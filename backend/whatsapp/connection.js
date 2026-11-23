import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys'
import qrcode from 'qrcode-terminal'
import { config } from '../config.js'
import { logger } from '../logger.js'

// READ-ONLY SESSION. This project must never call: readMessages, sendPresenceUpdate,
// presenceSubscribe, groupAcceptInvite, or any send function outside whatsapp/send.js.

// status: connecting | open | reconnecting | logged_out | replaced | blocked
export const waState = { status: 'connecting', since: new Date() }
const setStatus = (status) => Object.assign(waState, { status, since: new Date() })

// Codes where retrying is useless or harmful: stop and wait for a human.
const STOP = {
  [DisconnectReason.loggedOut]: 'logged_out',
  [DisconnectReason.connectionReplaced]: 'replaced',
  [DisconnectReason.forbidden]: 'blocked',
  [DisconnectReason.multideviceMismatch]: 'logged_out',
}

let attempt = 0

/**
 * @param {{ onSocket?: (sock) => void, onOpen?: (sock) => void, onStop?: (status: string) => void }} handlers
 * onSocket runs for every new socket (attach event listeners there).
 */
export async function startWhatsApp(handlers = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  const sock = makeWASocket({
    auth: state,
    logger: logger.child({ mod: 'baileys' }, { level: 'warn' }),
    markOnlineOnConnect: false, // no presence; also keeps delivery acks "inactive"
    // Only the small default sync. Do not disable it with shouldSyncHistoryMessage:
    // Baileys needs it for sender-ID mappings and warns of session errors without it.
    syncFullHistory: false,
  })
  let pairingRequested = false

  sock.ev.on('creds.update', saveCreds)
  handlers.onSocket?.(sock)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // `qr` is only emitted when ./auth holds no valid session, so a linked
    // number is never asked to re-link.
    if (qr) {
      if (!config.pairingPhoneNumber) {
        console.log('\nScan with WhatsApp > Linked devices > Link a device:\n')
        qrcode.generate(qr, { small: true })
      } else if (!pairingRequested) {
        pairingRequested = true
        try {
          const code = await sock.requestPairingCode(config.pairingPhoneNumber)
          console.log(`\nPairing code: ${code}\nWhatsApp > Linked devices > Link a device > Link with phone number instead\n`)
        } catch (err) {
          logger.error({ err }, 'could not get a pairing code')
        }
      }
    }

    if (connection === 'open') {
      attempt = 0
      setStatus('open')
      logger.info('whatsapp connected')
      handlers.onOpen?.(sock)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (STOP[code]) {
        setStatus(STOP[code])
        // TODO(step 7): also send this as a Telegram alert.
        logger.fatal({ code, status: STOP[code] }, 'whatsapp session stopped; not reconnecting. See README: re-linking')
        handlers.onStop?.(STOP[code])
        return
      }
      setStatus('reconnecting')
      // 515 is the normal "restart" right after linking: reconnect at once.
      const delay = code === DisconnectReason.restartRequired
        ? 0
        : Math.min(2000 * 2 ** attempt++, 5 * 60_000) * (0.5 + Math.random() / 2)
      logger.warn({ code, delayMs: Math.round(delay) }, 'whatsapp disconnected; reconnecting')
      setTimeout(() => reconnect(handlers), delay)
    }
  })

  return sock
}

function reconnect(handlers) {
  startWhatsApp(handlers).catch((err) => {
    logger.error({ err }, 'whatsapp reconnect failed')
    setTimeout(() => reconnect(handlers), Math.min(2000 * 2 ** attempt++, 5 * 60_000))
  })
}
