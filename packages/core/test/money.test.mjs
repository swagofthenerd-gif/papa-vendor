/**
 * Rupees on screens — the formatting and totalling rules.
 *
 * Two things are worth pinning down: the digit grouping (western, chosen
 * deliberately — see docs/assumptions.md#demo-rates), and the honesty rule
 * for totals: an unpriced item is COUNTED, never priced at zero, and a total
 * with nothing priced is no total at all rather than 'Rs 0'.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  formatRupees,
  totalRates,
  moneyLabel,
  indicativeDayTotal,
} from '../src/money.ts'

describe('formatRupees', () => {
  test('minor units in, whole grouped rupees out', () => {
    assert.equal(formatRupees(2_500_000), 'Rs 25,000')
    assert.equal(formatRupees(30_000), 'Rs 300')
    assert.equal(formatRupees(0), 'Rs 0')
  })

  test('western grouping, not lakh-style — the documented choice', () => {
    // 2.5 million rupees: 2,500,000 — never 25,00,000.
    assert.equal(formatRupees(250_000_000), 'Rs 2,500,000')
  })

  test('paisa round to the nearest rupee — nobody quotes paisa on a line', () => {
    assert.equal(formatRupees(150), 'Rs 2')
    assert.equal(formatRupees(149), 'Rs 1')
  })

  test('a negative amount keeps its sign outside the grouping', () => {
    // No negative money exists in the app today, but a formatter that
    // printed 'Rs -1,2,000' the first time one appeared would ship unseen.
    assert.equal(formatRupees(-1_200_000), 'Rs -12,000')
  })
})

describe('totalRates and moneyLabel — the honesty rule', () => {
  test('priced values sum; null and undefined count as unpriced', () => {
    const t = totalRates([100_000, null, 250_000, undefined])
    assert.deepEqual(t, { totalMinor: 350_000, priced: 2, unpriced: 2 })
  })

  test('a mixed total says how many lines it is not counting', () => {
    assert.equal(
      moneyLabel({ totalMinor: 4_300_000, priced: 3, unpriced: 2 }),
      'Rs 43,000 +2 unpriced',
    )
  })

  test('a fully priced total is just the money', () => {
    assert.equal(moneyLabel({ totalMinor: 4_300_000, priced: 3, unpriced: 0 }), 'Rs 43,000')
  })

  test('nothing priced means NO label — never Rs 0 over an unpriced list', () => {
    assert.equal(moneyLabel({ totalMinor: 0, priced: 0, unpriced: 4 }), null)
    assert.equal(moneyLabel(totalRates([])), null)
    assert.equal(moneyLabel(totalRates([null, null])), null)
  })
})

describe('the indicative day-rate total for an answered kit list', () => {
  const rates = new Map([
    ['prod-fx9', 2_500_000],
    ['prod-xlr', 30_000],
  ])
  const rateFor = (id) => rates.get(id) ?? null

  test('rate times quantity over the resolved lines', () => {
    const t = indicativeDayTotal(
      [
        { productId: 'prod-fx9', quantity: 1 },
        { productId: 'prod-xlr', quantity: 4 },
      ],
      rateFor,
    )
    assert.deepEqual(t, { totalMinor: 2_620_000, priced: 2, unpriced: 0 })
  })

  test('unresolved lines and rateless products both land in unpriced', () => {
    const t = indicativeDayTotal(
      [
        { productId: 'prod-fx9', quantity: 2 },
        { productId: null, quantity: 1 },       // the matcher refused to guess
        { productId: 'prod-norate', quantity: 3 }, // resolved, but no rate
      ],
      rateFor,
    )
    // The refusal carries through: two lines the money cannot speak for are
    // counted as lines, not silently priced at zero units of anything.
    assert.deepEqual(t, { totalMinor: 5_000_000, priced: 1, unpriced: 2 })
  })
})
