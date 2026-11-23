import { config } from '../config.js'
import { HIGH, LOW, RULES_FULL_CONFIDENCE_SCORE, LLM_MAX_IN_FLIGHT } from './rules.js'
import { score } from './scorer.js'
import { extract } from './extractor.js'
import { normalisePlace, findDuplicate } from './dedupe.js'

const MAX_TEXT = 4000
const MAX_SOURCE = 100
// Same shape as the HTTP layer's badRequest: server.js turns it into a 400 with this message.
const badInput = (msg) => Object.assign(new Error(msg), { status: 400, expose: true })

function validate(m) {
  if (!m || typeof m !== 'object') throw badInput('Invalid message.')
  const { source, rawText, receivedAt, rawMessageId } = m
  if (typeof rawText !== 'string' || !rawText.trim() || rawText.length > MAX_TEXT) {
    throw badInput(`Invalid rawText: must be non-empty text of at most ${MAX_TEXT} characters.`)
  }
  if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) throw badInput('Invalid receivedAt.')
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_SOURCE) {
    throw badInput(`Invalid source: must be non-empty text of at most ${MAX_SOURCE} characters.`)
  }
  if (rawMessageId != null && !/^[0-9a-f]{24}$/i.test(String(rawMessageId))) throw badInput('Invalid rawMessageId.')
}

const FIELDS = ['pickup', 'drop', 'tripDateTime', 'carType', 'fare', 'contact']

/**
 * createPipeline({ Booking, llm, onConfirmed, logger }) -> { processMessage({ source, rawText, receivedAt, rawMessageId? }) }
 * processMessage resolves to { status: 'confirmed'|'review'|'duplicate'|'ignored', bookingId?, duplicateOf? }
 * and rejects with { status: 400, expose: true } on invalid input. Deciding (rules, LLM) runs in parallel;
 * de-duplication and storing run one message at a time.
 */
export function createPipeline({ Booking, llm, onConfirmed, logger }) {
  let llmInFlight = 0
  // Bounded, so a slow or down OpenAI cannot pile up messages in memory: over the cap -> Review.
  async function askLlm(rawText, receivedAt) {
    if (llmInFlight >= LLM_MAX_IN_FLIGHT) return null
    llmInFlight++
    try { return await llm.classifyAndExtract(rawText, receivedAt) } finally { llmInFlight-- }
  }

  // design.md section 3. null = not a booking.
  async function decide(rawText, receivedAt) {
    const { score: n, cap } = score(rawText)
    if (n <= LOW) return null
    const rules = { fields: extract(rawText, receivedAt), confidence: Math.min(1, n / RULES_FULL_CONFIDENCE_SCORE), decidedBy: 'rules' }
    if (cap) return { ...rules, status: cap } // e.g. "car available": a driver's offer or a customer's question
    if (n >= HIGH) return { ...rules, status: 'confirmed' }
    const r = await askLlm(rawText, receivedAt)
    if (!r) return { ...rules, status: 'review' }
    // confidence is the probability that it IS a booking: drop it only when sure it is not
    if (!r.isBooking) return 1 - r.confidence >= config.llmConfirmThreshold ? null : { ...rules, status: 'review' }
    return { fields: r.fields, confidence: r.confidence, decidedBy: 'llm', status: r.confidence >= config.llmConfirmThreshold ? 'confirmed' : 'review' }
  }

  // Claimed atomically (as in routes.js confirm), so outputs fire once per booking.
  async function sendOutputs(_id) {
    const doc = await Booking.findOneAndUpdate(
      { _id, status: 'confirmed', outputsSentAt: null }, { $set: { outputsSentAt: new Date() } }, { returnDocument: 'after' },
    )
    if (doc) Promise.resolve().then(() => onConfirmed(doc)).catch((err) => logger.error({ err, bookingId: String(_id) }, 'outputs failed'))
  }

  // A confirmed copy of a Review booking confirms it (unless the admin put it there) and fills its empty fields.
  async function promote(dup, d) {
    const fill = Object.fromEntries(FIELDS.filter((k) => dup[k] == null && d.fields[k] != null).map((k) => [k, d.fields[k]]))
    if (fill.pickup) fill.pickupNorm = normalisePlace(fill.pickup)
    if (fill.drop) fill.dropNorm = normalisePlace(fill.drop)
    const { modifiedCount } = await Booking.updateOne(
      { _id: dup._id, status: 'review', decidedBy: { $ne: 'admin' } },
      { $set: { ...fill, status: 'confirmed', decidedBy: d.decidedBy, confidence: d.confidence, decidedAt: new Date() } },
    )
    if (modifiedCount === 1) {
      logger.info({ bookingId: String(dup._id), decidedBy: d.decidedBy }, 'pipeline: review booking confirmed by a copy')
      await sendOutputs(dup._id)
    }
  }

  async function store({ source, rawText, receivedAt, rawMessageId = null }, d) {
    if (!d) return { status: 'ignored' }
    const { fields, decidedBy } = d
    // A booking without both ends is unclear, whoever decided it.
    const status = d.status === 'confirmed' && fields.pickup && fields.drop ? 'confirmed' : 'review'

    const dup = await findDuplicate(Booking, { ...fields, rawText, receivedAt })
    if (dup) {
      const duplicateOf = String(dup._id)
      // status in the filter: if the admin rejected it meanwhile, this copy becomes a booking of its own
      const { modifiedCount } = await Booking.updateOne(
        { _id: dup._id, status: { $ne: 'rejected' } }, { $push: { otherSources: { source, rawMessageId, receivedAt } } },
      )
      if (modifiedCount === 1) {
        logger.info({ bookingId: duplicateOf, source }, 'pipeline: duplicate folded into booking')
        if (status === 'confirmed' && dup.status === 'review') await promote(dup, { ...d, fields })
        return { status: 'duplicate', duplicateOf }
      }
    }

    const doc = await Booking.create({
      source, rawText, ...fields, pickupNorm: normalisePlace(fields.pickup), dropNorm: normalisePlace(fields.drop),
      receivedAt, confidence: d.confidence, rawMessageId, status, decidedBy, decidedAt: new Date(),
    })
    const bookingId = String(doc._id)
    logger.info({ bookingId, status, decidedBy, source }, 'pipeline: booking stored')
    if (status === 'confirmed') await sendOutputs(doc._id)
    return { status, bookingId }
  }

  // Only dedupe + store are serial (two copies arriving together could otherwise both pass dedupe);
  // a message joins the queue once decided, so a slow LLM call never holds up other messages.
  let queue = Promise.resolve()
  return {
    async processMessage(msg) {
      validate(msg)
      const d = await decide(msg.rawText, msg.receivedAt)
      const result = queue.then(() => store(msg, d))
      queue = result.catch(() => {}) // the caller gets this message's error; the next message still runs
      return result
    },
  }
}
