/**
 * The demo's rate data and the reads built on it.
 *
 * The rates themselves are marked ASSUMPTION in seed.ts; what these tests
 * pin down is the plumbing and the honesty rule: minor units end to end, a
 * rateless product reports null (never zero), and every total carries its
 * unpriced count instead of quietly absorbing it.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, moneyLabel } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { assetFacts, dayRateFor, dueBoard } from '../src/demo/read-model.ts'

let db

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seedDemo(db)
})

describe('rate lookup', () => {
  test('a priced product carries both figures, in minor units', () => {
    const f = assetFacts(db, 'asset-fx9-1')
    assert.equal(f.dayRateMinor, 25_000 * 100)
    assert.equal(f.replacementMinor, 3_500_000 * 100)
    assert.equal(dayRateFor(db, 'prod-fx9'), 25_000 * 100)
  })

  test('an unpriced product answers null everywhere — no rate is not Rs 0', () => {
    // Sachdeva Tripod and the C-Stands are seeded without rates on purpose.
    const f = assetFacts(db, 'asset-sachdeva-1')
    assert.equal(f.dayRateMinor, null)
    assert.equal(f.replacementMinor, null)
    assert.equal(dayRateFor(db, 'prod-sachdeva'), null)
    assert.equal(dayRateFor(db, 'prod-does-not-exist'), null)
  })
})

describe('the dueBoard money column', () => {
  test('a job holding priced gear totals its replacement value', () => {
    // The seed sends one FX6 out on job-doc.
    const row = dueBoard(db, Date.now()).outJobs.find((j) => j.id === 'job-doc')
    assert.ok(row)
    assert.deepEqual(row.value, {
      totalMinor: 2_200_000 * 100,
      priced: 1,
      unpriced: 0,
    })
    assert.equal(moneyLabel(row.value), 'Rs 2,200,000')
  })

  test('unpriced items raise the unpriced count, never the total', () => {
    db.exec(`update assets set presence = 'out', current_job_id = 'job-doc'
              where id in ('asset-sachdeva-1', 'asset-cstand-1')`)
    const row = dueBoard(db, Date.now()).outJobs.find((j) => j.id === 'job-doc')
    assert.deepEqual(row.value, {
      totalMinor: 2_200_000 * 100,
      priced: 1,
      unpriced: 2,
    })
    assert.equal(moneyLabel(row.value), 'Rs 2,200,000 +2 unpriced')
  })

  test('a job of entirely unpriced gear has a count and no money', () => {
    db.exec(`insert into jobs (id, org_id, label, status)
             values ('job-u', 'demo-org', 'Unpriced', 'open')`)
    db.exec(`update assets set presence = 'out', current_job_id = 'job-u'
              where id = 'asset-cstand-2'`)
    const row = dueBoard(db, Date.now()).outJobs.find((j) => j.id === 'job-u')
    assert.equal(row.out, 1)
    assert.deepEqual(row.value, { totalMinor: 0, priced: 0, unpriced: 1 })
    assert.equal(moneyLabel(row.value), null)
  })
})
