/**
 * Adversarial stress: the flush loop against a hostile network.
 *
 * A fake server applies ops all-or-nothing exactly like submit_scan_batch,
 * remembers everything it ever applied (so a re-send is answered
 * 'duplicate', the timeout-after-success case), refuses a configured poison
 * set permanently, and throws seeded transient errors on a schedule. The
 * suite drives SyncEngine.flush to a fixpoint with a LOGICAL clock — `now`
 * is advanced past the backoff cap between rounds, no Date.now in any
 * decision — and then audits the ledger of what happened.
 *
 * THE INVARIANTS
 *  - conservation: every enqueued op ends applied-and-acked or parked;
 *    nothing is lost, nothing is left in limbo at fixpoint
 *  - exactly-once: the server applies each op at most once, however many
 *    times the network made the client re-send it
 *  - the parked set is EXACTLY the refused set plus its dependency closure
 *  - transient errors NEVER park anything (the H2 fix): attempts climb,
 *    the backoff delay saturates at the last step, state stays 'pending'
 *  - bisection isolates exactly the poison op wherever it sits in the
 *    batch, named by the server or not
 *
 * Deterministic reruns: mulberry32 with fixed seeds everywhere.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { Outbox } from '../src/outbox.ts'
import { SyncEngine, TransportError } from '../src/sync.ts'

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
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

const BASE_MS = new Date(2026, 0, 5, 6, 0).getTime()
const CAP_MS = 1_800_000 // the outbox's last backoff step

let db
let outbox
let ids

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  outbox = new Outbox(db)
  ids = 0
})

const enq = (dependsOn = null) => {
  const id = `op-${String(++ids).padStart(4, '0')}`
  outbox.enqueue({ id, op: 'submit_scan_batch', payload: { n: ids }, dependsOn })
  return id
}

/**
 * The fake server. All-or-nothing per call, applied ops remembered forever,
 * poison refused permanently. `beforeCall` is the fault injector — it may
 * throw a TransportError, or ask the server to apply-then-throw (the
 * timeout that arrives after the server already committed).
 */
function fakeServer({ poison = new Set(), nameRefused = true, beforeCall = () => null } = {}) {
  const applied = new Map() // op id -> times applied (must never exceed 1)
  let calls = 0
  const transport = {
    async submitScanBatch(_deviceId, ops) {
      calls++
      const order = beforeCall({ calls, ops }) // may throw; may return 'apply_then_throw'

      const hit = ops.find((op) => poison.has(op.id))
      if (hit) {
        // Refused before anything commits — all-or-nothing.
        throw nameRefused
          ? new TransportError(`refused ${hit.id}`, 'invalid_op', false, hit.client_seq)
          : new TransportError('the server said no and named nobody', 'invalid_op', false)
      }

      const results = ops.map((op) => {
        const seen = applied.get(op.id) ?? 0
        if (seen === 0) applied.set(op.id, 1)
        return {
          client_seq: op.client_seq,
          event_id: `ev-${op.id}`,
          outcome: seen === 0 ? 'accepted' : 'duplicate',
          alert_kind: null,
        }
      })

      if (order === 'apply_then_throw') {
        throw new TransportError('timeout after commit', 'timeout', true)
      }
      return results
    },
  }
  return { transport, applied, callCount: () => calls }
}

/** Drive flush to fixpoint with a logical clock. Returns the merged report. */
async function drain(engine, { limit = 50, maxRounds = 300 } = {}) {
  let now = BASE_MS
  const total = { sent: 0, acked: 0, duplicates: 0, failed: [] }
  for (let round = 0; round < maxRounds; round++) {
    const report = await engine.flush(true, limit, now)
    total.sent += report.sent
    total.acked += report.acked
    total.duplicates += report.duplicates
    total.failed.push(...report.failed)
    now += CAP_MS + 1 // leap every backoff, whatever step it reached
    if (report.stopped === 'nothing_to_do') return { ...total, rounds: round + 1 }
  }
  assert.fail(`no fixpoint in ${maxRounds} rounds — the queue is wedged`)
}

/** The full conservation audit: enqueued = applied+acked ⊎ parked. */
function audit({ enqueued, applied, poison = new Set() }) {
  const failedRows = db.all(`select id, error_code from outbox where state = 'failed'`)
  const parked = new Set(failedRows.map((r) => r.id))
  const live = db.all(`select id from outbox where state in ('pending','inflight')`)
  assert.equal(live.length, 0, 'limbo: ops neither acked nor parked at fixpoint')

  for (const id of enqueued) {
    const wasApplied = (applied.get(id) ?? 0) > 0
    assert.ok(wasApplied || parked.has(id), `op ${id} vanished: not applied, not parked`)
    assert.ok(!(wasApplied && parked.has(id)), `op ${id} both applied AND parked`)
  }
  for (const [id, times] of applied) {
    assert.equal(times, 1, `op ${id} applied ${times} times — exactly-once broken`)
  }
  // The refused set, exactly: parked rows split into the poison itself and
  // rows blocked by dependency; nothing else may ever park.
  for (const row of failedRows) {
    if (poison.has(row.id)) continue
    assert.equal(
      row.error_code,
      'blocked_by_dependency',
      `op ${row.id} parked without being refused or dependency-blocked`,
    )
  }
  return { parked }
}

// ----------------------------------------------------------- clean weather

describe('a calm network', () => {
  test('everything drains in one flush, acked exactly once', async () => {
    const enqueued = Array.from({ length: 40 }, () => enq())
    const server = fakeServer()
    const report = await drain(new SyncEngine(db, server.transport, 'WH-01'))
    assert.equal(report.acked, 40)
    assert.equal(report.duplicates, 0)
    audit({ enqueued, applied: server.applied })
  })
})

// ------------------------------------------------------- transient storms

describe('transient errors — the H2 rule: no number of network failures is a verdict', () => {
  test('a 30-failure storm parks NOTHING and drains completely when the weather clears', async () => {
    const enqueued = Array.from({ length: 25 }, () => enq())
    let storms = 30
    const server = fakeServer({
      beforeCall: () => {
        if (storms-- > 0) throw new TransportError('captive portal', 'timeout', true)
        return null
      },
    })
    const engine = new SyncEngine(db, server.transport, 'WH-01')
    const report = await drain(engine)
    assert.equal(report.acked, 25)
    assert.deepEqual(report.failed, [])
    assert.equal(new Outbox(db).failures().length, 0, 'a transient error was escalated to parked')
    audit({ enqueued, applied: server.applied })
  })

  test('attempts climb as a diagnostic while the DELAY saturates at the cap', async () => {
    enq()
    let failures = 12
    const server = fakeServer({
      beforeCall: () => {
        if (failures-- > 0) throw new TransportError('tunnel', 'network', true)
        return null
      },
    })
    const engine = new SyncEngine(db, server.transport, 'WH-01')

    let now = BASE_MS
    let lastDelay = 0
    for (let round = 0; round < 12; round++) {
      await engine.flush(true, 50, now)
      const row = db.get(`select attempts, next_retry_at, state from outbox`)
      assert.equal(row.state, 'pending', 'still pending, never failed')
      assert.equal(row.attempts, round + 1, 'every failure is counted for the needs-attention surface')
      const delay = row.next_retry_at - now
      assert.ok(delay <= CAP_MS, `delay ${delay} above the cap`)
      assert.ok(delay >= lastDelay || delay === CAP_MS, 'backoff went backwards')
      lastDelay = delay
      now = row.next_retry_at + 1
    }
    const row = db.get(`select next_retry_at from outbox`)
    assert.equal(row.next_retry_at - (now - CAP_MS - 1) > 0, true)
    // The last step repeats forever — the 12th delay is exactly the cap.
    assert.equal(lastDelay, CAP_MS)
  })

  test('timeout AFTER the server committed: the retry is answered duplicate and acked, never re-applied', async () => {
    const enqueued = Array.from({ length: 8 }, () => enq())
    let first = true
    const server = fakeServer({
      beforeCall: () => {
        if (first) {
          first = false
          return 'apply_then_throw'
        }
        return null
      },
    })
    const report = await drain(new SyncEngine(db, server.transport, 'WH-01'))
    assert.equal(report.duplicates, 8, 'the whole batch came back as duplicates on the retry')
    assert.equal(report.acked, 8)
    audit({ enqueued, applied: server.applied })
  })
})

// ------------------------------------------------------ poison, everywhere

describe('bisection isolates exactly the poison op, wherever it sits', () => {
  for (const named of [true, false]) {
    test(`poison at EVERY position of a 20-op batch, server ${named ? 'names' : 'does not name'} it`, async () => {
      for (let pos = 0; pos < 20; pos++) {
        db = new NodeSqliteDriver()
        db.exec(LOCAL_SCHEMA)
        outbox = new Outbox(db)
        ids = 0

        const enqueued = Array.from({ length: 20 }, () => enq())
        const poison = new Set([enqueued[pos]])
        const server = fakeServer({ poison, nameRefused: named })
        const report = await drain(new SyncEngine(db, server.transport, 'WH-01'))

        const { parked } = audit({ enqueued, applied: server.applied, poison })
        assert.deepEqual(
          [...parked],
          [enqueued[pos]],
          `position ${pos} (${named ? 'named' : 'unnamed'}): parked ${[...parked]}`,
        )
        assert.equal(report.acked, 19, `position ${pos}: the 19 good ops all landed`)
      }
    })
  }

  test('several poison ops scattered through 60 ops: the parked set equals the refused set exactly', async () => {
    for (const seedN of [5, 6, 7, 8]) {
      db = new NodeSqliteDriver()
      db.exec(LOCAL_SCHEMA)
      outbox = new Outbox(db)
      ids = 0

      const r = rng(seedN)
      const enqueued = Array.from({ length: 60 }, () => enq())
      const poison = new Set()
      while (poison.size < int(r, 2, 5)) poison.add(enqueued[int(r, 0, 59)])
      // The nastier variant: the server never names the culprit.
      const server = fakeServer({ poison, nameRefused: false })
      await drain(new SyncEngine(db, server.transport, 'WH-01'))

      const { parked } = audit({ enqueued, applied: server.applied, poison })
      assert.deepEqual([...parked].sort(), [...poison].sort(), `seed ${seedN}`)
    }
  })

  test('a poisoned parent parks its dependent child; an independent neighbour still ships', async () => {
    const parent = enq()
    const child = enq(parent) // same-asset ordering edge, as ScanSession writes them
    const bystander = enq()
    const poison = new Set([parent])
    const server = fakeServer({ poison, nameRefused: true })
    const report = await drain(new SyncEngine(db, server.transport, 'WH-01'))

    const { parked } = audit({ enqueued: [parent, child, bystander], applied: server.applied, poison })
    assert.deepEqual([...parked].sort(), [child, parent].sort())
    assert.equal(report.acked, 1, 'the bystander must never be frozen by someone else’s bad row')
    const childRow = db.get(`select error_code, error_detail from outbox where id = ?`, [child])
    assert.equal(childRow.error_code, 'blocked_by_dependency')
    assert.match(childRow.error_detail, new RegExp(parent))
  })
})

// ----------------------------------------------- mixed weather, long haul

describe('long random weather: transient bursts and scattered poison together', () => {
  test('30 seeded storms over 50-op queues conserve every op', async () => {
    for (let seedN = 100; seedN < 130; seedN++) {
      db = new NodeSqliteDriver()
      db.exec(LOCAL_SCHEMA)
      outbox = new Outbox(db)
      ids = 0

      const r = rng(seedN)
      const n = int(r, 10, 50)
      const enqueued = []
      // A few dependency chains woven in, like a morning of same-asset pairs.
      for (let i = 0; i < n; i++) {
        const chain = enqueued.length > 0 && r() < 0.15
        enqueued.push(enq(chain ? enqueued[enqueued.length - 1] : null))
      }
      const poison = new Set()
      const poisonCount = int(r, 0, 3)
      while (poison.size < poisonCount) poison.add(enqueued[int(r, 0, n - 1)])

      const server = fakeServer({
        poison,
        nameRefused: r() < 0.5,
        beforeCall: ({ calls }) => {
          // Deterministic per-call weather from the seed stream.
          const roll = r()
          if (roll < 0.25) throw new TransportError('squall', 'timeout', true)
          if (roll < 0.3 && calls > 1) return 'apply_then_throw'
          return null
        },
      })

      await drain(new SyncEngine(db, server.transport, 'WH-01'), {
        limit: int(r, 3, 50),
        maxRounds: 600,
      })
      const { parked } = audit({ enqueued, applied: server.applied, poison })

      // audit() already proved every parked row is poison or
      // dependency-blocked; the other direction: no poison op ever escapes.
      for (const p of poison) assert.ok(parked.has(p), `seed ${seedN}: poison ${p} escaped`)
    }
  })
})
