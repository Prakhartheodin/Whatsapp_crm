import { configLoaded } from './config-guard.js' // first: a malformed .env value is one fatal line
import mongoose from 'mongoose'
import { config } from './config.js'
import { logger, quietConsole, maskPhone } from './logger.js'
import { Admin, Booking, RawMessage, IngestKey } from './models.js'
import { createApp } from './http/server.js'
import { toBooking, releaseIngestKeys } from './http/routes.js'
import { startWhatsApp, waState, flushCreds, getSock, closeWhatsApp } from './whatsapp/connection.js'
import {
  attachCapture, loadGroupNames, seedGroupNames, groupNames, lastMessageAt, replaySpool, setPipeline, feedUnprocessed,
} from './whatsapp/capture.js'
import { createSender } from './whatsapp/send.js'
import { createLlm } from './pipeline/llm.js'
import { createPipeline } from './pipeline/index.js'
import { createTelegram } from './outputs/telegram.js'
import { createSheets } from './outputs/sheets.js'
import { createOutputs } from './outputs/index.js'
import { createHeartbeat } from './jobs/heartbeat.js'
import { createRetention } from './jobs/retention.js'
import { createOutbox } from './jobs/outbox.js'

configLoaded()

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

// The factories throw on a misconfigured enabled output or LLM: fail before connecting anything.
let telegram, sender, outputs, llm
try {
  telegram = createTelegram(config, { fetch, logger })
  sender = createSender(config, { getSock, logger })
  outputs = createOutputs({ telegram, sheets: createSheets(config, { fetch, logger }), sender, logger })
  llm = createLlm(config, { fetch, logger })
} catch (err) {
  logger.fatal(`${err.message}. See .env.example.`)
  process.exit(1)
}
if (sender.enabled) logger.warn({ to: maskPhone(config.targetNumber) }, 'WHATSAPP_SEND_ENABLED=true: booking alerts are also sent from the linked number')
// One onConfirmed for the pipeline and the dashboard's confirm: sends, records per-output delivery,
// and the outbox job retries what is missing. Outputs get the API booking shape on both paths.
const outbox = createOutbox({ Booking, outputs, logger })
const pipeline = createPipeline({ Booking, llm, onConfirmed: (doc) => outbox.deliver(toBooking(doc)), logger })
// Set before the first spool replay below, so replayed messages are processed too.
setPipeline((msg) => pipeline.processMessage(msg))
const heartbeat = createHeartbeat({
  config,
  // Newest stored message from MongoDB, so a restart does not reset the quiet clock.
  getLastMessageAt: async () =>
    (await RawMessage.findOne({ groupId: { $in: config.targetGroupIds } }, { timestamp: 1 }).sort({ timestamp: -1 }).lean())?.timestamp ?? null,
  getWaStatus: () => waState,
  alert: telegram.enabled ? telegram.send : null, // Telegram off: alerts are logged once, not retried
  logger,
})
const retention = createRetention({ RawMessage, config, logger })

try {
  await mongoose.connect(config.mongoUri)
} catch (err) {
  // Never log MONGODB_URI (it can hold a password); strip credentials from any URL in the reason too.
  logger.fatal(`MongoDB is unreachable (${err.name}: ${String(err.message).replace(/\/\/[^/@\s]*@/g, '//***@')}). Check MONGODB_URI and that MongoDB is running.`)
  process.exit(1)
}
logger.info('mongodb connected')
// Now and after every reconnect: store messages spooled during a MongoDB outage, then re-feed
// stored messages that never finished the booking pipeline (restart, MongoDB error mid-pipeline).
const recover = () => replaySpool().then(() => feedUnprocessed())
recover()
for (const ev of ['connected', 'reconnected']) mongoose.connection.on(ev, recover)
await seedGroupNames()
await releaseIngestKeys(IngestKey) // /ingest keys orphaned by the last stop; else their retries get 409 for 7 days

// HTTP first and independent of WhatsApp: if the session stops, the dashboard still shows why.
const app = createApp({
  models: { Admin, Booking, RawMessage, IngestKey },
  config,
  getHealthState: () => ({ whatsapp: waState, groupNames, lastMessageAt, heartbeat: heartbeat.state(), outputs: outputs.status(),
    outputCounts: () => outbox.counts() }),
  onConfirmed: (booking) => outbox.deliver(booking),
  pipeline,
  logger,
})
const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, outputs: outputs.status() }, 'http listening')
  heartbeat.check() // so /health has the quiet state before the first 5-minute tick
  heartbeat.start()
  retention.start()
  outbox.start()
})
server.on('error', (err) => {
  logger.fatal({ err }, 'http server failed')
  process.exit(1)
})

// Never call sock.logout() here: that would unlink the device.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    closeWhatsApp() // first, so no message arrives after MongoDB is gone; a plain close, not a logout
    heartbeat.stop()
    retention.stop()
    outbox.stop()
    // Unsent ones stay undelivered on their bookings; the outbox sends them after the restart.
    if (sender.pending?.()) logger.warn({ dropped: sender.pending() }, 'whatsapp sends still queued at shutdown were dropped')
    await flushCreds() // a cut creds.json write would cost the session
    await new Promise((resolve) => server.close(resolve))
    await mongoose.disconnect().catch(() => {})
    process.exit(0)
  })
}

quietConsole()
// A stop status alerts at once instead of at the next 5-minute heartbeat check.
await startWhatsApp({ onSocket: attachCapture, onOpen: loadGroupNames, onStop: () => heartbeat.check() })
