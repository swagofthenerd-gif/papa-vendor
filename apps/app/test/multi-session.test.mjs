/**
 * Several sessions at once.
 *
 * THE REGRESSION UNDER TEST: the store used to hold exactly ONE live session,
 * so opening a return mid-prep destroyed the prep session's dedupe set and
 * expected snapshot — and coming back to the prep, every rescan read as a
 * fresh scan and wrote a second op. A morning with one interruption in it
 * quietly double-counted.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { SessionRegistry } from '../src/demo/sessions.ts'

let db
let seed
let registry

/** The store's own expected sets: the job's list going out, what is
 *  physically out coming back. */
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

const scanOps = () =>
  db.all(`select payload from outbox where op = 'submit_scan_batch' order by seq`)
    .map((r) => JSON.parse(r.payload))

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  registry = new SessionRegistry(db, 'test-device', expectedFor)
})

describe('sessions keyed by job and direction', () => {
  test('coming back to a job RESUMES its session, dedupe set intact', () => {
    const shan = seed.jobs[0]
    const prep = registry.open(shan.id, 'out')
    prep.session.addManually(shan.expected[0], 'check_out')
    prep.session.addManually(shan.expected[1], 'check_out')

    // Interrupted: a truck arrives and a return is opened on another job.
    // The doc job has gear physically out (seeded), so the return is real.
    const back = registry.open('job-doc', 'in')
    assert.equal(back.expected.length, 1, 'the seeded FX6 is out on the doc job')
    back.session.addManually(back.expected[0], 'check_in')

    // Back to the prep: the SAME session object, with its progress.
    const resumed = registry.open(shan.id, 'out')
    assert.equal(resumed.session, prep.session, 'resumed, not rebuilt')
    assert.equal(resumed.session.scannedIds.length, 2)

    // And a rescan is a duplicate, not a second op — the double-count bug.
    const r = resumed.session.addManually(shan.expected[0], 'check_out')
    assert.equal(r.outcome, 'duplicate')
    assert.equal(scanOps().length, 3, 'two prep ops and one return op, nothing doubled')
  })

  test('each session keeps its own expected snapshot', () => {
    const shan = seed.jobs[0]
    const prep = registry.open(shan.id, 'out')

    // A return elsewhere moves gear around; the prep's denominator must not
    // melt while the tech is looking at it.
    const back = registry.open('job-doc', 'in')
    back.session.addManually(back.expected[0], 'check_in')

    assert.deepEqual(registry.open(shan.id, 'out').expected, prep.expected)
    assert.deepEqual(prep.expected, shan.expected)
  })

  test('the board can show progress on several jobs at once', () => {
    const [shan, wedding] = seed.jobs
    registry.open(shan.id, 'out').session.addManually(shan.expected[0], 'check_out')
    registry.open(wedding.id, 'out').session.addManually(wedding.expected[0], 'check_out')

    // Both in-progress numbers are readable without touching either session —
    // the single-session store could only ever answer for the last one.
    assert.equal(registry.peek(shan.id, 'out').session.scannedIds.length, 1)
    assert.equal(registry.peek(wedding.id, 'out').session.scannedIds.length, 1)
  })

  test('the same job can be going out and coming back without collision', () => {
    const shan = seed.jobs[0]
    const out = registry.open(shan.id, 'out')
    out.session.addManually(shan.expected[0], 'check_out')

    const back = registry.open(shan.id, 'in')
    assert.notEqual(back.session, out.session, 'a return is its own session')

    // A summary reached with only the job id lands on the one just opened.
    assert.equal(registry.peek(shan.id), back)
    assert.equal(registry.peek(shan.id, 'out'), out)
  })

  test('finishing completes THAT session only', () => {
    const [shan, wedding] = seed.jobs
    const prep = registry.open(shan.id, 'out')
    prep.session.addManually(shan.expected[0], 'check_out')

    registry.open(wedding.id, 'out')
    registry.endCurrent()

    assert.equal(registry.peek(wedding.id, 'out'), null, 'the finished one is gone')
    const survivor = registry.peek(shan.id, 'out')
    assert.equal(survivor?.session, prep.session, 'the other prep is untouched')
    assert.equal(survivor.session.scannedIds.length, 1)
  })

  test('ending with nothing open is a no-op, twice over', () => {
    registry.endCurrent()
    const shan = seed.jobs[0]
    registry.open(shan.id, 'out')
    registry.endCurrent()
    registry.endCurrent()
    assert.equal(registry.current(), null)
    assert.equal(registry.peek(shan.id, 'out'), null)
  })
})
