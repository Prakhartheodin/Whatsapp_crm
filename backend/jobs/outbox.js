import { setTimeout as delay } from 'node:timers/promises'
import { toBooking } from '../http/routes.js'

const NAMES = ['telegram', 'sheets', 'whatsappSend']
const QUICK_ATTEMPTS = 5
const QUICK_MS = 2 * 60_000 // run interval; also how old a claim must be before it is retried
const SLOW_MS = 3600_000 // after the quick attempts: hourly
const MAX_AGE_MS = 7 * 86_400_000 // then the still-missing outputs are given up (counted and logged)
const BATCH = 10

/**
 * Delivery of confirmed bookings to the outputs, with retries. Guarantee: every output that was
 * enabled when the booking was confirmed (`wanted`) gets it, or after 7 days is marked given up,
 * logged and counted. A second copy can only follow a send whose outcome is unknown (timeout, crash
 * between sending and recording); Telegram/WhatsApp then label it, Sheets looks for its row first.
 *
 * Per output: `sending.<k>` is written BEFORE the send (write-ahead) and cleared with the result;
 * `delivered.<k>` when it went out. A marker without a delivery = unknown outcome.
 * deliver(booking) is the onConfirmed used everywhere; run() (every 2 min, and at start) retries.
 */
export function createOutbox({ Booking, outputs, logger, now = () => new Date(), sleep = delay }) {
  const active = new Set() // booking ids being delivered right now (in this process)
  let timer
  let running = null

  const enabledNames = () => {
    const st = outputs.status()
    return NAMES.filter((k) => st[k])
  }
  const missing = (names) => names.map((k) => ({ wanted: k, [`delivered.${k}`]: null, [`givenUp.${k}`]: null }))
  const pendingFilter = (names, t, minAge) => ({
    status: 'confirmed',
    outputsSentAt: { $gte: new Date(t - MAX_AGE_MS), $lte: new Date(t - minAge) },
    $and: [{ $or: missing(names) },
      { $or: [{ outputAttempts: { $lt: QUICK_ATTEMPTS } }, { lastAttemptAt: { $lte: new Date(t - SLOW_MS) } }] }],
  })

  /** A brief MongoDB blip while recording must not turn into a repeat: a few tries with backoff. */
  async function record(id, $set) {
    for (let i = 0; ; i++) {
      try {
        return await Booking.updateOne({ _id: id }, { $set })
      } catch (err) {
        if (i === 2) throw err
        await sleep(500 * (i + 1))
      }
    }
  }

  async function sendOne(id, doc, booking, k, retry) {
    const repeat = Boolean(doc.sending?.[k]) // an earlier send of this output has no recorded outcome
    await Booking.updateOne({ _id: id }, { $set: { [`sending.${k}`]: now() } }) // write-ahead; if it fails, nothing is sent
    const v = (await outputs.onConfirmed(booking, { only: [k], repeat, check: retry }))[k]
    if (v === true) await record(id, { [`delivered.${k}`]: now(), [`sending.${k}`]: null })
    else if (v !== 'unknown') await record(id, { [`sending.${k}`]: null }) // definitely not sent: next try unlabelled
    return v // 'unknown' keeps the marker, so the next try is labelled (Sheets: checked)
  }

  /**
   * One attempt on one booking. Counted first, in the same atomic update that re-checks `filter`
   * against the stored row (a retry never works from a stale read). Each output is sent on its own
   * and recorded as soon as it settles (a queued WhatsApp send never delays Telegram or Sheets).
   */
  async function attempt(id, filter, pick, booking, first) {
    const $set = { lastAttemptAt: now(), ...(first && { wanted: enabledNames() }) }
    const doc = await Booking.findOneAndUpdate({ _id: id, ...filter }, { $inc: { outputAttempts: 1 }, $set }, { returnDocument: 'after' }).lean()
    if (!doc) return
    const shaped = booking ?? toBooking(doc)
    const names = pick(doc)
    const results = await Promise.all(names.map((k) => sendOne(id, doc, shaped, k, !first).catch((err) => {
      logger.error({ err, bookingId: id, output: k }, 'could not send or record a booking output')
      return false
    })))
    const failed = names.filter((k, i) => results[i] !== true)
    if (failed.length && doc.outputAttempts === QUICK_ATTEMPTS) {
      logger.error({ bookingId: id, failed }, `booking outputs not delivered after ${QUICK_ATTEMPTS} attempts; retrying hourly for up to 7 days`)
    }
  }

  /** Runs fn for a booking unless it is already being delivered in this process. Never throws. */
  async function exclusive(id, fn) {
    if (!id || active.has(id)) return
    active.add(id)
    try {
      await fn()
    } catch (err) {
      logger.error({ err, bookingId: id }, 'could not deliver booking outputs')
    } finally {
      active.delete(id)
    }
  }

  /** The onConfirmed for a booking just claimed: every output enabled now (snapshotted as `wanted`). */
  const deliver = (booking) => {
    const id = String(booking?.id ?? booking?._id ?? '')
    return exclusive(id, () => attempt(id, {}, (doc) => doc.wanted, booking, true))
  }

  /** Outputs still missing 7 days after the claim: given up, logged and counted, never silently dropped. */
  async function expire(t) {
    for (const k of NAMES) {
      const { modifiedCount } = await Booking.updateMany(
        { status: 'confirmed', outputsSentAt: { $lt: new Date(t - MAX_AGE_MS) }, wanted: k, [`delivered.${k}`]: null, [`givenUp.${k}`]: null },
        { $set: { [`givenUp.${k}`]: new Date(t) } },
      )
      if (modifiedCount) logger.error({ output: k, bookings: modifiedCount }, 'booking output not delivered within 7 days; given up')
    }
  }

  async function runOnce() {
    await expire(now().getTime())
    const names = enabledNames()
    if (!names.length) return
    const docs = await Booking.find(pendingFilter(names, now().getTime(), QUICK_MS)).sort({ outputsSentAt: 1 }).limit(BATCH).lean()
    for (const d of docs) {
      const id = String(d._id)
      await exclusive(id, () => attempt(id, pendingFilter(names, now().getTime(), QUICK_MS),
        (fresh) => names.filter((k) => fresh.wanted?.includes(k) && !fresh.delivered?.[k] && !fresh.givenUp?.[k])))
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
      const t = now().getTime()
      const [outputsPending, outputsFailed] = await Promise.all([
        names.length ? Booking.countDocuments({ status: 'confirmed', outputsSentAt: { $gte: new Date(t - MAX_AGE_MS) }, $or: missing(names) }) : 0,
        Booking.countDocuments({ $or: NAMES.map((k) => ({ [`givenUp.${k}`]: { $ne: null } })) }),
      ])
      return { outputsPending, outputsFailed }
    },
    start() {
      run()
      clearInterval(timer)
      timer = setInterval(run, QUICK_MS)
      timer.unref()
    },
    stop: () => clearInterval(timer),
  }
}
