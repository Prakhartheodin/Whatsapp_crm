import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Paths below resolve from the project folder, not from wherever the process was started.
const root = fileURLToPath(new URL('..', import.meta.url))

const env = process.env
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean)
function int(name, fallback, min = 1) {
  if (!env[name]) return fallback
  const n = Number(env[name])
  if (!Number.isInteger(n) || n < min) throw new Error(`${name}: must be a whole number >= ${min}`)
  return n
}
function bool(name) {
  const v = (env[name] || 'false').trim().toLowerCase()
  if (v !== 'true' && v !== 'false') throw new Error(`${name}: must be true or false`)
  return v === 'true'
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
  // outputs (checked by their factories when enabled)
  sheetsEnabled: bool('SHEETS_ENABLED'),
  googleSheetId: env.GOOGLE_SHEET_ID || '',
  googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON ? path.resolve(root, env.GOOGLE_SERVICE_ACCOUNT_JSON) : '',
  googleSheetRange: env.GOOGLE_SHEET_RANGE || 'Sheet1!A1',
  telegramEnabled: bool('TELEGRAM_ENABLED'),
  telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: env.TELEGRAM_CHAT_ID || '',
  whatsappSendEnabled: bool('WHATSAPP_SEND_ENABLED'),
  targetNumber: (env.TARGET_NUMBER || '').replace(/[\s+-]/g, ''), // anything else left in fails the sender's check
  sessionDownAlertMinutes: int('SESSION_DOWN_ALERT_MINUTES', 10),
  retentionDays: int('RETENTION_DAYS', 30, 0),
  // LLM for unclear messages (key and model are checked by createLlm when enabled)
  llmEnabled: bool('LLM_ENABLED'),
  openaiApiKey: env.OPENAI_API_KEY || '',
  openaiModel: env.OPENAI_MODEL || '',
  llmConfirmThreshold: env.LLM_CONFIRM_THRESHOLD ? Number(env.LLM_CONFIRM_THRESHOLD) : 0.8,
}

if (!(config.llmConfirmThreshold > 0 && config.llmConfirmThreshold <= 1)) {
  throw new Error('LLM_CONFIRM_THRESHOLD: must be a number above 0 and at most 1')
}

const bad = config.targetGroupIds.filter((id) => !id.endsWith('@g.us'))
if (bad.length) {
  throw new Error(`TARGET_GROUP_IDS: not group IDs (must end with @g.us): ${bad.join(', ')}`)
}
