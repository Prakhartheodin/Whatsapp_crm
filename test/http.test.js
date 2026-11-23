import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import ExcelJS from 'exceljs'
import { createApp } from '../backend/http/server.js'
import { hashPassword } from '../backend/auth/password.js'
import { toBooking, releaseIngestKeys } from '../backend/http/routes.js'
import { Booking } from '../backend/models.js'
import { fakeModel } from './fake-model.js'

// ---- fixtures ----
const PW = 'correct horse battery'
const TOKEN = 't'.repeat(40)
const SECRET = 's'.repeat(40)
const GROUP = '120363000000000001@g.us'
const id = (n) => n.toString(16).padStart(24, '0')
const passwordHash = await hashPassword(PW)
const now = Date.now()
const ago = (min) => new Date(now - min * 60_000)

function booking(n, status, decidedBy, extra = {}) {
  return {
    _id: id(n), source: 'whatsapp:Cabs', rawText: `trip ${n}`, pickup: 'Delhi', drop: 'Agra',
    pickupNorm: 'delhi', dropNorm: 'agra', tripDateTime: null, carType: 'Sedan', fare: 3500,
    contact: '9876543210', receivedAt: ago(100 - n), confidence: 0.9, rawMessageId: null,
    status, decidedBy, decidedAt: ago(1), otherSources: [], outputsSentAt: null, ...extra,
  }
}

async function start(t) {
  const models = {
    Admin: fakeModel([{ _id: 'admin', username: 'boss', passwordHash }]),
    Booking: fakeModel([
      booking(1, 'review', 'rules'),
      booking(2, 'review', 'rules', { rawMessageId: id(901) }),
      booking(3, 'confirmed', 'rules', { rawText: '=HYPERLINK("http://evil")', outputsSentAt: ago(5),
        otherSources: [{ source: 'app', rawMessageId: null, receivedAt: ago(3) }] }),
      booking(4, 'rejected', 'admin'),
      booking(5, 'confirmed', 'admin', { source: 'app', tripDateTime: new Date('2026-11-24T00:30:00Z') }),
    ]),
    IngestKey: fakeModel([], { unique: ['source', 'clientMessageId'] }),
    RawMessage: fakeModel([
      { _id: id(901), messageId: 'A', groupId: GROUP, groupName: 'Cabs', sender: '919876543210@s.whatsapp.net', text: 'hello', timestamp: ago(10) },
      { _id: id(902), messageId: 'B', groupId: GROUP, groupName: 'Cabs', sender: 'me', text: 'mine', timestamp: ago(5) },
    ]),
  }
  const confirmed = []
  const ingested = []
  const app = createApp({
    models,
    config: { apiToken: TOKEN, sessionSecret: SECRET, nodeEnv: 'test', targetGroupIds: [GROUP], heartbeatMinutes: 120 },
    getHealthState: () => ({
      whatsapp: { status: 'open', since: new Date(now) }, groupNames: new Map(), lastMessageAt: new Map(),
      heartbeat: { minutes: 120, windowStart: '08:00', windowEnd: '23:00', quiet: true, lastAlertAt: new Date(now) },
      outputs: { sheets: true, telegram: false, whatsappSend: false },
      outputCounts: async () => ({ outputsPending: 2, outputsFailed: 1 }),
    }),
    onConfirmed: (b) => confirmed.push(b),
    pipeline: {
      async processMessage(m) {
        ingested.push(m)
        // The real pipeline marks its validation errors like this (status 400, expose).
        if (m.rawText === 'rejected by pipeline') throw Object.assign(new Error('Pipeline says no.'), { status: 400, expose: true })
        return INGEST_RESULTS[m.rawText] ?? { status: 'ignored' }
      },
    },
    // Any logged error means a route failed (even after it had already answered).
    logger: { error: (o, msg) => errors.push(msg), warn() {}, info() {} },
  })
  const errors = []
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  t.after(() => {
    server.close()
    assert.deepEqual(errors, [])
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, { method = 'GET', body, headers = {}, auth = true } = {}) =>
    fetch(base + path, {
      method,
      headers: { ...(auth && { 'x-api-token': TOKEN }), ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
  const login = (username, password) => call('/login', { method: 'POST', body: { username, password }, auth: false })
  return { models, confirmed, ingested, call, login, errors }
}

const INGEST_RESULTS = {
  confirmed: { status: 'confirmed', bookingId: id(40) },
  review: { status: 'review', bookingId: id(41) },
  duplicate: { status: 'duplicate', duplicateOf: id(3) },
  ignored: { status: 'ignored' },
}

const signed = (payload, secret = SECRET) => {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `sid=${p}.${createHmac('sha256', secret).update(p).digest('base64url')}`
}

// ---- tests ----
test('every data route needs auth', async (t) => {
  const { call } = await start(t)
  for (const p of ['/api/me', '/api/bookings', '/api/raw', '/health', '/export']) {
    const res = await call(p, { auth: false })
    assert.equal(res.status, 401, p)
    assert.equal(typeof (await res.json()).error, 'string')
  }
  for (const p of [`/api/bookings/${id(1)}/confirm`, '/logout', '/ingest']) {
    assert.equal((await call(p, { method: 'POST', body: {}, auth: false })).status, 401, p)
  }
})

test('API token via header or query; wrong token rejected', async (t) => {
  const { call } = await start(t)
  assert.equal((await call('/api/bookings')).status, 200)
  assert.equal((await call(`/api/bookings?token=${TOKEN}`, { auth: false })).status, 200)
  assert.equal((await call('/api/me', { auth: false, headers: { 'x-api-token': 'x' + TOKEN.slice(1) } })).status, 401)
  assert.equal((await call('/api/me', { auth: false, headers: { 'x-api-token': 'short' } })).status, 401)
})

test('login sets a session cookie that authorises /api/me; logout clears it', async (t) => {
  const { call, login } = await start(t)
  const res = await login(' Boss ', PW)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  const set = res.headers.get('set-cookie')
  assert.match(set, /^sid=[\w-]+\.[\w-]+;/)
  assert.match(set, /HttpOnly/)
  assert.match(set, /SameSite=Strict/)
  assert.match(set, /Path=\//)
  assert.doesNotMatch(set, /Secure/)
  const cookie = set.split(';')[0]
  const me = await call('/api/me', { auth: false, headers: { cookie } })
  assert.equal(me.status, 200)
  assert.deepEqual(await me.json(), { username: 'boss' })

  const out = await call('/logout', { method: 'POST', body: {}, auth: false, headers: { cookie } })
  assert.equal(out.status, 200)
  assert.match(out.headers.get('set-cookie'), /^sid=;.*Expires=Thu, 01 Jan 1970/)
})

test('wrong password and unknown user get the same 401', async (t) => {
  const { login } = await start(t)
  const a = await login('boss', 'wrong password!')
  const b = await login('nobody', PW)
  assert.equal(a.status, 401)
  assert.equal(b.status, 401)
  assert.deepEqual(await a.json(), await b.json())
  assert.equal(a.headers.get('set-cookie'), null)
  assert.equal((await login(123, [])).status, 400)
})

test('6th failed login in the window gets 429, even with the right password', async (t) => {
  const { login } = await start(t)
  for (let i = 0; i < 5; i++) assert.equal((await login('boss', 'nope nope nope')).status, 401)
  const res = await login('boss', PW)
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.equal(typeof body.error, 'string')
  assert.ok(body.retryAfterSec > 0 && body.retryAfterSec <= 900)
})

test('tampered, foreign and expired cookies are rejected', async (t) => {
  const { call } = await start(t)
  const exp = now + 3600_000
  const ok = signed({ u: 'boss', exp })
  assert.equal((await call('/api/me', { auth: false, headers: { cookie: ok } })).status, 200)
  const [p, sig] = ok.slice(4).split('.')
  const tampered = `sid=${Buffer.from(JSON.stringify({ u: 'root', exp })).toString('base64url')}.${sig}`
  for (const cookie of [tampered, `sid=${p}.${sig.slice(0, -2)}`, signed({ u: 'boss', exp }, 'x'.repeat(40)),
    signed({ u: 'boss', exp: now - 1000 }), 'sid=garbage', 'sid=a.b.c']) {
    assert.equal((await call('/api/me', { auth: false, headers: { cookie } })).status, 401, cookie)
  }
})

test('bad query values give 400', async (t) => {
  const { call } = await start(t)
  for (const qs of ['status=foo', 'page=0', 'page=abc', 'page=1.5', 'page=999999', 'from=notadate',
    'to=2026-13-45', `q=${'a'.repeat(101)}`, 'q=a&q=b', 'from=2026-02-31', 'to=2026-02-30T10:00:00Z',
    'from=2026-11-23T10:00', 'from=2026-11-23T10:00:00', 'from=2026-11-23%2010:00Z', 'from=2026-11-23T25:00:00Z']) {
    const res = await call(`/api/bookings?${qs}`)
    assert.equal(res.status, 400, qs)
    assert.equal(typeof (await res.json()).error, 'string')
  }
  for (const qs of ['group=notagroup', 'page=-1', 'from=yesterday']) {
    assert.equal((await call(`/api/raw?${qs}`)).status, 400, qs)
  }
  assert.equal((await call('/export?from=nope')).status, 400)
})

test('bookings list: filters, ordering, paging shape', async (t) => {
  const { call } = await start(t)
  let body = await (await call('/api/bookings')).json()
  assert.equal(body.page, 1)
  assert.equal(body.pageSize, 50)
  assert.equal(body.total, 2)
  assert.deepEqual(body.items.map((b) => b.id), [id(5), id(3)]) // newest first
  const b = body.items[1]
  assert.deepEqual(Object.keys(b).sort(), ['carType', 'confidence', 'contact', 'decidedAt', 'decidedBy', 'drop', 'fare',
    'id', 'otherSources', 'pickup', 'rawText', 'receivedAt', 'source', 'status', 'tripDateTime'])
  assert.deepEqual(b.otherSources, [{ source: 'app', receivedAt: ago(3).toISOString() }])

  body = await (await call('/api/bookings?status=review')).json()
  assert.deepEqual(body.items.map((b) => b.id), [id(1), id(2)]) // oldest first
  body = await (await call('/api/bookings?source=app')).json()
  assert.deepEqual(body.items.map((b) => b.id), [id(5), id(3)]) // 3 was also posted from the app (otherSources)
  body = await (await call(`/api/bookings?source=${encodeURIComponent('whatsapp:Cabs')}`)).json()
  assert.deepEqual(body.items.map((b) => b.id), [id(3)])
  body = await (await call(`/api/bookings?q=${encodeURIComponent('HYPERLINK("')}`)).json()
  assert.deepEqual(body.items.map((b) => b.id), [id(3)]) // regex chars are literal
  body = await (await call(`/api/bookings?from=${encodeURIComponent(ago(96).toISOString())}`)).json()
  assert.deepEqual(body.items.map((b) => b.id), [id(5)])
  body = await (await call('/api/bookings?page=2')).json()
  assert.deepEqual([body.items.length, body.total, body.page], [0, 2, 2])
})

test('search matches pickup, drop, contact and raw text; source matches folded duplicates', async (t) => {
  const { call, models } = await start(t)
  models.Booking.docs.push(
    booking(30, 'review', 'rules', { pickup: 'Noida Sector 62', drop: 'Gurgaon', contact: '9123456789', rawText: 'need cab',
      source: 'whatsapp:A', otherSources: [{ source: 'whatsapp:B', rawMessageId: null, receivedAt: ago(1) }] }),
    booking(31, 'review', 'rules', { pickup: 'Agra', drop: 'Mathura', contact: null, rawText: 'Gurgaon drop wanted', source: 'whatsapp:B' }),
  )
  const ids = async (qs) => (await (await call(`/api/bookings?status=review&${qs}`)).json()).items.map((b) => b.id)
  assert.deepEqual(await ids('q=noida%20SECTOR'), [id(30)]) // pickup, case-insensitive
  assert.deepEqual(await ids('q=mathura'), [id(31)]) // drop
  assert.deepEqual(await ids('q=9123456'), [id(30)]) // contact
  assert.deepEqual(await ids('q=need%20cab'), [id(30)]) // raw text
  assert.deepEqual(await ids('q=gurgaon'), [id(30), id(31)]) // drop of one, raw text of the other
  assert.deepEqual(await ids('q=sector.62'), []) // regex chars stay literal
  assert.deepEqual(await ids(`source=${encodeURIComponent('whatsapp:B')}`), [id(30), id(31)]) // folded + primary
  assert.deepEqual(await ids(`source=${encodeURIComponent('whatsapp:A')}`), [id(30)])
  assert.deepEqual(await ids(`source=${encodeURIComponent('whatsapp:B')}&q=mathura`), [id(31)]) // both apply
  assert.deepEqual(await ids(`source=${encodeURIComponent('whatsapp:A')}&q=mathura`), [])
})

test('bare dates are IST days; timestamps need a zone; ties sort by id', async (t) => {
  const { call, models } = await start(t)
  const at = (iso) => new Date(iso)
  models.Booking.docs.push(
    booking(6, 'confirmed', 'rules', { receivedAt: at('2026-11-16T18:30:00.000Z') }), // 17 Nov 00:00 IST
    booking(9, 'confirmed', 'rules', { receivedAt: at('2026-11-16T18:30:00.000Z') }), // same second as 6
    booking(7, 'confirmed', 'rules', { receivedAt: at('2026-11-17T18:29:59.999Z') }), // 17 Nov 23:59:59.999 IST
    booking(8, 'confirmed', 'rules', { receivedAt: at('2026-11-17T18:30:00.000Z') }), // 18 Nov 00:00 IST
    booking(10, 'confirmed', 'rules', { receivedAt: at('2026-11-16T18:29:59.999Z') }), // 16 Nov IST
  )
  let body = await (await call('/api/bookings?from=2026-11-17&to=2026-11-17')).json()
  assert.deepEqual(body.items.map((b) => b.id), [id(7), id(9), id(6)])
  body = await (await call('/api/bookings?from=2026-11-17T00:00:00%2B05:30&to=2026-11-17T18:29:59.999Z')).json()
  assert.deepEqual(body.items.map((b) => b.id), [id(7), id(9), id(6)])
})

test('confirm / reject / undo state machine', async (t) => {
  const { call, confirmed, models } = await start(t)
  const post = (n, action) => call(`/api/bookings/${typeof n === 'number' ? id(n) : n}/${action}`, { method: 'POST', body: {} })

  let res = await post(1, 'confirm')
  assert.equal(res.status, 200)
  let { item } = await res.json()
  assert.equal(item.status, 'confirmed')
  assert.equal(item.decidedBy, 'admin')
  assert.equal(confirmed.length, 1)
  assert.equal(confirmed[0].id, id(1))

  assert.equal((await post(1, 'confirm')).status, 409)
  assert.equal((await post(1, 'reject')).status, 409)

  res = await post(1, 'undo')
  assert.equal(res.status, 200)
  const undo = await res.json()
  assert.equal(undo.item.status, 'review')
  assert.equal(undo.outputsAlreadySent, true)
  assert.equal((await post(1, 'undo')).status, 409)

  assert.equal((await post(1, 'confirm')).status, 200)
  assert.equal(confirmed.length, 1, 'outputs fire once, even after undo + confirm')
  assert.ok(models.Booking.docs[0].outputsSentAt)

  res = await post(2, 'reject')
  assert.equal(res.status, 200)
  assert.equal((await res.json()).item.status, 'rejected')
  res = await post(2, 'undo')
  assert.deepEqual([(await res.json()).outputsAlreadySent], [false])

  assert.equal((await post(3, 'undo')).status, 409, 'auto-confirmed rows cannot be undone')
  assert.equal((await post(3, 'reject')).status, 409)
  assert.equal((await post('nope', 'confirm')).status, 404)
  assert.equal((await post(id(999), 'confirm')).status, 404)
  assert.equal((await post(1, 'explode')).status, 404)
  assert.equal(confirmed.length, 1)
})

test('an undo landing between confirm and the outputs claim does not fire outputs', async (t) => {
  const { call, confirmed, models } = await start(t)
  const fau = models.Booking.findOneAndUpdate
  models.Booking.findOneAndUpdate = (...args) => {
    const q = fau(...args)
    models.Booking.docs[0].status = 'review' // concurrent undo after the confirm write
    return q
  }
  assert.equal((await call(`/api/bookings/${id(1)}/confirm`, { method: 'POST', body: {} })).status, 200)
  assert.equal(confirmed.length, 0)
  assert.equal(models.Booking.docs[0].outputsSentAt, null)
})

test('/api/raw masks senders and reports booking status', async (t) => {
  const { call, models } = await start(t)
  const res = await call(`/api/raw?group=${encodeURIComponent(GROUP)}`)
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(!text.includes('9876543210'))
  const body = JSON.parse(text)
  assert.equal(body.total, 2)
  assert.deepEqual(body.items.map((r) => [r.id, r.sender, r.bookingStatus]), [
    [id(902), 'me', null],
    [id(901), '91xxxxxxxx10', 'review'],
  ])
  assert.deepEqual(Object.keys(body.items[0]).sort(), ['bookingStatus', 'groupId', 'groupName', 'id', 'sender', 'text', 'timestamp'])

  // A message folded into booking 3 as a duplicate reports that booking's status.
  models.Booking.docs[2].otherSources.push({ source: 'whatsapp:Cabs', rawMessageId: id(902), receivedAt: ago(5) })
  const again = await (await call(`/api/raw?group=${encodeURIComponent(GROUP)}`)).json()
  assert.deepEqual(again.items.map((r) => [r.id, r.bookingStatus]), [[id(902), 'confirmed'], [id(901), 'review']])
})

test('security headers, JSON 404 for unknown /api, non-JSON POST rejected', async (t) => {
  const { call } = await start(t)
  for (const p of ['/', '/login']) {
    const res = await call(p, { auth: false })
    assert.equal(res.status, 200, p)
    assert.match(res.headers.get('content-type'), /^text\/html/)
    assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'")
  }
  for (const res of [await call('/api/me', { auth: false }), await call('/api/nope'), await call('/api/me')]) {
    assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'")
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('x-powered-by'), null)
  }
  const nf = await call('/api/nope')
  assert.equal(nf.status, 404)
  assert.equal(typeof (await nf.json()).error, 'string')

  const form = await call('/login', { method: 'POST', auth: false, body: 'username=boss&password=x',
    headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal(form.status, 415)
  const plain = await call(`/api/bookings/${id(1)}/confirm`, { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })
  assert.equal(plain.status, 415)
  const broken = await call('/login', { method: 'POST', auth: false, body: '{"username":' })
  assert.equal(broken.status, 400)
  assert.equal(typeof (await broken.json()).error, 'string')
})

test('export streams an xlsx of confirmed bookings, formulas stay text', async (t) => {
  const { call } = await start(t)
  const res = await call('/export?from=2026-01-01T00:00:00Z&to=2030-01-01T00:00:00Z')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="?bookings-2026-01-01-2030-01-01\.xlsx"?$/)
  const buf = Buffer.from(await res.arrayBuffer())
  assert.ok(buf.length > 0)

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets[0]
  assert.equal(ws.getRow(1).getCell(1).value, 'Received (IST)')
  assert.equal(ws.getRow(1).getCell(11).value, 'Original message')
  assert.equal(ws.rowCount, 3) // header + 2 confirmed
  const evil = ws.getRow(2).getCell(11)
  assert.equal(evil.value, '=HYPERLINK("http://evil")')
  assert.equal(evil.type, ExcelJS.ValueType.String)
  assert.equal(ws.getRow(2).getCell(9).value, 'app') // other sources
  assert.equal(ws.getRow(3).getCell(2).value, '2026-11-24 06:00') // trip time in IST
  assert.equal(ws.getRow(3).getCell(6).value, 3500)

  // Dashboard sends IST midnights as UTC: 17 Nov 00:00 IST .. 18 Nov 00:00 IST -> named after 17 Nov.
  const day = await call('/export?from=2026-11-16T18:30:00.000Z&to=2026-11-17T18:30:00.000Z')
  assert.match(day.headers.get('content-disposition'), /bookings-2026-11-17-2026-11-17\.xlsx/)
  await day.arrayBuffer()
  const bare = await call('/export?from=2026-11-17&to=2026-11-18')
  assert.match(bare.headers.get('content-disposition'), /bookings-2026-11-17-2026-11-18\.xlsx/)
  await bare.arrayBuffer()

  const filtered = await call('/export?source=app')
  assert.match(filtered.headers.get('content-disposition'), /bookings-all-all\.xlsx/)
  const wb2 = new ExcelJS.Workbook()
  await wb2.xlsx.load(Buffer.from(await filtered.arrayBuffer()))
  assert.equal(wb2.worksheets[0].rowCount, 3) // header + 5 (primary app) + 3 (app in otherSources)
})

test('export failing mid-stream: connection is cut, error logged once through our logger', async (t) => {
  const { call, models, errors } = await start(t)
  const find = models.Booking.find
  models.Booking.find = (...args) => {
    const q = find(...args)
    q.cursor = async function* () {
      for (let i = 0; i < 5000; i++) yield { ...models.Booking.docs[2], rawText: 'x'.repeat(200) + i }
      throw new Error('cursor lost')
    }
    return q
  }
  const stderr = []
  const original = console.error
  console.error = (...a) => stderr.push(a)
  t.after(() => { console.error = original })
  // Headers are already out, so no 500 is possible: the client must see a failed download.
  await assert.rejects(call('/export').then((res) => res.arrayBuffer()))
  console.error = original
  assert.deepEqual(stderr, []) // Express's default handler would print the raw stack here
  assert.deepEqual(errors.splice(0), ['request failed mid-response'])
})

test('/health shape, "today" starts at IST midnight', async (t) => {
  const { call, models } = await start(t)
  // Clock: 2030-01-01 00:30 IST. IST midnight = 2029-12-31T18:30:00Z.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2029-12-31T19:00:00Z') })
  const before = new Date('2029-12-31T18:29:59.999Z')
  const after = new Date('2029-12-31T18:30:00.000Z')
  models.RawMessage.docs.push(
    { _id: id(903), messageId: 'C', groupId: GROUP, groupName: 'Cabs', sender: 'me', text: 'late', timestamp: before },
    { _id: id(904), messageId: 'D', groupId: GROUP, groupName: 'Cabs', sender: 'me', text: 'early', timestamp: after },
  )
  models.Booking.docs.push(
    booking(20, 'confirmed', 'rules', { receivedAt: before, otherSources: [{ source: 'app', receivedAt: before }] }),
    booking(21, 'confirmed', 'rules', { receivedAt: after, otherSources: [{ source: 'app', receivedAt: after }] }),
  )
  const h = await (await call('/health')).json()
  assert.equal(h.whatsapp.status, 'open')
  assert.equal(h.lastMessageAt, after.toISOString())
  assert.deepEqual(h.perGroup, [{ id: GROUP, name: 'Cabs', lastMessageAt: after.toISOString(), countToday: 1 }])
  assert.deepEqual(h.counts, { rawToday: 1, bookingsToday: 1, reviewPending: 2, duplicatesToday: 1, outputsPending: 2, outputsFailed: 1 })
  // Injected heartbeat state and outputs status are passed through.
  assert.deepEqual(h.heartbeat, { minutes: 120, windowStart: '08:00', windowEnd: '23:00', quiet: true, lastAlertAt: new Date(now).toISOString() })
  assert.deepEqual(h.outputs, { sheets: true, telegram: false, whatsappSend: false })
})

test('POST /ingest: runs the pipeline and passes its result through', async (t) => {
  const { call, ingested } = await start(t)
  const receivedAt = new Date(Date.now() - 3600_000).toISOString()
  for (const rawText of Object.keys(INGEST_RESULTS)) {
    const res = await call('/ingest', { method: 'POST', body: { source: 'app', rawText, receivedAt } })
    assert.equal(res.status, 200, rawText)
    assert.deepEqual(await res.json(), INGEST_RESULTS[rawText])
  }
  assert.equal(ingested.length, 4)
  assert.deepEqual(ingested[0], { source: 'app', rawText: 'confirmed', receivedAt: new Date(receivedAt) })
  assert.ok(ingested[0].receivedAt instanceof Date)

  const res = await call('/ingest', { method: 'POST', body: { source: 'app', rawText: 'rejected by pipeline', receivedAt } })
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: 'Pipeline says no.' })
})

test('POST /ingest: invalid bodies get 400 and never reach the pipeline', async (t) => {
  const { call, ingested } = await start(t)
  const ok = { source: 'app', rawText: 'confirmed', receivedAt: new Date(Date.now() - 60_000).toISOString() }
  const soon = new Date(Date.now() + 4 * 60_000).toISOString()
  const late = new Date(Date.now() + 6 * 60_000).toISOString()
  const stale = new Date(Date.now() - 7 * 86_400_000 - 60_000).toISOString() // older than 7 days
  for (const patch of [
    { source: undefined }, { source: '' }, { source: '   ' }, { source: 'x'.repeat(101) }, { source: 5 },
    { rawText: undefined }, { rawText: '' }, { rawText: '  \n ' }, { rawText: 'x'.repeat(4001) }, { rawText: ['a'] },
    { receivedAt: undefined }, { receivedAt: '2026-11-23' }, { receivedAt: '2026-11-23T09:15:00' }, { receivedAt: 'yesterday' },
    { receivedAt: '2026-02-30T09:15:00Z' }, { receivedAt: '2026-11-23T25:00:00Z' }, { receivedAt: 1732350000000 }, { receivedAt: late }, { receivedAt: stale },
  ]) {
    const res = await call('/ingest', { method: 'POST', body: { ...ok, ...patch } })
    assert.equal(res.status, 400, JSON.stringify(patch).slice(0, 80))
    assert.equal(typeof (await res.json()).error, 'string')
  }
  for (const body of ['[]', 'null', '"text"']) {
    assert.equal((await call('/ingest', { method: 'POST', body })).status, 400, body)
  }
  assert.equal(ingested.length, 0)
  // Edge of the limits is fine: 100-char source, 4000-char text, 4 minutes ahead (clock skew).
  for (const body of [{ ...ok, source: 's'.repeat(100), rawText: 'x'.repeat(4000) }, { ...ok, receivedAt: soon }]) {
    assert.equal((await call('/ingest', { method: 'POST', body })).status, 200)
  }
})

test('POST /ingest: JSON only', async (t) => {
  const { call, ingested } = await start(t)
  const res = await call('/ingest', { method: 'POST', body: 'source=app&rawText=hi', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal(res.status, 415)
  assert.equal((await call('/ingest', { method: 'POST' })).status, 415) // no body, no content type
  assert.equal(ingested.length, 0)
})

test('toBooking gives outputs the same shape from a Mongoose document as from a lean row', () => {
  const doc = new Booking({ ...booking(50, 'confirmed', 'rules', { _id: undefined }), otherSources: [{ source: 'app', rawMessageId: id(7), receivedAt: ago(1) }] })
  const fromDoc = toBooking(doc)
  assert.deepEqual(fromDoc, toBooking(doc.toObject()))
  assert.equal(fromDoc.id, String(doc._id))
  assert.deepEqual(fromDoc.otherSources, [{ source: 'app', receivedAt: ago(1) }])
})

test('POST /ingest: 60 per rolling minute per credential and IP, then 429 with retryAfterSec', async (t) => {
  const { call, ingested, login } = await start(t)
  const body = { source: 'app', rawText: 'ignored', receivedAt: new Date().toISOString() }
  for (let i = 0; i < 60; i++) assert.equal((await call('/ingest', { method: 'POST', body })).status, 200, String(i))
  const res = await call('/ingest', { method: 'POST', body })
  assert.equal(res.status, 429)
  const err = await res.json()
  assert.equal(typeof err.error, 'string')
  assert.ok(err.retryAfterSec > 0 && err.retryAfterSec <= 60)
  assert.equal(res.headers.get('retry-after'), String(err.retryAfterSec))
  assert.equal(ingested.length, 60)
  // The dashboard session is a different credential with its own budget.
  const cookie = (await login('boss', PW)).headers.get('set-cookie').split(';')[0]
  assert.equal((await call('/ingest', { method: 'POST', body, auth: false, headers: { cookie } })).status, 200)
})

test('POST /ingest: a repeated source + clientMessageId returns the first result without running the pipeline', async (t) => {
  const { call, ingested, models, errors } = await start(t)
  const body = { source: 'app', rawText: 'confirmed', receivedAt: new Date().toISOString(), clientMessageId: 'msg-1' }
  const first = await (await call('/ingest', { method: 'POST', body })).json()
  assert.deepEqual(first, INGEST_RESULTS.confirmed)
  const again = await call('/ingest', { method: 'POST', body: { ...body, rawText: 'review' } })
  assert.equal(again.status, 200)
  assert.deepEqual(await again.json(), first)
  assert.equal(ingested.length, 1)
  // Same id from another source, or no id at all: processed normally.
  await call('/ingest', { method: 'POST', body: { ...body, source: 'app2' } })
  await call('/ingest', { method: 'POST', body: { ...body, clientMessageId: undefined } })
  assert.equal(ingested.length, 3)
  assert.equal(models.IngestKey.docs.length, 2)
  // Bad ids are rejected; a pipeline 400 frees the id for a corrected retry.
  for (const clientMessageId of ['', 'x'.repeat(101), 5]) {
    assert.equal((await call('/ingest', { method: 'POST', body: { ...body, clientMessageId } })).status, 400)
  }
  const bad = { ...body, clientMessageId: 'msg-2', rawText: 'rejected by pipeline' }
  assert.equal((await call('/ingest', { method: 'POST', body: bad })).status, 400)
  assert.equal((await call('/ingest', { method: 'POST', body: { ...bad, rawText: 'review' } })).status, 200)
  // A repeat while the first is still being processed is told to retry.
  models.IngestKey.docs.push({ source: 'app', clientMessageId: 'busy', result: null, createdAt: ago(1) })
  assert.equal((await call('/ingest', { method: 'POST', body: { ...body, clientMessageId: 'busy' } })).status, 409)
  // Keys without a result can only belong to this process (the start frees the previous process's),
  // so even an old one is a request still running (e.g. queued behind a slow LLM): never taken over.
  models.IngestKey.docs.push({ source: 'app', clientMessageId: 'slow', result: null, createdAt: ago(30) })
  const before = ingested.length
  assert.equal((await call('/ingest', { method: 'POST', body: { ...body, clientMessageId: 'slow' } })).status, 409)
  assert.equal(ingested.length, before)
  // If storing the result fails, the key is freed (a retry runs again; de-duplication folds the copy).
  const updateOne = models.IngestKey.updateOne
  models.IngestKey.updateOne = async () => { throw new Error('mongo blip') }
  const stored = await call('/ingest', { method: 'POST', body: { ...body, clientMessageId: 'unsaved' } })
  models.IngestKey.updateOne = updateOne
  assert.equal(stored.status, 200)
  assert.deepEqual(await stored.json(), INGEST_RESULTS.confirmed)
  assert.equal(models.IngestKey.docs.some((d) => d.clientMessageId === 'unsaved'), false)
  assert.deepEqual(errors.splice(0), ['could not store the /ingest result; key freed'])
  // The key's source is case- and space-insensitive (the booking keeps the source as sent).
  const n = ingested.length
  const same = await call('/ingest', { method: 'POST', body: { ...body, source: ' APP ' } })
  assert.deepEqual(await same.json(), first)
  assert.equal(ingested.length, n)
})

test('releaseIngestKeys: at start, keys without a result (their request died with the process) are freed', async () => {
  const IngestKey = fakeModel([
    { source: 'app', clientMessageId: 'a', result: null },
    { source: 'app', clientMessageId: 'b', result: { status: 'ignored' } },
  ])
  await releaseIngestKeys(IngestKey)
  assert.deepEqual(IngestKey.docs.map((d) => d.clientMessageId), ['b'])
})
