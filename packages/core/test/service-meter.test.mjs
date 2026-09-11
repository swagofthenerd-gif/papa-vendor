/**
 * The usage meters — service days and battery cycles (project.ts, fleet.ts;
 * migration 0021).
 *
 * The properties that matter offline:
 *   - the day rule is the SAME rule the server states: calendar days
 *     touched, (in − out) + 1, partial day = full day, same-day = 1;
 *   - the meter moves with the scan projection: a check_in adds its pair's
 *     days, a rescan echo and a loose check_in add nothing;
 *   - cycles count on flagged products only, on check_out;
 *   - `serviced` queues one desk op, resets the meter, and touches neither
 *     health, presence nor the cycle count — and its expense link rides
 *     the op's nested payload, where submit_scan_batch files it.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { ScanSession } from '../src/scan.ts'
import { rentalDaysBetween } from '../src/project.ts'
import { recordServiced } from '../src/fleet.ts'

let db
let seq
let clock

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  db.exec(
    `insert into products (id, org_id, display_name, service_due_after_rental_days, count_cycles, retire_after_cycles)
     values ('p-cam','o','Sony FX9', 100, 0, null),
            ('p-batt','o','V-Mount', null, 1, 30)`,
  )
  db.exec(`insert into jobs (id, org_id, label, status) values ('j1','o','TVC','open')`)
  db.exec(`insert into jobs (id, org_id, label, status) values ('j2','o','Wedding','open')`)
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, presence, health)
     values ('cam','o','p-cam','FX9-01','here','ok'),
            ('batt','o','p-batt','VM-01','here','ok')`,
  )
  db.exec(
    `insert into asset_tags (tag_code, asset_id, status)
     values ('t-cam','cam','active'), ('t-batt','batt','active')`,
  )
  seq = 0
  clock = Date.parse('2026-03-02T18:00:00') // local Monday evening
})

const ids = () => `id-${++seq}`

const session = (jobId) =>
  new ScanSession(db, { deviceId: 'dev', jobId, now: () => clock, newId: ids })

const meter = (id) =>
  Number(db.get(`select rental_days_since_service as m from assets where id=?`, [id]).m)
const cycles = (id) =>
  Number(db.get(`select cycle_count as c from assets where id=?`, [id]).c)

describe('the day rule', () => {
  const day = (s) => Date.parse(s)

  test('calendar days touched, partial day = full day', () => {
    assert.equal(rentalDaysBetween(day('2026-03-02T18:00'), day('2026-03-04T09:00')), 3)
    assert.equal(rentalDaysBetween(day('2026-03-02T08:00'), day('2026-03-02T20:00')), 1)
    assert.equal(rentalDaysBetween(day('2026-03-02T23:30'), day('2026-03-03T00:30')), 2)
  })

  test('clock skew that puts the return first still counts the rental', () => {
    assert.equal(rentalDaysBetween(day('2026-03-02T12:00'), day('2026-03-01T12:00')), 1)
  })
})

describe('the service meter moves with the projection', () => {
  test('a check_in adds its pair’s days; echoes and loose check_ins add nothing', () => {
    const out = session('j1')
    assert.equal(out.scan('t-cam', 'check_out').outcome, 'accepted')
    assert.equal(meter('cam'), 0, 'going out is not yet wear')

    clock = Date.parse('2026-03-04T09:00:00') // third calendar morning
    const back = session('j1')
    assert.equal(back.scan('t-cam', 'check_in').outcome, 'accepted')
    assert.equal(meter('cam'), 3, 'Monday-evening out to Wednesday-morning in is 3 days')

    // The rescan echo: a NEW session (the dedupe honestly died), same
    // check_in — recorded, but the pair is already consumed.
    clock = Date.parse('2026-03-04T09:05:00')
    const echo = session('j1')
    assert.equal(echo.scan('t-cam', 'check_in').outcome, 'accepted')
    assert.equal(meter('cam'), 3, 'an echo adds no days — no unconsumed check_out')

    // A loose check_in with no job has no pair to price.
    clock = Date.parse('2026-03-05T09:00:00')
    const loose = session(null)
    assert.equal(loose.scan('t-cam', 'check_in').outcome, 'accepted')
    assert.equal(meter('cam'), 3)
  })

  test('a same-day out-and-back adds exactly 1', () => {
    clock = Date.parse('2026-03-10T08:00:00')
    session('j2').scan('t-cam', 'check_out')
    clock = Date.parse('2026-03-10T20:00:00')
    session('j2').scan('t-cam', 'check_in')
    assert.equal(meter('cam'), 1)
  })
})

describe('cycles', () => {
  test('a flagged product counts a cycle per check_out; an unflagged one never does', () => {
    session('j1').scan('t-batt', 'check_out')
    assert.equal(cycles('batt'), 1)
    clock += 3_600_000
    session('j1').scan('t-batt', 'check_in')
    session('j2').scan('t-batt', 'check_out')
    assert.equal(cycles('batt'), 2, 'each checkout is a cycle')

    session('j1').scan('t-cam', 'check_out')
    assert.equal(cycles('cam'), 0, 'the camera’s product is not flagged')
  })
})

describe('recordServiced', () => {
  test('queues one desk op, resets the meter, touches nothing else', () => {
    db.exec(`update assets set rental_days_since_service = 120, cycle_count = 7 where id='batt'`)
    const r = recordServiced(db, {
      assetId: 'batt', note: 'Cell swap — Battery-wala', now: () => clock, newId: ids,
    })
    assert.ok(r.outboxId)

    const a = db.get(
      `select rental_days_since_service as m, cycle_count as c, presence, health
         from assets where id='batt'`,
    )
    assert.equal(Number(a.m), 0, 'the meter resets')
    assert.equal(Number(a.c), 7, 'cycles are the unit’s life, not its maintenance')
    assert.equal(a.presence, 'here', 'no movement was invented')
    assert.equal(a.health, 'ok', 'serviced does not moonlight in the health vocabulary')

    const op = JSON.parse(
      db.get(`select payload from outbox where id = ?`, [r.outboxId]).payload,
    )
    assert.equal(op.event_type, 'serviced')
    assert.equal(op.entry_method, 'manual')
    assert.equal(op.note, 'Cell swap — Battery-wala')
  })

  test('the expense link rides the op’s nested payload — where the server files it', () => {
    const r = recordServiced(db, {
      assetId: 'cam', expenseId: 'exp-1', now: () => clock, newId: ids,
    })
    const op = JSON.parse(
      db.get(`select payload from outbox where id = ?`, [r.outboxId]).payload,
    )
    assert.deepEqual(op.payload, { expense_id: 'exp-1' })
  })

  test('without a cost there is no payload key at all — absence, not null', () => {
    const r = recordServiced(db, { assetId: 'cam', now: () => clock, newId: ids })
    const op = JSON.parse(
      db.get(`select payload from outbox where id = ?`, [r.outboxId]).payload,
    )
    assert.equal('payload' in op, false)
  })
})
