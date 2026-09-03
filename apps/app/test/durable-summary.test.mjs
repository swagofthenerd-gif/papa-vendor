/**
 * Handover summaries that outlive their session.
 *
 * THE REGRESSION UNDER TEST: the summary was built from the in-memory
 * session, so tapping "done" — or a refresh — destroyed the only readable
 * record of the morning, and the evening owner met "that scan session has
 * finished" instead of a tally. The scans were never lost (the outbox holds
 * every one, keyed by session), but the session's mode and expected snapshot
 * died with the object. scan_sessions now stores those two facts the moment
 * a session opens, and the summary rebuilds from the two tables together.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { SessionRegistry } from '../src/demo/sessions.ts'
import {
  decodeScanOps,
  lastSessionRecord,
  sessionScanFacts,
} from '../src/demo/read-model.ts'
import { buildSummary, shortfall } from '../src/session-summary.ts'

let db
let seed
let registry

const expectedFor = (jobId, mode) => {
  if (mode === 'out') return seed.jobs.find((j) => j.id === jobId)?.expected ?? []
  return db
    .all(
      `select id from assets
        where current_job_id = ? and presence in ('out', 'in_transit')
        order by asset_code`,
      [jobId],
    )
    .map((r) => r.id)
}

/** The store's rebuild path, minus the sql.js store: record + queue in,
 *  summary out. */
function rebuild(jobId) {
  const rec = lastSessionRecord(db, jobId)
  if (!rec) return null
  const facts = sessionScanFacts(decodeScanOps(db), rec.id)
  return buildSummary({
    jobLabel: seed.jobs.find((j) => j.id === jobId)?.label ?? jobId,
    mode: rec.mode,
    expected: rec.expected,
    ...facts,
    facts: () => undefined,
  })
}

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  registry = new SessionRegistry(db, 'test-device', expectedFor)
})

describe('the session record', () => {
  test('is written the moment a session opens, not at finish', () => {
    const shan = seed.jobs[0]
    const entry = registry.open(shan.id, 'out')
    const rec = lastSessionRecord(db, shan.id)
    assert.ok(rec, 'recorded at open — a crash mid-scan must not lose it')
    assert.equal(rec.id, entry.session.id)
    assert.equal(rec.mode, 'out')
    assert.deepEqual(rec.expected, shan.expected)
  })

  test('a later session on the same job supersedes the earlier one', () => {
    const shan = seed.jobs[0]
    registry.open(shan.id, 'out')
    registry.endCurrent()
    const ret = registry.open(shan.id, 'in')
    const rec = lastSessionRecord(db, shan.id)
    assert.equal(rec.id, ret.session.id)
    assert.equal(rec.mode, 'in')
  })

  test('a job never scanned has no record and no invented summary', () => {
    assert.equal(lastSessionRecord(db, 'job-wedding'), null)
    assert.equal(rebuild('job-wedding'), null)
  })
})

describe('rebuilding the summary after the session is gone', () => {
  test('the rebuilt tally equals the live one', () => {
    const shan = seed.jobs[0]
    const entry = registry.open(shan.id, 'out')
    for (const id of shan.expected.slice(0, 4)) entry.session.addManually(id, 'check_out')
    entry.session.addManually('asset-komodo-1', 'check_out') // off-list

    // The live numbers, computed the wave-1 way from the open session…
    const liveFacts = sessionScanFacts(decodeScanOps(db), entry.session.id)
    const live = buildSummary({
      jobLabel: shan.label,
      mode: 'out',
      expected: entry.expected,
      ...liveFacts,
      facts: () => undefined,
    })

    // …then the tech holds "done" and the in-memory session is destroyed.
    registry.endCurrent()
    assert.equal(registry.peek(shan.id), null, 'the live session really is gone')

    const later = rebuild(shan.id)
    assert.ok(later, 'still reviewable in the evening')
    assert.equal(later.scanned, live.scanned)
    assert.equal(later.assumed, live.assumed)
    assert.equal(shortfall(later), shortfall(live))
    assert.deepEqual(
      later.missing.map((m) => m.key),
      live.missing.map((m) => m.key),
    )
    assert.equal(later.exceptions.length, live.exceptions.length)
  })

  test('two jobs scanned the same morning rebuild independently', () => {
    const shan = seed.jobs[0]
    const prep = registry.open(shan.id, 'out')
    prep.session.addManually(shan.expected[0], 'check_out')

    const back = registry.open('job-doc', 'in')
    back.session.addManually(back.expected[0], 'check_in')

    registry.endCurrent() // finishes the doc return
    registry.open(shan.id, 'out')
    registry.endCurrent() // finishes the prep

    const prepSummary = rebuild(shan.id)
    const docSummary = rebuild('job-doc')
    assert.equal(prepSummary.mode, 'out')
    assert.equal(prepSummary.scanned, 1)
    assert.equal(docSummary.mode, 'in')
    assert.equal(docSummary.scanned, 1)
    assert.equal(shortfall(docSummary), 0, 'everything out on the doc came back')
  })

  test('an unknown tag survives into the rebuilt exceptions', () => {
    const shan = seed.jobs[0]
    const entry = registry.open(shan.id, 'out')
    entry.session.scan('v1NOTAREALTAGCODEATALL0')
    registry.endCurrent()

    const later = rebuild(shan.id)
    assert.equal(later.exceptions.length, 1)
    assert.equal(later.exceptions[0].outcome, 'unknown')
  })
})

describe('the one decode helper', () => {
  test('decodes every scan op with its session and entry method', () => {
    const shan = seed.jobs[0]
    const entry = registry.open(shan.id, 'out')
    entry.session.addManually(shan.expected[0], 'check_out')

    const ops = decodeScanOps(db)
    assert.equal(ops.length, 1)
    assert.equal(ops[0].sessionId, entry.session.id)
    assert.equal(ops[0].assetId, shan.expected[0])
    assert.equal(ops[0].entryMethod, 'manual')
    assert.equal(ops[0].eventType, 'check_out')
    assert.equal(ops[0].jobId, shan.id)
  })
})
