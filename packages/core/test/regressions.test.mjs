/**
 * Regressions.
 *
 * Every test here corresponds to a defect that was live in the engine and was
 * found by review rather than by a failing test — which is the point. Each of
 * these was possible because the rule it protects lived in two places, or
 * because a value was written without comparing it to what was already there.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { PullApplier } from '../src/pull.ts'
import { ScanSession } from '../src/scan.ts'
import { metaGetNumber, metaSet } from '../src/meta.ts'

const ORG = 'org-1'
let db
let ids = 0
const newId = () => `id-${String(++ids).padStart(4, '0')}`

const page = (tables, cursor = 100) => ({
  cursor,
  has_more: false,
  server_time: new Date().toISOString(),
  tables,
})

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  ids = 0
})

function seedAsset(extra = {}) {
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, presence, last_scanned_at)
     values (?, ?, ?, ?, ?, ?)`,
    ['a1', ORG, 'p1', 'FX9-02', extra.presence ?? 'here', extra.last_scanned_at ?? null],
  )
  db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('T1', 'a1', 'active')`)
}

describe('the pull cursor only moves forward', () => {
  // Was: apply() wrote payload.cursor unconditionally. A retried or
  // out-of-order page rewound the watermark and re-pulled everything after it.
  // pull.ts's own header calls a duplicate page "a routine Tuesday" on a phone
  // with an aggressive battery killer, so this was reachable in normal use.
  test('an older page does not rewind the watermark', () => {
    const applier = new PullApplier(db)
    applier.apply(page({}, 500))
    assert.equal(applier.cursor(), 500)

    const report = applier.apply(page({}, 120))
    assert.equal(applier.cursor(), 500, 'cursor must not go backwards')
    assert.equal(report.cursor, 500, 'and the report states the real cursor')
  })

  test('a newer page still advances it', () => {
    const applier = new PullApplier(db)
    applier.apply(page({}, 500))
    applier.apply(page({}, 900))
    assert.equal(applier.cursor(), 900)
  })
})

describe('a pull does not undo the local scan timestamp', () => {
  // Was: ScanSession set last_scanned_at, the pull replay did not, and
  // last_scanned_at IS a mirrored column. So every pull overwrote the tech's
  // own scan time with the server's older one and never put it back — the
  // "your own scan undoes itself" bug surviving in a single column, because
  // the projection rule was written in two places and drifted.
  test('the optimistic scan survives a pull that carries a stale server row', () => {
    seedAsset()
    const session = new ScanSession(db, { deviceId: 'dev-1', jobId: 'job-1', newId })
    session.scan('T1', 'check_out')

    const afterScan = db.get(`select presence, current_job_id, last_scanned_at from assets where id = 'a1'`)
    assert.equal(afterScan.presence, 'out')
    assert.ok(afterScan.last_scanned_at, 'the scan stamps a time')

    // The server has not seen the scan yet: it still thinks the asset is here,
    // with an older timestamp.
    new PullApplier(db).apply(
      page({
        assets: [{
          id: 'a1', org_id: ORG, product_id: 'p1', asset_code: 'FX9-02',
          presence: 'here', current_job_id: null,
          last_scanned_at: '2000-01-01T00:00:00.000Z',
        }],
      }),
    )

    const afterPull = db.get(`select presence, current_job_id, last_scanned_at from assets where id = 'a1'`)
    assert.equal(afterPull.presence, 'out', 'presence is protected')
    assert.equal(afterPull.current_job_id, 'job-1', 'the job is protected')
    assert.equal(
      afterPull.last_scanned_at,
      afterScan.last_scanned_at,
      'and so is the scan timestamp — this is the column that used to be lost',
    )
  })
})

describe('sync_meta coercion', () => {
  // Was: `row?.value ? Number(row.value) : 0` in Outbox.nextSeq. "0" is falsy,
  // so a legitimately stored zero read as absent. Harmless for a counter that
  // starts at 1, and a trap for any key that can hold zero — pull_cursor can.
  test('a stored zero reads back as zero, not as missing', () => {
    metaSet(db, 'k', 0)
    assert.equal(metaGetNumber(db, 'k', 999), 0)
  })

  test('a genuinely absent key falls back', () => {
    assert.equal(metaGetNumber(db, 'nope', 999), 999)
  })

  test('a corrupt value falls back rather than yielding NaN', () => {
    metaSet(db, 'k', 'not-a-number')
    assert.equal(metaGetNumber(db, 'k', 7), 7)
  })
})
