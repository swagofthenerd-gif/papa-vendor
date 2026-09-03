/**
 * Jobs born at the desk.
 *
 * The promise under test: a job created from an answered kit list (or from
 * nothing, as a walk-in) is INDISTINGUISHABLE from a seeded job — on the
 * board, in a scan session, and in the availability answer. Wave 1 could not
 * keep that promise because the expected sets lived only on the seed object;
 * they live in job_expected now, and these tests are what hold that door
 * shut.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import {
  LOCAL_SCHEMA,
  ScanSession,
  availabilityNote,
  checkAvailability,
  dueStatus,
  matchKitList,
  parseKitList,
} from '@papa/core'
import { seedDemo, demoCatalogue } from '../src/demo/seed.ts'
import {
  createJob,
  openJob,
  openJobCommitments,
  openJobs,
  setExpectedBack,
} from '../src/demo/read-model.ts'

let db
let seed

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
})

const create = (over = {}) =>
  createJob(db, {
    id: 'job-desk-1',
    orgId: seed.orgId,
    label: 'Music video — Gulberg',
    contact: 'Sara 0301 5556677',
    expectedBack: null,
    wants: [{ productId: 'prod-fx6', qty: 2 }, { productId: 'prod-cstand', qty: 3 }],
    ...over,
  })

describe('creating a job', () => {
  test('inserts the job and allocates real units as its promised set', () => {
    const { expected, requested } = create()
    assert.equal(requested, 5)
    assert.equal(expected.length, 5)

    const job = openJob(db, 'job-desk-1')
    assert.ok(job, 'on the board')
    assert.deepEqual([...job.expected].sort(), [...expected].sort())
    assert.equal(job.departsAt, null, 'a walk-in has no departure slot')
  })

  test('only rentable units are promised — never faulty, never absent', () => {
    // One FX6 is seeded out on the documentary, so only two are here.
    const { expected } = create({ wants: [{ productId: 'prod-fx6', qty: 3 }] })
    assert.deepEqual(expected.sort(), ['asset-fx6-1', 'asset-fx6-2'])
    assert.ok(!expected.includes('asset-fx6-3'), 'the one that is out stays out')
  })

  test('a shortfall is reported, not padded', () => {
    // Four 600Ds exist; one is seeded faulty. Asking for five gets three
    // and an honest gap the sheet can name — a padded set is a promised
    // unit that is not there.
    const { expected, requested } = create({
      wants: [{ productId: 'prod-aputure600', qty: 5 }],
    })
    assert.equal(requested, 5)
    assert.equal(expected.length, 3)
    assert.ok(!expected.includes('asset-aputure600-4'), 'the faulty light is not promised')
  })

  test('a scan session against the new job behaves like a seeded one', () => {
    const { expected } = create()
    const session = new ScanSession(db, {
      deviceId: 't', jobId: 'job-desk-1', expected: new Set(expected),
    })
    const tag = seed.tags.find((t) => t.assetId === expected[0])
    const result = session.scan(tag.tagCode)
    assert.equal(result.outcome, 'accepted')
    assert.equal(result.assetId, expected[0])
  })
})

describe('the due date on a job card', () => {
  test('can be set, and the board ranks it immediately', () => {
    create()
    setExpectedBack(db, 'job-desk-1', '2026-01-05')
    const job = openJob(db, 'job-desk-1')
    assert.equal(job.expectedBack, '2026-01-05')
    assert.equal(dueStatus(job.expectedBack, Date.parse('2026-01-08T10:00')).state, 'overdue')
  })

  test('can be cleared back to the honest no-date', () => {
    create({ expectedBack: '2026-01-05' })
    setExpectedBack(db, 'job-desk-1', null)
    const job = openJob(db, 'job-desk-1')
    assert.equal(job.expectedBack, null)
    assert.equal(dueStatus(job.expectedBack, Date.now()).label, 'no date')
  })
})

describe('commitments feed the availability answer', () => {
  test('open jobs claim their promised products, one entry per unit', () => {
    const commitments = openJobCommitments(db)
    const shan = commitments.find((c) => c.jobId === 'job-shan')
    assert.ok(shan)
    assert.equal(shan.out, false, 'promised but not yet left')
    assert.equal(
      shan.productIds.filter((p) => p === 'prod-vmount').length,
      4,
      'four batteries, four entries',
    )

    const doc = commitments.find((c) => c.jobId === 'job-doc')
    assert.equal(doc.out, true, 'the documentary has gear physically out')
  })

  test('the answer names the job and when its gear is back', () => {
    const matched = matchKitList(parseKitList('1 Sony FX9'), demoCatalogue())
    const summary = checkAvailability(db, matched, openJobCommitments(db), Date.now())
    const [line] = summary.lines
    assert.equal(line.state, 'available')
    const note = availabilityNote(line)
    assert.ok(note.includes('Shan Foods'), `note names the claiming job: ${note}`)
    assert.ok(note.includes('going to'), 'promised gear reads as going, not out')
  })

  test('a desk-created job claims stock like a seeded one', () => {
    create({ wants: [{ productId: 'prod-komodo', qty: 1 }] })
    const matched = matchKitList(parseKitList('1 RED Komodo 6K'), demoCatalogue())
    const summary = checkAvailability(db, matched, openJobCommitments(db), Date.now())
    const note = availabilityNote(summary.lines[0])
    assert.ok(note.includes('Music video — Gulberg'), note)
  })

  test('sorted openJobs still lists every open job for the board', () => {
    create()
    assert.equal(openJobs(db).length, seed.jobs.length + 1)
    // No departure time: the walk-in sits at the bottom of the morning.
    assert.equal(openJobs(db).at(-1).id, 'job-desk-1')
  })
})
