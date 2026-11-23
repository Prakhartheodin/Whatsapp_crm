import test from 'node:test'
import assert from 'node:assert/strict'
import { createHeartbeat } from '../backend/jobs/heartbeat.js'
import { createRetention } from '../backend/jobs/retention.js'

const IST_MS = 5.5 * 3600_000
// Wall-clock time in IST on 2026-01-<day>.
const ist = (h, m = 0, day = 2) => new Date(Date.UTC(2026, 0, day, h, m) - IST_MS)
const logger = { info() {}, warn() {}, error() {}, debug() {} }

function rig({ last, status = 'open', since = ist(0) } = {}) {
  const s = { t: ist(12), last, wa: { status, since }, alerts: [] }
  s.hb = createHeartbeat({
    config: { heartbeatMinutes: 120, sessionDownAlertMinutes: 10 },
    getLastMessageAt: async () => s.last,
    getWaStatus: () => s.wa,
    alert: async (text) => { s.alerts.push(text); return true },
    now: () => s.t,
    logger,
  })
  s.at = async (t) => { s.t = t; await s.hb.check() }
  return s
}

test('heartbeat: quiet alert once inside the window, then silent; re-arms after a message', async () => {
  const s = rig({ last: ist(11) })
  await s.at(ist(12, 59))
  assert.equal(s.alerts.length, 0)
  assert.equal(s.hb.state().quiet, false)
  await s.at(ist(13, 0))
  assert.equal(s.alerts.length, 1)
  assert.match(s.alerts[0], /120 minutes/)
  assert.deepEqual(s.hb.state(), { minutes: 120, windowStart: '08:00', windowEnd: '23:00', quiet: true, lastAlertAt: ist(13, 0) })
  await s.at(ist(13, 5))
  await s.at(ist(18, 0))
  assert.equal(s.alerts.length, 1, 'no repeats')

  s.last = ist(18, 2)
  await s.at(ist(18, 5))
  assert.equal(s.hb.state().quiet, false)
  await s.at(ist(20, 2))
  assert.equal(s.alerts.length, 2, 're-armed by the new message')
})

test('heartbeat: nothing outside 08:00-23:00 IST; overnight gap not counted', async () => {
  const s = rig({ last: ist(20, 0, 1) })
  await s.at(ist(23, 30, 1))
  await s.at(ist(3, 0))
  await s.at(ist(7, 55))
  assert.equal(s.alerts.length, 0)
  assert.equal(s.hb.state().quiet, false)
  await s.at(ist(9, 0))
  await s.at(ist(9, 59))
  assert.equal(s.alerts.length, 0, 'clock starts at 08:00')
  await s.at(ist(10, 0))
  assert.equal(s.alerts.length, 1)
})

test('heartbeat: a multi-day silence alerts again once per day, never twice in a day', async () => {
  const s = rig({ last: ist(9, 0, 1) })
  await s.at(ist(12, 0, 1))
  await s.at(ist(22, 55, 1))
  assert.equal(s.alerts.length, 1)
  await s.at(ist(9, 0, 2))
  assert.equal(s.alerts.length, 1, 'new day: quiet counts from 08:00')
  await s.at(ist(10, 0, 2))
  await s.at(ist(15, 0, 2))
  assert.equal(s.alerts.length, 2)
  await s.at(ist(10, 0, 3))
  assert.equal(s.alerts.length, 3)
})

test('heartbeat: an alert that keeps failing is logged at warn once, then at debug', async () => {
  const levels = []
  const log = (level) => () => levels.push(level)
  const hb = createHeartbeat({
    config: { heartbeatMinutes: 120, sessionDownAlertMinutes: 10 },
    getLastMessageAt: async () => ist(9), getWaStatus: () => ({ status: 'open', since: ist(0) }),
    alert: async () => false, now: () => ist(12), logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
  })
  for (let i = 0; i < 4; i++) await hb.check()
  assert.deepEqual(levels, ['warn', 'debug', 'debug', 'debug'])
})

test('heartbeat: a failed alert is retried on the next check', async () => {
  const s = rig({ last: ist(9) })
  let ok = false
  const hb = createHeartbeat({
    config: { heartbeatMinutes: 120, sessionDownAlertMinutes: 10 },
    getLastMessageAt: async () => s.last, getWaStatus: () => s.wa, now: () => s.t, logger,
    alert: async (text) => { s.alerts.push(text); return ok },
  })
  s.t = ist(12); await hb.check()
  ok = true
  s.t = ist(12, 5); await hb.check()
  s.t = ist(12, 10); await hb.check()
  assert.equal(s.alerts.length, 2)
})

test('heartbeat: session down alerts after N minutes even if since keeps moving, then recovery', async () => {
  const s = rig({ last: ist(11, 55), status: 'reconnecting', since: ist(12) })
  await s.at(ist(12, 5))
  assert.equal(s.alerts.length, 0)
  s.wa = { status: 'reconnecting', since: ist(12, 7) } // each reconnect attempt resets waState.since
  await s.at(ist(12, 10))
  assert.equal(s.alerts.length, 1)
  assert.match(s.alerts[0], /reconnecting/)
  s.wa = { status: 'connecting', since: ist(12, 12) }
  await s.at(ist(12, 15))
  assert.equal(s.alerts.length, 1, 'no repeat while still down')
  s.wa = { status: 'open', since: ist(12, 18) }
  await s.at(ist(12, 20))
  assert.equal(s.alerts.length, 2)
  assert.match(s.alerts[1], /back online/)
  await s.at(ist(12, 25))
  assert.equal(s.alerts.length, 2)
})

test('heartbeat: short drop -> no alert and no recovery alert', async () => {
  const s = rig({ last: ist(11, 55), status: 'reconnecting', since: ist(12) })
  await s.at(ist(12, 5))
  s.wa = { status: 'open', since: ist(12, 6) }
  await s.at(ist(12, 10))
  assert.equal(s.alerts.length, 0)
})

test('heartbeat: stop statuses alert immediately, once (also outside the window)', async () => {
  for (const status of ['logged_out', 'replaced', 'blocked', 'needs_link']) {
    const s = rig({ last: ist(1), status, since: ist(2) })
    await s.at(ist(2))
    await s.at(ist(2, 5))
    assert.equal(s.alerts.length, 1, status)
    assert.match(s.alerts[0], new RegExp(status))
  }
  // reconnecting already alerted, then a stop status: that is new information
  const s = rig({ last: ist(11, 55), status: 'reconnecting', since: ist(12) })
  await s.at(ist(12, 10))
  s.wa = { status: 'logged_out', since: ist(12, 11) }
  await s.at(ist(12, 15))
  assert.equal(s.alerts.length, 2)
})

test('heartbeat: a failing getLastMessageAt is logged, not thrown', async () => {
  const errors = []
  const hb = createHeartbeat({
    config: { heartbeatMinutes: 120, sessionDownAlertMinutes: 10 },
    getLastMessageAt: async () => { throw new Error('mongo down') },
    getWaStatus: () => ({ status: 'open', since: ist(0) }),
    alert: async () => true, now: () => ist(12), logger: { ...logger, error: (...a) => errors.push(a) },
  })
  await hb.check()
  assert.equal(errors.length, 1)
})

test('heartbeat and retention timers are unref-ed and cleared by stop()', () => {
  const real = globalThis.setInterval
  const timers = []
  globalThis.setInterval = (...a) => { const t = real(...a); timers.push({ t, ms: a[1] }); return t }
  try {
    const hb = rig({ last: ist(11) }).hb
    const ret = createRetention({ RawMessage: { deleteMany: async () => ({ deletedCount: 0 }) }, config: { retentionDays: 30 }, logger })
    hb.start()
    ret.start()
    assert.deepEqual(timers.map((x) => [x.ms, x.t.hasRef()]), [[5 * 60_000, false], [86_400_000, false]])
    hb.stop()
    ret.stop()
    assert.ok(timers.every((x) => x.t._destroyed), 'cleared')
  } finally {
    globalThis.setInterval = real
  }
})

test('retention: deletes raw messages older than RETENTION_DAYS, logs only the count', async () => {
  const filters = []
  const lines = []
  const RawMessage = { deleteMany: async (f) => { filters.push(f); return { deletedCount: 7 } } }
  const now = new Date('2026-03-31T00:00:00.000Z')
  const r = createRetention({ RawMessage, config: { retentionDays: 30 }, now: () => now, logger: { info: (...a) => lines.push(a), error() {} } })
  assert.equal(await r.run(), 7)
  assert.deepEqual(filters, [{ timestamp: { $lt: new Date('2026-03-01T00:00:00.000Z') } }])
  assert.deepEqual(lines[0][0], { deleted: 7, retentionDays: 30 })
  r.start() // runs once at start
  r.stop()
  await new Promise((res) => setImmediate(res))
  assert.equal(filters.length, 2)
})

test('retention: 0 disables purging', async () => {
  let called = false
  const RawMessage = { deleteMany: async () => { called = true; return { deletedCount: 0 } } }
  const r = createRetention({ RawMessage, config: { retentionDays: 0 }, logger })
  assert.equal(await r.run(), 0)
  r.start()
  r.stop()
  assert.equal(called, false)
})

test('config: RETENTION_DAYS rejects negative and non-numeric, accepts 0', async () => {
  const load = (v) => {
    process.env.RETENTION_DAYS = v
    return import(`../backend/config.js?retention=${encodeURIComponent(v)}`)
  }
  try {
    await assert.rejects(load('-1'), /RETENTION_DAYS/)
    await assert.rejects(load('abc'), /RETENTION_DAYS/)
    assert.equal((await load('0')).config.retentionDays, 0)
    process.env.WHATSAPP_SEND_ENABLED = 'yes'
    await assert.rejects(load('5'), /WHATSAPP_SEND_ENABLED/)
  } finally {
    delete process.env.WHATSAPP_SEND_ENABLED
    delete process.env.RETENTION_DAYS
  }
  assert.equal((await import('../backend/config.js?retention=default')).config.retentionDays, 30)
})

test('heartbeat: concurrent checks (onStop + timer) send a stop-status alert once', async () => {
  const s = rig({ status: 'logged_out', last: ist(11) })
  let release
  const gate = new Promise((r) => { release = r })
  const hb = createHeartbeat({
    config: { heartbeatMinutes: 120, sessionDownAlertMinutes: 10 },
    getLastMessageAt: async () => s.last, getWaStatus: () => s.wa, now: () => s.t, logger,
    alert: async (text) => { s.alerts.push(text); await gate; return true }, // slow Telegram
  })
  const both = Promise.all([hb.check(), hb.check()])
  release()
  await both
  assert.equal(s.alerts.length, 1)
})

test('heartbeat: without an alert channel (Telegram off) an alert is logged once, not retried', async () => {
  const levels = []
  const log = (level) => () => levels.push(level)
  const hb = createHeartbeat({
    config: { heartbeatMinutes: 120, sessionDownAlertMinutes: 10 },
    getLastMessageAt: async () => ist(9), getWaStatus: () => ({ status: 'open', since: ist(0) }),
    alert: null, now: () => ist(12), logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
  })
  for (let i = 0; i < 4; i++) await hb.check()
  assert.deepEqual(levels, ['warn'])
  assert.equal(hb.state().lastAlertAt, null, 'nothing was delivered')
  assert.equal(hb.state().quiet, true)
})

test('heartbeat: an alert with an unknown outcome (Telegram timeout) is not counted as sent and is retried', async () => {
  const s = rig({ last: ist(9) })
  const results = ['unknown', true]
  const hb = createHeartbeat({
    config: { heartbeatMinutes: 120, sessionDownAlertMinutes: 10 },
    getLastMessageAt: async () => s.last, getWaStatus: () => s.wa, now: () => s.t, logger,
    alert: async (text) => { s.alerts.push(text); return results.shift() },
  })
  s.t = ist(12); await hb.check()
  assert.equal(hb.state().lastAlertAt, null)
  s.t = ist(12, 5); await hb.check()
  s.t = ist(12, 10); await hb.check()
  assert.equal(s.alerts.length, 2)
  assert.deepEqual(hb.state().lastAlertAt, ist(12, 5))
})
