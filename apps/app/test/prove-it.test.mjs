/**
 * The "Prove it" alibi card.
 *
 * The card is only an alibi if it never overstates, so the assertions here
 * are mostly about honesty: an assumed entry is named as trust, zero photos
 * says zero, no history says no history — and the timestamp is deterministic,
 * because two builds of the same facts must produce the same card.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildProveIt } from '../src/prove-it.ts'

const WHEN = new Date(2026, 8, 3, 6, 14).getTime() // local 2026-09-03 06:14

const base = () => ({
  houseName: 'Ravi Light & Grip',
  code: 'FX9-02',
  name: 'Sony FX9',
  statusLine: 'On Documentary — Walled City',
  lastScan: {
    eventType: 'check_out',
    whenMs: WHEN,
    jobLabel: 'Documentary — Walled City',
    entryMethod: 'scanned',
  },
  photoCount: 2,
})

describe('what the card says', () => {
  test('the full alibi: item, state, last scan, photos, whose log', () => {
    const text = buildProveIt(base())
    assert.match(text, /^FX9-02 — Sony FX9/)
    assert.match(text, /On Documentary — Walled City/)
    assert.match(
      text,
      /Last record: went out 2026-09-03 06:14 on Documentary — Walled City — scanned on this phone/,
    )
    assert.match(text, /2 condition photos on this phone\./)
    assert.match(text, /From the Ravi Light & Grip scan log\.$/)
  })

  test('a check-in reads as coming back', () => {
    const text = buildProveIt({
      ...base(),
      lastScan: { ...base().lastScan, eventType: 'check_in' },
    })
    assert.match(text, /Last record: came back 2026-09-03 06:14/)
  })

  test('is deterministic — same facts, same card', () => {
    assert.equal(buildProveIt(base()), buildProveIt(base()))
  })
})

describe('the honesty rules', () => {
  test('an assumed entry is named as trust, not dressed as a scan', () => {
    const text = buildProveIt({
      ...base(),
      lastScan: { ...base().lastScan, entryMethod: 'assumed' },
    })
    assert.match(text, /taken on trust, not seen/)
    assert.doesNotMatch(text, /scanned on this phone/)
  })

  test('no scan history is said plainly, never implied clean', () => {
    const text = buildProveIt({ ...base(), lastScan: null })
    assert.match(text, /No scan of this item recorded on this phone\./)
    assert.doesNotMatch(text, /Last record:/)
  })

  test('zero photos says zero — the count is evidence either way', () => {
    const text = buildProveIt({ ...base(), photoCount: 0 })
    assert.match(text, /No condition photos on this phone\./)
    const one = buildProveIt({ ...base(), photoCount: 1 })
    assert.match(one, /1 condition photo on this phone\./)
  })

  test('a scan with no job still tells its story', () => {
    const text = buildProveIt({
      ...base(),
      lastScan: { ...base().lastScan, jobLabel: null },
    })
    assert.match(text, /Last record: went out 2026-09-03 06:14 — scanned on this phone/)
    assert.doesNotMatch(text, / on null/)
  })
})
