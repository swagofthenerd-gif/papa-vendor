/**
 * Scanning a case.
 *
 * This is the plan's override #1 and the decision the product's honesty rests
 * on. The failure it prevents is concrete: a battery plate is taken out of a
 * case on Tuesday and never scanned back in. On Friday the case goes out. If a
 * case scan records its contents automatically, the system then states — with
 * a timestamp and a named actor — that Friday's client took that plate, and
 * uses it against them when it does not come back.
 *
 * The client is right. The database is lying. Nothing downstream can tell.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { caseManifest, hasContents } from '../src/containment.ts'
import { ScanSession } from '../src/scan.ts'

let db

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  db.exec(`insert into products (id, org_id, display_name) values ('pc','o','A-Cam Case')`)
  db.exec(`insert into products (id, org_id, display_name) values ('pb','o','Sony FX9')`)
  db.exec(`insert into products (id, org_id, display_name) values ('pl','o','Sigma 18-35mm')`)
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, is_container, presence, health)
     values ('case','o','pc','CASE-01',1,'here','ok'),
            ('body','o','pb','FX9-01',0,'here','ok'),
            ('lens','o','pl','SG-01',0,'here','ok'),
            ('plate','o','pl','PL-01',0,'here','ok')`,
  )
  db.exec(
    `insert into asset_containment (parent_asset_id, child_asset_id, kind)
     values ('case','body','permanent'), ('case','lens','packed'), ('case','plate','packed')`,
  )
})

describe('the manifest', () => {
  test('splits what is welded on from what is merely believed to be inside', () => {
    const m = caseManifest(db, 'case')
    assert.equal(m.permanent.length, 1)
    assert.equal(m.permanent[0].assetId, 'body')
    assert.equal(m.packed.length, 2)
  })

  test('names every child, because a list of ids is not a manifest', () => {
    const m = caseManifest(db, 'case')
    for (const c of [...m.permanent, ...m.packed]) {
      assert.ok(c.displayName, 'has a name')
      assert.ok(c.assetCode, 'has a code')
    }
  })

  test('an item with nothing inside opens no manifest', () => {
    assert.equal(hasContents(db, 'lens'), false)
    assert.equal(hasContents(db, 'case'), true)
  })

  test('an unknown parent returns nothing rather than an empty case', () => {
    assert.equal(caseManifest(db, 'nope'), null)
  })
})

describe('what a case scan is allowed to record', () => {
  test('packed contents are NOT recorded by scanning the case', () => {
    // THE RULE. Scanning the case records the case. Everything believed to be
    // inside it stays unconfirmed until a person acts.
    const session = new ScanSession(db, { deviceId: 'd', jobId: 'j1' })
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1CASE','case','active')`)

    session.scan('v1CASE')

    assert.deepEqual(session.scannedIds, ['case'], 'only the case')
    const events = db.all(`select payload from outbox where op = 'submit_scan_batch'`)
    const ids = events.map((e) => JSON.parse(e.payload).asset_id)
    assert.ok(!ids.includes('lens'), 'the lens was not recorded')
    assert.ok(!ids.includes('plate'), 'the plate was not recorded')
  })

  test('bulk-confirming marks them assumed, never scanned', () => {
    // Countable, visible on the manifest, and excluded from dispute evidence.
    // If these passed as scans there would be no way to tell an observation
    // from a belief, which is the whole distinction.
    const session = new ScanSession(db, { deviceId: 'd', jobId: 'j1' })
    const m = caseManifest(db, 'case')
    const results = session.confirmContents(m.packed.map((c) => c.assetId))

    assert.equal(results.length, 2)
    for (const r of results) {
      assert.equal(r.outcome, 'accepted')
      // Named. A bulk-confirm row used to come back as a bare id and rendered
      // as "Unknown item" on the one screen whose job is showing you what you
      // took on trust.
      assert.ok(r.displayName, 'the row can name itself')
      assert.ok(r.assetCode, 'and carries its code')
    }

    const methods = db
      .all(`select payload from outbox where op = 'submit_scan_batch'`)
      .map((e) => JSON.parse(e.payload))
      .filter((p) => p.asset_id === 'lens' || p.asset_id === 'plate')
      .map((p) => p.entry_method)

    assert.deepEqual(methods, ['assumed', 'assumed'])
  })

  test('a child scanned properly is not downgraded by a later bulk confirm', () => {
    // The tech scanned the lens, then bulk-confirmed the rest. The lens must
    // stay an observation — a real scan outranks a belief about the same item.
    const session = new ScanSession(db, { deviceId: 'd', jobId: 'j1' })
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1LENS','lens','active')`)
    session.scan('v1LENS')

    const results = session.confirmContents(['lens', 'plate'])
    assert.equal(results.find((r) => r.assetId === 'lens').outcome, 'duplicate')

    const lensMethods = db
      .all(`select payload from outbox where op = 'submit_scan_batch'`)
      .map((e) => JSON.parse(e.payload))
      .filter((p) => p.asset_id === 'lens')
      .map((p) => p.entry_method)

    assert.deepEqual(lensMethods, ['scanned'], 'one record, and it is the real one')
  })
})
