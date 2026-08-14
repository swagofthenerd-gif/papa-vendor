/**
 * The session-list row.
 *
 * The memo comparison is the thing under test. A memo that is too eager stops
 * the screen updating, and a tech reads a missing row as "the scanner missed
 * one" — the fastest way to lose their trust in the whole system. So the
 * comparison is asserted directly rather than trusted to a shallow compare.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { scanRowClass, scanRowChanged } from '../src/scan-row.ts'

const row = (over = {}) => ({
  key: 'k1',
  at: 1,
  outcome: 'accepted',
  assetId: 'a1',
  assetCode: 'FX9-02',
  displayName: 'Sony FX9',
  ...over,
})

describe('the row class list', () => {
  test('carries the outcome so the row is colour-coded', () => {
    assert.equal(scanRowClass('accepted', false), 'scan-row is-accepted')
    assert.equal(scanRowClass('conflict', false), 'scan-row is-conflict')
  })

  test('adds the pulse only while pulsing', () => {
    assert.equal(scanRowClass('duplicate', true), 'scan-row is-duplicate is-pulsing')
  })

  test('never leaves a trailing space when not pulsing', () => {
    // The array+filter+join version this replaced could produce one, and a
    // stray class string is the kind of thing that quietly breaks a selector.
    assert.equal(scanRowClass('accepted', false).endsWith(' '), false)
  })
})

describe('when a row must re-render', () => {
  test('it does not, when nothing changed', () => {
    const r = row()
    assert.equal(scanRowChanged({ row: r, isPulsing: false }, { row: r, isPulsing: false }), false)
  })

  test('it does, when the pulse starts', () => {
    const r = row()
    assert.equal(scanRowChanged({ row: r, isPulsing: false }, { row: r, isPulsing: true }), true)
  })

  test('it does, when the pulse ends 400ms later', () => {
    const r = row()
    assert.equal(scanRowChanged({ row: r, isPulsing: true }, { row: r, isPulsing: false }), true)
  })

  // The case that matters most. A row whose outcome is resolved — "Add anyway"
  // on an unexpected item — is a NEW object, and the row must redraw. If this
  // ever returns false the button appears to do nothing.
  test('it does, when the row itself is replaced', () => {
    assert.equal(
      scanRowChanged(
        { row: row({ outcome: 'unexpected' }), isPulsing: false },
        { row: row({ outcome: 'accepted' }), isPulsing: false },
      ),
      true,
    )
  })

  test('it does not, for a different row object that is the same reference', () => {
    // Rows are immutable once added, so identity is the correct test and a
    // deep compare would be wasted work on every scan.
    const r = row()
    assert.equal(scanRowChanged({ row: r, isPulsing: true }, { row: r, isPulsing: true }), false)
  })
})
