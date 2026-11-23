// ============================================================================
// PLACEHOLDER RULES. The owner has not supplied real booking messages yet, so
// EVERY keyword, pattern, weight and threshold in this file is an invented,
// deliberately conservative guess. Tune them from test/samples.json once real
// samples arrive (each group is marked TODO(samples)).
// All detection vocabulary lives here: no other file may hard-code a keyword.
// Not covered yet: Devanagari script, "raat/night" times, month-first dates.
// ============================================================================

// Escaped alternation, longest first (so "innova crysta" wins over "innova"); a space matches any whitespace.
const alt = (words) =>
  [...words].sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')
// Whole-word match that also works next to non-ASCII letters (\b does not).
const anyWord = (words) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(words)})(?![\\p{L}\\p{N}])`, 'iu')
// A signal that matches when any of several patterns does.
const anyOf = (...res) => ({ test: (text) => res.some((re) => re.test(text)) })

// TODO(samples): thresholds. score >= HIGH: rules decide; LOW < score < HIGH: LLM or Review; score <= LOW: ignored.
export const HIGH = 6
export const LOW = 2
// TODO(samples): score that maps to confidence 1 for rule-decided bookings (confidence = score / this, capped at 1).
export const RULES_FULL_CONFIDENCE_SCORE = 12
// TODO(samples): at most this many messages wait on the LLM at once; further unclear messages go straight to Review.
export const LLM_MAX_IN_FLIGHT = 4
// TODO(samples): longest pickup, drop or car type kept (from rules or the LLM); longer -> null.
export const FIELD_MAX_CHARS = 100

// TODO(samples): vehicle names, as they are stored in carType.
export const CAR_TYPES = ['Sedan', 'SUV', 'Hatchback', 'Dzire', 'Etios', 'Swift', 'Wagon R', 'Ertiga', 'Innova',
  'Innova Crysta', 'Xylo', 'Tempo Traveller']
export const CAR_TYPE = anyWord(CAR_TYPES)

// TODO(samples): words that say "I need a car".
export const BOOKING_WORDS = ['cab', 'taxi', 'car', 'gadi', 'gaadi', 'gaddi', 'booking', 'book', 'need', 'needed',
  'required', 'require', 'urgent', 'chahiye', 'chaiye']
// TODO(samples): words cut out of the text before places are read, so they do not end up inside a place.
export const NOISE_WORDS = [...BOOKING_WORDS, 'jana', 'jaana', 'jana hai', 'jaana hai', 'ke liye', 'tak',
  'call', 'contact', 'ph', 'phone', 'mob', 'mobile', 'sampark', 'fixed', 'only',
  'bhai', 'bhaiya', 'sir', 'ji', 'hello', 'hi', 'please', 'plz', 'pls', 'koi', 'kya']
export const NOISE = anyWord(NOISE_WORDS)
// TODO(samples): driver-availability words ("free car", "khali gadi"). Customers ask "car available?" too,
// so these cap the decision at Review instead of subtracting (see SIGNALS).
export const AVAILABILITY_WORDS = ['available', 'availability', 'khali', 'khaali', 'free car', 'empty car', 'return car',
  'empty return', 'vacant']

// TODO(samples): relative day words -> days after the day the message arrived (IST).
export const DAY_WORDS = { 'day after tomorrow': 2, parso: 2, parson: 2, tomorrow: 1, tmrw: 1, kal: 1, today: 0, aaj: 0, tonight: 0 }
export const DAY_WORD = anyWord(Object.keys(DAY_WORDS))
// TODO(samples): a 1-day-ahead word ("kal", "tomorrow") sent from midnight until this hour IST may mean the
// coming morning or the day after: the date is left empty (ambiguous).
export const TOMORROW_AMBIGUOUS_UNTIL_HOUR = 4
// TODO(samples): weekday names, index 0 = Sunday.
export const WEEKDAYS = [['sunday', 'ravivar', 'itwar'], ['monday', 'somvar'], ['tuesday', 'mangalvar'],
  ['wednesday', 'budhvar'], ['thursday', 'guruvar'], ['friday', 'shukravar'], ['saturday', 'shanivar']]
export const WEEKDAY = anyWord(WEEKDAYS.flat())
// TODO(samples): explicit dates, day first (Indian order): 21/11, 21/11/2026, 21-11-2026, 21.11.2026, 21 Nov,
// 3rd December. Dashes and dots only with a year: "6-7 seater" is a count, "6.30" a time.
export const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] // first 3 letters
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'sept', 'october',
  'november', 'december', ...MONTHS]
// TODO(samples): words before a number like "12/3" that make it an address, not a date ("flat 12/3", "H.No. 4/2").
export const ADDRESS_WORDS = ['flat', 'house', 'house no', 'h.no', 'h no', 'hno', 'plot', 'gali', 'lane', 'block',
  'sector', 'room', 'shop', 'gate']
const NOT_ADDRESS = `(?<!(?:^|[^\\p{L}\\p{N}])(?:${alt(ADDRESS_WORDS)})[\\s.:#-]*)`
export const NUMERIC_DATE = new RegExp(`${NOT_ADDRESS}(?<![\\p{N}/.-])(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{4}|\\d{2}))?(?![\\p{N}/])|(?<![\\p{N}/.-])(\\d{1,2})([-.])(\\d{1,2})\\5(\\d{4}|\\d{2})(?![\\p{N}.-])`, 'iu')
export const TEXT_DATE = new RegExp(`(?<!\\p{N})(\\d{1,2})(?:st|nd|rd|th)?\\s*(${alt(MONTH_NAMES)})(?![\\p{L}\\p{N}])`, 'iu')
// TODO(samples): an explicit date up to this many days in the past is a mistake, not next year: left empty.
export const PAST_DATE_GRACE_DAYS = 7
// TODO(samples): words after a number range that make it a count, not a date ("6-7 seater", "2-3 log", "7-8 hrs").
export const RANGE_UNIT_WORDS = ['seater', 'seats', 'seat', 'passengers', 'passenger', 'pax', 'log', 'sawari', 'sawaari',
  'people', 'persons', 'person', 'members', 'hrs', 'hr', 'hours', 'km', 'days', 'din']
// TODO(samples): date-like text still left after the dates above were read ("25-11", "Nov 25", "25 tarikh",
// "date 25"). When any is left, the trip time is left empty rather than guessed as the next occurrence.
// Month names and "date" count only next to a day number, so "I may need" or "date fix hai" do not.
export const DATE_HINT = new RegExp([
  `${NOT_ADDRESS}(?<!\\p{N})\\d{1,2}\\s*[-./]\\s*\\d{1,2}(?!\\p{N})(?!\\s*(?:${alt(RANGE_UNIT_WORDS)})(?![\\p{L}\\p{N}]))`,
  `(?<![\\p{L}\\p{N}])(?:${alt([...MONTH_NAMES, 'date'])})\\s*[:-]?\\s*\\d{1,2}(?!\\p{N})`,
  `(?<!\\p{N})\\d{1,2}\\s*(?:${alt(['tarikh', 'tareekh', 'tarik'])})(?![\\p{L}\\p{N}])`,
].join('|'), 'iu')

// TODO(samples): times. "6 am", "6:30pm", "7 baje", "18:30". Without am/pm a clock hour of 1-12 needs a
// morning/evening word somewhere in the message, otherwise the time is ambiguous and left empty.
export const TIME_SUFFIXES = { am: ['am', 'a.m', 'a.m.'], pm: ['pm', 'p.m', 'p.m.'], none: ['baje', 'bje', 'hrs'] }
const SUFFIX = alt(Object.values(TIME_SUFFIXES).flat())
export const TIME = new RegExp(`(?<![\\p{N}:./-])(\\d{1,2})(?=[:.]\\d{2}|\\s*(?:${SUFFIX})(?![\\p{L}]))(?:[:.](\\d{2}))?\\s*(${SUFFIX})?(?![\\p{L}\\p{N}])`, 'iu')
export const AM_WORDS = anyWord(['subah', 'subha', 'morning', 'savere', 'savera'])
export const PM_WORDS = anyWord(['shaam', 'sham', 'evening', 'dopahar', 'afternoon'])

// TODO(samples): Indian mobile numbers, optional +91 / 91 / 0 prefix, single spaces or dashes between digits.
export const PHONE = /(?<![\p{N}+])(?:\+\s*91[\s-]*|91[\s-]*|0)?[6-9](?:[\s-]?\d){9}(?!\p{N})/u

// TODO(samples): fares. A bare number is never a fare; it needs a currency or fare word. Rupees, plausible range only
// (also applied to the LLM's fare).
// A list or range of fare-sized numbers ("6000 7000", "6000-7000", "6000 ya 7000") is captured whole, so the
// extractor sees every candidate and leaves the fare empty when they differ. Items after the first need 3+
// digits ("fare 3500, 2-3 log" is one fare); a separator is required, so a digit run cannot be split.
const FARE_NUMS = `(\\d[\\d,]*(?:(?:\\s*(?:[-–/]|or|ya|to|se)\\s*|\\s+)\\d[\\d,]{2,})*)`
const RUPEE_WORDS = '(?:rs|rupees|rupee|rupay|rupaye|rupaiya)(?!\\p{L})'
export const FARE_BEFORE = new RegExp(`(?:₹|(?<![\\p{L}\\p{N}])(?:rs\\.?|inr|fare|price|rate|kiraya|bhada|amount)(?!\\p{L}))\\s*[:=-]?\\s*${FARE_NUMS}(?![\\p{N}])`, 'iu')
export const FARE_AFTER = new RegExp(`(?<![\\p{N},])${FARE_NUMS}\\s*(?:\\/-|₹|${RUPEE_WORDS})`, 'iu')
// TODO(samples): a per-km rate ("12/km", "12 rs per km", "₹150 per km") is not a fare; it is cut out first.
export const PER_KM = new RegExp(`(?:₹\\s*|(?<![\\p{L}\\p{N}])rs\\.?\\s*)?(?<![\\p{N},])\\d[\\d,]*\\s*(?:₹|${RUPEE_WORDS})?\\s*(?:\\/|per|prati)\\s*(?:km|kms|kilometer|kilometre)(?!\\p{L})`, 'iu')
export const FARE_MIN = 100
export const FARE_MAX = 100000

// TODO(samples): places. Read after every field above (and NOISE_WORDS) has been cut out of the text (each cut
// leaves a line break), so a place is whatever is left up to the next field or sentence end. A comma does not
// end a place ("Sector 62, Noida"). Labels win over "X to Y" routes.
const SEP = ';\\n.!?:'
// (?<=\S): start only at the end of a word, so a long whitespace run is not rescanned from every position.
const ROUTE_SEP = '(?:(?<=\\S)\\s+(?:to|se)\\s+|(?<=\\S)\\s*(?:->|→)\\s*)'
export const ROUTE_WORD = new RegExp(ROUTE_SEP, 'iu') // a place containing one is two routes run together: ambiguous
export const PICKUP_LABEL = new RegExp(`(?<!\\p{L})pick\\s*-?\\s*up(?:\\s+(?:point|from|location))?\\s*[:-]?\\s*([^${SEP}]+?)\\s*(?=[${SEP}]|(?<!\\p{L})drop(?!\\p{L})|$)`, 'iu')
export const DROP_LABEL = new RegExp(`(?<!\\p{L})drop(?:\\s+(?:point|location|at|to))?\\s*[:-]?\\s*([^${SEP}]+?)\\s*(?=[${SEP}]|(?<!\\p{L})pick\\s*-?\\s*up(?!\\p{L})|$)`, 'iu')
// The outer spaces must not match "\n" (a separator): `\s*` there made this cubic on runs of cut fields
// (4000 chars took ~10 s). Keep [^\S\n]* when editing.
export const ROUTE = new RegExp(`(?:^|[${SEP}])[^\\S\\n]*(?:from\\s+)?([^${SEP}]+?)${ROUTE_SEP}([^${SEP}]+?)[^\\S\\n]*(?=[${SEP}]|$)`, 'iu')
export const PLACE_MAX_WORDS = 6
// TODO(samples): a comma ends the drop ("Agra, one way"), except after a sub-locality: a part with a number
// or one of these words continues across that one comma ("Sector 62, Noida", "Block C, Vasant Kunj").
export const LOCALITY_WORDS = [...ADDRESS_WORDS, 'phase', 'terminal', 'tower', 'pocket', 'wing', 'floor']
export const SUB_LOCALITY = new RegExp(`\\p{N}|${anyWord(LOCALITY_WORDS).source}`, 'iu')

// TODO(samples): words dropped when normalising places for de-duplication.
export const FILLER_WORDS = ['near', 'opp', 'opposite', 'the', 'ke', 'paas', 'pass', 'ki', 'ka', 'side', 'area']
// TODO(samples): two places match when their numbers are identical and this share of words (of the longer
// place) match. Words match when equal or, for letters-only words of PLACE_TYPO_MIN_LETTERS+ letters with
// the same first letter, one edit apart (Connaught/Conaught yes; Jaipur/Raipur, Patna/Panna no).
export const PLACE_MATCH_MIN = 0.75
export const PLACE_TYPO_MIN_LETTERS = 6

// TODO(samples): weighted signal groups for the scorer. Each group counts once.
// A group with `cap` adds nothing; when it hits, rules never confirm and never ignore: a score above LOW
// goes to Review.
export const SIGNALS = [
  { name: 'route', weight: 2, re: new RegExp(`(?<!\\p{L})(?:pick\\s*-?\\s*up|drop)(?!\\p{L})|\\S\\s+(?:to|se)\\s+\\S|->|→`, 'iu') },
  { name: 'carType', weight: 3, re: CAR_TYPE },
  { name: 'bookingWord', weight: 3, re: anyWord(BOOKING_WORDS) }, // > LOW, so "cab chahiye airport" reaches Review
  { name: 'date', weight: 1, re: anyOf(DAY_WORD, WEEKDAY, NUMERIC_DATE, TEXT_DATE) },
  { name: 'time', weight: 1, re: TIME },
  { name: 'phone', weight: 2, re: PHONE },
  { name: 'fare', weight: 2, re: anyOf(FARE_BEFORE, FARE_AFTER) },
  { name: 'availability', weight: 0, cap: 'review', re: anyWord(AVAILABILITY_WORDS) },
]
