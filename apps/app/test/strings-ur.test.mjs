/**
 * The Roman-Urdu table, and the switch that selects it.
 *
 * The `StrTable` annotation on STR_UR already makes key drift a COMPILE
 * error; this suite re-proves the parts a type cannot see at runtime:
 *
 *   1. Parity — same keys as English, same kind (string vs function), same
 *      arity, because a translation that silently drops an argument renders
 *      'undefined' in the warehouse.
 *   2. Substance — every entry renders non-empty, through both the plural
 *      and the singular branch of every parameterised string.
 *   3. The same well-formedness rule the English table lives under: no two
 *      entries that are one sentence wearing different trailing punctuation.
 *   4. Selection — with 'papa-lang' set to 'ur' the STR that components
 *      import IS the Urdu table; anything else (absent, garbage) is English,
 *      which is also why the e2e suite's literal-English assertions hold on
 *      a fresh profile.
 *
 * localStorage is stubbed BEFORE any app module loads: strings.ts picks its
 * table at import time, and node caches modules, so the order here is the
 * mechanism under test, not an accident.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const backing = new Map()
globalThis.localStorage = {
  getItem: (key) => backing.get(key) ?? null,
  setItem: (key, value) => { backing.set(key, String(value)) },
}
backing.set('papa-lang', 'ur')

const { STR_UR } = await import('../src/strings-ur.ts')
const { STR, STR_EN } = await import('../src/strings.ts')
const { getLang, setLang } = await import('../src/lang.ts')

/** Render with sample args; n picks the plural branch under test. */
function renderValue(value, n) {
  if (typeof value === 'string') return value
  const args = [n, n + 1, n + 2].slice(0, value.length)
  return String(value(...args))
}

describe('the Roman-Urdu table mirrors the English one', () => {
  const keys = Object.keys(STR_EN).sort()

  test('same keys, nothing missing, nothing extra', () => {
    assert.deepEqual(Object.keys(STR_UR).sort(), keys)
  })

  test('every key is the same kind, and functions take the same arguments', () => {
    for (const key of keys) {
      assert.equal(typeof STR_UR[key], typeof STR_EN[key], key)
      if (typeof STR_EN[key] === 'function') {
        assert.equal(STR_UR[key].length, STR_EN[key].length, `${key} arity`)
      }
    }
  })

  test('every entry renders non-empty, plural and singular', () => {
    for (const n of [2, 1]) {
      const empty = Object.entries(STR_UR)
        .filter(([, v]) => renderValue(v, n).trim().length === 0)
        .map(([k]) => k)
      assert.deepEqual(empty, [], `empty at n=${n}`)
    }
  })

  test('no two entries differ only by trailing punctuation', () => {
    // Same rule as the English table (strings.test.mjs): identical values on
    // two screens are fine, a punctuation-only variant never is.
    const groups = new Map()
    for (const [key, value] of Object.entries(STR_UR)) {
      if (typeof value !== 'string') continue
      const normalized = value.replace(/[\s.,;:!?…·—–-]+$/u, '')
      const group = groups.get(normalized) ?? new Map()
      group.set(value, [...(group.get(value) ?? []), key])
      groups.set(normalized, group)
    }
    const clashes = [...groups.values()]
      .filter((g) => g.size > 1)
      .map((g) => [...g.values()].flat().join(' / '))
    assert.deepEqual(clashes, [], `trailing-punctuation twins:\n${clashes.join('\n')}`)
  })
})

describe('the language switch', () => {
  test("'papa-lang: ur' selects the Urdu table as THE table components import", () => {
    // Identity, not similarity: the STR every screen renders is STR_UR.
    assert.equal(getLang(), 'ur')
    assert.equal(STR, STR_UR)
  })

  test('absent or unrecognised values read as English', () => {
    backing.delete('papa-lang')
    assert.equal(getLang(), 'en')
    backing.set('papa-lang', 'nastaliq')
    assert.equal(getLang(), 'en')
  })

  test('setLang persists the choice (and survives node, where location is absent)', () => {
    setLang('en')
    assert.equal(backing.get('papa-lang'), 'en')
    setLang('ur')
    assert.equal(backing.get('papa-lang'), 'ur')
    assert.equal(getLang(), 'ur')
  })
})
