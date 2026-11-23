import crypto from 'node:crypto'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { call, ist } from './common.js'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

/**
 * Google Sheets append with a service account. append(booking) -> true (written), false (not
 * written: safe to retry) or 'unknown' (timeout/network error after sending: may be written,
 * so the caller must not retry). Never throws.
 */
export function createSheets(config, { fetch = globalThis.fetch, logger, now = () => new Date(), sleep = delay }) {
  if (!config.sheetsEnabled) return { enabled: false, append: async () => false }
  if (!config.googleSheetId) throw new Error('GOOGLE_SHEET_ID: required when SHEETS_ENABLED=true')
  let email, key
  try {
    const sa = JSON.parse(fs.readFileSync(config.googleServiceAccountJson, 'utf8'))
    email = sa.client_email
    key = crypto.createPrivateKey(sa.private_key)
    if (!email) throw new Error()
  } catch (err) {
    // Never include err.message: JSON and key parse errors quote the file content.
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON: cannot use the service-account key file "${config.googleServiceAccountJson}" (${err.code ?? 'not a service-account JSON key with client_email and private_key'})`)
  }
  const opts = { logger, sleep, output: 'sheets' }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetId)}/values/` +
    `${encodeURIComponent(config.googleSheetRange || 'Sheet1!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
  let token = null
  let expiresAt = 0

  async function accessToken() {
    if (token && now().getTime() < expiresAt - 60_000) return token
    const iat = Math.floor(now().getTime() / 1000)
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`
    const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`
    const { body } = await call(fetch, TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    }, opts)
    if (!body?.access_token) return null
    token = body.access_token
    expiresAt = iat * 1000 + (Number(body.expires_in) || 3600) * 1000
    return token
  }

  return {
    enabled: true,
    async append(b) {
      try {
        // RAW: strings stay strings, so a message starting with "=" is never a formula.
        // Google rejects a cell over 50 000 chars, which would lose the whole row.
        const row = [ist(b.receivedAt), ist(b.tripDateTime), b.pickup ?? '', b.drop ?? '', b.carType ?? '', b.fare ?? '',
          b.contact ?? '', b.source ?? '', b.confidence ?? '', b.rawText ?? ''].map((c) => (typeof c === 'string' ? c.slice(0, 50_000) : c))
        for (let attempt = 0; ; attempt++) {
          const t = await accessToken()
          if (!t) return false
          const res = await call(fetch, url, {
            method: 'POST',
            headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
            body: JSON.stringify({ values: [row] }),
          }, opts)
          if (res.ok) return true
          token = null // a revoked token is not reused until it expires
          if (res.unknown) return 'unknown'
          if (res.status !== 401 || attempt) return false
          // 401: the cached token was rejected; one retry with a fresh one (nothing was written).
        }
      } catch (err) {
        logger.error({ output: 'sheets', error: err.name }, 'output failed')
        return false
      }
    },
  }
}
