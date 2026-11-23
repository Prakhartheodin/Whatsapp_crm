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

export function createOutputs({ telegram, sheets, sender, logger }) {
  const outputs = { telegram: [telegram, (b) => telegram.send(formatAlert(b))], sheets: [sheets, (b) => sheets.append(b ?? {})],
    whatsappSend: [sender, (b) => sender.send(formatAlert(b))] }
  return {
    status: () => ({ sheets: sheets.enabled, telegram: telegram.enabled, whatsappSend: sender.enabled }),
    /**
     * Fans out to every enabled output. Never rejects; one failing output never blocks the others.
     * Resolves to { telegram, sheets, whatsappSend }: true sent, false failed, null disabled.
     */
    async onConfirmed(booking) {
      const names = Object.keys(outputs).filter((k) => outputs[k][0].enabled)
      const settled = await Promise.allSettled(names.map((k) => Promise.resolve(booking).then(outputs[k][1])))
      const result = { telegram: null, sheets: null, whatsappSend: null }
      names.forEach((k, i) => { result[k] = settled[i].status === 'fulfilled' && settled[i].value === true })
      const failed = names.filter((k) => !result[k])
      // Id and output names only: no phone number, no message text.
      if (failed.length) logger.error({ bookingId: String(booking?.id ?? booking?._id ?? ''), failed }, 'booking outputs failed')
      return result
    },
  }
}
