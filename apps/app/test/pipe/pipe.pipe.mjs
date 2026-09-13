/**
 * The pipe, end to end (W9): a phone-side database in Node, the real
 * PostgREST, the real Postgres, in containers on this machine.
 *
 * Every other check stops at a fake server. This one enrols a device the
 * real way (the harness fetches the OTP as papa_auth, the way the SMS
 * transport would), pulls the fleet into a fresh local database, scans out
 * offline and watches the row land, places a pencil offline and watches the
 * server's id replace the phone's, lets two phones fight over one unit, and
 * kills the network mid-flush to prove principle 3: nothing lost, only
 * delayed, exact row counts.
 *
 * Deliberately NOT part of `npm test`: it needs containers. Run it with
 * `npm run test:pipe` (db/pipe-test.sh), or bring the pipe up yourself and
 * point PAPA_PIPE_URL / PAPA_PIPE_PG at it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import {
  PostgrestTransport, SyncLoop, ScanSession, Outbox, IdMap,
  enrol, migrateLocal, sessionOf, isClientMinted,
} from '@papa/core'
import { DEMO_SCHEMA } from '../../src/demo/read-model.ts'
import { NETWORK_SCHEMA } from '../../src/demo/network.ts'
import { createBooking, confirmBooking, convertBookingToJob, listBookings } from '../../src/demo/bookings.ts'

const URL = process.env.PAPA_PIPE_URL ?? 'http://127.0.0.1:3050'
const PG = process.env.PAPA_PIPE_PG ?? 'papa-pipe-pg'
const RUNTIME = process.env.PAPA_PIPE_RUNTIME ?? (which('podman') ? 'podman' : 'docker')

const ORG = '11111111-1111-7111-8111-111111111111'
const CUSTOMER = '50000000-0000-7000-8000-000000000001'
const FX9_01 = '30000000-0000-7000-8000-000000000001'
const FX9_02 = '30000000-0000-7000-8000-000000000002'
const LNS_01 = '30000000-0000-7000-8000-000000000003'
const JOB = '60000000-0000-7000-8000-000000000001'
const TAG_FX9_01 = 'v1PIPEFX9010000000000001'
const TAG_FX9_02 = 'v1PIPEFX9020000000000002'
const TAG_LNS_01 = 'v1PIPELNS010000000000003'

function which(bin) {
  try { execFileSync('which', [bin], { stdio: 'pipe' }); return true } catch { return false }
}

/** One SQL statement as postgres, first column of the first row (or all rows). */
function sql(statement, { all = false } = {}) {
  const out = execFileSync(RUNTIME, [
    'exec', '-i', PG, 'psql', '-U', 'postgres', '-d', 'papa', '-X', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', statement,
  ], { encoding: 'utf8' }).trim()
  return all ? out.split('\n').filter(Boolean) : out
}
const count = (statement) => Number(sql(statement))

/** The SMS transport's half: papa_auth mints the code and hands it over. */
function otpFor(phone) {
  const code = sql(`set role papa_auth; select request_otp('${phone}');`)
  assert.match(code, /^[0-9]{6}$/, 'a 6-digit code from request_otp as papa_auth')
  return code
}

/** A phone: fresh local database with the app's tables, a transport, a loop. */
function phone(label) {
  const db = new NodeSqliteDriver()
  migrateLocal(db)
  db.exec(DEMO_SCHEMA)
  db.exec(NETWORK_SCHEMA)
  const deviceId = crypto.randomUUID()
  let trapNextScanBatch = false
  const transport = new PostgrestTransport({
    baseUrl: URL,
    sessionToken: () => sessionOf(db)?.token ?? null,
    fetch: async (url, init) => {
      const res = await fetch(url, init)
      if (trapNextScanBatch && String(url).endsWith('/rpc/submit_scan_batch')) {
        // The server has committed; the phone never hears. The one network
        // failure that matters for exactly-once.
        trapNextScanBatch = false
        await res.text()
        throw new TypeError('socket hung up')
      }
      return res
    },
  })
  const loop = new SyncLoop({ db, transport, deviceId, pollMs: 0, online: () => true })
  return {
    label, db, deviceId, transport, loop,
    trap() { trapNextScanBatch = true },
    session: () => sessionOf(db),
    outbox: new Outbox(db),
    scan: (jobId, tag, type = 'check_out') =>
      new ScanSession(db, { deviceId, jobId, newId: () => crypto.randomUUID() }).scan(tag, type),
    sync: () => loop.kick(),
  }
}

const A = phone('A')
const B = phone('B')
const now = Date.now()
const DAY = 86_400_000
const bookingStart = now + 10 * DAY
const bookingEnd = now + 12 * DAY

// ---------------------------------------------------------------------------

test('the pipe answers', async () => {
  const res = await fetch(`${URL}/`)
  assert.equal(res.ok, true, `PostgREST at ${URL} should answer the OpenAPI root`)
  assert.equal(count(`select count(*) from assets where org_id = '${ORG}'`), 3)
})

test('(1) enrol a device — the harness fetches the OTP as papa_auth', async () => {
  const code = otpFor('+923000000002')
  const r = await enrol(A.db, A.transport, {
    phone: '+923000000002', code, deviceId: A.deviceId, deviceLabel: 'Phone A', pin: '4321', serverUrl: URL,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.session.displayName, 'Bilal')
  assert.equal(r.session.role, 'desk')
  assert.equal(A.session().token.length, 64)
  assert.equal(count(`select count(*) from device_sessions where device_id = '${A.deviceId}' and revoked_at is null`), 1)
  assert.equal(sql(`select label from devices where id = '${A.deviceId}'`), 'Phone A')

  // A wrong code is a null token, never a session — and the attempt counted.
  const wrong = await enrol(B.db, B.transport, {
    phone: '+923000000001', code: '000000', deviceId: B.deviceId, deviceLabel: 'Phone B', serverUrl: URL,
  })
  assert.deepEqual(wrong, { ok: false, reason: 'bad_code' })
  assert.equal(B.session(), null)
})

test('(2) pull the fleet into a fresh local database', async () => {
  const report = await A.sync()
  assert.equal(report.error, null, report.error)
  assert.ok(report.pulled >= 3 + 3 + 2 + 1 + 4, `pulled ${report.pulled} rows`)
  assert.equal(A.db.get(`select count(*) as n from assets`).n, 3)
  assert.equal(A.db.get(`select count(*) as n from asset_tags`).n, 3)
  assert.equal(A.db.get(`select count(*) as n from products`).n, 2)
  assert.equal(A.db.get(`select label from jobs where id = ?`, [JOB]).label, 'Zindagi promo')
  assert.deepEqual(
    A.db.all(`select id, display_name, role, has_pin from members order by display_name`).map((m) => [m.display_name, m.role, m.has_pin]),
    [['Bilal', 'desk', 1], ['Danish', 'warehouse', 0], ['Imran', 'owner', 1], ['Kashif', 'driver', 0]],
    'the members mirror: names, roles, has_pin — nothing else',
  )
  assert.equal(A.db.get(`select count(*) as n from pragma_table_info('members') where name like '%phone%'`).n, 0)
  let status = A.loop.status()
  assert.ok(status.lastPullAt > 0)
  assert.equal(status.lastError, null)

  // THE CURSOR IS THE MINIMUM SAFE ADVANCE (0015 C1): rows written within
  // the last three seconds are delivered but the cursor is held below
  // them until their transactions have provably settled. Seeded seconds
  // ago, the fleet arrives with the cursor still at 0 — correct. Once the
  // window passes, the next pull advances it.
  await new Promise((r) => setTimeout(r, 3_200))
  await A.sync()
  status = A.loop.status()
  assert.ok(status.cursor > 0, `cursor advanced past the settle window (got ${status.cursor})`)
  assert.equal(A.db.get(`select count(*) as n from assets`).n, 3, 'and the re-pull changed nothing')
})

test('(5a) a second phone enrols and pulls the same fleet', async () => {
  const code = otpFor('+923000000001')
  const r = await enrol(B.db, B.transport, {
    phone: '+923000000001', code, deviceId: B.deviceId, deviceLabel: 'Phone B', serverUrl: URL,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.session.displayName, 'Imran')
  const report = await B.sync()
  assert.equal(report.error, null)
  assert.equal(B.db.get(`select count(*) as n from assets`).n, 3)
})

test('(3) scan out offline → flush → row on the server → pull → mirror agrees', async () => {
  const r = A.scan(JOB, TAG_FX9_01)
  assert.equal(r.outcome, 'accepted')
  assert.equal(A.outbox.pendingCount(), 1)
  assert.equal(A.db.get(`select presence from assets where id = ?`, [FX9_01]).presence, 'out', 'optimistic, before any network')
  assert.equal(count(`select count(*) from scan_events where device_id = '${A.deviceId}'`), 0, 'the server has not seen it')

  const report = await A.sync()
  assert.equal(report.error, null, report.error)
  const flush = report.flushes.find((f) => f.acked > 0)
  assert.ok(flush, 'a flush acked the scan')
  assert.equal(A.outbox.pendingCount(), 0)
  assert.equal(count(`select count(*) from scan_events where device_id = '${A.deviceId}' and event_type = 'check_out'`), 1)
  assert.equal(sql(`select presence || '|' || coalesce(current_job_id::text, '') from assets where id = '${FX9_01}'`), `out|${JOB}`,
    'the server projected the scan')
  assert.equal(sql(`select actor_user_id from scan_events where device_id = '${A.deviceId}'`), 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    'stamped with the SESSION\'s user, never a claim from the phone')

  await A.sync()
  const local = A.db.get(`select presence, current_job_id, last_scanned_at from assets where id = ?`, [FX9_01])
  assert.equal(local.presence, 'out')
  assert.equal(local.current_job_id, JOB)
  assert.ok(local.last_scanned_at, 'the server\'s last_scanned_at came back')
  // The other phone learns it on its next pull.
  await B.sync()
  assert.equal(B.db.get(`select presence from assets where id = ?`, [FX9_01]).presence, 'out')
})

let aBookingId = null
let bBookingId = null

test('(4a) pencil offline → dispatcher → the server\'s id replaces the phone\'s', async () => {
  A.db.exec(`insert into customers (id, org_id, name) values (?, ?, 'Zindagi Films')`, [CUSTOMER, ORG])
  const created = createBooking(A.db, ORG, {
    customerId: CUSTOMER, startMs: bookingStart, endMs: bookingEnd,
    lines: [{ assetId: FX9_02 }], status: 'pencil',
  }, now)
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(isClientMinted(created.bookingId), true, 'the phone named it first')
  assert.equal(A.outbox.pendingCount(), 1)

  const report = await A.sync()
  assert.equal(report.error, null, report.error)
  const flush = report.flushes.find((f) => f.dispatched > 0)
  assert.ok(flush, 'create_booking was dispatched')
  assert.equal(flush.mapped, 1)

  const serverId = new IdMap(A.db).serverIdFor(created.bookingId)
  assert.ok(serverId && !isClientMinted(serverId), 'the server minted a uuid and the phone learned it')
  assert.equal(count(`select count(*) from bookings where id = '${serverId}' and status = 'pencil'`), 1)
  assert.equal(count(`select count(*) from op_receipts where device_id = '${A.deviceId}'`), 1, 'one receipt filed')

  // The mirror speaks the server's name, and its lines are the server's.
  assert.equal(A.db.get(`select count(*) as n from bookings where id = ?`, [serverId]).n, 1)
  assert.equal(A.db.get(`select count(*) as n from bookings where id = ?`, [created.bookingId]).n, 0)
  const lines = A.db.all(`select id from booking_lines where booking_id = ?`, [serverId])
  assert.equal(lines.length, 1)
  assert.equal(isClientMinted(lines[0].id), false, 'the phone\'s guessed line was replaced by the server\'s')
  aBookingId = serverId
})

test('(5b) the second phone, offline, promises the same unit', () => {
  B.db.exec(`insert into customers (id, org_id, name) values (?, ?, 'Zindagi Films')`, [CUSTOMER, ORG])
  const created = createBooking(B.db, ORG, {
    customerId: CUSTOMER, startMs: bookingStart, endMs: bookingEnd,
    lines: [{ assetId: FX9_02 }], status: 'pencil',
  }, now)
  assert.equal(created.ok, true, JSON.stringify(created))
  const confirmed = confirmBooking(B.db, ORG, created.bookingId, {}, now)
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  const converted = convertBookingToJob(B.db, ORG, created.bookingId, now)
  assert.equal(converted.ok, true, JSON.stringify(converted))
  assert.equal(B.outbox.pendingCount(), 3, 'create, confirm, convert — queued, nothing sent')
  bBookingId = created.bookingId
})

test('(4b) confirm → convert to job → the server\'s jobs projection shows it', async () => {
  const confirmed = confirmBooking(A.db, ORG, aBookingId, {}, now)
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  const converted = convertBookingToJob(A.db, ORG, aBookingId, now)
  assert.equal(converted.ok, true, JSON.stringify(converted))
  assert.equal(isClientMinted(converted.jobId), true)

  const report = await A.sync()
  assert.equal(report.error, null, report.error)
  assert.equal(A.outbox.pendingCount(), 0)
  assert.equal(A.outbox.failures().length, 0)

  assert.equal(sql(`select status from bookings where id = '${aBookingId}'`), 'confirmed')
  assert.equal(count(`select count(*) from asset_reservations where booking_id = '${aBookingId}' and state = 'confirmed' and asset_id = '${FX9_02}'`), 1)
  const serverJob = sql(`select id from jobs where booking_id = '${aBookingId}'`)
  assert.ok(serverJob, 'the server has the job')
  assert.equal(new IdMap(A.db).serverIdFor(converted.jobId), serverJob)
  assert.equal(A.db.get(`select count(*) as n from jobs where id = ?`, [serverJob]).n, 1, 'the local job now wears the server\'s id')
  assert.equal(A.db.get(`select count(*) as n from jobs where id = ?`, [converted.jobId]).n, 0)
  assert.equal(A.db.get(`select count(*) as n from asset_reservations where booking_id = ? and ${'not (length(id) = 36)'}`, [aBookingId]).n, 0,
    'no guessed reservation rows remain beside the server\'s')
  const view = listBookings(A.db, {}, now).find((b) => b.id === aBookingId)
  assert.equal(view.stamp, 'confirmed')
  assert.equal(view.job.id, serverJob)
})

test('(5c) two phones confirmed the same unit — the loser parks as ONE card with the server\'s message', async () => {
  const report = await B.sync()
  assert.equal(report.error, null, report.error)
  const failures = B.outbox.failures()
  assert.equal(failures.length, 2, 'the confirm and the convert behind it')
  const [root, child] = failures
  assert.equal(root.op, 'confirm_booking')
  assert.equal(root.error_code, '23P01')
  assert.match(root.error_detail, /FX9-02 is already promised to booking #\d+/)
  assert.equal(child.op, 'convert_booking_to_job')
  assert.equal(child.error_code, 'blocked_by_dependency')
  assert.equal(B.outbox.pendingCount(), 0, 'the pencil itself landed; nothing else is stuck')

  // Server truth: B's pencil exists, A's confirmation stands, one job.
  const bServer = new IdMap(B.db).serverIdFor(bBookingId)
  assert.ok(bServer)
  assert.equal(sql(`select status from bookings where id = '${bServer}'`), 'pencil')
  assert.equal(count(`select count(*) from asset_reservations where asset_id = '${FX9_02}' and state = 'confirmed' and deleted_at is null`), 1)
  assert.equal(count(`select count(*) from jobs where booking_id = '${bServer}'`), 0)
  assert.equal(count(`select count(*) from op_receipts where device_id = '${B.deviceId}'`), 1, 'only the create was receipted; the refused confirm rolled back')
})

test('(6) the network dies mid-flush after the server committed — nothing lost, retried, exact counts', async () => {
  const before = count(`select count(*) from scan_events where device_id = '${A.deviceId}'`)
  A.scan(JOB, TAG_LNS_01)                 // lens out
  A.scan(JOB, TAG_FX9_01, 'check_in')     // camera back
  A.scan(JOB, TAG_FX9_01)                 // and out again
  A.scan(JOB, TAG_LNS_01, 'check_in')
  A.scan(JOB, TAG_FX9_02)
  assert.equal(A.outbox.pendingCount(), 5)

  A.trap()
  const first = await A.sync()
  assert.equal(first.error, null)
  const stopped = first.flushes.find((f) => f.stopped === 'retry_later')
  assert.ok(stopped, 'the flush backed off on the lost reply')
  assert.equal(A.outbox.pendingCount(), 5, 'every scan still queued — nothing lost')
  assert.equal(A.outbox.failures().length, 0, 'and nothing parked: a network failure is not a verdict')
  assert.equal(count(`select count(*) from scan_events where device_id = '${A.deviceId}'`), before + 5, 'the server DID commit them')

  // Backoff is 1s on the first attempt; the retry must be answered with
  // duplicates, never a second set of rows.
  await new Promise((r) => setTimeout(r, 1_200))
  const second = await A.sync()
  assert.equal(second.error, null, second.error)
  const acked = second.flushes.find((f) => f.acked > 0)
  assert.ok(acked, 'the retry was acked')
  assert.equal(acked.acked, 5)
  assert.equal(acked.duplicates, 5, 'all five were duplicates of rows the server already had')
  assert.equal(A.outbox.pendingCount(), 0)
  assert.equal(count(`select count(*) from scan_events where device_id = '${A.deviceId}'`), before + 5, 'EXACTLY five — not ten')
  assert.equal(sql(`select presence || '|' || coalesce(current_job_id::text, '') from assets where id = '${FX9_02}'`), `out|${JOB}`)
  assert.equal(sql(`select presence from assets where id = '${LNS_01}'`), 'here')
  await A.sync()
  assert.equal(A.db.get(`select presence from assets where id = ?`, [LNS_01]).presence, 'here', 'and the mirror agrees')
})
