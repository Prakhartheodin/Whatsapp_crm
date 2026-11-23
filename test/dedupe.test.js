import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extract } from '../backend/pipeline/extractor.js'
import { normalisePlace, placesMatch, findDuplicate } from '../backend/pipeline/dedupe.js'
import { fakeBooking } from './fake-booking.js'

const samples = JSON.parse(fs.readFileSync(new URL('./samples.json', import.meta.url), 'utf8'))
const H = 3600_000
const candidateOf = (s) => ({ ...extract(s.text, new Date(s.receivedAt)), rawText: s.text, receivedAt: new Date(s.receivedAt) })
const rowOf = (s, extra = {}) => {
  const c = candidateOf(s)
  return { _id: s.id, ...c, pickupNorm: normalisePlace(c.pickup), dropNorm: normalisePlace(c.drop), status: 'confirmed', ...extra }
}

// Each booking sample is checked against all earlier booking samples stored as bookings:
// it must fold into exactly its `duplicateOf`, or into nothing.
const bookings = samples.filter((s) => s.expected.isBooking)
bookings.forEach((s, i) => {
  test(`dedupe: sample ${s.id} ${s.duplicateOf ? `is a duplicate of ${s.duplicateOf}` : 'is new'}`, async () => {
    const Booking = fakeBooking(bookings.slice(0, i).map((x) => rowOf(x)))
    const dup = await findDuplicate(Booking, candidateOf(s))
    assert.equal(dup?._id ?? null, s.duplicateOf)
  })
})

test('normalisePlace: lowercase, punctuation, spaces, filler words', () => {
  assert.equal(normalisePlace('  Near, IGI   Airport (T3)!! '), 'igi airport t3')
  assert.equal(normalisePlace('Opp. Railway Station'), 'railway station')
  assert.equal(normalisePlace('near'), null)
  assert.equal(normalisePlace(null), null)
})

test('placesMatch', () => {
  assert.equal(placesMatch('connaught place', 'connaught place'), true)
  assert.equal(placesMatch('conaught place', 'connaught place'), true) // one-letter typo
  assert.equal(placesMatch('igi airport t3', 'igi airport terminal t3'), true) // 3 of 4 words
  assert.equal(placesMatch('noida sector 62', 'noida sector 63'), false) // numbers must be exact
  assert.equal(placesMatch('sector 62 noida', 'sector 18 noida'), false)
  assert.equal(placesMatch('agra', 'agar'), false) // short words must be exact
  assert.equal(placesMatch('delhi', 'delhi airport'), false)
  // any difference in numbers blocks a match, whatever the share of other words
  assert.equal(placesMatch('IGI Airport Terminal 1', 'IGI Airport Terminal 3'), false)
  assert.equal(placesMatch('Noida Sector 62 Block A', 'Noida Sector 63 Block A'), false)
  // one typo only in long words with the same first letter
  assert.equal(placesMatch('Jaipur', 'Raipur'), false)
  assert.equal(placesMatch('Patna', 'Panna'), false)
  assert.equal(placesMatch('Mumbai', 'Mumbra'), false) // 6 letters, but 2 edits
  assert.equal(placesMatch('Gurgaon', 'Gurgaun'), true)
  assert.equal(placesMatch(null, null), false)
  assert.equal(placesMatch('delhi', null), false)
})

test('findDuplicate: the section 7 rules', async () => {
  const t0 = new Date('2026-11-20T10:00:00+05:30')
  const trip = new Date('2026-11-21T04:00:00+05:30')
  const base = { contact: '9810012345', pickup: 'Connaught Place', drop: 'IGI Airport T3', tripDateTime: trip, receivedAt: t0, rawText: 'CP to IGI T3 4 am 9810012345' }
  const row = (extra) => ({ _id: 'b1', ...base, pickupNorm: 'connaught place', dropNorm: 'igi airport t3', status: 'confirmed', ...extra })
  const find = (rows, cand) => findDuplicate(fakeBooking(rows), { ...base, rawText: 'other wording', receivedAt: new Date(+t0 + H), ...cand })

  assert.equal((await find([row()], {}))?._id, 'b1')
  assert.equal((await find([row({ status: 'review' })], {}))?._id, 'b1')
  assert.equal(await find([row({ status: 'rejected' })], {}), null)
  assert.equal(await find([row()], { contact: '9810012346' }), null)
  assert.equal(await find([row()], { contact: null }), null)
  assert.equal(await find([row()], { drop: 'Agra' }), null)
  assert.equal(await find([row()], { pickup: null }), null)
  assert.equal(await find([row()], { tripDateTime: new Date(+trip + 60_000) }), null)
  assert.equal((await find([row()], { tripDateTime: new Date(+trip + 30_000) }))?._id, 'b1') // same minute
  // a missing trip time merges only an identical text (case and spacing aside)
  assert.equal(await find([row()], { tripDateTime: null, rawText: 'other text' }), null)
  assert.equal((await find([row()], { tripDateTime: null, rawText: ' cp to  IGI t3 4 AM 9810012345' }))?._id, 'b1')
  assert.equal(await find([row({ tripDateTime: null })], { tripDateTime: null, rawText: 'other text' }), null)
  assert.equal((await find([row({ tripDateTime: null })], { tripDateTime: null, rawText: base.rawText }))?._id, 'b1')
  // the same text with two different trip times is two bookings
  assert.equal(await find([row()], { tripDateTime: new Date(+trip + 86_400_000), rawText: base.rawText }), null)
  // a differing car type or fare (both present) blocks a merge; one side empty does not
  assert.equal(await find([row({ carType: 'Sedan' })], { carType: 'Innova' }), null)
  assert.equal(await find([row({ fare: 900 })], { fare: 1200 }), null)
  assert.equal((await find([row({ carType: null, fare: null })], { carType: 'Sedan', fare: 900 }))?._id, 'b1')
  assert.equal(await find([row()], { receivedAt: new Date(+t0 + 25 * H) }), null)
  assert.equal(await find([row({ receivedAt: new Date(+t0 - 25 * H) })], {}), null)
  // the window is +-24 h, so a late-processed older copy (spool replay) still folds in
  assert.equal((await find([row({ receivedAt: new Date(+t0 + 3 * H) })], {}))?._id, 'b1')
  // earliest matching booking wins
  const two = [row({ _id: 'b2', receivedAt: new Date(+t0 + 30 * 60_000) }), row()]
  assert.equal((await find(two, {}))?._id, 'b1')
})

test('findDuplicate: without a contact only an identical text within the window folds', async () => {
  const t0 = new Date('2026-11-20T12:00:00+05:30')
  const text = 'Delhi to Jaipur kal 6 am Sedan 9876543210 / 9812345678'
  const row = { _id: 'b1', contact: null, pickup: 'Delhi', drop: 'Jaipur', pickupNorm: 'delhi', dropNorm: 'jaipur', tripDateTime: null, rawText: text, receivedAt: t0, status: 'review' }
  const cand = { contact: null, pickup: 'Delhi', drop: 'Jaipur', tripDateTime: null, rawText: text.toUpperCase(), receivedAt: new Date(+t0 + H) }
  assert.equal((await findDuplicate(fakeBooking([{ ...row }]), cand))?._id, 'b1')
  assert.equal(await findDuplicate(fakeBooking([{ ...row }]), { ...cand, rawText: 'Delhi to Jaipur kal 7 am' }), null)
  // a forwarded copy with an emoji or WhatsApp formatting is still the same text
  const styled = `🚕 *Delhi to Jaipur* _kal_ 6 am ~Sedan~ \`9876543210\` / 9812345678 🙏`
  assert.equal((await findDuplicate(fakeBooking([{ ...row }]), { ...cand, rawText: styled }))?._id, 'b1')
  assert.equal(await findDuplicate(fakeBooking([{ ...row, status: 'rejected' }]), cand), null)
  assert.equal(await findDuplicate(fakeBooking([{ ...row }]), { ...cand, receivedAt: new Date(+t0 + 25 * H) }), null)
})

test('fake Booking model refuses operators it does not implement', () => {
  assert.throws(() => fakeBooking([{ a: 1 }]).find({ a: { $in: [1] } }), /unsupported/)
  assert.throws(() => fakeBooking([{ a: 1 }]).find({ $or: [] }), /unsupported/)
})
