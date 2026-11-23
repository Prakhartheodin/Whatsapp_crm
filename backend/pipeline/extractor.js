import * as R from './rules.js'

// IST is a fixed UTC+5:30 (no TZ env: it is unreliable on Windows).
const IST = 330 * 60_000
const DAY = 86_400_000
const MIN = 60_000
const all = (re) => new RegExp(re.source, re.flags + 'g')

// none -> undefined; one distinct valid value -> it; several, or an invalid one (null) -> null (ambiguous).
function only(vals) {
  const u = new Set(vals.map((v) => JSON.stringify(v)))
  return u.size === 0 ? undefined : u.size === 1 && !u.has('null') ? vals[0] : null
}

// Replaces each match with a line break (so a place stops at the next field) and returns fn(match) for each.
function cut(s, re, fn) {
  const out = []
  s.text = s.text.replace(all(re), (...m) => { out.push(fn(m)); return ' \n ' })
  return out
}

/** Last 10 digits of every Indian mobile number in `text`. */
export const phonesIn = (text) => [...String(text).matchAll(all(R.PHONE))].map((m) => m[0].replace(/\D/g, '').slice(-10))
/** Last 10 digits of the one Indian mobile number in `text`, else null (none, or several different ones). */
export const contactOf = (text) => only(phonesIn(text)) ?? null

// UTC-midnight ms of a calendar day; null if the day does not exist (31/2).
function day(y, m, d) {
  const ms = Date.UTC(y, m, d)
  return new Date(ms).getUTCMonth() === m && new Date(ms).getUTCDate() === d ? ms : null
}
// Day-first explicit date; without a year, the next such day on or after today
// (a day only a few days past is a mistake, not next year: null).
function explicitDay(today, d, m, y) {
  if (y) return day(y.length === 2 ? 2000 + +y : +y, m, +d)
  const thisYear = new Date(today).getUTCFullYear()
  const ms = day(thisYear, m, +d)
  if (ms === null || ms >= today) return ms
  return today - ms <= R.PAST_DATE_GRACE_DAYS * DAY ? null : day(thisYear + 1, m, +d)
}
// Minutes after midnight, or null when the hour cannot be pinned down (7 baje: morning or evening?).
function minutes(hs, ms, suffix, context) {
  let h = +hs
  const min = ms ? +ms : 0
  const s = suffix?.toLowerCase()
  const mer = R.TIME_SUFFIXES.am.includes(s) ? 'am' : R.TIME_SUFFIXES.pm.includes(s) ? 'pm' : context
  if (mer && h >= 1 && h <= 12) h = (h % 12) + (mer === 'pm' ? 12 : 0)
  else if (!(h <= 23 && (h > 12 || h === 0 || hs.startsWith('0')))) return null
  return min > 59 ? null : h * 60 + min
}
// Removes trip qualifiers ("one way", "urgent") from the end of a short text; '' when nothing else is left.
const stripQualifiers = (p) => (p.length > R.FIELD_MAX_CHARS ? p : ` ${p}`.replace(R.TRAILING_QUALIFIERS, '').trim())

// The drop ends at a comma ("Agra, one way"), except one comma after a sub-locality ("Sector 62, Noida"),
// and only when what follows is more than trip qualifiers ("Sector 62, one way" -> "Sector 62").
function dropPart(place) {
  const parts = place?.split(',') ?? []
  const continues = parts.length > 1 && R.SUB_LOCALITY.test(parts[0]) && /\p{L}/u.test(stripQualifiers(parts[1].trim()))
  return continues ? `${parts[0]},${parts[1]}` : parts[0]
}
function clean(place) {
  let p = place?.replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/^[\s,-]+|[\s,-]+$/g, '')
  if (!p || p.length > R.FIELD_MAX_CHARS) return null
  const q = stripQualifiers(p)
  if (/\p{L}/u.test(q)) p = q // a qualifier that is the whole place ("Return") stays
  return /\p{L}/u.test(p) && p.split(' ').length <= R.PLACE_MAX_WORDS ? p : null
}

/** extract(text, receivedAt) -> { pickup, drop, tripDateTime, carType, fare, contact }; null when not found or ambiguous. Pure. */
export function extract(text, receivedAt) {
  const s = { text: String(text) }
  const t0 = receivedAt.getTime()
  const ist = new Date(t0 + IST)
  const today = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate())
  const am = R.AM_WORDS.test(s.text)
  const pm = R.PM_WORDS.test(s.text)
  const context = am && !pm ? 'am' : pm && !am ? 'pm' : null

  const contact = only(cut(s, R.PHONE, (m) => m[0].replace(/\D/g, '').slice(-10)))
  cut(s, R.PER_KM, () => 0)
  // each match may be a list or range ("6000-7000"): every number in it is a candidate
  const fare = only([...cut(s, R.FARE_BEFORE, (m) => m[1]), ...cut(s, R.FARE_AFTER, (m) => m[1])]
    .flatMap((v) => v.split(/[^\d,]+/).filter((n) => /\d/.test(n))).map((v) => {
      const n = Number(v.replace(/,/g, ''))
      return n >= R.FARE_MIN && n <= R.FARE_MAX ? n : null
    }))
  const date = only([
    ...cut(s, R.NUMERIC_DATE, (m) => explicitDay(today, m[1] ?? m[4], +(m[2] ?? m[6]) - 1, m[3] ?? m[7])),
    ...cut(s, R.TEXT_DATE, (m) => explicitDay(today, m[1], R.MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()))),
    ...cut(s, R.DAY_WORD, (m) => {
      const ahead = R.DAY_WORDS[m[0].toLowerCase().replace(/\s+/g, ' ')]
      // "kal" just after midnight: the coming morning, or the day after?
      return ahead === 1 && ist.getUTCHours() < R.TOMORROW_AMBIGUOUS_UNTIL_HOUR ? null : today + ahead * DAY
    }),
    ...cut(s, R.WEEKDAY, (m) => {
      const ahead = (R.WEEKDAYS.findIndex((w) => w.includes(m[0].toLowerCase())) - ist.getUTCDay() + 7) % 7
      return ahead ? today + ahead * DAY : null // today's own weekday name: this week or next?
    }),
  ])
  const time = only(cut(s, R.TIME, (m) => minutes(m[1], m[2], m[3], context)))
  cut(s, R.AM_WORDS, () => 0)
  cut(s, R.PM_WORDS, () => 0)

  // Date-like text the rules could not read: never fall back to "today/tomorrow".
  const unreadDate = cut(s, R.DATE_HINT, () => 0).length > 0 // also keeps "25-11" out of the places

  let tripDateTime = null
  if (time != null && date !== null && !unreadDate) {
    tripDateTime = new Date((date ?? today) + time * MIN - IST)
    // a time without a date is its next occurrence at or after receivedAt (to the minute)
    if (date === undefined && tripDateTime.getTime() < Math.floor(t0 / MIN) * MIN) tripDateTime = new Date(tripDateTime.getTime() + DAY)
  }

  const carType = only(cut(s, R.CAR_TYPE, (m) => R.CAR_TYPES.find((c) => c.toLowerCase() === m[0].toLowerCase().replace(/\s+/g, ' '))))
  cut(s, R.NOISE, () => 0)

  const labelled = [clean(s.text.match(R.PICKUP_LABEL)?.[1]), clean(dropPart(s.text.match(R.DROP_LABEL)?.[1]))]
  const [pickup, drop] = labelled[0] || labelled[1]
    ? labelled
    // a side that still holds "to"/"se" is two routes run together ("Delhi to Agra, Agra to Mathura"): ambiguous
    : only([...s.text.matchAll(all(R.ROUTE))].map((m) => (R.ROUTE_WORD.test(m[2]) ? null : [clean(m[1]), clean(dropPart(m[2]))]))) ?? [null, null]

  return { pickup, drop, tripDateTime, carType: carType ?? null, fare: fare ?? null, contact: contact ?? null }
}
