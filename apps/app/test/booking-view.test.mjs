/**
 * The booking screens' pure helpers: the month grid the calendar draws,
 * the datetime-local round trip the sheets depend on, and the two stamp
 * labels. Each is a place a quiet mistake shows up as "the calendar put
 * the 1st on the wrong weekday" or "the booking landed a day early".
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  collisionSubject,
  fromLocalInput,
  monthGrid,
  monthLabel,
  monthStartOf,
  promisedStampParts,
  shiftMonth,
  toLocalInput,
} from '../src/booking-view.ts'

describe('the month grid', () => {
  test('is whole weeks, Monday first, with the days in order', () => {
    // September 2026 starts on a Tuesday: one leading pad.
    const sep = new Date(2026, 8, 1).getTime()
    const rows = monthGrid(sep)
    assert.ok(rows.every((r) => r.length === 7))
    assert.equal(rows[0][0], null)
    assert.equal(rows[0][1], sep)
    const days = rows.flat().filter((d) => d !== null)
    assert.equal(days.length, 30)
    assert.equal(new Date(days[29]).getDate(), 30)
    assert.equal(new Date(days[0]).getHours(), 0, 'day keys are local midnights')
  })

  test('a month starting on Sunday pads six, and February 2027 is 28 days', () => {
    // November 2026 begins on a Sunday.
    const nov = new Date(2026, 10, 1).getTime()
    assert.equal(monthGrid(nov)[0].filter((d) => d === null).length, 6)
    assert.equal(monthGrid(new Date(2027, 1, 1).getTime()).flat().filter((d) => d !== null).length, 28)
  })

  test('month arithmetic crosses the year both ways', () => {
    const dec = new Date(2026, 11, 1).getTime()
    assert.equal(monthLabel(dec), 'December 2026')
    assert.equal(monthLabel(shiftMonth(dec, 1)), 'January 2027')
    assert.equal(monthLabel(shiftMonth(dec, -12)), 'December 2025')
    assert.equal(monthStartOf(new Date(2026, 8, 17, 15).getTime()), new Date(2026, 8, 1).getTime())
  })
})

describe('the datetime-local round trip', () => {
  test('survives both ways in local time', () => {
    const ms = new Date(2026, 8, 17, 9, 30).getTime()
    assert.equal(toLocalInput(ms), '2026-09-17T09:30')
    assert.equal(fromLocalInput('2026-09-17T09:30'), ms)
    assert.equal(fromLocalInput('2026-09-17T09:30:00'), ms, 'a seconds suffix is tolerated')
  })

  test('refuses what a browser can hand back when the field is cleared', () => {
    assert.equal(fromLocalInput(''), null)
    assert.equal(fromLocalInput('2026-09-17'), null)
  })
})

describe('the stamps', () => {
  test('the promised stamp is the number and the day the hold begins', () => {
    assert.deepEqual(
      promisedStampParts(5, new Date(2026, 8, 17, 7).getTime()),
      { no: '#5', day: 'Thu 17' },
    )
  })

  test('a collision card is the unit for a unit, the shortfall for bulk', () => {
    assert.equal(collisionSubject({ kind: 'asset', assetCode: 'FX9-02' }), 'FX9-02')
    assert.equal(collisionSubject({ kind: 'bulk', shortBy: 3, productName: 'XLR 5m' }), '3 × XLR 5m')
  })
})
