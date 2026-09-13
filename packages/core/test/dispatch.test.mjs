/**
 * The dispatcher — non-scan ops across the wire — against a real SQLite
 * and a fake server that behaves like replay_op (0027): receipts, minted
 * ids, verdicts.
 *
 * The three rules in dispatch.ts, each pinned: exactly once (a lost reply
 * is retried and answered by the receipt, not by a second booking); the
 * server names things (the reply's id replaces the phone's everywhere, and
 * later ops are rewritten before they go); a guess is a prefix (the pull
 * replaces the phone's child rows with the server's). Plus the order rule
 * from sync.ts: segments in seq, a scan never overtaking the op that
 * creates the unit it scans.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { Outbox } from '../src/outbox.ts'
import { SyncEngine, TransportError, toScanOp } from '../src/sync.ts'
import { IdMap, argsOf, isClientMinted, rekeyLocal } from '../src/dispatch.ts'
import { PullApplier } from '../src/pull.ts'
import { ScanSession, voidScan } from '../src/scan.ts'

const ORG = 'org-1'
const S_BOOKING = '019a0000-0000-7000-8000-000000000b01'
const S_JOB = '019a0000-0000-7000-8000-000000000j01'.replace('j', '0')

let db
let ids = 0
const newId = () => `id-${String(++ids).padStart(4, '0')}`

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  ids = 0
})

/**
 * A server double: submit_scan_batch echoes acks; replay_op keeps receipts
 * per op id, mints ids per rpc, and can be told to refuse or to lose a
 * reply after committing.
 */
function fakeServer(opts = {}) {
  const receipts = new Map()
  const calls = []
  const minted = []
  let loseNext = 0
  const server = {
    calls, minted, receipts,
    loseReplies(n) { loseNext = n },
    async submitScanBatch(_device, ops) {
      calls.push(['scan', ops])
      return ops.map((o) => ({ client_seq: o.client_seq, event_id: o.id, outcome: 'accepted', alert_kind: null }))
    },
    async rpc(name, args) {
      calls.push([name, args])
      assert.equal(name, 'replay_op', 'every non-scan op goes through replay_op')
      const { p_op_id, p_rpc, p_args } = args
      if (receipts.has(p_op_id)) return { reply: receipts.get(p_op_id), duplicate: true }
      const verdict = opts.refuse?.(p_rpc, p_args)
      if (verdict) throw verdict
      let reply = null
      if (p_rpc === 'create_booking') {
        reply = { booking_id: S_BOOKING, booking_no: 7, status: p_args.p_status }
        minted.push(['booking', p_args])
      } else if (p_rpc === 'convert_booking_to_job') {
        reply = S_JOB
        minted.push(['job', p_args])
      } else if (p_rpc === 'confirm_booking') {
        reply = { booking_id: p_args.p_booking_id, status: 'confirmed' }
      } else if (p_rpc === 'bind_tag') {
        reply = { tag_code: p_args.p_tag_code, asset_id: p_args.p_asset_id }
      }
      receipts.set(p_op_id, reply)
      if (loseNext > 0) { loseNext--; throw new TransportError('socket hung up', 'network', true) }
      return { reply, duplicate: false }
    },
  }
  return server
}

function pencilOffline(outbox, bookingId = 'bk-1') {
  db.exec(`insert into bookings (id, org_id, booking_no, customer_id, status, customer_from, customer_until, blocked_from, blocked_until)
           values (?, ?, 1, 'c1', 'pencil', 'a', 'b', 'a', 'b')`, [bookingId, ORG])
  db.exec(`insert into booking_lines (id, org_id, booking_id, product_id, qty) values ('bl-1', ?, ?, 'p1', 1)`, [ORG, bookingId])
  db.exec(`insert into asset_reservations (id, org_id, booking_id, booking_line_id, asset_id, blocked_from, blocked_until, state)
           values ('ar-1', ?, ?, 'bl-1', 'a1', 'a', 'b', 'pencil')`, [ORG, bookingId])
  const create = outbox.enqueue({
    id: 'op-create', op: 'create_booking',
    payload: { client_booking_id: bookingId, p_customer_id: 'c1', p_lines: [{ product_id: 'p1', qty: 1 }], p_status: 'pencil' },
  })
  const confirm = outbox.enqueue({
    id: 'op-confirm', op: 'confirm_booking',
    payload: { p_booking_id: bookingId, p_blocked_period: null }, dependsOn: create.id,
  })
  const convert = outbox.enqueue({
    id: 'op-convert', op: 'convert_booking_to_job',
    payload: { p_booking_id: bookingId, client_job_id: 'job-1' }, dependsOn: confirm.id,
  })
  db.exec(`insert into jobs (id, org_id, label, booking_id) values ('job-1', ?, 'B#1', ?)`, [ORG, bookingId])
  return { create, confirm, convert }
}

describe('rule 2 — the server names things', () => {
  test('the reply\'s id is recorded, the mirror is re-keyed, and the next op is rewritten', async () => {
    const outbox = new Outbox(db)
    pencilOffline(outbox)
    const server = fakeServer()
    const engine = new SyncEngine(db, server, 'WH-01')

    const report = await engine.flush(true)
    assert.equal(report.dispatched, 3)
    assert.equal(report.mapped, 2, 'the booking and the job')
    assert.equal(report.failed.length, 0)
    assert.equal(outbox.pendingCount(), 0)

    const map = new IdMap(db)
    assert.equal(map.serverIdFor('bk-1'), S_BOOKING)
    assert.equal(map.serverIdFor('job-1'), S_JOB)

    // The mirror now speaks the server's name — the booking, its children's
    // foreign keys, the job that became it.
    assert.equal(db.get(`select id from bookings`).id, S_BOOKING)
    assert.equal(db.get(`select booking_id from booking_lines where id = 'bl-1'`).booking_id, S_BOOKING)
    assert.equal(db.get(`select booking_id from asset_reservations where id = 'ar-1'`).booking_id, S_BOOKING)
    assert.deepEqual(
      [db.get(`select id, booking_id from jobs`).id, db.get(`select id, booking_id from jobs`).booking_id],
      [S_JOB, S_BOOKING],
    )

    // What the server was actually sent: confirm and convert named the
    // SERVER's booking id, not the phone's; client_* keys never crossed.
    const sent = server.calls.filter(([n]) => n === 'replay_op').map(([, a]) => a)
    assert.deepEqual(Object.keys(sent[0].p_args).sort(), ['p_customer_id', 'p_lines', 'p_status'])
    assert.equal(sent[1].p_rpc, 'confirm_booking')
    assert.equal(sent[1].p_args.p_booking_id, S_BOOKING)
    assert.equal(sent[2].p_args.p_booking_id, S_BOOKING)
    assert.equal('client_job_id' in sent[2].p_args, false)
  })

  test('the app\'s own tables are re-keyed too when it says which', () => {
    db.exec(`create table job_expected (job_id text, asset_id text)`)
    db.exec(`insert into job_expected values ('job-1', 'a1')`)
    db.exec(`insert into jobs (id, org_id, label) values ('job-1', 'o', 'x')`)
    rekeyLocal(db, 'job-1', S_JOB, { jobs: ['id'], job_expected: ['job_id'], not_a_table: ['id'] })
    assert.equal(db.get(`select job_id from job_expected`).job_id, S_JOB)
    assert.equal(db.get(`select id from jobs`).id, S_JOB)
  })

  test('rewrite is deep and leaves unknown strings alone', () => {
    const map = new IdMap(db)
    map.record('bk-1', S_BOOKING, 'booking')
    const out = map.rewrite({ p_booking_id: 'bk-1', p_lines: [{ asset_id: 'a-real' }, { booking: 'bk-1' }], note: 'bk-1 said' })
    assert.deepEqual(out, { p_booking_id: S_BOOKING, p_lines: [{ asset_id: 'a-real' }, { booking: S_BOOKING }], note: 'bk-1 said' })
  })

  test('argsOf sends p_* keys only, and shapes bind_tag', () => {
    assert.deepEqual(argsOf('create_booking', { client_booking_id: 'bk-1', p_customer_id: 'c', extra: 1 }), { p_customer_id: 'c' })
    assert.deepEqual(argsOf('bind_tag', { tag_code: 'v1x', asset_id: 'a1', device_time: 't' }), { p_tag_code: 'v1x', p_asset_id: 'a1' })
  })

  test('a guess is a prefix', () => {
    assert.equal(isClientMinted('bk-019a0000-0000-7000-8000-000000000001'), true)
    assert.equal(isClientMinted('019a0000-0000-7000-8000-000000000001'), false)
  })
})

describe('rule 1 — exactly once', () => {
  test('a reply lost after the server committed is retried and answered by the receipt', async () => {
    const outbox = new Outbox(db)
    pencilOffline(outbox)
    const server = fakeServer()
    server.loseReplies(1)
    const engine = new SyncEngine(db, server, 'WH-01')

    const first = await engine.flush(true, 50, 1_000)
    assert.equal(first.stopped, 'retry_later', 'the network had a moment')
    assert.equal(first.dispatched, 0)
    assert.equal(outbox.pendingCount(), 3, 'nothing lost')
    assert.equal(server.minted.length, 1, 'the server DID book it')

    const second = await engine.flush(true, 50, 10_000)
    assert.equal(second.dispatched, 3)
    assert.equal(second.duplicates, 1, 'the receipt answered the retry')
    assert.equal(server.minted.filter(([k]) => k === 'booking').length, 1, 'ONE booking, not two')
    assert.equal(new IdMap(db).serverIdFor('bk-1'), S_BOOKING, 'the original reply\'s id was still learned')
  })
})

describe('the poison rule', () => {
  test('a verdict parks the op and its subtree as one card wearing the server\'s words', async () => {
    const outbox = new Outbox(db)
    pencilOffline(outbox)
    const server = fakeServer({
      refuse: (rpc) => rpc === 'confirm_booking'
        ? new TransportError('asset FX9-02 is already promised to booking #7', '23P01', false)
        : null,
    })
    const engine = new SyncEngine(db, server, 'WH-01')
    const report = await engine.flush(true)

    assert.equal(report.dispatched, 1, 'the pencil itself landed')
    assert.deepEqual(report.failed, ['op-confirm', 'op-convert'])
    const failures = outbox.failures()
    assert.equal(failures.length, 2)
    assert.equal(failures[0].error_code, '23P01')
    assert.equal(failures[0].error_detail, 'asset FX9-02 is already promised to booking #7')
    assert.equal(failures[1].error_code, 'blocked_by_dependency')
    assert.equal(server.calls.filter(([n, a]) => n === 'replay_op' && a.p_rpc === 'convert_booking_to_job').length, 0,
      'the blocked child was never sent')
  })

  test('a retryable error backs the op off and stops the flush; later ops wait their turn', async () => {
    const outbox = new Outbox(db)
    pencilOffline(outbox)
    let attempts = 0
    const server = fakeServer({
      refuse: (rpc) => rpc === 'create_booking' && attempts++ === 0
        ? new TransportError('gateway timeout', 'http_504', true) : null,
    })
    const engine = new SyncEngine(db, server, 'WH-01')
    const r1 = await engine.flush(true, 50, 1_000)
    assert.equal(r1.stopped, 'retry_later')
    assert.equal(server.calls.length, 1, 'confirm was not sent around the backing-off create')
    assert.equal(outbox.nextBatch(50, 1_500).length, 0, 'the whole chain waits for the head')
    const r2 = await engine.flush(true, 50, 10_000)
    assert.equal(r2.dispatched, 3)
  })

  test('a transport with no rpc() backs a non-scan op off rather than losing or parking it', async () => {
    const outbox = new Outbox(db)
    outbox.enqueue({ id: 'op-1', op: 'upsert_partner_house', payload: { p_name: 'Kamran' } })
    const engine = new SyncEngine(db, { submitScanBatch: async () => [] }, 'WH-01')
    const report = await engine.flush(true, 50, 1_000)
    assert.equal(report.stopped, 'retry_later')
    assert.equal(outbox.pendingCount(), 1)
    assert.equal(outbox.failures().length, 0)
  })
})

describe('order — segments in seq', () => {
  test('a scan of a unit created by an earlier op never overtakes that op', async () => {
    db.exec(`insert into products (id, org_id, display_name) values ('p1', '${ORG}', 'FX9')`)
    db.exec(`insert into assets (id, org_id, product_id, asset_code) values ('asset-1', '${ORG}', 'p1', 'FX9-09')`)
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1-x', 'asset-1', 'active')`)
    const outbox = new Outbox(db)
    outbox.enqueue({ id: 'op-hire', op: 'record_sub_hire_in', payload: { client_asset_id: 'asset-1', p_partner_house_id: 'ph', p_product_id: 'p1' } })
    const session = new ScanSession(db, { deviceId: 'WH-01', jobId: 'job-9', newId })
    session.scan('v1-x')      // check_out of the borrowed unit
    outbox.enqueue({ id: 'op-rate', op: 'upsert_rate_entry', payload: { p_rate_card_id: 'card-1', p_product_id: 'p1', p_day_rate_minor: 100 } })

    const server = fakeServer()
    const S_ASSET = '019a0000-0000-7000-8000-00000000a001'
    const inner = server.rpc.bind(server)
    server.rpc = async (name, args) => {
      if (args.p_rpc === 'record_sub_hire_in') {
        server.calls.push([name, args])
        server.receipts.set(args.p_op_id, { sub_hire_id: 'sh-s', asset_id: S_ASSET, expense_id: 'ex-s' })
        return { reply: { sub_hire_id: 'sh-s', asset_id: S_ASSET, expense_id: 'ex-s' }, duplicate: false }
      }
      return inner(name, args)
    }
    const engine = new SyncEngine(db, server, 'WH-01')
    const report = await engine.flush(true)

    assert.equal(report.dispatched, 2)
    assert.equal(report.acked, 3)
    assert.deepEqual(server.calls.map(([n, a]) => n === 'scan' ? 'scan' : a.p_rpc),
      ['record_sub_hire_in', 'scan', 'upsert_rate_entry'], 'seq order, segment by segment')
    const scanned = server.calls[1][1][0]
    assert.equal(scanned.asset_id, S_ASSET, 'the scan named the SERVER\'s unit — it was rewritten before it went')
    assert.equal(db.get(`select asset_id from asset_tags where tag_code = 'v1-x'`).asset_id, S_ASSET)
  })

  test('a void crosses as a forward-pointing correction on the voided op\'s event id', () => {
    db.exec(`insert into assets (id, org_id, asset_code) values ('a1', '${ORG}', 'FX9-02')`)
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1-a1', 'a1', 'active')`)
    const session = new ScanSession(db, { deviceId: 'WH-01', jobId: 'job-9', newId })
    const scan = session.scan('v1-a1')
    voidScan(db, scan.outboxId, { newId, now: () => 5_000 })
    const rows = db.all(`select * from outbox order by seq`)
    const wire = toScanOp(rows[1])
    assert.equal(wire.corrects_event_id, scan.outboxId, 'the outbox id IS the event id server-side')
    assert.equal(wire.event_type, 'check_out', 'wears the voided op\'s own type')
    assert.equal(wire.job_id, 'job-9')
    assert.equal(wire.asset_id, 'a1')
    assert.equal(wire.entry_method, 'manual')
    assert.equal(wire.client_seq, rows[1].seq)
  })
})

describe('rule 3 — the pull replaces the phone\'s guesses', () => {
  test('server lines and claims for a booking replace the prefixed ones, and only those', () => {
    const outbox = new Outbox(db)
    pencilOffline(outbox)
    // As after the ack: the booking is re-keyed, its children still guessed.
    rekeyLocal(db, 'bk-1', S_BOOKING)
    // An older SERVER line on another booking must survive untouched.
    db.exec(`insert into booking_lines (id, org_id, booking_id, product_id, qty) values ('019a0000-0000-7000-8000-0000000000aa', ?, 'other', 'p1', 1)`, [ORG])

    const applier = new PullApplier(db)
    applier.apply({
      cursor: 10, has_more: false, server_time: 'x',
      tables: {
        booking_lines: [{ id: '019a0000-0000-7000-8000-0000000000b1', org_id: ORG, booking_id: S_BOOKING, product_id: 'p1', qty: 1 }],
        asset_reservations: [{ id: '019a0000-0000-7000-8000-0000000000c1', org_id: ORG, booking_id: S_BOOKING, booking_line_id: '019a0000-0000-7000-8000-0000000000b1', asset_id: 'a1', blocked_from: 'a', blocked_until: 'b', state: 'confirmed' }],
      },
    })
    assert.deepEqual(db.all(`select id from booking_lines order by id`).map((r) => r.id),
      ['019a0000-0000-7000-8000-0000000000aa', '019a0000-0000-7000-8000-0000000000b1'])
    assert.deepEqual(db.all(`select id from asset_reservations`).map((r) => r.id), ['019a0000-0000-7000-8000-0000000000c1'])
  })

  test('a page carrying nothing for a booking leaves its guesses alone', () => {
    const outbox = new Outbox(db)
    pencilOffline(outbox)
    new PullApplier(db).apply({ cursor: 10, has_more: false, server_time: 'x', tables: { booking_lines: [], products: [] } })
    assert.equal(db.all(`select id from booking_lines`).length, 1)
  })

  test('the members mirror lands', () => {
    new PullApplier(db).apply({
      cursor: 10, has_more: false, server_time: 'x',
      tables: { members: [{ id: 'u1', org_id: ORG, display_name: 'Bilal', role: 'warehouse', has_pin: true }] },
    })
    assert.deepEqual(db.get(`select display_name, role, has_pin from members`), Object.assign(Object.create(null), { display_name: 'Bilal', role: 'warehouse', has_pin: 1 }))
  })
})
