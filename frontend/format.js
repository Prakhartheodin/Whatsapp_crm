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

// Whole IST days, `to` inclusive (sent as the exclusive start of the next day).
export const dayRange = (fromDay, toDay) => ({
  from: new Date(istMidnight(fromDay)).toISOString(),
  to: new Date(istMidnight(addDays(toDay, 1))).toISOString(),
})

// Open-ended presets have no `to`, so a re-fetch keeps catching new bookings.
export function presetRange(name, now = new Date()) {
  const today = istToday(now)
  const iso = (ms) => new Date(ms).toISOString()
  switch (name) {
    case 'last24': return { from: iso(now.getTime() - DAY_MS) }
    case 'today': return { from: iso(istMidnight(today)) }
    case 'yesterday': return { from: iso(istMidnight(addDays(today, -1))), to: iso(istMidnight(today)) }
    case '7days': return { from: iso(now.getTime() - 7 * DAY_MS) }
    default: throw new Error(`Unknown date preset: ${name}`)
  }
}

export const quietLabel = (minutes) => `Quiet ${minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`}+`
