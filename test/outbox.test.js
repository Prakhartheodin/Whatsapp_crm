import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutbox } from '../backend/jobs/outbox.js'
import { fakeModel } from './fake-model.js'

const T0 = new Date('2026-11-23T06:00:00Z')
const min = (m) => new Date(T0.getTime() + m * 60_000)
const id = (n) => n.toString(16).padStart(24, '0')
const tick = () => new Promise((r) => setImmediate(r))
const none = () => ({ telegram: null, sheets: null, whatsappSend: null })

function booking(n, extra = {}) {
  return {
    _id: id(n), source: 'whatsapp:Cabs', rawText: `trip ${n}`, pickup: 'Delhi', drop: 'Agra', tripDateTime: null,
    carType: null, fare: null, contact: '9876543210', receivedAt: T0, confidence: 0.9, status: 'confirmed',
    decidedBy: 'rules', decidedAt: T0, otherSources: [], outputsSentAt: T0, outputAttempts: 0, lastAttemptAt: null,
    wanted: ['telegram', 'sheets'], delivered: none(), sending: none(), givenUp: none(),
    ...extra,
  }
}

/**
 * Fake outputs. s.calls gets '<n>:<output>' per output sent, with '+r' when labelled as a possible repeat
 * and '+c' when Sheets was asked to check for its row first. results: output -> true, false, 'unknown',
 * or a function (call count) -> value or promise (e.g. a queued WhatsApp send).
 */
function rig(docs, { enabled = { telegram: true, sheets: true, whatsappSend: false }, results = {}, Booking } = {}) {
  const s = { t: min(3), calls: [], logs: [] }
  s.Booking = Booking ?? fakeModel(docs)
  const n = {}
  s.outputs = {
    status: () => ({ ...enabled }),
    async onConfirmed(b, { only, repeat, check, onStart } = {}) {
      const names = Object.keys(enabled).filter((k) => enabled[k] && (!only || only.includes(k)))
      const out = none()
      for (const k of names) {
        s.calls.push(`${Number.parseInt(b.id, 16)}:${k}${repeat ? '+r' : ''}${check && k === 'sheets' ? '+c' : ''}`)
        n[k] = (n[k] ?? 0) + 1
        const r = results[k] ?? true
        if (typeof r !== 'function' && k === 'whatsappSend') await onStart?.()
        out[k] = await (typeof r === 'function' ? r(n[k], onStart) : r)
      }
      return out
    },
  }
  const log = (level) => (o, msg) => s.logs.push({ level, o, msg })
  s.box = createOutbox({ Booking: s.Booking, outputs: s.outputs, now: () => s.t, sleep: async () => {},
    logger: { info: log('info'), warn: log('warn'), error: log('error'), debug() {} } })
  s.doc = (n) => s.Booking.docs.find((d) => d._id === id(n))
  s.errors = () => s.logs.filter((l) => l.level === 'error')
  return s
}

test('outbox: the first delivery snapshots the enabled outputs, records each one and counts the attempt', async () => {
  const s = rig([booking(1, { wanted: undefined })], { results: { telegram: true, sheets: false } })
  await s.box.deliver({ id: id(1) })
  assert.deepEqual(s.doc(1).wanted, ['telegram', 'sheets'])
  assert.deepEqual(s.doc(1).delivered, { telegram: min(3), sheets: null, whatsappSend: null })
  assert.deepEqual(s.doc(1).sending, none(), 'markers cleared once the outcome is known')
  assert.equal(s.doc(1).outputAttempts, 1)
  assert.deepEqual(s.doc(1).lastAttemptAt, min(3))
})

test('outbox: a crash between claim and send is recovered; delivered outputs are never re-sent', async () => {
  const s = rig([booking(1), booking(2, { delivered: { telegram: T0, sheets: null, whatsappSend: null }, outputAttempts: 1 })])
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram', '1:sheets+c', '2:sheets+c'])
  assert.ok(s.doc(1).delivered.telegram && s.doc(1).delivered.sheets && s.doc(2).delivered.sheets)
  await s.box.run()
  assert.equal(s.calls.length, 3, 'nothing left to send')
})

test('outbox: a clean Telegram failure is retried without the repeat label, then recorded', async () => {
  const s = rig([booking(1)], { results: { telegram: (n) => n > 1, sheets: true } })
  await s.box.deliver({ id: id(1) }) // the first send from onConfirmed
  assert.equal(s.doc(1).delivered.telegram, null)
  s.t = min(6)
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram', '1:sheets', '1:telegram'])
  assert.deepEqual(s.doc(1).delivered.telegram, min(6))
  assert.equal(s.doc(1).outputAttempts, 2)
})

test('outbox: a crash after Telegram sent but before it was recorded gives one labelled repeat, then delivered', async () => {
  // The write-ahead marker is there, the delivery is not: the outcome of that send is unknown.
  const s = rig([booking(1, { wanted: ['telegram'], sending: { telegram: min(0), sheets: null, whatsappSend: null }, outputAttempts: 1 })])
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram+r'])
  assert.ok(s.doc(1).delivered.telegram)
  assert.equal(s.doc(1).sending.telegram, null)
  s.t = min(30)
  await s.box.run()
  assert.equal(s.calls.length, 1)
})

test('outbox: an unknown outcome (timeout) leaves the marker, so the retry is labelled', async () => {
  const s = rig([booking(1)], { enabled: { telegram: true, sheets: false, whatsappSend: false }, results: { telegram: (n) => (n === 1 ? 'unknown' : true) } })
  await s.box.deliver({ id: id(1) })
  assert.ok(s.doc(1).sending.telegram)
  s.t = min(6)
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram', '1:telegram+r'])
})

test('outbox: recording a delivery that fails twice then succeeds causes no repeat', async () => {
  const s = rig([booking(1)], { enabled: { telegram: true, sheets: false, whatsappSend: false } })
  const updateOne = s.Booking.updateOne
  let failures = 0
  s.Booking.updateOne = async (f, u) => {
    if (u.$set?.['delivered.telegram'] && failures < 2) { failures++; throw new Error('mongo blip') }
    return updateOne(f, u)
  }
  await s.box.deliver({ id: id(1) })
  assert.ok(s.doc(1).delivered.telegram)
  s.t = min(10)
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram'])
})

test('outbox: Sheets is retried with a check for its row, also after an unknown outcome (never given up for it)', async () => {
  const s = rig([booking(1)], { enabled: { telegram: false, sheets: true, whatsappSend: false }, results: { sheets: (n) => (n === 1 ? 'unknown' : true) } })
  await s.box.deliver({ id: id(1) })
  assert.equal(s.doc(1).givenUp.sheets, null)
  s.t = min(6)
  await s.box.run()
  assert.deepEqual(s.calls, ['1:sheets', '1:sheets+r+c'])
  assert.ok(s.doc(1).delivered.sheets)
})

test('outbox: only claims older than 2 minutes, oldest first, never one being delivered right now', async () => {
  const s = rig([booking(1, { outputsSentAt: min(2) }), booking(2, { outputsSentAt: min(0.5) }), booking(3, { outputsSentAt: min(0) })])
  await s.box.run()
  assert.deepEqual(s.calls.map((c) => c.split(':')[0]), ['3', '3', '2', '2'])

  let release
  const slow = rig([booking(4)], { results: { telegram: () => new Promise((r) => { release = () => r(true) }) } })
  const first = slow.box.deliver({ id: id(4) }) // e.g. a send waiting in a queue
  await tick()
  slow.t = min(10)
  await slow.box.run()
  release()
  await first
  assert.deepEqual(slow.calls, ['4:telegram', '4:sheets'])
})

test('outbox: a first delivery that finishes after the retry batch was read is not sent again (stale batch)', async () => {
  const waits = {}
  const enabled = { telegram: false, sheets: true, whatsappSend: true }
  const s = rig([booking(1, { wanted: ['sheets', 'whatsappSend'] }), booking(2, { wanted: undefined })], { enabled,
    results: { whatsappSend: () => new Promise((r) => { (waits.q ??= []).push(() => r(true)) }) } })
  const first = s.box.deliver({ id: id(2) })
  await tick()
  const run = s.box.run()
  for (let i = 0; i < 5; i++) await tick()
  waits.q.shift()() // booking 2's WhatsApp send finally goes out
  await first
  for (let i = 0; i < 5; i++) await tick()
  waits.q.shift()()
  for (let i = 0; i < 10; i++) await tick()
  await run
  assert.deepEqual(s.calls.sort(), ['1:sheets+c', '1:whatsappSend', '2:sheets', '2:whatsappSend'])
})

test('outbox: a restart while WhatsApp is still queued (not started) re-sends only WhatsApp, unlabelled', async () => {
  const enabled = { telegram: true, sheets: true, whatsappSend: true }
  const before = rig([booking(1, { wanted: undefined })], { enabled, results: { whatsappSend: () => new Promise(() => {}) } })
  before.box.deliver({ id: id(1) })
  for (let i = 0; i < 5; i++) await tick()
  assert.ok(before.doc(1).delivered.telegram && before.doc(1).delivered.sheets)
  assert.equal(before.doc(1).delivered.whatsappSend, null)
  const after = rig(null, { enabled, Booking: before.Booking }) // pm2 restart: new process, same store
  after.t = min(6)
  await after.box.run()
  assert.deepEqual(after.calls, ['1:whatsappSend'], 'never reached the socket: no label')
  assert.ok(after.doc(1).delivered.whatsappSend)
})

test('outbox: a restart after the WhatsApp send started (socket call under way) re-sends it labelled', async () => {
  const enabled = { telegram: false, sheets: false, whatsappSend: true }
  const before = rig([booking(1, { wanted: undefined })], { enabled,
    results: { whatsappSend: async (n, onStart) => { await onStart(); return new Promise(() => {}) } } })
  before.box.deliver({ id: id(1) })
  for (let i = 0; i < 5; i++) await tick()
  assert.ok(before.doc(1).sending.whatsappSend)
  const after = rig(null, { enabled, Booking: before.Booking })
  after.t = min(6)
  await after.box.run()
  assert.deepEqual(after.calls, ['1:whatsappSend+r'])
})

test('outbox: 5 quick attempts, one error line at the switch, then hourly retries', async () => {
  const s = rig([booking(1)], { results: { telegram: false, sheets: true } })
  await s.box.deliver({ id: id(1) })
  for (let i = 1; i <= 8; i++) { s.t = min(3 + i * 2); await s.box.run() } // quick attempts 2-5, then nothing
  assert.deepEqual(s.calls, ['1:telegram', '1:sheets', '1:telegram', '1:telegram', '1:telegram', '1:telegram'])
  assert.equal(s.doc(1).outputAttempts, 5)
  assert.deepEqual(s.errors().map((l) => l.o), [{ bookingId: id(1), failed: ['telegram'] }])
  assert.match(s.errors()[0].msg, /hourly/)
  assert.deepEqual(await s.box.counts(), { outputsPending: 1, outputsFailed: 0 })
  const lastQuick = s.doc(1).lastAttemptAt
  s.t = new Date(lastQuick.getTime() + 59 * 60_000)
  await s.box.run()
  assert.equal(s.calls.length, 6, 'not yet an hour')
  s.t = new Date(lastQuick.getTime() + 60 * 60_000)
  await s.box.run()
  assert.equal(s.calls.length, 7)
  assert.equal(s.errors().length, 1, 'no more error lines while retrying hourly')
})

test('outbox: a 26-hour outage recovers by itself', async () => {
  const s = rig([booking(1, { outputAttempts: 5, lastAttemptAt: min(-60) })])
  s.t = new Date(T0.getTime() + 26 * 3600_000)
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram', '1:sheets+c'])
  assert.ok(s.doc(1).delivered.telegram && s.doc(1).delivered.sheets)
})

test('outbox: after 7 days the missing outputs are given up, counted and logged once', async () => {
  const s = rig([booking(1, { delivered: { telegram: T0, sheets: null, whatsappSend: null }, outputAttempts: 40, lastAttemptAt: T0 })])
  s.t = new Date(T0.getTime() + 7 * 86_400_000 + 60_000)
  await s.box.run()
  await s.box.run()
  assert.deepEqual(s.calls, [])
  assert.ok(s.doc(1).givenUp.sheets)
  assert.equal(s.doc(1).givenUp.telegram, null)
  assert.deepEqual(s.errors().map((l) => l.o), [{ output: 'sheets', bookings: 1 }])
  assert.deepEqual(await s.box.counts(), { outputsPending: 0, outputsFailed: 1 })
})

test('outbox: an output enabled later is not sent for older bookings; a disabled one is not pending', async () => {
  const s = rig([booking(1, { wanted: ['telegram'], delivered: { telegram: T0, sheets: null, whatsappSend: null } })])
  await s.box.run()
  assert.deepEqual(s.calls, [], 'sheets was not enabled when booking 1 was confirmed')
  assert.deepEqual(await s.box.counts(), { outputsPending: 0, outputsFailed: 0 })
  const off = rig([booking(2, { delivered: { telegram: T0, sheets: null, whatsappSend: null } })], { enabled: { telegram: true, sheets: false, whatsappSend: false } })
  await off.box.run()
  assert.deepEqual(off.calls, [])
  assert.deepEqual(await off.box.counts(), { outputsPending: 0, outputsFailed: 0 })
})

test('outbox: bookings from before this change (no wanted list, already attempted) are left alone', async () => {
  const s = rig([booking(1, { wanted: undefined, outputAttempts: 1 })])
  await s.box.run()
  assert.deepEqual(s.calls, [])
})

test('outbox: undo takes a booking out; re-confirm sends only what is missing', async () => {
  const s = rig([booking(1, { status: 'review', delivered: { telegram: T0, sheets: null, whatsappSend: null }, outputAttempts: 1 })])
  await s.box.run()
  assert.deepEqual(s.calls, [], 'in review: nothing sent')
  s.doc(1).status = 'confirmed' // re-confirmed by the admin (outputsSentAt stays from the first claim)
  await s.box.run()
  assert.deepEqual(s.calls, ['1:sheets+c'])
})

test('outbox: counts pending bookings', async () => {
  const s = rig([booking(1), booking(2, { delivered: { telegram: T0, sheets: T0, whatsappSend: null } }), booking(3, { status: 'review' })])
  assert.deepEqual(await s.box.counts(), { outputsPending: 1, outputsFailed: 0 })
})

test('outbox: start runs once at once and is unref-ed; stop clears it', async () => {
  const s = rig([booking(1)])
  s.box.start()
  s.box.stop()
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(s.calls.length, 2)
})

test('outbox: a claim whose first attempt never got recorded (write failed or process died) is delivered later and counted', async () => {
  const s = rig([booking(1, { wanted: undefined })], { enabled: { telegram: true, sheets: false, whatsappSend: false } })
  const real = s.Booking.findOneAndUpdate
  let fail = true
  s.Booking.findOneAndUpdate = (...a) => {
    if (fail) { fail = false; return { lean: async () => { throw new Error('mongo blip') } } }
    return real(...a)
  }
  await s.box.deliver({ id: id(1) }) // the first attempt's update throws: nothing sent, nothing recorded
  assert.deepEqual(s.calls, [])
  assert.equal(s.doc(1).outputAttempts, 0)
  assert.deepEqual(await s.box.counts(), { outputsPending: 1, outputsFailed: 0 })
  s.t = min(3)
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram'])
  assert.deepEqual(s.doc(1).wanted, ['telegram'], 'the snapshot is taken by the retry')
  assert.ok(s.doc(1).delivered.telegram)
  assert.deepEqual(await s.box.counts(), { outputsPending: 0, outputsFailed: 0 })
})

test('outbox: such a claim still undelivered after 7 days is given up and counted', async () => {
  const s = rig([booking(1, { wanted: undefined })], { enabled: { telegram: true, sheets: false, whatsappSend: false } })
  s.t = new Date(T0.getTime() + 8 * 86_400_000)
  await s.box.run()
  assert.ok(s.doc(1).givenUp.telegram)
  assert.deepEqual(await s.box.counts(), { outputsPending: 0, outputsFailed: 1 })
})
