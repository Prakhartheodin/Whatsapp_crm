import { setTimeout as delay } from 'node:timers/promises'

// THE ONLY place in this codebase allowed to send on the WhatsApp socket (test/send.test.js enforces it).
// Owner's rule: off by default; only to TARGET_NUMBER; random 3-8 s delay; max 10 per minute.
const MAX_PER_MINUTE = 10
const MAX_QUEUE = 100

// Process-wide, so the limit and the queue cannot be bypassed with a second sender.
const sentAt = [] // times of the sends in the last 60 s
let pending = 0
let chain = Promise.resolve()
let created = false

/** Test-only: forget the process-wide sender state. Never call from service code. */
export function resetSenderForTests() {
  sentAt.length = 0
  pending = 0
  chain = Promise.resolve()
  created = false
}

/**
 * send(text) -> Promise<true | false | 'unknown'>: sent, not sent (skipped), or sendMessage threw (may have gone out).
 * There is no recipient parameter: the recipient is fixed at start-up. At most one enabled
 * sender per process: build it once and keep `getSock` pointing at the current socket.
 */
export function createSender(config, { getSock, logger, sleep = delay, random = Math.random, now = () => new Date() }) {
  if (!config.whatsappSendEnabled) {
    return Object.freeze({
      enabled: false,
      send: async () => { throw new Error('WhatsApp sending is disabled (WHATSAPP_SEND_ENABLED=false)') },
    })
  }
  const digits = String(config.targetNumber ?? '')
  if (!/^\d{8,15}$/.test(digits)) throw new Error('TARGET_NUMBER: required when WHATSAPP_SEND_ENABLED=true (digits only, with country code)')
  if (created) throw new Error('createSender: an enabled WhatsApp sender already exists in this process; reuse it')
  created = true
  const jid = `${digits}@s.whatsapp.net`

  async function deliver(text, onStart) {
    for (;;) {
      const t = now().getTime()
      while (sentAt.length && t - sentAt[0] >= 60_000) sentAt.shift()
      if (sentAt.length < MAX_PER_MINUTE) break
      await sleep(60_000 - (t - sentAt[0]))
    }
    // Every send is preceded by the random delay, also after a limit wait (no fixed spacing).
    await sleep(3000 + Math.min(Math.max(Number(random()) || 0, 0), 1) * 5000)
    const sock = getSock()
    if (!sock?.ws?.isOpen) {
      logger.warn('whatsapp send skipped: socket not open')
      return false
    }
    try {
      await onStart?.() // the caller's "send started" mark; if it cannot be written, do not send
    } catch (err) {
      logger.warn({ err }, 'whatsapp send not started: onStart failed')
      return false
    }
    sentAt.push(now().getTime())
    try {
      // linkPreview: null -> Baileys never fetches URLs that group members wrote.
      await sock.sendMessage(jid, { text: String(text), linkPreview: null })
      return true
    } catch (err) {
      // It may have gone out before the error: unknown, so a retry is labelled as a possible repeat.
      logger.error({ err }, 'whatsapp send failed (outcome unknown)')
      return 'unknown'
    }
  }

  return Object.freeze({
    enabled: true,
    /** Messages waiting or being sent (lost if the process stops now). */
    pending: () => pending,
    /** onStart: optional, awaited right before the socket call (after the queue wait and the delay). */
    send(text, { onStart } = {}) {
      if (pending >= MAX_QUEUE) {
        logger.warn('whatsapp send queue full; message dropped')
        return Promise.resolve(false)
      }
      pending++
      // Strictly sequential, FIFO.
      const p = chain.then(() => deliver(text, onStart)).finally(() => { pending-- })
      chain = p.catch(() => {})
      return p
    },
  })
}
