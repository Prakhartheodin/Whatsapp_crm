import { ist } from '../outputs/common.js'

const IST_MS = 5.5 * 3600_000 // fixed UTC+5:30 (no DST)
const DAY = 86_400_000
const STOP = new Set(['logged_out', 'replaced', 'blocked', 'needs_link'])

/**
 * Quiet-groups and session-down alerts. alert(text) -> true when delivered; an undelivered
 * alert is retried on the next check. alert = null (no channel, Telegram off): each alert is
 * only logged, once. getLastMessageAt() -> Promise<Date | null>.
 */
export function createHeartbeat({ config, getLastMessageAt, getWaStatus, alert, now = () => new Date(), logger }) {
  const minutes = config.heartbeatMinutes
  let quiet = false
  let lastAlertAt = null
  let quietAlertedFor // `${last message}|${day}` the quiet alert was sent for: re-arms on a new message or a new day
  let downSince = null // first time seen not open (waState.since moves on every reconnect attempt)
  let downAlerted = null // status the down alert was sent for
  let lastLogged // an alert retried every check (Telegram down/disabled) is logged at warn once
  let timer

  async function send(text) {
    logger[text === lastLogged ? 'debug' : 'warn']({ alert: text.split('\n')[0] }, 'heartbeat alert')
    lastLogged = text
    if (!alert) return true // nothing to deliver to, so nothing to retry
    if ((await alert(text)) !== true) return false // 'unknown' (timeout) is retried: a repeated alert is harmless
    lastAlertAt = now()
    return true
  }

  async function checkSession(t) {
    const { status, since } = getWaStatus()
    if (status === 'open') {
      if (downAlerted && !(await send('WhatsApp is back online.'))) return
      downSince = null
      downAlerted = null
      return
    }
    downSince ??= Math.min(t, new Date(since ?? t).getTime() || t)
    const due = STOP.has(status) || (!downAlerted && t - downSince >= config.sessionDownAlertMinutes * 60_000)
    if (downAlerted !== status && due &&
      await send(`WhatsApp session is "${status}" (not connected since ${ist(downSince)} IST): messages are not being captured.${STOP.has(status) ? ' It will not reconnect by itself; see README, "What each stop status means".' : ''}`)) {
      downAlerted = status
    }
  }

  async function checkQuiet(t) {
    const local = t + IST_MS
    const minute = Math.floor((local % DAY) / 60_000)
    if (minute < 8 * 60 || minute >= 23 * 60) {
      quiet = false
      return
    }
    const last = await getLastMessageAt()
    const lastMs = last ? new Date(last).getTime() : 0
    const windowStart = Math.floor(local / DAY) * DAY - IST_MS + 8 * 3600_000 // 08:00 IST today
    quiet = t - Math.max(lastMs, windowStart) >= minutes * 60_000
    const key = `${lastMs}|${windowStart}`
    if (quiet && quietAlertedFor !== key &&
      await send(`No message from any target group for ${minutes} minutes (last: ${ist(last) || 'none'} IST). Check that capture is working.`)) {
      quietAlertedFor = key
    }
  }

  async function runCheck() {
    const t = now().getTime()
    for (const step of [checkSession, checkQuiet]) {
      try {
        await step(t)
      } catch (err) {
        logger.error({ err }, 'heartbeat check failed')
      }
    }
  }

  // Serialized: an onStop check racing the timer's check must not send the same alert twice.
  let chain = Promise.resolve()
  const check = () => (chain = chain.then(runCheck))

  return {
    check,
    state: () => ({ minutes, windowStart: '08:00', windowEnd: '23:00', quiet, lastAlertAt }),
    start() {
      clearInterval(timer)
      timer = setInterval(check, 5 * 60_000)
      timer.unref()
    },
    stop: () => clearInterval(timer),
  }
}
