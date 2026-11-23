import pino from 'pino'
import { config } from './config.js'

// 919876543210 -> 91xxxxxxxx10
export function maskPhone(n) {
  const d = String(n).replace(/\D/g, '')
  return d.length < 5 ? 'xxxx' : d.slice(0, 2) + 'x'.repeat(d.length - 4) + d.slice(-2)
}

// Masks the number part of user JIDs (…@s.whatsapp.net, …@lid). Group IDs are left alone.
export const maskJids = (s) =>
  s.replace(/\d{6,}(?=(?::\d+)?@(?:s\.whatsapp\.net|lid|c\.us))/g, maskPhone)

const plain = (k, v) =>
  v instanceof Error
    ? { type: v.name, message: v.message, stack: v.stack, statusCode: v.output?.statusCode }
    : typeof v === 'bigint' ? String(v) : v

// Baileys logs JIDs in its own objects, so masking is applied to everything
// below debug level, not just to our own log calls.
export function maskObject(o) {
  try {
    return JSON.parse(maskJids(JSON.stringify(o, plain)))
  } catch {
    return { logError: 'unserialisable log object dropped' }
  }
}

const verbose = ['debug', 'trace'].includes(config.logLevel)

export const logger = pino({
  level: config.logLevel,
  formatters: { log: (o) => (verbose ? o : maskObject(o)) },
  hooks: {
    logMethod(args, method) {
      method.apply(this, verbose ? args : args.map((a) => (typeof a === 'string' ? maskJids(a) : a)))
    },
  },
})
