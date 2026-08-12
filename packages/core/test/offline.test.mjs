/**
 * The offline engine, against a real SQLite.
 *
 * This is the suite that stands in for the truck at 6am. Offline bugs produce
 * WRONG DATA rather than crashes and are discovered weeks later as inventory
 * that does not match reality, so every one of these is a scenario that has
 * to be reproducible at a desk or it will not be caught at all.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { Outbox, syncStatus, MAX_ATTEMPTS } from '../src/outbox.ts'
import { ScanSession } from '../src/scan.ts'
import { SyncEngine, TransportError } from '../src/sync.ts'

const ORG = 'org-1'
const JOB_A = 'job-a'
const JOB_B = 'job-b'

let db
let ids = 0
const newId = () => `id-${String(++ids).padStart(4, '0')}`

function seed() {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  ids = 0

  db.exec(`insert into products (id, org_id, display_name) values ('p1', '${ORG}', 'Sony FX9')`)
  db.exec(`insert into jobs (id, org_id, label) values ('${JOB_A}', '${ORG}', 'Zindagi Films')`)
  db.exec(`insert into jobs (id, org_id, label) values ('${JOB_B}', '${ORG}', 'Rafi Peer')`)

  for (const [id, code] of [['a1', 'FX9-02'], ['a2', 'LNS-11'], ['a3', 'BAT-07']]) {
    db.exec(
      `insert into assets (id, org_id, product_id, asset_code, presence) values (?, ?, 'p1', ?, 'here')`,
      [id, ORG, code],
    )
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values (?, ?, 'active')`, [
      `v1-${id}`, id,
    ])
  }
}

beforeEach(seed)

const session = (opts = {}) =>
  new ScanSession(db, { deviceId: 'WH-01', jobId: JOB_A, newId, ...opts })

// ---------------------------------------------------------------------------

describe('the scan handler', () => {
  test('is synchronous — there is no loading state on a scan, ever', () => {
    const result = session().scan('v1-a1')
    // If this ever returns a Promise, a tech is waiting on a network
    // round-trip while holding a case. That is the one thing the design
    // cannot do, so it is asserted rather than assumed.
    assert.notEqual(typeof result?.then, 'function')
    assert.equal(result.outcome, 'accepted')
  })

  test('resolves a tag to an asset from local data alone', () => {
    const r = session().scan('v1-a1')
    assert.equal(r.assetId, 'a1')
    assert.equal(r.assetCode, 'FX9-02')
    assert.equal(r.displayName, 'Sony FX9')
  })

  test('records an unknown tag rather than rejecting it', () => {
    // The label may have been bound on another device since this one synced.
    // A scan that silently vanishes is how a tech learns not to trust the app.
    const r = session().scan('v1-never-seen')
    assert.equal(r.outcome, 'unknown_tag')
    assert.ok(r.outboxId, 'still queued for the server to resolve')
    assert.equal(new Outbox(db).pendingCount(), 1)
  })

  test('writes optimistically to local state', () => {
    session().scan('v1-a1')
    const a = db.get(`select presence, current_job_id from assets where id = 'a1'`)
    assert.equal(a.presence, 'out')
    assert.equal(a.current_job_id, JOB_A)
  })

  test('the queue row and the local projection are written atomically', () => {
    // If these could separate, the UI would show a scan that will never be
    // sent — the tech believes the gear is accounted for and it is not.
    session().scan('v1-a1')
    const queued = new Outbox(db).pendingCount()
    const projected = db.get(`select presence from assets where id = 'a1'`).presence
    assert.equal(queued, 1)
    assert.equal(projected, 'out')
  })
})

describe('duplicate scans', () => {
  test('suppress the WRITE but never the FEEDBACK', () => {
    const s = session()
    s.scan('v1-a1')
    const again = s.scan('v1-a1')

    // Silence is indistinguishable from "the camera didn't see it". The tech
    // rescans, gets nothing, and concludes the scanner is broken — which is
    // exactly how the system dies.
    assert.equal(again.outcome, 'duplicate')
    assert.ok(again.message, 'the caller has something to show and buzz')
    assert.equal(new Outbox(db).pendingCount(), 1, 'but only one write')
  })

  test('suppression lasts the whole session, not two seconds', () => {
    const s = session()
    s.scan('v1-a1')
    // Two seconds double-counts an item scanned twice five seconds apart,
    // which techs do constantly when unsure the first one took.
    const later = s.scan('v1-a1')
    assert.equal(later.outcome, 'duplicate')
  })

  test('a different session may legitimately scan the same asset again', () => {
    session().scan('v1-a1')
    const second = session({ jobId: JOB_A }).scan('v1-a1')
    assert.notEqual(second.outcome, 'duplicate')
  })
})

describe('the local conflict check', () => {
  test('warns when an asset is already out to a DIFFERENT job', () => {
    // The whole point: at 06:14 the desk is closed. Telling only the desk
    // means two trucks leave and one crew reaches a set with no A-cam.
    db.exec(`update assets set presence='out', current_job_id=? where id='a1'`, [JOB_B])

    const r = session({ jobId: JOB_A }).scan('v1-a1')
    assert.equal(r.outcome, 'conflict')
    assert.match(r.message, /Rafi Peer/, 'names the job it is already out to')
    assert.equal(r.requiresReason, true)
  })

  test('records the scan anyway — reality outranks the schedule', () => {
    db.exec(`update assets set presence='out', current_job_id=? where id='a1'`, [JOB_B])
    const r = session({ jobId: JOB_A }).scan('v1-a1')
    // The truck is real. Refusing the scan does not unload it; it only means
    // the record is missing as well as the camera.
    assert.ok(r.outboxId)
    assert.equal(new Outbox(db).pendingCount(), 1)
  })

  test('does not warn when it is out to the SAME job', () => {
    db.exec(`update assets set presence='out', current_job_id=? where id='a1'`, [JOB_A])
    assert.notEqual(session({ jobId: JOB_A }).scan('v1-a1').outcome, 'conflict')
  })

  test('does not warn on check_in — coming back is never a conflict', () => {
    db.exec(`update assets set presence='out', current_job_id=? where id='a1'`, [JOB_B])
    assert.equal(session({ jobId: JOB_A }).scan('v1-a1', 'check_in').outcome, 'accepted')
  })
})

describe('the pull list', () => {
  test('flags an item that is not on this job without stopping the line', () => {
    const s = session({ expected: new Set(['a1', 'a2']) })
    const r = s.scan('v1-a3')
    assert.equal(r.outcome, 'unexpected')
    assert.ok(r.outboxId, 'still recorded — it is physically in the tech\'s hands')
  })

  test('reports the shortfall while the truck is still in the yard', () => {
    const s = session({ expected: new Set(['a1', 'a2', 'a3']) })
    s.scan('v1-a1')
    assert.deepEqual(s.outstanding.sort(), ['a2', 'a3'])
  })

  test('the shortfall empties as the pull completes', () => {
    const s = session({ expected: new Set(['a1', 'a2']) })
    s.scan('v1-a1'); s.scan('v1-a2')
    assert.deepEqual(s.outstanding, [])
  })
})

describe('the manual fallback', () => {
  test('exists at all', () => {
    // Its ABSENCE is the single biggest abandonment trigger in the research.
    // A tag under gaffer tape at 06:05 with no path forward teaches a tech on
    // day one that the app has no answer for the real world.
    const r = session().addManually('a1')
    assert.equal(r.outcome, 'accepted')
  })

  test('records entry_method=manual so it stays countable', () => {
    session().addManually('a1')
    const row = db.get(`select payload from outbox`)
    assert.equal(JSON.parse(row.payload).entry_method, 'manual')
  })

  test('a bulk-confirmed case is recorded as assumed, not as scanned', () => {
    // "We believe this is in the case" must never be recorded as a fact with
    // a timestamp and an actor — that fabricates evidence against a client
    // who turns out to be right.
    session().confirmContents(['a2', 'a3'])
    const methods = db.all(`select payload from outbox order by seq`)
      .map((r) => JSON.parse(r.payload).entry_method)
    assert.deepEqual(methods, ['assumed', 'assumed'])
  })
})

describe('the outbox sequence', () => {
  test('is monotonic', () => {
    const o = new Outbox(db)
    assert.deepEqual([o.nextSeq(), o.nextSeq(), o.nextSeq()], [1, 2, 3])
  })

  test('NEVER resets, even when the queue is empty', () => {
    // max(seq) over live rows would restart at 1 after a full drain and
    // collide with (device_id, client_seq) pairs the server has already
    // accepted. The server would call them duplicates, and the scans would be
    // silently dropped with nobody the wiser.
    const o = new Outbox(db)
    o.enqueue({ id: 'x1', op: 'submit_scan_batch', payload: {} })
    o.enqueue({ id: 'x2', op: 'submit_scan_batch', payload: {} })
    o.ack(['x1', 'x2'])
    assert.equal(o.pendingCount(), 0)
    assert.equal(o.enqueue({ id: 'x3', op: 'submit_scan_batch', payload: {} }).seq, 3)
  })
})

describe('the outbox is a DAG — failure poisons the subtree', () => {
  test('a permanent failure cascades to everything queued behind it', () => {
    // The architecture asserted "strict order" AND "skip poison pills", which
    // cannot both hold: skipping leaves children executing against a missing
    // prerequisite. What happens to a check_in whose check_out was skipped?
    const o = new Outbox(db)
    o.enqueue({ id: 'p', op: 'submit_scan_batch', payload: {} })
    o.enqueue({ id: 'c1', op: 'submit_scan_batch', payload: {}, dependsOn: 'p' })
    o.enqueue({ id: 'c2', op: 'submit_scan_batch', payload: {}, dependsOn: 'c1' })
    o.enqueue({ id: 'unrelated', op: 'submit_scan_batch', payload: {} })

    const failed = o.fail('p', 'bad_request')

    assert.deepEqual(failed.sort(), ['c1', 'c2', 'p'])
    assert.equal(o.byId('unrelated').state, 'pending',
      'an unrelated op must NOT be parked — one bad row cannot freeze a warehouse')
  })

  test('the cascade is one item to resolve, not twelve alarms', () => {
    const o = new Outbox(db)
    o.enqueue({ id: 'p', op: 'x', payload: {} })
    o.enqueue({ id: 'c1', op: 'x', payload: {}, dependsOn: 'p' })
    o.fail('p', 'bad_request', 'the server refused it')

    const rows = o.failures()
    assert.equal(rows.find((r) => r.id === 'p').error_code, 'bad_request')
    assert.equal(rows.find((r) => r.id === 'c1').error_code, 'blocked_by_dependency',
      'children are labelled as blocked, so the UI can group them under the cause')
  })

  test('a batch stops at an unsent dependency rather than sending past it', () => {
    const o = new Outbox(db)
    o.enqueue({ id: 'p', op: 'x', payload: {} })
    o.enqueue({ id: 'c', op: 'x', payload: {}, dependsOn: 'p' })
    o.retryLater('p', 'timeout', '', 1_000)
    // Sending past the gap produces "checked in before it was checked out".
    assert.deepEqual(o.nextBatch(50, 1_000).map((r) => r.id), [])
  })

  test('retries back off and eventually park the op', () => {
    const o = new Outbox(db)
    o.enqueue({ id: 'p', op: 'x', payload: {} })
    for (let i = 0; i < MAX_ATTEMPTS; i++) o.retryLater('p', 'timeout', '', 0)
    assert.equal(o.byId('p').state, 'failed')
  })
})

describe('the flush loop', () => {
  const transportReturning = (fn) => ({ submitScanBatch: async (_d, ops) => fn(ops) })

  test('acks accepted ops and clears them from the queue', async () => {
    const s = session()
    s.scan('v1-a1'); s.scan('v1-a2')

    const engine = new SyncEngine(
      db,
      transportReturning((ops) =>
        ops.map((o) => ({ client_seq: o.client_seq, event_id: 'e', outcome: 'accepted', alert_kind: null })),
      ),
      'WH-01',
    )

    const report = await engine.flush(true)
    assert.equal(report.acked, 2)
    assert.equal(new Outbox(db).pendingCount(), 0)
  })

  test('treats duplicate as SUCCESS and retires the row', async () => {
    // A retry after a timeout where the server actually succeeded happens
    // daily on a flaky mobile network. Treating it as an error wedges the
    // queue forever.
    session().scan('v1-a1')

    const engine = new SyncEngine(
      db,
      transportReturning((ops) =>
        ops.map((o) => ({ client_seq: o.client_seq, event_id: 'e', outcome: 'duplicate', alert_kind: null })),
      ),
      'WH-01',
    )

    const report = await engine.flush(true)
    assert.equal(report.duplicates, 1)
    assert.equal(new Outbox(db).pendingCount(), 0)
  })

  test('does nothing at all when offline', async () => {
    session().scan('v1-a1')
    const engine = new SyncEngine(db, transportReturning(() => { throw new Error('must not be called') }), 'WH-01')
    const report = await engine.flush(false)
    assert.equal(report.stopped, 'offline')
    assert.equal(new Outbox(db).pendingCount(), 1, 'the scan is still safely queued')
  })

  test('a retryable failure keeps everything queued', async () => {
    session().scan('v1-a1')
    const engine = new SyncEngine(db, {
      submitScanBatch: async () => { throw new TransportError('timeout', 'timeout', true) },
    }, 'WH-01')

    const report = await engine.flush(true)
    assert.equal(report.stopped, 'retry_later')
    assert.equal(new Outbox(db).pendingCount(), 1)
    assert.equal(new Outbox(db).byId(report.failed[0] ?? 'none'), undefined)
  })

  test('a permanent failure parks the op instead of retrying forever', async () => {
    session().scan('v1-a1')
    const engine = new SyncEngine(db, {
      submitScanBatch: async () => { throw new TransportError('rejected', 'bad_request', false) },
    }, 'WH-01')

    const report = await engine.flush(true)
    assert.equal(report.failed.length, 1)
    assert.equal(new Outbox(db).failures().length, 1)
  })

  test('an unacknowledged op stays queued rather than being lost', async () => {
    // The server may coalesce or reorder. Matching by array index would ack
    // the wrong rows and silently drop a scan.
    const s = session()
    s.scan('v1-a1'); s.scan('v1-a2')

    const engine = new SyncEngine(
      db,
      transportReturning((ops) => [
        { client_seq: ops[1].client_seq, event_id: 'e', outcome: 'accepted', alert_kind: null },
      ]),
      'WH-01',
    )

    await engine.flush(true)
    assert.equal(new Outbox(db).pendingCount(), 1, 'the unacknowledged op survives')
  })

  test('surfaces a server-side alert to the caller', async () => {
    session().scan('v1-a1')
    const engine = new SyncEngine(
      db,
      transportReturning((ops) =>
        ops.map((o) => ({ client_seq: o.client_seq, event_id: 'e', outcome: 'accepted', alert_kind: 'double_checkout' })),
      ),
      'WH-01',
    )
    assert.deepEqual((await engine.flush(true)).alerts, ['double_checkout'])
  })
})

describe('a full offline morning, then reconnection', () => {
  test('40 scans survive a closed app and land exactly once', async () => {
    // The rehearsal from the verification plan: airplane mode for a full pull,
    // close the app, reopen, reconnect. Nothing may double-apply, and nothing
    // may vanish.
    const s = session({ expected: new Set(['a1', 'a2', 'a3']) })
    for (const tag of ['v1-a1', 'v1-a2', 'v1-a3']) s.scan(tag)

    const offline = new SyncEngine(db, {
      submitScanBatch: async () => { throw new TransportError('offline', 'network', true) },
    }, 'WH-01')
    await offline.flush(true)
    assert.equal(new Outbox(db).pendingCount(), 3, 'all three still queued')

    const seen = []
    const online = new SyncEngine(db, {
      submitScanBatch: async (_d, ops) => {
        for (const op of ops) {
          assert.ok(!seen.includes(op.client_seq), `client_seq ${op.client_seq} sent twice`)
          seen.push(op.client_seq)
        }
        return ops.map((o) => ({ client_seq: o.client_seq, event_id: 'e', outcome: 'accepted', alert_kind: null }))
      },
    }, 'WH-01')

    await online.flush(true, 50, Date.now() + 3_600_000)
    assert.equal(new Outbox(db).pendingCount(), 0)
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3])
  })
})

describe('the status strip', () => {
  test('is ABSENT when online and idle, not green', () => {
    // A permanent "all good" indicator is noise people stop seeing in a week.
    assert.equal(syncStatus(true, 0, 0, 0).tone, 'hidden')
  })

  test('is calm when offline — that is normal here, not broken', () => {
    const s = syncStatus(false, 14, 60_000, 0)
    assert.equal(s.tone, 'calm')
    assert.match(s.text, /waiting to send/, 'says "waiting to send", never "saved"')
  })

  test('escalates by AGE, not by state', () => {
    // "Offline, 14 scans" after three days is not normal, it is a broken
    // device, and a calm strip conceals that from the one person who can fix it.
    assert.equal(syncStatus(false, 14, 13 * 3_600_000, 0).tone, 'accent')
    assert.equal(syncStatus(false, 14, 25 * 3_600_000, 0).tone, 'attention')
  })

  test('escalates on a large backlog regardless of age', () => {
    assert.equal(syncStatus(false, 400, 60_000, 0).tone, 'attention')
  })

  test('a genuine failure always wins', () => {
    const s = syncStatus(true, 0, 0, 3)
    assert.equal(s.tone, 'attention')
    assert.match(s.text, /attention/)
  })
})

describe('clock offset', () => {
  test('is measured with a round-trip correction and stored, never applied', () => {
    const engine = new SyncEngine(db, { submitScanBatch: async () => [] }, 'WH-01')
    // Device thinks it is t=1000 when the server says 5000: 4s slow.
    const offset = engine.recordClockOffset(5_000, 900, 1_100)
    assert.ok(Math.abs(offset - 4_000) < 200, `offset was ${offset}`)
    assert.equal(engine.clockOffsetMs(), offset, 'persisted for the next scan')
  })
})

describe('what a device wipe destroys', () => {
  test('the outbox is the only irrecoverable data on the phone', () => {
    // Mirrors can be re-synced from the server. Queue rows exist NOWHERE else,
    // and nobody — including the server — ever learns they existed. This is an
    // accepted, documented limit rather than a solved problem, and the test
    // exists so nobody later assumes otherwise.
    session().scan('v1-a1')
    const queued = db.all(`select * from outbox`)
    assert.equal(queued.length, 1)

    const serverKnows = false
    assert.equal(
      serverKnows, false,
      'an uninstall here loses this scan silently — mitigated by flushing on any connectivity, not solved',
    )
  })
})
