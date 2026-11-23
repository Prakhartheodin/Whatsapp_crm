import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTelegram } from '../backend/outputs/telegram.js'
import { createSheets } from '../backend/outputs/sheets.js'
import { createOutputs, formatAlert } from '../backend/outputs/index.js'
import { Booking } from '../backend/models.js'

const TOKEN = '123456:SECRET-token_value'
const tgConfig = { telegramEnabled: true, telegramBotToken: TOKEN, telegramChatId: '-1001' }

function fakeLogger() {
  const lines = []
  const log = (level) => (...args) => lines.push({ level, args })
  return { lines, text: () => JSON.stringify(lines), warn: log('warn'), error: log('error'), info: log('info'), debug: log('debug') }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
function fakeFetch(...responses) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init })
    const r = responses.shift()
    if (r instanceof Error) throw r
    return typeof r === 'function' ? r(String(url), init) : r
  }
  fn.calls = calls
  return fn
}
const noSleep = (log = []) => Object.assign(async (ms) => { log.push(ms) }, { log })

// ---- Telegram ----
test('telegram: disabled is a no-op returning false, warned once at start', async () => {
  const fetch = fakeFetch()
  const logger = fakeLogger()
  const tg = createTelegram({ telegramEnabled: false }, { fetch, logger })
  assert.equal(tg.enabled, false)
  assert.equal(await tg.send('hi'), false)
  assert.equal(await tg.send('hi'), false)
  assert.equal(fetch.calls.length, 0)
  assert.equal(logger.lines.length, 1)
  assert.match(logger.lines[0].args.at(-1), /TELEGRAM_ENABLED/)
})

test('telegram: enabled without a valid token or chat id fails at start-up', () => {
  assert.throws(() => createTelegram({ telegramEnabled: true, telegramChatId: '1' }, { logger: fakeLogger() }), /TELEGRAM_BOT_TOKEN/)
  assert.throws(() => createTelegram({ ...tgConfig, telegramBotToken: '1:a/../x' }, { logger: fakeLogger() }), /TELEGRAM_BOT_TOKEN/)
  assert.throws(() => createTelegram({ ...tgConfig, telegramChatId: '' }, { logger: fakeLogger() }), /TELEGRAM_CHAT_ID/)
})

test('telegram: success sends plain text to the chat, capped at 4096 chars', async () => {
  const fetch = fakeFetch(json({ ok: true }), json({ ok: true }))
  const tg = createTelegram(tgConfig, { fetch, logger: fakeLogger() })
  assert.equal(await tg.send('*hi* <b>x</b>'), true)
  const { url, init } = fetch.calls[0]
  assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
  assert.deepEqual(JSON.parse(init.body), { chat_id: '-1001', text: '*hi* <b>x</b>', link_preview_options: { is_disabled: true } }) // no parse_mode
  assert.ok(init.signal instanceof AbortSignal)
  await tg.send('a'.repeat(5000))
  assert.equal(JSON.parse(fetch.calls[1].init.body).text.length, 4096)
})

test('telegram: 429 is retried once after retry_after (capped)', async () => {
  const sleep = noSleep()
  const fetch = fakeFetch(json({ ok: false, parameters: { retry_after: 3 } }, 429), json({ ok: true }))
  const tg = createTelegram(tgConfig, { fetch, logger: fakeLogger(), sleep })
  assert.equal(await tg.send('x'), true)
  assert.deepEqual(sleep.log, [3000])

  const sleep2 = noSleep()
  const fetch2 = fakeFetch(json({ parameters: { retry_after: 9999 } }, 429), json({ ok: true }))
  await createTelegram(tgConfig, { fetch: fetch2, logger: fakeLogger(), sleep: sleep2 }).send('x')
  assert.deepEqual(sleep2.log, [30_000])
})

test('telegram: 500 then 500 returns false; 400 is not retried; never throws', async () => {
  const logger = fakeLogger()
  const fetch = fakeFetch(json({}, 500), json({}, 502))
  const tg = createTelegram(tgConfig, { fetch, logger, sleep: noSleep() })
  assert.equal(await tg.send('x'), false)
  assert.equal(fetch.calls.length, 2)

  const fetch2 = fakeFetch(json({ description: 'Bad Request: chat not found' }, 400))
  assert.equal(await createTelegram(tgConfig, { fetch: fetch2, logger, sleep: noSleep() }).send('x'), false)
  assert.equal(fetch2.calls.length, 1)

  const netErr = () => new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`)
  // A network error or timeout may have delivered the message: reported as unknown, never retried here
  // (the outbox retries it later, labelled as a possible repeat).
  const fetch3 = fakeFetch(netErr())
  assert.equal(await createTelegram(tgConfig, { fetch: fetch3, logger, sleep: noSleep() }).send('x'), 'unknown')
  assert.equal(fetch3.calls.length, 1)
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
  assert.equal(await createTelegram(tgConfig, { fetch: fakeFetch(timeout), logger, sleep: noSleep() }).send('x'), 'unknown')

  assert.ok(logger.lines.some((l) => l.level === 'error'))
  assert.ok(!logger.text().includes(TOKEN), 'token must never be logged')
  assert.ok(!logger.text().includes('SECRET'), 'token must never be logged')
})

// ---- Google Sheets ----
async function sheetsSetup() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sheets-'))
  const keyFile = path.join(dir, 'sa.json')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  await fs.writeFile(keyFile, JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: pem }))
  const config = { sheetsEnabled: true, googleSheetId: 'SHEET/ID', googleServiceAccountJson: keyFile, googleSheetRange: 'Sheet1!A1' }
  return { config, publicKey, dir, pem }
}
const tokenUrl = 'https://oauth2.googleapis.com/token'
const booking = {
  id: 'b1', source: 'Group A', rawText: '=HYPERLINK("http://evil")', pickup: 'Delhi', drop: 'Agra',
  tripDateTime: '2026-01-01T04:30:00.000Z', carType: 'sedan', fare: 2500, contact: '919876543210',
  receivedAt: new Date('2026-01-01T03:00:00.000Z'), confidence: 0.9,
}

test('sheets: disabled is a no-op; missing or unreadable key file fails at start-up without leaking it', async () => {
  assert.equal(await createSheets({ sheetsEnabled: false }, { logger: fakeLogger() }).append(booking), false)
  const { config, dir } = await sheetsSetup()
  assert.throws(() => createSheets({ ...config, googleServiceAccountJson: path.join(dir, 'nope.json') }, { logger: fakeLogger() }), /GOOGLE_SERVICE_ACCOUNT_JSON/)
  const bad = path.join(dir, 'bad.json')
  await fs.writeFile(bad, '{"private_key": "-----BEGIN SECRETKEYDATA')
  assert.throws(() => createSheets({ ...config, googleServiceAccountJson: bad }, { logger: fakeLogger() }), (err) =>
    /GOOGLE_SERVICE_ACCOUNT_JSON/.test(err.message) && !err.message.includes('SECRETKEYDATA'))
  assert.throws(() => createSheets({ ...config, googleSheetId: '' }, { logger: fakeLogger() }), /GOOGLE_SHEET_ID/)
})

test('sheets: signed JWT, cached token, RAW append with formula text kept as a string', async () => {
  const { config, publicKey, pem } = await sheetsSetup()
  let clock = Date.UTC(2026, 0, 1)
  const appendOk = (url, init) => json({ updates: { updatedRows: 1 } })
  const tokenOk = (url, init) => {
    assert.equal(url, tokenUrl)
    const form = new URLSearchParams(init.body)
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [h, c, sig] = form.get('assertion').split('.')
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')), 'valid RS256 signature')
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(c, 'base64url'))
    assert.deepEqual(claims, {
      iss: 'bot@proj.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: tokenUrl, iat: clock / 1000, exp: clock / 1000 + 3600,
    })
    return json({ access_token: 'ya29.tok', expires_in: 3600 })
  }
  const fetch = fakeFetch(tokenOk, appendOk, appendOk, tokenOk, appendOk, appendOk)
  const logger = fakeLogger()
  const sheets = createSheets(config, { fetch, logger, now: () => new Date(clock), sleep: noSleep() })
  assert.equal(sheets.enabled, true)
  assert.equal(await sheets.append(booking), true)
  const { url, init } = fetch.calls[1]
  assert.equal(url, 'https://sheets.googleapis.com/v4/spreadsheets/SHEET%2FID/values/Sheet1!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS')
  assert.equal(init.headers.authorization, 'Bearer ya29.tok')
  assert.deepEqual(JSON.parse(init.body).values, [[
    '2026-01-01 08:30', '2026-01-01 10:00', 'Delhi', 'Agra', 'sedan', 2500, '919876543210', 'Group A', 0.9, '=HYPERLINK("http://evil")', 'b1',
  ]])

  clock += 30 * 60_000
  assert.equal(await sheets.append(booking), true)
  assert.equal(fetch.calls.filter((c) => c.url === tokenUrl).length, 1, 'token cached')
  clock += 30 * 60_000 // within a minute of expiry: refresh
  assert.equal(await sheets.append(booking), true)
  assert.equal(fetch.calls.filter((c) => c.url === tokenUrl).length, 2)
  assert.ok(!logger.text().includes('ya29') && !logger.text().includes(pem.slice(40, 80)))

  // a single cell is capped at 50 000 chars (Google rejects longer cells and the row would be lost)
  await sheets.append({ ...booking, rawText: 'x'.repeat(60_000) })
  assert.equal(JSON.parse(fetch.calls.at(-1).init.body).values[0][9].length, 50_000)
})

test('sheets: failures return false, never throw; 5xx retried once, 403 not', async () => {
  const { config } = await sheetsSetup()
  const token = () => json({ access_token: 't', expires_in: 3600 })
  const logger = fakeLogger()
  const f1 = fakeFetch(token, json({ error: { message: 'backend' } }, 503), json({}, 500))
  assert.equal(await createSheets(config, { fetch: f1, logger, sleep: noSleep() }).append(booking), false)
  assert.equal(f1.calls.length, 3)
  const f2 = fakeFetch(token, json({ error: { message: 'The caller does not have permission' } }, 403))
  assert.equal(await createSheets(config, { fetch: f2, logger, sleep: noSleep() }).append(booking), false)
  assert.equal(f2.calls.length, 2)
  const f4 = fakeFetch(token, new TypeError('fetch failed'))
  assert.equal(await createSheets(config, { fetch: f4, logger, sleep: noSleep() }).append(booking), 'unknown',
    'the row may have been written: never retried, reported as unknown')
  assert.equal(f4.calls.length, 2, 'append not retried on a network error (could duplicate the row)')
  const f5 = fakeFetch(new TypeError('fetch failed')) // the token request: nothing was written
  assert.equal(await createSheets(config, { fetch: f5, logger, sleep: noSleep() }).append(booking), false)
  const f3 = fakeFetch(json({ error: 'invalid_grant' }, 400))
  assert.equal(await createSheets(config, { fetch: f3, logger, sleep: noSleep() }).append(booking), false)
  assert.equal(f3.calls.length, 1)
  assert.ok(logger.lines.every((l) => !JSON.stringify(l).includes('Bearer')))
})

// ---- fan-out ----
test('formatAlert: plain text with — for missing values, IST trip time', () => {
  assert.equal(formatAlert(booking), [
    'New booking: Delhi → Agra', 'Trip (IST): 2026-01-01 10:00', 'Car: sedan', 'Fare: 2500', 'Contact: 919876543210', 'Source: Group A',
  ].join('\n'))
  // Mongoose-document shape, with missing fields
  const doc = new Booking({ source: 'Group B', rawText: 'x', pickup: 'Pune', receivedAt: new Date(), status: 'confirmed', decidedBy: 'rules' })
  assert.equal(formatAlert(doc), ['New booking: Pune → —', 'Trip (IST): —', 'Car: —', 'Fare: —', 'Contact: —', 'Source: Group B'].join('\n'))
  assert.equal(formatAlert({}).split('\n')[0], 'New booking: — → —')
  // a field cannot fake extra lines
  assert.equal(formatAlert({ pickup: 'Agra\nFare: 0\r\n', drop: ' ' }).split('\n')[0], 'New booking: Agra Fare: 0 → —')
})

test('outputs: fans out to enabled outputs; one failing never blocks the others or throws', async () => {
  const calls = []
  const logger = fakeLogger()
  const outputs = createOutputs({
    telegram: { enabled: true, send: async (t) => { calls.push(['telegram', t]); throw new Error('boom') } },
    sheets: { enabled: true, append: (b) => { calls.push(['sheets', b.id]); throw new Error('sync boom') } },
    sender: { enabled: false, send: async () => { calls.push(['whatsapp']); return true } },
    logger,
  })
  assert.deepEqual(outputs.status(), { sheets: true, telegram: true, whatsappSend: false })
  assert.deepEqual(await outputs.onConfirmed(booking), { telegram: false, sheets: false, whatsappSend: null })
  assert.deepEqual(calls.map((c) => c[0]).sort(), ['sheets', 'telegram'])
  assert.equal(calls.find((c) => c[0] === 'telegram')[1], formatAlert(booking))
  const errors = logger.lines.filter((l) => l.level === 'error')
  assert.equal(errors.length, 1, 'one line per booking')
  assert.deepEqual(errors[0].args[0], { bookingId: 'b1', failed: ['telegram', 'sheets'] })
  assert.ok(!logger.text().includes('9876543210') && !logger.text().includes('HYPERLINK'))

  const sent = []
  const all = createOutputs({
    telegram: { enabled: true, send: async () => { sent.push('t'); return false } },
    sheets: { enabled: true, append: async () => { sent.push('s'); return true } },
    sender: { enabled: true, send: async () => { sent.push('w'); return true } },
    logger: fakeLogger(),
  })
  assert.deepEqual(await all.onConfirmed(booking), { telegram: false, sheets: true, whatsappSend: true })
  assert.deepEqual(sent.sort(), ['s', 't', 'w'])
  await all.onConfirmed(null) // malformed input still never throws

  const quiet = fakeLogger()
  const ok = createOutputs({
    telegram: { enabled: true, send: async () => true }, sheets: { enabled: false, append: async () => false },
    sender: { enabled: false, send: async () => { throw new Error('disabled') } }, logger: quiet,
  })
  const doc = new Booking({ source: 'G', rawText: 'x', receivedAt: new Date(), status: 'confirmed', decidedBy: 'rules' })
  assert.deepEqual(await ok.onConfirmed(doc), { telegram: true, sheets: null, whatsappSend: null })
  assert.equal(quiet.lines.length, 0)
})

test('sheets: a 401 drops the cached token, gets a new one and retries the append once', async () => {
  const { config } = await sheetsSetup()
  const token = (t) => () => json({ access_token: t, expires_in: 3600 })
  const unauth = json({ error: { message: 'Request had invalid authentication credentials.' } }, 401)
  const f = fakeFetch(token('old'), unauth, token('new'), json({}))
  const sheets = createSheets(config, { fetch: f, logger: fakeLogger(), sleep: noSleep() })
  assert.equal(await sheets.append(booking), true)
  assert.deepEqual(f.calls.map((c) => c.init.headers.authorization ?? 'token'), ['token', 'Bearer old', 'token', 'Bearer new'])
  const g = fakeFetch(token('a'), unauth, token('b'), json({ error: {} }, 401))
  assert.equal(await createSheets(config, { fetch: g, logger: fakeLogger(), sleep: noSleep() }).append(booking), false)
  assert.equal(g.calls.length, 4, 'only one retry')
})

test('outputs: only sends the named outputs; an unknown Sheets outcome is passed through', async () => {
  const sent = []
  const outputs = createOutputs({
    telegram: { enabled: true, send: async () => { sent.push('t'); return true } },
    sheets: { enabled: true, append: async () => { sent.push('s'); return 'unknown' } },
    sender: { enabled: true, send: async () => { sent.push('w'); return true } },
    logger: fakeLogger(),
  })
  assert.deepEqual(await outputs.onConfirmed(booking, { only: ['telegram'] }), { telegram: true, sheets: null, whatsappSend: null })
  assert.deepEqual(sent, ['t'])
  assert.deepEqual(await outputs.onConfirmed(booking), { telegram: true, sheets: 'unknown', whatsappSend: true })
})

test('sheets: every row carries the booking id in column K', async () => {
  const { config } = await sheetsSetup()
  const f = fakeFetch(() => json({ access_token: 't', expires_in: 3600 }), json({}))
  assert.equal(await createSheets(config, { fetch: f, logger: fakeLogger(), sleep: noSleep() }).append({ ...booking, id: 'abc123' }), true)
  const row = JSON.parse(f.calls[1].init.body).values[0]
  assert.equal(row.length, 11)
  assert.equal(row[10], 'abc123')
})

test('sheets: a retry (check) reads the Booking ID column first and never appends a row that is already there', async () => {
  const { config } = await sheetsSetup()
  const token = () => json({ access_token: 't', expires_in: 3600 })
  const b = { ...booking, id: 'b42' }
  // Timeout on the first try, then the retry finds the row: delivered, no second append.
  const f1 = fakeFetch(token, new TypeError('fetch failed'), json({ values: [['', 'b41', 'b42']] }))
  const sheets = createSheets(config, { fetch: f1, logger: fakeLogger(), sleep: noSleep() })
  assert.equal(await sheets.append(b), 'unknown')
  assert.equal(await sheets.append(b, { check: true }), true)
  assert.equal(f1.calls.length, 3)
  assert.equal(f1.calls[2].init.method, undefined, 'a read, not an append')
  assert.match(f1.calls[2].url, /\/values\/Sheet1!K%3AK\?majorDimension=COLUMNS$/)
  // Not there: appended exactly once.
  const f2 = fakeFetch(token, json({ values: [['b1']] }), json({}))
  assert.equal(await createSheets(config, { fetch: f2, logger: fakeLogger(), sleep: noSleep() }).append(b, { check: true }), true)
  assert.equal(f2.calls.filter((c) => c.init.method === 'POST' && c.url.includes(':append')).length, 1)
  // An empty sheet (no values) appends; a failed read appends nothing and reports a clean failure.
  const f3 = fakeFetch(token, json({}), json({}))
  assert.equal(await createSheets(config, { fetch: f3, logger: fakeLogger(), sleep: noSleep() }).append(b, { check: true }), true)
  const f4 = fakeFetch(token, json({ error: {} }, 403))
  assert.equal(await createSheets(config, { fetch: f4, logger: fakeLogger(), sleep: noSleep() }).append(b, { check: true }), false)
  assert.equal(f4.calls.length, 2)
})

test('outputs: a possible repeat is labelled on Telegram and WhatsApp; Sheets gets the check flag', async () => {
  const got = {}
  const outputs = createOutputs({
    telegram: { enabled: true, send: async (t) => { got.telegram = t; return true } },
    sheets: { enabled: true, append: async (b, o) => { got.sheets = o; return true } },
    sender: { enabled: true, send: async (t) => { got.whatsapp = t; return 'unknown' } },
    logger: fakeLogger(),
  })
  assert.deepEqual(await outputs.onConfirmed(booking, { repeat: true, check: true }), { telegram: true, sheets: true, whatsappSend: 'unknown' })
  assert.equal(got.telegram, 'Possible repeat (delivery of the first copy could not be confirmed)\n' + formatAlert(booking))
  assert.equal(got.whatsapp, got.telegram)
  assert.deepEqual(got.sheets, { check: true })
  await outputs.onConfirmed(booking)
  assert.equal(got.telegram, formatAlert(booking), 'no label by default')
  assert.deepEqual(got.sheets, { check: false })
})

test('sheets: GOOGLE_SHEET_RANGE must name the tab and start at column A (the id is column K)', async () => {
  const { config } = await sheetsSetup()
  for (const range of ['A1', 'Bookings!B1', 'Sheet1', '!A1']) {
    assert.throws(() => createSheets({ ...config, googleSheetRange: range }, { logger: fakeLogger() }), /GOOGLE_SHEET_RANGE/, range)
  }
  for (const range of ['Sheet1!A1', 'Bookings!A:K', "'My Tab'!A2"]) {
    assert.equal(createSheets({ ...config, googleSheetRange: range }, { logger: fakeLogger() }).enabled, true, range)
  }
})
