import 'dotenv/config'

const env = process.env
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean)

export const config = {
  logLevel: env.LOG_LEVEL || 'info',
  mongoUri: env.MONGODB_URI || '',
  targetGroupIds: list(env.TARGET_GROUP_IDS),
  // digits only, with country code, e.g. 919876543210. Empty = link by QR.
  pairingPhoneNumber: (env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, ''),
  authDir: './auth',
}

const bad = config.targetGroupIds.filter((id) => !id.endsWith('@g.us'))
if (bad.length) {
  throw new Error(`TARGET_GROUP_IDS: not group IDs (must end with @g.us): ${bad.join(', ')}`)
}
