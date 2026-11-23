import mongoose from 'mongoose'
import { config } from './config.js'
import { logger } from './logger.js'
import { startWhatsApp } from './whatsapp/connection.js'
import { attachCapture, loadGroupNames } from './whatsapp/capture.js'

if (!config.mongoUri) {
  logger.fatal('MONGODB_URI is not set. Copy .env.example to .env and fill it in.')
  process.exit(1)
}

await mongoose.connect(config.mongoUri)
logger.info('mongodb connected')

await startWhatsApp({ onSocket: attachCapture, onOpen: loadGroupNames })

// Never call sock.logout() here: that would unlink the device.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await mongoose.disconnect().catch(() => {})
    process.exit(0)
  })
}
