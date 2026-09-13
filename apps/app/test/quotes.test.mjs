/**
 * Quoting on the phone, against a real SQLite and the seeded demo house —
 * the read model over the mirror, the write side's 0024 ops, and the
 * WhatsApp quote in both tables:
 *
 *   * the seed: ONE default card carrying every priced product; Sachdeva
 *     and the C-Stands unpriced; the Dec–Feb season at 1.0 and one Eid
 *     day at 1.25; dayRateFor reads the card (one rate home);
 *   * quoteFor prices a seeded booking with the golden math and the
 *     booking's own sub-hire cost nets out of the margin;
 *   * quoteForLines prices an enquiry BEFORE a booking exists, indicative
 *     by construction, and the same lines booked price the same;
 *   * the verified-client stamp: the deposit ladder over the local flags;
 *   * setRate writes the card entry and queues upsert_rate_entry; a null
 *     removes it; the card knobs queue upsert_rate_card;
 *   * setCalendarDay / clearCalendarDay move the multiplier and queue;
 *   * setLineOverride is the final rate, keeps the original, needs a
 *     reason, chains behind the booking's op, and clears;
 *   * quoteText golden, EN and UR.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, HOUR_MS, bookingDateLabel } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { dayRateFor, closeJob } from '../src/demo/read-model.ts'
import { createBooking, confirmBooking, convertBookingToJob } from '../src/demo/bookings.ts'
import { recordExpense } from '../src/demo/kharcha.ts'
import { quoteFlags, recordEntry, setPaymentLine } from '../src/demo/khata.ts'
import {
  calendarDays,
  clearCalendarDay,
  quoteFor,
  quoteForLines,
  quoteTextFor,
  quoteTextOf,
  rateCard,
  setCalendarDay,
  setLineOverride,
  setRate,
  setRateCard,
  subHireCostFor,
} from '../src/demo/quotes.ts'
import { STR_EN } from '../src/strings.ts'
import { STR_UR } from '../src/strings-ur.ts'

const ORG = 'demo-org'
let db
let seed
let n = 0
const NOW = Date.parse('2030-03-20T10:00:00+05:00')
const ids = { now: () => NOW, newId: () => `t${String(++n).padStart(3, '0')}` }
const at = (s) => Date.parse(s)
const rs = (rupees) => rupees * 100

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  n = 0
})

const ops = (op) => db.all(`select id, op, payload, depends_on from outbox where op = ? order by seq`, [op])
  .map((r) => ({ ...r, payload: JSON.parse(r.payload) }))

// The golden window: Mon 1 Apr 2030 10:00 -> Thu 11 Apr 10:00 PKT, ten days.
const APR1 = at('2030-04-01T10:00+05:00')
const APR11 = at('2030-04-11T10:00+05:00')

describe('the seeded card', () => {
  test('one default card, the documented knobs, every priced product on it', () => {
    const card = rateCard(db)
    assert.equal(card.name, 'Standard')
    assert.equal(card.isDefault, true)
    assert.deepEqual([card.weekEqualsDays, card.minBillableDays, card.weekendMask], [3, 1, []])
    const fx9 = card.rates.find((r) => r.productId === 'prod-fx9')
    assert.equal(fx9.dayRateMinor, rs(25_000))
    assert.equal(card.rates.find((r) => r.productId === 'prod-sachdeva').dayRateMinor, null)
    assert.equal(card.rates.find((r) => r.productId === 'prod-cstand').dayRateMinor, null)
  })
  test('dayRateFor reads the card — the one rate home', () => {
    assert.equal(dayRateFor(db, 'prod-fx9'), rs(25_000))
    assert.equal(dayRateFor(db, 'prod-sachdeva'), null)
    db.exec(`update rate_cards set is_default = 0`)
    assert.equal(dayRateFor(db, 'prod-fx9'), null, 'no default card, no rate')
  })
  test('the calendar: the Dec–Feb season at 1.0 and one Eid day at 1.25', () => {
    const days = calendarDays(db)
    const season = days.filter((d) => d.kind === 'season')
    assert.ok(season.length >= 90 && season.length <= 91, `a whole season, found ${season.length}`)
    assert.ok(season.every((d) => d.rateMultiplier === 1))
    const eid = days.filter((d) => d.kind === 'holiday')
    assert.equal(eid.length, 1)
    assert.equal(eid[0].name, 'Eid ul-Fitr')
    assert.equal(eid[0].rateMultiplier, 1.25)
    assert.match(eid[0].day, /-04-10$/)
  })
})

describe('quoteFor — a booking priced from the mirror', () => {
  test('GOLDEN: FX9 ×2 + XLR ×4 + an unpriced tripod over ten days = Rs 307,200 +1 unpriced', () => {
    const r = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: APR1, endMs: APR11,
      lines: [{ productId: 'prod-fx9', qty: 2 }, { productId: 'prod-xlr', qty: 4 }, { productId: 'prod-sachdeva', qty: 1 }],
      status: 'pencil',
    }, NOW, ids)
    assert.equal(r.ok, true)
    const q = quoteFor(db, r.bookingId)
    assert.equal(q.bookingNo, r.bookingNo)
    assert.equal(q.customerName, 'Hamza Saeed')
    assert.equal(q.steps.weekRule.billableDays, 6)
    assert.equal(q.lines[0].lineTotalMinor, rs(300_000))
    assert.equal(q.lines[1].lineTotalMinor, rs(7_200))
    assert.equal(q.lines[2].priced, false)
    assert.equal(q.totals.subtotalMinor, rs(307_200))
    assert.equal(q.totals.unpricedCount, 1)
    assert.equal(q.totals.indicative, true)
    assert.deepEqual(q.totals.indicativeReasons, ['unpriced_lines', 'not_confirmed'])
    assert.equal(q.steps.calendarMultiplier.multiplier, 1, 'April 1–10 crosses no seeded calendar day')
  })
  test('a confirmed, fully priced booking is not indicative; the seeded B#1 prices', () => {
    const q = quoteFor(db, 'bk-1')
    assert.equal(q.status, 'confirmed')
    assert.equal(q.totals.unpricedCount, 0)
    assert.equal(q.totals.indicative, false)
    // B#1: FX9 ×1 + Aputure ×2 over atDays(7,9) -> atDays(9,18): 2d 9h -> 3 days.
    assert.equal(q.steps.billableDays.calendarDays, 3)
    assert.equal(q.totals.subtotalMinor, 3 * (rs(25_000) + 2 * rs(12_000)))
  })
  test('the margin nets every live expense tagged to the booking, or to the job it became', () => {
    assert.equal(subHireCostFor(db, 'bk-1'), 0)
    const expId = recordExpense(db, {
      orgId: ORG, kind: 'sub_hire', amountMinor: rs(5_000), bookingId: 'bk-1',
      counterparty: 'Kamran Rentals', note: 'second body', createdAt: NOW,
    })
    assert.ok(expId)
    let q = quoteFor(db, 'bk-1')
    assert.equal(q.totals.subHireCostMinor, rs(5_000))
    assert.equal(q.totals.marginMinor, q.totals.subtotalMinor - rs(5_000))
    // Convert; a cost on the JOB counts too.
    const conv = convertBookingToJob(db, ORG, 'bk-1', NOW, ids)
    assert.equal(conv.ok, true)
    recordExpense(db, { orgId: ORG, kind: 'transport', amountMinor: rs(200), jobId: conv.jobId, createdAt: NOW })
    q = quoteFor(db, 'bk-1')
    assert.equal(q.totals.subHireCostMinor, rs(5_200))
  })
  test('a booking not on this phone has no quote', () => {
    assert.equal(quoteFor(db, 'bk-nope'), null)
  })
})

describe('quoteForLines — the enquiry priced before a booking exists', () => {
  const LINES = [
    { productId: 'prod-fx9', productName: 'Sony FX9', qty: 2 },
    { productId: 'prod-xlr', productName: 'XLR Cable 5m', qty: 4 },
  ]
  test('indicative by construction, the same numbers the booking will carry', () => {
    const q = quoteForLines(db, LINES, APR1, APR11, null)
    assert.equal(q.status, 'enquiry')
    assert.equal(q.bookingId, null)
    assert.equal(q.totals.subtotalMinor, rs(307_200))
    assert.equal(q.totals.unpricedCount, 0)
    assert.equal(q.totals.indicative, true)
    assert.deepEqual(q.totals.indicativeReasons, ['not_confirmed'])
    const b = createBooking(db, ORG, {
      customerId: 'cust-bilal', startMs: APR1, endMs: APR11,
      lines: LINES.map((l) => ({ productId: l.productId, qty: l.qty })), status: 'pencil',
    }, NOW, ids)
    assert.equal(quoteFor(db, b.bookingId).totals.subtotalMinor, q.totals.subtotalMinor)
  })
  test('with a customer, the flags ride along; without one, null', () => {
    assert.equal(quoteForLines(db, LINES, APR1, APR11, null).flags, null)
    const q = quoteForLines(db, LINES, APR1, APR11, 'cust-hamza')
    assert.equal(q.customerName, 'Hamza Saeed')
    assert.equal(q.flags.verified, true)
  })
  test('a window crossing the seeded Eid carries ×1.25 booking-wide', () => {
    const eid = calendarDays(db).find((d) => d.kind === 'holiday').day
    const start = Date.parse(`${eid}T10:00:00+05:00`) - 24 * HOUR_MS
    const q = quoteForLines(db, [LINES[0]], start, start + 3 * 24 * HOUR_MS, null)
    assert.equal(q.steps.calendarMultiplier.multiplier, 1.25)
    assert.equal(q.steps.calendarMultiplier.drivenBy.name, 'Eid ul-Fitr')
    assert.equal(q.lines[0].lineTotalMinor, Math.round(2 * 3 * rs(25_000) * 1.25))
  })
})

describe('the verified-client stamp (quoteFlags)', () => {
  test('Hamza: verified, one clean closed job, nothing owed → fast lane, lighter deposit', () => {
    const f = quoteFlags(db, 'cust-hamza')
    assert.equal(f.verified, true)
    assert.equal(f.cleanCompletedJobs, 1)
    assert.equal(f.cleanHistory, true)
    assert.equal(f.fastLane, true)
    assert.equal(f.depositHint, 'lighter')
  })
  test('Bilal: verified but owing on a closed job → standard deposit', () => {
    const f = quoteFlags(db, 'cust-bilal')
    assert.equal(f.verified, true)
    assert.equal(f.cleanHistory, false)
    assert.equal(f.fastLane, false)
    assert.equal(f.depositHint, 'standard')
  })
  test('Ayesha: a stranger with paperwork not on file → full deposit; blacklisted → refuse', () => {
    assert.equal(quoteFlags(db, 'cust-ayesha').depositHint, 'full')
    db.exec(`update customers set blacklisted = 1 where id = 'cust-ayesha'`)
    const f = quoteFlags(db, 'cust-ayesha')
    assert.equal(f.blacklisted, true)
    assert.equal(f.depositHint, 'refuse')
    assert.equal(quoteFlags(db, 'cust-nope'), null)
  })
  test('a job paid off and closed makes a stranger clean, but not verified', () => {
    // Ayesha's overdue job: pay it and close it.
    recordEntry(db, { orgId: ORG, customerId: 'cust-ayesha', kind: 'payment', amountMinor: -rs(55_000), jobId: 'job-doc', createdAt: NOW })
    db.exec(`update assets set presence = 'here', current_job_id = null where current_job_id = 'job-doc'`)
    closeJob(db, 'job-doc', NOW)
    const f = quoteFlags(db, 'cust-ayesha')
    assert.equal(f.cleanCompletedJobs, 1)
    assert.equal(f.cleanHistory, true)
    assert.equal(f.fastLane, false, 'clean history without verified paperwork is not the fast lane')
    assert.equal(f.depositHint, 'full')
  })
})

describe('the rate card writes', () => {
  test('setRate writes the entry, the quote reads it, and upsert_rate_entry is queued', () => {
    const r = setRate(db, ORG, 'prod-sachdeva', rs(1_500), NOW, ids)
    assert.equal(r.ok, true)
    assert.equal(dayRateFor(db, 'prod-sachdeva'), rs(1_500))
    const q = quoteForLines(db, [{ productId: 'prod-sachdeva', productName: 'Sachdeva Tripod', qty: 2 }], APR1, APR11, null)
    assert.equal(q.lines[0].lineTotalMinor, 2 * 6 * rs(1_500))
    const [op] = ops('upsert_rate_entry')
    assert.deepEqual(op.payload, { p_rate_card_id: 'card-standard', p_product_id: 'prod-sachdeva', p_day_rate_minor: rs(1_500) })
  })
  test('a null rate REMOVES the entry — unpriced again, never zero; 0 is a price', () => {
    setRate(db, ORG, 'prod-fx9', null, NOW, ids)
    assert.equal(dayRateFor(db, 'prod-fx9'), null)
    assert.equal(ops('upsert_rate_entry')[0].payload.p_day_rate_minor, null)
    setRate(db, ORG, 'prod-xlr', 0, NOW, ids)
    assert.equal(dayRateFor(db, 'prod-xlr'), 0)
    const q = quoteForLines(db, [{ productId: 'prod-xlr', productName: 'XLR', qty: 4 }], APR1, APR11, null)
    assert.equal(q.lines[0].priced, true)
    assert.equal(q.lines[0].lineTotalMinor, 0)
  })
  test('a negative rate and an unknown product are refused, and queue nothing', () => {
    assert.deepEqual(setRate(db, ORG, 'prod-fx9', -1, NOW, ids), { ok: false, reason: 'negative' })
    assert.deepEqual(setRate(db, ORG, 'prod-nope', 100, NOW, ids), { ok: false, reason: 'unknown_product' })
    assert.equal(ops('upsert_rate_entry').length, 0)
  })
  test('setRateCard edits the knobs, the next quote reads them, and upsert_rate_card is queued', () => {
    const r = setRateCard(db, ORG, { weekendMask: [6, 7], minBillableDays: 2 }, NOW, ids)
    assert.equal(r.ok, true)
    const card = rateCard(db)
    assert.deepEqual(card.weekendMask, [6, 7])
    assert.equal(card.minBillableDays, 2)
    assert.equal(card.weekEqualsDays, 3, 'an omitted knob keeps its value')
    const q = quoteForLines(db, [{ productId: 'prod-fx9', productName: 'FX9', qty: 1 }], APR1, APR11, null)
    assert.deepEqual(q.steps.billableDays.droppedDates, ['2030-04-06', '2030-04-07'])
    assert.equal(q.steps.weekRule.billableDays, 4)
    const [op] = ops('upsert_rate_card')
    assert.equal(op.payload.p_id, 'card-standard')
    assert.deepEqual(op.payload.p_weekend_mask, [6, 7])
    assert.equal(op.payload.p_min_billable_days, 2)
  })
  test('an entry queued after a card edit depends on it', () => {
    setRateCard(db, ORG, { weekEqualsDays: 4 }, NOW, ids)
    setRate(db, ORG, 'prod-fx9', rs(26_000), NOW, ids)
    assert.equal(ops('upsert_rate_entry')[0].depends_on, ops('upsert_rate_card')[0].id)
  })
  test('with no card at all, setRateCard makes the first one, default by itself', () => {
    db.exec(`delete from rate_cards`)
    db.exec(`delete from rate_card_entries`)
    assert.equal(rateCard(db), null)
    const r = setRateCard(db, ORG, { name: 'House card' }, NOW, ids)
    assert.equal(r.ok, true)
    assert.equal(rateCard(db).isDefault, true)
    assert.equal(ops('upsert_rate_card')[0].payload.p_id, null, 'a create, not an edit')
  })
  test('the knobs are checked: a zero week, a zero minimum, a bad mask', () => {
    assert.deepEqual(setRateCard(db, ORG, { weekEqualsDays: 0 }, NOW, ids), { ok: false, reason: 'bad_week' })
    assert.deepEqual(setRateCard(db, ORG, { minBillableDays: 0 }, NOW, ids), { ok: false, reason: 'bad_min_days' })
    assert.deepEqual(setRateCard(db, ORG, { weekendMask: [8] }, NOW, ids), { ok: false, reason: 'bad_mask' })
  })
})

describe('the calendar writes', () => {
  test('setCalendarDay adds a holiday the next quote applies, and queues set_calendar_day', () => {
    const r = setCalendarDay(db, ORG, '2030-04-05', 'holiday', 'Test holiday', 1.5, NOW, ids)
    assert.equal(r.ok, true)
    const q = quoteForLines(db, [{ productId: 'prod-fx9', productName: 'FX9', qty: 1 }], APR1, APR11, null)
    assert.equal(q.steps.calendarMultiplier.multiplier, 1.5)
    assert.equal(q.lines[0].lineTotalMinor, Math.round(6 * rs(25_000) * 1.5))
    // client_day_id rides beside the args (W9): the pipe maps the server's
    // row id onto the phone's `cal-…` one when the reply comes back.
    const { client_day_id, ...args } = ops('set_calendar_day')[0].payload
    assert.match(client_day_id, /^cal-/)
    assert.deepEqual(args, { p_day: '2030-04-05', p_kind: 'holiday', p_name: 'Test holiday', p_rate_multiplier: 1.5 })
  })
  test('the same (day, kind) is one row, updated; clearCalendarDay removes it and queues', () => {
    setCalendarDay(db, ORG, '2030-04-05', 'holiday', 'First', 1.5, NOW, ids)
    setCalendarDay(db, ORG, '2030-04-05', 'holiday', 'Second', 1.1, NOW, ids)
    const rows = calendarDays(db).filter((d) => d.day === '2030-04-05')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'Second')
    assert.equal(clearCalendarDay(db, '2030-04-05', 'holiday', NOW, ids), true)
    assert.equal(clearCalendarDay(db, '2030-04-05', 'holiday', NOW, ids), false)
    assert.equal(calendarDays(db).some((d) => d.day === '2030-04-05'), false)
    assert.deepEqual(ops('clear_calendar_day')[0].payload, { p_day: '2030-04-05', p_kind: 'holiday' })
  })
  test('a bad multiplier, a blank name, a malformed date are refused', () => {
    assert.deepEqual(setCalendarDay(db, ORG, '2030-04-05', 'holiday', 'X', 0, NOW, ids), { ok: false, reason: 'bad_multiplier' })
    assert.deepEqual(setCalendarDay(db, ORG, '2030-04-05', 'holiday', '  ', 1, NOW, ids), { ok: false, reason: 'bad_name' })
    assert.deepEqual(setCalendarDay(db, ORG, '5 April', 'holiday', 'X', 1, NOW, ids), { ok: false, reason: 'bad_day' })
  })
})

describe('the override (0024 D8)', () => {
  let bookingId
  let lineId
  beforeEach(() => {
    const r = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: APR1, endMs: at('2030-04-15T10:00+05:00'),
      lines: [{ productId: 'prod-fx9', qty: 1 }], status: 'pencil',
    }, NOW, ids)
    bookingId = r.bookingId
    lineId = db.get(`select id from booking_lines where booking_id = ?`, [bookingId]).id
  })
  test('the override is the final rate, keeps the original, and 6 days × Rs 20,000 = Rs 120,000', () => {
    const r = setLineOverride(db, lineId, rs(20_000), 'Zindagi: long-standing client, Rs 20,000 agreed', NOW, ids)
    assert.equal(r.ok, true)
    assert.equal(r.originalRateMinor, rs(25_000))
    const q = quoteFor(db, bookingId)
    assert.equal(q.lines[0].lineTotalMinor, rs(120_000))
    assert.equal(q.lines[0].override.originalRateMinor, rs(25_000))
    assert.equal(q.lines[0].override.reason, 'Zindagi: long-standing client, Rs 20,000 agreed')
    assert.equal(q.totals.overriddenCount, 1)
  })
  test('needs a reason, refuses a negative, chains behind the booking\'s create op', () => {
    assert.deepEqual(setLineOverride(db, lineId, rs(20_000), '  ', NOW, ids), { ok: false, reason: 'needs_reason' })
    assert.deepEqual(setLineOverride(db, lineId, -5, 'typo', NOW, ids), { ok: false, reason: 'negative' })
    assert.deepEqual(setLineOverride(db, 'bl-nope', rs(1), 'x', NOW, ids), { ok: false, reason: 'not_found' })
    setLineOverride(db, lineId, rs(20_000), 'agreed', NOW, ids)
    const [op] = ops('set_line_rate_override')
    assert.deepEqual(op.payload, { client_booking_id: bookingId, p_line_id: lineId, p_rate_minor: rs(20_000), p_reason: 'agreed' })
    assert.equal(op.depends_on, ops('create_booking').at(-1).id)
  })
  test('the multiplier does not apply on top; a null clears back to the card', () => {
    setCalendarDay(db, ORG, '2030-04-03', 'holiday', 'Eid', 1.25, NOW, ids)
    setLineOverride(db, lineId, rs(20_000), 'Eid goodwill', NOW, ids)
    let q = quoteFor(db, bookingId)
    assert.equal(q.lines[0].multiplierApplied, false)
    assert.equal(q.lines[0].lineTotalMinor, rs(120_000))
    const cleared = setLineOverride(db, lineId, null, 'client withdrew the ask', NOW, ids)
    assert.equal(cleared.ok, true)
    q = quoteFor(db, bookingId)
    assert.equal(q.lines[0].override, null)
    assert.equal(q.lines[0].lineTotalMinor, Math.round(6 * rs(25_000) * 1.25))
    assert.equal(ops('set_line_rate_override').at(-1).payload.p_rate_minor, null)
  })
  test('confirming a booking with an unpriced line is allowed — counted, not blocked', () => {
    const r = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: APR1, endMs: APR11,
      lines: [{ productId: 'prod-sachdeva', qty: 1 }], status: 'pencil',
    }, NOW, ids)
    assert.equal(confirmBooking(db, ORG, r.bookingId, {}, NOW, ids).ok, true)
    const q = quoteFor(db, r.bookingId)
    assert.equal(q.status, 'confirmed')
    assert.equal(q.totals.unpricedCount, 1)
    assert.deepEqual(q.totals.indicativeReasons, ['unpriced_lines'])
  })
})

describe('the WhatsApp quote — golden, both tables', () => {
  let bookingId
  beforeEach(() => {
    setPaymentLine(db, 'JazzCash: 0300 1234567')
    const r = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: APR1, endMs: APR11,
      lines: [{ productId: 'prod-fx9', qty: 2 }, { productId: 'prod-xlr', qty: 4 }, { productId: 'prod-sachdeva', qty: 1 }],
      status: 'pencil',
    }, NOW, ids)
    bookingId = r.bookingId
  })
  test('English', () => {
    const text = quoteTextFor(db, STR_EN, seed.houseName, bookingId)
    assert.equal(text, [
      'Ravi Light & Grip — quote',
      'For: Hamza Saeed',
      `From ${bookingDateLabel(APR1)} to ${bookingDateLabel(APR11)}`,
      '6 billable days (10 on the calendar)',
      '',
      'Sony FX9 × 2 · 6 days · Rs 25,000/day = Rs 300,000',
      'XLR Cable 5m × 4 · 6 days · Rs 300/day = Rs 7,200',
      'Sachdeva Tripod × 1 · unpriced',
      '',
      'Total: Rs 307,200',
      'Indicative — 1 item unpriced, final quote from the desk.',
      'Deposit: half deposit',
      'Pay: JazzCash: 0300 1234567',
      '',
      'Reply here to confirm or change anything. Thank you.',
    ].join('\n'))
  })
  test('Roman Urdu', () => {
    const text = quoteTextFor(db, STR_UR, seed.houseName, bookingId)
    assert.equal(text, [
      'Ravi Light & Grip — quote',
      'Naam: Hamza Saeed',
      `${bookingDateLabel(APR1)} se ${bookingDateLabel(APR11)} tak`,
      '6 bill wale din (calendar pe 10)',
      '',
      'Sony FX9 × 2 · 6 din · Rs 25,000/din = Rs 300,000',
      'XLR Cable 5m × 4 · 6 din · Rs 300/din = Rs 7,200',
      'Sachdeva Tripod × 1 · bina rate',
      '',
      'Total: Rs 307,200',
      'Andaazan — 1 cheez bina rate, final quote desk se.',
      'Deposit: aadha deposit',
      'Payment: JazzCash: 0300 1234567',
      '',
      'Pakka karne ya kuch badalne ke liye yahin reply karein. Shukriya.',
    ].join('\n'))
  })
  test('an enquiry quote with a holiday inside carries the note; no client, no deposit line', () => {
    setCalendarDay(db, ORG, '2030-04-05', 'holiday', 'Eid ul-Fitr', 1.25, NOW, ids)
    const q = quoteForLines(db, [{ productId: 'prod-fx9', productName: 'Sony FX9', qty: 1 }], APR1, APR11, null)
    const text = quoteTextOf(db, STR_EN, seed.houseName, q)
    assert.match(text, /Eid ul-Fitr on 2030-04-05: ×1\.25 on the whole booking/)
    assert.match(text, /Sony FX9 × 1 · 6 days · Rs 25,000\/day = Rs 187,500/)
    assert.match(text, /Indicative — not confirmed yet\./)
    assert.doesNotMatch(text, /Deposit/)
    assert.doesNotMatch(text, /For:/)
    assert.equal(quoteTextFor(db, STR_EN, seed.houseName, 'bk-nope'), null)
  })
})
