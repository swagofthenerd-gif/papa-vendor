/**
 * The money book against a real SQLite — the khata read model.
 *
 * What is worth pinning down: the seeded customers' projected balances (the
 * four demo states the screens demonstrate), that recording is INSERT-only
 * and the projection follows, the Today money strip's three figures, the
 * turned-away demand log's recording rules, per-asset earnings and the
 * payback bar's honesty, and the two money documents rendered from BOTH
 * string tables — the golden texts a client actually receives.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, balanceCardText, monthlyStatementText, oldestUnpaidMs } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import {
  assetEarnings,
  customerForJob,
  customersByBalance,
  customerView,
  khataLabels,
  moneyStrip,
  paymentLine,
  recordEntry,
  recordTurnedAway,
  setPaymentLine,
  turnedAwayThisMonth,
} from '../src/demo/khata.ts'
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

describe('the seeded book', () => {
  test('Bilal owes Rs 75,000 across two jobs', () => {
    const c = customerView(db, 'cust-bilal')
    assert.equal(c.balanceMinor, rs(75_000))
    assert.equal(c.depositHeldMinor, 0)
    const jobIds = new Set(c.entries.map((e) => e.jobId))
    assert.ok(jobIds.has('job-shan'))
    assert.ok(jobIds.has('job-shan-stills'))
    // Two linked jobs on the page, one of them closed.
    assert.equal(c.jobs.length, 2)
    assert.ok(c.jobs.some((j) => j.status === 'closed'))
  })

  test('Hamza is clean: charged, paid, zero', () => {
    const c = customerView(db, 'cust-hamza')
    assert.equal(c.balanceMinor, 0)
    assert.equal(c.depositHeldMinor, 0)
  })

  test('Imran owes nothing but Rs 50,000 sits held as security', () => {
    const c = customerView(db, 'cust-imran')
    assert.equal(c.balanceMinor, 0)
    assert.equal(c.depositHeldMinor, rs(50_000))
  })

  test('Ayesha owes Rs 55,000 on the overdue job', () => {
    const c = customerView(db, 'cust-ayesha')
    assert.equal(c.balanceMinor, rs(55_000))
    assert.equal(customerForJob(db, 'job-doc')?.id, 'cust-ayesha')
  })

  test('entries on the page read newest first', () => {
    const c = customerView(db, 'cust-bilal')
    for (let i = 1; i < c.entries.length; i++) {
      assert.ok(c.entries[i - 1].createdAt >= c.entries[i].createdAt)
    }
  })

  test('the owed list ranks by balance and knows who is clean', () => {
    const rows = customersByBalance(db)
    assert.equal(rows[0].id, 'cust-bilal')
    assert.equal(rows[1].id, 'cust-ayesha')
    const owing = rows.filter((r) => r.balanceMinor > 0)
    assert.equal(owing.length, 2)
  })

  test('an unknown customer is null, not a blank page', () => {
    assert.equal(customerView(db, 'cust-nobody'), null)
  })
})

describe('recordEntry', () => {
  test('a payment is an INSERT and the projection follows', () => {
    const before = customerView(db, 'cust-bilal').entries.length
    recordEntry(db, {
      orgId: seed.orgId,
      customerId: 'cust-bilal',
      kind: 'payment',
      amountMinor: -rs(25_000),
      note: 'JazzCash',
      createdAt: Date.now(),
    })
    const c = customerView(db, 'cust-bilal')
    assert.equal(c.entries.length, before + 1)
    assert.equal(c.balanceMinor, rs(50_000))
    // Newest first: the payment just written is the top row.
    assert.equal(c.entries[0].kind, 'payment')
  })

  test('a damage charge lands on the job it was agreed at', () => {
    recordEntry(db, {
      orgId: seed.orgId,
      customerId: 'cust-ayesha',
      kind: 'damage_charge',
      amountMinor: rs(8_000),
      jobId: 'job-doc',
      note: 'Cracked matte box',
      createdAt: Date.now(),
    })
    const c = customerView(db, 'cust-ayesha')
    assert.equal(c.balanceMinor, rs(63_000))
    assert.equal(c.entries[0].jobLabel, 'Documentary — Walled City')
  })

  test('a same-millisecond charge and payment cannot flip the owed-since clock', () => {
    // A bulk import writes lines faster than the clock ticks. The book
    // carries rowid as the tie-break (LedgerEntryView.seq), so re-sorting
    // the screen's newest-first rows reproduces insertion order exactly —
    // without it, the tied payment sorted ahead of the tied charge, the
    // running balance dipped to zero mid-walk, and "owed since" jumped
    // from the original charge to the tie's day.
    db.exec(`insert into customers (id, org_id, name) values ('cust-tie', ?, 'Tie Case')`, [
      seed.orgId,
    ])
    const t1 = new Date(2030, 2, 1, 12).getTime()
    const t2 = new Date(2030, 2, 6, 12).getTime()
    const line = (kind, amountMinor, createdAt) =>
      recordEntry(db, { orgId: seed.orgId, customerId: 'cust-tie', kind, amountMinor, createdAt })
    line('charge', rs(100_000), t1)
    line('charge', rs(40_000), t2)
    line('payment', -rs(100_000), t2) // same millisecond, written after
    const v = customerView(db, 'cust-tie')
    assert.equal(v.balanceMinor, rs(40_000))
    // The debt has run unbroken since t1: the tied payment never cleared it.
    assert.equal(oldestUnpaidMs(v.entries), t1)
  })
})

describe('moneyStrip', () => {
  test('owed = the debts only; credits are not income', () => {
    const strip = moneyStrip(db, Date.now())
    assert.equal(strip.owedMinor, rs(75_000 + 55_000))
    assert.equal(strip.owingCount, 2)
  })

  test('earned this month sums the charge-side kinds only', () => {
    // Seeded inside this month's window: Bilal's Rs 45,000 (1 day ago),
    // Ayesha's Rs 55,000 (9 days ago), Imran's Rs 40,000 (6 days ago) —
    // when those days-ago fall in the current calendar month. Rather than
    // re-deriving the calendar here, assert the invariant that matters:
    // payments and deposits never count as earnings.
    const strip = moneyStrip(db, Date.now())
    const total = db.get(
      `select sum(amount_minor) as t from customer_ledger_entries
        where kind in ('charge', 'late_fee', 'damage_charge')`,
    )
    assert.ok(strip.earnedMonthMinor >= 0)
    assert.ok(strip.earnedMonthMinor <= Number(total.t))
    // A late fee written now lands in this month's earnings.
    recordEntry(db, {
      orgId: seed.orgId,
      customerId: 'cust-ayesha',
      kind: 'late_fee',
      amountMinor: rs(10_000),
      createdAt: Date.now(),
    })
    const after = moneyStrip(db, Date.now())
    assert.equal(after.earnedMonthMinor, strip.earnedMonthMinor + rs(10_000))
    // A payment written now does NOT.
    recordEntry(db, {
      orgId: seed.orgId,
      customerId: 'cust-ayesha',
      kind: 'payment',
      amountMinor: -rs(5_000),
      createdAt: Date.now(),
    })
    assert.equal(moneyStrip(db, Date.now()).earnedMonthMinor, after.earnedMonthMinor)
  })

  test('due in today follows the board date, not a separate clock', () => {
    // The seed already has job-shan (Bilal's) due back today — his whole
    // balance is the money a finished return would put on the counter.
    assert.equal(moneyStrip(db, Date.now()).dueTodayMinor, rs(75_000))
    // Make job-doc (Ayesha's, still open with gear out) due back today too.
    const d = new Date()
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    db.exec(`update jobs set expected_back = ? where id = 'job-doc'`, [iso])
    assert.equal(moneyStrip(db, Date.now()).dueTodayMinor, rs(75_000 + 55_000))
  })
})

describe('the turned-away demand log', () => {
  const lines = [
    { productId: 'prod-fx9', wanted: 3, onHand: 1, state: 'short' },
    { productId: 'prod-cne', wanted: 1, onHand: 0, state: 'none' },
    { productId: 'prod-fx6', wanted: 2, onHand: 2, state: 'available' },
    { productId: null, wanted: 2, onHand: 0, state: 'none' },
  ]

  test('only real shortages with a known product are recorded', () => {
    const n = recordTurnedAway(db, lines, Date.now())
    assert.equal(n, 2)
    const fx9 = turnedAwayThisMonth(db, 'prod-fx9', Date.now())
    assert.equal(fx9.times, 1)
    assert.equal(fx9.units, 2) // wanted 3, could offer 1
    const fx6 = turnedAwayThisMonth(db, 'prod-fx6', Date.now())
    assert.equal(fx6.times, 0)
  })

  test('each answered list is its own incident', () => {
    recordTurnedAway(db, lines, Date.now())
    recordTurnedAway(db, lines, Date.now())
    const fx9 = turnedAwayThisMonth(db, 'prod-fx9', Date.now())
    assert.equal(fx9.times, 2)
    assert.equal(fx9.units, 4)
  })

  test('last month is not this month', () => {
    const lastMonth = new Date()
    lastMonth.setDate(0) // last day of the previous month
    recordTurnedAway(db, lines, lastMonth.getTime())
    const fx9 = turnedAwayThisMonth(db, 'prod-fx9', Date.now())
    assert.equal(fx9.times, 0)
  })
})

describe('assetEarnings', () => {
  test('FX9-01 earned across two jobs, with a payback bar', () => {
    const e = assetEarnings(db, 'asset-fx9-1')
    assert.equal(e.earnedMinor, rs(60_000 + 45_000))
    assert.equal(e.jobs, 2)
    assert.equal(e.replacementMinor, rs(3_500_000))
    assert.equal(e.paybackPct, 3)
  })

  test('an asset nothing was charged against has earned nothing', () => {
    const e = assetEarnings(db, 'asset-fx9-2')
    assert.equal(e.earnedMinor, 0)
    assert.equal(e.jobs, 0)
    // The bar still shows honestly at 0% — the denominator is known.
    assert.equal(e.paybackPct, 0)
  })

  test('no replacement value on record, no payback bar', () => {
    // The Sachdeva tripods are seeded rateless and valueless on purpose.
    const e = assetEarnings(db, 'asset-sachdeva-1')
    assert.equal(e.replacementMinor, null)
    assert.equal(e.paybackPct, null)
  })

  test('damage recovery is not earnings: the bar celebrates rental money only', () => {
    const before = assetEarnings(db, 'asset-fx9-1').earnedMinor
    recordEntry(db, {
      orgId: seed.orgId,
      customerId: 'cust-bilal',
      kind: 'damage_charge',
      amountMinor: rs(150_000),
      assetId: 'asset-fx9-1',
      note: 'Top handle repair',
      createdAt: Date.now(),
    })
    // On the khata, yes; on the payback bar, never — a camera that gets
    // broken often must not look like the fleet's best performer.
    assert.equal(assetEarnings(db, 'asset-fx9-1').earnedMinor, before)
  })

  test('a reversed charge stops counting the moment the reversal names it', () => {
    const before = assetEarnings(db, 'asset-fx9-1').earnedMinor
    const chargeId = recordEntry(db, {
      orgId: seed.orgId,
      customerId: 'cust-bilal',
      kind: 'charge',
      amountMinor: rs(20_000),
      assetId: 'asset-fx9-1',
      createdAt: Date.now(),
    })
    assert.equal(assetEarnings(db, 'asset-fx9-1').earnedMinor, before + rs(20_000))
    recordEntry(db, {
      orgId: seed.orgId,
      customerId: 'cust-bilal',
      kind: 'reversal',
      amountMinor: -rs(20_000),
      assetId: 'asset-fx9-1',
      reversalOf: chargeId,
      createdAt: Date.now(),
    })
    assert.equal(assetEarnings(db, 'asset-fx9-1').earnedMinor, before)
  })

  test('payments against the same asset id do not subtract from earnings', () => {
    const before = assetEarnings(db, 'asset-fx9-1').earnedMinor
    recordEntry(db, {
      orgId: seed.orgId,
      customerId: 'cust-bilal',
      kind: 'payment',
      amountMinor: -rs(30_000),
      assetId: 'asset-fx9-1',
      createdAt: Date.now(),
    })
    assert.equal(assetEarnings(db, 'asset-fx9-1').earnedMinor, before)
  })
})

describe('the payment line setting', () => {
  test('unset by default; set, read back, cleared', () => {
    assert.equal(paymentLine(db), null)
    setPaymentLine(db, 'JazzCash: 0300 1234567')
    assert.equal(paymentLine(db), 'JazzCash: 0300 1234567')
    setPaymentLine(db, 'Easypaisa: 0345 7654321')
    assert.equal(paymentLine(db), 'Easypaisa: 0345 7654321')
    setPaymentLine(db, '   ')
    assert.equal(paymentLine(db), null)
  })
})

/**
 * The golden documents, in BOTH languages, from the REAL string tables via
 * khataLabels — the same path the app takes. Fixed timestamps so the texts
 * are exact; the builders never read a clock.
 */
describe('the money documents, golden', () => {
  const at = (y, m, d) => new Date(y, m - 1, d).getTime()
  const entries = [
    {
      kind: 'charge', amountMinor: rs(60_000), createdAt: at(2026, 8, 9),
      jobLabel: 'Shan Foods stills',
    },
    { kind: 'payment', amountMinor: -rs(30_000), createdAt: at(2026, 8, 12) },
    {
      kind: 'charge', amountMinor: rs(45_000), createdAt: at(2026, 9, 10),
      jobLabel: 'Shan Foods TVC',
    },
  ]
  const input = {
    customerName: 'Bilal Hussain',
    houseName: 'Lightcraft Rentals',
    entries,
    paymentLine: 'JazzCash: 0300 1234567',
  }

  test('the balance card, English', () => {
    assert.equal(
      balanceCardText(input, khataLabels(STR_EN)),
      [
        'Hisaab — Bilal Hussain',
        'Lightcraft Rentals',
        '',
        'Balance: Rs 75,000',
        '',
        '9 Aug  charge  +Rs 60,000',
        '12 Aug  payment  -Rs 30,000',
        '10 Sep  charge  +Rs 45,000',
        '',
        'Owed since 9 Aug',
        'JazzCash: 0300 1234567',
      ].join('\n'),
    )
  })

  test('the balance card, Roman Urdu', () => {
    assert.equal(
      balanceCardText(input, khataLabels(STR_UR)),
      [
        'Hisaab — Bilal Hussain',
        'Lightcraft Rentals',
        '',
        'Balance: Rs 75,000',
        '',
        '9 Aug  kiraya  +Rs 60,000',
        '12 Aug  wusooli  -Rs 30,000',
        '10 Sep  kiraya  +Rs 45,000',
        '',
        '9 Aug se baqaya',
        'JazzCash: 0300 1234567',
      ].join('\n'),
    )
  })

  test('the monthly statement, English', () => {
    assert.equal(
      monthlyStatementText({ ...input, nowMs: at(2026, 9, 11) }, khataLabels(STR_EN)),
      [
        'Statement — Bilal Hussain · Sep 2026',
        'Lightcraft Rentals',
        '',
        '10 Sep  charge — Shan Foods TVC  +Rs 45,000',
        '',
        'Closing balance: Rs 75,000',
        'JazzCash: 0300 1234567',
      ].join('\n'),
    )
  })

  test('the monthly statement, Roman Urdu', () => {
    assert.equal(
      monthlyStatementText({ ...input, nowMs: at(2026, 9, 11) }, khataLabels(STR_UR)),
      [
        'Statement — Bilal Hussain · Sep 2026',
        'Lightcraft Rentals',
        '',
        '10 Sep  kiraya — Shan Foods TVC  +Rs 45,000',
        '',
        'Aakhri balance: Rs 75,000',
        'JazzCash: 0300 1234567',
      ].join('\n'),
    )
  })

  test('a clean khata in Urdu still says so', () => {
    const clean = balanceCardText(
      {
        customerName: 'Hamza Saeed',
        houseName: 'Lightcraft Rentals',
        entries: [
          { kind: 'charge', amountMinor: rs(80_000), createdAt: at(2026, 8, 22) },
          { kind: 'payment', amountMinor: -rs(80_000), createdAt: at(2026, 8, 24) },
        ],
        paymentLine: null,
      },
      khataLabels(STR_UR),
    )
    assert.ok(clean.includes('Kuch baqaya nahi'))
  })

  test('a negative balance says the house owes — plainly, in both languages', () => {
    // POLICY (owner may overrule): the vendor owing the client is a fact
    // the card states, never a 'Nothing owed' shrug.
    const overpaid = {
      customerName: 'Bilal Hussain',
      houseName: 'Lightcraft Rentals',
      entries: [
        { kind: 'charge', amountMinor: rs(20_000), createdAt: at(2026, 8, 9) },
        { kind: 'payment', amountMinor: -rs(35_000), createdAt: at(2026, 8, 12) },
      ],
      paymentLine: null,
    }
    const en = balanceCardText(overpaid, khataLabels(STR_EN))
    assert.ok(en.includes('You owe them Rs 15,000'))
    assert.ok(!en.includes('Nothing owed'))
    const ur = balanceCardText(overpaid, khataLabels(STR_UR))
    assert.ok(ur.includes('Aap ke zimme Rs 15,000'))
    assert.ok(!ur.includes('Kuch baqaya nahi'))
  })

  test('every ledger kind has a word in both tables', () => {
    const kinds = [
      'charge', 'payment', 'deposit_hold', 'deposit_apply',
      'deposit_refund', 'late_fee', 'damage_charge', 'adjustment',
    ]
    for (const table of [STR_EN, STR_UR]) {
      const labels = khataLabels(table)
      for (const kind of kinds) {
        const word = labels.kindLabel(kind)
        assert.equal(typeof word, 'string')
        assert.ok(word.length > 0)
        // A raw snake_case kind leaking through means the lookup missed.
        assert.ok(!word.includes('_'), `${kind} fell through in a table`)
      }
    }
  })
})
