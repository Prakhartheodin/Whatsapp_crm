import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Paths below resolve from the project folder, not from wherever the process was started.
const root = fileURLToPath(new URL('..', import.meta.url))

const env = process.env
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean)
function int(name, fallback) {
  if (!env[name]) return fallback
  const n = Number(env[name])
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name}: must be a positive whole number`)
  return n
}
const nodeEnv = env.NODE_ENV || 'development'

export const config = {
  nodeEnv,
  port: int('PORT', 3000),
  // Production sits behind a reverse proxy on the same machine.
  host: env.HOST || (nodeEnv === 'production' ? '127.0.0.1' : '0.0.0.0'),
  // Checked at service start (index.js), not here, so scripts and tests can import config without them.
  apiToken: env.API_TOKEN || '',
  sessionSecret: env.SESSION_SECRET || '',
  heartbeatMinutes: int('HEARTBEAT_MINUTES', 120),
  logLevel: env.LOG_LEVEL || 'info',
  mongoUri: env.MONGODB_URI || '',
  targetGroupIds: list(env.TARGET_GROUP_IDS),
  // digits only, with country code, e.g. 919876543210. Empty = link by QR.
  pairingPhoneNumber: (env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, ''),
  // Full access to the WhatsApp account: keep it out of cloud-synced folders (see .env.example).
  authDir: path.resolve(root, env.AUTH_DIR || 'auth'),
  // Messages that could not be stored in MongoDB wait here until it is back.
  spoolFile: path.join(root, 'spool', 'raw.jsonl'),
}

const bad = config.targetGroupIds.filter((id) => !id.endsWith('@g.us'))
if (bad.length) {
  throw new Error(`TARGET_GROUP_IDS: not group IDs (must end with @g.us): ${bad.join(', ')}`)
}
