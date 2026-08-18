/**
 * Attaching a label to an item.
 *
 * This is how a house gets tagged at all, so it runs thousands of times in the
 * first week, by whoever is free, on a phone, standing at a rack. Everything
 * it gets wrong is silent and permanent: a label bound to the wrong camera
 * answers confidently for the rest of its life.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { ScanSession } from '../src/scan.ts'

let db
let session

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  db.exec(`insert into products (id, org_id, display_name) values ('p1','o','Sony FX9')`)
  db.exec(`insert into products (id, org_id, display_name) values ('p2','o','Canon C300 Mark III')`)
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, presence, health)
     values ('a1','o','p1','FX9-01','here','ok'), ('a2','o','p2','C300-01','here','ok')`,
  )
  session = new ScanSession(db, { deviceId: 'd1', jobId: null })
})

describe('binding a label', () => {
  test('the label resolves on the very next scan', () => {
    // A tech who rescans what they just tagged and gets "unknown" concludes it
    // did not work, and does it again.
    const r = session.bindTag('v1NEWLABEL', 'a1')
    assert.equal(r.outcome, 'accepted')

    const fresh = new ScanSession(db, { deviceId: 'd1', jobId: null })
    const scan = fresh.scan('v1NEWLABEL')
    assert.equal(scan.outcome, 'accepted')
    assert.equal(scan.assetId, 'a1')
  })

  test('it is queued for the server, not only written locally', () => {
    session.bindTag('v1NEWLABEL', 'a1')
    const op = db.get(`select op, payload from outbox where op = 'bind_tag'`)
    assert.ok(op, 'queued')
    const payload = JSON.parse(op.payload)
    assert.equal(payload.tag_code, 'v1NEWLABEL')
    assert.equal(payload.asset_id, 'a1')
  })

  test('refuses to move a label that is already on something else', () => {
    // THE ONE THAT MATTERS. Silently rebinding transfers the tag's entire
    // history to a different camera, and every past scan of the old one now
    // reads as the new one.
    session.bindTag('v1LABEL', 'a1')
    const r = session.bindTag('v1LABEL', 'a2')

    assert.equal(r.outcome, 'conflict')
    assert.match(r.message, /already on/)
    assert.match(r.message, /Sony FX9/, 'names what it is already on')

    const row = db.get(`select asset_id from asset_tags where tag_code = 'v1LABEL'`)
    assert.equal(row.asset_id, 'a1', 'and nothing moved')
  })

  test('rebinding the same label to the same item is harmless', () => {
    // Happens constantly: a tech is not sure the first one took.
    session.bindTag('v1LABEL', 'a1')
    assert.equal(session.bindTag('v1LABEL', 'a1').outcome, 'accepted')
    const n = db.get(`select count(*) as n from asset_tags where tag_code = 'v1LABEL'`).n
    assert.equal(Number(n), 1, 'one row, not two')
  })

  test('binding to an item this device has never synced is refused', () => {
    const r = session.bindTag('v1LABEL', 'no-such-asset')
    assert.equal(r.outcome, 'unknown_tag')
    const row = db.get(`select asset_id from asset_tags where tag_code = 'v1LABEL'`)
    assert.equal(row, undefined, 'nothing was written')
  })

  test('a second label on one item is allowed', () => {
    // Real: a case gets a label and so does the body inside it, and gear that
    // loses a sticker gets a replacement before the old one is peeled off.
    assert.equal(session.bindTag('v1FIRST', 'a1').outcome, 'accepted')
    assert.equal(session.bindTag('v1SECOND', 'a1').outcome, 'accepted')
    const n = db.get(`select count(*) as n from asset_tags where asset_id = 'a1'`).n
    assert.equal(Number(n), 2)
  })
})
