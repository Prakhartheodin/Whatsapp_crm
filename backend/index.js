import mongoose from 'mongoose'
import { config } from './config.js'
import { logger, quietConsole } from './logger.js'
import { Admin, Booking, RawMessage } from './models.js'
import { createApp } from './http/server.js'
import { startWhatsApp, waState, flushCreds } from './whatsapp/connection.js'
import { attachCapture, loadGroupNames, groupNames, lastMessageAt, replaySpool } from './whatsapp/capture.js'

if (!config.mongoUri) {
  logger.fatal('MONGODB_URI is not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}
for (const [name, value] of [['API_TOKEN', config.apiToken], ['SESSION_SECRET', config.sessionSecret]]) {
  if (value.length < 32) {
    logger.fatal(`${name} is missing or shorter than 32 characters. See .env.example for how to generate one.`)
    process.exit(1)
  }
}

await mongoose.connect(config.mongoUri)
logger.info('mongodb connected')
// Messages spooled to disk during a MongoDB outage are stored now and after every reconnect.
replaySpool()
for (const ev of ['connected', 'reconnected']) mongoose.connection.on(ev, () => replaySpool())

// HTTP first and independent of WhatsApp: if the session stops, the dashboard still shows why.
const app = createApp({
  models: { Admin, Booking, RawMessage },
  config,
  getHealthState: () => ({ whatsapp: waState, groupNames, lastMessageAt }),
  onConfirmed: () => {}, // TODO(step 7): fan out to the enabled outputs.
  logger,
})
const server = app.listen(config.port, config.host, () => logger.info({ host: config.host, port: config.port }, 'http listening'))
server.on('error', (err) => {
  logger.fatal({ err }, 'http server failed')
  process.exit(1)
})

// Never call sock.logout() here: that would unlink the device.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await flushCreds() // a cut creds.json write would cost the session
    await new Promise((resolve) => server.close(resolve))
    await mongoose.disconnect().catch(() => {})
    process.exit(0)
  })
}

quietConsole()
await startWhatsApp({ onSocket: attachCapture, onOpen: loadGroupNames })
