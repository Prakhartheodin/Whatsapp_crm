import test from 'node:test'
import assert from 'node:assert/strict'
import { extractText } from '../backend/whatsapp/capture.js'
import { maskPhone, maskObject } from '../backend/logger.js'

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
