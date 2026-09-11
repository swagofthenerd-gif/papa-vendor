/**
 * The ginti discrepancy report.
 *
 * Golden in both languages. The report SURFACES the diff — matched, missing,
 * found-here-anyway — and never decides: missing items carry the "for you to
 * decide" line, never a verdict.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildGintiReport, gintiLabels } from '../src/ginti-report.ts'
import { STR_EN } from '../src/strings.ts'
import { STR_UR } from '../src/strings-ur.ts'

const withDiff = () => ({
  shelf: 'Grip Bay',
  okCount: 5,
  missing: [{ code: 'CST-08', name: 'C-Stand' }],
  unexpected: [{ code: 'AP600-02', name: 'Aputure 600D Pro' }],
})

describe('the ginti report, English', () => {
  const L = gintiLabels(STR_EN)

  test('lists matched, missing and unexpected, and defers the decision', () => {
    const text = buildGintiReport(withDiff(), L)
    assert.match(text, /^GINTI/)
    assert.match(text, /Shelf: Grip Bay/)
    assert.match(text, /5 matched the book\./)
    assert.match(text, /MISSING \(expected, not found\):/)
    assert.match(text, /CST-08\s+C-Stand/)
    assert.match(text, /NOT ON THIS SHELF \(found here anyway\):/)
    assert.match(text, /AP600-02\s+Aputure 600D Pro/)
    assert.match(text, /Missing items are for you to decide/)
  })

  test('a clean count says every item was found', () => {
    const text = buildGintiReport({ shelf: 'Rack A', okCount: 9, missing: [], unexpected: [] }, L)
    assert.match(text, /Every item on this shelf was found\./)
    assert.doesNotMatch(text, /MISSING/)
  })

  test('is deterministic', () => {
    assert.equal(buildGintiReport(withDiff(), L), buildGintiReport(withDiff(), L))
  })
})

describe('the ginti report, Roman Urdu', () => {
  const L = gintiLabels(STR_UR)

  test('renders non-empty and carries the shelf and codes', () => {
    const text = buildGintiReport(withDiff(), L)
    assert.ok(text.length > 0)
    assert.match(text, /GINTI/)
    assert.match(text, /Grip Bay/)
    assert.match(text, /CST-08/)
    assert.match(text, /AP600-02/)
  })
})
