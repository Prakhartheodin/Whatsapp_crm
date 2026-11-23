import { setTimeout as delay } from 'node:timers/promises'
import { call } from './common.js'

/** Telegram bot alert. send(text) -> true, false (not sent) or 'unknown' (timeout: may have been sent); never throws. */
export function createTelegram(config, { fetch = globalThis.fetch, logger, sleep = delay }) {
  if (!config.telegramEnabled) {
    logger.warn('TELEGRAM_ENABLED=false: heartbeat, session-down and booking alerts are not sent anywhere')
    return { enabled: false, send: async () => false }
  }
  const token = config.telegramBotToken
  const chatId = config.telegramChatId
  // The token goes into the URL path, so its shape is checked strictly.
  if (!/^\d+:[\w-]+$/.test(token ?? '')) throw new Error('TELEGRAM_BOT_TOKEN: missing or not a bot token (123456:ABC...)')
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID: required when TELEGRAM_ENABLED=true')
  const url = `https://api.telegram.org/bot${token}/sendMessage`

  return {
    enabled: true,
    async send(text) {
      // Plain text (no parse_mode): message content cannot inject formatting. Never cut a surrogate pair.
      // No link previews: a URL in a booking field must not render an attacker-chosen card.
      const body = {
        chat_id: chatId,
        text: String(text).slice(0, 4096).replace(/[\ud800-\udbff]$/, ''),
        link_preview_options: { is_disabled: true },
      }
      const res = await call(fetch, url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }, { logger, sleep, output: 'telegram' })
      return res.ok || (res.unknown ? 'unknown' : false)
    },
  }
}
