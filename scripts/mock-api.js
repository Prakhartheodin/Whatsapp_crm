// DEV MOCK ONLY. Serves frontend/ and fakes every route of the HTTP contract with
// made-up, in-memory data, so the dashboard can be previewed without MongoDB or WhatsApp.
// Nothing here is used by the real service. Login: admin / admin-password-123.
//   node scripts/mock-api.js              (PORT=4000 by default)
//   MOCK_WA=logged_out node scripts/mock-api.js   (preview the logged-out Status panel)
//   MOCK_QUIET=1 node scripts/mock-api.js         (preview the "Quiet 2h+" pill)
//   MOCK_NOAUTH=1 PORT=4001 node scripts/mock-api.js  (no login; for headless screenshots)
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PORT = Number(process.env.PORT) || 4000
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend')
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

// ---- made-up data ----
const now = Date.now()
const ago = (min) => new Date(now - min * 60000).toISOString()
// Ids shaped like real group JIDs, so they pass the backend's `group` check too.
const groups = [
  { id: '120363000000000001@g.us', name: 'Group A' },
  { id: '120363000000000002@g.us', name: 'Group B' },
  { id: '120363000000000003@g.us', name: 'Group C' },
  { id: '120363000000000004@g.us', name: 'Group D' },
]
const outputs = { sheets: true, telegram: true, whatsappSend: false }
let seq = 0
const booking = (o) => ({
  id: `b${++seq}`, source: 'whatsapp:Group A', rawText: '', pickup: null, drop: null, tripDateTime: null,
  carType: null, fare: null, contact: null, receivedAt: ago(5), confidence: 0.95, status: 'confirmed',
  decidedBy: 'rules', decidedAt: ago(5), otherSources: [], ...o,
})
const bookings = [
  booking({
    pickup: 'Delhi Airport T3', drop: 'Agra', tripDateTime: '2026-11-24T00:30:00Z', carType: 'Sedan', fare: 3500,
    contact: '9876543210', receivedAt: ago(18), rawText: 'Delhi Airport T3 to Agra\n24 Nov 6 am\nSedan 3500\nCall 9876543210',
    otherSources: [{ source: 'whatsapp:Group C', receivedAt: ago(16) }, { source: 'whatsapp:Group D', receivedAt: ago(15) }],
  }),
  booking({
    source: 'whatsapp:Group B', pickup: 'Gurgaon Sector 29', drop: 'Jaipur (Ajmeri Gate, near the old city wall)',
    carType: 'Innova Crysta', fare: 5200, contact: '9811122233', receivedAt: ago(95), confidence: 0.82, decidedBy: 'llm',
    rawText: 'Gurgaon sec 29 se Jaipur Ajmeri Gate\nkal subah 7 baje\nInnova Crysta 5200\n9811122233',
  }),
  booking({ pickup: 'Noida Sector 62', drop: 'Delhi Airport T1', contact: '9900011122', receivedAt: ago(60 * 9), rawText: 'Noida 62 to T1 airport urgent 9900011122' }),
  booking({ source: 'app', pickup: 'Chandigarh', drop: 'Shimla', carType: 'SUV', fare: 4800, receivedAt: ago(60 * 26), rawText: 'Chandigarh to Shimla SUV 4800' }),
  booking({ status: 'review', source: 'whatsapp:Group B', pickup: 'Jaipur', drop: 'Delhi', carType: 'Innova', contact: '9812345678', confidence: 0.55, decidedBy: 'rules', receivedAt: ago(70), rawText: 'Jaipur → Delhi tomorrow, Innova needed\nanyone available? 9812345678' }),
  booking({ status: 'review', source: 'whatsapp:Group C', pickup: 'Agra', confidence: 0.48, decidedBy: 'llm', receivedAt: ago(40), rawText: 'Agra se koi gaadi khali hai kya shaam ko' }),
  booking({ status: 'review', source: 'whatsapp:Group A', confidence: 0.51, decidedBy: 'rules', receivedAt: ago(12), rawText: '=HYPERLINK("http://example.invalid","cheap cabs")\nDelhi to Manali 2 seats' }),
  booking({ status: 'rejected', source: 'whatsapp:Group D', confidence: 0.3, decidedBy: 'admin', receivedAt: ago(200), rawText: 'Good morning everyone' }),
]
const raw = [
  ...bookings.map((b, i) => ({
    id: `r${i + 1}`, groupId: groups.find((g) => `whatsapp:${g.name}` === b.source)?.id || groups[0].id,
    groupName: b.source === 'app' ? 'App' : b.source.replace('whatsapp:', ''), sender: `98xxxxxx${10 + i}`,
    text: b.rawText, timestamp: b.receivedAt, bookingStatus: b.status,
  })),
  { id: 'r100', groupId: groups[1].id, groupName: 'Group B', sender: '91xxxxxxxx44', text: '<script>alert(1)</script> <img src=x onerror=alert(2)>', timestamp: ago(30), bookingStatus: null },
  { id: 'r101', groupId: groups[0].id, groupName: 'Group A', sender: 'me', text: '=cmd|"/c calc"!A1', timestamp: ago(45), bookingStatus: null },
]

// A new confirmed booking every 40 s, to preview polling, highlight and the "N new" bar.
setInterval(() => {
  const b = booking({ pickup: 'Faridabad', drop: `Mathura ${seq}`, carType: 'Dzire', fare: 2100 + seq, contact: '9898989898', receivedAt: new Date().toISOString(), rawText: `Faridabad to Mathura, Dzire ${2100 + seq}` })
  bookings.push(b)
  raw.push({ id: `r${b.id}`, groupId: groups[0].id, groupName: 'Group A', sender: '98xxxxxx98', text: b.rawText, timestamp: b.receivedAt, bookingStatus: 'confirmed' })
}, 40000).unref()

const health = () => ({
  whatsapp: { status: process.env.MOCK_WA || 'open', since: ago(60 * 3) },
  lastMessageAt: ago(2),
  perGroup: [
    { id: groups[0].id, name: 'Group A', lastMessageAt: ago(2), countToday: 48 },
    { id: groups[1].id, name: 'Group B', lastMessageAt: ago(30), countToday: 31 },
    { id: groups[2].id, name: 'Group C', lastMessageAt: ago(16), countToday: 22 },
    { id: groups[3].id, name: 'Group D', lastMessageAt: ago(60 * 3 + 5), countToday: 4 }, // quiet group
  ],
  counts: { rawToday: 105, bookingsToday: bookings.filter((b) => b.status === 'confirmed').length, reviewPending: bookings.filter((b) => b.status === 'review').length, duplicatesToday: 2 },
  heartbeat: { minutes: 120, windowStart: '08:00', windowEnd: '23:00', quiet: Boolean(process.env.MOCK_QUIET), lastAlertAt: process.env.MOCK_QUIET ? ago(10) : null },
  outputs,
})

// ---- helpers ----
const sessions = new Set()
let failures = 0
const send = (res, status, body, extra = {}) => {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra })
  res.end(JSON.stringify(body))
}
// MOCK_NOAUTH=1 skips the login check, for headless screenshots only.
const authed = (req) => Boolean(process.env.MOCK_NOAUTH) || sessions.has(/(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1])
const readJson = (req) => new Promise((resolve, reject) => {
  let s = ''
  req.on('data', (c) => { s += c; if (s.length > 10000) reject(new Error('too big')) })
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch (e) { reject(e) } })
})
// ---- query validation, mirroring backend/http/routes.js (400 on anything malformed) ----
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 })
function text(url, key, max = 200) {
  const v = url.searchParams.get(key)
  if (v === null || v === '') return undefined
  if (v.length > max) throw badRequest(`Invalid ${key}.`)
  return v
}
const ISO = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/
// A bare date is a whole IST day: `from` is its first millisecond, `to` its last (inclusive).
function date(url, key) {
  const v = text(url, key, 40)
  if (v === undefined) return undefined
  const m = ISO.exec(v)
  const day = m && new Date(`${m[1]}T00:00:00Z`)
  const d = m && new Date(v.length === 10 ? `${v}T00:00:00+05:30` : v)
  if (!m || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== m[1] || Number.isNaN(d.getTime())) {
    throw badRequest(`Invalid ${key}: use YYYY-MM-DD or an ISO timestamp with a time zone.`)
  }
  return v.length === 10 && key === 'to' ? new Date(d.getTime() + 86_400_000 - 1) : d
}
function pageNo(url) {
  const v = text(url, 'page', 6) ?? '1'
  if (!/^\d+$/.test(v) || +v < 1 || +v > 10000) throw badRequest('Invalid page.')
  return +v
}
function pageOf(items, url) {
  const page = pageNo(url)
  return { items: items.slice((page - 1) * 50, page * 50), total: items.length, page, pageSize: 50 }
}
function rangeOf(url) {
  const from = date(url, 'from')
  const to = date(url, 'to')
  return (iso) => (!from || new Date(iso) >= from) && (!to || new Date(iso) <= to)
}
const matches = (q, ...fields) => !q || fields.some((f) => f && String(f).toLowerCase().includes(q.toLowerCase()))

function listBookings(url) {
  const status = text(url, 'status') ?? 'confirmed'
  if (!['confirmed', 'review', 'rejected'].includes(status)) throw badRequest('Invalid status.')
  const source = text(url, 'source')
  const q = text(url, 'q', 100)
  const inRange = rangeOf(url)
  const items = bookings
    .filter((b) => b.status === status && inRange(b.receivedAt))
    .filter((b) => !source || b.source === source || b.otherSources.some((o) => o.source === source))
    .filter((b) => matches(q, b.pickup, b.drop, b.contact, b.rawText))
    .sort((a, b) => (status === 'review' ? a.receivedAt.localeCompare(b.receivedAt) : b.receivedAt.localeCompare(a.receivedAt)))
  return items
}

async function serveStatic(res, file) {
  const full = path.resolve(ROOT, file)
  if (!full.startsWith(ROOT + path.sep) || !TYPES[path.extname(full)]) return send(res, 404, { error: 'Not found' })
  try {
    const body = await readFile(full)
    res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(full)], 'Cache-Control': 'no-store' })
    res.end(body)
  } catch {
    send(res, 404, { error: 'Not found' })
  }
}

// ---- routes ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const p = url.pathname
  try {
    if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, { error: 'Send JSON.' })
    }
    if (req.method === 'GET' && p === '/') return serveStatic(res, 'index.html')
    if (req.method === 'GET' && p === '/login') return serveStatic(res, 'login.html')
    if (req.method === 'POST' && p === '/login') {
      if (failures >= 5) return send(res, 429, { error: 'Too many attempts.', retryAfterSec: 600 })
      const { username, password } = await readJson(req)
      if (username !== 'admin' || password !== 'admin-password-123') { failures += 1; return send(res, 401, { error: 'Wrong username or password' }) }
      failures = 0
      const sid = randomBytes(16).toString('hex')
      sessions.add(sid)
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/` })
    }
    if (req.method === 'GET' && /^\/[\w-]+\.(js|css|html)$/.test(p)) return serveStatic(res, p.slice(1))

    if (!authed(req)) return send(res, 401, { error: 'Log in first.' })

    if (req.method === 'POST' && p === '/logout') {
      sessions.delete(/sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1])
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' })
    }
    if (req.method === 'GET' && p === '/api/me') return send(res, 200, { username: 'admin' })
    if (req.method === 'GET' && p === '/health') return send(res, 200, health())
    if (req.method === 'GET' && p === '/api/bookings') return send(res, 200, pageOf(listBookings(url), url))
    if (req.method === 'GET' && p === '/api/raw') {
      const group = text(url, 'group', 100)
      if (group !== undefined && !/^[\d-]+@g\.us$/.test(group)) throw badRequest('Invalid group.')
      const q = text(url, 'q', 100)
      const inRange = rangeOf(url)
      const items = raw
        .filter((m) => (!group || m.groupId === group) && inRange(m.timestamp) && matches(q, m.text))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      return send(res, 200, pageOf(items, url))
    }
    const action = /^\/api\/bookings\/([\w-]+)\/(confirm|reject|undo)$/.exec(p)
    if (req.method === 'POST' && action) {
      await readJson(req)
      const b = bookings.find((x) => x.id === action[1])
      if (!b) return send(res, 404, { error: 'No such booking.' })
      const [, , verb] = action
      if (verb === 'undo') {
        if (b.decidedBy !== 'admin' || !['confirmed', 'rejected'].includes(b.status)) return send(res, 409, { error: 'This booking was already changed. Reload.' })
        const outputsAlreadySent = b.status === 'confirmed' && (outputs.sheets || outputs.telegram || outputs.whatsappSend)
        Object.assign(b, { status: 'review', decidedAt: new Date().toISOString() })
        return send(res, 200, { item: b, outputsAlreadySent })
      }
      if (b.status !== 'review') return send(res, 409, { error: 'This booking was already changed. Reload.' })
      Object.assign(b, { status: verb === 'confirm' ? 'confirmed' : 'rejected', decidedBy: 'admin', decidedAt: new Date().toISOString() })
      return send(res, 200, { item: b })
    }
    if (req.method === 'GET' && p === '/export') {
      // The real backend streams .xlsx; the mock sends a CSV so it needs no dependencies.
      const rows = listBookings(url).map((b) => [b.receivedAt, b.pickup, b.drop, b.fare, b.contact].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bookings-MOCK.csv"' })
      return res.end(['receivedAt,pickup,drop,fare,contact', ...rows].join('\n'))
    }
    send(res, 404, { error: 'Not found' })
  } catch (e) {
    send(res, 400, { error: e.status === 400 ? e.message : `Bad request: ${e.message}` })
  }
})

// Loopback only: the preview must not be reachable from the LAN.
server.listen(PORT, '127.0.0.1', () => console.log(`DEV MOCK (made-up data) on http://localhost:${PORT}  login: admin / admin-password-123`))
