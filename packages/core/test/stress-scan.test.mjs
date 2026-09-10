/**
 * Adversarial stress: the scan engine under long random interleavings.
 *
 * Several ScanSessions live on one database at once — the multi-session
 * reality sessions.ts exists for — and a seeded PRNG (mulberry32, fixed
 * seeds, deterministic reruns) drives hundreds of scans, manual adds,
 * lookups and duplicate storms across them. After every run the whole
 * queue is replayed through an INDEPENDENT model of project.ts's rules and
 * compared to the assets table: the projection must be exactly what the
 * ops say, no more, no less.
 *
 * THE INVARIANTS UNDER TEST
 *  - at most ONE queued op per (session, asset, event) — the session dedupe
 *  - the local projection == a replay of the queue, always
 *  - a lookup writes NOTHING: no op, no projection change
 *  - scannedIds is first-scan order; outstanding = expected − recorded
 *  - same-asset ops in one session are chained via depends_on, and fail()
 *    drags the chain down together
 *  - the outbox seq survives a device kill (new driver over the same file)
 *    even after every row has been acked away
 *
 * No Date.now in test logic: sessions get an injected `now` ticking from a
 * fixed base, and ids come from a counter.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { Outbox } from '../src/outbox.ts'
import { ScanSession, SameTagDebounce, lookupTag } from '../src/scan.ts'

// ---------------------------------------------------------------- the dice

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)]
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

const BASE_MS = new Date(2026, 0, 5, 6, 0).getTime() // a 6am load-out
const ORG = 'org-1'
const JOBS = ['job-tvc', 'job-wedding', 'job-doc']
const FLEET = 24

let db
let ids
let clock

const newId = () => `id-${String(++ids.n).padStart(5, '0')}`
const now = () => (clock.ms += 250) // every action a quarter-second apart

function seed(driver = new NodeSqliteDriver()) {
  db = driver
  db.exec(LOCAL_SCHEMA)
  ids = { n: 0 }
  clock = { ms: BASE_MS }

  db.exec(`insert into products (id, org_id, display_name) values ('p1', '${ORG}', 'Sony FX9')`)
  for (const j of JOBS) {
    db.exec(`insert into jobs (id, org_id, label) values (?, ?, ?)`, [j, ORG, `Label ${j}`])
  }
  for (let i = 1; i <= FLEET; i++) {
    const id = `a${i}`
    db.exec(
      `insert into assets (id, org_id, product_id, asset_code, presence) values (?, ?, 'p1', ?, 'here')`,
      [id, ORG, `FX9-${String(i).padStart(2, '0')}`],
    )
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values (?, ?, 'active')`, [
      `v1-${id}`, id,
    ])
  }
}

beforeEach(() => seed())

const mkSession = (jobId, expected) =>
  new ScanSession(db, {
    deviceId: 'WH-01',
    jobId,
    expected: expected ? new Set(expected) : undefined,
    now,
    newId,
  })

/** Every queued scan op, decoded, in seq order. */
function queuedOps() {
  return db
    .all(`select id, seq, payload, depends_on from outbox where op = 'submit_scan_batch' order by seq`)
    .map((r) => ({ outboxId: r.id, seq: r.seq, dependsOn: r.depends_on, ...JSON.parse(r.payload) }))
}

/**
 * The reference projection: replay the queue through project.ts's stated
 * rules, written independently — check_out means (out, job), check_in means
 * (here, no job), anything else moves nothing.
 */
function replayedModel() {
  const model = new Map()
  for (const op of queuedOps()) {
    if (typeof op.asset_id !== 'string') continue
    if (op.event_type === 'check_out') model.set(op.asset_id, { presence: 'out', job: op.job_id ?? null })
    else if (op.event_type === 'check_in') model.set(op.asset_id, { presence: 'here', job: null })
  }
  return model
}

function assertProjectionMatchesReplay(label) {
  const model = replayedModel()
  for (const [assetId, want] of model) {
    const row = db.get(`select presence, current_job_id from assets where id = ?`, [assetId])
    assert.equal(row.presence, want.presence, `${label}: ${assetId} presence`)
    assert.equal(row.current_job_id, want.job, `${label}: ${assetId} job`)
  }
  // And nothing the queue never touched has moved.
  for (let i = 1; i <= FLEET; i++) {
    if (model.has(`a${i}`)) continue
    const row = db.get(`select presence, current_job_id from assets where id = ?`, [`a${i}`])
    assert.equal(row.presence, 'here', `${label}: untouched a${i} moved`)
    assert.equal(row.current_job_id, null, `${label}: untouched a${i} gained a job`)
  }
}

function assertNoDuplicateOps(label) {
  const seen = new Set()
  for (const op of queuedOps()) {
    if (typeof op.asset_id !== 'string') continue
    const key = `${op.session_id}\n${op.asset_id}\n${op.event_type}`
    assert.ok(!seen.has(key), `${label}: duplicate op for ${key.replaceAll('\n', '|')}`)
    seen.add(key)
  }
}

// ------------------------------------------------- the long interleavings

describe('random interleavings across several live sessions', () => {
  test('400 actions over five sessions: dedupe, projection, and lookup-writes-nothing all hold', () => {
    for (const seedN of [11, 22, 33]) {
      seed() // fresh db per seed
      const r = rng(seedN)

      const sessions = [
        { s: mkSession('job-tvc', ['a1', 'a2', 'a3', 'a4', 'a5']), dir: 'check_out' },
        { s: mkSession('job-wedding', ['a6', 'a7', 'a8']), dir: 'check_out' },
        { s: mkSession('job-doc'), dir: 'check_out' },
        { s: mkSession('job-tvc'), dir: 'check_in' },
        { s: mkSession('job-wedding'), dir: 'check_in' },
      ]

      for (let step = 0; step < 400; step++) {
        const { s, dir } = pick(r, sessions)
        const roll = r()
        if (roll < 0.55) {
          s.scan(`v1-a${int(r, 1, FLEET)}`, dir)
        } else if (roll < 0.7) {
          // Duplicate pressure: rescan something this session already took.
          const done = s.scannedIds
          if (done.length > 0) {
            const again = s.scan(`v1-${pick(r, done)}`, dir)
            assert.notEqual(again.outcome, undefined)
          }
        } else if (roll < 0.8) {
          s.addManually(`a${int(r, 1, FLEET)}`, dir)
        } else if (roll < 0.9) {
          // A lookup must write NOTHING — count ops around it to prove it.
          const before = db.get(`select count(*) as n from outbox`).n
          lookupTag(db, `v1-a${int(r, 1, FLEET)}`)
          lookupTag(db, `v1-nothing-${int(r, 1, 99)}`)
          assert.equal(db.get(`select count(*) as n from outbox`).n, before, 'lookup enqueued an op')
        } else {
          s.scan(`v1-unknown-${int(r, 1, 5)}`, dir)
        }
      }

      const label = `seed ${seedN}`
      assertNoDuplicateOps(label)
      assertProjectionMatchesReplay(label)

      // scannedIds is first-scan order and matches the queue's own story.
      for (const { s } of sessions) {
        const mine = queuedOps().filter(
          (op) => op.session_id === s.id && typeof op.asset_id === 'string',
        )
        const firstSeen = [...new Set(mine.map((op) => op.asset_id))]
        assert.deepEqual(s.scannedIds, firstSeen, `${label}: scan order drifted from the queue`)
      }

      // outstanding = expected − recorded, exactly.
      const tvc = sessions[0].s
      const wantOutstanding = ['a1', 'a2', 'a3', 'a4', 'a5'].filter(
        (id) => !tvc.scannedIds.includes(id),
      )
      assert.deepEqual(tvc.outstanding, wantOutstanding, `${label}: shortfall arithmetic`)
    }
  })

  test('an item that goes out and comes home in ONE session keeps both events, chained', () => {
    const s = mkSession('job-tvc')
    const out = s.scan('v1-a1', 'check_out')
    assert.equal(out.outcome, 'accepted')
    const back = s.scan('v1-a1', 'check_in')
    assert.equal(back.outcome, 'accepted', 'the check_in must not be eaten as a duplicate')

    const ops = queuedOps()
    assert.equal(ops.length, 2)
    assert.equal(ops[1].dependsOn, ops[0].outboxId, 'the check_in depends on its check_out')

    // And the DAG rule holds: parking the check_out drags the check_in down.
    const outbox = new Outbox(db)
    const failed = outbox.fail(out.outboxId, 'refused', 'server said no')
    assert.deepEqual(failed.sort(), [out.outboxId, back.outboxId].sort())
    assert.equal(outbox.failures().length, 2)
  })
})

// ---------------------------------------------------- hostile tag traffic

describe('retired tags and unknown-tag storms', () => {
  test('a tag retired MID-SESSION stops resolving at the very next scan', () => {
    const s = mkSession('job-tvc')
    assert.equal(s.scan('v1-a1', 'check_out').outcome, 'accepted')

    // The desk retires the label while the session is still open.
    db.exec(`update asset_tags set status = 'retired' where tag_code = 'v1-a1'`)

    const after = s.scan('v1-a1', 'check_out')
    assert.equal(after.outcome, 'retired_tag')
    assert.ok(after.outboxId, 'still recorded — reality outranks the mirror')

    // The retired-path op carries the TAG, never the asset: the session
    // dedupe is keyed by asset, so this op records by tag_code only and the
    // server (which knows why the label was revoked) decides what it means.
    const ops = queuedOps()
    assert.equal(ops.length, 2)
    assert.equal(ops[1].asset_id, undefined)
    assert.equal(ops[1].tag_code, 'v1-a1')

    // And the projection did NOT move again — replay must still match.
    assertProjectionMatchesReplay('retired mid-session')
  })

  test('a lost tag warns differently from a retired one, and lookup agrees', () => {
    db.exec(`update asset_tags set status = 'lost' where tag_code = 'v1-a2'`)
    const s = mkSession('job-tvc')
    const r = s.scan('v1-a2', 'check_out')
    assert.equal(r.outcome, 'retired_tag')
    assert.match(r.message, /lost/)
    assert.deepEqual(lookupTag(db, 'v1-a2'), { kind: 'retired', status: 'lost' })
  })

  test('PIN: an unknown-tag storm queues one op PER SCAN — the session does not dedupe tag-only ops', () => {
    // Each scan of an unknown label is a real physical fact ("this label was
    // in front of the camera") and the dedupe set is keyed by ASSET id,
    // which tag-only ops do not have. The only guard against a storm is the
    // camera-side SameTagDebounce (1.5s quiet window), which lives outside
    // the session. Pinned so the trade-off stays a decision, not an
    // accident: 30 hostile scans = 30 queued ops.
    const s = mkSession('job-tvc')
    for (let i = 0; i < 30; i++) {
      assert.equal(s.scan('v1-storm', 'check_out').outcome, 'unknown_tag')
    }
    assert.equal(queuedOps().length, 30)

    // The debounce IS that guard: same tag inside the quiet window is
    // swallowed, and a deliberate rescan after it re-fires.
    const d = new SameTagDebounce()
    assert.equal(d.accept('v1-storm', BASE_MS), true)
    assert.equal(d.accept('v1-storm', BASE_MS + 100), false)
    assert.equal(d.accept('v1-storm', BASE_MS + 1_499), false)
    assert.equal(d.accept('v1-storm', BASE_MS + 1_500), true)
    // A suppressed frame must not renew the window (the held-up-label case).
    assert.equal(d.accept('v1-held', BASE_MS), true)
    for (let t = BASE_MS + 60; t < BASE_MS + 1_500; t += 60) d.accept('v1-held', t)
    assert.equal(d.accept('v1-held', BASE_MS + 1_501), true, 'window renewed itself off suppressed frames')
  })

  test('retired-tag scans are also per-scan ops, by the same reasoning', () => {
    db.exec(`update asset_tags set status = 'retired' where tag_code = 'v1-a3'`)
    const s = mkSession('job-tvc')
    s.scan('v1-a3', 'check_out')
    s.scan('v1-a3', 'check_out')
    assert.equal(queuedOps().length, 2)
  })
})

// -------------------------------------------------------- conflict storms

describe('the local conflict check under interleaved jobs', () => {
  test('double-checkout warns, records, moves the projection, and still dedupes', () => {
    const first = mkSession('job-tvc')
    first.scan('v1-a1', 'check_out')

    const second = mkSession('job-wedding')
    const c = second.scan('v1-a1', 'check_out')
    assert.equal(c.outcome, 'conflict')
    assert.equal(c.requiresReason, true)
    assert.match(c.message, /job-tvc|Label job-tvc/)

    // Reality outranks the schedule: the projection follows the second scan.
    const row = db.get(`select presence, current_job_id from assets where id = 'a1'`)
    assert.equal(row.presence, 'out')
    assert.equal(row.current_job_id, 'job-wedding')

    // A rescan of the conflicted item in the SAME session is a duplicate.
    assert.equal(second.scan('v1-a1', 'check_out').outcome, 'duplicate')
    assert.equal(queuedOps().length, 2)
    assertProjectionMatchesReplay('conflict')
  })

  test('checking IN an asset that is out elsewhere never warns — homecoming is always good news', () => {
    mkSession('job-tvc').scan('v1-a1', 'check_out')
    const back = mkSession('job-wedding').scan('v1-a1', 'check_in')
    assert.equal(back.outcome, 'accepted')
    assert.equal(db.get(`select presence from assets where id = 'a1'`).presence, 'here')
  })

  test('50 random conflict/normal rounds keep queue and projection agreeing', () => {
    const r = rng(77)
    const sessions = JOBS.map((j) => mkSession(j))
    for (let i = 0; i < 50; i++) {
      const s = pick(r, sessions)
      pick(r, [
        () => s.scan(`v1-a${int(r, 1, 8)}`, 'check_out'),
        () => s.scan(`v1-a${int(r, 1, 8)}`, 'check_in'),
      ])()
    }
    assertNoDuplicateOps('conflict rounds')
    assertProjectionMatchesReplay('conflict rounds')
  })
})

// -------------------------------------------- bulk trust, and its limits

describe('confirmContents under exclusions and rescans', () => {
  test('an excluded child scanned later is a fresh accepted scan, not a duplicate', () => {
    const s = mkSession('job-tvc')
    // The tech unticks a2 on the manifest; only a1 and a3 ride on trust.
    const results = s.confirmContents(['a1', 'a3'], 'check_out')
    assert.deepEqual(results.map((x) => x.outcome), ['accepted', 'accepted'])
    assert.ok(results.every((x) => x.message === 'Taken on trust'))

    // The excluded child, found later and actually scanned: accepted.
    assert.equal(s.scan('v1-a2', 'check_out').outcome, 'accepted')

    // Rescanning a TRUSTED child is a duplicate — trust already counted it.
    assert.equal(s.scan('v1-a1', 'check_out').outcome, 'duplicate')

    const ops = queuedOps()
    assert.equal(ops.length, 3)
    assert.deepEqual(
      ops.map((op) => op.entry_method),
      ['assumed', 'assumed', 'scanned'],
      'trust is countable, a real scan is a real scan',
    )
    assertProjectionMatchesReplay('manifest')
  })

  test('re-confirming the same case is all duplicates, no second helping of trust', () => {
    const s = mkSession('job-tvc')
    s.confirmContents(['a1', 'a2', 'a3'], 'check_out')
    const again = s.confirmContents(['a1', 'a2', 'a3'], 'check_out')
    assert.deepEqual(again.map((x) => x.outcome), ['duplicate', 'duplicate', 'duplicate'])
    assert.equal(queuedOps().length, 3)
  })
})

// ------------------------------------------------- the kill-and-restart

describe('a device kill: a new store over the same database file', () => {
  test('the outbox seq NEVER rewinds — even after every row was acked and a new driver opens the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papa-stress-'))
    const file = join(dir, 'device.db')
    try {
      seed(new NodeSqliteDriver(file))
      const s1 = mkSession('job-tvc')
      s1.scan('v1-a1', 'check_out')
      s1.scan('v1-a2', 'check_out')
      const outbox1 = new Outbox(db)
      const maxSeq = Math.max(...db.all(`select seq from outbox`).map((r) => r.seq))
      // Server acks everything; the table is now EMPTY.
      outbox1.ack(db.all(`select id from outbox`).map((r) => r.id))
      assert.equal(outbox1.pendingCount(), 0)
      db.close()

      // The kill: a brand-new driver and sessions over the same file.
      db = new NodeSqliteDriver(file)
      ids = { n: 1000 }
      clock = { ms: BASE_MS + 3_600_000 }
      const s2 = mkSession('job-wedding')
      s2.scan('v1-a3', 'check_out')
      const after = db.get(`select seq from outbox`).seq
      assert.ok(
        after > maxSeq,
        `seq restarted: ${after} <= ${maxSeq} — the server would report the scan as a duplicate and silently drop it`,
      )
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('PIN: after a kill, a rescan of an already-recorded item is a NEW op under a NEW session — the dedupe set is per-session by design', () => {
    // The in-memory `seen` set dies with the process, and a restarted app
    // opens a fresh session id. Rescanning gear the dead session already
    // recorded therefore queues a SECOND check_out op. The projection stays
    // correct (check_out twice is idempotent on presence), and the server's
    // scan log treats both as real history — but it IS two ops. Pinned as
    // observed behaviour and raised in the report: whether a resumed
    // morning should rebuild its dedupe set from the queue is a product
    // decision, not a test's.
    const dir = mkdtempSync(join(tmpdir(), 'papa-stress-'))
    const file = join(dir, 'device.db')
    try {
      seed(new NodeSqliteDriver(file))
      const s1 = mkSession('job-tvc')
      s1.scan('v1-a1', 'check_out')
      db.close()

      db = new NodeSqliteDriver(file)
      ids = { n: 2000 }
      clock = { ms: BASE_MS + 60_000 }
      const s2 = mkSession('job-tvc')
      const r = s2.scan('v1-a1', 'check_out')
      assert.equal(r.outcome, 'accepted', 'not a duplicate: the new session never saw it')

      const ops = queuedOps()
      assert.equal(ops.length, 2, 'two ops for one physical item across the kill')
      assert.notEqual(ops[0].session_id, ops[1].session_id)
      // The projection is still exactly right — the cost is history noise,
      // not wrong inventory.
      assertProjectionMatchesReplay('kill-rescan')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
