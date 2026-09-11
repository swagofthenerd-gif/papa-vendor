/**
 * The theft report — the police / insurance card.
 *
 * Golden in BOTH languages (the parchi/khata pattern): the words come from
 * the string table, so the same facts build a coherent report in English and
 * Roman Urdu. The load-bearing honesty: the serial, the photo count and the
 * last-seen line are printed exactly, because this is the document a house
 * hands the police.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildTheftReport, theftLabels } from '../src/theft-report.ts'
import { STR_EN } from '../src/strings.ts'
import { STR_UR } from '../src/strings-ur.ts'

const WHEN = new Date(2026, 1, 14, 18, 30).getTime() // local 2026-02-14 18:30

const base = () => ({
  houseName: 'Ravi Light & Grip',
  item: { code: 'FX6-01', name: 'Sony FX6', serial: 'SN-99123' },
  photoCount: 2,
  lastSeen: { whenMs: WHEN, jobLabel: 'Music video — night shoot', place: 'Rack A' },
  contactLine: 'JazzCash: 0300 1234567',
})

describe('the theft report, English', () => {
  const L = theftLabels(STR_EN)

  test('names the item completely and stamps STOLEN', () => {
    const text = buildTheftReport(base(), L)
    assert.match(text, /THEFT REPORT — Ravi Light & Grip/)
    assert.match(text, /reported STOLEN/)
    assert.match(text, /FX6-01\s+Sony FX6/)
    assert.match(text, /Serial: SN-99123/)
    assert.match(text, /2 condition photos on record\./)
    assert.match(text, /2026-02-14 18:30 — on Music video — night shoot/)
    assert.match(text, /Rack A/)
    assert.match(text, /Contact: JazzCash: 0300 1234567/)
    assert.match(text, /Reported by Ravi Light & Grip/)
  })

  test('a missing serial says so, not blank', () => {
    const text = buildTheftReport({ ...base(), item: { ...base().item, serial: null } }, L)
    assert.match(text, /Serial: not recorded/)
  })

  test('no scan on record reads honestly', () => {
    const text = buildTheftReport({ ...base(), lastSeen: null }, L)
    assert.match(text, /No scan on record\./)
  })

  test('one photo is singular; zero says none', () => {
    assert.match(buildTheftReport({ ...base(), photoCount: 1 }, L), /1 condition photo on record\./)
    assert.match(buildTheftReport({ ...base(), photoCount: 0 }, L), /No condition photos on record\./)
  })

  test('is deterministic — same facts, same card', () => {
    assert.equal(buildTheftReport(base(), L), buildTheftReport(base(), L))
  })
})

describe('the theft report, Roman Urdu', () => {
  const L = theftLabels(STR_UR)

  test('renders non-empty and carries the same facts', () => {
    const text = buildTheftReport(base(), L)
    assert.ok(text.length > 0)
    assert.match(text, /CHORI KI REPORT/)
    assert.match(text, /FX6-01/)
    assert.match(text, /SN-99123/)
    // The last-seen instant is a stamp, language-independent.
    assert.match(text, /2026-02-14 18:30/)
    assert.match(text, /Ravi Light & Grip/)
  })
})
