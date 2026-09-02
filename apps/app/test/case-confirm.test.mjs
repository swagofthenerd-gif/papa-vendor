/**
 * "Not in here" on the case sheet.
 *
 * THE RULE UNDER TEST: the bulk confirm records the untouched rows as
 * `assumed` — countable, never dispute evidence — while a row toggled "not in
 * here" is recorded as NOTHING AT ALL, so it lands on the session shortfall
 * as missing. The all-or-nothing sheet forced a tech who knew a battery was
 * absent to either scan everything one by one or put their name to it anyway.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, ScanSession, caseManifest } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { confirmRest, toggleNotInHere } from '../src/case-confirm.ts'
import { buildSummary } from '../src/session-summary.ts'

let db
let seed

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
})

describe('the pure decision', () => {
  const packed = [{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }]

  test('confirm-rest leaves out the scanned and the disbelieved', () => {
    assert.deepEqual(confirmRest(packed, new Set(), new Set()), ['a', 'b', 'c'])
    assert.deepEqual(confirmRest(packed, new Set(['a']), new Set(['c'])), ['b'])
    assert.deepEqual(confirmRest(packed, new Set(), new Set(['a', 'b', 'c'])), [])
  })

  test('the toggle round-trips, and never mutates in place', () => {
    // The set lives in React state: mutating in place renders nothing, and a
    // toggle that does not visibly toggle gets tapped again.
    const none = new Set()
    const marked = toggleNotInHere(none, 'a')
    assert.equal(none.size, 0, 'the original set is untouched')
    assert.ok(marked.has('a'))

    const unmarked = toggleNotInHere(marked, 'a')
    assert.equal(unmarked.size, 0)
    assert.ok(marked.has('a'), 'the intermediate set is untouched too')
  })
})

describe('what the record says afterwards', () => {
  test('untouched rows become assumed; a toggled row lands on the shortfall', () => {
    // The seeded A-Cam case travels on the Shan job: its packed children are
    // all on that job's list, which is what makes "missing" mean something.
    const job = seed.jobs[0]
    const manifest = caseManifest(db, 'asset-case-1')
    const excludedId = manifest.packed[0].assetId
    for (const c of manifest.packed) {
      assert.ok(job.expected.includes(c.assetId), `${c.assetId} is on the job`)
    }

    const session = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })

    const notInHere = toggleNotInHere(new Set(), excludedId)
    const rest = confirmRest(manifest.packed, new Set(session.scannedIds), notInHere)
    const results = session.confirmContents(rest, 'check_out')
    assert.equal(results.length, manifest.packed.length - 1)

    // The record: every confirmed row is assumed — a belief, not evidence —
    // and the excluded row appears NOWHERE.
    const ops = db
      .all(`select payload from outbox where op = 'submit_scan_batch'`)
      .map((r) => JSON.parse(r.payload))
    assert.ok(ops.length > 0)
    for (const op of ops) {
      assert.equal(op.entry_method, 'assumed')
      assert.notEqual(op.asset_id, excludedId, 'nothing at all for the excluded row')
    }

    // The handover: the excluded item is MISSING, named, and the assumed ones
    // are counted apart from observations.
    const s = buildSummary({
      jobLabel: job.label,
      mode: 'out',
      expected: job.expected,
      recorded: session.scannedIds,
      assumed: rest,
      unknownTags: [],
      facts: (id) => ({ id, code: id, name: id }),
    })
    assert.ok(s.missing.some((m) => m.key === excludedId), 'it shows as missing')
    assert.equal(s.assumed, rest.length)
    assert.equal(s.scanned, 0, 'nothing here was an observation')
  })

  test('the excluded item still reads as on the shelf, not out', () => {
    // No write means no projection move: the battery the tech said was not
    // in the case must not show as checked out to the job.
    const job = seed.jobs[0]
    const manifest = caseManifest(db, 'asset-case-1')
    const excludedId = manifest.packed[0].assetId

    const session = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    const rest = confirmRest(manifest.packed, new Set(), new Set([excludedId]))
    session.confirmContents(rest, 'check_out')

    const a = db.get(`select presence, current_job_id from assets where id = ?`, [excludedId])
    assert.equal(a.presence, 'here')
    assert.equal(a.current_job_id, null)
  })
})
