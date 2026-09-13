/**
 * Every write crosses the pipe (W11) — the ops the money book, the expense
 * book, the walk-in job and the customer now queue, pinned against a real
 * SQLite: the payload is the RPC's own shape (`p_*` in the 0017/0018/0019/
 * 0024/0028 argument names, the phone's id beside them as `client_*`), and
 * every op chains behind the op that mints what it names — the customer
 * before its ledger line, the job before its close, the expense before its
 * reversal and before the serviced scan that cites it.
 *
 * The write sides that mint NOTHING the server does not mint inside another
 * RPC — a partner's customer row, a lend-out's charge, a borrowed unit's
 * bill — queue no op of their own, and that is pinned too: a second op
 * would be a second row.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, IdMap, argsOf, recordServiced } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { createCustomer, recordEntry, recordReversalOf } from '../src/demo/khata.ts'
import { jobMargin, recordExpense, reverseExpense } from '../src/demo/kharcha.ts'
import { closeJob, createJob, reopenJob, setExpectedBack } from '../src/demo/read-model.ts'
import { createBooking, noteSubRent } from '../src/demo/bookings.ts'
import { recordSubHireIn, recordSubHireOut } from '../src/demo/network.ts'
import { NAMES, lastOpNaming } from '../src/demo/ops.ts'
import { STR_EN } from '../src/strings.ts'

let db
let seed
let seq
const NOW = new Date(2026, 10, 10, 12).getTime()
const ids = (nowMs = NOW) => ({ now: () => nowMs, newId: () => `op-${++seq}` })
const ops = (op) => db.all(`select id, op, payload, depends_on from outbox where op = ? order by seq`, [op])
  .map((r) => ({ id: r.id, op: r.op, dependsOn: r.depends_on, payload: JSON.parse(r.payload) }))
const allOps = () => db.all(`select op from outbox order by seq`).map((r) => r.op)
const rs = (rupees) => rupees * 100

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  seq = 0
})

describe('the customer', () => {
  test('create_customer: the trimmed name and phone, the phone\'s id as client_customer_id, no dependency', () => {
    const id = createCustomer(db, { orgId: seed.orgId, name: '  Ayesha Raza ', phone: ' 0333 1122334 ' }, ids())
    assert.match(id, /^cust-/)
    const [op] = ops('create_customer')
    assert.deepEqual(op.payload, { client_customer_id: id, p_name: 'Ayesha Raza', p_phone: '0333 1122334' })
    assert.equal(op.dependsOn, null)
    assert.deepEqual(argsOf('create_customer', op.payload), { p_name: 'Ayesha Raza', p_phone: '0333 1122334' },
      'the dispatcher sends only the p_* keys')
  })

  test('a blank name writes nothing and queues nothing; a null clock queues nothing', () => {
    assert.equal(createCustomer(db, { orgId: seed.orgId, name: '   ' }, ids()), null)
    assert.equal(allOps().length, 0)
    const id = createCustomer(db, { orgId: seed.orgId, name: 'Partner row' }, null)
    assert.ok(id)
    assert.equal(allOps().length, 0, 'the server mints this one inside another op')
  })
})

describe('the ledger', () => {
  test('a payment goes to record_payment as the positive amount received, behind the customer\'s op', () => {
    const cust = createCustomer(db, { orgId: seed.orgId, name: 'Ayesha Raza' }, ids())
    const led = recordEntry(db, {
      orgId: seed.orgId, customerId: cust, kind: 'payment', amountMinor: -rs(20_000),
      jobId: null, note: 'Cash', createdAt: NOW,
    }, ids())
    const [op] = ops('record_payment')
    assert.deepEqual(op.payload, {
      client_ledger_entry_id: led, p_customer_id: cust, p_amount_minor: rs(20_000), p_job_id: null, p_note: 'Cash',
    })
    assert.equal(op.dependsOn, ops('create_customer')[0].id, 'the line waits for the customer to exist')
  })

  test('a charge goes to record_ledger_entry SIGNED, on its job; the reversal names it and chains behind it', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'damage_charge', amountMinor: rs(5_000),
      jobId: 'job-wedding', assetId: 'asset-fx9-1', note: 'Cracked filter', createdAt: NOW,
    }, ids())
    assert.equal(recordReversalOf(db, seed.orgId, charge, 'It turned up', NOW + 1), true)
    const [c, r] = ops('record_ledger_entry')
    assert.deepEqual(c.payload, {
      client_ledger_entry_id: charge, p_customer_id: 'cust-bilal', p_entry_kind: 'damage_charge',
      p_amount_minor: rs(5_000), p_job_id: 'job-wedding', p_asset_id: 'asset-fx9-1',
      p_note: 'Cracked filter', p_reversal_of: null,
    })
    assert.equal(c.dependsOn, null, 'a seeded customer and job: nothing pending to wait for')
    assert.equal(r.payload.p_entry_kind, 'reversal')
    assert.equal(r.payload.p_amount_minor, -rs(5_000))
    assert.equal(r.payload.p_reversal_of, charge)
    assert.equal(r.dependsOn, c.id, 'the reversal waits for the line it voids')
  })

  test('a deposit kind writes the row and no op — the phone has no deposit door', () => {
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'deposit_hold', amountMinor: rs(10_000), createdAt: NOW,
    }, ids())
    assert.equal(allOps().length, 0)
  })

  test('a null clock writes the row and no op (the lend-out\'s charge is record_sub_hire_out\'s)', () => {
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge', amountMinor: rs(1), createdAt: NOW,
    }, null)
    assert.equal(allOps().length, 0)
  })
})

describe('the expense book', () => {
  test('record_expense: the 0024 shape with p_spent_at on the row\'s clock and p_booking_id', () => {
    const exp = recordExpense(db, {
      orgId: seed.orgId, kind: 'transport', amountMinor: rs(1_500), jobId: 'job-wedding',
      counterparty: ' Rickshaw ', note: 'Two trips', createdAt: NOW,
    }, ids())
    const [op] = ops('record_expense')
    assert.deepEqual(op.payload, {
      client_expense_id: exp, p_kind: 'transport', p_amount_minor: rs(1_500), p_asset_id: null,
      p_job_id: 'job-wedding', p_counterparty: 'Rickshaw', p_note: 'Two trips',
      p_spent_at: new Date(NOW).toISOString(), p_booking_id: null,
    })
  })

  test('reverse_expense names the target and chains behind its op', () => {
    const exp = recordExpense(db, { orgId: seed.orgId, kind: 'misc', amountMinor: rs(500), createdAt: NOW }, ids())
    assert.equal(reverseExpense(db, seed.orgId, exp, 'double entry', NOW + 1, ids()), true)
    const [rec] = ops('record_expense')
    const [rev] = ops('reverse_expense')
    assert.match(rev.payload.client_expense_id, /^exp-/)
    assert.notEqual(rev.payload.client_expense_id, exp, 'the reversal is its own row')
    assert.equal(rev.payload.p_expense_id, exp)
    assert.equal(rev.payload.p_note, 'double entry')
    assert.equal(rev.dependsOn, rec.id)
  })

  test('a non-positive amount writes nothing and queues nothing; a null clock queues nothing', () => {
    assert.equal(recordExpense(db, { orgId: seed.orgId, kind: 'misc', amountMinor: 0, createdAt: NOW }, ids()), null)
    assert.ok(recordExpense(db, { orgId: seed.orgId, kind: 'misc', amountMinor: rs(1), createdAt: NOW }, null))
    assert.equal(allOps().length, 0)
  })

  test('the serviced scan cites the expense and chains behind its op', () => {
    const exp = recordExpense(db, {
      orgId: seed.orgId, kind: 'repair', amountMinor: rs(4_000), assetId: 'asset-fx9-1', createdAt: NOW,
    }, ids())
    recordServiced(db, {
      assetId: 'asset-fx9-1', note: 'Sensor clean', expenseId: exp,
      dependsOn: lastOpNaming(db, NAMES.expense(exp)), now: () => NOW, newId: () => 'scan-1',
    })
    const scan = db.get(`select payload, depends_on from outbox where id = 'scan-1'`)
    assert.equal(JSON.parse(scan.payload).payload.expense_id, exp)
    assert.equal(scan.depends_on, ops('record_expense')[0].id,
      'the scan goes after the expense op — its id is the server\'s by then, and a refused bill parks it too')
  })
})

describe('the job', () => {
  test('a walk-in queues create_job behind its new customer; close, reopen and the due date chain behind it', () => {
    const cust = createCustomer(db, { orgId: seed.orgId, name: 'Walk-in' }, ids())
    createJob(db, {
      id: 'job-walk', orgId: seed.orgId, label: 'Lens test', contact: '0301 5556677',
      expectedBack: '2026-11-12', customerId: cust, wants: [{ productId: 'prod-fx9', qty: 1 }],
    }, ids())
    const [create] = ops('create_job')
    assert.deepEqual(create.payload, {
      client_job_id: 'job-walk', p_label: 'Lens test', p_contact: '0301 5556677',
      p_expected_back: '2026-11-12', p_customer_id: cust, p_note: null,
    })
    assert.equal(create.dependsOn, ops('create_customer')[0].id)

    setExpectedBack(db, 'job-walk', null, ids())
    const [due] = ops('set_job_expected_back')
    assert.deepEqual(due.payload, { p_job_id: 'job-walk', p_expected_back: null })
    assert.equal(due.dependsOn, create.id)

    assert.deepEqual(closeJob(db, 'job-walk', NOW, ids()), { ok: true })
    const [close] = ops('close_job')
    assert.deepEqual(close.payload, { p_job_id: 'job-walk', p_note: null })
    assert.equal(close.dependsOn, due.id, 'behind the last op naming the job')

    assert.equal(reopenJob(db, 'job-walk', NOW + 1, ids()), true)
    const [reopen] = ops('reopen_job')
    assert.deepEqual(reopen.payload, { p_job_id: 'job-walk', p_note: null })
    assert.equal(reopen.dependsOn, close.id)
    assert.deepEqual(allOps(), ['create_customer', 'create_job', 'set_job_expected_back', 'close_job', 'reopen_job'])
  })

  test('a refused close queues nothing; a job created without a clock queues nothing', () => {
    createJob(db, { id: 'job-bridge', orgId: seed.orgId, label: 'From a booking', contact: null, expectedBack: null, wants: [] })
    assert.equal(allOps().length, 0, 'the bridge and the lend-out mint their jobs inside their own RPCs')
    const out = db.get(`select current_job_id as id from assets where presence = 'out' and current_job_id is not null limit 1`)
    const r = closeJob(db, out.id, NOW, ids())
    assert.equal(r.ok, false, 'gear is still out on it')
    assert.equal(allOps().length, 0)
  })
})

describe('the two walls', () => {
  test('the sub-rent intent crosses as set_booking_note, appending the line', () => {
    const b = createBooking(db, seed.orgId, {
      customerId: 'cust-bilal', startMs: NOW + 5 * 86_400_000, endMs: NOW + 6 * 86_400_000,
      lines: [{ productId: 'prod-fx9', qty: 1 }], status: 'pencil', note: 'Ask about the tripod',
    }, NOW, ids())
    const noted = noteSubRent(db, b.bookingId, {
      productId: 'prod-fx9', productName: 'Sony FX9', qty: 1, forBookingId: 'bk-1', forBookingNo: 1,
    }, STR_EN, NOW + 1, ids())
    assert.equal(noted.ok, true)
    assert.equal(noted.note, 'Ask about the tripod\nSub-rent Sony FX9 ×1 for #1')
    const [op] = ops('set_booking_note')
    assert.deepEqual(argsOf('set_booking_note', op.payload), {
      p_booking_id: b.bookingId, p_note: 'Sub-rent Sony FX9 ×1 for #1', p_append: true,
    }, 'the server appends the one line; the note the desk already had is not overwritten')
    assert.equal(op.dependsOn, ops('create_booking')[0].id)
  })

  test('a borrowed unit\'s bill names the booking, queues no expense op, and the job the booking becomes sees it', () => {
    const b = createBooking(db, seed.orgId, {
      customerId: 'cust-bilal', startMs: NOW + 5 * 86_400_000, endMs: NOW + 6 * 86_400_000,
      lines: [{ productId: 'prod-fx9', qty: 1 }], status: 'pencil',
    }, NOW, ids())
    const loan = recordSubHireIn(db, seed.orgId, {
      partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: NOW + 5 * 86_400_000, endMs: NOW + 6 * 86_400_000,
      agreedCostMinor: rs(15_000), bookingId: b.bookingId,
    }, NOW + 1, ids())
    assert.equal(loan.ok, true)
    assert.equal(db.get(`select booking_id from org_expenses where id = ?`, [loan.expenseId]).booking_id, b.bookingId)
    assert.deepEqual(allOps(), ['create_booking', 'record_sub_hire_in'], 'record_sub_hire_in mints the bill server-side')
    assert.equal(ops('record_sub_hire_in')[0].dependsOn, ops('create_booking')[0].id)

    // The job born from the booking reads the bill through jobs.booking_id.
    createJob(db, { id: 'job-eid', orgId: seed.orgId, label: 'Eid', contact: null, expectedBack: null, wants: [] })
    db.exec(`update jobs set booking_id = ? where id = 'job-eid'`, [b.bookingId])
    assert.equal(jobMargin(db, 'job-eid').expenseMinor, rs(15_000))
    assert.equal(jobMargin(db, 'job-eid').expenseCount, 1)
    // A bill on the booking that names ANOTHER job is that job's.
    recordExpense(db, { orgId: seed.orgId, kind: 'misc', amountMinor: rs(100), jobId: 'job-wedding', bookingId: b.bookingId, createdAt: NOW }, null)
    assert.equal(jobMargin(db, 'job-eid').expenseMinor, rs(15_000))
    assert.equal(jobMargin(db, 'job-wedding').expenseCount >= 1, true)
  })

  test('the lend-out writes its charge and its customer with no ops of their own', () => {
    const r = recordSubHireOut(db, seed.orgId, {
      partnerId: 'partner-zeeshan', assetId: 'asset-fx9-1', startMs: NOW + 86_400_000, endMs: NOW + 2 * 86_400_000,
      agreedChargeMinor: rs(8_000),
    }, NOW, ids())
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(r.ledgerEntryId)
    assert.deepEqual(allOps(), ['record_sub_hire_out'])
  })
})

describe('the dispatcher knows the new id kinds', () => {
  test('every new op\'s reply maps its client id', () => {
    const map = new IdMap(db)
    const S = '019a0000-0000-7000-8000-000000000001'
    const cases = [
      ['create_customer', 'client_customer_id', 'customer'],
      ['create_job', 'client_job_id', 'job'],
      ['record_ledger_entry', 'client_ledger_entry_id', 'ledger_entry'],
      ['record_payment', 'client_ledger_entry_id', 'ledger_entry'],
      ['record_expense', 'client_expense_id', 'expense'],
      ['reverse_expense', 'client_expense_id', 'expense'],
    ]
    for (const [op, client, kind] of cases) {
      assert.deepEqual(map.mappingsFrom(op, { [client]: 'local-1' }, { id: S }), [{ clientId: 'local-1', serverId: S, kind }], op)
    }
    for (const op of ['close_job', 'reopen_job', 'set_job_expected_back', 'set_booking_note']) {
      assert.deepEqual(map.mappingsFrom(op, { p_job_id: 'x' }, { id: S }), [], `${op} mints nothing`)
    }
  })
})
