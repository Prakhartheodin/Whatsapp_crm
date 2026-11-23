import { toBooking } from '../http/routes.js'

const NAMES = ['telegram', 'sheets', 'whatsappSend']
const MAX_ATTEMPTS = 5
const RETRY_AFTER_MS = 2 * 60_000 // a claim younger than this may still be in its first delivery
const MAX_AGE_MS = 24 * 3600_000 // an output enabled later never floods the outputs with old bookings
const BATCH = 10

/**
 * Delivery of confirmed bookings to the enabled outputs, with retries.
 * deliver(booking) is the onConfirmed used everywhere: it counts the attempt, sends each enabled
 * output and records delivered.<name> (sent) or givenUp.<name> as soon as that output settles. run() (every 2 min and at
 * start) re-sends only the outputs still missing on confirmed bookings, so a failed send or a
 * crash between the outputsSentAt claim and the send is recovered. A Sheets append whose outcome
 * is unknown (timeout after sending) is given up at once: a duplicate row is worse than a missing one.
 */
export function createOutbox({ Booking, outputs, logger, now = () => new Date() }) {
  const active = new Set() // booking ids being delivered right now (in this process)
  let timer
  let running = null

  const enabledNames = () => {
    const st = outputs.status()
    return NAMES.filter((k) => st[k])
  }
  const missing = (names) => names.map((k) => ({ [`delivered.${k}`]: null, [`givenUp.${k}`]: null }))
  const pendingFilter = (names, t, minAge) => ({
    status: 'confirmed', outputAttempts: { $lt: MAX_ATTEMPTS },
    outputsSentAt: { $gte: new Date(t - MAX_AGE_MS), $lte: new Date(t - minAge) }, $or: missing(names),
  })

  /**
   * One attempt on one booking. Counted first, in the same atomic update that re-checks `filter`
   * against the stored row (so a retry never works from a stale read). Each output is then sent on
   * its own and recorded as soon as it settles: a slow WhatsApp send in the sender queue never delays
   * recording Telegram or Sheets, so a restart meanwhile does not send those again.
   */
  async function attempt(id, filter, pick, booking) {
    const doc = await Booking.findOneAndUpdate({ _id: id, ...filter }, { $inc: { outputAttempts: 1 } }, { returnDocument: 'after' }).lean()
    if (!doc) return
    const shaped = booking ?? toBooking(doc)
    const results = await Promise.all(pick(doc).map(async (k) => {
      const v = (await outputs.onConfirmed(shaped, { only: [k] }))[k]
      if (v === true) await Booking.updateOne({ _id: id }, { $set: { [`delivered.${k}`]: now() } })
      if (v === 'unknown') {
        await Booking.updateOne({ _id: id }, { $set: { [`givenUp.${k}`]: now() } })
        logger.error({ bookingId: id, output: k }, 'output outcome unknown (timeout); not retried, to avoid a duplicate')
      }
      return [k, v]
    }))
    const failed = results.filter(([, v]) => v === false).map(([k]) => k)
    if (failed.length && doc.outputAttempts >= MAX_ATTEMPTS) {
      const t = now()
      await Booking.updateOne({ _id: id }, { $set: Object.fromEntries(failed.map((k) => [`givenUp.${k}`, t])) })
      logger.error({ bookingId: id, failed }, `booking outputs failed ${MAX_ATTEMPTS} times; giving up`)
    }
  }

  /** Runs fn for a booking unless it is already being delivered in this process. Never throws. */
  async function exclusive(id, fn) {
    if (!id || active.has(id)) return
    active.add(id)
    try {
      await fn()
    } catch (err) {
      logger.error({ err, bookingId: id }, 'could not deliver or record booking outputs')
    } finally {
      active.delete(id)
    }
  }

  /** The onConfirmed for a booking just claimed: every enabled output. */
  const deliver = (booking) => {
    const id = String(booking?.id ?? booking?._id ?? '')
    return exclusive(id, () => attempt(id, {}, enabledNames, booking))
  }

  async function runOnce() {
    const names = enabledNames()
    if (!names.length) return
    const docs = await Booking.find(pendingFilter(names, now().getTime(), RETRY_AFTER_MS)).sort({ outputsSentAt: 1 }).limit(BATCH).lean()
    for (const d of docs) {
      const id = String(d._id)
      // The batch may be stale by now (a first delivery finished meanwhile): attempt() re-checks it.
      await exclusive(id, () => attempt(id, pendingFilter(names, now().getTime(), RETRY_AFTER_MS),
        (fresh) => names.filter((k) => !fresh.delivered?.[k] && !fresh.givenUp?.[k])))
    }
  }
  const run = () => (running ??= runOnce()
    .catch((err) => logger.error({ err }, 'outbox run failed'))
    .finally(() => { running = null }))

  return {
    deliver,
    run,
    /** For /health: bookings still being retried, and bookings with an output given up. */
    async counts() {
      const names = enabledNames()
      const [outputsPending, outputsFailed] = await Promise.all([
        names.length ? Booking.countDocuments(pendingFilter(names, now().getTime(), 0)) : 0,
        Booking.countDocuments({ $or: NAMES.map((k) => ({ [`givenUp.${k}`]: { $ne: null } })) }),
      ])
      return { outputsPending, outputsFailed }
    },
    start() {
      run()
      clearInterval(timer)
      timer = setInterval(run, RETRY_AFTER_MS)
      timer.unref()
    },
    stop: () => clearInterval(timer),
  }
}
