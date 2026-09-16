/**
 * What a client has been worth, and how hard a unit works — the last two
 * money doors, against a real SQLite (W13, `no-lifetime-value-view` and
 * `no-utilization-read`).
 *
 * Both are pure READS over rows that already exist, so what is worth
 * pinning is the arithmetic and the HONESTY: a reversed or waived charge
 * is not worth; an average with no jobs behind it is null, not zero;
 * "never seen it go out" is not "idle 90 days"; and days out are
 * calendar dates, the way the rental-day rule and the service meter both
 * count them.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, ScanSession } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import {
  correctEntry,
  lifetimeValue,
  recordEntry,
  waiveLateFee,
  writeOffEntry,
} from '../src/demo/khata.ts'
import { holdDeposit } from '../src/demo/deposits.ts'
import { daysCovered, outPeriods, utilisation, workedHardest } from '../src/demo/utilisation.ts'

let db
let seed
let seq
const NOW = new Date(2027, 5, 10, 12).getTime()
const DAY = 24 * 60 * 60 * 1000
const ids = (nowMs = NOW) => ({ now: () => nowMs, newId: () => `op-${++seq}` })
const rs = (rupees) => rupees * 100

/** Out at `outMs`, back at `inMs` (or still out when null). */
function rental(assetId, outMs, inMs) {
  const out = new ScanSession(db, {
    deviceId: 'phone-1', jobId: 'job-shan', expected: new Set([assetId]),
    now: () => outMs, newId: () => `s-${++seq}`,
  })
  out.addManually(assetId, 'check_out')
  if (inMs === null) return
  const back = new ScanSession(db, {
    deviceId: 'phone-1', jobId: 'job-shan', expected: new Set([assetId]),
    now: () => inMs, newId: () => `s-${++seq}`,
  })
  back.addManually(assetId, 'check_in')
}

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  seq = 0
})

describe('what a client has been worth', () => {
  test('the seeded books add up, and the average is charged ÷ jobs', () => {
    const w = lifetimeValue(db, 'cust-bilal')
    // Rs 60,000 + Rs 45,000 charged across two jobs, Rs 30,000 paid.
    assert.equal(w.chargedMinor, rs(105_000))
    assert.equal(w.paidMinor, rs(30_000))
    assert.equal(w.writtenOffMinor, 0)
    assert.equal(w.waivedMinor, 0)
    assert.equal(w.jobs, 2)
    assert.equal(w.averageJobMinor, rs(52_500))
    assert.ok(w.firstAt !== null && w.lastAt !== null && w.lastAt >= w.firstAt)
  })

  test('a reversed charge was never worth anything', () => {
    const before = lifetimeValue(db, 'cust-bilal')
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(20_000), jobId: 'job-shan', createdAt: NOW,
    }, ids())
    assert.equal(lifetimeValue(db, 'cust-bilal').chargedMinor, before.chargedMinor + rs(20_000))
    correctEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Never went out', whenMs: NOW + 1,
    }, ids(NOW + 1))
    assert.equal(lifetimeValue(db, 'cust-bilal').chargedMinor, before.chargedMinor)
  })

  test('a write-off shows in its own column, and a waived fee in neither', () => {
    const charge = recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-ayesha', kind: 'charge',
      amountMinor: rs(12_000), createdAt: NOW,
    }, ids())
    writeOffEntry(db, {
      orgId: seed.orgId, entryId: charge, reason: 'Absconded', whenMs: NOW + 1,
    }, ids(NOW + 1))
    const w = lifetimeValue(db, 'cust-ayesha')
    assert.equal(w.writtenOffMinor, rs(12_000))
    assert.equal(w.waivedMinor, 0, 'nothing waived yet')
    assert.equal(w.chargedMinor, rs(55_000), 'the written-off charge is not billing')

    waiveLateFee(db, {
      orgId: seed.orgId, jobId: 'job-doc', amountMinor: rs(4_000),
      reason: 'Goodwill', whenMs: NOW + 2,
    }, ids(NOW + 2))
    const after = lifetimeValue(db, 'cust-ayesha')
    assert.equal(after.chargedMinor, rs(55_000), 'a favour is not a bill')
    // The two give-ups are DIFFERENT facts and sit in different columns.
    // Absconded money was chased and lost; a waived fee is a courtesy the
    // house never had. Folded together they printed "billed Rs 55,000,
    // written off Rs 16,000" — forgiving more than was billed, unreadable.
    assert.equal(after.writtenOffMinor, rs(12_000), 'money chased and lost')
    assert.equal(after.waivedMinor, rs(4_000), 'a fee never insisted on')
  })

  test('held security money is the pot, never worth', () => {
    holdDeposit(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', amountMinor: rs(50_000), heldAt: NOW,
    }, ids())
    const w = lifetimeValue(db, 'cust-hamza')
    assert.equal(w.depositHeldMinor, rs(50_000))
    assert.equal(w.chargedMinor, rs(80_000), 'the deposit did not bill them anything')
  })

  test('an empty book is empty, not a row of zeros', () => {
    const w = lifetimeValue(db, 'cust-nobody')
    assert.equal(w.firstAt, null)
    assert.equal(w.lastAt, null)
    assert.equal(w.jobs, 0)
    assert.equal(w.averageJobMinor, null, 'no average against a zero denominator')
  })

  test('a charge with no job counts as money but not as a job', () => {
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-hamza', kind: 'charge',
      amountMinor: rs(9_000), jobId: null, createdAt: NOW,
    }, ids())
    const w = lifetimeValue(db, 'cust-hamza')
    assert.equal(w.chargedMinor, rs(89_000))
    assert.equal(w.jobs, 1, 'the seeded mehndi job; the loose charge adds none')
  })
})

describe('days out are calendar dates', () => {
  test('a Tuesday-evening to Wednesday-morning rental worked two days', () => {
    const outMs = new Date(2027, 5, 1, 19).getTime()
    const inMs = new Date(2027, 5, 2, 9).getTime()
    assert.equal(daysCovered([{ startMs: outMs, endMs: inMs }], outMs - DAY, NOW), 2)
  })

  test('overlapping periods count a date once', () => {
    const a = new Date(2027, 5, 1, 9).getTime()
    const b = new Date(2027, 5, 3, 9).getTime()
    assert.equal(
      daysCovered([{ startMs: a, endMs: b }, { startMs: a + DAY, endMs: b }], a - DAY, NOW),
      3,
    )
  })

  test('a period still open runs to now, and the window clips both ends', () => {
    const start = NOW - 200 * DAY
    // Open-ended: 201 dates, but the 90-day window sees only its own.
    assert.equal(daysCovered([{ startMs: start, endMs: null }], NOW - 90 * DAY, NOW), 91)
  })
})

describe('how hard a unit works', () => {
  test('the log becomes out→in periods; a second checkout closes the first', () => {
    rental('asset-fx9-1', NOW - 20 * DAY, NOW - 18 * DAY)
    rental('asset-fx9-1', NOW - 5 * DAY, null)
    const periods = outPeriods(db).filter((p) => p.assetId === 'asset-fx9-1')
    assert.equal(periods.length, 2)
    assert.equal(periods[0].endMs, NOW - 18 * DAY)
    assert.equal(periods[1].endMs, null, 'still out')
  })

  test('a loose check_in this phone never saw leave is not a rental', () => {
    const back = new ScanSession(db, {
      deviceId: 'phone-1', jobId: 'job-shan', expected: new Set(['asset-fx9-2']),
      now: () => NOW, newId: () => `s-${++seq}`,
    })
    back.addManually('asset-fx9-2', 'check_in')
    assert.deepEqual(outPeriods(db).filter((p) => p.assetId === 'asset-fx9-2'), [])
  })

  test('days out, busy percent, idle days and earnings per day', () => {
    rental('asset-fx9-1', NOW - 30 * DAY, NOW - 28 * DAY)
    rental('asset-fx9-1', NOW - 10 * DAY, NOW - 8 * DAY)
    const u = utilisation(db, 'asset-fx9-1', NOW)
    assert.equal(u.windowDays, 90)
    assert.equal(u.daysOut, 6, 'two three-date rentals')
    assert.equal(u.busyPct, Math.round((6 / 90) * 100))
    assert.equal(u.idleDays, 10, 'since it last LEFT, not since it came back')
    assert.equal(u.outNow, false)
    // The seeded book has Rs 105,000 of live charges naming FX9-01.
    assert.equal(u.earnedMinor, rs(105_000))
    assert.equal(u.knownDays, 30)
    assert.equal(u.earnedPerDayMinor, Math.round(rs(105_000) / 30))
  })

  test('out right now reads zero idle days, not an unknown', () => {
    rental('asset-fx9-1', NOW - 2 * DAY, null)
    const u = utilisation(db, 'asset-fx9-1', NOW)
    assert.equal(u.outNow, true)
    assert.equal(u.idleDays, 0)
  })

  test('never seen moving is NULL, not 90 days idle', () => {
    const u = utilisation(db, 'asset-cstand-5', NOW)
    assert.equal(u.daysOut, 0)
    assert.equal(u.idleDays, null, '"never seen it go out" is a different fact')
  })

  test('the service meter rides along from 0021, not from here', () => {
    db.exec(`update assets set rental_days_since_service = 137 where id = 'asset-fx9-1'`)
    const u = utilisation(db, 'asset-fx9-1', NOW)
    assert.equal(u.rentalDaysSinceService, 137)
    assert.equal(u.serviceDueAfter, 100, "the FX9 product's own threshold")
  })
})

describe('the fleet ranking — the AUG question', () => {
  test('hardest worker first, money breaking a tie, and the idle left out', () => {
    rental('asset-fx9-1', NOW - 20 * DAY, NOW - 10 * DAY)   // 11 dates
    rental('asset-fx9-2', NOW - 5 * DAY, NOW - 4 * DAY)     // 2 dates
    rental('asset-c300-1', NOW - 5 * DAY, NOW - 4 * DAY)    // 2 dates, Rs 55,000
    const rows = workedHardest(db, NOW, 5)
    assert.equal(rows[0].id, 'asset-fx9-1')
    assert.equal(rows[0].daysOut, 11)
    assert.equal(rows[0].earnedMinor, rs(105_000))
    // Two units at 2 days: the one that earned more outranks it.
    const tied = rows.filter((r) => r.daysOut === 2).map((r) => r.id)
    assert.deepEqual(tied, ['asset-c300-1', 'asset-fx9-2'])
    assert.equal(rows.some((r) => r.id === 'asset-cstand-5'), false, 'never rented, never ranked')
  })

  test('the limit is honoured and a terminal unit is gone, not idle', () => {
    rental('asset-fx9-1', NOW - 20 * DAY, NOW - 10 * DAY)
    rental('asset-fx9-2', NOW - 20 * DAY, NOW - 15 * DAY)
    assert.equal(workedHardest(db, NOW, 1).length, 1)
    db.exec(`update assets set disposition = 'sold' where id = 'asset-fx9-1'`)
    assert.equal(
      workedHardest(db, NOW, 5).some((r) => r.id === 'asset-fx9-1'), false,
      'terminal gear is gone from the fleet, not ranked in it',
    )
  })

  test('per day out is null when nothing was out, never a divide by zero', () => {
    recordEntry(db, {
      orgId: seed.orgId, customerId: 'cust-bilal', kind: 'charge',
      amountMinor: rs(7_000), assetId: 'asset-cstand-5', createdAt: NOW,
    }, ids())
    const row = workedHardest(db, NOW, 5).find((r) => r.id === 'asset-cstand-5')
    assert.equal(row.daysOut, 0)
    assert.equal(row.earnedPerDayMinor, null)
  })
})
