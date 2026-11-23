import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extract } from '../backend/pipeline/extractor.js'

const samples = JSON.parse(fs.readFileSync(new URL('./samples.json', import.meta.url), 'utf8'))
const FIELDS = ['pickup', 'drop', 'tripDateTime', 'carType', 'fare', 'contact']
const at = (s) => new Date(s)
const iso = (d) => (d ? d.toISOString() : d)

for (const s of samples.filter((x) => x.expected.isBooking)) {
  test(`extractor: sample ${s.id}`, () => {
    const got = extract(s.text, at(s.receivedAt))
    for (const f of FIELDS.filter((k) => k in s.expected)) {
      const want = f === 'tripDateTime' && s.expected[f] ? iso(at(s.expected[f])) : s.expected[f]
      assert.deepEqual(f === 'tripDateTime' ? iso(got[f]) : got[f], want, `${s.id}.${f}`)
    }
  })
}

test('extractor: returns every field, null when nothing is found', () => {
  assert.deepEqual(extract('hello there', at('2026-11-20T10:00:00+05:30')),
    { pickup: null, drop: null, tripDateTime: null, carType: null, fare: null, contact: null })
})

test('extractor: phone numbers', () => {
  const c = (t) => extract(t, new Date()).contact
  assert.equal(c('call +91 98765 43210'), '9876543210')
  assert.equal(c('call +91-98765-43210'), '9876543210')
  assert.equal(c('call 919876543210'), '9876543210')
  assert.equal(c('call 098765 43210'), '9876543210')
  assert.equal(c('call 98765-43210'), '9876543210')
  assert.equal(c('call 9876543210 or 9876543210'), '9876543210') // same number twice is fine
  assert.equal(c('call 9876543210 or 9812345678'), null) // two numbers: ambiguous
  assert.equal(c('call 12345 67890'), null) // not a mobile number
  assert.equal(c('ref 98765432101'), null) // 11 digits, no prefix
})

test('extractor: fare', () => {
  const f = (t) => extract(t, new Date()).fare
  assert.equal(f('Rs. 3,500 only'), 3500)
  assert.equal(f('3500/- fixed'), 3500)
  assert.equal(f('₹ 1200'), 1200)
  assert.equal(f('fare 50'), null) // below the plausible range
  assert.equal(f('Rs 900 or Rs 1200'), null) // ambiguous
  assert.equal(f('Delhi to Agra 3500'), null) // bare number is not a fare
})

test('extractor: dates and times resolve in IST', () => {
  const t = (text, received) => iso(extract(text, at(received)).tripDateTime)
  const ist = (s) => at(s).toISOString()
  // just after midnight IST the UTC date is still the previous day
  assert.equal(t('aaj 6 am', '2026-11-21T00:10:00+05:30'), ist('2026-11-21T06:00:00+05:30'))
  // "kal" late at night (just after midnight it is ambiguous: see the next tests)
  assert.equal(t('kal 7 am', '2026-11-20T23:30:00+05:30'), ist('2026-11-21T07:00:00+05:30'))
  assert.equal(t('kal 7 am', '2026-11-21T01:00:00+05:30'), null)
  assert.equal(t('kal 12 am', '2026-11-20T10:00:00+05:30'), ist('2026-11-21T00:00:00+05:30'))
  assert.equal(t('kal 12 pm', '2026-11-20T10:00:00+05:30'), ist('2026-11-21T12:00:00+05:30'))
  assert.equal(t('day after tomorrow 6:30 pm', '2026-11-20T10:00:00+05:30'), ist('2026-11-22T18:30:00+05:30'))
  // time without a date: next occurrence at or after receivedAt
  assert.equal(t('6 am', '2026-11-20T09:15:00+05:30'), ist('2026-11-21T06:00:00+05:30'))
  assert.equal(t('9:15 am', '2026-11-20T09:15:40+05:30'), ist('2026-11-20T09:15:00+05:30'))
  assert.equal(t('18:30', '2026-11-20T09:15:00+05:30'), ist('2026-11-20T18:30:00+05:30'))
  assert.equal(t('shaam 7 baje', '2026-11-20T09:15:00+05:30'), ist('2026-11-20T19:00:00+05:30'))
  // weekday names (2026-11-20 is a Friday) and explicit dates
  assert.equal(t('monday 10 am', '2026-11-20T09:15:00+05:30'), ist('2026-11-23T10:00:00+05:30'))
  assert.equal(t('25/12 10 am', '2026-11-20T09:15:00+05:30'), ist('2026-12-25T10:00:00+05:30'))
  assert.equal(t('5/1 10 am', '2026-11-20T09:15:00+05:30'), ist('2027-01-05T10:00:00+05:30'))
  assert.equal(t('21/11/2026 10 am', '2026-11-20T09:15:00+05:30'), ist('2026-11-21T10:00:00+05:30'))
  assert.equal(t('3rd December 10 am', '2026-11-20T09:15:00+05:30'), ist('2026-12-03T10:00:00+05:30'))
})

test('extractor: ambiguous dates and times give null, never a guess', () => {
  const t = (text) => extract(text, at('2026-11-20T09:15:00+05:30')).tripDateTime
  assert.equal(t('kal 8 baje'), null) // morning or evening?
  assert.equal(t('kal ya parso 7 am'), null) // two dates
  assert.equal(t('6 am or 8 am'), null) // two times
  assert.equal(t('kal'), null) // date without a time
  assert.equal(t('friday 10 am'), null) // today is Friday: this week or next?
  assert.equal(t('31/2 10 am'), null) // no such date
  assert.equal(t('25:00'), null)
  assert.equal(t('subah 7 baje, shaam ko wapas'), null) // morning and evening words
})

test('extractor: dash and dot dates; unknown date text never falls back to "next occurrence"', () => {
  const e = (text, received = '2026-11-20T09:15:00+05:30') => extract(text, at(received))
  const ist = (s) => at(s).toISOString()
  // dash dates only with a year; a bare "25-11" could be a count, so the trip time is left empty
  const r = e('Delhi to Agra 25-11 6 am, Sedan, 9876543210')
  assert.equal(r.tripDateTime, null)
  assert.equal(r.drop, 'Agra')
  assert.equal(iso(e('Delhi to Agra 25-11-2026 6 am').tripDateTime), ist('2026-11-25T06:00:00+05:30'))
  assert.equal(iso(e('Delhi to Agra 21.11.2026 6 am').tripDateTime), ist('2026-11-21T06:00:00+05:30'))
  assert.equal(iso(e('Delhi to Agra 6.30 pm').tripDateTime), ist('2026-11-20T18:30:00+05:30')) // a dotted time is not a date
  assert.equal(e('Delhi to Agra Nov 25 6 am').tripDateTime, null) // month before the day: not parsed, so no guess
  assert.equal(e('Delhi to Agra 25 tarikh 6 am').tripDateTime, null)
  assert.equal(e('Delhi to Agra 19/11 10 am').tripDateTime, null) // yesterday, not next year
  assert.equal(iso(e('Delhi to Agra 19/11 10 am', '2026-12-20T09:15:00+05:30').tripDateTime), ist('2027-11-19T10:00:00+05:30'))
})

test('extractor: counts, ranges and everyday words do not become dates or blank a clear trip time', () => {
  const t = (text) => iso(extract(text, at('2026-11-20T10:00:00+05:30')).tripDateTime)
  const tomorrow6 = at('2026-11-21T06:00:00+05:30').toISOString()
  assert.equal(t('Innova 6-7 seater, 6 am'), tomorrow6) // was 6 July 2027
  assert.equal(t('Delhi to Agra 6 am, Innova 6-7 seater 9876543210'), tomorrow6)
  assert.equal(t('4-5 passengers kal 6 am'), tomorrow6) // was 4 May 2027
  assert.equal(t('2-3 log kal 6 am'), tomorrow6)
  assert.equal(t('7-8 hrs ka kaam, kal 6 am'), tomorrow6)
  assert.equal(t('I may need a cab kal 6 am'), tomorrow6)
  assert.equal(t('nahi to mar jayenge, kal 6 am'), tomorrow6)
  assert.equal(t('date fix hai, kal 6 am'), tomorrow6)
  // still unreadable dates -> empty, not guessed
  assert.equal(t('25-11 6 am'), null)
  assert.equal(t('Nov 25 6 am'), null)
  assert.equal(t('25 tarikh 6 am'), null)
  assert.equal(t('date 25, 6 am'), null)
  assert.equal(t('25-11-2026 6 am'), at('2026-11-25T06:00:00+05:30').toISOString())
})

test('extractor: a place keeps its whole comma-separated phrase, up to the next field', () => {
  const e = (t) => extract(t, at('2026-11-20T10:00:00+05:30'))
  const a = e('Sector 62, Noida to IGI airport T3, kal 5 am, Sedan, 9876543210')
  assert.deepEqual([a.pickup, a.drop], ['Sector 62, Noida', 'IGI airport T3'])
  // the drop ends at a plain comma (round 4 decision); only a sub-locality continues across it
  const b = e('Noida Sector 62 to Connaught Place, New Delhi, Rs 900, 9876543210')
  assert.deepEqual([b.pickup, b.drop], ['Noida Sector 62', 'Connaught Place'])
  const c = e('Bhai, Delhi to Agra kal 6 am') // a greeting is not part of the place
  assert.deepEqual([c.pickup, c.drop], ['Delhi', 'Agra'])
  const d = e('Pickup: Sector 18, Noida, Drop: IGI T3, kal 5 am')
  assert.deepEqual([d.pickup, d.drop], ['Sector 18, Noida', 'IGI T3'])
})

test('extractor: a comma ends the drop unless the part before it is a sub-locality', () => {
  const e = (t) => extract(t, at('2026-11-20T10:00:00+05:30'))
  const drop = (t) => e(t).drop
  assert.equal(drop('Gurgaon se Jaipur, one way, Dzire'), 'Jaipur')
  assert.equal(drop('Delhi to Agra, one way, Rs 2500'), 'Agra')
  assert.equal(drop('Delhi to Agra, toll extra, kal 6 am'), 'Agra')
  assert.equal(drop('Gurgaon to Delhi airport, flight at 9 am'), 'Delhi airport')
  assert.equal(drop('Delhi to Agra, 2 din, return same day'), 'Agra')
  assert.equal(drop('Delhi to Agra, AC car, kal 6 am'), 'Agra')
  assert.equal(drop('Drop: Agra, one way'), 'Agra')
  // a numbered or locality part continues across one comma
  assert.equal(drop('IGI T3 to Sector 62, Noida, kal 5 am'), 'Sector 62, Noida')
  assert.equal(drop('Noida to Block C, Vasant Kunj'), 'Block C, Vasant Kunj')
  assert.equal(drop('Noida to Terminal 3, IGI Airport'), 'Terminal 3, IGI Airport')
  // the pickup may span commas; newlines still separate words
  assert.equal(e('Connaught Place, New Delhi to IGI T3').pickup, 'Connaught Place, New Delhi')
  assert.deepEqual([e('Delhi\nto\nAgra').pickup, e('Delhi\nto\nAgra').drop], ['Delhi', 'Agra'])
})

test('extractor: trip qualifiers ("one way", "urgent", "AC") are not part of a place', () => {
  const e = (t) => extract(t, at('2026-11-20T10:00:00+05:30'))
  const drop = (t) => e(t).drop
  assert.equal(drop('Delhi to Sector 62, one way'), 'Sector 62') // not a sub-locality continuation
  assert.equal(drop('Delhi to Terminal 3, urgent'), 'Terminal 3')
  assert.equal(drop('Delhi to Jaipur one way'), 'Jaipur') // trailing, no comma
  assert.equal(drop('Delhi to Jaipur one way, round trip, kal 7 am'), 'Jaipur')
  assert.equal(drop('Delhi to Agra non ac'), 'Agra')
  assert.equal(drop('Delhi to Sector 62, Noida one way'), 'Sector 62, Noida')
  assert.equal(e('Jaipur round trip to Delhi').pickup, 'Jaipur')
  // guards: a place keeps a qualifier word that is not at its end, or is its only word
  assert.equal(drop('Delhi to Sector 62, Noida kal 6 am'), 'Sector 62, Noida')
  assert.equal(drop('Delhi to AC Market, Tardeo'), 'AC Market')
  assert.equal(drop('Delhi to Block C, AC Market'), 'Block C, AC Market')
  assert.equal(drop('Noida to Return'), 'Return')
})

test('extractor: several fares, ranges and per-km rates give no fare', () => {
  const f = (t) => extract(t, at('2026-11-20T10:00:00+05:30')).fare
  assert.equal(f('Delhi to Agra kal 6 am Sedan fare 6000 7000 8000 negotiable'), null)
  assert.equal(f('fare 6000-7000'), null)
  assert.equal(f('6000-7000'), null)
  assert.equal(f('6000 - 7000 rs'), null)
  assert.equal(f('fare 6000 ya 7000'), null)
  assert.equal(f('12 rs per km'), null)
  assert.equal(f('Rs 12/km'), null)
  assert.equal(f('₹150 per km'), null)
  // a single fare survives repetition, a rate beside it, and numbers that are not fares
  assert.equal(f('Rs 3500'), 3500)
  assert.equal(f('Rs 3500 final, 3500 rs only'), 3500)
  assert.equal(f('Rs 3500 fixed, extra 15 rs per km'), 3500)
  assert.equal(f('fare 3500 kal 6 am'), 3500)
  assert.equal(f('fare 3500, 2-3 log'), 3500)
  assert.equal(f('Rs. 3,50,000'), null) // out of range
})

test('extractor: an address number like "flat 12/3" is not a date', () => {
  const e = (t) => extract(t, at('2026-11-20T10:00:00+05:30'))
  const r = e('flat 12/3 se airport kal 6 am')
  assert.equal(iso(r.tripDateTime), at('2026-11-21T06:00:00+05:30').toISOString())
  assert.deepEqual([r.pickup, r.drop], ['flat 12/3', 'airport'])
  assert.equal(iso(e('H.No. 4/2 to station, 6 am').tripDateTime), at('2026-11-21T06:00:00+05:30').toISOString())
  assert.equal(iso(e('Gali 3/1 se bus stand aaj 5 pm').tripDateTime), at('2026-11-20T17:00:00+05:30').toISOString())
  // without an address word it is still a date
  assert.equal(iso(e('Delhi to Agra 12/3 6 am').tripDateTime), at('2027-03-12T06:00:00+05:30').toISOString())
})

test('extractor: "kal" or "tomorrow" sent between midnight and 4 am IST is ambiguous', () => {
  const t = (text, received) => iso(extract(text, at(received)).tripDateTime)
  assert.equal(t('kal subah 7 baje', '2026-11-21T00:10:00+05:30'), null)
  assert.equal(t('tomorrow 7 am', '2026-11-21T03:59:00+05:30'), null)
  assert.equal(t('kal subah 7 baje', '2026-11-21T04:00:00+05:30'), at('2026-11-22T07:00:00+05:30').toISOString())
  assert.equal(t('aaj 7 am', '2026-11-21T00:10:00+05:30'), at('2026-11-21T07:00:00+05:30').toISOString())
})

test('extractor: a one-word place is capped in length', () => {
  assert.equal(extract('pickup ' + 'x'.repeat(3990) + ', drop Agra', new Date()).pickup, null)
})

test('extractor: car type and places', () => {
  const e = (t) => extract(t, at('2026-11-20T09:15:00+05:30'))
  assert.equal(e('innova crysta needed').carType, 'Innova Crysta')
  assert.equal(e('Sedan or SUV').carType, null)
  const r = e('Delhi to Agra tomorrow 6 am sedan')
  assert.deepEqual([r.pickup, r.drop], ['Delhi', 'Agra'])
  const two = e('Delhi to Agra, Agra to Mathura')
  assert.deepEqual([two.pickup, two.drop], [null, null]) // two routes: ambiguous
})
