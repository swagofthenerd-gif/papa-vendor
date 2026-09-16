/**
 * The demo seed's clock, guarded (principle 5).
 *
 * bookings.test.mjs asserted that a pencil expiring "in five hours" dies
 * TODAY. True before 19:00, false after — so the file failed for the time of
 * day rather than for the code. The fix was a seam: `seedDemo(db, nowMs)`,
 * with `Date.now()` surviving only as a default argument, and every test
 * that cares about time handing in one fixed instant.
 *
 * That fix is worth nothing the moment someone writes `new Date()` back into
 * the seed, or adds a test that seeds from the wall clock and then asks what
 * day it is. Prose does not stop either. These two checks do.
 *
 * Read from source rather than imported, the same way icon-names.test.mjs
 * reads the icon set, and resolved against THIS FILE rather than the working
 * directory — the suite runs from the repo root and from apps/app, and a
 * cwd-relative path finds nothing in one of them, which would make a guard
 * pass by examining zero files.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')

/**
 * Files the seed is built out of. A wall-clock read in any of them is read
 * BEHIND the caller's back: it ignores the instant that was handed in, so
 * `seedDemo(db, NOW)` silently returns a house built at some other time.
 * That was true of the job due dates, the rate card's season and Eid, and
 * the network seed until the sweep that added this file.
 */
const SEED_SOURCES = ['src/demo/seed.ts', 'src/demo/network.ts']

/**
 * Tests that seed WITHOUT a clock, on purpose. Two honest reasons only:
 * the file never asks what time it is, or it runs its own fixed era and
 * wants the seeded book out of the way. Anything else belongs on a clock.
 *
 * A new name may only join this list with a reason that survives reading.
 * The second check below is what makes that more than an honour system.
 */
const SEEDS_WITHOUT_A_CLOCK = new Map([
  // Nothing in these reads a date, a due state, a month or a meter. They
  // scan tags, pack cases, build manifests and round-trip QR codes — all of
  // which answer the same on any Tuesday at any hour.
  ['case-confirm.test.mjs', 'no clock read anywhere'],
  ['demo-seed.test.mjs', 'no clock read anywhere'],
  ['durable-summary.test.mjs', 'no clock read anywhere'],
  ['multi-session.test.mjs', 'no clock read anywhere'],
  ['qr-roundtrip.test.mjs', 'no clock read anywhere'],
  ['round-trip.test.mjs', 'no clock read anywhere'],
  ['session-summary.test.mjs', 'no clock read anywhere'],
  // Seeded-deterministic by design: each drives its own simulated era and
  // asserts against a hand-kept mirror, not against the seeded history.
  ['stress-bookings.test.mjs', 'fixed test era, seeded-deterministic'],
  ['stress-money.test.mjs', 'fixed test era, seeded-deterministic'],
  ['stress-network.test.mjs', 'fixed test era, seeded-deterministic'],
  ['stress-registry.test.mjs', 'fixed test era, seeded-deterministic'],
  ['year-in-the-life.test.mjs', 'fixed test era, seeded-deterministic'],
])

/** The reads that make a file care what time it is. */
const CLOCK_READS =
  /\b(dueStatus|dueBoard|dayAccount|dayLabel|dayBounds|monthAccount|monthProfit|moneyStrip|sehat|listBookings|bookingView|promisedStrip|pruneExpiredPencils|calendar)\s*\(/

describe('the seed is built from the instant it is given', () => {
  for (const rel of SEED_SOURCES) {
    test(`${rel} reads no clock except as a default argument`, () => {
      const src = readFileSync(join(APP, rel), 'utf8')

      // `new Date()` — no arguments — is the wall clock. `new Date(nowMs)`
      // and `new Date(y, m, d)` are fine and are everywhere in here.
      const bare = [...src.matchAll(/new Date\(\s*\)/g)]
      assert.equal(bare.length, 0, `${rel}: ${bare.length} bare new Date() — pass nowMs instead`)

      // Date.now() survives in exactly one shape: the default that lets the
      // app call seedDemo(db) and get today.
      for (const m of src.matchAll(/Date\.now\(\)/g)) {
        const line = src.slice(0, m.index).split('\n').length
        const text = src.split('\n')[line - 1]
        assert.match(
          text,
          /:\s*number\s*=\s*Date\.now\(\)/,
          `${rel}:${line} — Date.now() outside a default argument: ${text.trim()}`,
        )
      }
    })
  }
})

/** This file, which quotes the pattern it is looking for. */
const SELF = 'seed-clock.test.mjs'

describe('a test that cares what time it is says which time', () => {
  const testFiles = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs') && f !== SELF)

  test('every seedDemo without a clock is one of the documented exemptions', () => {
    const undocumented = []
    for (const file of testFiles) {
      const src = readFileSync(join(HERE, file), 'utf8')
      if (!/seedDemo\(\s*db\s*\)/.test(src)) continue
      if (!SEEDS_WITHOUT_A_CLOCK.has(file)) undocumented.push(file)
    }
    assert.deepEqual(
      undocumented,
      [],
      'these seed from the wall clock. Hand seedDemo the same fixed instant the\n' +
        'file reads against — see bookings.test.mjs — or add the file above with\n' +
        `a reason:\n${undocumented.join('\n')}`,
    )
  })

  test('nothing on the exemption list quietly started reading a clock', () => {
    // The list is only as good as its reasons. A file exempted for asking no
    // questions about time, which later asks one, is the original bug back
    // under a different name.
    const broken = []
    for (const [file, reason] of SEEDS_WITHOUT_A_CLOCK) {
      if (!reason.startsWith('no clock read')) continue
      const src = readFileSync(join(HERE, file), 'utf8')
      const hit = src.match(CLOCK_READS)
      if (hit) broken.push(`${file}: reads ${hit[1]}()`)
    }
    assert.deepEqual(broken, [], `exempted as clock-free, but no longer:\n${broken.join('\n')}`)
  })

  test('the exemption list names files that exist and actually seed', () => {
    for (const file of SEEDS_WITHOUT_A_CLOCK.keys()) {
      assert.ok(testFiles.includes(file), `${file} is listed but does not exist`)
      const src = readFileSync(join(HERE, file), 'utf8')
      assert.match(src, /seedDemo\(\s*db\s*\)/, `${file} is listed but no longer seeds without a clock`)
    }
  })
})
