/**
 * Adversarial stress: the session registry under a chaotic morning.
 *
 * Hundreds of seeded-random interleavings of open / scan / add / finish
 * across every job and both directions — the multi-session reality the
 * registry exists for — then a device kill simulated the honest way: a
 * SECOND registry over the same database, the way a restarted app actually
 * comes back.
 *
 * INVARIANTS
 *  - at most one queued op per (session, asset, event), however the tech
 *    bounces between jobs — the double-count regression, fuzzed
 *  - resuming is the SAME ScanSession object; only endCurrent forgets one
 *  - the assets table always equals a replay of the queue over the seeded
 *    initial state
 *  - every session id that ever queued an op has a durable scan_sessions
 *    row, so its handover summary survives the process
 *  - after a kill, the durable record rebuilds the dead session's summary
 *    with the same facts the live one reported
 *
 * Seeded mulberry32 throughout; reruns are identical. seedDemo dates are
 * relative to the wall clock by design, but nothing here ranks by date.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { SessionRegistry } from '../src/demo/sessions.ts'
import {
  decodeScanOps,
  lastSessionRecord,
  sessionScanFacts,
} from '../src/demo/read-model.ts'

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

let db
let seed
let registry

/** The store's own expected rule, same as multi-session.test.mjs. */
const expectedFor = (jobId, mode) => {
  if (mode === 'out') return seed.jobs.find((j) => j.id === jobId)?.expected ?? []
  return db
    .all(
      `select id from assets
        where current_job_id = ? and presence in ('out', 'in_transit')
        order by asset_code`,
      [jobId],
    )
    .map((r) => r.id)
}

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  registry = new SessionRegistry(db, 'stress-device', expectedFor)
})

const allAssetIds = () => db.all(`select id from assets order by id`).map((r) => r.id)

function snapshotAssets() {
  const snap = new Map()
  for (const row of db.all(`select id, presence, current_job_id from assets`)) {
    snap.set(row.id, { presence: row.presence, job: row.current_job_id })
  }
  return snap
}

/** Replay the queue over the seeded initial state — the reference model. */
function assertProjectionMatchesReplay(initial, label) {
  const model = new Map()
  for (const op of decodeScanOps(db)) {
    if (!op.assetId) continue
    if (op.eventType === 'check_out') model.set(op.assetId, { presence: 'out', job: op.jobId })
    else if (op.eventType === 'check_in') model.set(op.assetId, { presence: 'here', job: null })
  }
  for (const id of allAssetIds()) {
    const row = db.get(`select presence, current_job_id from assets where id = ?`, [id])
    const want = model.get(id) ?? initial.get(id)
    assert.equal(row.presence, want.presence, `${label}: ${id} presence`)
    assert.equal(row.current_job_id, want.job, `${label}: ${id} job`)
  }
}

function assertNoDuplicateOps(label) {
  const seen = new Set()
  for (const op of decodeScanOps(db)) {
    if (!op.assetId) continue
    const key = `${op.sessionId}\n${op.assetId}\n${op.eventType}`
    assert.ok(!seen.has(key), `${label}: duplicate op ${key.replaceAll('\n', '|')}`)
    seen.add(key)
  }
}

describe('a chaotic morning, fuzzed', () => {
  test('300 interleaved actions × 5 seeds: dedupe, resume identity, and the projection all hold', () => {
    for (const seedN of [3, 14, 159, 2653, 58979]) {
      // Fresh world per seed.
      db = new NodeSqliteDriver()
      db.exec(LOCAL_SCHEMA)
      seed = seedDemo(db)
      registry = new SessionRegistry(db, 'stress-device', expectedFor)

      const initial = snapshotAssets()
      const jobs = seed.jobs.map((j) => j.id)
      const assets = allAssetIds()
      const liveSessions = new Map() // key -> ScanSession, our shadow of the registry
      const rng1 = rng(seedN)

      for (let step = 0; step < 300; step++) {
        const jobId = pick(rng1, jobs)
        const mode = rng1() < 0.6 ? 'out' : 'in'
        const key = `${jobId}\n${mode}`
        const entry = registry.open(jobId, mode)

        // Resume identity: reopening must hand back the SAME object until
        // endCurrent forgets it — this is the double-count regression.
        const shadow = liveSessions.get(key)
        if (shadow) {
          assert.equal(entry.session, shadow, `seed ${seedN}: session rebuilt instead of resumed`)
        }
        liveSessions.set(key, entry.session)

        const roll = rng1()
        if (roll < 0.5) {
          entry.session.addManually(pick(rng1, assets), mode === 'out' ? 'check_out' : 'check_in')
        } else if (roll < 0.8) {
          // Duplicate pressure on whatever this session already took.
          const done = entry.session.scannedIds
          if (done.length > 0) {
            entry.session.addManually(pick(rng1, done), mode === 'out' ? 'check_out' : 'check_in')
          }
        } else if (roll < 0.9) {
          // The expected snapshot must never melt while the session lives.
          assert.deepEqual(entry.expected, registry.open(jobId, mode).expected, `seed ${seedN}`)
        } else {
          registry.endCurrent()
          liveSessions.delete(key)
        }
      }

      assertNoDuplicateOps(`seed ${seedN}`)
      assertProjectionMatchesReplay(initial, `seed ${seedN}`)

      // Every session that queued anything left a durable row behind.
      const sessionIds = new Set(decodeScanOps(db).map((op) => op.sessionId).filter(Boolean))
      for (const id of sessionIds) {
        const row = db.get(`select id from scan_sessions where id = ?`, [id])
        assert.ok(row, `seed ${seedN}: session ${id} queued ops but has no durable record`)
      }
    }
  })

  test('finishing one job never touches another job’s half-scanned session', () => {
    const [shan, wedding] = seed.jobs
    const prep = registry.open(shan.id, 'out')
    prep.session.addManually(shan.expected[0], 'check_out')
    prep.session.addManually(shan.expected[1], 'check_out')

    const other = registry.open(wedding.id, 'out')
    other.session.addManually(wedding.expected[0], 'check_out')
    registry.endCurrent() // finishes the WEDDING session only

    const resumed = registry.open(shan.id, 'out')
    assert.equal(resumed.session, prep.session, 'the prep survived the other job’s finish')
    assert.equal(resumed.session.scannedIds.length, 2)
    assert.equal(
      resumed.session.addManually(shan.expected[0], 'check_out').outcome,
      'duplicate',
      'its dedupe set survived too',
    )

    // The wedding, reopened, is a genuinely NEW session.
    const reopened = registry.open(wedding.id, 'out')
    assert.notEqual(reopened.session, other.session)
  })
})

describe('the kill: a second registry over the same database', () => {
  test('the dead session’s summary is rebuilt from the durable record with the same facts', () => {
    const doc = 'job-doc' // seeded with asset-fx6-3 physically out
    const entry = registry.open(doc, 'in')
    assert.deepEqual(entry.expected, ['asset-fx6-3'])
    entry.session.addManually('asset-fx6-3', 'check_in')
    const deadSessionId = entry.session.id

    // The kill. No endCurrent — the process just stops.
    const registry2 = new SessionRegistry(db, 'stress-device', expectedFor)
    assert.equal(registry2.peek(doc), null, 'the new process has no live entry')

    // But the durable record remembers the dead session, newest first…
    const rec = lastSessionRecord(db, doc)
    assert.equal(rec.id, deadSessionId)
    assert.equal(rec.mode, 'in')
    assert.deepEqual(rec.expected, ['asset-fx6-3'])

    // …and the queue still holds its scans, so the summary reconstructs.
    const facts = sessionScanFacts(decodeScanOps(db), rec.id)
    assert.deepEqual(facts.recorded, ['asset-fx6-3'])
    assert.deepEqual(facts.assumed, [])
  })

  test('PIN: after the kill, reopening the job starts a NEW session whose expected set reflects the projection', () => {
    // The FX6 was checked in before the kill, so the restarted return has
    // nothing left to look for — the expected snapshot is re-taken from the
    // mirror, not resurrected. And a rescan of the already-returned item is
    // recorded as a fresh op under the new session id (the per-session
    // dedupe died with the process — pinned at core level too, raised in
    // the report as a product question).
    const doc = 'job-doc'
    registry.open(doc, 'in').session.addManually('asset-fx6-3', 'check_in')

    const registry2 = new SessionRegistry(db, 'stress-device', expectedFor)
    const revived = registry2.open(doc, 'in')
    assert.deepEqual(revived.expected, [], 'nothing is out on the job any more')

    // PIN, and a finding for the report: addManually does NOT consult the
    // expected set — only scan() does. A manually added off-list item reads
    // 'accepted' on the screen row (no 'Not on this job', no resolve
    // buttons), while the handover summary — which derives 'unexpected'
    // from set arithmetic — will still call the same item off-list. The
    // existing round-trip test pins this same 'accepted' on purpose
    // ("reality outranks the schedule"), so the asymmetry is treated as
    // settled behaviour here, not silently "fixed" into new policy.
    const r = revived.session.addManually('asset-fx6-3', 'check_in')
    assert.equal(r.outcome, 'accepted', 'manual adds never flag off-list — see comment above')
    const ops = decodeScanOps(db).filter((op) => op.assetId === 'asset-fx6-3')
    assert.equal(ops.length, 2, 'two check_in ops across the kill: history noise, not wrong inventory')
    assert.notEqual(ops[0].sessionId, ops[1].sessionId)
    assert.equal(
      db.get(`select presence from assets where id = 'asset-fx6-3'`).presence,
      'here',
      'the projection stays right regardless',
    )
  })
})
