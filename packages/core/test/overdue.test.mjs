/**
 * Overdue is computed on the device, from stored timestamps and a caller
 * clock — the CONTRIBUTING hard rule made testable. The tests that matter
 * most are the refusals: free text and garbage dates must come back
 * 'unknown' with the label 'no date', never a confidently wrong badge.
 *
 * All dates are built with the local-time Date constructor so the suite
 * passes identically in any timezone.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  dueStatus,
  parseDueDate,
  compareDueDates,
  compareJobsByDue,
} from '../src/overdue.ts'

// A fixed "now": Tuesday 15 September 2026, 10:30 local time.
const NOW = new Date(2026, 8, 15, 10, 30).getTime()

describe('the three honest states of a real date', () => {
  test('due today, for the whole of today', () => {
    assert.deepEqual(dueStatus('2026-09-15', NOW), {
      state: 'due_today',
      label: 'due today',
    })
    // Still today at one minute to midnight.
    const lateEvening = new Date(2026, 8, 15, 23, 59).getTime()
    assert.equal(dueStatus('2026-09-15', lateEvening).state, 'due_today')
  })

  test('overdue from the first minute of the next day, with the day count', () => {
    const s = dueStatus('2026-09-12', NOW)
    assert.equal(s.state, 'overdue')
    assert.equal(s.daysLate, 3)
    assert.equal(s.label, '3 days late')
  })

  test('one day late is singular', () => {
    const s = dueStatus('2026-09-14', NOW)
    assert.equal(s.daysLate, 1)
    assert.equal(s.label, '1 day late')
  })

  test('a future date is upcoming, labelled as a day the owner can say aloud', () => {
    const s = dueStatus('2026-09-21', NOW)
    assert.equal(s.state, 'upcoming')
    assert.equal(s.daysLate, undefined, 'daysLate only exists once late')
    assert.equal(s.label, 'back Mon 21 Sep')
  })

  test('a full ISO datetime works, compared by calendar day not by hour', () => {
    // Due 15th 08:00; now is 10:30 the same day. Two and a half hours past
    // the timestamp, but still "due today" — nobody calls a client at 08:01.
    assert.equal(dueStatus('2026-09-15T08:00:00', NOW).state, 'due_today')
  })
})

describe('refusing to invent a date', () => {
  test('null and empty are unknown, labelled "no date"', () => {
    assert.deepEqual(dueStatus(null, NOW), { state: 'unknown', label: 'no date' })
    assert.deepEqual(dueStatus('', NOW), { state: 'unknown', label: 'no date' })
    assert.equal(dueStatus(undefined, NOW).state, 'unknown')
  })

  test('free text the desk actually types is unknown, not a guess', () => {
    for (const v of ['after eid', 'monday ia', 'next week', 'kal', '2 din']) {
      assert.equal(dueStatus(v, NOW).state, 'unknown', v)
    }
  })

  // Date.parse would happily read a year out of these. We must not.
  test('date-ish text is still refused unless it is a real ISO date', () => {
    for (const v of ['2026', '15/09/2026', 'Sep 21 2026', '2026-9-5']) {
      assert.equal(dueStatus(v, NOW).state, 'unknown', v)
    }
  })

  test('a calendar-impossible date is refused, not silently rolled over', () => {
    // new Date(2026, 1, 31) would quietly become March 3rd.
    assert.equal(parseDueDate('2026-02-31'), null)
    assert.equal(dueStatus('2026-02-31', NOW).state, 'unknown')
    assert.equal(parseDueDate('2026-13-01'), null)
  })

  test('surrounding whitespace is tolerated — it is not free text', () => {
    assert.equal(dueStatus(' 2026-09-15 ', NOW).state, 'due_today')
  })
})

describe('sorting jobs by when they are due back', () => {
  const job = (id, expected_back) => ({ id, expected_back })

  test('earliest — most overdue — first', () => {
    const jobs = [
      job('c', '2026-09-21'),
      job('a', '2026-09-10'),
      job('b', '2026-09-15'),
    ]
    jobs.sort(compareJobsByDue)
    assert.deepEqual(jobs.map((j) => j.id), ['a', 'b', 'c'])
  })

  test('null and unparseable dates sort last, together', () => {
    const jobs = [
      job('nodate', null),
      job('due', '2026-09-15'),
      job('freetext', 'after eid'),
      job('early', '2026-09-01'),
    ]
    jobs.sort(compareJobsByDue)
    assert.deepEqual(jobs.map((j) => j.id), ['early', 'due', 'nodate', 'freetext'])
  })

  test('dateless rows compare equal so a stable sort keeps their order', () => {
    assert.equal(compareDueDates(null, 'garbage'), 0)
    assert.equal(compareDueDates(null, null), 0)
  })

  test('the comparator agrees with itself both ways round', () => {
    assert.ok(compareDueDates('2026-09-01', null) < 0)
    assert.ok(compareDueDates(null, '2026-09-01') > 0)
    assert.equal(compareDueDates('2026-09-01', '2026-09-01'), 0)
  })
})
