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
import { LOCAL_SCHEMA, argsOf, monthlyStatementText, oldestUnpaidMs } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import {
  assetEarnings,
  chargedButReturned,
  correctEntry,
  customersByBalance,
  customerView,
  quoteFlags,
  setBlacklisted,
  duplicateEntries,
  khataLabels,
  recordEntry,
  settlements,
  waiveLateFee,
  waivedFees,
  writeOffEntry,
} from '../src/demo/khata.ts'
import { holdDeposit } from '../src/demo/deposits.ts'
import { SessionRegistry } from '../src/demo/sessions.ts'
import { confirmBooking, createBooking } from '../src/demo/bookings.ts'
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
  seed = seedDemo(db, NOW)
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

  test('a written-off charge whose item came back offers no dead Reverse button', () => {
    // The notice reads the WHOLE settled rule, not just reversals. A charge
    // that was written off and whose item then came home used to keep
    // offering "charged, then it came back — Reverse?", and the tap could
    // never write anything: the ledger refuses a second settlement, so the
    // card came back unarmed every time.
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-ayesha', kind: 'charge',
      amountMinor: rs(90_000), jobId: 'job-doc', assetId: 'asset-fx6-3',
      note: 'Did not come back', createdAt: NOW,
    }, ids())
    // Scanned home through the real session, on an injected clock, so the
    // check-in genuinely lands after the charge on the book's axis.
    const registry = new SessionRegistry(db, 'corrections-device', () => ['asset-fx6-3'],
      () => NOW + 60_000)
    const entry = registry.open('job-doc', 'in')
    assert.equal(entry.session.addManually('asset-fx6-3', 'check_in').outcome, 'accepted')
    assert.deepEqual(
      chargedButReturned(db).map((n) => n.entryId), [charge],
      'uncorrected, so the decision is still the owner\'s',
    )

    writeOffEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Wrote it off instead', whenMs: NOW + 2 * 60_000,
    }, ids(NOW + 2 * 60_000))
    assert.deepEqual(chargedButReturned(db), [], 'settled is settled, whichever way')
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

describe('the waived fee', () => {
  test('the fee is written and written off: nothing owed, the favour on the record', () => {
    const before = customerView(db, 'cust-ayesha').balanceMinor
    const r = waiveLateFee(db, {
      orgId: seed.orgId, jobId: 'job-doc', amountMinor: rs(4_000),
      reason: 'Long client, first time late', whenMs: NOW,
    }, ids())
    assert.equal(r.ok, true)

    const v = customerView(db, 'cust-ayesha')
    assert.equal(v.balanceMinor, before, 'a waiver costs the client nothing')
    // Two lines, both in the book, netting to zero.
    const fee = v.entries.find((e) => e.id === r.id)
    assert.equal(fee.kind, 'late_fee')
    assert.equal(fee.amountMinor, rs(4_000))
    const off = v.entries.find((e) => e.correctsEntryId === r.id)
    assert.equal(off.kind, 'write_off')
    assert.equal(off.amountMinor, -rs(4_000))
    // And the khata reads them as one story.
    assert.equal(v.settled.get(r.id).kind, 'write_off')

    const [w] = waivedFees(db, 'cust-ayesha')
    assert.equal(w.entryId, r.id)
    assert.equal(w.amountMinor, rs(4_000))
    assert.equal(w.jobId, 'job-doc')
    assert.equal(w.reason, 'Long client, first time late')
    assert.equal(w.waivedAt, NOW)
  })

  test('a waived fee earns the month nothing — it was never income', () => {
    const before = monthProfit(db, NOW).earnedMinor
    assert.equal(waiveLateFee(db, {
      orgId: seed.orgId, jobId: 'job-doc', amountMinor: rs(198_000),
      reason: 'Forgiven', whenMs: NOW,
    }, ids()).ok, true)
    assert.equal(monthProfit(db, NOW).earnedMinor, before)
  })

  test('both ops cross, the write-off chained behind the fee it forgives', () => {
    const r = waiveLateFee(db, {
      orgId: seed.orgId, jobId: 'job-doc', amountMinor: rs(4_000),
      reason: 'Goodwill', whenMs: NOW,
    }, ids())
    const queued = ops('record_ledger_entry')
    const fee = queued.find((o) => o.payload.client_ledger_entry_id === r.id)
    const off = queued.find((o) => o.payload.p_entry_kind === 'write_off')
    assert.equal(fee.payload.p_entry_kind, 'late_fee')
    assert.equal(off.payload.p_corrects_entry_id, r.id)
    assert.equal(off.dependsOn, fee.id, 'the server must have the fee before it is forgiven')
  })

  test('no reason, no customer and a zero figure all write nothing', () => {
    assert.equal(waiveLateFee(db, {
      orgId: seed.orgId, jobId: 'job-doc', amountMinor: rs(4_000), reason: '  ', whenMs: NOW,
    }, ids()).reason, 'no_reason')
    // job-tvc-2 has no customer wired in the seed's shape; an unknown job
    // is the same refusal, and neither writes a line.
    assert.equal(waiveLateFee(db, {
      orgId: seed.orgId, jobId: 'job-nobody', amountMinor: rs(4_000), reason: 'x', whenMs: NOW,
    }, ids()).reason, 'not_found')
    assert.equal(waiveLateFee(db, {
      orgId: seed.orgId, jobId: 'job-doc', amountMinor: 0, reason: 'x', whenMs: NOW,
    }, ids()).ok, false)
    assert.deepEqual(waivedFees(db, 'cust-ayesha'), [])
  })

  test('a plain write-off on a charge is not a waived fee', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-ayesha', kind: 'charge',
      amountMinor: rs(9_000), createdAt: NOW,
    }, ids())
    writeOffEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Absconded', whenMs: NOW + 1,
    }, ids(NOW + 1))
    assert.deepEqual(waivedFees(db, 'cust-ayesha'), [], 'only a forgiven LATE FEE is a favour')
  })
})

describe('the do-not-rent decision', () => {
  test('the flag, the reason and the date land locally, and the op crosses', () => {
    const r = setBlacklisted(db, {
      customerId: 'cust-ayesha', on: true,
      reason: 'Rs 2.6M of gear never came back', whenMs: NOW,
    }, ids())
    assert.equal(r.ok, true)
    assert.equal(r.blacklisted, true)

    const v = customerView(db, 'cust-ayesha')
    assert.equal(v.blacklisted, true)
    assert.equal(v.blacklistReason, 'Rs 2.6M of gear never came back')
    assert.equal(v.blacklistedAt, NOW)
    // The owed list carries the stamp too — it is where the desk looks.
    assert.equal(customersByBalance(db).find((c) => c.id === 'cust-ayesha').blacklisted, true)

    const [op] = ops('set_customer_blacklisted')
    assert.deepEqual(op.payload, {
      p_customer_id: 'cust-ayesha',
      p_on: true,
      p_reason: 'Rs 2.6M of gear never came back',
    })
    assert.deepEqual(argsOf('set_customer_blacklisted', op.payload), op.payload,
      'every key is an RPC argument — the phone mints nothing here')
  })

  test('0022\'s confirm gate refuses the blacklisted client, and stands down when lifted', () => {
    const made = createBooking(db, seed.orgId, {
      customerId: 'cust-bilal',
      startMs: NOW + 86_400_000,
      endMs: NOW + 86_400_000 * 3,
      lines: [{ assetId: 'asset-fx9-1' }],
      status: 'pencil',
    }, NOW)
    assert.equal(made.ok, true)

    assert.equal(setBlacklisted(db, {
      customerId: 'cust-bilal', on: true, reason: 'Cheque bounced twice', whenMs: NOW,
    }, ids()).ok, true)
    const refused = confirmBooking(db, seed.orgId, made.bookingId, {}, NOW)
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'blacklisted')

    assert.equal(setBlacklisted(db, {
      customerId: 'cust-bilal', on: false, reason: null, whenMs: NOW + 1,
    }, ids(NOW + 1)).ok, true)
    assert.equal(confirmBooking(db, seed.orgId, made.bookingId, {}, NOW).ok, true)
  })

  test('refusing a client with no reason writes nothing; lifting needs none', () => {
    assert.equal(setBlacklisted(db, {
      customerId: 'cust-bilal', on: true, reason: '   ', whenMs: NOW,
    }, ids()).reason, 'no_reason')
    assert.equal(customerView(db, 'cust-bilal').blacklisted, false)
    assert.equal(ops('set_customer_blacklisted').length, 0)

    assert.equal(setBlacklisted(db, {
      customerId: 'cust-bilal', on: false, reason: null, whenMs: NOW,
    }, ids()).ok, true, 'letting someone back in refuses nobody')
  })

  test('lifting it clears the sentence, and an unknown client is refused', () => {
    setBlacklisted(db, {
      customerId: 'cust-bilal', on: true, reason: 'For now', whenMs: NOW,
    }, ids())
    setBlacklisted(db, {
      customerId: 'cust-bilal', on: false, reason: null, whenMs: NOW + 1,
    }, ids(NOW + 1))
    const v = customerView(db, 'cust-bilal')
    assert.equal(v.blacklisted, false)
    assert.equal(v.blacklistReason, null)
    assert.equal(v.blacklistedAt, null)

    assert.equal(setBlacklisted(db, {
      customerId: 'cust-nobody', on: true, reason: 'x', whenMs: NOW,
    }, ids()).reason, 'not_found')
  })

  test('the quote flags ladder drops to refuse', () => {
    setBlacklisted(db, {
      customerId: 'cust-bilal', on: true, reason: 'Absconded', whenMs: NOW,
    }, ids())
    const f = quoteFlags(db, 'cust-bilal')
    assert.equal(f.blacklisted, true)
    assert.equal(f.fastLane, false)
    assert.equal(f.depositHint, 'refuse')
  })
})
