/**
 * The standalone health door against a real SQLite (W13,
 * `no-health-door`).
 *
 * The year's JAN dropped FX9 needed SQL, and a lens dropped on the bench
 * with no job behind it had no door at all. What is pinned: each of the
 * three answers is a REAL scan verb through the append-only queue (the
 * evidence rule), the mirror moves optimistically by the one rule
 * project.ts owns, availability stops offering a broken unit at once,
 * and the release brings it back without touching the service meter.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import {
  LOCAL_SCHEMA,
  ScanSession,
  checkAvailability,
  healthFor,
  markHealth,
  markTerminal,
  markFound,
  swapAsset,
} from '@papa/core'
import { seedDemo, demoCatalogue } from '../src/demo/seed.ts'
import { matchKitList, parseKitList } from '@papa/core'
import { openJobCommitments, serviceFacts } from '../src/demo/read-model.ts'

let db
let seed
let seq
const NOW = new Date(2026, 10, 10, 12).getTime()
const ids = () => ({ now: () => NOW, newId: () => `op-${++seq}` })

const healthOf = (assetId) =>
  db.get(`select health, presence from assets where id = ?`, [assetId])
const scanOps = () =>
  db
    .all(`select id, payload, depends_on from outbox where op = 'submit_scan_batch' order by seq`)
    .map((r) => ({ id: r.id, dependsOn: r.depends_on, payload: JSON.parse(r.payload) }))

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  seq = 0
})

describe('the one health rule', () => {
  test('healthFor maps the server\'s own case, and an explicit health wins', () => {
    assert.equal(healthFor({ event_type: 'quarantine' }), 'quarantined')
    assert.equal(healthFor({ event_type: 'send_to_service' }), 'servicing')
    assert.equal(healthFor({ event_type: 'release' }), 'ok')
    assert.equal(healthFor({ event_type: 'return_from_service' }), 'ok')
    assert.equal(healthFor({ event_type: 'flag_damage' }), 'quarantined')
    // The server's coalesce: the event may name its own health.
    assert.equal(healthFor({ event_type: 'flag_damage', health: 'servicing' }), 'servicing')
    assert.equal(healthFor({ event_type: 'found' }), 'ok')
    // Everything else leaves health alone.
    assert.equal(healthFor({ event_type: 'check_out' }), null)
    assert.equal(healthFor({ event_type: 'check_in' }), null)
    assert.equal(healthFor({ event_type: 'serviced' }), null)
    assert.equal(healthFor({ event_type: 'mark_lost' }), null)
    assert.equal(healthFor({}), null)
  })
})

describe('marking a unit broken', () => {
  test('one quarantine event, the mirror off the shelf at once, presence untouched', () => {
    assert.equal(healthOf('asset-fx9-2').health, 'ok')
    const r = markHealth(db, {
      assetId: 'asset-fx9-2', call: 'broken', note: 'Dropped on the bench', ...ids(),
    })
    assert.equal(r.assetId, 'asset-fx9-2')

    const row = healthOf('asset-fx9-2')
    assert.equal(row.health, 'quarantined')
    assert.equal(row.presence, 'here', 'health is not a movement')

    const ops = scanOps()
    const mine = ops.find((o) => o.id === r.outboxId)
    assert.equal(mine.payload.event_type, 'quarantine')
    assert.equal(mine.payload.asset_id, 'asset-fx9-2')
    assert.equal(mine.payload.entry_method, 'manual')
    assert.equal(mine.payload.note, 'Dropped on the bench')
    assert.equal(mine.payload.device_time, new Date(NOW).toISOString())
    assert.equal(mine.dependsOn, null)
  })

  test('the shelf stops offering it — availability honesty, with no sync', () => {
    const ask = (n) =>
      checkAvailability(
        db,
        matchKitList(parseKitList(`${n}x Sony FX9`), demoCatalogue()),
        openJobCommitments(db),
        NOW,
      ).lines[0]
    const before = ask(1).onHand
    markHealth(db, { assetId: 'asset-fx9-2', call: 'broken', ...ids() })
    assert.equal(ask(1).onHand, before - 1, 'a broken body is not on hand')
  })

  test('a blank note leaves the payload without one, rather than an empty string', () => {
    const r = markHealth(db, { assetId: 'asset-fx9-2', call: 'broken', note: '   ', ...ids() })
    const mine = scanOps().find((o) => o.id === r.outboxId)
    assert.equal('note' in mine.payload, false)
  })
})

describe('needs a look, and back again', () => {
  test('send_to_service parks it in the workshop; release brings it back', () => {
    markHealth(db, { assetId: 'asset-fx9-2', call: 'needs_a_look', note: 'Odd noise', ...ids() })
    assert.equal(healthOf('asset-fx9-2').health, 'servicing')

    markHealth(db, { assetId: 'asset-fx9-2', call: 'ok', note: 'Bench-checked, fine', ...ids() })
    assert.equal(healthOf('asset-fx9-2').health, 'ok')

    const kinds = scanOps().map((o) => o.payload.event_type)
    assert.ok(kinds.includes('send_to_service'))
    assert.ok(kinds.includes('release'))
  })

  test('a release does NOT reset the service meter — two decisions, two taps', () => {
    // Put real rental days on the meter through a full out-and-in.
    const out = new ScanSession(db, {
      deviceId: 'phone-1', jobId: 'job-shan', expected: new Set(['asset-fx9-1']),
      now: () => NOW, newId: () => `s-${++seq}`,
    })
    out.addManually('asset-fx9-1', 'check_out')
    const back = new ScanSession(db, {
      deviceId: 'phone-1', jobId: 'job-shan', expected: new Set(['asset-fx9-1']),
      now: () => NOW + 86_400_000 * 2, newId: () => `s-${++seq}`,
    })
    back.addManually('asset-fx9-1', 'check_in')
    const meter = serviceFacts(db, 'asset-fx9-1').daysSinceService
    assert.ok(meter > 0, `${meter} rental days on the meter`)

    markHealth(db, { assetId: 'asset-fx9-1', call: 'broken', ...ids() })
    markHealth(db, { assetId: 'asset-fx9-1', call: 'ok', ...ids() })
    assert.equal(
      serviceFacts(db, 'asset-fx9-1').daysSinceService, meter,
      'quarantine and release own health and nothing else (0021 D2)',
    )
  })
})

describe('the health rule has one home', () => {
  test('the swap quarantines the broken item through the reducer, not by hand', () => {
    // The swap used to write `health = 'quarantined'` beside its ops; the
    // rule is project.ts's now, and the swap must still work.
    const out = new ScanSession(db, {
      deviceId: 'phone-1', jobId: 'job-shan', expected: new Set(['asset-fx9-1']),
      now: () => NOW, newId: () => `s-${++seq}`,
    })
    out.addManually('asset-fx9-1', 'check_out')
    const r = swapAsset(db, {
      jobId: 'job-shan',
      brokenAssetId: 'asset-fx9-1',
      substituteAssetId: 'asset-fx9-2',
      note: 'Mount cracked on set',
      now: () => NOW + 1000,
      newId: () => `sw-${++seq}`,
    })
    assert.equal(r.outcome, 'swapped')
    assert.equal(healthOf('asset-fx9-1').health, 'quarantined')
    assert.equal(healthOf('asset-fx9-2').presence, 'out')
  })

  test('found brings a terminal unit home healthy, in one update', () => {
    markHealth(db, { assetId: 'asset-fx9-2', call: 'broken', ...ids() })
    markTerminal(db, {
      assetId: 'asset-fx9-2', disposition: 'lost',
      now: () => NOW, newId: () => `t-${++seq}`,
    })
    assert.equal(healthOf('asset-fx9-2').presence, 'gone')

    markFound(db, { assetId: 'asset-fx9-2', now: () => NOW + 1, newId: () => `f-${++seq}` })
    const row = healthOf('asset-fx9-2')
    assert.equal(row.presence, 'here')
    assert.equal(row.health, 'ok', 'found clears the disposition AND the damage (0020 D1)')
  })

  test('a check_out of a healthy unit leaves health alone', () => {
    const out = new ScanSession(db, {
      deviceId: 'phone-1', jobId: 'job-shan', expected: new Set(['asset-fx9-1']),
      now: () => NOW, newId: () => `s-${++seq}`,
    })
    out.addManually('asset-fx9-1', 'check_out')
    assert.equal(healthOf('asset-fx9-1').health, 'ok')
  })
})
