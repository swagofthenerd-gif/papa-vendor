/**
 * Looking a label up.
 *
 * THE RULE UNDER TEST: a lookup asserts nothing about the physical world, so
 * it writes NOTHING — no outbox op, no projection change, no session. The
 * defect this pins down: "Just scan" used to run a real check-in session, so
 * scanning an item to ask WHERE it was quietly marked it RETURNED.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { lookupTag } from '../src/scan.ts'

let db

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  db.exec(`insert into products (id, org_id, display_name) values ('p1','o','Sony FX9')`)
  db.exec(`insert into jobs (id, org_id, label, status) values ('j1','o','Zindagi Films','open')`)
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, presence, health, current_job_id)
     values ('a1','o','p1','FX9-01','out','ok','j1')`,
  )
  db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1LIVE','a1','active')`)
  db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1OLD','a1','retired')`)
  db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1GONE','a1','lost')`)
  // A tag bound on another device: the row synced, the asset has not yet.
  db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1STALE','a9','active')`)
})

describe('resolving a label without recording anything', () => {
  test('an active label answers with the item', () => {
    const r = lookupTag(db, 'v1LIVE')
    assert.equal(r.kind, 'found')
    assert.equal(r.assetId, 'a1')
    assert.equal(r.assetCode, 'FX9-01')
    assert.equal(r.displayName, 'Sony FX9')
  })

  test('a label this phone has never seen is unknown', () => {
    assert.deepEqual(lookupTag(db, 'v1NEVER'), { kind: 'unknown_tag' })
  })

  test('a label on an asset not yet synced is a stale mirror, not a fresh label', () => {
    // The same split scan() makes: the tech can act on the difference — an
    // unknown TAG usually means a fresh label, an unknown ITEM a stale mirror.
    assert.deepEqual(lookupTag(db, 'v1STALE'), { kind: 'unknown_item' })
  })

  test('a retired or lost label never resolves with confidence', () => {
    // The label keeps its asset_id — that IS the historical record — but a
    // peeled sticker found on the floor answers as whatever it USED to be on.
    assert.deepEqual(lookupTag(db, 'v1OLD'), { kind: 'retired', status: 'retired' })
    assert.deepEqual(lookupTag(db, 'v1GONE'), { kind: 'retired', status: 'lost' })
  })

  test('THE POINT: no lookup writes anything, anywhere', () => {
    for (const code of ['v1LIVE', 'v1NEVER', 'v1STALE', 'v1OLD', 'v1GONE']) {
      lookupTag(db, code)
    }

    const queued = db.get(`select count(*) as n from outbox`)
    assert.equal(Number(queued.n), 0, 'nothing was queued for the server')

    // And the projection did not move: the camera is still out on its job.
    // A check_in here is exactly the old defect — asking marked it returned.
    const a = db.get(`select presence, current_job_id from assets where id = 'a1'`)
    assert.equal(a.presence, 'out')
    assert.equal(a.current_job_id, 'j1')
  })
})
