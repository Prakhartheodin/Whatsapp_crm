import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtWhen, fmtFare, dash, sourceLabel, istToday, addDays, dayRange, presetRange, quietLabel, isDay, istDayChanged,
  isGroupQuiet, outputsNote,
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
})

test('dayRange sends picked days as bare dates (the API treats them as whole IST days, to inclusive)', () => {
  assert.deepEqual(dayRange('2026-11-18', '2026-11-24'), { from: '2026-11-18', to: '2026-11-24' })
  assert.deepEqual(dayRange('', '2026-11-24'), { from: undefined, to: '2026-11-24' })
  assert.deepEqual(dayRange('2026-02-31', 'junk'), { from: undefined, to: undefined })
})

test('isDay', () => {
  assert.equal(isDay('2026-11-24'), true)
  assert.equal(isDay('2026-02-31'), false)
  assert.equal(isDay('2026-1-5'), false)
  assert.equal(isDay(undefined), false)
})

test('istDayChanged flips exactly at IST midnight', () => {
  assert.equal(istDayChanged('2026-11-23', new Date('2026-11-23T18:29:59Z')), false)
  assert.equal(istDayChanged('2026-11-23', new Date('2026-11-23T18:30:00Z')), true)
})

test('presetRange', () => {
  const now = justAfterMidnight
  assert.deepEqual(presetRange('last24', now), { from: '2026-11-22T18:31:00.000Z' })
  assert.deepEqual(presetRange('today', now), { from: '2026-11-23T18:30:00.000Z' })
  assert.deepEqual(presetRange('yesterday', now), {
    from: '2026-11-22T18:30:00.000Z', to: '2026-11-23T18:29:59.999Z',
  })
  assert.deepEqual(presetRange('7days', now), { from: '2026-11-16T18:31:00.000Z' })
  assert.throws(() => presetRange('bogus', now))
})

test('isGroupQuiet: only inside the IST heartbeat window, only with a threshold', () => {
  const at = (ist) => new Date(Date.parse(`2026-11-24T${ist}:00+05:30`))
  const last = (ist) => new Date(Date.parse(`2026-11-24T${ist}:00+05:30`)).toISOString()
  assert.equal(isGroupQuiet(last('09:00'), 120, '08:00', '23:00', at('12:00')), true) // 3 h silent, in window
  assert.equal(isGroupQuiet(last('11:00'), 120, '08:00', '23:00', at('12:00')), false) // 1 h only
  assert.equal(isGroupQuiet(last('09:00'), 120, '08:00', '23:00', at('23:30')), false) // after the window
  assert.equal(isGroupQuiet(last('01:00'), 120, '08:00', '23:00', at('07:59')), false) // before the window
  assert.equal(isGroupQuiet(null, 120, '08:00', '23:00', at('12:00')), true) // never heard from
  assert.equal(isGroupQuiet(null, 0, '08:00', '23:00', at('12:00')), false) // no threshold
  assert.equal(isGroupQuiet(null, undefined, undefined, undefined, at('12:00')), false)
})

test('outputsNote', () => {
  assert.deepEqual(outputsNote({ outputsPending: 2, outputsFailed: 1 }), ['2 alerts waiting to send', '1 alert failed'])
  assert.deepEqual(outputsNote({ outputsPending: 1 }), ['1 alert waiting to send'])
  assert.deepEqual(outputsNote({ outputsPending: 0, outputsFailed: 0 }), [])
  assert.deepEqual(outputsNote({}), [])
  assert.deepEqual(outputsNote(undefined), [])
  assert.deepEqual(outputsNote({ outputsPending: '3', outputsFailed: -1 }), [])
})

test('quietLabel', () => {
  assert.equal(quietLabel(120), 'Quiet 2h+')
  assert.equal(quietLabel(90), 'Quiet 90m+')
})
