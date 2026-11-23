import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { verifyPassword, normalizeUsername } from '../auth/password.js'

const WEEK_MS = 7 * 24 * 3600_000
const WINDOW_MS = 15 * 60_000
const MAX_FAILS = 5
const MAX_TRACKED = 10_000
const BAD_LOGIN = 'Wrong username or password.'
// Well-formed hash that matches nothing: unknown usernames still cost one scrypt.
const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`

const digest = (s) => createHash('sha256').update(String(s)).digest()
const sameString = (a, b) => timingSafeEqual(digest(a), digest(b))
const hmac = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url')

export function createAuth({ Admin, config }) {
  const fails = new Map() // ip -> { count, resetAt }
  const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: config.nodeEnv === 'production', path: '/' }

  function tokenOk(req) {
    const given = req.get('x-api-token') ?? req.query.token
    return Boolean(config.apiToken) && typeof given === 'string' && sameString(given, config.apiToken)
  }

  function sessionUser(req) {
    const value = /(?:^|;\s*)sid=([^;]+)/.exec(req.get('cookie') || '')?.[1]
    const [payload, sig, extra] = (value || '').split('.')
    if (!payload || !sig || extra !== undefined) return null
    const expected = Buffer.from(hmac(payload, config.sessionSecret))
    const got = Buffer.from(sig)
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
    try {
      const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
      return typeof u === 'string' && exp > Date.now() ? u : null
    } catch {
      return null
    }
  }

  function requireAuth(req, res, next) {
    const user = sessionUser(req) ?? (tokenOk(req) ? 'api-token' : null)
    if (!user) return res.status(401).json({ error: 'Not logged in.' })
    req.user = user
    next()
  }

  async function login(req, res) {
    const { username, password } = req.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 200) {
      return res.status(400).json({ error: 'Send username and password as text.' })
    }
    const now = Date.now()
    // Entries are inserted in resetAt order, so expired ones sit at the front: stop at the first live one.
    for (const [ip, e] of fails) {
      if (e.resetAt > now) break
      fails.delete(ip)
    }
    // shortcut: past MAX_TRACKED IPs in 15 min the oldest is forgotten (resets its limit); key IPv6 by /64 if abused.
    if (!fails.has(req.ip) && fails.size >= MAX_TRACKED) fails.delete(fails.keys().next().value)
    const entry = fails.get(req.ip) ?? { count: 0, resetAt: now + WINDOW_MS }
    if (entry.count >= MAX_FAILS) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000)
      res.set('Retry-After', String(retryAfterSec))
      return res.status(429).json({ error: 'Too many failed logins. Try again later.', retryAfterSec })
    }
    // Counted before the check so parallel guesses cannot slip past the limit; a success clears it.
    entry.count++
    fails.set(req.ip, entry)

    const admin = await Admin.findById('admin').lean()
    const name = normalizeUsername(username)
    const known = admin?.username === name
    // Always one scrypt, so a wrong username and a wrong password take the same time.
    const ok = (await verifyPassword(password, known ? admin.passwordHash : DUMMY_HASH)) && known
    if (!ok) return res.status(401).json({ error: BAD_LOGIN })
    fails.delete(req.ip)
    const payload = Buffer.from(JSON.stringify({ u: name, exp: now + WEEK_MS })).toString('base64url')
    res.cookie('sid', `${payload}.${hmac(payload, config.sessionSecret)}`, { ...cookieOpts, maxAge: WEEK_MS })
    res.json({ ok: true })
  }

  function logout(req, res) {
    res.clearCookie('sid', cookieOpts)
    res.json({ ok: true })
  }

  return { requireAuth, login, logout }
}
