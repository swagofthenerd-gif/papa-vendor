/**
 * Auth on the phone, against a real SQLite and a scripted server.
 *
 * Pinned: enrolment keeps the token and the session facts; a null token is
 * "bad code" and never a stored session; the multi-org refusal is told
 * apart; the PIN switch asks the server first and the echo offline; sign
 * out is refused while anything is queued and wipes the org when it is
 * not; the device id is minted once.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { Outbox } from '../src/outbox.ts'
import { TransportError } from '../src/sync.ts'
import {
  SESSION_KEYS, enrol, ensureDeviceId, hasPinEcho, needsPinGate, pinSwitch, sessionOf, signOut,
} from '../src/auth.ts'
import { metaGet } from '../src/meta.ts'

let db
beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
})

const ISSUED = {
  token: 'a'.repeat(64), session_id: 's1', org_id: 'o1', user_id: 'u1', device_id: 'dev-1',
  role: 'desk', display_name: 'Bilal', expires_at: '2026-11-12T00:00:00Z',
}
const NULLS = { token: null, session_id: null, org_id: null, user_id: null, device_id: null, role: null, display_name: null, expires_at: null }

const rpcWith = (fn) => ({ calls: [], async rpc(name, args) { this.calls.push([name, args]); return fn(name, args) } })
const input = { phone: '+923000000002', code: '123456', deviceId: 'dev-1', deviceLabel: 'Warehouse phone', serverUrl: 'http://s' }

describe('enrol', () => {
  test('keeps the token and the session facts, once', async () => {
    const rpc = rpcWith(() => ISSUED)
    const r = await enrol(db, rpc, { ...input, pin: '4321' })
    assert.equal(r.ok, true)
    assert.deepEqual(rpc.calls[0], ['complete_enrolment', {
      p_phone: input.phone, p_code: '123456', p_device_id: 'dev-1', p_device_label: 'Warehouse phone', p_pin: '4321', p_org_slug: null,
    }])
    const s = sessionOf(db)
    assert.equal(s.token, ISSUED.token)
    assert.equal(s.orgId, 'o1'); assert.equal(s.userId, 'u1'); assert.equal(s.role, 'desk')
    assert.equal(s.displayName, 'Bilal'); assert.equal(s.serverUrl, 'http://s')
    assert.equal(metaGet(db, SESSION_KEYS.lastUserId), 'u1')
    assert.equal(hasPinEcho(db, 'u1'), true, 'the PIN typed at enrolment is echoed for the offline gate')
  })

  test('a null token is a bad code — nothing is stored', async () => {
    const r = await enrol(db, rpcWith(() => NULLS), input)
    assert.deepEqual(r, { ok: false, reason: 'bad_code' })
    assert.equal(sessionOf(db), null)
  })

  test('the two-houses refusal is told apart so the screen can ask which', async () => {
    const r = await enrol(db, rpcWith(() => {
      throw new TransportError('this phone belongs to more than one organisation; specify the org', '22023', false)
    }), input)
    assert.deepEqual(r, { ok: false, reason: 'ambiguous_org' })
  })

  test('no network is offline, a refusal carries the words', async () => {
    assert.deepEqual(await enrol(db, rpcWith(() => { throw new TransportError('x', 'network', true) }), input),
      { ok: false, reason: 'offline' })
    assert.deepEqual(await enrol(db, rpcWith(() => { throw new TransportError('device dev-1 is enrolled with another organisation', '42501', false) }), input),
      { ok: false, reason: 'refused', message: 'device dev-1 is enrolled with another organisation' })
  })

  test('the device id is minted once', () => {
    let n = 0
    const a = ensureDeviceId(db, () => `dev-${++n}`)
    const b = ensureDeviceId(db, () => `dev-${++n}`)
    assert.equal(a, 'dev-1'); assert.equal(b, 'dev-1')
  })
})

describe('the PIN switch', () => {
  beforeEach(async () => {
    await enrol(db, rpcWith(() => ISSUED), input)
    db.exec(`insert into members (id, org_id, display_name, role, has_pin) values
             ('u1', 'o1', 'Bilal', 'desk', 1), ('u2', 'o1', 'Imran', 'owner', 1), ('u3', 'o1', 'Zoya', 'readonly', 0)`)
  })

  test('asks the server, repoints the session, and remembers the echo', async () => {
    const rpc = rpcWith(() => true)
    const r = await pinSwitch(db, rpc, 'u2', '1111')
    assert.deepEqual(r, { ok: true, userId: 'u2', verifiedBy: 'server' })
    assert.deepEqual(rpc.calls[0], ['switch_session_user', { p_user_id: 'u2', p_pin: '1111' }])
    assert.equal(sessionOf(db).userId, 'u2')
    assert.equal(sessionOf(db).displayName, 'Imran')
    assert.equal(sessionOf(db).role, 'owner')
    assert.equal(hasPinEcho(db, 'u2'), true)
  })

  test('false from the server is a wrong PIN; the session stays', async () => {
    assert.deepEqual(await pinSwitch(db, rpcWith(() => false), 'u2', '0000'), { ok: false, reason: 'wrong_pin' })
    assert.equal(sessionOf(db).userId, 'u1')
  })

  test('offline: the echo answers for a PIN the server once verified, and refuses the rest', async () => {
    await pinSwitch(db, rpcWith(() => true), 'u2', '1111')
    const offline = rpcWith(() => { throw new TransportError('x', 'network', true) })
    assert.deepEqual(await pinSwitch(db, offline, 'u2', '1111'), { ok: true, userId: 'u2', verifiedBy: 'echo' })
    assert.deepEqual(await pinSwitch(db, offline, 'u2', '2222'), { ok: false, reason: 'wrong_pin' })
    assert.deepEqual(await pinSwitch(db, offline, 'u3', '2222'), { ok: false, reason: 'offline_unknown' })
  })

  test('the lockout and a structural refusal are told apart', async () => {
    assert.deepEqual(await pinSwitch(db, rpcWith(() => { throw new TransportError('too many attempts', '53300', false) }), 'u2', '1'),
      { ok: false, reason: 'locked_out' })
    assert.deepEqual(await pinSwitch(db, rpcWith(() => { throw new TransportError('that person cannot use this device', '42501', false) }), 'u2', '1'),
      { ok: false, reason: 'refused', message: 'that person cannot use this device' })
  })

  test('the gate shows when the last holder has a PIN, and not otherwise', async () => {
    assert.equal(needsPinGate(db), true, 'Bilal has a PIN')
    await pinSwitch(db, rpcWith(() => true), 'u3', '0000')
    assert.equal(needsPinGate(db), false, 'Zoya has none')
    db.exec(`delete from sync_meta where key = '${SESSION_KEYS.token}'`)
    assert.equal(needsPinGate(db), false, 'no session, no gate')
  })
})

describe('sign out', () => {
  beforeEach(async () => {
    await enrol(db, rpcWith(() => ISSUED), input)
    db.exec(`insert into assets (id, org_id) values ('a1', 'o1')`)
    db.exec(`insert into members (id, org_id, display_name, role) values ('u1', 'o1', 'Bilal', 'desk')`)
    db.exec(`insert into id_map (client_id, server_id, kind, mapped_at) values ('bk-1', 'x', 'booking', 1)`)
  })

  test('is refused while anything is queued — a scan must not be stranded', async () => {
    new Outbox(db).enqueue({ id: 'op', op: 'submit_scan_batch', payload: {} })
    const rpc = rpcWith(() => null)
    assert.deepEqual(await signOut(db, rpc), { ok: false, reason: 'unsent', pending: 1 })
    assert.equal(rpc.calls.length, 0, 'the server was not even asked')
    assert.notEqual(sessionOf(db), null)
  })

  test('revokes on the server and forgets the org, keeping the device id', async () => {
    const rpc = rpcWith(() => null)
    assert.deepEqual(await signOut(db, rpc), { ok: true })
    assert.deepEqual(rpc.calls[0], ['sign_out_device', {}])
    assert.equal(sessionOf(db), null)
    assert.equal(db.get(`select count(*) as n from assets`).n, 0)
    assert.equal(db.get(`select count(*) as n from members`).n, 0)
    assert.equal(db.get(`select count(*) as n from id_map`).n, 0)
    assert.equal(metaGet(db, SESSION_KEYS.deviceId), 'dev-1')
  })

  test('needs the server: offline is not signed out', async () => {
    assert.deepEqual(await signOut(db, rpcWith(() => { throw new TransportError('x', 'network', true) })), { ok: false, reason: 'offline' })
    assert.notEqual(sessionOf(db), null)
  })

  test('a session the server already killed counts as signed out', async () => {
    assert.deepEqual(await signOut(db, rpcWith(() => { throw new TransportError('invalid or expired device session', '28000', false) })), { ok: true })
    assert.equal(sessionOf(db), null)
  })
})
