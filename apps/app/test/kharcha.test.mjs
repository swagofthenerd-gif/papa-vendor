/**
 * The expense side of the money book against a real SQLite — the kharcha
 * read model.
 *
 * What is worth pinning down: the seeded expense history (the three
 * stories every screen renders), that recording is INSERT-only and every
 * amount positive, the void-pair reversal semantics (both rows leave
 * every sum, once, never a chain), the day and month slices the hisaab
 * renders, the month profit line (earned − spent, reversed charges out),
 * per-job margin, and the payback bar's new denominator: replacement
 * value PLUS repairs, with the unpriced honesty rules intact.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, liveExpenses, totalExpenses } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import {
  assetCosts,
  expenseRows,
  jobMargin,
  kharchaBetween,
  monthProfit,
  recordExpense,
  reverseExpense,
} from '../src/demo/kharcha.ts'
import { assetEarnings, recordEntry } from '../src/demo/khata.ts'
import { dayAccount, dayAccountText, dayBounds } from '../src/demo/hisaab.ts'
import { STR_EN } from '../src/strings.ts'
import { STR_UR } from '../src/strings-ur.ts'

let db
let seed

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
})

const rs = (rupees) => rupees * 100

describe('the seeded expense book', () => {
  test('three stories: a repair, a sub-hire, a purchase', () => {
    const rows = expenseRows(db)
    assert.equal(rows.length, 3)
    const kinds = rows.map((e) => e.kind).sort()
    assert.deepEqual(kinds, ['purchase', 'repair', 'sub_hire'])
    // Every seeded amount is positive — the book's one sign rule.
    assert.ok(rows.every((e) => e.amountMinor > 0))
  })

  test('the repair names the FX9 the photo dispute is about', () => {
    const repair = expenseRows(db).find((e) => e.kind === 'repair')
    assert.equal(repair.assetId, 'asset-fx9-1')
    assert.equal(repair.counterparty, 'Sharif Camera Works')
    const costs = assetCosts(db, 'asset-fx9-1')
    assert.equal(costs.repairMinor, rs(45_000))
    assert.equal(costs.repairCount, 1)
  })

  test('the sub-hire names the job it rescued, and the margin says so', () => {
    const sub = expenseRows(db).find((e) => e.kind === 'sub_hire')
    assert.equal(sub.jobId, 'job-imran-drama')
    const m = jobMargin(db, 'job-imran-drama')
    assert.equal(m.incomeMinor, rs(40_000)) // Imran's seeded Komodo charge
    assert.equal(m.expenseMinor, rs(18_000))
    assert.equal(m.marginMinor, rs(22_000))
    assert.equal(m.expenseCount, 1)
  })

  test('a job with no expenses has a margin equal to its income', () => {
    const m = jobMargin(db, 'job-hamza-mehndi')
    assert.equal(m.incomeMinor, rs(80_000))
    assert.equal(m.expenseMinor, 0)
    assert.equal(m.marginMinor, rs(80_000))
    assert.equal(m.expenseCount, 0)
  })
})

describe('recordExpense', () => {
  test('an INSERT, and the projections follow', () => {
    const before = expenseRows(db).length
    const id = recordExpense(db, {
      orgId: seed.orgId,
      kind: 'transport',
      amountMinor: rs(3_000),
      note: 'Fuel — two runs',
      createdAt: Date.now(),
    })
    assert.ok(id)
    assert.equal(expenseRows(db).length, before + 1)
    assert.equal(totalExpenses(expenseRows(db)), rs(45_000 + 18_000 + 16_000 + 3_000))
  })

  test('a zero or negative amount writes NOTHING', () => {
    // A zero-rupee expense is a record of nothing; a negative one is a
    // reversal wearing a costume. Both refused, neither inserted.
    const before = expenseRows(db).length
    assert.equal(
      recordExpense(db, { orgId: seed.orgId, kind: 'misc', amountMinor: 0, createdAt: Date.now() }),
      null,
    )
    assert.equal(
      recordExpense(db, { orgId: seed.orgId, kind: 'misc', amountMinor: -rs(500), createdAt: Date.now() }),
      null,
    )
    assert.equal(expenseRows(db).length, before)
  })

  test('the counterparty is stored trimmed, blank becomes null', () => {
    const id = recordExpense(db, {
      orgId: seed.orgId,
      kind: 'misc',
      amountMinor: rs(100),
      counterparty: '   ',
      createdAt: Date.now(),
    })
    const row = expenseRows(db).find((e) => e.id === id)
    assert.equal(row.counterparty, null)
  })
})

describe('reverseExpense — the void pair', () => {
  test('the reversal copies its target and BOTH rows leave every sum', () => {
    const id = recordExpense(db, {
      orgId: seed.orgId,
      kind: 'purchase',
      amountMinor: rs(9_000),
      counterparty: 'Hall Road',
      createdAt: Date.now(),
    })
    const before = totalExpenses(expenseRows(db))
    assert.equal(reverseExpense(db, seed.orgId, id, 'entered twice', Date.now()), true)

    const rows = expenseRows(db)
    const rev = rows.find((e) => e.reversalOf === id)
    assert.ok(rev, 'the reversal row exists — append-only stays intact')
    assert.equal(rev.kind, 'purchase')
    assert.equal(rev.amountMinor, rs(9_000))
    // Void-PAIR semantics: unlike the customer ledger (where the pair
    // stays in the sums and cancels), both rows leave the live set.
    const live = liveExpenses(rows)
    assert.ok(!live.some((e) => e.id === id))
    assert.ok(!live.some((e) => e.id === rev.id))
    assert.equal(totalExpenses(rows), before - rs(9_000))
  })

  test('a second reversal is refused — a double-tap cannot over-credit', () => {
    const id = recordExpense(db, {
      orgId: seed.orgId, kind: 'misc', amountMinor: rs(500), createdAt: Date.now(),
    })
    assert.equal(reverseExpense(db, seed.orgId, id, null, Date.now()), true)
    assert.equal(reverseExpense(db, seed.orgId, id, null, Date.now()), false)
    assert.equal(expenseRows(db).filter((e) => e.reversalOf === id).length, 1)
  })

  test('a reversal cannot be reversed — record the expense again instead', () => {
    const id = recordExpense(db, {
      orgId: seed.orgId, kind: 'misc', amountMinor: rs(500), createdAt: Date.now(),
    })
    reverseExpense(db, seed.orgId, id, null, Date.now())
    const rev = expenseRows(db).find((e) => e.reversalOf === id)
    assert.equal(reverseExpense(db, seed.orgId, rev.id, null, Date.now()), false)
  })

  test('an unknown id reverses nothing', () => {
    assert.equal(reverseExpense(db, seed.orgId, 'exp-nobody', null, Date.now()), false)
  })
})

describe('the day slice (the hisaab Kharcha section)', () => {
  test('today holds what was spent today, not the seeded history', () => {
    const now = Date.now()
    // The seed's expenses are days old — today opens honest and empty.
    const empty = kharchaBetween(db, dayBounds(now).startMs, dayBounds(now).endMs)
    assert.equal(empty.rows.length, 0)
    assert.equal(empty.totalMinor, 0)

    recordExpense(db, {
      orgId: seed.orgId, kind: 'repair', amountMinor: rs(4_000),
      counterparty: 'Sharif Camera Works', createdAt: now,
    })
    const { startMs, endMs } = dayBounds(now)
    const day = kharchaBetween(db, startMs, endMs)
    assert.equal(day.rows.length, 1)
    assert.equal(day.totalMinor, rs(4_000))
  })

  test('a reversal written today voids a row written yesterday', () => {
    const now = Date.now()
    const yesterday = now - 24 * 60 * 60 * 1000
    const id = recordExpense(db, {
      orgId: seed.orgId, kind: 'misc', amountMinor: rs(2_000), createdAt: yesterday,
    })
    reverseExpense(db, seed.orgId, id, null, now)
    // The live filter runs over the whole book: neither yesterday's slice
    // nor today's shows either half of the voided pair.
    const y = dayBounds(yesterday)
    assert.equal(kharchaBetween(db, y.startMs, y.endMs).rows.length, 0)
    const t = dayBounds(now)
    assert.equal(kharchaBetween(db, t.startMs, t.endMs).rows.length, 0)
  })

  test('the day account carries the kharcha and its share text says it', () => {
    const now = Date.now()
    recordExpense(db, {
      orgId: seed.orgId, kind: 'sub_hire', amountMinor: rs(18_000),
      counterparty: 'Noor Light & Grip', createdAt: now,
    })
    const account = dayAccount(db, now)
    assert.equal(account.kharcha.totalMinor, rs(18_000))
    const text = dayAccountText(account)
    assert.ok(text.includes('Kharcha: Rs 18,000'))
    assert.ok(text.includes('sub-hire Rs 18,000 — Noor Light & Grip'))
  })

  test('a quiet day says nothing about kharcha in the share text', () => {
    const text = dayAccountText(dayAccount(db, Date.now()))
    assert.ok(!text.includes('Kharcha:'))
  })
})

describe('monthProfit — the vendor-dream figure', () => {
  // A far-future month, so nothing seeded (relative days-ago rows) can
  // drift into the window and the arithmetic is exact.
  const at = (d, h = 12) => new Date(2031, 4, d, h).getTime()

  beforeEach(() => {
    db.exec(`insert into customers (id, org_id, name) values ('cust-may', ?, 'May Films')`, [
      seed.orgId,
    ])
  })

  test('earned − spent, with every exclusion honest', () => {
    const line = (kind, amountMinor, createdAt, extra = {}) =>
      recordEntry(db, {
        orgId: seed.orgId, customerId: 'cust-may', kind, amountMinor, createdAt, ...extra,
      })
    line('charge', rs(90_000), at(3))
    line('late_fee', rs(10_000), at(5))
    line('payment', -rs(50_000), at(6)) // payments are never income
    // A charged-then-returned item: the reversal voids it out of income.
    const ghost = line('charge', rs(25_000), at(8))
    line('reversal', -rs(25_000), at(9), { reversalOf: ghost })

    recordExpense(db, {
      orgId: seed.orgId, kind: 'repair', amountMinor: rs(45_000), createdAt: at(10),
    })
    const fuel = recordExpense(db, {
      orgId: seed.orgId, kind: 'transport', amountMinor: rs(5_000), createdAt: at(11),
    })
    reverseExpense(db, seed.orgId, fuel, 'entered twice', at(12))

    const p = monthProfit(db, at(15))
    assert.equal(p.earnedMinor, rs(100_000))
    assert.equal(p.spentMinor, rs(45_000))
    assert.equal(p.profitMinor, rs(55_000))
    assert.equal(p.expenseCount, 1)
    assert.equal(p.monthLabel, 'May 2031')
  })

  test('a month that spent more than it billed reads as the honest loss', () => {
    recordExpense(db, {
      orgId: seed.orgId, kind: 'repair', amountMinor: rs(45_000), createdAt: at(10),
    })
    const p = monthProfit(db, at(15))
    assert.equal(p.earnedMinor, 0)
    assert.equal(p.profitMinor, -rs(45_000))
  })

  test('an empty month is zeros with an honest count, never a lie', () => {
    const p = monthProfit(db, new Date(2032, 0, 15).getTime())
    assert.equal(p.earnedMinor, 0)
    assert.equal(p.spentMinor, 0)
    assert.equal(p.profitMinor, 0)
    assert.equal(p.expenseCount, 0)
  })
})

describe('the payback bar meets the repair bill', () => {
  test('the denominator is replacement value PLUS repairs', () => {
    // POLICY (owner may overrule): a camera that needed a Rs 45,000
    // repair has genuinely cost more to keep earning.
    const e = assetEarnings(db, 'asset-fx9-1')
    assert.equal(e.earnedMinor, rs(60_000 + 45_000))
    assert.equal(e.replacementMinor, rs(3_500_000))
    assert.equal(e.repairMinor, rs(45_000))
    assert.equal(e.repairCount, 1)
    assert.equal(e.costMinor, rs(3_545_000))
    assert.equal(e.paybackPct, Math.round((rs(105_000) / rs(3_545_000)) * 100))
  })

  test('a new repair moves the bar the moment it is recorded', () => {
    const before = assetEarnings(db, 'asset-fx9-1')
    recordExpense(db, {
      orgId: seed.orgId, kind: 'repair', amountMinor: rs(455_000),
      assetId: 'asset-fx9-1', createdAt: Date.now(),
    })
    const after = assetEarnings(db, 'asset-fx9-1')
    assert.equal(after.costMinor, rs(4_000_000))
    assert.ok(after.paybackPct <= before.paybackPct)
  })

  test('no replacement value still means NO bar — repairs alone are not a cost', () => {
    // The unpriced honesty rule holds: a tiny repairs-only denominator
    // would make every bar read paid-off, the confident lie inverted.
    recordExpense(db, {
      orgId: seed.orgId, kind: 'repair', amountMinor: rs(2_000),
      assetId: 'asset-sachdeva-1', createdAt: Date.now(),
    })
    const e = assetEarnings(db, 'asset-sachdeva-1')
    assert.equal(e.repairMinor, rs(2_000))
    assert.equal(e.costMinor, null)
    assert.equal(e.paybackPct, null)
  })

  test('a voided repair leaves the denominator', () => {
    const id = recordExpense(db, {
      orgId: seed.orgId, kind: 'repair', amountMinor: rs(100_000),
      assetId: 'asset-fx9-1', createdAt: Date.now(),
    })
    assert.equal(assetEarnings(db, 'asset-fx9-1').costMinor, rs(3_645_000))
    reverseExpense(db, seed.orgId, id, 'was warranty work', Date.now())
    assert.equal(assetEarnings(db, 'asset-fx9-1').costMinor, rs(3_545_000))
  })
})

describe('the kharcha words', () => {
  test('every expense kind has a word in both tables', () => {
    const kinds = ['repair', 'sub_hire', 'purchase', 'transport', 'consumables', 'misc']
    for (const table of [STR_EN, STR_UR]) {
      for (const kind of kinds) {
        const word = table.kharchaKindLabel(kind)
        assert.equal(typeof word, 'string')
        assert.ok(word.length > 0)
        // A raw snake_case kind leaking through means the lookup missed.
        assert.ok(!word.includes('_'), `${kind} fell through in a table`)
      }
    }
  })
})
