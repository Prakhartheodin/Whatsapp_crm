import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSender, resetSenderForTests } from '../backend/whatsapp/send.js'

const JID = '919876543210@s.whatsapp.net'
const on = { whatsappSendEnabled: true, targetNumber: '919876543210' }

test.beforeEach(() => resetSenderForTests())

function fakeLogger() {
  const lines = []
  const log = (level) => (...args) => lines.push({ level, args })
  return { lines, warn: log('warn'), error: log('error'), info: log('info') }
}

/** Fake clock + socket: sleep advances the clock instead of waiting. */
function rig({ open = true, random = () => 0 } = {}) {
  let t = Date.UTC(2026, 0, 1)
  const sleeps = []
  const sent = []
  let active = 0
  let maxActive = 0
  const sock = {
    ws: { isOpen: open },
    sendMessage: async (jid, content) => {
      maxActive = Math.max(maxActive, ++active)
      await new Promise((r) => setImmediate(r))
      sent.push({ jid, content, at: t })
      active--
      return {}
    },
  }
  const deps = {
    getSock: () => sock,
    logger: fakeLogger(),
    sleep: async (ms) => { sleeps.push(ms); t += ms },
    random,
    now: () => new Date(t),
  }
  return { deps, sock, sleeps, sent, maxActive: () => maxActive }
}

test('sender: refuses when disabled and never touches the socket', async () => {
  let touched = false
  const s = createSender({ whatsappSendEnabled: false, targetNumber: '919876543210' }, { getSock: () => { touched = true }, logger: fakeLogger() })
  assert.equal(s.enabled, false)
  await assert.rejects(s.send('hi'), /WHATSAPP_SEND_ENABLED/)
  assert.equal(touched, false)
})

test('sender: enabled without a valid TARGET_NUMBER fails at start-up', () => {
  for (const targetNumber of ['', undefined, '12345', 'abc', '1234567890123456', '91987654321@g.us']) {
    assert.throws(() => createSender({ whatsappSendEnabled: true, targetNumber }, rig().deps), /TARGET_NUMBER/)
  }
})

test('sender: only one enabled sender per process (one shared limit and queue)', () => {
  createSender(on, rig().deps)
  assert.throws(() => createSender(on, rig().deps), /already/)
  // a disabled one is harmless and allowed
  assert.equal(createSender({ whatsappSendEnabled: false }, rig().deps).enabled, false)
})

test('sender: recipient is always TARGET_NUMBER; delay 3-8 s before each send; no link preview', async () => {
  const r = rig({ random: () => 0.999 })
  const s = createSender(on, r.deps)
  assert.equal(await s.send('hello https://x.example', 'other@s.whatsapp.net'), true)
  assert.deepEqual(r.sent.map((x) => [x.jid, x.content]), [[JID, { text: 'hello https://x.example', linkPreview: null }]])
  assert.ok(r.sleeps[0] >= 3000 && r.sleeps[0] <= 8000, `delay ${r.sleeps[0]}`)
  assert.ok(Object.isFrozen(s))
  resetSenderForTests()
  const r2 = rig({ random: () => 0 })
  await createSender(on, r2.deps).send('x')
  assert.deepEqual(r2.sleeps, [3000])
  resetSenderForTests()
  const r3 = rig({ random: () => NaN }) // a bad random source still gives a delay in range
  await createSender(on, r3.deps).send('x')
  assert.deepEqual(r3.sleeps, [3000])
})

test('sender: at most 10 per rolling minute, strictly sequential, FIFO; random delay also after a limit wait', async () => {
  const r = rig({ random: () => 0.5 }) // 5.5 s delay
  const s = createSender(on, r.deps)
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => s.send(`m${i}`)))
  assert.ok(results.every(Boolean))
  assert.deepEqual(r.sent.map((x) => x.content.text), Array.from({ length: 12 }, (_, i) => `m${i}`))
  assert.equal(r.maxActive(), 1)
  const at = r.sent.map((x) => x.at)
  assert.ok(at[9] - at[0] < 60_000, 'first 10 are not delayed by the limit')
  for (let i = 0; i + 10 < at.length; i++) assert.ok(at[i + 10] - at[i] >= 60_000)
  assert.equal(at[10] - at[0], 60_000 + 5500, '11th: window wait, then the random delay')
})

test('sender: queue capped at 100, overflow dropped with a warning', async () => {
  const r = rig()
  r.deps.sleep = () => new Promise(() => {}) // first send never finishes its delay
  const s = createSender(on, r.deps)
  for (let i = 0; i < 100; i++) s.send(`m${i}`)
  assert.equal(await s.send('overflow'), false)
  assert.ok(r.deps.logger.lines.some((l) => l.level === 'warn' && /queue full/.test(l.args.at(-1))))
})

test('sender: skipped with a warning when the socket is not open', async () => {
  const r = rig({ open: false })
  let current = r.sock
  const s = createSender(on, { ...r.deps, getSock: () => current })
  assert.equal(await s.send('x'), false)
  current = undefined // no socket at all
  assert.equal(await s.send('x'), false)
  assert.equal(r.sent.length, 0)
  assert.ok(r.deps.logger.lines.some((l) => l.level === 'warn'))
})

test('sender: a sendMessage that throws is an unknown outcome (it may have gone out); the queue keeps going', async () => {
  const r = rig()
  let n = 0
  const real = r.sock.sendMessage
  r.sock.sendMessage = async (...a) => { if (n++ === 0) throw new Error('socket gone'); return real(...a) }
  const s = createSender(on, r.deps)
  assert.deepEqual(await Promise.all([s.send('a'), s.send('b')]), ['unknown', true])
})

// ---- Ban-risk guard: nothing else in the codebase may send, mark read, show presence, join, look up contacts ----
const BANNED = /\b(sendMessage|relayMessage|readMessages|sendReceipts?|sendReadReceipt|sendPresenceUpdate|presenceSubscribe|groupAcceptInvite\w*|chatModify|groupParticipantsUpdate|onWhatsApp|updateBlockStatus|rejectCall)\b/g
// Exact, reviewed text that names a banned word for another reason (Telegram's Bot API method).
const ALLOWED_TEXT = { 'backend/outputs/telegram.js': 'api.telegram.org/bot${token}/sendMessage' }
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function findBanned(rel, src) {
  const code = stripComments(src).split(ALLOWED_TEXT[rel] ?? '\0').join('')
  const hits = [...code.matchAll(BANNED)].map((m) => m[1])
  if (rel === 'backend/whatsapp/send.js' && hits.length === 1 && hits[0] === 'sendMessage') return []
  return hits
}

test('ban-risk scanner catches aliased, computed and stored calls, ignores comments', () => {
  for (const src of [
    "sock['sendMessage'](j, m)", 'const { sendMessage } = sock; sendMessage(j, m)', 'sock.sendMessage.call(sock, j, m)',
    'sock.sendMessage?.(j, m)', 'const f = sock.readMessages; f(keys)', 'await sock.onWhatsApp(n)', 'sock.rejectCall(id, from)',
    'sock.groupParticipantsUpdate(g, [p], "add")', 'sock.updateBlockStatus(j, "block")', 'sock.groupAcceptInviteV4(k, m)',
    'const u = "http://x"; sock.sendPresenceUpdate("available")',
  ]) assert.notDeepEqual(findBanned('backend/x.js', src), [], src)
  assert.deepEqual(findBanned('backend/x.js', '// never call readMessages\n/* or sendMessage */ const a = 1'), [])
  assert.deepEqual(findBanned('backend/whatsapp/send.js', 'sock.sendMessage(jid, c)'), [])
  assert.notDeepEqual(findBanned('backend/whatsapp/send.js', 'sock.sendMessage(a); sock.sendMessage(b)'), [])
  assert.notDeepEqual(findBanned('backend/whatsapp/send.js', 'sock.sendMessage(a); sock.readMessages(k)'), [])
})

test('no WhatsApp send/read/presence/join/lookup calls outside whatsapp/send.js', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const offenders = []
  for (const dir of ['backend', 'scripts']) {
    for (const f of await fs.readdir(path.join(root, dir), { recursive: true })) {
      if (!f.endsWith('.js')) continue
      const rel = path.join(dir, f).replaceAll('\\', '/')
      const hits = findBanned(rel, await fs.readFile(path.join(root, rel), 'utf8'))
      if (hits.length) offenders.push(`${rel}: ${hits.join(', ')}`)
    }
  }
  assert.deepEqual(offenders, [])
  const sendSrc = await fs.readFile(path.join(root, 'backend/whatsapp/send.js'), 'utf8')
  assert.equal([...stripComments(sendSrc).matchAll(/\bsendMessage\b/g)].length, 1, 'send.js sends from exactly one place')
})
