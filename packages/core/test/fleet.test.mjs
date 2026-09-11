/**
 * The fleet lifecycle — terminal states, the swap, and the ginti diff
 * (fleet.ts; migration 0020).
 *
 * The properties that matter offline:
 *   - a terminal mark queues ONE append-only op and projects gone +
 *     disposition + OFF THE JOB (the line that lets a ghost job close);
 *   - found is the reverse, and clears the disposition;
 *   - a swap is atomic: three linked ops, the substitute out on the same
 *     job, the broken item home and quarantined, refusals writing nothing;
 *   - the cycle-count diff buckets seen against expected without touching
 *     the world.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { markTerminal, markFound, swapAsset, cycleCountDiff } from '../src/fleet.ts'

let db
let seq

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  db.exec(`insert into products (id, org_id, display_name) values ('p1','o','Sony FX9')`)
  db.exec(`insert into jobs (id, org_id, label, status) values ('j1','o','TVC','open')`)
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, presence, health, current_job_id)
     values ('broken','o','p1','FX9-01','out','ok','j1')`,
  )
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, presence, health)
     values ('sub','o','p1','FX9-02','here','ok')`,
  )
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, presence, health)
     values ('cable','o','p1','XLR-01','out','ok')`,
  )
  db.exec(`update assets set current_job_id = 'j1' where id = 'cable'`)
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, presence, health)
     values ('spare','o','p1','FX9-Q','here','quarantined')`,
  )
  seq = 0
})

const ids = () => `id-${++seq}`
const opCount = () =>
  Number(db.get(`select count(*) as n from outbox where op = 'submit_scan_batch'`).n)

describe('marking gear terminal', () => {
  test('mark_lost queues one op and projects gone + lost + off the job', () => {
    const r = markTerminal(db, {
      assetId: 'cable', disposition: 'lost', note: 'Paid for, never came back',
      now: () => 1000, newId: ids,
    })
    assert.equal(r.assetId, 'cable')
    assert.equal(opCount(), 1)
    const a = db.get(`select presence, disposition, current_job_id from assets where id = 'cable'`)
    assert.equal(a.presence, 'gone')
    assert.equal(a.disposition, 'lost')
    assert.equal(a.current_job_id, null)
  })

  test('mark_stolen and mark_sold each stamp their disposition', () => {
    markTerminal(db, { assetId: 'broken', disposition: 'stolen', newId: ids })
    assert.equal(db.get(`select disposition from assets where id='broken'`).disposition, 'stolen')

    markTerminal(db, { assetId: 'sub', disposition: 'sold', saleAmountMinor: 120_000_00, newId: ids })
    assert.equal(db.get(`select disposition from assets where id='sub'`).disposition, 'sold')
  })

  test('a sale amount rides the op payload, not any money book', () => {
    markTerminal(db, { assetId: 'sub', disposition: 'sold', saleAmountMinor: 5_000_00, newId: ids })
    const row = db.get(`select payload from outbox where op='submit_scan_batch'`)
    const p = JSON.parse(row.payload)
    assert.equal(p.event_type, 'mark_sold')
    assert.equal(p.sale_amount_minor, 5_000_00)
  })

  test('found brings a lost item home and clears the disposition', () => {
    markTerminal(db, { assetId: 'cable', disposition: 'lost', newId: ids })
    markFound(db, { assetId: 'cable', newId: ids })
    const a = db.get(`select presence, disposition from assets where id='cable'`)
    assert.equal(a.presence, 'here')
    assert.equal(a.disposition, null)
    assert.equal(opCount(), 2) // both writes kept — append-only
  })

  test('retire uses the existing verb and stamps retired', () => {
    markTerminal(db, { assetId: 'sub', disposition: 'retired', newId: ids })
    const a = db.get(`select presence, disposition from assets where id='sub'`)
    assert.equal(a.presence, 'gone')
    assert.equal(a.disposition, 'retired')
    assert.equal(JSON.parse(db.get(`select payload from outbox`).payload).event_type, 'retire')
  })
})

describe('the crisis-day swap', () => {
  test('records three linked ops, substitute out on the same job, broken home + flagged', () => {
    const r = swapAsset(db, {
      jobId: 'j1', brokenAssetId: 'broken', substituteAssetId: 'sub',
      note: 'Dropped on set', now: () => 2000, newId: ids,
    })
    assert.equal(r.outcome, 'swapped')
    assert.equal(opCount(), 3)

    const broken = db.get(`select presence, health, current_job_id from assets where id='broken'`)
    assert.equal(broken.presence, 'here')
    assert.equal(broken.health, 'quarantined')
    assert.equal(broken.current_job_id, null)

    const sub = db.get(`select presence, current_job_id from assets where id='sub'`)
    assert.equal(sub.presence, 'out')
    assert.equal(sub.current_job_id, 'j1')

    // One session across all three; the two consequences depend on the check_in.
    const rows = db.all(`select id, payload, depends_on from outbox order by seq`)
    const sessions = new Set(rows.map((x) => JSON.parse(x.payload).session_id))
    assert.equal(sessions.size, 1)
    assert.equal(rows[1].depends_on, r.checkedInEvent)
    assert.equal(rows[2].depends_on, r.checkedInEvent)
    // The substitute checkout names the unit it replaces.
    const out = JSON.parse(rows[2].payload)
    assert.equal(out.replaces_asset_id, 'broken')
  })

  test('quarantine flag is honoured', () => {
    const r = swapAsset(db, {
      jobId: 'j1', brokenAssetId: 'broken', substituteAssetId: 'sub',
      flag: 'quarantine', newId: ids,
    })
    assert.equal(r.outcome, 'swapped')
    const flagOp = JSON.parse(db.all(`select payload from outbox order by seq`)[1].payload)
    assert.equal(flagOp.event_type, 'quarantine')
  })

  test('refuses a broken item not out on the job, writing nothing', () => {
    const r = swapAsset(db, { jobId: 'j1', brokenAssetId: 'sub', substituteAssetId: 'spare', newId: ids })
    assert.equal(r.outcome, 'not_on_job')
    assert.equal(opCount(), 0)
  })

  test('refuses a terminal, off-shelf or unfit substitute', () => {
    markTerminal(db, { assetId: 'sub', disposition: 'sold', newId: ids })
    const terminal = swapAsset(db, { jobId: 'j1', brokenAssetId: 'broken', substituteAssetId: 'sub', newId: ids })
    assert.deepEqual(terminal, { outcome: 'substitute_unavailable', reason: 'terminal' })

    const unfit = swapAsset(db, { jobId: 'j1', brokenAssetId: 'broken', substituteAssetId: 'spare', newId: ids })
    assert.deepEqual(unfit, { outcome: 'substitute_unavailable', reason: 'unfit' })

    const offShelf = swapAsset(db, { jobId: 'j1', brokenAssetId: 'broken', substituteAssetId: 'cable', newId: ids })
    assert.deepEqual(offShelf, { outcome: 'substitute_unavailable', reason: 'off_shelf' })
    assert.equal(opCount(), 1) // only the mark_sold above
  })

  test('an item cannot substitute for itself', () => {
    const r = swapAsset(db, { jobId: 'j1', brokenAssetId: 'broken', substituteAssetId: 'broken', newId: ids })
    assert.equal(r.outcome, 'same_asset')
    assert.equal(opCount(), 0)
  })
})

describe('the cycle-count diff', () => {
  test('buckets seen against expected', () => {
    const d = cycleCountDiff(['a', 'b', 'c'], ['a', 'b', 'x'])
    assert.deepEqual(d.ok.sort(), ['a', 'b'])
    assert.deepEqual(d.missing, ['c'])
    assert.deepEqual(d.unexpected, ['x'])
  })

  test('an empty shelf scanned clean is all ok', () => {
    const d = cycleCountDiff(['a', 'b'], ['a', 'b'])
    assert.deepEqual(d.missing, [])
    assert.deepEqual(d.unexpected, [])
    assert.equal(d.ok.length, 2)
  })

  test('reads nothing and writes nothing — pure set logic', () => {
    // No db argument at all: a diff is a report, never a mutation.
    const d = cycleCountDiff([], ['surprise'])
    assert.deepEqual(d.unexpected, ['surprise'])
    assert.deepEqual(d.ok, [])
  })
})

// --- network (0025 D5) ------------------------------------------------------
describe('retiring a borrowed unit', () => {
  test('retire on ownership=sub_rented_in stamps returned_to_owner, never retired', () => {
    db.exec(
      `insert into assets (id, org_id, product_id, asset_code, presence, health, ownership)
       values ('loaner','o','p1','FX9-L1','here','ok','sub_rented_in')`,
    )
    markTerminal(db, { assetId: 'loaner', disposition: 'retired', newId: ids })
    const a = db.get(`select presence, disposition from assets where id='loaner'`)
    assert.equal(a.presence, 'gone')
    assert.equal(a.disposition, 'returned_to_owner')
    // The op on the wire is the plain retire verb — the server derives the
    // same word from ownership; the phone invents no vocabulary.
    const op = JSON.parse(db.get(`select payload from outbox order by seq desc limit 1`).payload)
    assert.equal(op.event_type, 'retire')
  })

  test('retire on an owned unit still reads retired', () => {
    markTerminal(db, { assetId: 'sub', disposition: 'retired', newId: ids })
    assert.equal(db.get(`select disposition from assets where id='sub'`).disposition, 'retired')
  })

  test("asking for 'returned_to_owner' by name mints the same retire verb", () => {
    db.exec(
      `insert into assets (id, org_id, product_id, asset_code, presence, health, ownership)
       values ('loaner2','o','p1','FX9-L2','here','ok','sub_rented_in')`,
    )
    markTerminal(db, { assetId: 'loaner2', disposition: 'returned_to_owner', newId: ids })
    assert.equal(db.get(`select disposition from assets where id='loaner2'`).disposition, 'returned_to_owner')
    const op = JSON.parse(db.get(`select payload from outbox order by seq desc limit 1`).payload)
    assert.equal(op.event_type, 'retire')
  })

  test('found clears returned_to_owner like any disposition', () => {
    db.exec(
      `insert into assets (id, org_id, product_id, asset_code, presence, health, ownership)
       values ('loaner3','o','p1','FX9-L3','here','ok','sub_rented_in')`,
    )
    markTerminal(db, { assetId: 'loaner3', disposition: 'retired', newId: ids })
    markFound(db, { assetId: 'loaner3', newId: ids })
    const a = db.get(`select presence, disposition from assets where id='loaner3'`)
    assert.equal(a.presence, 'here')
    assert.equal(a.disposition, null)
  })
})
