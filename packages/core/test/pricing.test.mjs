/**
 * The pricing pipeline on the phone, pinned to the GOLDEN FIXTURES of
 * db/tests/0024_rate_cards_test.sql — the same bookings, the same card,
 * the same numbers, so the desk's offline quote and the server's trace
 * can never disagree:
 *
 *   * the 3-day week: 10 days = 1 week (3) + 3 = 6 billable; 14 days = 6;
 *     8 days = 3 + 1 = 4; a 6-day remainder is capped at 3;
 *   * a day is 24h from pickup: back one minute late bills the next day;
 *   * the weekend mask drops named dates; a weekend-only job still bills
 *     min_billable_days; min_billable_days floors a 1-day job to 2;
 *   * a 3-day job crossing a 1.25x Eid day bills x1.25, booking-wide, the
 *     trace naming the driving day; the max wins over a 1.0 season;
 *   * an unpriced line is COUNTED and null, never zero; a 0 rate IS a price;
 *   * the override replaces the card rate, reports the original, ignores
 *     the multiplier;
 *   * margin nets the sub-hire cost; indicative flips false only when
 *     confirmed AND fully priced; no card at all says so.
 *
 * Instants are written with the +05 offset the fixtures use, and the
 * dates are read in Asia/Karachi — the org's zone — so 'first_day' is
 * the fixture's date whatever machine runs this.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  priceQuote, quoteText, localDate, addDays, isoWeekday, formatRupees, bookingDateLabel,
} from '@papa/core'

const FX9 = 'prod-fx9'
const XLR = 'prod-xlr'
const CASE = 'prod-case'
const at = (s) => Date.parse(s)

const CARD_A = { id: 'card-a', name: 'Standard', isDefault: true, weekEqualsDays: 3, minBillableDays: 1, weekendMask: [] }
const CARD_B = { ...CARD_A, id: 'card-b', name: 'Weekend free', isDefault: false, weekendMask: [6, 7] }
const CARD_C = { ...CARD_A, id: 'card-c', name: 'Two-day minimum', isDefault: false, minBillableDays: 2 }
const ENTRIES = new Map([[FX9, 2_500_000], [XLR, 30_000]])

const fx9 = (qty = 1, extra = {}) => ({ productId: FX9, productName: 'Sony FX9', qty, ...extra })

function price(startIso, endIso, lines, extra = {}) {
  return priceQuote({
    customerStartMs: at(startIso), customerEndMs: at(endIso),
    card: CARD_A, entries: ENTRIES, calendarDays: [], lines,
    subHireCostMinor: 0, status: 'pencil',
    ...extra,
  })
}

// B10: ten days, Mon Apr 1 -> Thu Apr 11 (10:00 PKT both ends).
// FX9 x2 (priced), XLR x4 (priced), CASE-1 (unpriced).
const B10 = () => price('2030-04-01T10:00+05:00', '2030-04-11T10:00+05:00', [
  fx9(2), { productId: XLR, productName: 'XLR Cable 5m', qty: 4 },
  { productId: CASE, productName: 'Peli 1650', qty: 1, assetId: 'a-case', assetCode: 'CASE-1' },
])

describe('dates in the org timezone', () => {
  test('an instant is dated where the org is, not where the phone is', () => {
    assert.equal(localDate(at('2030-04-01T10:00+05:00'), 'Asia/Karachi'), '2030-04-01')
    // 02:00 PKT on the 2nd is still the 1st in UTC — the org's date wins.
    assert.equal(localDate(at('2030-04-02T02:00+05:00'), 'Asia/Karachi'), '2030-04-02')
    assert.equal(localDate(at('2030-04-02T02:00+05:00'), 'UTC'), '2030-04-01')
  })
  test('calendar arithmetic and ISO weekdays', () => {
    assert.equal(addDays('2030-04-01', 10), '2030-04-11')
    assert.equal(addDays('2030-12-30', 3), '2031-01-02')
    assert.equal(isoWeekday('2030-04-01'), 1, 'Apr 1 2030 is a Monday')
    assert.equal(isoWeekday('2030-04-06'), 6)
    assert.equal(isoWeekday('2030-04-07'), 7)
  })
})

describe('GOLDEN: steps 1 and 2 (D2, D4)', () => {
  test('10 days on a 3-day week = 3 + 3 = 6 billable days', () => {
    const q = B10()
    assert.equal(q.steps.billableDays.calendarDays, 10)
    assert.equal(q.steps.billableDays.firstDay, '2030-04-01')
    assert.equal(q.steps.weekRule.weeks, 1)
    assert.equal(q.steps.weekRule.remainderDays, 3)
    assert.equal(q.steps.weekRule.billableDays, 6)
  })
  test('14 days = two weeks = 6', () => {
    assert.equal(price('2030-04-01T10:00+05:00', '2030-04-15T10:00+05:00', [fx9()]).steps.weekRule.billableDays, 6)
  })
  test('8 days = 3 + 1 = 4', () => {
    assert.equal(price('2030-04-01T10:00+05:00', '2030-04-09T10:00+05:00', [fx9()]).steps.weekRule.billableDays, 4)
  })
  test('a 6-day remainder is capped at the week rate (3) — never more than a week', () => {
    const q = price('2030-04-01T10:00+05:00', '2030-04-07T10:00+05:00', [fx9()])
    assert.equal(q.steps.weekRule.remainderBilled, 3)
    assert.equal(q.steps.weekRule.billableDays, 3)
  })
  test('out at 10:00, back at 10:00 the next day is ONE day; back a minute late bills two', () => {
    assert.equal(price('2030-04-01T10:00+05:00', '2030-04-02T10:00+05:00', [fx9()]).steps.billableDays.calendarDays, 1)
    assert.equal(price('2030-04-01T10:00+05:00', '2030-04-02T10:01+05:00', [fx9()]).steps.billableDays.calendarDays, 2)
  })
  test('min_billable_days=2 floors a one-day job to two', () => {
    const q = price('2030-04-01T10:00+05:00', '2030-04-02T10:00+05:00', [fx9()], { card: CARD_C })
    assert.equal(q.steps.billableDays.minApplied, true)
    assert.equal(q.steps.weekRule.billableDays, 2)
  })
})

describe('the weekend mask (D3)', () => {
  test('the golden card (empty mask) drops nothing', () => {
    assert.equal(B10().steps.billableDays.weekendDaysDropped, 0)
  })
  test('the weekend-free card drops Sat 6 and Sun 7 from the ten-day job, and names them', () => {
    const q = price('2030-04-01T10:00+05:00', '2030-04-11T10:00+05:00', [fx9()], { card: CARD_B })
    assert.equal(q.steps.billableDays.weekendDaysDropped, 2)
    assert.deepEqual(q.steps.billableDays.droppedDates, ['2030-04-06', '2030-04-07'])
    assert.equal(q.steps.weekRule.billableDays, 4, '8 counted days -> 1 week + 1 = 4 billable')
  })
  test('a Sat->Mon job on the weekend-free card hits the minimum and still bills one day', () => {
    const q = price('2030-04-06T10:00+05:00', '2030-04-08T10:00+05:00', [fx9()], { card: CARD_B })
    assert.equal(q.steps.billableDays.minApplied, true)
    assert.equal(q.steps.weekRule.billableDays, 1)
  })
})

describe('GOLDEN: card rates, unpriced counted not zeroed (D5)', () => {
  test('FX9 x2 x 6 days x Rs 25,000 = Rs 300,000; XLR x4 x 6 x Rs 300 = Rs 7,200', () => {
    const q = B10()
    assert.equal(q.lines[0].lineTotalMinor, 30_000_000)
    assert.equal(q.lines[1].lineTotalMinor, 720_000)
  })
  test('the Peli case has no entry: priced=false, total NULL, counted; subtotal sums the priced only', () => {
    const q = B10()
    assert.equal(q.lines[2].priced, false)
    assert.equal(q.lines[2].lineTotalMinor, null)
    assert.equal(q.lines[2].assetCode, 'CASE-1')
    assert.equal(q.totals.subtotalMinor, 30_720_000)
    assert.equal(q.totals.unpricedCount, 1)
    assert.deepEqual(q.totals.indicativeReasons, ['unpriced_lines', 'not_confirmed'])
    assert.equal(q.steps.cardRates.unpricedLines, 1)
  })
  test('an explicit Rs 0 entry prices the case at zero (an included item)', () => {
    const entries = new Map([...ENTRIES, [CASE, 0]])
    const q = price('2030-04-01T10:00+05:00', '2030-04-11T10:00+05:00', [
      { productId: CASE, productName: 'Peli 1650', qty: 1 },
    ], { entries })
    assert.equal(q.lines[0].priced, true)
    assert.equal(q.lines[0].lineTotalMinor, 0)
    assert.equal(q.totals.unpricedCount, 0)
  })
})

const EID = { day: '2030-05-07', kind: 'holiday', name: 'Eid ul-Fitr', rateMultiplier: 1.25 }
const EID2 = { day: '2030-05-08', kind: 'holiday', name: 'Eid holiday 2', rateMultiplier: 1.1 }
const season = (day) => ({ day, kind: 'season', name: 'Wedding season', rateMultiplier: 1 })
const BE = (extra = {}) => price('2030-05-06T10:00+05:00', '2030-05-09T10:00+05:00', [fx9()], { calendarDays: [EID], ...extra })

describe('GOLDEN: the calendar multiplier (D6, D7)', () => {
  test('a 3-day job crossing Eid carries x1.25, the trace names the day: 3 x Rs 25,000 x 1.25 = Rs 93,750', () => {
    const q = BE()
    assert.equal(q.steps.calendarMultiplier.multiplier, 1.25)
    assert.equal(q.steps.calendarMultiplier.drivenBy.name, 'Eid ul-Fitr')
    assert.equal(q.lines[0].lineTotalMinor, 9_375_000)
  })
  test('a booking with no calendar day inside it is x1.0 with nothing driving it', () => {
    const q = B10()
    assert.equal(q.steps.calendarMultiplier.multiplier, 1)
    assert.equal(q.steps.calendarMultiplier.drivenBy, null)
  })
  test('two calendar days inside the period: the higher multiplier wins', () => {
    assert.equal(BE({ calendarDays: [EID2, EID] }).steps.calendarMultiplier.multiplier, 1.25)
  })
  test('a December job is shaded, not surcharged, but the trace still says it is in season', () => {
    const q = price('2030-12-10T10:00+05:00', '2030-12-12T10:00+05:00', [fx9()], {
      calendarDays: [season('2030-12-09'), season('2030-12-10'), season('2030-12-11'), season('2030-12-12')],
    })
    assert.equal(q.steps.calendarMultiplier.multiplier, 1)
    assert.equal(q.steps.calendarMultiplier.drivenBy.kind, 'season')
    assert.equal(q.steps.calendarMultiplier.drivenBy.day, '2030-12-10', 'the first day inside the span drives a tie')
  })
  test('a calendar day on the return date is OUTSIDE a job that ends that morning', () => {
    // Apr 1 10:00 -> Apr 4 10:00 is three days (1, 2, 3); a holiday on the 4th does not touch it.
    const q = price('2030-04-01T10:00+05:00', '2030-04-04T10:00+05:00', [fx9()], {
      calendarDays: [{ ...EID, day: '2030-04-04' }],
    })
    assert.equal(q.steps.calendarMultiplier.multiplier, 1)
  })
})

describe('GOLDEN: the override (D8)', () => {
  test('6 days x Rs 20,000 = Rs 120,000 — the override replaces the card rate and reports the original', () => {
    const q = price('2030-04-01T10:00+05:00', '2030-04-15T10:00+05:00', [
      fx9(1, { lineId: 'l14', overrideRateMinor: 2_000_000, originalRateMinor: 2_500_000, overrideReason: 'Zindagi: long-standing client, Rs 20,000 agreed' }),
    ])
    assert.equal(q.lines[0].lineTotalMinor, 12_000_000)
    assert.equal(q.lines[0].override.originalRateMinor, 2_500_000)
    assert.equal(q.lines[0].override.reason, 'Zindagi: long-standing client, Rs 20,000 agreed')
    assert.equal(q.steps.overrides.overriddenLines, 1)
    assert.equal(q.totals.overriddenCount, 1)
  })
  test('the calendar multiplier does not apply on top of an override: 3 x Rs 20,000 = Rs 60,000, not x1.25', () => {
    const q = BE({ lines: [fx9(1, { overrideRateMinor: 2_000_000, originalRateMinor: 2_500_000, overrideReason: 'Eid goodwill' })] })
    assert.equal(q.lines[0].multiplierApplied, false)
    assert.equal(q.lines[0].multiplier, 1)
    assert.equal(q.lines[0].lineTotalMinor, 6_000_000)
    assert.equal(q.steps.calendarMultiplier.multiplier, 1.25, 'the booking-wide multiplier is still reported')
  })
  test('an override prices a line the card cannot — still the owner\'s number', () => {
    const q = price('2030-04-01T10:00+05:00', '2030-04-02T10:00+05:00', [
      { productId: CASE, productName: 'Peli 1650', qty: 1, overrideRateMinor: 50_000, overrideReason: 'thrown in' },
    ])
    assert.equal(q.lines[0].priced, true)
    assert.equal(q.lines[0].cardRateMinor, null)
    assert.equal(q.lines[0].lineTotalMinor, 50_000)
  })
})

describe('margin and the indicative flag (D5, D9)', () => {
  test('margin = subtotal (Rs 120,000) - cost (Rs 5,000)', () => {
    const q = price('2030-04-01T10:00+05:00', '2030-04-15T10:00+05:00', [
      fx9(1, { overrideRateMinor: 2_000_000, overrideReason: 'agreed' }),
    ], { subHireCostMinor: 500_000 })
    assert.equal(q.totals.subHireCostMinor, 500_000)
    assert.equal(q.totals.marginMinor, 11_500_000)
  })
  test('confirmed AND fully priced: not indicative', () => {
    const q = price('2030-04-01T10:00+05:00', '2030-04-15T10:00+05:00', [fx9()], { status: 'confirmed' })
    assert.equal(q.totals.indicative, false)
    assert.deepEqual(q.totals.indicativeReasons, [])
  })
  test('an org with no rate card gets an all-unpriced trace that says why', () => {
    const q = price('2030-04-01T10:00+05:00', '2030-04-04T10:00+05:00', [fx9()], { card: null, entries: new Map() })
    assert.equal(q.lines[0].priced, false)
    assert.deepEqual(q.totals.indicativeReasons, ['unpriced_lines', 'not_confirmed', 'no_rate_card'])
    assert.equal(q.steps.weekRule.weekEqualsDays, 3, 'the day math still renders on the documented defaults')
    assert.deepEqual(q.steps.billableDays.weekendMask, [])
  })
})

describe('the WhatsApp quote text', () => {
  const STR = {
    title: (h) => `${h} — quote`,
    forCustomer: (n) => `For: ${n}`,
    window: (a, b) => `From ${a} to ${b}`,
    days: (b, c) => `${b} billable day${b === 1 ? '' : 's'} (${c} on the calendar)`,
    line: (name, qty, days, rate, total) => `${name} × ${qty} · ${days} days · ${rate}/day = ${total}`,
    lineUnpriced: (name, qty) => `${name} × ${qty} · unpriced`,
    multiplierNote: (name, day, m) => `${name} on ${day}: ${m} on the whole booking`,
    total: (r) => `Total: ${r}`,
    indicativeUnpriced: (n) => `Indicative — ${n} item${n === 1 ? '' : 's'} unpriced, final quote from the desk.`,
    indicativeNotConfirmed: 'Indicative — not yet confirmed.',
    depositLine: (h) => `Deposit: ${h}`,
    payment: (l) => `Pay: ${l}`,
    footer: 'Reply here to confirm.',
  }
  const text = (quote, extra = {}) => quoteText({
    quote, houseName: 'Ravi Light & Grip', customerName: 'Zindagi Films',
    fromLabel: bookingDateLabel(quote.customerStartMs), untilLabel: bookingDateLabel(quote.customerEndMs),
    formatRupees, depositHint: null, paymentLine: null, ...extra,
  }, STR)

  test('every line, the unpriced named, the honesty line before the total is trusted', () => {
    const lines = text(B10(), { depositHint: 'lighter', paymentLine: 'JazzCash 0300 1234567' }).split('\n')
    assert.equal(lines[0], 'Ravi Light & Grip — quote')
    assert.equal(lines[1], 'For: Zindagi Films')
    assert.match(lines[2], /^From .* to .*$/)
    assert.equal(lines[3], '6 billable days (10 on the calendar)')
    assert.equal(lines[5], 'Sony FX9 × 2 · 6 days · Rs 25,000/day = Rs 300,000')
    assert.equal(lines[6], 'XLR Cable 5m × 4 · 6 days · Rs 300/day = Rs 7,200')
    assert.equal(lines[7], 'Peli 1650 CASE-1 × 1 · unpriced')
    assert.equal(lines[9], 'Total: Rs 307,200')
    assert.equal(lines[10], 'Indicative — 1 item unpriced, final quote from the desk.')
    assert.equal(lines[11], 'Deposit: lighter')
    assert.equal(lines[12], 'Pay: JazzCash 0300 1234567')
    assert.equal(lines[14], 'Reply here to confirm.')
  })
  test('the season/holiday note appears only when the multiplier is above 1', () => {
    assert.match(text(BE()), /Eid ul-Fitr on 2030-05-07: ×1\.25 on the whole booking/)
    assert.doesNotMatch(text(B10()), /on the whole booking/)
    const shaded = price('2030-12-10T10:00+05:00', '2030-12-12T10:00+05:00', [fx9()], { calendarDays: [season('2030-12-10')] })
    assert.doesNotMatch(text(shaded), /Wedding season/)
  })
  test('a fully priced, unconfirmed quote says it is not yet confirmed; a confirmed one says nothing', () => {
    const q = price('2030-04-01T10:00+05:00', '2030-04-15T10:00+05:00', [fx9()])
    assert.match(text(q), /Indicative — not yet confirmed\./)
    assert.doesNotMatch(text({ ...q, totals: { ...q.totals, indicative: false } }), /Indicative/)
  })
})
