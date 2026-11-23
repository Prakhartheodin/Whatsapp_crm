import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractText, pickSender, toDate, replaySpool } from '../backend/whatsapp/capture.js'
import { maskPhone, maskObject, maskJids } from '../backend/logger.js'

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
