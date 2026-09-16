/**
 * The month behind the day, against a real SQLite (W13,
 * `no-month-history-screen`).
 *
 * The year's complaint was precise: `moneyStrip(nowMs)` answers ANY
 * month — verified for October and December from March — but every
 * caller hardcoded `Date.now()`, so the owner could not see last month
 * from this one. What is pinned here: the month window is the device's
 * calendar month, the figures are the same reads the day's account uses
 * (no new maths), a past month's account is complete on its own, and the
 * deep link round-trips.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, ScanSession, monthBounds } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { monthAccount, monthKey, monthStep, msOfMonth } from '../src/demo/hisaab.ts'
import { recordEntry, waiveLateFee } from '../src/demo/khata.ts'
import { recordExpense } from '../src/demo/kharcha.ts'
import { parseHash, viewToHash } from '../src/nav.ts'

let db
let seed
let seq
/**
 * Noon on the 10th, so no assertion here can straddle a month edge — and
 * far enough from the seed's own history that the windows below hold only
 * what this file puts in them.
 *
 * That distance used to be luck: the seed dated its history days back from
 * the REAL clock, so it stayed clear of 2027 only until the real clock got
 * there. SEEDED pins it instead. The seed's money reaches 34 days back, so
 * from mid-April it spans mid-March to mid-April — clear of February (the
 * quiet month below), of May and of June, deliberately and for good.
 */
const TODAY = new Date(2027, 5, 10, 12).getTime()
const LAST = new Date(2027, 4, 10, 12).getTime()
const SEEDED = new Date(2027, 3, 15, 12).getTime()
const ids = (nowMs) => ({ now: () => nowMs, newId: () => `op-${++seq}` })
const rs = (rupees) => rupees * 100

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db, SEEDED)
  seq = 0
})

describe('the month keys', () => {
  test('monthKey, msOfMonth and monthStep round-trip on the local calendar', () => {
    assert.equal(monthKey(TODAY), '2027-06')
    assert.equal(monthKey(msOfMonth('2027-06')), '2027-06')
    assert.equal(monthKey(monthStep(TODAY, -1)), '2027-05')
    assert.equal(monthKey(monthStep(TODAY, 1)), '2027-07')
    // Across a year edge, where a naive 30-day subtraction goes wrong.
    assert.equal(monthKey(monthStep(new Date(2027, 0, 31, 12).getTime(), -1)), '2026-12')
    assert.equal(monthKey(monthStep(new Date(2026, 11, 31, 12).getTime(), 1)), '2027-01')
  })

  test('a month that is not a month is no month', () => {
    for (const bad of ['2026-13', '2026-00', '2026-9', 'september', '', '2026-09-01']) {
      assert.equal(msOfMonth(bad), null, bad)
    }
  })

  test('the deep link round-trips, and this month carries no query', () => {
    assert.deepEqual(parseHash('#/hisaab?m=2026-05'), { name: 'hisaab', month: '2026-05' })
    assert.equal(viewToHash({ name: 'hisaab', month: '2026-05' }), '#/hisaab?m=2026-05')
    assert.deepEqual(parseHash('#/hisaab'), { name: 'hisaab' })
    assert.equal(viewToHash({ name: 'hisaab' }), '#/hisaab')
    // A malformed month opens this month rather than breaking the route.
    assert.deepEqual(parseHash('#/hisaab?m=2026-13'), { name: 'hisaab' })
  })
})

describe('a past month answers for itself', () => {
  beforeEach(() => {
    // Last month: one charge, one payment, one bill. This month: another
    // charge, so the two windows must not bleed.
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(90_000), jobId: 'job-shan', note: 'Last month TVC', createdAt: LAST,
    }, ids(LAST))
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'payment',
      amountMinor: -rs(40_000), note: 'Cash', createdAt: LAST + 3_600_000,
    }, ids(LAST))
    recordExpense(db, {
      orgId: seed.orgId, kind: 'transport', amountMinor: rs(6_000),
      counterparty: 'Rickshaw', createdAt: LAST + 7_200_000,
    }, ids(LAST))
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', kind: 'charge',
      amountMinor: rs(11_000), createdAt: TODAY,
    }, ids(TODAY))
  })

  test('the window is the device\'s calendar month, and the label is its own', () => {
    const a = monthAccount(db, LAST, TODAY)
    assert.equal(a.month, '2027-05')
    assert.equal(a.monthLabel, monthBounds(LAST).label)
    assert.equal(a.startMs, monthBounds(LAST).startMs)
    assert.equal(a.endMs, monthBounds(LAST).endMs)
    assert.equal(a.isThisMonth, false)
    assert.equal(monthAccount(db, TODAY, TODAY).isThisMonth, true)
  })

  test('the profit is last month\'s, not this month\'s', () => {
    const a = monthAccount(db, LAST, TODAY)
    assert.equal(a.profit.earnedMinor, rs(90_000))
    assert.equal(a.profit.spentMinor, rs(6_000))
    assert.equal(a.profit.profitMinor, rs(84_000))
    assert.equal(a.kharcha.rows.length, 1)
    assert.equal(a.kharcha.totalMinor, rs(6_000))

    const now = monthAccount(db, TODAY, TODAY)
    assert.equal(now.profit.earnedMinor, rs(11_000), 'this month sees only its own charge')
  })

  test('the statement links name everyone whose khata moved, biggest biller first', () => {
    const a = monthAccount(db, LAST, TODAY)
    assert.deepEqual(a.customers.map((c) => c.id), ['cust-bilal'])
    assert.equal(a.customers[0].billedMinor, rs(90_000))
    assert.equal(a.customers[0].paidMinor, rs(40_000))
    // The balance is NOW's — the reason to call them, not the month's close.
    assert.equal(a.customers[0].balanceMinor, rs(75_000 + 90_000 - 40_000))

    const now = monthAccount(db, TODAY, TODAY)
    assert.deepEqual(now.customers.map((c) => c.id), ['cust-hamza'])
  })

  test('a waived fee is not billing — the month\'s figures use the one settled rule', () => {
    assert.equal(waiveLateFee(db, {
      orgId: seed.orgId, jobId: 'job-doc', amountMinor: rs(30_000),
      reason: 'Goodwill', whenMs: LAST + 10_000,
    }, ids(LAST)).ok, true)
    const a = monthAccount(db, LAST, TODAY)
    assert.equal(a.profit.earnedMinor, rs(90_000), 'the fee was drafted and forgiven')
    const ayesha = a.customers.find((c) => c.id === 'cust-ayesha')
    assert.equal(ayesha.billedMinor, 0, 'a favour is not a bill')
  })

  test('a month nothing happened in says so, rather than showing zeros as facts', () => {
    const quiet = monthAccount(db, new Date(2027, 1, 10, 12).getTime(), TODAY)
    assert.equal(quiet.wentOut, 0)
    assert.equal(quiet.cameBack, 0)
    assert.deepEqual(quiet.customers, [])
    assert.equal(quiet.kharcha.rows.length, 0)
    assert.equal(quiet.profit.expenseCount, 0)
  })
})

describe('what moved in the month', () => {
  test('units are counted once per direction, however often they were scanned', () => {
    const out = new ScanSession(db, {
      deviceId: 'phone-1', jobId: 'job-shan', expected: new Set(['asset-fx9-1']),
      now: () => LAST, newId: () => `s-${++seq}`,
    })
    out.addManually('asset-fx9-1', 'check_out')
    // A rescan in a second session is the same physical departure.
    const again = new ScanSession(db, {
      deviceId: 'phone-1', jobId: 'job-shan', expected: new Set(['asset-fx9-1']),
      now: () => LAST + 60_000, newId: () => `s-${++seq}`,
    })
    again.addManually('asset-fx9-1', 'check_out')
    const back = new ScanSession(db, {
      deviceId: 'phone-1', jobId: 'job-shan', expected: new Set(['asset-fx9-1']),
      now: () => LAST + 86_400_000, newId: () => `s-${++seq}`,
    })
    back.addManually('asset-fx9-1', 'check_in')

    const a = monthAccount(db, LAST, TODAY)
    assert.equal(a.wentOut, 1)
    assert.equal(a.cameBack, 1)
    // And none of it lands in this month.
    const now = monthAccount(db, TODAY, TODAY)
    assert.equal(now.wentOut, 0)
    assert.equal(now.cameBack, 0)
  })
})
