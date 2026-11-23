import fs from 'node:fs/promises'
import path from 'node:path'
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys'
import qrcode from 'qrcode-terminal'
import { config } from '../config.js'
import { logger } from '../logger.js'

// READ-ONLY SESSION. This project must never call: readMessages, sendPresenceUpdate,
// presenceSubscribe, groupAcceptInvite, or any send function outside whatsapp/send.js.

// status: connecting | open | reconnecting | logged_out | replaced | blocked | needs_link
export const waState = { status: 'connecting', since: new Date() }
const setStatus = (status) => Object.assign(waState, { status, since: new Date() })

// Codes where retrying is useless or harmful: stop and wait for a human.
const STOP = {
  [DisconnectReason.loggedOut]: 'logged_out',
  [DisconnectReason.connectionReplaced]: 'replaced',
  [DisconnectReason.forbidden]: 'blocked',
  [DisconnectReason.multideviceMismatch]: 'logged_out',
}

const see = (status) => `See README.md, "What each stop status means" > ${status}.`
const STOP_HELP = {
  logged_out: `WhatsApp unlinked this device. Not reconnecting. Stop the service, move the auth folder (AUTH_DIR) aside, run \`npm run groups\` in a terminal to link again, then start the service. ${see('logged_out')}`,
  replaced: `Another process or device opened this same session (a second copy of the service, or \`npm run groups\` while the service runs). Not reconnecting. Stop the other one, then restart this service. No re-link needed. ${see('replaced')}`,
  blocked: `WhatsApp refused this account (403). Not reconnecting. Do NOT re-link: the account is restricted. Check WhatsApp on the phone. ${see('blocked')}`,
  needs_link: `No linked WhatsApp session, and no terminal to show a QR or pairing code in. Stop pm2 (\`pm2 stop booking-collector\`), run \`npm run groups\` in a terminal to link, then start pm2 again. ${see('needs_link')}`,
}

/** Pure decision after a close: { stop: status } or { delay: ms, attempt: next attempt count }. */
export function nextStep(code, attempt, rand = Math.random()) {
  if (STOP[code]) return { stop: STOP[code] }
  // 515 is the normal "restart" right after linking: reconnect at once.
  if (code === DisconnectReason.restartRequired) return { delay: 0, attempt }
  return { delay: Math.min(2000 * 2 ** attempt, 5 * 60_000) * (0.5 + rand / 2), attempt: attempt + 1 }
}

let attempt = 0
let stableTimer

// Credential writes in flight; flushCreds() lets callers wait for them before process.exit.
const pending = new Set()
function track(p) {
  pending.add(p)
  p.finally(() => pending.delete(p))
}
export async function flushCreds() {
  while (pending.size) await Promise.all(pending)
}

const credsFile = () => path.join(config.authDir, 'creds.json')
const backupFile = () => path.join(config.authDir, 'creds.backup.json')

async function jsonState(file) {
  try {
    JSON.parse(await fs.readFile(file, 'utf8'))
    return 'ok'
  } catch (err) {
    return err.code === 'ENOENT' ? 'missing' : 'bad'
  }
}

/** False when creds.json is damaged and no valid backup exists (never silently start a new identity). */
async function prepareAuthDir() {
  await fs.mkdir(config.authDir, { recursive: true, mode: 0o700 })
  await fs.chmod(config.authDir, 0o700).catch(() => {}) // no-op on Windows
  if ((await jsonState(credsFile())) !== 'bad') return true
  if ((await jsonState(backupFile())) === 'ok') {
    await fs.copyFile(backupFile(), credsFile())
    logger.warn('creds.json was damaged; restored it from creds.backup.json')
    return true
  }
  return false
}

async function backupCreds() {
  const text = await fs.readFile(credsFile(), 'utf8')
  JSON.parse(text) // never back up a damaged file
  await fs.writeFile(backupFile(), text, { mode: 0o600 })
}

function stop(status, handlers, details = {}, message = STOP_HELP[status]) {
  setStatus(status)
  // TODO(step 7): also send this as a Telegram alert.
  logger.fatal({ ...details, status }, message)
  handlers.onStop?.(status)
}

/**
 * @param {{ onSocket?: (sock) => void, onOpen?: (sock) => void, onStop?: (status: string) => void }} handlers
 * onSocket runs for every new socket (attach event listeners there).
 */
export async function startWhatsApp(handlers = {}) {
  if (!(await prepareAuthDir())) {
    stop('logged_out', handlers, {}, `creds.json in ${config.authDir} is damaged and there is no valid creds.backup.json. Not starting WhatsApp, so no new identity is created. Move the auth folder aside and link again. ${see('logged_out')}`)
    return
  }
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
  let stopped = false

  sock.ev.on('creds.update', () => {
    track(saveCreds().catch((err) => logger.error({ err }, 'could not save WhatsApp credentials')))
  })
  handlers.onSocket?.(sock)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // `qr` is only emitted when the auth folder holds no valid session, so a linked
    // number is never asked to re-link.
    if (qr) {
      // Under pm2 nobody sees the terminal, and a QR/pairing code in a log file lets anyone link.
      if (!process.stdout.isTTY) {
        stopped = true
        sock.end(undefined)
        stop('needs_link', handlers)
        return
      }
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
      // Reset backoff only after a stable minute, so a connection that drops right after opening still backs off.
      stableTimer = setTimeout(() => { attempt = 0 }, 60_000)
      stableTimer.unref()
      setStatus('open')
      logger.info('whatsapp connected')
      const inFlight = [...pending]
      track(Promise.all(inFlight).then(backupCreds).catch((err) => logger.warn({ err }, 'could not back up creds.json')))
      handlers.onOpen?.(sock)
    }

    if (connection === 'close') {
      clearTimeout(stableTimer)
      if (stopped) return
      const code = lastDisconnect?.error?.output?.statusCode
      const step = nextStep(code, attempt)
      if (step.stop) return stop(step.stop, handlers, { code })
      attempt = step.attempt
      setStatus('reconnecting')
      logger.warn({ code, delayMs: Math.round(step.delay) }, 'whatsapp disconnected; reconnecting')
      setTimeout(() => reconnect(handlers), step.delay)
    }
  })

  return sock
}

function reconnect(handlers) {
  startWhatsApp(handlers).catch((err) => {
    logger.error({ err }, 'whatsapp reconnect failed')
    const step = nextStep(undefined, attempt)
    attempt = step.attempt
    setTimeout(() => reconnect(handlers), step.delay)
  })
}
