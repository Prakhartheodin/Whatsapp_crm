import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// capture.js reads the target groups from config at import, so the env is set before importing it.
const GROUP = '120363000000000009@g.us'
process.env.TARGET_GROUP_IDS = GROUP
process.env.LOG_LEVEL = 'silent'
const { extractText, pickSender, toDate, replaySpool, attachCapture, setPipeline, lastMessageAt, feedUnprocessed,
  seedGroupNames, loadGroupNames, groupNames } = await import('../backend/whatsapp/capture.js')
const { RawMessage, Booking } = await import('../backend/models.js')
const { maskPhone, maskObject, maskJids } = await import('../backend/logger.js')

test('extractText: plain, extended, caption, wrapped, non-text', () => {
  assert.equal(extractText({ conversation: ' hi ' }).text, 'hi')
  assert.equal(extractText({ extendedTextMessage: { text: 'link msg' } }).text, 'link msg')
  assert.equal(extractText({ imageMessage: { caption: 'Delhi to Agra' } }).text, 'Delhi to Agra')
  assert.equal(extractText({ ephemeralMessage: { message: { conversation: 'gone soon' } } }).text, 'gone soon')
  assert.deepEqual(extractText({ audioMessage: {} }), { type: 'audioMessage', text: null })
  assert.equal(extractText({ imageMessage: {} }).text, null)
})

test('phone numbers are masked in logs', () => {
  assert.equal(maskPhone('+91 98765-43210'), '91xxxxxxxx10')
  const out = maskObject({
    jid: '919876543210@s.whatsapp.net',
    device: '919876543210:12@s.whatsapp.net',
    lid: '123456789012345@lid',
    group: '120363012345678901@g.us',
    ts: 1732350000000,
    err: new Error('bad 919876543210@s.whatsapp.net'),
  })
  assert.equal(out.jid, '91xxxxxxxx10@s.whatsapp.net')
  assert.equal(out.device, '91xxxxxxxx10:12@s.whatsapp.net')
  assert.equal(out.lid, '12xxxxxxxxxxx45@lid')
  assert.equal(out.group, '120363012345678901@g.us')
  assert.equal(out.ts, 1732350000000)
  assert.equal(out.err.message, 'bad 91xxxxxxxx10@s.whatsapp.net')
})

test('pickSender prefers the phone-number JID, whichever field holds it', () => {
  const pn = '919876543210@s.whatsapp.net'
  const lid = '123456789012345@lid'
  assert.equal(pickSender({ participant: lid, participantAlt: pn }), pn) // LID-addressed group
  assert.equal(pickSender({ participant: pn, participantAlt: lid }), pn) // PN-addressed group
  assert.equal(pickSender({ participant: lid }), lid) // no phone number known
  assert.equal(pickSender({ participant: pn, fromMe: true }), 'me')
  assert.equal(pickSender({}), '')
})

test('toDate: seconds to Date, missing or invalid falls back to now', () => {
  assert.equal(toDate(1732350000).getTime(), 1732350000000)
  assert.equal(toDate({ toString: () => '1732350000' }).getTime(), 1732350000000) // Long-like
  for (const bad of [undefined, null, 0, 'x']) {
    assert.ok(Math.abs(toDate(bad).getTime() - Date.now()) < 1000)
  }
})

test('@hosted JIDs are masked too', () => {
  assert.equal(maskJids('a 919876543210@hosted b 123456789012345@hosted.lid'), 'a 91xxxxxxxx10@hosted b 12xxxxxxxxxxx45@hosted.lid')
})

test('replaySpool: stores every good line, keeps failures, sets aside unreadable ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spool-'))
  const file = path.join(dir, 'raw.jsonl')
  const doc = (id) => JSON.stringify({ groupId: 'g@g.us', messageId: id, text: 't', timestamp: '2026-11-23T10:00:00.000Z' })
  await fs.writeFile(file, [doc('a'), '{"cut', doc('fail'), doc('b')].join('\n') + '\n')

  const stored = []
  const store = async (d) => {
    if (d.messageId === 'fail') throw new Error('mongo down')
    stored.push(d.messageId)
  }
  await replaySpool(file, store)
  assert.deepEqual(stored, ['a', 'b'])
  assert.equal(await fs.readFile(file, 'utf8'), doc('fail') + '\n') // only the failed line is left
  assert.equal(await fs.readFile(path.join(dir, 'raw.rejected.jsonl'), 'utf8'), '{"cut\n')

  await replaySpool(file, async (d) => stored.push(d.messageId)) // replay is the same upsert: safe to repeat
  await assert.rejects(fs.access(file)) // file removed once every line is stored
  await fs.rm(dir, { recursive: true })
})

// ---- capture -> pipeline hook (RawMessage.updateOne is replaced by an in-memory upsert) ----
// Replaces model statics for one test; restored afterwards.
function patch(t, model, fns) {
  const saved = Object.fromEntries(Object.keys(fns).map((k) => [k, model[k]]))
  Object.assign(model, fns)
  t.after(() => Object.assign(model, saved))
}
const query = (v) => ({ sort() { return this }, lean: async () => structuredClone(v) })

function fakeStore(t) {
  const rows = new Map()
  rows.processed = [] // raw ids marked processedAt
  const original = RawMessage.updateOne
  RawMessage.updateOne = async ({ _id, groupId, messageId }, update) => {
    if (_id) {
      assert.ok(update.$set.processedAt instanceof Date)
      rows.processed.push(_id)
      return { modifiedCount: 1 }
    }
    const key = groupId + '/' + messageId
    if (rows.has(key)) return { upsertedCount: 0, upsertedId: null }
    rows.set(key, 'oid-' + messageId)
    return { upsertedCount: 1, upsertedId: rows.get(key) }
  }
  t.after(() => {
    RawMessage.updateOne = original
    setPipeline(null)
  })
  return rows
}
const settle = () => new Promise((r) => setImmediate(r))

function socket() {
  const handlers = {}
  attachCapture({ ev: { on: (name, fn) => { handlers[name] = fn } } })
  return (...messages) => handlers['messages.upsert']({ messages, type: 'notify' })
}
const msg = (id, text, groupId = GROUP) => ({
  key: { remoteJid: groupId, id, participant: '919876543210@s.whatsapp.net' },
  message: { conversation: text },
  messageTimestamp: 1732350000,
})

test('capture: each newly stored message goes to the pipeline once, repeats and other groups do not', async (t) => {
  const rows = fakeStore(t)
  const seen = []
  setPipeline((m) => seen.push(m))
  const upsert = socket()
  await upsert(msg('A', ' Delhi to Agra '), msg('A', 'Delhi to Agra'), msg('B', 'other group', '120363000000000001@g.us'), msg('C', 'hello'))
  await upsert(msg('A', 'Delhi to Agra')) // redelivered after a reconnect
  await settle()
  assert.equal(rows.size, 2)
  assert.deepEqual(seen, [
    { source: `whatsapp:${GROUP}`, rawText: 'Delhi to Agra', receivedAt: new Date(1732350000000), rawMessageId: 'oid-A' },
    { source: `whatsapp:${GROUP}`, rawText: 'hello', receivedAt: new Date(1732350000000), rawMessageId: 'oid-C' },
  ])
  assert.deepEqual(lastMessageAt.get(GROUP), new Date(1732350000000))
})

test('capture: an over-long message reaches the pipeline cut to its 4000-char limit', async (t) => {
  fakeStore(t)
  const seen = []
  setPipeline((m) => seen.push(m))
  await socket()(msg('L', 'x'.repeat(5000)))
  await settle()
  assert.equal(seen[0].rawText.length, 4000)
})

test('capture: a pipeline that throws or rejects never breaks capture', async (t) => {
  const rows = fakeStore(t)
  let calls = 0
  setPipeline((m) => {
    calls++
    if (m.rawText === 'sync') throw new Error('boom')
    return Promise.reject(new Error('async boom'))
  })
  const upsert = socket()
  await upsert(msg('S', 'sync'), msg('R', 'async'), msg('N', 'next'))
  await settle()
  assert.equal(rows.size, 3)
  assert.equal(calls, 3)
})

test('capture: the pipeline is not awaited before the next message is stored', async (t) => {
  const rows = fakeStore(t)
  setPipeline(() => new Promise(() => {})) // never settles
  await socket()(msg('P1', 'one'), msg('P2', 'two'))
  assert.equal(rows.size, 2)
})

test('replaySpool: newly stored spooled messages go to the pipeline, already stored ones do not', async (t) => {
  const rows = fakeStore(t)
  rows.set(GROUP + '/old', 'oid-old')
  const seen = []
  setPipeline((m) => seen.push(m))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spool-'))
  const file = path.join(dir, 'raw.jsonl')
  const line = (messageId, text) => JSON.stringify({ groupId: GROUP, messageId, groupName: 'Cabs', sender: 'me', text, timestamp: '2026-11-23T10:00:00.000Z' })
  await fs.writeFile(file, [line('old', 'stored before'), line('new', 'Delhi to Agra')].join('\n') + '\n')
  await replaySpool(file)
  await settle()
  assert.deepEqual(seen, [{ source: 'whatsapp:Cabs', rawText: 'Delhi to Agra', receivedAt: new Date('2026-11-23T10:00:00.000Z'), rawMessageId: 'oid-new' }])
  await fs.rm(dir, { recursive: true })
})

test('capture: processedAt is set once the pipeline resolves, never when it fails', async (t) => {
  const rows = fakeStore(t)
  setPipeline(async (m) => {
    if (m.rawText === 'fails') throw new Error('mongo blip inside the pipeline')
    return { status: 'ignored' }
  })
  await socket()(msg('OK', 'fine'), msg('F', 'fails'))
  await settle()
  await settle()
  assert.deepEqual(rows.processed, ['oid-OK'])
})

test('feedUnprocessed: re-feeds unprocessed rows of the last 48 h oldest first; linked rows are only marked', async (t) => {
  const rows = fakeStore(t)
  const now = new Date('2026-11-23T12:00:00Z')
  const raw = (id, hoursAgo, extra = {}) => ({ _id: id, groupId: GROUP, messageId: id, groupName: 'Cabs', sender: 'me',
    text: 'text ' + id, timestamp: new Date(now - hoursAgo * 3600_000), processedAt: null, ...extra })
  const stored = [raw('a'.repeat(24), 1), raw('b'.repeat(24), 30), raw('c'.repeat(24), 49), raw('d'.repeat(24), 2, { processedAt: now }),
    raw('e'.repeat(24), 3), raw('f'.repeat(24), 4)]
  let findFilter
  const marked = []
  patch(t, RawMessage, {
    find(f) {
      findFilter = f
      return query(stored.filter((r) => r.processedAt === null && r.timestamp >= f.timestamp.$gte).sort((x, y) => x.timestamp - y.timestamp))
    },
    async updateMany(f, u) { marked.push(...f._id.$in.map(String)); assert.ok(u.$set.processedAt) },
  })
  // e already became a booking, f was folded into another one: the crash came after the booking write.
  patch(t, Booking, { find: () => query([{ rawMessageId: 'e'.repeat(24) }, { rawMessageId: '9'.repeat(24), otherSources: [{ rawMessageId: 'f'.repeat(24) }] }]) })
  const seen = []
  setPipeline((m) => { seen.push(m); return new Promise(() => {}) }) // still queued: stays in flight
  await Promise.all([feedUnprocessed(now), feedUnprocessed(now)])
  await feedUnprocessed(now) // a MongoDB reconnect while they are still queued
  await settle()
  assert.equal(findFilter.processedAt, null)
  assert.deepEqual(findFilter.timestamp.$gte, new Date(now - 48 * 3600_000))
  assert.deepEqual(seen.map((m) => String(m.rawMessageId)), ['b'.repeat(24), 'a'.repeat(24)], 'oldest first, once each')
  assert.deepEqual(seen[1], { source: 'whatsapp:Cabs', rawText: 'text ' + 'a'.repeat(24), receivedAt: stored[0].timestamp, rawMessageId: 'a'.repeat(24) })
  // Marked processed on each of the two runs (the fake does not persist the mark).
  assert.deepEqual(marked, ['f'.repeat(24), 'e'.repeat(24), 'f'.repeat(24), 'e'.repeat(24)]) // oldest first
  assert.equal(rows.processed.length, 0)
})

test('feedUnprocessed: a newly captured message in flight is not fed a second time', async (t) => {
  fakeStore(t)
  const seen = []
  setPipeline((m) => { seen.push(m); return new Promise(() => {}) })
  await socket()(msg('X', 'live one'))
  patch(t, RawMessage, { find: () => query([{ _id: 'oid-X', groupId: GROUP, groupName: GROUP, text: 'live one', timestamp: new Date(), processedAt: null }]) })
  patch(t, Booking, { find: () => query([]) })
  await feedUnprocessed()
  await settle()
  assert.equal(seen.length, 1)
})

test('group names: seeded from MongoDB before WhatsApp; the real name fixes ID-labelled rows and bookings', async (t) => {
  t.after(() => groupNames.clear())
  let nameFilter
  const rawFixes = []
  const bookingFixes = []
  patch(t, RawMessage, {
    findOne(f) { nameFilter = f; return query({ groupName: 'Cabs (old name)' }) },
    async updateMany(...a) { rawFixes.push(a) },
  })
  patch(t, Booking, { async updateMany(...a) { bookingFixes.push(a) } })
  await seedGroupNames()
  assert.equal(groupNames.get(GROUP), 'Cabs (old name)')
  assert.deepEqual(nameFilter.groupName.$nin.slice(0, 1), [GROUP], 'never seeds the ID as a name')

  await loadGroupNames({ groupMetadata: async () => ({ subject: 'Cabs' }) })
  assert.equal(groupNames.get(GROUP), 'Cabs')
  assert.deepEqual(rawFixes, [[{ groupId: GROUP, groupName: GROUP }, { groupName: 'Cabs' }]])
  assert.deepEqual(bookingFixes, [
    [{ source: `whatsapp:${GROUP}` }, { $set: { source: 'whatsapp:Cabs' } }],
    [{ 'otherSources.source': `whatsapp:${GROUP}` }, { $set: { 'otherSources.$[s].source': 'whatsapp:Cabs' } }, { arrayFilters: [{ 's.source': `whatsapp:${GROUP}` }] }],
  ])
  await loadGroupNames({ groupMetadata: async () => { throw new Error('must not be called again') } })
})
