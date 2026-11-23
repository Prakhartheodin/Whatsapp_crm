import { ist } from './common.js'

// One line per field: newlines inside a value cannot fake extra lines in the alert.
const v = (x) => (x === null || x === undefined ? '' : String(x)).replace(/\s+/g, ' ').trim() || '—'

/** One plain-text alert. Works with the API shape (routes.js toBooking) and Mongoose documents. */
export function formatAlert(b) {
  return [
    `New booking: ${v(b?.pickup)} → ${v(b?.drop)}`,
    `Trip (IST): ${v(ist(b?.tripDateTime))}`,
    `Car: ${v(b?.carType)}`,
    `Fare: ${v(b?.fare)}`,
    `Contact: ${v(b?.contact)}`,
    `Source: ${v(b?.source)}`,
  ].join('\n')
}

export const REPEAT_LABEL = 'Possible repeat (delivery of the first copy could not be confirmed)'
const alert = (b, o) => (o.repeat ? `${REPEAT_LABEL}\n` : '') + formatAlert(b)

export function createOutputs({ telegram, sheets, sender, logger }) {
  const outputs = {
    telegram: [telegram, (b, o) => telegram.send(alert(b, o))],
    sheets: [sheets, (b, o) => sheets.append(b ?? {}, { check: o.check })],
    whatsappSend: [sender, (b, o) => sender.send(alert(b, o))],
  }
  return {
    status: () => ({ sheets: sheets.enabled, telegram: telegram.enabled, whatsappSend: sender.enabled }),
    /**
     * Fans out to every enabled output (or only those named in `only`). repeat: the alert text starts
     * with REPEAT_LABEL; check: Sheets first looks for the booking's row. Never rejects; one failing
     * output never blocks the others. Resolves to { telegram, sheets, whatsappSend }: true sent,
     * false not sent, 'unknown' maybe sent (timeout), null disabled or not asked.
     */
    async onConfirmed(booking, { only, repeat = false, check = false } = {}) {
      const names = Object.keys(outputs).filter((k) => outputs[k][0].enabled && (!only || only.includes(k)))
      const settled = await Promise.allSettled(names.map((k) => Promise.resolve(booking).then((b) => outputs[k][1](b, { repeat, check }))))
      const result = { telegram: null, sheets: null, whatsappSend: null }
      names.forEach((k, i) => {
        const v = settled[i].status === 'fulfilled' && settled[i].value
        result[k] = v === true || v === 'unknown' ? v : false
      })
      const failed = names.filter((k) => result[k] !== true)
      // Id and output names only: no phone number, no message text.
      if (failed.length) logger.error({ bookingId: String(booking?.id ?? booking?._id ?? ''), failed }, 'booking outputs failed')
      return result
    },
  }
}
