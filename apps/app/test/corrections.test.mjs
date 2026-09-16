/**
 * The correction door against a real SQLite (W13, `no-adjustment-door`).
 *
 * The year's DEC double-tap, FEB's bounced cheque and MAY's forgiven fee
 * all needed a screen that could post a reversal or a write-off, and the
 * app had none. What is pinned here: the two doors write the RIGHT KIND
 * with the amount copied from the target, both refuse without a reason,
 * neither can be used twice on one line, the book reads the pair as ONE
 * story, and each queues record_ledger_entry naming the line it settles
 * and chained behind it.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, monthlyStatementText, oldestUnpaidMs } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import {
  assetEarnings,
  correctEntry,
  customerView,
  duplicateEntries,
  khataLabels,
  recordEntry,
  settlements,
  writeOffEntry,
} from '../src/demo/khata.ts'
import { holdDeposit } from '../src/demo/deposits.ts'
import { monthProfit } from '../src/demo/kharcha.ts'
import { STR_EN } from '../src/strings.ts'

let db
let seed
let seq
const NOW = new Date(2026, 10, 10, 12).getTime()
const ids = (nowMs = NOW) => ({ now: () => nowMs, newId: () => `op-${++seq}` })
const ops = (op) =>
  db
    .all(`select id, payload, depends_on from outbox where op = ? order by seq`, [op])
    .map((r) => ({ id: r.id, dependsOn: r.depends_on, payload: JSON.parse(r.payload) }))
const rs = (rupees) => rupees * 100

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  seq = 0
})

describe('correct this', () => {
  test('a reversal negates the line exactly, keeps the reason, and settles it', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-imran', kind: 'damage_charge',
      amountMinor: rs(30_000), jobId: 'job-imran-drama', note: 'Cracked monitor hood',
      createdAt: NOW,
    }, ids())
    const before = customerView(db, 'cust-imran').balanceMinor

    const r = correctEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Entered twice at the dock', whenMs: NOW + 5000,
    }, ids(NOW + 5000))
    assert.equal(r.ok, true)

    const v = customerView(db, 'cust-imran')
    assert.equal(v.balanceMinor, before - rs(30_000), 'the debt goes back to where it was')
    const settled = v.settled.get(charge)
    assert.equal(settled.kind, 'reversal')
    assert.equal(settled.amountMinor, -rs(30_000))
    assert.equal(settled.note, 'Entered twice at the dock')
    assert.equal(settled.byId, r.id)
    // The reversal carries the target's own links, so the story stays whole.
    const rev = v.entries.find((e) => e.id === r.id)
    assert.equal(rev.reversalOf, charge)
    assert.equal(rev.jobId, 'job-imran-drama')
  })

  test('it queues record_ledger_entry as a reversal, chained behind the line it voids', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(10_000), jobId: 'job-shan', note: 'Extra day', createdAt: NOW,
    }, ids())
    const r = correctEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Never went out', whenMs: NOW + 1,
    }, ids(NOW + 1))
    const [first, second] = ops('record_ledger_entry')
    assert.equal(second.payload.client_ledger_entry_id, r.id)
    assert.equal(second.payload.p_entry_kind, 'reversal')
    assert.equal(second.payload.p_amount_minor, -rs(10_000))
    assert.equal(second.payload.p_reversal_of, charge)
    assert.equal(second.payload.p_corrects_entry_id, null)
    assert.equal(second.payload.p_note, 'Never went out')
    assert.equal(second.dependsOn, first.id, 'the reversal waits for the line it voids')
  })

  test('a blank reason writes nothing — the judgement is always recorded', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(1_000), createdAt: NOW,
    }, ids())
    for (const reason of [null, '', '   ']) {
      const r = correctEntry(db, { orgId: seed.orgId, entryId: charge, reason, whenMs: NOW }, ids())
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'no_reason')
    }
    assert.equal(customerView(db, 'cust-bilal').settled.size, 0)
    assert.equal(ops('record_ledger_entry').length, 1, 'only the charge was written')
  })

  test('a line can only be settled once, and a correction cannot be corrected', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(2_000), createdAt: NOW,
    }, ids())
    const first = correctEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Wrong client', whenMs: NOW,
    }, ids())
    assert.equal(first.ok, true)

    const twice = correctEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Again', whenMs: NOW,
    }, ids())
    assert.equal(twice.reason, 'already_settled')

    const ofRev = correctEntry(db, {
      orgId: seed.orgId, entryId: first.id, reason: 'Undo the undo', whenMs: NOW,
    }, ids())
    assert.equal(ofRev.reason, 'is_settlement')
  })

  test('deposit money is not correctable — it moves through apply and refund', () => {
    holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', amountMinor: rs(10_000), heldAt: NOW,
    }, ids())
    const line = customerView(db, 'cust-bilal').entries.find((e) => e.kind === 'deposit_hold')
    const r = correctEntry(db, {
      orgId: seed.orgId, entryId: line.id, reason: 'Wrong amount', whenMs: NOW,
    }, ids())
    assert.equal(r.reason, 'deposit_line')
  })

  test('an unknown line is refused, never invented', () => {
    assert.equal(correctEntry(db, {
      orgId: seed.orgId, entryId: 'led-nobody', reason: 'x', whenMs: NOW,
    }, ids()).reason, 'not_found')
  })

  test('the debt clock survives a corrected payment — FEB\'s bounced cheque', () => {
    // A payment that clears the book and then bounces must not make a
    // six-week debt look six days old (fixed bug (a)4, pinned here through
    // the real door instead of a hand-built pair).
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', kind: 'charge',
      amountMinor: rs(50_000), createdAt: NOW,
    }, ids())
    const paid = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', kind: 'payment',
      amountMinor: -rs(50_000), note: 'Cheque', createdAt: NOW + 86_400_000 * 40,
    }, ids())
    assert.equal(correctEntry(db, {
      orgId: seed.orgId, entryId: paid, reason: 'Cheque bounced',
      whenMs: NOW + 86_400_000 * 46,
    }, ids()).ok, true)

    const v = customerView(db, 'cust-hamza')
    assert.equal(v.balanceMinor, rs(50_000))
    assert.equal(
      oldestUnpaidMs(v.entries),
      NOW,
      'the debt still dates from the charge, not from the bounce',
    )
    assert.equal(v.settled.get(paid).note, 'Cheque bounced')
    void charge
  })
})

describe('write it off', () => {
  test('a write-off forgives the line through corrects_entry_id, never as a reversal', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-ayesha', kind: 'charge',
      amountMinor: rs(20_000), jobId: 'job-doc', note: 'Third extra day', createdAt: NOW,
    }, ids())
    const before = customerView(db, 'cust-ayesha').balanceMinor

    const r = writeOffEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Goodwill — long client', whenMs: NOW + 1,
    }, ids(NOW + 1))
    assert.equal(r.ok, true)

    const v = customerView(db, 'cust-ayesha')
    assert.equal(v.balanceMinor, before - rs(20_000))
    const row = v.entries.find((e) => e.id === r.id)
    assert.equal(row.kind, 'write_off')
    assert.equal(row.amountMinor, -rs(20_000))
    assert.equal(row.correctsEntryId, charge)
    assert.equal(row.reversalOf, null, 'the server allows p_reversal_of on a reversal alone')
    assert.equal(v.settled.get(charge).kind, 'write_off')

    const op = ops('record_ledger_entry').find((o) => o.payload.client_ledger_entry_id === r.id)
    assert.equal(op.payload.p_entry_kind, 'write_off')
    assert.equal(op.payload.p_corrects_entry_id, charge)
    assert.equal(op.payload.p_reversal_of, null)
    assert.equal(op.payload.p_amount_minor, -rs(20_000))
  })

  test('the statement prints "write-off", never the house\'s own "adjustment"', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-ayesha', kind: 'charge',
      amountMinor: rs(4_000), createdAt: NOW,
    }, ids())
    writeOffEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Forgiven', whenMs: NOW + 1,
    }, ids(NOW + 1))
    const text = monthlyStatementText(
      {
        customerName: 'Ayesha Raza',
        houseName: 'Sachdeva',
        entries: customerView(db, 'cust-ayesha').entries,
        nowMs: NOW,
        paymentLine: null,
      },
      khataLabels(STR_EN),
    )
    assert.match(text, /write-off/)
    assert.doesNotMatch(text, /adjustment/)
  })

  test('money the customer never owed cannot be written off', () => {
    const paid = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', kind: 'payment',
      amountMinor: -rs(5_000), createdAt: NOW,
    }, ids())
    const r = writeOffEntry(db, {
      orgId: seed.orgId, entryId: paid, reason: 'Gift', whenMs: NOW,
    }, ids())
    assert.equal(r.ok, false)
  })

  test('a written-off charge stops counting as the unit\'s earnings and the month\'s income', () => {
    const before = assetEarnings(db, 'asset-fx9-1').earnedMinor
    const beforeMonth = monthProfit(db, NOW).earnedMinor
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(15_000), assetId: 'asset-fx9-1', createdAt: NOW,
    }, ids())
    assert.equal(assetEarnings(db, 'asset-fx9-1').earnedMinor, before + rs(15_000))
    assert.equal(monthProfit(db, NOW).earnedMinor, beforeMonth + rs(15_000))

    writeOffEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Not chasing it', whenMs: NOW + 1,
    }, ids(NOW + 1))
    assert.equal(
      assetEarnings(db, 'asset-fx9-1').earnedMinor, before,
      'a forgiven charge never earned the camera a rupee',
    )
    assert.equal(monthProfit(db, NOW).earnedMinor, beforeMonth)
  })
})

describe('the book reads the pair as one story', () => {
  test('settlements are keyed by the line they settle, first one wins', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(3_000), createdAt: NOW,
    }, ids())
    correctEntry(db, { orgId: seed.orgId, entryId: charge, reason: 'One', whenMs: NOW + 1 }, ids(NOW + 1))
    const entries = customerView(db, 'cust-bilal').entries
    const map = settlements(entries)
    assert.equal(map.size, 1)
    assert.equal([...map.keys()][0], charge)
  })

  test('a settlement naming a line this customer does not have is ignored', () => {
    // A reversal whose target is on another khata (or gone) must not
    // strike a random row through.
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'reversal',
      amountMinor: -rs(1_000), reversalOf: 'led-elsewhere', note: 'x', createdAt: NOW,
    }, ids())
    assert.equal(customerView(db, 'cust-bilal').settled.size, 0)
  })
})

describe('the double-tap question', () => {
  test('two identical charges seconds apart surface as one question', () => {
    const first = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-imran', kind: 'damage_charge',
      amountMinor: rs(30_000), jobId: 'job-imran-drama', note: 'Cracked monitor hood',
      createdAt: NOW,
    }, ids())
    const second = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-imran', kind: 'damage_charge',
      amountMinor: rs(30_000), jobId: 'job-imran-drama', note: 'Cracked monitor hood',
      createdAt: NOW + 4_000,
    }, ids(NOW + 4_000))

    const [d] = duplicateEntries(db)
    assert.equal(d.firstId, first)
    assert.equal(d.entryId, second, 'the question is about the SECOND line')
    assert.equal(d.amountMinor, rs(30_000))
    assert.equal(d.secondsApart, 4)
    assert.equal(d.customerName, 'Imran Qureshi')
  })

  test('the write is never blocked — both lines are in the book', () => {
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-imran', kind: 'charge',
      amountMinor: rs(1_000), createdAt: NOW,
    }, ids())
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-imran', kind: 'charge',
      amountMinor: rs(1_000), createdAt: NOW + 1_000,
    }, ids(NOW + 1_000))
    assert.equal(
      customerView(db, 'cust-imran').entries.filter((e) => e.kind === 'charge' && e.amountMinor === rs(1_000)).length,
      2,
    )
  })

  test('far apart, different amounts, different kinds and different clients are not questions', () => {
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(5_000), createdAt: NOW,
    }, ids())
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(5_000), createdAt: NOW + 120_000,
    }, ids(NOW + 120_000))
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'late_fee',
      amountMinor: rs(7_000), createdAt: NOW,
    }, ids())
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'damage_charge',
      amountMinor: rs(7_000), createdAt: NOW + 1_000,
    }, ids(NOW + 1_000))
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', kind: 'charge',
      amountMinor: rs(7_000), createdAt: NOW + 1_000,
    }, ids(NOW + 1_000))
    assert.deepEqual(duplicateEntries(db), [])
  })

  test('a corrected duplicate stops asking', () => {
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-imran', kind: 'charge',
      amountMinor: rs(8_000), createdAt: NOW,
    }, ids())
    const second = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-imran', kind: 'charge',
      amountMinor: rs(8_000), createdAt: NOW + 2_000,
    }, ids(NOW + 2_000))
    assert.equal(duplicateEntries(db).length, 1)
    correctEntry(db, {
      orgId: seed.orgId, entryId: second, reason: 'Entered twice', whenMs: NOW + 9_000,
    }, ids(NOW + 9_000))
    assert.deepEqual(duplicateEntries(db), [])
  })
})
