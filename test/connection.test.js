import test from 'node:test'
import assert from 'node:assert/strict'
import { nextStep } from '../backend/whatsapp/connection.js'

test('nextStep: stop codes stop, 515 reconnects at once, others back off with a cap', () => {
  assert.deepEqual(nextStep(401, 3), { stop: 'logged_out' })
  assert.deepEqual(nextStep(411, 0), { stop: 'logged_out' })
  assert.deepEqual(nextStep(440, 0), { stop: 'replaced' })
  assert.deepEqual(nextStep(403, 0), { stop: 'blocked' })
  assert.deepEqual(nextStep(515, 4), { delay: 0, attempt: 4 })
  assert.deepEqual(nextStep(428, 0, 1), { delay: 2000, attempt: 1 })
  assert.deepEqual(nextStep(428, 3, 1), { delay: 16000, attempt: 4 })
  assert.deepEqual(nextStep(undefined, 20, 0), { delay: 150_000, attempt: 21 }) // 5 min cap, jitter down to half
})
