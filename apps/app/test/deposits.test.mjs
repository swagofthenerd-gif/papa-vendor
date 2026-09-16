/**
 * The deposit door against a real SQLite (W13, `no-deposit-door`).
 *
 * Two things are worth pinning: the MONEY — the ledger's pot and balance
 * after a hold, an apply and a refund, which the projection has always
 * been able to do and no screen could ever cause — and the PIPE: each of
 * the three queues the RPC it replays as, in the RPC's own argument
 * shape, chained behind the op that mints what it names, with the ledger
 * line queuing nothing of its own because the server writes that line
 * inside the deposit RPC.
 *
 * And the gate. A refund is refused while the linked job is not clear,
 * with the reason available BEFORE the tap — the whole point of the door.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, ScanSession, argsOf, ID_REPLY_RULES } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import {
  applyDeposit,
  applyTargets,
  depositRow,
  depositsFor,
  holdDeposit,
  refundBlockers,
  refundDeposit,
} from '../src/demo/deposits.ts'
import { customerView, recordEntry } from '../src/demo/khata.ts'

let db
let seed
let seq
const NOW = new Date(2026, 10, 10, 12).getTime()
const ids = (nowMs = NOW) => ({ now: () => nowMs, newId: () => `op-${++seq}` })
const ops = (op) =>
  db
    .all(`select id, op, payload, depends_on from outbox where op = ? order by seq`, [op])
    .map((r) => ({ id: r.id, dependsOn: r.depends_on, payload: JSON.parse(r.payload) }))
const allOps = () => db.all(`select op from outbox order by seq`).map((r) => r.op)
const rs = (rupees) => rupees * 100

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  seq = 0
})

describe('the seeded deposit', () => {
  test("Imran's held cheque is a real deposits row, not a lone ledger line", () => {
    const [d] = depositsFor(db, 'cust-imran')
    assert.equal(d.amountMinor, rs(50_000))
    assert.equal(d.state, 'held')
    assert.equal(d.appliedMinor, 0)
    assert.equal(d.remainingMinor, rs(50_000))
    assert.equal(d.jobId, 'job-imran-drama')
    // And the ledger line points back at it — the server's own link.
    const line = customerView(db, 'cust-imran').entries.find((e) => e.kind === 'deposit_hold')
    assert.equal(line.depositId, d.id)
    // The pot is the projection's, not the row's.
    assert.equal(customerView(db, 'cust-imran').depositHeldMinor, rs(50_000))
  })

  test('a customer with no deposits gets an empty list, not a zero row', () => {
    assert.deepEqual(depositsFor(db, 'cust-hamza'), [])
  })
})

describe('holding a deposit', () => {
  test('the pot rises, the balance does not, and hold_deposit is queued in the RPC shape', () => {
    const before = customerView(db, 'cust-bilal')
    const id = holdDeposit(db, {
      orgId: seed.orgId,
      customerId: 'cust-bilal',
      amountMinor: rs(100_000),
      jobId: 'job-shan',
      note: 'Cheque — HBL 4471',
      heldAt: NOW,
    }, ids())
    assert.match(id, /^dep-/)

    const after = customerView(db, 'cust-bilal')
    assert.equal(after.depositHeldMinor, rs(100_000), 'the pot holds it')
    assert.equal(after.balanceMinor, before.balanceMinor, 'security money is not debt')

    const [op] = ops('hold_deposit')
    assert.deepEqual(op.payload, {
      client_deposit_id: id,
      p_customer_id: 'cust-bilal',
      p_amount_minor: rs(100_000),
      p_job_id: 'job-shan',
      p_note: 'Cheque — HBL 4471',
    })
    assert.deepEqual(argsOf('hold_deposit', op.payload), {
      p_customer_id: 'cust-bilal',
      p_amount_minor: rs(100_000),
      p_job_id: 'job-shan',
      p_note: 'Cheque — HBL 4471',
    }, 'the dispatcher sends only the p_* keys')
    assert.equal(op.dependsOn, null, 'a seeded customer and job: nothing pending to wait for')
    assert.deepEqual(allOps(), ['hold_deposit'], 'the ledger line queues nothing of its own')
  })

  test("the server's reply renames the phone's deposit", () => {
    assert.deepEqual(ID_REPLY_RULES.hold_deposit, [
      { client: 'client_deposit_id', reply: 'id', kind: 'deposit' },
    ])
  })

  test('a zero or negative deposit writes nothing and queues nothing', () => {
    assert.equal(holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: 0, heldAt: NOW,
    }, ids()), null)
    assert.equal(holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: -rs(5), heldAt: NOW,
    }, ids()), null)
    assert.deepEqual(depositsFor(db, 'cust-bilal'), [])
    assert.deepEqual(allOps(), [])
  })

  test('a null clock writes the row and queues nothing', () => {
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: rs(10_000), heldAt: NOW,
    }, null)
    assert.ok(id)
    assert.deepEqual(allOps(), [])
  })
})

describe('applying a deposit', () => {
  test('one line drops the pot and the debt by the same rupee, and chains behind the hold', () => {
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: rs(100_000),
      jobId: 'job-shan', note: 'Cash', heldAt: NOW,
    }, ids())
    const r = applyDeposit(db, {
      orgId: seed.orgId, depositId: id, amountMinor: rs(40_000),
      note: 'Against the TVC charge', whenMs: NOW + 1000,
    }, ids(NOW + 1000))
    assert.equal(r.ok, true)
    assert.equal(r.remainingMinor, rs(60_000))

    const v = customerView(db, 'cust-bilal')
    assert.equal(v.depositHeldMinor, rs(60_000))
    // The seeded book owes Rs 75,000; Rs 40,000 of held money settles it.
    assert.equal(v.balanceMinor, rs(35_000))

    const d = depositRow(db, id)
    assert.equal(d.state, 'partially_applied')
    assert.equal(d.appliedMinor, rs(40_000))

    const [op] = ops('apply_deposit')
    assert.deepEqual(op.payload, {
      client_deposit_id: id,
      p_deposit_id: id,
      p_amount_minor: rs(40_000),
      p_note: 'Against the TVC charge',
    })
    assert.equal(op.dependsOn, ops('hold_deposit')[0].id, 'the apply waits for the hold')
    assert.deepEqual(allOps(), ['hold_deposit', 'apply_deposit'])
  })

  test('more than is held is refused, and a double-tap cannot spend it twice', () => {
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: rs(50_000), heldAt: NOW,
    }, ids())
    const over = applyDeposit(db, {
      orgId: seed.orgId, depositId: id, amountMinor: rs(50_001), whenMs: NOW,
    }, ids())
    assert.equal(over.ok, false)
    assert.equal(over.reason, 'over_remaining')
    assert.equal(over.remainingMinor, rs(50_000))

    assert.equal(applyDeposit(db, {
      orgId: seed.orgId, depositId: id, amountMinor: rs(50_000), whenMs: NOW,
    }, ids()).ok, true)
    const again = applyDeposit(db, {
      orgId: seed.orgId, depositId: id, amountMinor: rs(1), whenMs: NOW,
    }, ids())
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'over_remaining')
    assert.equal(ops('apply_deposit').length, 1, 'one apply, one op')
  })

  test('the sheet is offered the balance and the job\'s own live charges', () => {
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: rs(100_000),
      jobId: 'job-shan', heldAt: NOW,
    }, ids())
    const t = applyTargets(db, id)
    assert.equal(t.balanceMinor, rs(75_000))
    assert.deepEqual(t.charges.map((c) => c.amountMinor), [rs(45_000)])
    assert.equal(t.charges[0].kind, 'charge')
  })

  test('the offered balance never exceeds what is still held', () => {
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: rs(10_000), heldAt: NOW,
    }, ids())
    assert.equal(applyTargets(db, id).balanceMinor, rs(10_000))
  })
})

describe('the refund gate', () => {
  test('a clear job refunds the remainder, and refund_deposit chains behind the hold', () => {
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-imran', amountMinor: rs(30_000),
      jobId: 'job-imran-drama', heldAt: NOW,
    }, ids())
    assert.deepEqual(refundBlockers(db, 'job-imran-drama'), [], 'the drama job is home and closed')
    const r = refundDeposit(db, {
      orgId: seed.orgId, depositId: id, note: 'Cheque returned', whenMs: NOW + 1000,
    }, ids(NOW + 1000))
    assert.equal(r.ok, true)
    assert.equal(r.refundedMinor, rs(30_000))

    const d = depositRow(db, id)
    assert.equal(d.state, 'refunded')
    assert.equal(d.refundedMinor, rs(30_000))
    assert.equal(d.remainingMinor, 0)

    const [op] = ops('refund_deposit')
    assert.deepEqual(op.payload, {
      client_deposit_id: id, p_deposit_id: id, p_note: 'Cheque returned',
    })
    assert.equal(op.dependsOn, ops('hold_deposit')[0].id)
  })

  test('gear still out on the job REFUSES the refund and names the count', () => {
    // job-doc is the overdue documentary: its gear is still out.
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-ayesha', amountMinor: rs(20_000),
      jobId: 'job-doc', heldAt: NOW,
    }, ids())
    const blockers = refundBlockers(db, 'job-doc')
    assert.ok(blockers.some((b) => b.reason === 'gear_still_out' && b.count > 0))

    const r = refundDeposit(db, { orgId: seed.orgId, depositId: id, whenMs: NOW }, ids())
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'job_not_clear')
    assert.ok(r.blockers.some((b) => b.reason === 'gear_still_out'))
    assert.equal(ops('refund_deposit').length, 0, 'a refused refund queues nothing')
    assert.equal(depositRow(db, id).state, 'held')
    assert.equal(customerView(db, 'cust-ayesha').depositHeldMinor, rs(20_000))
  })

  test('gone out and nothing scanned back is its own named reason', () => {
    // Scan a unit out on the closed drama job: gear out, nothing back.
    const session = new ScanSession(db, {
      deviceId: 'phone-1',
      jobId: 'job-imran-drama',
      expected: new Set(['asset-komodo-1']),
      now: () => NOW,
      newId: () => `scan-${++seq}`,
    })
    session.addManually('asset-komodo-1', 'check_out')
    const reasons = refundBlockers(db, 'job-imran-drama').map((b) => b.reason)
    assert.ok(reasons.includes('gear_still_out'))
    assert.ok(reasons.includes('no_return_recorded'))
  })

  test('a deposit with no job has nothing to be blocked by', () => {
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', amountMinor: rs(5_000), heldAt: NOW,
    }, ids())
    assert.deepEqual(refundBlockers(db, null), [])
    assert.equal(refundDeposit(db, { orgId: seed.orgId, depositId: id, whenMs: NOW }, ids()).ok, true)
  })

  test('a fully applied deposit has nothing to refund, and refunding twice is refused', () => {
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: rs(20_000), heldAt: NOW,
    }, ids())
    assert.equal(applyDeposit(db, {
      orgId: seed.orgId, depositId: id, amountMinor: rs(20_000), whenMs: NOW,
    }, ids()).ok, true)
    const r = refundDeposit(db, { orgId: seed.orgId, depositId: id, whenMs: NOW }, ids())
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'nothing_left')

    const other = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: rs(20_000), heldAt: NOW,
    }, ids())
    assert.equal(refundDeposit(db, { orgId: seed.orgId, depositId: other, whenMs: NOW }, ids()).ok, true)
    const again = refundDeposit(db, { orgId: seed.orgId, depositId: other, whenMs: NOW }, ids())
    assert.equal(again.ok, false)
    assert.equal(again.reason, 'already_refunded')
  })

  test('an unknown deposit is refused, never written', () => {
    assert.equal(refundDeposit(db, {
      orgId: seed.orgId, depositId: 'dep-nobody', whenMs: NOW,
    }, ids()).reason, 'not_found')
    assert.equal(applyDeposit(db, {
      orgId: seed.orgId, depositId: 'dep-nobody', amountMinor: rs(1), whenMs: NOW,
    }, ids()).reason, 'not_found')
    assert.deepEqual(allOps(), [])
  })
})

describe('the whole arc, to the paisa', () => {
  test('hold 100k, damage 40k, apply 40k, refund 60k — the DEC scene', () => {
    const id = holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', amountMinor: rs(100_000),
      note: 'Cheque held', heldAt: NOW,
    }, ids())
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', kind: 'damage_charge',
      amountMinor: rs(40_000), note: 'Lens scratch', createdAt: NOW + 1,
    }, ids(NOW + 1))
    assert.equal(applyDeposit(db, {
      orgId: seed.orgId, depositId: id, amountMinor: rs(40_000), whenMs: NOW + 2,
    }, ids(NOW + 2)).ok, true)
    assert.equal(refundDeposit(db, {
      orgId: seed.orgId, depositId: id, whenMs: NOW + 3,
    }, ids(NOW + 3)).ok, true)

    const v = customerView(db, 'cust-hamza')
    assert.equal(v.balanceMinor, 0, 'the damage is settled out of the deposit')
    assert.equal(v.depositHeldMinor, 0, 'the pot is empty')
    assert.deepEqual(
      allOps(),
      ['hold_deposit', 'record_ledger_entry', 'apply_deposit', 'refund_deposit'],
      'four ops in the order the desk wrote them; the two deposit lines queue none',
    )
  })
})
