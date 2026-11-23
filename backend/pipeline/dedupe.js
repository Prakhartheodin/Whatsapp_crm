import { FILLER_WORDS, PLACE_MATCH_MIN, PLACE_TYPO_MIN_LETTERS } from './rules.js'

const WINDOW = 24 * 3600_000
const MIN = 60_000
const hasDigit = (w) => /\p{N}/u.test(w)

/** Lowercase, punctuation -> space, filler words dropped, spaces collapsed. null when nothing is left. */
export function normalisePlace(s) {
  const words = String(s ?? '').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w && !FILLER_WORDS.includes(w))
  return words.join(' ') || null
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}
// One typo only in long letters-only words with the same first letter (Jaipur/Raipur are different cities).
const long = new RegExp(`^\\p{L}{${PLACE_TYPO_MIN_LETTERS},}$`, 'u')
const wordsMatch = (a, b) =>
  a === b || (a[0] === b[0] && Math.abs(a.length - b.length) <= 1 && long.test(a) && long.test(b) && editDistance(a, b) <= 1)

/**
 * Fuzzy match of two places (raw or normalised), in any word order: same numbers, every word of the shorter
 * place found in the longer one (New/Old Delhi Railway Station differ), and those make up enough of the longer.
 */
export function placesMatch(a, b) {
  const [x, y] = [normalisePlace(a)?.split(' '), normalisePlace(b)?.split(' ')].sort((p, q) => (p?.length ?? 0) - (q?.length ?? 0))
  if (!x || !y) return false
  if (x.filter(hasDigit).sort().join() !== y.filter(hasDigit).sort().join()) return false // sector 62 != 63, T1 != T3
  return x.every((w) => y.some((v) => wordsMatch(w, v))) && x.length / y.length >= PLACE_MATCH_MIN
}

// Same words in the same order: case, spacing, punctuation, emoji and WhatsApp *bold*/_italic_/~strike~ ignored.
const sameText = (a, b) => {
  const n = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
  return n(a) !== '' && n(a) === n(b)
}
const differ = (a, b) => a != null && b != null && a !== b

/**
 * The earliest non-rejected booking within +-24 h that `candidate` duplicates (design.md section 7), or null.
 * candidate: { contact, pickup, drop, tripDateTime, carType, fare, rawText, receivedAt }.
 */
export async function findDuplicate(Booking, c) {
  const t = c.receivedAt.getTime()
  const near = await Booking.find({
    contact: c.contact ?? null, // no single contact: only other contact-less bookings, matched by identical text
    status: { $ne: 'rejected' },
    receivedAt: { $gte: new Date(t - WINDOW), $lte: new Date(t + WINDOW) },
  }).sort({ receivedAt: 1 }).lean()
  return near.find((b) => {
    if (differ(b.carType, c.carType) || differ(b.fare, c.fare)) return false
    const bothTimes = b.tripDateTime != null && c.tripDateTime != null
    if (bothTimes && Math.floor(+b.tripDateTime / MIN) !== Math.floor(+c.tripDateTime / MIN)) return false
    // A missing trip time (or contact) proves little: then only an exact repost of the text counts.
    if (sameText(b.rawText, c.rawText)) return true
    return Boolean(c.contact) && bothTimes && placesMatch(b.pickupNorm, c.pickup) && placesMatch(b.dropNorm, c.drop)
  }) ?? null
}
