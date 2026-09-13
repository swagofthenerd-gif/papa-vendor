/**
 * The sync loop, against a real SQLite and a scripted server.
 *
 * Pinned: a cycle is pull → apply → flush → (pull again when the server
 * renamed something); kicks coalesce rather than interleave; the loop
 * remembers when it last heard from the server and what the last complaint
 * was; a dead session is remembered rather than retried forever; the
 * status view is the Backed-up chip's one source.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { Outbox } from '../src/outbox.ts'
import { SyncLoop } from '../src/engine.ts'
import { TransportError } from '../src/sync.ts'
import { ScanSession } from '../src/scan.ts'
import { metaGet } from '../src/meta.ts'

const ORG = 'org-1'
const S_BOOKING = '019a0000-0000-7000-8000-000000000b01'
let db
let ids = 0
const newId = () => `id-${String(++ids).padStart(4, '0')}`
let clock = 1_000_000

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  ids = 0
  clock = 1_000_000
})

/** A server whose pull answers are a script, and whose writes are counted. */
function server(script = []) {
  const calls = []
  const s = {
    calls,
    pages: script,
    async pull(cursor, limit) {
      calls.push(['pull', cursor, limit])
      const page = s.pages.shift()
      return page ?? { cursor, has_more: false, server_time: new Date(clock + 250).toISOString(), tables: {} }
    },
    async submitScanBatch(_d, ops) {
      calls.push(['scan', ops.length])
      return ops.map((o) => ({ client_seq: o.client_seq, event_id: o.id, outcome: 'accepted', alert_kind: null }))
    },
    async rpc(name, args) {
      calls.push([name, args.p_rpc])
      if (args.p_rpc === 'create_booking') return { reply: { booking_id: S_BOOKING }, duplicate: false }
      return { reply: null, duplicate: false }
    },
  }
  return s
}

const loopWith = (srv, extra = {}) => new SyncLoop({
  db, transport: srv, deviceId: 'WH-01', now: () => clock, pollMs: 0, ...extra,
})

describe('one cycle', () => {
  test('pulls every page, applies, then flushes until drained', async () => {
    const srv = server([
      { cursor: 10, has_more: true, server_time: 'x', tables: { assets: [{ id: 'a1', org_id: ORG, asset_code: 'FX9-02', presence: 'here' }] } },
      { cursor: 20, has_more: false, server_time: 'x', tables: { asset_tags: [{ tag_code: 'v1-a1', asset_id: 'a1', status: 'active' }] } },
    ])
    // Scans queued before the first pull ever happened.
    db.exec(`insert into assets (id, org_id, asset_code) values ('a1', '${ORG}', 'FX9-02')`)
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1-a1', 'a1', 'active')`)
    new ScanSession(db, { deviceId: 'WH-01', jobId: 'j1', newId }).scan('v1-a1')

    let ticks = 0
    const report = await loopWith(srv, { onChange: () => ticks++ }).kick()
    assert.equal(report.pages, 2)
    assert.equal(report.pulled, 2)
    assert.equal(report.error, null)
    assert.equal(report.flushes.at(-1).stopped, 'nothing_to_do')
    assert.equal(new Outbox(db).pendingCount(), 0)
    assert.equal(db.get(`select presence from assets where id = 'a1'`).presence, 'out',
      'the phone\'s own unsent scan won over the server\'s page while it was unsent')
    assert.equal(metaGet(db, 'pull_cursor'), '20')
    assert.ok(Number(metaGet(db, 'last_pull_at')) > 0)
    assert.ok(Number(metaGet(db, 'last_flush_at')) > 0)
    assert.equal(ticks, 1, 'the UI is told once per cycle that something changed')
    assert.deepEqual(srv.calls.map((c) => c[0]), ['pull', 'pull', 'scan', 'pull'].slice(0, 3).concat([]),
      'pull, pull, one scan batch — and no re-pull when nothing was renamed')
  })

  test('pulls once more after the server renamed something, so its children arrive now', async () => {
    const srv = server()
    new Outbox(db, () => clock).enqueue({
      id: 'op-1', op: 'create_booking', payload: { client_booking_id: 'bk-1', p_customer_id: 'c' },
    })
    db.exec(`insert into bookings (id, org_id, booking_no, customer_id, status, customer_from, customer_until, blocked_from, blocked_until)
             values ('bk-1', '${ORG}', 1, 'c', 'pencil', 'a', 'b', 'a', 'b')`)
    await loopWith(srv).kick()
    assert.deepEqual(srv.calls.map((c) => c[0]), ['pull', 'replay_op', 'pull'])
    assert.equal(db.get(`select id from bookings`).id, S_BOOKING)
  })

  test('does nothing offline, and says so in status', async () => {
    const srv = server()
    const loop = loopWith(srv, { online: () => false })
    const report = await loop.kick()
    assert.equal(report.pages, 0)
    assert.equal(srv.calls.length, 0)
    assert.equal(loop.status().online, false)
  })

  test('a network error is remembered as the last complaint and nothing is lost', async () => {
    const srv = server()
    srv.pull = async () => { throw new TransportError('fetch failed', 'network', true) }
    db.exec(`insert into assets (id, org_id) values ('a1', '${ORG}')`)
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1-a1', 'a1', 'active')`)
    new ScanSession(db, { deviceId: 'WH-01', jobId: 'j1', newId }).scan('v1-a1')
    const loop = loopWith(srv)
    const report = await loop.kick()
    assert.equal(report.error, 'fetch failed')
    assert.equal(new Outbox(db).pendingCount(), 1)
    assert.equal(loop.status().lastError, 'fetch failed')
    assert.equal(loop.status().lastErrorAt, clock)
    // And a good cycle clears it.
    srv.pull = server().pull
    await loop.kick()
    assert.equal(loop.status().lastError, null)
  })

  test('a dead session is remembered, not retried forever', async () => {
    const srv = server()
    srv.pull = async () => { throw new TransportError('invalid or expired device session', '28000', false) }
    const loop = loopWith(srv)
    await loop.kick()
    assert.equal(loop.status().sessionDead, true)
  })

  test('records the clock offset from the server\'s time', async () => {
    const srv = server([{ cursor: 1, has_more: false, server_time: new Date(clock + 60_000).toISOString(), tables: {} }])
    await loopWith(srv).kick()
    assert.equal(Number(metaGet(db, 'clock_offset_ms')), 60_000)
  })
})

describe('kicks', () => {
  test('coalesce: a kick during a cycle runs one more cycle after it, never two at once', async () => {
    let inFlight = 0
    let peak = 0
    const srv = server()
    srv.pull = async (cursor) => {
      srv.calls.push(['pull', cursor])
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { cursor, has_more: false, server_time: 'x', tables: {} }
    }
    const loop = loopWith(srv)
    const a = loop.kick()
    const b = loop.kick()
    const c = loop.kick()
    assert.equal(a, b, 'the same in-flight cycle is handed back')
    assert.equal(b, c)
    await a
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(peak, 1)
    assert.equal(srv.calls.length, 2, 'the three kicks became exactly two cycles')
  })

  test('start hangs connectivity listeners on the target and stop removes them', () => {
    const listeners = new Map()
    const target = {
      addEventListener: (k, f) => listeners.set(k, f),
      removeEventListener: (k) => listeners.delete(k),
    }
    const loop = loopWith(server(), { target })
    loop.start()
    assert.deepEqual([...listeners.keys()].sort(), ['online', 'visibilitychange'])
    loop.stop()
    assert.equal(listeners.size, 0)
  })
})

describe('status', () => {
  test('is the chip\'s one source: pending, failures, age, tone', async () => {
    db.exec(`insert into assets (id, org_id) values ('a1', '${ORG}')`)
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1-a1', 'a1', 'active')`)
    new ScanSession(db, { deviceId: 'WH-01', jobId: 'j1', newId, now: () => clock - 3_600_000 }).scan('v1-a1')
    const loop = loopWith(server(), { online: () => false })
    const s = loop.status()
    assert.equal(s.pending, 1)
    assert.equal(s.failures, 0)
    assert.equal(s.oldestAgeMs, 3_600_000)
    assert.equal(s.tone, 'calm')
    assert.match(s.text, /1 scan waiting to send/)
    assert.equal(s.cursor, 0)
    assert.equal(s.lastPullAt, null)
  })
})
