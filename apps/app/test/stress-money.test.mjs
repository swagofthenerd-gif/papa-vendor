/**
 * Adversarial stress: the money book against the scanner, and the UI-logic
 * edges where dates, empty books, and hostile input meet the read models.
 *
 * The centrepiece is the charge-from-the-dock question (report finding,
 * not invented policy): a return session shows a shortfall, the owner
 * charges the client for the missing item, and THEN the item is rescanned
 * home. What happens is pinned exactly as observed: the charge stays on
 * the khata, nothing offsets it, no surface hints that the charged item
 * came back, and the per-asset payback bar counts the damage money as
 * earnings. Whether that is right is the owner's call; these tests make
 * the current answer visible instead of accidental.
 *
 * Everything else: seeded-random khata round-trips against a real SQLite,
 * the money strip over an empty book / zero-entry customers / month
 * edges, and dueStatus under ISO-with-timezone, rollover, and free-text
 * dates. Deterministic throughout — mulberry32 seeds, fixed timestamps in
 * 2030 (far from seedDemo's wall-clock-relative entries), no Date.now in
 * any assertion's arithmetic.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import {
  LOCAL_SCHEMA,
  projectLedger,
  dueStatus,
  parseDueDate,
  compareDueDates,
} from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { SessionRegistry } from '../src/demo/sessions.ts'
import {
  assetEarnings,
  customerForJob,
  customersByBalance,
  customerView,
  isoDate,
  moneyStrip,
  recordEntry,
} from '../src/demo/khata.ts'
import {
  assetFacts,
  decodeScanOps,
  dueBoard,
  sessionScanFacts,
  setExpectedBack,
} from '../src/demo/read-model.ts'
import { buildSummary } from '../src/session-summary.ts'

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

/** Fixed test-era base: 15 Jun 2030, local — far from the seeded book. */
const NOW = new Date(2030, 5, 15, 11, 0).getTime()

let db
let seed

const expectedFor = (jobId, mode) => {
  if (mode === 'out') return seed.jobs.find((j) => j.id === jobId)?.expected ?? []
  return db
    .all(
      `select id from assets
        where current_job_id = ? and presence in ('out', 'in_transit')
        order by asset_code`,
      [jobId],
    )
    .map((r) => r.id)
}

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
})

// ------------------------------------------------ charged, then it came home

describe('charge-from-the-dock versus a shortfall that heals (report finding)', () => {
  test('the charge stays, nothing offsets it, and the payback bar counts it — pinned end to end', () => {
    const registry = new SessionRegistry(db, 'stress-device', expectedFor)

    // The seeded overdue job: asset-fx6-3 is physically out on job-doc,
    // whose customer is Ayesha with Rs 55,000 already on the book.
    const before = customerView(db, 'cust-ayesha')
    assert.equal(before.balanceMinor, 55_000_00)

    // The return session opens; the FX6 has not come back.
    const entry = registry.open('job-doc', 'in')
    assert.deepEqual(entry.expected, ['asset-fx6-3'])
    const facts0 = sessionScanFacts(decodeScanOps(db), entry.session.id)
    const summary0 = buildSummary({
      jobLabel: 'Documentary — Walled City',
      mode: 'in',
      expected: entry.expected,
      ...facts0,
      facts: (id) => assetFacts(db, id),
    })
    assert.equal(summary0.missing.length, 1)
    const fx6 = assetFacts(db, 'asset-fx6-3')
    assert.ok(fx6.replacementMinor > 0, 'the missing line prices at replacement value')
    assert.equal(summary0.missing[0].valueMinor, fx6.replacementMinor)

    // The dock charges the client for the missing camera — the store's
    // chargeClient path, reproduced at the khata layer it delegates to.
    const customer = customerForJob(db, 'job-doc')
    assert.equal(customer.id, 'cust-ayesha')
    recordEntry(db, {
      orgId: seed.orgId,
      customerId: customer.id,
      kind: 'damage_charge',
      amountMinor: fx6.replacementMinor,
      jobId: 'job-doc',
      assetId: 'asset-fx6-3',
      note: 'FX6 not returned — charged at replacement',
      createdAt: NOW,
    })
    assert.equal(
      customerView(db, 'cust-ayesha').balanceMinor,
      55_000_00 + fx6.replacementMinor,
    )

    // …and TWENTY MINUTES LATER the camera turns up on the other truck and
    // is scanned home. The shortfall heals.
    const r = entry.session.addManually('asset-fx6-3', 'check_in')
    assert.equal(r.outcome, 'accepted')
    const facts1 = sessionScanFacts(decodeScanOps(db), entry.session.id)
    const summary1 = buildSummary({
      jobLabel: 'Documentary — Walled City',
      mode: 'in',
      expected: entry.expected,
      ...facts1,
      facts: (id) => assetFacts(db, id),
    })
    assert.equal(summary1.missing.length, 0, 'the shortfall is gone')

    // PIN 1: the charge does NOT move. The book is append-only and no code
    // path writes an offsetting line or links a check_in to a charge.
    const after = customerView(db, 'cust-ayesha')
    assert.equal(after.balanceMinor, 55_000_00 + fx6.replacementMinor)

    // PIN 2: the ONLY reconciliation trail is the entry itself naming the
    // asset and job — an owner must notice and write the adjustment by
    // hand. Nothing derives "charged but returned".
    const trail = after.entries.find((e) => e.kind === 'damage_charge')
    assert.equal(trail.assetId, 'asset-fx6-3')
    assert.equal(trail.jobId, 'job-doc')

    // PIN 3: the payback bar now counts the damage money as earnings for
    // an item that is back on the shelf.
    const earnings = assetEarnings(db, 'asset-fx6-3')
    assert.equal(earnings.earnedMinor, fx6.replacementMinor)
    assert.equal(earnings.paybackPct, 100, 'one dock charge = a 100% "paid for itself" bar')
  })
})

// ----------------------------------------------------- khata fuzz, on SQLite

describe('random books through the real store layer', () => {
  test('40 seeded customers: view, list order, and strip arithmetic all agree with the projection', () => {
    // Silence the seeded book so the arithmetic below owns the whole table.
    db.exec(`delete from customer_ledger_entries`)

    const r = rng(424242)
    const KINDS_POS = ['charge', 'late_fee', 'damage_charge']
    const custIds = []
    for (let c = 0; c < 40; c++) {
      const id = `cust-fuzz-${c}`
      custIds.push(id)
      db.exec(`insert into customers (id, org_id, name, phone) values (?, ?, ?, null)`, [
        id, seed.orgId, `Fuzz Customer ${c}`,
      ])
      const n = int(r, 0, 30) // zero-entry customers included, on purpose
      let t = NOW - int(r, 0, 90) * 24 * 3_600_000
      let pot = 0
      for (let i = 0; i < n; i++) {
        t += int(r, 1, 36) * 3_600_000
        const roll = r()
        let kind
        let amount
        if (roll < 0.4) {
          kind = KINDS_POS[int(r, 0, 2)]
          amount = int(r, 1, 900_000) * 100
        } else if (roll < 0.7) {
          kind = 'payment'
          amount = -int(r, 1, 900_000) * 100
        } else if (roll < 0.85) {
          kind = 'deposit_hold'
          amount = int(r, 1, 300_000) * 100
          pot += amount
        } else if (pot > 0) {
          kind = r() < 0.5 ? 'deposit_apply' : 'deposit_refund'
          amount = -int(r, 1, pot / 100) * 100
          pot += amount
        } else {
          kind = 'adjustment'
          amount = (r() < 0.5 ? 1 : -1) * int(r, 1, 100_000) * 100
        }
        recordEntry(db, {
          orgId: seed.orgId,
          customerId: id,
          kind,
          amountMinor: amount,
          createdAt: t,
        })
      }
    }

    // Per-customer: the view's balance equals the pure projection over its
    // own rows, and the page reads newest-first.
    for (const id of custIds) {
      const v = customerView(db, id)
      const p = projectLedger(v.entries)
      assert.equal(v.balanceMinor, p.balanceMinor, id)
      assert.equal(v.depositHeldMinor, p.depositHeldMinor, id)
      assert.ok(p.depositHeldMinor >= 0, `${id}: the pot went negative`)
      for (let i = 1; i < v.entries.length; i++) {
        assert.ok(
          v.entries[i - 1].createdAt >= v.entries[i].createdAt,
          `${id}: the page must read newest first`,
        )
      }
    }

    // The owed list: biggest debt first, and the strip's sums match it.
    const list = customersByBalance(db)
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].balanceMinor >= list[i].balanceMinor, 'owed list out of order')
    }
    const owing = list.filter((c) => c.balanceMinor > 0)
    const strip = moneyStrip(db, NOW)
    assert.equal(strip.owedMinor, owing.reduce((n, c) => n + c.balanceMinor, 0))
    assert.equal(strip.owingCount, owing.length)
  })
})

// ------------------------------------------------------- the strip's edges

describe('the money strip on thin ice', () => {
  test('an empty ledger produces an all-zero strip, never NaN or null', () => {
    db.exec(`delete from customer_ledger_entries`)
    const strip = moneyStrip(db, NOW)
    assert.deepEqual(strip, {
      owedMinor: 0,
      dueTodayMinor: 0,
      earnedMonthMinor: 0,
      owingCount: 0,
    })
  })

  test('a customer with zero entries is on the list at zero, and never in the owed count', () => {
    db.exec(`insert into customers (id, org_id, name) values ('cust-zero', ?, 'Walk In')`, [
      seed.orgId,
    ])
    const row = customersByBalance(db).find((c) => c.id === 'cust-zero')
    assert.deepEqual(
      { balanceMinor: row.balanceMinor, depositHeldMinor: row.depositHeldMinor },
      { balanceMinor: 0, depositHeldMinor: 0 },
    )
    const v = customerView(db, 'cust-zero')
    assert.deepEqual(v.entries, [])
    assert.equal(moneyStrip(db, NOW).owingCount, customersByBalance(db).filter((c) => c.balanceMinor > 0).length)
  })

  test('due-in-today counts a debtor only when an OPEN job is due on exactly the strip’s day', () => {
    // Deterministic dates: pin all three seeded open jobs explicitly.
    setExpectedBack(db, 'job-doc', isoDate(NOW)) // Ayesha's — due today
    setExpectedBack(db, 'job-shan', '2030-06-20') // Bilal's — later
    setExpectedBack(db, 'job-wedding', 'after eid') // Hamza's — free text

    const strip = moneyStrip(db, NOW)
    const ayesha = customersByBalance(db).find((c) => c.id === 'cust-ayesha')
    assert.equal(strip.dueTodayMinor, ayesha.balanceMinor, 'exactly the due-today debtor')

    // The free-text job is honestly dateless everywhere downstream too.
    const board = dueBoard(db, NOW)
    const wedding = board.outJobs.find((j) => j.id === 'job-wedding')
    // (job-wedding has no gear out in the seed, so it is not on the board
    //  at all — the free-text case on the BOARD is covered below.)
    assert.equal(wedding, undefined)

    // A closed job due today must never count: close job-doc and recheck.
    db.exec(`update jobs set status = 'closed' where id = 'job-doc'`)
    assert.equal(moneyStrip(db, NOW).dueTodayMinor, 0)
  })

  test('earned-this-month respects the month edge to the millisecond', () => {
    db.exec(`delete from customer_ledger_entries`)
    const lastTick = new Date(2030, 5, 30, 23, 59, 59, 999).getTime() // 30 Jun
    const nextTick = new Date(2030, 6, 1, 0, 0, 0, 0).getTime() // 1 Jul
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: 10_000_00, createdAt: lastTick,
    })
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: 77_000_00, createdAt: nextTick,
    })
    // Payments never count as 'earned' — billed, not collected.
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'payment',
      amountMinor: -5_000_00, createdAt: lastTick,
    })
    assert.equal(moneyStrip(db, NOW).earnedMonthMinor, 10_000_00)
    assert.equal(moneyStrip(db, new Date(2030, 6, 2).getTime()).earnedMonthMinor, 77_000_00)
  })
})

// ------------------------------------------------- hostile dates, UI edges

describe('dueStatus under hostile expected_back values', () => {
  test('ISO with a timezone offset is accepted, and the day math holds at that instant', () => {
    const value = '2030-06-15T18:00:00+05:00'
    const parsed = parseDueDate(value)
    assert.notEqual(parsed, null, 'a full ISO datetime with offset must parse')

    // At the exact instant it names, it is due TODAY — true in every
    // timezone, because both sides reduce to the same local midnight.
    const instant = Date.parse(value)
    assert.equal(dueStatus(value, instant).state, 'due_today')

    // 48 hours later is exactly two calendar days late, DST or not.
    const late = dueStatus(value, instant + 48 * 3_600_000)
    assert.equal(late.state, 'overdue')
    assert.equal(late.daysLate, 2)
  })

  test('rollover, free text, bare years, and 25 o’clock are all an honest "no date"', () => {
    for (const hostile of [
      '2030-02-31', // rollover — Feb 31 silently becomes March otherwise
      '2030-13-01', // thirteenth month
      '2030-9-5', // not the column's shape
      'after eid',
      'monday ia',
      '2030',
      '',
      null,
      undefined,
      '2030-06-15T25:00', // Date.parse returns NaN
    ]) {
      const s = dueStatus(hostile, NOW)
      assert.equal(s.state, 'unknown', `${String(hostile)} must not invent a date`)
      assert.equal(s.label, 'no date')
    }
    // Whitespace around a real date is forgiven, though.
    assert.equal(dueStatus(' 2030-06-15 ', NOW).state, 'due_today')
  })

  test('dateless jobs sort last and count in neither overdue nor due-back', () => {
    // Put gear out on all three open jobs so all three reach the board.
    db.exec(`update assets set presence = 'out', current_job_id = 'job-shan' where id = 'asset-fx9-1'`)
    db.exec(`update assets set presence = 'out', current_job_id = 'job-wedding' where id = 'asset-fx6-1'`)
    setExpectedBack(db, 'job-doc', '2030-06-10') // 5 days late
    setExpectedBack(db, 'job-shan', isoDate(NOW)) // due today
    setExpectedBack(db, 'job-wedding', 'after eid') // free text

    const board = dueBoard(db, NOW)
    assert.deepEqual(
      board.outJobs.map((j) => j.due.state),
      ['overdue', 'due_today', 'unknown'],
      'overdue pinned first, dateless honestly last',
    )
    assert.equal(board.overdue, 1, 'free text is not late')
    assert.equal(board.dueBack, 1, 'and not due back either')
    assert.equal(board.outJobs[2].due.label, 'no date')
  })

  test('compareDueDates: garbage after dates, stable among itself, fuzzed', () => {
    const r = rng(77)
    const values = [
      '2030-06-01', '2030-06-10', '2030-07-01', null, 'after eid', '', '2030-02-31',
    ]
    for (let round = 0; round < 50; round++) {
      const shuffledVals = [...values].sort(() => r() - 0.5)
      const sorted = [...shuffledVals].sort(compareDueDates)
      const dated = sorted.filter((v) => parseDueDate(v) !== null)
      const dateless = sorted.filter((v) => parseDueDate(v) === null)
      assert.deepEqual(dated, ['2030-06-01', '2030-06-10', '2030-07-01'], 'dates in order first')
      assert.equal(dateless.length, 4, 'everything unparseable after them')
      assert.deepEqual(sorted.slice(0, 3), dated, 'no garbage interleaved among the dates')
    }
  })
})
