import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtWhen, fmtFare, dash, sourceLabel, istToday, addDays, dayRange, presetRange, quietLabel,
} from '../frontend/format.js'

// 24 Nov 2026, 00:01 IST
const justAfterMidnight = new Date('2026-11-23T18:31:00Z')

test('fmtWhen: today shows time only, in IST', () => {
  assert.equal(fmtWhen('2026-11-23T18:30:30Z', justAfterMidnight), '00:00')
  assert.equal(fmtWhen('2026-11-24T05:12:00Z', new Date('2026-11-24T10:00:00Z')), '10:42')
})

test('fmtWhen: a minute before IST midnight is yesterday, so date + time', () => {
  assert.equal(fmtWhen('2026-11-23T18:29:00Z', justAfterMidnight), '23 Nov, 23:59')
})

test('fmtWhen: same UTC day but different IST day still shows the date', () => {
  // 23 Nov 15:30 IST vs now 24 Nov 00:01 IST (both 23 Nov in UTC)
  assert.equal(fmtWhen('2026-11-23T10:00:00Z', justAfterMidnight), '23 Nov, 15:30')
})

test('fmtWhen: other days and missing values', () => {
  assert.equal(fmtWhen('2026-11-24T00:30:00Z', justAfterMidnight), '06:00') // later today (trip time)
  assert.equal(fmtWhen('2026-11-25T00:30:00Z', justAfterMidnight), '25 Nov, 06:00')
  assert.equal(fmtWhen('2026-01-05T00:30:00Z', justAfterMidnight), '5 Jan, 06:00')
  assert.equal(fmtWhen(null), '—')
  assert.equal(fmtWhen('not a date'), '—')
})

test('fmtFare and dash', () => {
  assert.equal(fmtFare(3500), '₹3500')
  assert.equal(fmtFare('3500'), '₹3500')
  assert.equal(fmtFare(0), '₹0')
  assert.equal(fmtFare(null), '—')
  assert.equal(fmtFare(undefined), '—')
  assert.equal(dash('Sedan'), 'Sedan')
  assert.equal(dash(''), '—')
  assert.equal(dash(null), '—')
  assert.equal(dash(0), '0')
})

test('sourceLabel', () => {
  assert.equal(sourceLabel('whatsapp:Group A'), 'Group A')
  assert.equal(sourceLabel('app'), 'App')
  assert.equal(sourceLabel(null), '—')
})

test('IST calendar dates', () => {
  assert.equal(istToday(justAfterMidnight), '2026-11-24')
  assert.equal(istToday(new Date('2026-11-23T18:29:00Z')), '2026-11-23')
  assert.equal(addDays('2026-11-24', -6), '2026-11-18')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.deepEqual(dayRange('2026-11-18', '2026-11-24'), {
    from: '2026-11-17T18:30:00.000Z', to: '2026-11-24T18:30:00.000Z',
  })
})

test('presetRange', () => {
  const now = justAfterMidnight
  assert.deepEqual(presetRange('last24', now), { from: '2026-11-22T18:31:00.000Z' })
  assert.deepEqual(presetRange('today', now), { from: '2026-11-23T18:30:00.000Z' })
  assert.deepEqual(presetRange('yesterday', now), {
    from: '2026-11-22T18:30:00.000Z', to: '2026-11-23T18:30:00.000Z',
  })
  assert.deepEqual(presetRange('7days', now), { from: '2026-11-16T18:31:00.000Z' })
  assert.throws(() => presetRange('bogus', now))
})

test('quietLabel', () => {
  assert.equal(quietLabel(120), 'Quiet 2h+')
  assert.equal(quietLabel(90), 'Quiet 90m+')
})
