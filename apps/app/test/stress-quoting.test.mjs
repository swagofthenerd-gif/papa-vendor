/**
 * Adversarial stress: the pricing pipeline under two thousand random
 * quotes.
 *
 * priceQuote (packages/core/src/pricing.ts) is pure — period, card,
 * calendar and lines in, a traced quote out — so it can be hammered with
 * seeded-random inputs and every promise the six named steps make can be
 * re-derived beside the answer:
 *
 *  - the subtotal is exactly the sum of the priced line totals, and the
 *    priced/unpriced counts partition the lines
 *  - an unpriced line never contributes: pricing the same quote without
 *    its unpriced lines gives the same subtotal (counted, never zero)
 *  - a calendar multiplier ≥ 1 never lowers a quote: the same lines with
 *    no calendar price at most the same
 *  - an override line ignores the multiplier — its total is qty × days ×
 *    the override, whatever the calendar says (ASSUMPTION #override-final)
 *  - billable days never exceed the calendar days, except through the
 *    card's own minimum (min_billable_days), and never exceed the counted
 *    days; every quote bills at least one day
 *  - indicative ⇔ an unpriced line or not confirmed; margin = subtotal −
 *    sub-hire cost; the same input twice gives the same quote
 *
 * Seeded mulberry32, fixed 2031 dates, Asia/Karachi. Reruns are identical.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { DAY_MS, HOUR_MS, priceQuote, localDate, addDays, DEFAULT_TIMEZONE } from '@papa/core'

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)]
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

const T0 = Date.parse('2031-01-06T09:00:00+05:00')
const SAMPLES = 2000
const PRODUCTS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']
const STATUSES = ['draft', 'pencil', 'confirmed', 'cancelled', 'enquiry']

/** One random quote input — card, calendar, lines — with a few knobs
 *  deliberately pushed to their edges (no card, empty mask, a minimum
 *  above the calendar days, an override on an unpriced product). */
function sample(r) {
  const hasCard = r() < 0.9
  const mask = []
  for (let d = 1; d <= 7; d++) if (r() < 0.2) mask.push(d)
  const card = hasCard
    ? {
        id: 'card', name: 'Stress', isDefault: true,
        weekEqualsDays: int(r, 1, 7), minBillableDays: int(r, 1, 3), weekendMask: mask,
      }
    : null
  const entries = new Map()
  for (const p of PRODUCTS) if (r() < 0.75) entries.set(p, int(r, 3, 400) * 100_00)

  const customerStartMs = T0 + int(r, 0, 300 * DAY_MS)
  const customerEndMs = customerStartMs + int(r, HOUR_MS, 20 * DAY_MS)
  const firstDay = localDate(customerStartMs, DEFAULT_TIMEZONE)

  // Calendar rows inside and around the window; multipliers ≥ 1 only —
  // a "discount season" is not a thing the pipeline promises anything about.
  const calendarDays = []
  for (let i = int(r, 0, 4); i > 0; i--) {
    calendarDays.push({
      day: addDays(firstDay, int(r, -3, 22)),
      kind: r() < 0.5 ? 'holiday' : 'season',
      name: `Row ${i}`,
      rateMultiplier: pick(r, [1, 1, 1.1, 1.25, 1.5, 2]),
    })
  }

  const lines = []
  for (let l = int(r, 1, 6); l > 0; l--) {
    const productId = r() < 0.05 ? null : pick(r, PRODUCTS)
    const override = r() < 0.2
    lines.push({
      lineId: `bl-${l}`, productId, productName: productId ?? 'Unit', qty: int(r, 1, 5),
      overrideRateMinor: override ? int(r, 1, 300) * 100_00 : null,
      originalRateMinor: override && productId ? (entries.get(productId) ?? null) : null,
      overrideReason: override ? 'stress' : null,
    })
  }

  return {
    customerStartMs, customerEndMs, timezone: DEFAULT_TIMEZONE, card, entries, calendarDays, lines,
    subHireCostMinor: r() < 0.3 ? int(r, 0, 500) * 100_00 : 0,
    status: pick(r, STATUSES),
  }
}

describe('the pricing pipeline under random quotes', () => {
  test(`${SAMPLES} random (period, card, calendar, lines): the six steps keep every promise`, () => {
    const r = rng(20240)
    const seen = { unpriced: 0, overrides: 0, multipliers: 0, noCard: 0, minApplied: 0, weekendDropped: 0 }

    for (let i = 0; i < SAMPLES; i++) {
      const input = sample(r)
      const q = priceQuote(input)
      const label = `sample ${i}`

      // ---- totals are sums, and the counts partition the lines ------------
      const priced = q.lines.filter((l) => l.priced)
      const unpriced = q.lines.filter((l) => !l.priced)
      assert.equal(priced.length + unpriced.length, q.lines.length)
      assert.equal(q.totals.pricedCount, priced.length, label)
      assert.equal(q.totals.unpricedCount, unpriced.length, label)
      assert.equal(q.totals.subtotalMinor, priced.reduce((n, l) => n + l.lineTotalMinor, 0), `${label}: subtotal is not the sum`)
      assert.ok(unpriced.every((l) => l.lineTotalMinor === null && l.effectiveRateMinor === null), `${label}: an unpriced line carries a number`)
      assert.equal(q.totals.marginMinor, q.totals.subtotalMinor - input.subHireCostMinor, label)
      assert.equal(q.totals.overriddenCount, q.lines.filter((l) => l.override !== null).length, label)
      assert.deepEqual(q.steps.totals, { step: 6, name: 'totals', ...q.totals }, label)

      // ---- unpriced never contributes ---------------------------------------
      if (unpriced.length > 0) {
        seen.unpriced++
        const without = priceQuote({ ...input, lines: input.lines.filter((_, k) => q.lines[k].priced) })
        assert.equal(without.totals.subtotalMinor, q.totals.subtotalMinor, `${label}: an unpriced line moved the total`)
        assert.equal(without.totals.unpricedCount, 0)
      }

      // ---- billable days ---------------------------------------------------------
      const b = q.steps.billableDays
      const w = q.steps.weekRule
      assert.equal(b.calendarDays, Math.max(1, Math.ceil((input.customerEndMs - input.customerStartMs) / DAY_MS)), label)
      assert.ok(w.billableDays >= 1, `${label}: a quote billed nothing`)
      assert.ok(w.billableDays <= b.countedDays, `${label}: billed more days than counted`)
      if (b.minApplied) {
        seen.minApplied++
        assert.equal(b.countedDays, b.minBillableDays, label)
        assert.ok(b.calendarDays - b.weekendDaysDropped < b.minBillableDays, `${label}: the minimum applied without cause`)
      } else {
        assert.ok(w.billableDays <= b.calendarDays, `${label}: billed more days than the calendar has`)
        assert.equal(b.countedDays, b.calendarDays - b.weekendDaysDropped, label)
      }
      if (b.weekendDaysDropped > 0) seen.weekendDropped++
      assert.ok(b.weekendDaysDropped <= b.calendarDays, label)
      assert.equal(b.droppedDates.length, b.weekendDaysDropped, label)
      assert.equal(w.billableDays, w.weeks * w.weekEqualsDays + w.remainderBilled, label)
      assert.ok(w.remainderBilled <= Math.min(w.remainderDays, w.weekEqualsDays), label)
      assert.ok(q.lines.every((l) => l.billableDays === w.billableDays), `${label}: a line billed its own day count`)

      // ---- the multiplier never lowers; overrides ignore it ----------------
      const m = q.steps.calendarMultiplier.multiplier
      assert.ok(m >= 1, label)
      if (m > 1) {
        seen.multipliers++
        const flat = priceQuote({ ...input, calendarDays: [] })
        assert.equal(flat.steps.calendarMultiplier.multiplier, 1)
        assert.ok(flat.totals.subtotalMinor <= q.totals.subtotalMinor, `${label}: the multiplier lowered the quote`)
        const allOverridden = priced.every((l) => l.override !== null)
        if (allOverridden) assert.equal(flat.totals.subtotalMinor, q.totals.subtotalMinor, `${label}: the multiplier moved an all-override quote`)
        else assert.ok(flat.totals.subtotalMinor < q.totals.subtotalMinor, `${label}: a multiplier over a card line changed nothing`)
      }
      for (const l of q.lines) {
        if (l.override !== null) {
          seen.overrides++
          assert.equal(l.multiplierApplied, false, `${label}: an override took the multiplier`)
          assert.equal(l.multiplier, 1, label)
          assert.equal(l.effectiveRateMinor, l.override.rateMinor, label)
          assert.equal(l.lineTotalMinor, Math.round(l.qty * l.billableDays * l.override.rateMinor), `${label}: override line total`)
          assert.equal(l.priced, true)
        } else if (l.priced) {
          assert.equal(l.multiplierApplied, true, label)
          assert.equal(l.multiplier, m, label)
          assert.equal(l.effectiveRateMinor, l.cardRateMinor, label)
          assert.equal(l.lineTotalMinor, Math.round(l.qty * l.billableDays * l.cardRateMinor * m), `${label}: card line total`)
        }
      }

      // ---- indicative and the no-card edge --------------------------------------
      assert.equal(q.totals.indicative, unpriced.length > 0 || input.status !== 'confirmed', label)
      assert.equal(q.totals.indicativeReasons.includes('unpriced_lines'), unpriced.length > 0, label)
      assert.equal(q.totals.indicativeReasons.includes('not_confirmed'), input.status !== 'confirmed', label)
      assert.equal(q.totals.indicativeReasons.includes('no_rate_card'), input.card === null, label)
      if (input.card === null) {
        seen.noCard++
        assert.ok(q.lines.every((l) => l.cardRateMinor === null), `${label}: a card rate with no card`)
        assert.ok(q.lines.every((l) => l.override !== null || !l.priced), `${label}: priced with no card and no override`)
        assert.deepEqual(b.weekendMask, [], `${label}: a mask with no card`)
      }

      // ---- determinism -------------------------------------------------------------
      assert.deepEqual(priceQuote(input), q, `${label}: the same input priced differently`)
    }

    // The sampler actually reached every edge it was written to reach.
    for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `${k} was never sampled`)
  })
})
