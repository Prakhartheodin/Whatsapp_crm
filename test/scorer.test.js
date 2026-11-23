import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { score } from '../backend/pipeline/scorer.js'
import { HIGH, LOW } from '../backend/pipeline/rules.js'

const samples = JSON.parse(fs.readFileSync(new URL('./samples.json', import.meta.url), 'utf8'))

// Contract: a booking is never silently dropped (score > LOW); a non-booking is never
// auto-confirmed (score < HIGH, or capped to Review).
for (const s of samples) {
  test(`scorer: sample ${s.id} (${s.expected.isBooking ? 'booking' : 'not a booking'})`, () => {
    const { score: n, hits, cap } = score(s.text)
    assert.ok(Array.isArray(hits))
    if (s.expected.isBooking) assert.ok(n > LOW, `score ${n} <= LOW ${LOW}, hits ${hits}`)
    else assert.ok(n < HIGH || cap === 'review', `score ${n} >= HIGH ${HIGH} and not capped, hits ${hits}`)
  })
}

test('scorer: availability words cap at Review instead of subtracting', () => {
  const with_ = score('Sedan car available Delhi to Chandigarh kal 6 am, Rs 2500, call 9876501234')
  const without = score('Sedan car Delhi to Chandigarh kal 6 am, Rs 2500, call 9876501234')
  assert.equal(with_.score, without.score)
  assert.equal(with_.cap, 'review')
  assert.equal(without.cap, null)
  // a terse request now passes LOW (booking words weigh more)
  assert.ok(score('Cab chahiye airport').score > LOW)
  assert.ok(score('Gurgaon ke liye gadi chahiye abhi').score > LOW)
})

test('scorer: pure, empty text scores 0, hits name the matched groups', () => {
  assert.deepEqual(score(''), { score: 0, hits: [], cap: null })
  const a = score('Need Sedan Delhi to Agra, call 9876543210')
  assert.deepEqual(score('Need Sedan Delhi to Agra, call 9876543210'), a)
  assert.ok(a.hits.includes('carType') && a.hits.includes('phone') && a.hits.includes('route'))
})

