/**
 * Applying a pull to the local mirrors.
 *
 * The headline behaviour: a pull must never make a tech watch their own scan
 * undo itself. That is the moment a person decides the app is unreliable, and
 * from then on they check the shelf instead.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { PullApplier } from '../src/pull.ts'
import { Outbox } from '../src/outbox.ts'
import { ScanSession } from '../src/scan.ts'

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

describe('applying a page', () => {
  test('inserts rows into the mirrors', () => {
    const report = new PullApplier(db).apply(
      page({
        products: [{ id: 'p1', org_id: ORG, display_name: 'Sony FX9', category: 'camera' }],
        assets: [{ id: 'a1', org_id: ORG, product_id: 'p1', asset_code: 'FX9-02', presence: 'here' }],
        asset_tags: [{ tag_code: 'v1-a1', asset_id: 'a1', status: 'active' }],
      }),
    )

    assert.equal(report.upserted, 3)
    assert.equal(db.get(`select asset_code from assets where id = 'a1'`).asset_code, 'FX9-02')
    assert.equal(db.get(`select asset_id from asset_tags where tag_code = 'v1-a1'`).asset_id, 'a1')
  })

  test('updates a row that already exists', () => {
    const applier = new PullApplier(db)
    applier.apply(page({ assets: [{ id: 'a1', org_id: ORG, asset_code: 'FX9-02', presence: 'here' }] }))
    applier.apply(page({ assets: [{ id: 'a1', org_id: ORG, asset_code: 'FX9-02', presence: 'out' }] }, 200))

    assert.equal(db.get(`select presence from assets where id = 'a1'`).presence, 'out')
    assert.equal(db.all(`select id from assets`).length, 1, 'updated, not duplicated')
  })

  test('is idempotent — replaying a page changes nothing', () => {
    // A page can arrive twice: the response was received but the app was
    // killed before the cursor was persisted. On a warehouse phone with an
    // aggressive OEM battery killer that is a routine Tuesday.
    const applier = new PullApplier(db)
    const p = page({ assets: [{ id: 'a1', org_id: ORG, asset_code: 'FX9-02', presence: 'here' }] })
    applier.apply(p)
    applier.apply(p)
    assert.equal(db.all(`select id from assets`).length, 1)
  })

  test('advances and persists the cursor', () => {
    const applier = new PullApplier(db)
    assert.equal(applier.cursor(), 0)
    applier.apply(page({ assets: [] }, 512))
    assert.equal(applier.cursor(), 512)
    assert.equal(new PullApplier(db).cursor(), 512, 'survives a fresh instance')
  })

  test('ignores a table this build does not mirror', () => {
    // The server may add a table before the client knows about it. Erroring
    // there would stop sync entirely for an older build — which is how one
    // deploy bricks every phone that has not updated.
    assert.doesNotThrow(() =>
      new PullApplier(db).apply(page({ some_future_table: [{ id: 'x', org_id: ORG }] })),
    )
  })
})

describe('soft deletes are the tombstones', () => {
  test('a row arriving with deleted_at is removed from the mirror', () => {
    const applier = new PullApplier(db)
    applier.apply(page({ jobs: [{ id: 'j1', org_id: ORG, label: 'Zindagi' }] }))
    assert.equal(db.all(`select id from jobs`).length, 1)

    const report = applier.apply(
      page({ jobs: [{ id: 'j1', org_id: ORG, label: 'Zindagi', deleted_at: '2026-08-12T00:00:00Z' }] }, 200),
    )
    assert.equal(report.deleted, 1)
    assert.equal(db.all(`select id from jobs`).length, 0)
  })

  test('a delete for something never seen locally is harmless', () => {
    assert.doesNotThrow(() =>
      new PullApplier(db).apply(page({ jobs: [{ id: 'ghost', org_id: ORG, deleted_at: 'x' }] })),
    )
  })
})

describe('THE HEADLINE: a pull must not undo an unsent scan', () => {
  function withPendingScan() {
    const applier = new PullApplier(db)
    applier.apply(
      page({
        products: [{ id: 'p1', org_id: ORG, display_name: 'Sony FX9', category: 'camera' }],
        assets: [{ id: 'a1', org_id: ORG, product_id: 'p1', asset_code: 'FX9-02', presence: 'here' }],
        asset_tags: [{ tag_code: 'v1-a1', asset_id: 'a1', status: 'active' }],
        jobs: [{ id: 'job-a', org_id: ORG, label: 'Zindagi Films' }],
      }),
    )

    const session = new ScanSession(db, { deviceId: 'WH-01', jobId: 'job-a', newId })
    session.scan('v1-a1')
    return applier
  }

  test('the scan is optimistically applied', () => {
    withPendingScan()
    assert.equal(db.get(`select presence from assets where id = 'a1'`).presence, 'out')
  })

  test('a pull carrying the server\'s STALE view does not revert it', () => {
    const applier = withPendingScan()

    // The server has not seen the scan yet, so it still says 'here'.
    const report = applier.apply(
      page({ assets: [{ id: 'a1', org_id: ORG, product_id: 'p1', asset_code: 'FX9-02', presence: 'here' }] }, 300),
    )

    assert.equal(
      db.get(`select presence from assets where id = 'a1'`).presence,
      'out',
      'the tech must not watch their own scan undo itself on screen',
    )
    assert.deepEqual(report.protectedAssets, ['a1'])
    assert.equal(db.get(`select current_job_id from assets where id = 'a1'`).current_job_id, 'job-a')
  })

  test('once the write is acked, the server view takes over again', () => {
    const applier = withPendingScan()
    const outbox = new Outbox(db)
    outbox.ack(db.all(`select id from outbox`).map((r) => r.id))
    assert.equal(outbox.pendingCount(), 0)

    // The asset genuinely came back, and the server says so.
    applier.apply(
      page({ assets: [{ id: 'a1', org_id: ORG, product_id: 'p1', asset_code: 'FX9-02', presence: 'here' }] }, 400),
    )
    assert.equal(db.get(`select presence from assets where id = 'a1'`).presence, 'here')
  })

  test('other fields from the server still land on a protected asset', () => {
    // Protection covers the fields the pending write owns, not the whole row.
    // A serial number corrected at the desk must still reach the device.
    const applier = withPendingScan()
    applier.apply(
      page({
        assets: [{
          id: 'a1', org_id: ORG, product_id: 'p1', asset_code: 'FX9-02',
          serial_number: '1000345', presence: 'here',
        }],
      }, 300),
    )

    const a = db.get(`select presence, serial_number from assets where id = 'a1'`)
    assert.equal(a.presence, 'out', 'local truth held')
    assert.equal(a.serial_number, '1000345', 'server truth still applied')
  })

  test('replay order matches scan order', () => {
    const applier = withPendingScan()
    // Same asset scanned back in before anything synced.
    new ScanSession(db, { deviceId: 'WH-01', jobId: 'job-a', newId }).scan('v1-a1', 'check_in')

    applier.apply(
      page({ assets: [{ id: 'a1', org_id: ORG, product_id: 'p1', asset_code: 'FX9-02', presence: 'out' }] }, 500),
    )
    assert.equal(
      db.get(`select presence from assets where id = 'a1'`).presence,
      'here',
      'the LAST unsent write wins, as it did on the screen',
    )
  })

  test('a malformed queue row does not stop the sync', () => {
    const applier = withPendingScan()
    db.exec(`insert into outbox (id, seq, op, payload, state, created_at)
             values ('bad', 9999, 'x', 'not json', 'pending', 0)`)
    assert.doesNotThrow(() => applier.apply(page({ assets: [] }, 600)))
    assert.equal(applier.cursor(), 600)
  })
})

describe('resetting the mirrors', () => {
  test('clears mirrored data and the cursor', () => {
    const applier = new PullApplier(db)
    applier.apply(page({ assets: [{ id: 'a1', org_id: ORG, asset_code: 'FX9-02' }] }, 700))
    applier.resetMirrors()

    assert.equal(db.all(`select id from assets`).length, 0)
    assert.equal(applier.cursor(), 0, 'a full re-sync will follow')
  })

  test('NEVER touches the outbox', () => {
    // Outbox rows exist nowhere else. Clearing them would silently destroy
    // scans the server has never seen — the single most destructive thing
    // this codebase could do.
    const applier = new PullApplier(db)
    applier.apply(page({
      assets: [{ id: 'a1', org_id: ORG, asset_code: 'FX9-02', presence: 'here' }],
      asset_tags: [{ tag_code: 'v1-a1', asset_id: 'a1', status: 'active' }],
    }))
    new ScanSession(db, { deviceId: 'WH-01', jobId: 'job-a', newId }).scan('v1-a1')
    assert.equal(new Outbox(db).pendingCount(), 1)

    applier.resetMirrors()

    assert.equal(new Outbox(db).pendingCount(), 1, 'unsent scans survive a mirror reset')
  })
})
