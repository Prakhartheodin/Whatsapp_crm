import { Router } from 'express'
import ExcelJS from 'exceljs'
import { maskPhone } from '../logger.js'

const PAGE_SIZE = 50
const MAX_PAGE = 10_000
const STATUSES = ['confirmed', 'review', 'rejected']
const IST_MS = 5.5 * 3600_000

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400, expose: true })
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const istStartOfToday = () => new Date(Math.floor((Date.now() + IST_MS) / 86_400_000) * 86_400_000 - IST_MS)
const ist = (d) => (d ? new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 16).replace('T', ' ') : '')

// ---- query validation: every value is optional; anything present must be well-formed ----
function text(q, key, max = 200) {
  const v = q[key]
  if (v === undefined || v === '') return undefined
  if (typeof v !== 'string' || v.length > max) throw badRequest(`Invalid ${key}.`)
  return v
}
// A full ISO timestamp with Z or an offset (never server-local time), or a bare YYYY-MM-DD.
const ISO = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/
const valid = (d) => !Number.isNaN(d.getTime())
// A bare date is a whole IST day: `from` is its first millisecond, `to` its last.
function date(q, key) {
  const v = text(q, key, 40)
  if (v === undefined) return undefined
  const m = ISO.exec(v)
  const day = m && new Date(`${m[1]}T00:00:00Z`)
  const d = m && new Date(v.length === 10 ? `${v}T00:00:00+05:30` : v)
  // Date() rolls 2026-02-31 over to 3 March, so the calendar date must round-trip.
  if (!m || !valid(day) || day.toISOString().slice(0, 10) !== m[1] || !valid(d)) {
    throw badRequest(`Invalid ${key}: use YYYY-MM-DD or an ISO timestamp with a time zone.`)
  }
  return v.length === 10 && key === 'to' ? new Date(d.getTime() + 86_400_000 - 1) : d
}
function page(q) {
  const v = text(q, 'page', 6) ?? '1'
  if (!/^\d+$/.test(v) || +v < 1 || +v > MAX_PAGE) throw badRequest('Invalid page.')
  return +v
}
function range(q) {
  const from = date(q, 'from')
  const to = date(q, 'to')
  return from || to ? { ...(from && { $gte: from }), ...(to && { $lte: to }) } : undefined
}
const like = (q) => {
  const v = text(q, 'q', 100)
  return v && { $regex: escapeRegex(v), $options: 'i' }
}
// Drops undefined filters (Mongoose would otherwise match field == null).
const filter = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
// { $or: [{ a: c }, { b: c }] }, or undefined when there is no condition.
const anyOf = (fields, c) => c && { $or: fields.map((k) => ({ [k]: c })) }
// A booking folded from several groups is found under each of them.
const bySource = (q) => anyOf(['source', 'otherSources.source'], text(q, 'source'))
// MongoDB rejects an empty $and.
const allOf = (...cs) => (cs.some(Boolean) ? cs.filter(Boolean) : undefined)

// ---- response shapes from the API contract ----
// Also the one shape outputs receive (index.js maps the pipeline's Mongoose document with it).
export const toBooking = (d) => ({
  id: String(d._id), source: d.source, rawText: d.rawText, pickup: d.pickup, drop: d.drop,
  tripDateTime: d.tripDateTime ?? null, carType: d.carType ?? null, fare: d.fare ?? null, contact: d.contact ?? null,
  receivedAt: d.receivedAt, confidence: d.confidence, status: d.status, decidedBy: d.decidedBy, decidedAt: d.decidedAt,
  otherSources: (d.otherSources ?? []).map(({ source, receivedAt }) => ({ source, receivedAt })),
})
// "919876543210:3@s.whatsapp.net" -> "91xxxxxxxx10"; "me" and empty stay as they are.
const maskSender = (s) => (!s || s === 'me' ? s : maskPhone(s.split(/[:@]/)[0]))

const INGEST_PER_MINUTE = 60
/**
 * At start, before HTTP listens: one process, so a key without a result is an orphan of a request
 * that died with the previous process. After this, a key without a result is a request still running.
 */
export const releaseIngestKeys = (IngestKey) => IngestKey.deleteMany({ result: null })
const MAX_TRACKED = 10_000

export function createRoutes({ models: { Booking, RawMessage, IngestKey }, config, getHealthState, onConfirmed, pipeline, logger }) {
  const r = Router()
  const ingestHits = new Map() // credential|ip -> request times in the last 60 s; least recent key first

  /** Rolling-minute limit; returns the seconds to wait, or 0 when the request may go ahead. */
  function ingestLimited(key, t) {
    const times = (ingestHits.get(key) ?? []).filter((x) => t - x < 60_000)
    ingestHits.delete(key)
    if (times.length >= INGEST_PER_MINUTE) {
      ingestHits.set(key, times)
      return Math.max(1, Math.ceil((times[0] + 60_000 - t) / 1000))
    }
    times.push(t)
    ingestHits.set(key, times)
    // shortcut: past MAX_TRACKED keys in a minute the least recent is forgotten (resets its limit).
    if (ingestHits.size > MAX_TRACKED) ingestHits.delete(ingestHits.keys().next().value)
    return 0
  }

  r.get('/api/bookings', async (req, res) => {
    const status = text(req.query, 'status') ?? 'confirmed'
    if (!STATUSES.includes(status)) throw badRequest('Invalid status.')
    const p = page(req.query)
    const f = filter({
      status,
      receivedAt: range(req.query),
      $and: allOf(bySource(req.query), anyOf(['rawText', 'pickup', 'drop', 'contact'], like(req.query))),
    })
    const dir = status === 'review' ? 1 : -1
    const [docs, total] = await Promise.all([
      // _id breaks ties (same-second messages), so rows cannot repeat or vanish across pages.
      Booking.find(f).sort({ receivedAt: dir, _id: dir }).skip((p - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      Booking.countDocuments(f),
    ])
    res.json({ items: docs.map(toBooking), total, page: p, pageSize: PAGE_SIZE })
  })

  // Atomic: the expected current status is part of the filter, so two clicks cannot both win.
  async function transition(req, res, from, set) {
    const id = req.params.id
    const doc = /^[0-9a-f]{24}$/i.test(id) && await Booking.findOneAndUpdate(
      { _id: id, ...from },
      { $set: { ...set, decidedBy: 'admin', decidedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean()
    if (doc) return doc
    if (doc === null && await Booking.exists({ _id: id })) res.status(409).json({ error: 'This booking was already changed. Reload.' })
    else res.status(404).json({ error: 'Booking not found.' })
  }

  r.post('/api/bookings/:id/confirm', async (req, res) => {
    const doc = await transition(req, res, { status: 'review' }, { status: 'confirmed' })
    if (!doc) return
    const item = toBooking(doc)
    // outputsSentAt is claimed atomically, so outputs fire once per booking even across undo + confirm;
    // status in the filter: an undo landing between the two writes must not fire them.
    // A failed send or a crash after the claim is retried by jobs/outbox.js, per output, never re-sending a delivered one.
    const claimed = !doc.outputsSentAt &&
      (await Booking.updateOne({ _id: doc._id, status: 'confirmed', outputsSentAt: null }, { $set: { outputsSentAt: new Date() } })).modifiedCount === 1
    if (claimed) {
      Promise.resolve().then(() => onConfirmed(item)).catch((err) => logger.error({ err, bookingId: item.id }, 'outputs failed'))
    }
    res.json({ item })
  })

  r.post('/api/bookings/:id/reject', async (req, res) => {
    const doc = await transition(req, res, { status: 'review' }, { status: 'rejected' })
    if (doc) res.json({ item: toBooking(doc) })
  })

  r.post('/api/bookings/:id/undo', async (req, res) => {
    const doc = await transition(req, res, { status: { $in: ['confirmed', 'rejected'] }, decidedBy: 'admin' }, { status: 'review' })
    if (doc) res.json({ item: toBooking(doc), outputsAlreadySent: Boolean(doc.outputsSentAt) })
  })

  // Same pipeline as WhatsApp messages; the text lives only on the booking (not in raw_messages).
  r.post('/ingest', async (req, res) => {
    const retryAfterSec = ingestLimited(`${req.user}|${req.ip}`, Date.now())
    if (retryAfterSec) {
      res.set('Retry-After', String(retryAfterSec))
      return res.status(429).json({ error: 'Too many /ingest requests. Slow down.', retryAfterSec })
    }
    const { source, rawText, receivedAt, clientMessageId } = req.body ?? {}
    if (typeof source !== 'string' || !source.trim() || source.length > 100) throw badRequest('Invalid source: text of 1-100 characters.')
    if (typeof rawText !== 'string' || !rawText.trim() || rawText.length > 4000) throw badRequest('Invalid rawText: text of 1-4000 characters.')
    let at
    try {
      // A bare date (10 chars) is not a moment in time.
      at = typeof receivedAt === 'string' && receivedAt.length > 10 && date(req.body, 'receivedAt')
    } catch {}
    if (!at) throw badRequest('Invalid receivedAt: use an ISO-8601 timestamp with a time zone, e.g. 2026-11-23T09:15:00+05:30.')
    if (at.getTime() > Date.now() + 5 * 60_000) throw badRequest('Invalid receivedAt: more than 5 minutes in the future.')
    // Dedupe only looks 24 h around receivedAt, so a re-sent old message with a shifted time would fire outputs again.
    if (at.getTime() < Date.now() - 7 * 86_400_000) throw badRequest('Invalid receivedAt: more than 7 days in the past.')
    if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !clientMessageId || clientMessageId.length > 100)) {
      throw badRequest('Invalid clientMessageId: text of 1-100 characters.')
    }
    // Idempotency for collectors that re-read the same messages: the key is claimed first, so two
    // concurrent repeats cannot both run the pipeline. Keys expire after 7 days (TTL index).
    // Requests without clientMessageId are not idempotent.
    const key = clientMessageId && { source: source.trim().toLowerCase(), clientMessageId }
    if (key) {
      try {
        await IngestKey.create(key)
      } catch (err) {
        if (err.code !== 11000) throw err
        const prev = await IngestKey.findOne(key).lean()
        if (prev?.result) return res.json(prev.result)
        return res.status(409).json({ error: 'This message is still being processed. Retry shortly.' })
      }
    }
    let result
    try {
      const { status, bookingId, duplicateOf } = await pipeline.processMessage({ source, rawText, receivedAt: at })
      result = { status, ...(bookingId && { bookingId: String(bookingId) }), ...(duplicateOf && { duplicateOf: String(duplicateOf) }) }
    } catch (err) {
      if (key) await IngestKey.deleteOne(key).catch(() => {}) // not processed: a retry must run again
      throw err
    }
    if (key) {
      await IngestKey.updateOne(key, { $set: { result } }).catch((err) => {
        // Never leave a key without a result (its retries would get 409 until a restart).
        logger.error({ err }, 'could not store the /ingest result; key freed')
        return IngestKey.deleteOne(key).catch(() => {})
      })
    }
    res.json(result)
  })

  r.get('/api/raw', async (req, res) => {
    const group = text(req.query, 'group', 100)
    if (group !== undefined && !/^[\d-]+@g\.us$/.test(group)) throw badRequest('Invalid group.')
    const p = page(req.query)
    const f = filter({ groupId: group, timestamp: range(req.query), text: like(req.query) })
    const [docs, total] = await Promise.all([
      RawMessage.find(f).sort({ timestamp: -1, _id: -1 }).skip((p - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      RawMessage.countDocuments(f),
    ])
    const ids = docs.map((d) => d._id)
    // A message folded into a booking as a duplicate shows that booking's status.
    const linked = await Booking.find(
      { $or: [{ rawMessageId: { $in: ids } }, { 'otherSources.rawMessageId': { $in: ids } }] },
      { rawMessageId: 1, 'otherSources.rawMessageId': 1, status: 1 },
    ).lean()
    const statusOf = new Map(linked.flatMap((b) => (b.otherSources ?? []).map((s) => [String(s.rawMessageId), b.status])))
    for (const b of linked) if (b.rawMessageId) statusOf.set(String(b.rawMessageId), b.status)
    res.json({
      items: docs.map((d) => ({
        id: String(d._id), groupId: d.groupId, groupName: d.groupName, sender: maskSender(d.sender),
        text: d.text, timestamp: d.timestamp, bookingStatus: statusOf.get(String(d._id)) ?? null,
      })),
      total, page: p, pageSize: PAGE_SIZE,
    })
  })

  r.get('/export', async (req, res) => {
    const r = range(req.query)
    const f = filter({ status: 'confirmed', receivedAt: r, $and: allOf(bySource(req.query)) })
    // IST dates; `to` minus 1 ms so an exclusive next-midnight bound names the day it ends.
    const day = (d) => (d ? ist(d).slice(0, 10) : 'all')
    const name = `bookings-${day(r?.$gte)}-${day(r?.$lte && new Date(r.$lte - 1))}.xlsx`
    res.attachment(name)
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    // Streams row by row; strings are written as strings, so "=..." is never a formula.
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: false, useSharedStrings: false })
    const ws = wb.addWorksheet('Bookings')
    ws.addRow(['Received (IST)', 'Trip time (IST)', 'Pickup', 'Drop', 'Car', 'Fare', 'Contact', 'Source',
      'Other sources', 'Confidence', 'Original message']).commit()
    for await (const d of Booking.find(f).sort({ receivedAt: 1 }).lean().cursor()) {
      if (res.destroyed) return // client went away; leaving the loop closes the cursor
      ws.addRow([ist(d.receivedAt), ist(d.tripDateTime), d.pickup ?? '', d.drop ?? '', d.carType ?? '', d.fare ?? '',
        d.contact ?? '', d.source ?? '', (d.otherSources ?? []).map((s) => s.source).join(', '), d.confidence ?? '',
        d.rawText ?? '']).commit()
    }
    ws.commit()
    await wb.commit()
  })

  r.get('/health', async (req, res) => {
    const start = istStartOfToday()
    const { whatsapp, groupNames, lastMessageAt, heartbeat, outputs, outputCounts } = getHealthState()
    const perGroup = await Promise.all(config.targetGroupIds.map(async (id) => {
      // After a restart the in-memory values are empty; the newest stored message fills them.
      const newest = await RawMessage.findOne({ groupId: id }).sort({ timestamp: -1 }).lean()
      return {
        id,
        name: groupNames.get(id) ?? newest?.groupName ?? id,
        lastMessageAt: lastMessageAt.get(id) ?? newest?.timestamp ?? null,
        countToday: await RawMessage.countDocuments({ groupId: id, timestamp: { $gte: start } }),
      }
    }))
    const [rawToday, bookingsToday, reviewPending, withDupes] = await Promise.all([
      RawMessage.countDocuments({ timestamp: { $gte: start } }),
      Booking.countDocuments({ status: 'confirmed', receivedAt: { $gte: start } }),
      Booking.countDocuments({ status: 'review' }),
      Booking.find({ 'otherSources.receivedAt': { $gte: start } }, { otherSources: 1 }).lean(),
    ])
    const times = perGroup.map((g) => g.lastMessageAt).filter(Boolean).map((d) => new Date(d))
    res.json({
      whatsapp: { status: whatsapp.status, since: whatsapp.since },
      lastMessageAt: times.length ? new Date(Math.max(...times)) : null,
      perGroup,
      counts: {
        rawToday, bookingsToday, reviewPending,
        duplicatesToday: withDupes.flatMap((b) => b.otherSources).filter((s) => new Date(s.receivedAt) >= start).length,
        ...(await outputCounts()), // outputsPending, outputsFailed
      },
      heartbeat,
      outputs,
    })
  })

  return r
}
