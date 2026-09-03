/**
 * The Today board's numbers and order.
 *
 * Wave 1 shipped a comment that claimed the job list was sorted by departure
 * over a list that was not sorted at all, an overdue counter hardcoded to
 * zero, and a progress ring that reset on every reload. Each of those is a
 * board that lies to the owner at 6am, so each is pinned here against the
 * real seed and the real on-device schema.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, ScanSession, dueStatus } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import {
  compareJobsByDeparture,
  dueBoard,
  itemsSummary,
  openJobs,
  outItemNames,
  packedProgress,
} from '../src/demo/read-model.ts'

let db
let seed

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
})

describe('the seeded due dates', () => {
  test('straddle today: one overdue, one due today, one upcoming', () => {
    // The seed documents this promise: the dates are relative to the day the
    // demo opens precisely so the board always demonstrates all three
    // states. A fixed calendar date would rot into all-overdue in a week.
    const states = seed.jobs.map((j) => dueStatus(j.expectedBack, Date.now()).state).sort()
    assert.deepEqual(states, ['due_today', 'overdue', 'upcoming'])
  })

  test('are real ISO dates the parser accepts, not free text', () => {
    for (const job of seed.jobs) {
      assert.match(job.expectedBack, /^\d{4}-\d{2}-\d{2}$/)
      assert.notEqual(dueStatus(job.expectedBack, Date.now()).state, 'unknown')
    }
  })

  test('the overdue job is the one with gear already out', () => {
    // So the coming-back board opens with a real red row and a nudge to
    // send, instead of the overdue state being unreachable in the demo.
    const doc = seed.jobs.find((j) => j.id === 'job-doc')
    assert.equal(dueStatus(doc.expectedBack, Date.now()).state, 'overdue')
    const out = db.get(
      `select count(*) as n from assets where current_job_id = 'job-doc' and presence = 'out'`,
    )
    assert.ok(Number(out.n) > 0)
  })
})

describe('the promised sets live in the database', () => {
  test('job_expected mirrors the seed object exactly', () => {
    for (const job of seed.jobs) {
      const rows = db
        .all(`select asset_id from job_expected where job_id = ? order by asset_id`, [job.id])
        .map((r) => r.asset_id)
      assert.deepEqual(rows, [...job.expected].sort())
    }
  })

  test('openJobs reads the same sets back', () => {
    const jobs = openJobs(db)
    assert.equal(jobs.length, seed.jobs.length)
    for (const j of jobs) {
      const seeded = seed.jobs.find((s) => s.id === j.id)
      assert.deepEqual([...j.expected].sort(), [...seeded.expected].sort())
      assert.equal(j.expectedBack, seeded.expectedBack)
      assert.equal(j.departsAt, seeded.departsAt)
    }
  })
})

describe('the board runs in departure order', () => {
  test('earliest departure first — the order the morning happens in', () => {
    assert.deepEqual(
      openJobs(db).map((j) => j.departsAt),
      ['06:30', '09:15', '14:00'],
    )
  })

  test('a job with no departure time sorts last, not first', () => {
    // Walk-ins have no departure. They must not jump the 6am truck.
    const rows = [
      { departsAt: null },
      { departsAt: '14:00' },
      { departsAt: '06:30' },
      { departsAt: null },
    ]
    const sorted = [...rows].sort(compareJobsByDeparture)
    assert.deepEqual(
      sorted.map((r) => r.departsAt),
      ['06:30', '14:00', null, null],
    )
  })
})

describe('the coming-back board', () => {
  test('counts overdue and due-back from dueStatus, not a hardcoded zero', () => {
    const board = dueBoard(db, Date.now())
    // Only the documentary has gear out, and it is seeded overdue.
    assert.equal(board.overdue, 1)
    assert.equal(board.dueBack, 0)
    assert.equal(board.outJobs.length, 1)
    assert.equal(board.outJobs[0].id, 'job-doc')
    assert.equal(board.outJobs[0].due.state, 'overdue')
  })

  test('overdue rows are pinned above everything else', () => {
    // Put the wedding's gear out too — it is due in three days.
    db.exec(
      `update assets set presence = 'out', current_job_id = 'job-wedding' where id = 'asset-fx6-1'`,
    )
    const board = dueBoard(db, Date.now())
    assert.deepEqual(
      board.outJobs.map((j) => j.due.state),
      ['overdue', 'upcoming'],
    )
  })

  test('free-text dates land in neither counter — no date is not late', () => {
    db.exec(`update jobs set expected_back = 'after eid' where id = 'job-doc'`)
    const board = dueBoard(db, Date.now())
    assert.equal(board.overdue, 0)
    assert.equal(board.dueBack, 0)
    assert.equal(board.outJobs[0].due.label, 'no date')
  })
})

describe('per-job progress survives losing the live session', () => {
  test('falls back to counting projected check-outs of promised items', () => {
    const job = seed.jobs.find((j) => j.id === 'job-shan')
    assert.equal(packedProgress(db, job.id), 0, 'nothing packed yet')

    // A session scans three promised items out, then the app "reloads":
    // the session object is gone but the projection is in the mirror.
    const session = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    for (const id of job.expected.slice(0, 3)) session.addManually(id, 'check_out')

    assert.equal(packedProgress(db, job.id), 3)
  })

  test('an off-list scan does not inflate the promised count', () => {
    const job = seed.jobs.find((j) => j.id === 'job-shan')
    const session = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    session.addManually(job.expected[0], 'check_out')
    session.addManually('asset-komodo-1', 'check_out') // on no list at all

    // The komodo IS out on the job, but the ring reads x/expected — counting
    // it would let the ring claim a promised item left when it did not.
    assert.equal(packedProgress(db, job.id), 1)
  })
})

describe('the nudge shortfall summary', () => {
  test('names what is out without reciting a manifest', () => {
    assert.equal(itemsSummary([]), '')
    assert.equal(itemsSummary(['Sony FX6']), 'Sony FX6')
    assert.equal(itemsSummary(['Sony FX6', 'C-Stand', 'XLR Cable 5m']), 'Sony FX6 + 2 more')
  })

  test('reads the out items for a job from the mirror', () => {
    assert.deepEqual(outItemNames(db, 'job-doc'), ['Sony FX6'])
  })
})
