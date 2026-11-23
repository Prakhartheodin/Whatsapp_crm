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

// ---- response shapes from the API contract ----
const toBooking = (d) => ({
  id: String(d._id), source: d.source, rawText: d.rawText, pickup: d.pickup, drop: d.drop,
  tripDateTime: d.tripDateTime ?? null, carType: d.carType ?? null, fare: d.fare ?? null, contact: d.contact ?? null,
  receivedAt: d.receivedAt, confidence: d.confidence, status: d.status, decidedBy: d.decidedBy, decidedAt: d.decidedAt,
  otherSources: (d.otherSources ?? []).map(({ source, receivedAt }) => ({ source, receivedAt })),
})
// "919876543210:3@s.whatsapp.net" -> "91xxxxxxxx10"; "me" and empty stay as they are.
const maskSender = (s) => (!s || s === 'me' ? s : maskPhone(s.split(/[:@]/)[0]))

export function createRoutes({ models: { Booking, RawMessage }, config, getHealthState, onConfirmed, logger }) {
  const r = Router()

  r.get('/api/bookings', async (req, res) => {
    const status = text(req.query, 'status') ?? 'confirmed'
    if (!STATUSES.includes(status)) throw badRequest('Invalid status.')
    const p = page(req.query)
    const f = filter({ status, receivedAt: range(req.query), source: text(req.query, 'source'), rawText: like(req.query) })
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
    // TODO(step 7): claim-then-send is at-most-once; a crash or failed output is not retried.
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

  r.get('/api/raw', async (req, res) => {
    const group = text(req.query, 'group', 100)
    if (group !== undefined && !/^[\d-]+@g\.us$/.test(group)) throw badRequest('Invalid group.')
    const p = page(req.query)
    const f = filter({ groupId: group, timestamp: range(req.query), text: like(req.query) })
    const [docs, total] = await Promise.all([
      RawMessage.find(f).sort({ timestamp: -1, _id: -1 }).skip((p - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      RawMessage.countDocuments(f),
    ])
    const linked = await Booking.find({ rawMessageId: { $in: docs.map((d) => d._id) } }, { rawMessageId: 1, status: 1 }).lean()
    const statusOf = new Map(linked.map((b) => [String(b.rawMessageId), b.status]))
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
    const f = filter({ status: 'confirmed', receivedAt: r, source: text(req.query, 'source') })
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
    const { whatsapp, groupNames, lastMessageAt } = getHealthState()
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
      },
      // TODO(step 9): quiet and lastAlertAt come from the heartbeat job.
      heartbeat: { minutes: config.heartbeatMinutes, windowStart: '08:00', windowEnd: '23:00', quiet: false, lastAlertAt: null },
      // TODO(step 7): report which outputs are enabled.
      outputs: { sheets: false, telegram: false, whatsappSend: false },
    })
  })

  return r
}
