// Pure formatting helpers. No DOM, so they import in Node for tests.
// IST is fixed at UTC+5:30 (no DST), so plain offset arithmetic is exact.
const IST_MS = 330 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const DASH = '—'

export const dash = (v) => (v == null || v === '' ? DASH : String(v))

export const fmtFare = (v) => (v == null || v === '' ? DASH : `₹${v}`)

export const sourceLabel = (s) => (!s ? DASH : s === 'app' ? 'App' : s.replace(/^whatsapp:/, ''))

// "YYYY-MM-DD" of the IST calendar day containing `date`.
export const istToday = (date = new Date()) => new Date(date.getTime() + IST_MS).toISOString().slice(0, 10)

export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

// UTC instant of 00:00 IST on `day`.
const istMidnight = (day) => Date.parse(`${day}T00:00:00Z`) - IST_MS

// Today shows time only; any other day shows "24 Nov, 06:00".
export function fmtWhen(iso, now = new Date()) {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return DASH
  const d = new Date(t + IST_MS)
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
  if (d.toISOString().slice(0, 10) === istToday(now)) return time
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${time}`
}

// A real calendar day "YYYY-MM-DD" (rejects 2026-02-31, which Date would roll over).
export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

// The API reads a bare day as the whole IST day, `to` inclusive, so send the days as picked.
export const dayRange = (fromDay, toDay) => ({
  from: isDay(fromDay) ? fromDay : undefined,
  to: isDay(toDay) ? toDay : undefined,
})

export const PRESETS = ['last24', 'today', 'yesterday', '7days']

// Open-ended presets have no `to`, so a re-fetch keeps catching new bookings.
// `to` is inclusive on the API, so "yesterday" ends 1 ms before today's IST midnight.
export function presetRange(name, now = new Date()) {
  const today = istToday(now)
  const iso = (ms) => new Date(ms).toISOString()
  switch (name) {
    case 'last24': return { from: iso(now.getTime() - DAY_MS) }
    case 'today': return { from: iso(istMidnight(today)) }
    case 'yesterday': return { from: iso(istMidnight(addDays(today, -1))), to: iso(istMidnight(today) - 1) }
    case '7days': return { from: iso(now.getTime() - 7 * DAY_MS) }
    default: throw new Error(`Unknown date preset: ${name}`)
  }
}

// True once the IST calendar day differs from the one the rows were rendered on.
export const istDayChanged = (renderedDay, now = new Date()) => istToday(now) !== renderedDay

// A group is quiet only inside the heartbeat window (IST "HH:MM"-"HH:MM") and only when a threshold is set.
export function isGroupQuiet(lastMessageAt, minutes, windowStart, windowEnd, now = new Date()) {
  if (!(minutes > 0) || !/^\d{2}:\d{2}$/.test(windowStart || '') || !/^\d{2}:\d{2}$/.test(windowEnd || '')) return false
  const hhmm = new Date(now.getTime() + IST_MS).toISOString().slice(11, 16)
  if (hhmm < windowStart || hhmm >= windowEnd) return false
  const last = lastMessageAt ? Date.parse(lastMessageAt) : NaN
  return Number.isNaN(last) || now.getTime() - last > minutes * 60000
}

// Status lines for the outputs queue; nothing for zero or missing counts.
export function outputsNote(counts = {}) {
  const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0)
  const lines = []
  if (n(counts.outputsPending)) lines.push(`${counts.outputsPending} alert${counts.outputsPending === 1 ? '' : 's'} waiting to send`)
  if (n(counts.outputsFailed)) lines.push(`${counts.outputsFailed} alert${counts.outputsFailed === 1 ? '' : 's'} failed`)
  return lines
}

export const quietLabel =(minutes) => `Quiet ${minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`}+`
