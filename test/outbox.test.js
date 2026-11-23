import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutbox } from '../backend/jobs/outbox.js'
import { fakeModel } from './fake-model.js'

const T0 = new Date('2026-11-23T06:00:00Z')
const min = (m) => new Date(T0.getTime() + m * 60_000)
const id = (n) => n.toString(16).padStart(24, '0')
const tick = () => new Promise((r) => setImmediate(r))

function booking(n, extra = {}) {
  return {
    _id: id(n), source: 'whatsapp:Cabs', rawText: `trip ${n}`, pickup: 'Delhi', drop: 'Agra', tripDateTime: null,
    carType: null, fare: null, contact: '9876543210', receivedAt: T0, confidence: 0.9, status: 'confirmed',
    decidedBy: 'rules', decidedAt: T0, otherSources: [], outputsSentAt: T0, outputAttempts: 0,
    delivered: { telegram: null, sheets: null, whatsappSend: null }, givenUp: { telegram: null, sheets: null, whatsappSend: null },
    ...extra,
  }
}

/**
 * Fake outputs, one entry in s.calls per output sent ('<n>:<output>'). results: output -> true, false,
 * 'unknown', or a function (call count, booking id) -> value or promise (e.g. a queued WhatsApp send).
 */
function rig(docs, { enabled = { telegram: true, sheets: true, whatsappSend: false }, results = {}, Booking } = {}) {
  const s = { t: min(3), calls: [], logs: [] }
  s.Booking = Booking ?? fakeModel(docs)
  const n = {}
  s.outputs = {
    status: () => ({ ...enabled }),
    async onConfirmed(b, { only } = {}) {
      const names = Object.keys(enabled).filter((k) => enabled[k] && (!only || only.includes(k)))
      const out = { telegram: null, sheets: null, whatsappSend: null }
      for (const k of names) {
        s.calls.push(`${Number.parseInt(b.id, 16)}:${k}`)
        n[k] = (n[k] ?? 0) + 1
        const r = results[k] ?? true
        out[k] = await (typeof r === 'function' ? r(n[k], b.id) : r)
      }
      return out
    },
  }
  const log = (level) => (o, msg) => s.logs.push({ level, o, msg })
  s.box = createOutbox({ Booking: s.Booking, outputs: s.outputs, now: () => s.t,
    logger: { info: log('info'), warn: log('warn'), error: log('error'), debug() {} } })
  s.doc = (n) => s.Booking.docs.find((d) => d._id === id(n))
  return s
}

test('outbox: deliver records each delivered output and counts the attempt', async () => {
  const s = rig([booking(1)], { results: { telegram: true, sheets: false } })
  await s.box.deliver({ id: id(1) })
  assert.deepEqual(s.doc(1).delivered, { telegram: min(3), sheets: null, whatsappSend: null })
  assert.equal(s.doc(1).outputAttempts, 1)
})

test('outbox: a crash between claim and send is recovered; delivered outputs are never re-sent', async () => {
  const s = rig([booking(1), booking(2, { delivered: { telegram: T0, sheets: null, whatsappSend: null }, outputAttempts: 1 })])
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram', '1:sheets', '2:sheets'])
  assert.ok(s.doc(1).delivered.telegram && s.doc(1).delivered.sheets && s.doc(2).delivered.sheets)
  await s.box.run()
  assert.equal(s.calls.length, 3, 'nothing left to send')
})

test('outbox: a failed Telegram send is retried later and then recorded', async () => {
  const s = rig([booking(1)], { results: { telegram: (n) => n > 1, sheets: true } })
  await s.box.deliver({ id: id(1) }) // the first send from onConfirmed
  assert.equal(s.doc(1).delivered.telegram, null)
  s.t = min(6)
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram', '1:sheets', '1:telegram'])
  assert.deepEqual(s.doc(1).delivered.telegram, min(6))
  assert.equal(s.doc(1).outputAttempts, 2)
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
  // Booking 2's first delivery is still running when the job reads [1, 2]; it finishes while the job
  // is busy with booking 1. The job must re-check booking 2 instead of using the stale row.
  const waits = {}
  const queued = (n, bid) => new Promise((r) => { (waits[bid] ??= []).push(() => r(true)) })
  const s = rig([booking(1), booking(2)], { enabled: { telegram: false, sheets: true, whatsappSend: true }, results: { whatsappSend: queued } })
  const first = s.box.deliver({ id: id(2) })
  await tick()
  const run = s.box.run()
  for (let i = 0; i < 5; i++) await tick()
  waits[id(2)].shift()() // booking 2's WhatsApp send finally goes out
  await first
  waits[id(1)].shift()()
  for (let i = 0; i < 10; i++) await tick()
  await run
  assert.deepEqual(s.calls.sort(), ['1:sheets', '1:whatsappSend', '2:sheets', '2:whatsappSend'])
})

test('outbox: outputs are recorded as each settles; a restart while WhatsApp is queued re-sends only WhatsApp', async () => {
  const enabled = { telegram: true, sheets: true, whatsappSend: true }
  const before = rig([booking(1)], { enabled, results: { whatsappSend: () => new Promise(() => {}) } }) // still queued
  before.box.deliver({ id: id(1) })
  for (let i = 0; i < 5; i++) await tick()
  assert.ok(before.doc(1).delivered.telegram && before.doc(1).delivered.sheets)
  assert.equal(before.doc(1).delivered.whatsappSend, null)
  // pm2 restart: a new process (new outbox) over the same stored bookings.
  const after = rig(null, { enabled, Booking: before.Booking })
  after.t = min(6)
  await after.box.run()
  assert.deepEqual(after.calls, ['1:whatsappSend'])
  assert.ok(after.doc(1).delivered.whatsappSend)
})

test('outbox: after 5 failed attempts it gives up with one error line and stops', async () => {
  const s = rig([booking(1)], { results: { telegram: false, sheets: true } })
  await s.box.deliver({ id: id(1) })
  for (let i = 0; i < 8; i++) { s.t = min(5 + i * 2); await s.box.run() }
  assert.deepEqual(s.calls, ['1:telegram', '1:sheets', '1:telegram', '1:telegram', '1:telegram', '1:telegram'])
  assert.equal(s.doc(1).outputAttempts, 5)
  assert.deepEqual(s.doc(1).givenUp.telegram, min(11))
  const errors = s.logs.filter((l) => l.level === 'error')
  assert.equal(errors.length, 1)
  assert.deepEqual(errors[0].o, { bookingId: id(1), failed: ['telegram'] })
  assert.deepEqual(await s.box.counts(), { outputsPending: 0, outputsFailed: 1 })
})

test('outbox: a disabled output is never missing', async () => {
  const s = rig([booking(1, { delivered: { telegram: T0, sheets: null, whatsappSend: null } })], { enabled: { telegram: true, sheets: false, whatsappSend: false } })
  await s.box.run()
  assert.deepEqual(s.calls, [])
  assert.deepEqual(await s.box.counts(), { outputsPending: 0, outputsFailed: 0 })
})

test('outbox: undo takes a booking out; re-confirm sends only what is missing', async () => {
  const s = rig([booking(1, { status: 'review', delivered: { telegram: T0, sheets: null, whatsappSend: null }, outputAttempts: 1 })])
  await s.box.run()
  assert.deepEqual(s.calls, [], 'in review: nothing sent')
  s.doc(1).status = 'confirmed' // re-confirmed by the admin (outputsSentAt stays from the first claim)
  await s.box.run()
  assert.deepEqual(s.calls, ['1:sheets'])
})

test('outbox: a Sheets append with an unknown outcome is given up at once, never retried', async () => {
  const s = rig([booking(1)], { results: { telegram: true, sheets: 'unknown' } })
  await s.box.deliver({ id: id(1) })
  assert.deepEqual(s.doc(1).givenUp.sheets, min(3))
  assert.equal(s.logs.filter((l) => l.level === 'error').length, 1)
  s.t = min(10)
  await s.box.run()
  assert.equal(s.calls.length, 2)
  assert.deepEqual(await s.box.counts(), { outputsPending: 0, outputsFailed: 1 })
})

test('outbox: counts pending bookings; bookings claimed over 24 h ago are left alone', async () => {
  const s = rig([booking(1), booking(2, { delivered: { telegram: T0, sheets: T0, whatsappSend: null } }),
    booking(3, { outputsSentAt: new Date(T0 - 25 * 3600_000) })])
  assert.deepEqual(await s.box.counts(), { outputsPending: 1, outputsFailed: 0 })
  await s.box.run()
  assert.deepEqual(s.calls, ['1:telegram', '1:sheets'])
})

test('outbox: start runs once at once and is unref-ed; stop clears it', async () => {
  const s = rig([booking(1)])
  s.box.start()
  s.box.stop()
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(s.calls.length, 2)
})
