/**
 * A year in the life — twelve months of a Lahore rental house, scripted
 * against the REAL seams: the on-device schema, the demo seed, ScanSession,
 * the outbox, the ledger, the read models. Nothing here is mocked except the
 * server, exactly as in the demo.
 *
 * WHAT THIS FILE IS. A permanent regression test shaped as a story. Each
 * month block performs the vendor's real actions through the same functions
 * the screens call, and asserts the invariants the app promises: balances
 * are projections that never drift, scans are never lost, the boards agree
 * with the tables. Where the year hits a wall — a scenario the app cannot
 * express — the wall is PINNED as an assertion of the current behaviour and
 * logged as a finding id. The narrative, repro steps and ranking live in
 * docs/year-in-the-life.md; this file must stay green.
 *
 * THE CLOCK. Simulated months are anchored to real calendar months: month k
 * is noon on the (15+d)th of the (k+1)th calendar month after whenever the
 * test runs, so month-window arithmetic (monthBounds, statements, the money
 * strip) is exact and the file is deterministic relative to its run date.
 * The story labels (SEP..AUG) are narrative names for k = 0..11.
 *
 * KNOWN CLOCK WELDS (finding `clock-welds`): Outbox.enqueue stamps
 * created_at with Date.now() and SessionRegistry stamps session starts the
 * same way, so scan rows always land on the REAL today — which is why this
 * file drives ScanSession directly with an injected `now`, and why the
 * din-ka-hisaab day grouping cannot be exercised for a simulated past day.
 * The store's money writes (recordPayment / chargeClient / recordLateFee)
 * take no timestamp at all, so this file posts through recordEntry.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import {
  LOCAL_SCHEMA,
  ScanSession,
  PhotoStore,
  lookupTag,
  dueStatus,
  lateFeeDraft,
  checkAvailability,
  parseKitList,
  matchKitList,
  availabilityNote,
  replySummary,
  balanceCardText,
  monthlyStatementText,
  oldestUnpaidMs,
  pairBySide,
  buildPullList,
  parseCsv,
  readRows,
  planImport,
  parsePhoneNumber,
  whatsAppNudgeUrl,
  overdueNudgeMessage,
  formatRupees,
  moneyLabel,
} from '@papa/core'
import { seedDemo, demoCatalogue } from '../src/demo/seed.ts'
import {
  createJob,
  decodeScanOps,
  dueBoard,
  openJob,
  openJobs,
  openJobCommitments,
  packedProgress,
  recordSessionStart,
  sessionScanFacts,
  setExpectedBack,
} from '../src/demo/read-model.ts'
import {
  assetEarnings,
  customerForJob,
  customersByBalance,
  customerView,
  isoDate,
  khataLabels,
  moneyStrip,
  recordEntry,
  recordTurnedAway,
  turnedAwayThisMonth,
} from '../src/demo/khata.ts'
import { buildSummary } from '../src/session-summary.ts'
import { STR_EN } from '../src/strings.ts'

// ---------------------------------------------------------------- the world

const db = new NodeSqliteDriver()
db.exec(LOCAL_SCHEMA)
const seed = seedDemo(db)
const L = khataLabels(STR_EN)

/** tag code for an asset id — how a phone actually names gear. */
const tagOf = new Map(seed.tags.map((t) => [t.assetId, t.tagCode]))

const rs = (rupees) => rupees * 100

// ---------------------------------------------------------------- the clock

const DAY = 24 * 60 * 60 * 1000
const base = new Date()

/** Noon on the (15+d)th of simulated month k (k=0 is next calendar month). */
function at(k, d = 0, hour = 12) {
  return new Date(base.getFullYear(), base.getMonth() + 1 + k, 15 + d, hour).getTime()
}
const iso = (k, d = 0) => isoDate(at(k, d))

// ------------------------------------------------------------- the findings
// Ids only. Repro, ranking and narrative: docs/year-in-the-life.md.

const FINDINGS = new Set()
const finding = (id) => FINDINGS.add(id)

// ---------------------------------------------------- the independent books
// A hand-kept mirror of every rupee and every out item, updated beside each
// action, so the year-long assertions are re-derivations, not tautologies.

const books = new Map([
  ['cust-bilal', { balance: rs(75_000), deposit: 0 }],
  ['cust-hamza', { balance: 0, deposit: 0 }],
  ['cust-ayesha', { balance: rs(55_000), deposit: 0 }],
  ['cust-imran', { balance: 0, deposit: rs(50_000) }],
])
const DEPOSIT_KINDS = new Set(['deposit_hold', 'deposit_apply', 'deposit_refund'])
const CHARGE_KINDS = new Set(['charge', 'late_fee', 'damage_charge'])

/** Charge-side minor units posted per simulated month. */
const monthCharged = new Array(12).fill(0)

/** Every ledger line this year posts goes through here. */
function post(customerId, kind, rupees, opts) {
  const amountMinor = rs(rupees)
  const whenMs = at(opts.k, opts.d ?? 0, opts.hour ?? 12)
  recordEntry(db, {
    orgId: seed.orgId,
    customerId,
    kind,
    amountMinor,
    jobId: opts.jobId ?? null,
    assetId: opts.assetId ?? null,
    note: opts.note ?? null,
    createdAt: whenMs,
  })
  const b = books.get(customerId) ?? { balance: 0, deposit: 0 }
  if (DEPOSIT_KINDS.has(kind)) {
    b.deposit += amountMinor
    if (kind === 'deposit_apply') b.balance += amountMinor
  } else {
    b.balance += amountMinor
  }
  books.set(customerId, b)
  if (CHARGE_KINDS.has(kind)) monthCharged[opts.k] += amountMinor
}

function assertBooks() {
  for (const [id, expected] of books) {
    const v = customerView(db, id)
    assert.ok(v, `${id} exists`)
    assert.equal(v.balanceMinor, expected.balance, `${id} balance`)
    assert.equal(v.depositHeldMinor, expected.deposit, `${id} deposit`)
  }
  // The owed list is exactly the positive balances, biggest first.
  const owing = customersByBalance(db).filter((c) => c.balanceMinor > 0)
  const expectedOwed = [...books.values()]
    .filter((b) => b.balance > 0)
    .reduce((n, b) => n + b.balance, 0)
  assert.equal(
    owing.reduce((n, c) => n + c.balanceMinor, 0),
    expectedOwed,
    'owed total',
  )
}

// -------------------------------------------------------- the physical world
// outTracker mirrors "what is physically at a client's site" by hand.

const outTracker = new Set(
  db
    .all(`select id from assets where presence in ('out','in_transit')`)
    .map((r) => r.id),
)

function sqlOutSet() {
  return new Set(
    db
      .all(`select id from assets where presence in ('out','in_transit')`)
      .map((r) => r.id),
  )
}

function assertPhysical() {
  assert.deepEqual([...sqlOutSet()].sort(), [...outTracker].sort(), 'out set')
}

// ------------------------------------------------------------ scan plumbing

let expectedScanOps = 0
const countScanOps = () =>
  Number(db.get(`select count(*) as n from outbox where op = 'submit_scan_batch'`).n)

const physicallyOut = (jobId) =>
  db
    .all(
      `select id from assets
        where current_job_id = ? and presence in ('out','in_transit')
        order by asset_code`,
      [jobId],
    )
    .map((r) => r.id)

/**
 * Open a session the way the registry does, but on the simulated clock —
 * the registry itself cannot take one, the outbox stamps rows with the
 * real Date.now(), and the store's money writes take no timestamp at all
 * (so a payment can never be backdated). Finding `clock-welds`.
 */
function openSession(jobId, mode, whenMs) {
  finding('clock-welds')
  const expected =
    mode === 'out' ? (openJob(db, jobId)?.expected ?? []) : physicallyOut(jobId)
  const session = new ScanSession(db, {
    deviceId: 'sim-phone',
    jobId,
    expected: new Set(expected),
    now: () => whenMs,
  })
  recordSessionStart(db, { id: session.id, jobId, mode, startedAt: whenMs, expected })
  return { session, expected, mode, jobId }
}

/** Scan a list of assets by their real tags; keep the trackers honest. */
function scanAll(entry, assetIds, eventType, allowed = ['accepted']) {
  const results = []
  for (const id of assetIds) {
    const r = entry.session.scan(tagOf.get(id), eventType)
    assert.ok(allowed.includes(r.outcome), `${id}: got ${r.outcome}`)
    if (r.outboxId) {
      expectedScanOps++
      if (eventType === 'check_out') outTracker.add(id)
      if (eventType === 'check_in') outTracker.delete(id)
    }
    results.push(r)
  }
  return results
}

function assertNoLostScans() {
  assert.equal(countScanOps(), expectedScanOps, 'scan op count')
}

// -------------------------------------------------- workarounds, documented
// Each of these is a thing the VENDOR CANNOT DO in the app. The simulation
// does it with direct SQL so the year can continue; each use is a finding.

/** finding `no-add-customer`: nothing in the app creates a customer row. */
function addCustomer(id, name, phone) {
  db.exec(
    `insert into customers (id, org_id, name, phone, note) values (?, ?, ?, ?, null)`,
    [id, seed.orgId, name, phone],
  )
  books.set(id, { balance: 0, deposit: 0 })
  finding('no-add-customer')
}

/** finding `no-customer-on-desk-job`: createJob/createJobFromLines take no
 *  customer, so every desk-made job is born unchargeable. */
function wireJob(jobId, customerId) {
  db.exec(`insert into job_customer (job_id, customer_id) values (?, ?)`, [
    jobId,
    customerId,
  ])
  finding('no-customer-on-desk-job')
}

/** finding `no-close-job`: no API sets status='closed'; without this SQL the
 *  Today board and availability commitments accumulate every job forever. */
function closeJob(jobId) {
  db.exec(`update jobs set status = 'closed' where id = ?`, [jobId])
  finding('no-close-job')
}

// ------------------------------------------------------------- job helpers

let jobSeq = 0

function makeJob(label, customerId, wants, dueIso, contact = null) {
  const id = `job-sim-${String(++jobSeq).padStart(3, '0')}`
  const result = createJob(db, {
    id,
    orgId: seed.orgId,
    label,
    contact,
    expectedBack: dueIso,
    wants,
  })
  wireJob(id, customerId)
  return { id, expected: result.expected, requested: result.requested }
}

/** The common loop: create, wire, scan out everything allocated. */
function jobOut(label, customerId, wants, dueIso, whenMs, contact = null) {
  const job = makeJob(label, customerId, wants, dueIso, contact)
  const out = openSession(job.id, 'out', whenMs)
  scanAll(out, job.expected, 'check_out')
  return job
}

/** Return everything physically out on a job, then charge/pay/close. */
function jobBack(jobId, customerId, whenMs, money = {}) {
  const back = openSession(jobId, 'in', whenMs)
  scanAll(back, back.expected, 'check_in')
  const k = money.k
  if (money.chargeRs) {
    post(customerId, 'charge', money.chargeRs, {
      k, d: money.d, jobId, assetId: money.assetId ?? null, note: money.note ?? null,
    })
  }
  if (money.payRs) {
    // An hour after the charge, never the same millisecond: oldestUnpaidMs
    // re-sorts the screen's newest-first entries by createdAt, and a tied
    // charge/payment pair flips order — see the papercut in the year doc.
    post(customerId, 'payment', -money.payRs, { k, d: money.d, hour: 13, jobId, note: 'Cash' })
  }
  closeJob(jobId)
}

// ===========================================================================

describe('a year in the life of the rental house', () => {
  // -------------------------------------------------------------- SEP (k=0)
  test('SEP — the pilot starts: import, tagging, first jobs, first payments', () => {
    // --- The catalogue import ---------------------------------------------
    const csv = [
      'Item,Qty,Code,Shelf',
      'Godox SL60W,4,GDX,Grip Bay',
      'Sony FX9,1,FX9,Rack A',
      'Aputure 600D Pro,2,AP600,Grip Bay',
      'HMI 1.2K,1,HMI,Grip Bay',
    ].join('\n')
    const table = parseCsv(csv)
    const { rows, rejected } = readRows(table, {
      name: 0, quantity: 1, code: 2, location: 3,
    })
    const plan = planImport(rows, demoCatalogue(), rejected)
    assert.equal(plan.newProducts, 2)        // Godox, HMI
    assert.equal(plan.existingProducts, 2)   // FX9, Aputure — exact matches
    assert.equal(plan.unitsToCreate, 8)

    // Applying the plan replicates DemoStore.applyImport line for line,
    // because that routine lives in store.ts welded to the sql.js driver and
    // cannot run (or be reused) under Node. Finding `import-apply-welded`.
    finding('import-apply-welded')
    applyPlan(plan)

    // The import gave the new FX9 unit the code FX9-01 — the SAME visible
    // code as the seeded FX9-01. Nothing objects. Two different cameras now
    // answer to one sticker code in manual search. Finding `duplicate-asset-code`.
    const dupes = db.get(
      `select count(*) as n from assets where asset_code = 'FX9-01'`,
    )
    assert.equal(Number(dupes.n), 2)
    finding('duplicate-asset-code')

    // --- Tagging the imported rack ----------------------------------------
    const binder = new ScanSession(db, { deviceId: 'sim-phone', now: () => at(0, -3) })
    const imported = db
      .all(`select id from assets where id like 'asset-imported-%' order by id`)
      .map((r) => r.id)
    assert.equal(imported.length, 8)
    imported.forEach((assetId, i) => {
      const code = `v1SIMSEP${String(i + 1).padStart(2, '0')}AAAAAAAAAAAAAA`
      const r = binder.bindTag(code, assetId)
      assert.equal(r.outcome, 'accepted')
      tagOf.set(assetId, code)
      assert.equal(lookupTag(db, code).assetId, assetId)
    })
    // A label already in use refuses to move — the protective rule holds.
    const steal = binder.bindTag(tagOf.get('asset-fx9-1'), imported[0])
    assert.equal(steal.outcome, 'conflict')

    // --- Real due dates entered at adoption -------------------------------
    setExpectedBack(db, 'job-shan', iso(0, 0))
    setExpectedBack(db, 'job-wedding', iso(0, 3))
    setExpectedBack(db, 'job-doc', iso(0, -5)) // the pre-app mess, already late

    // --- First job out: the TVC, clean ------------------------------------
    const shan = openSession('job-shan', 'out', at(0, -1, 6))
    const pull = buildPullList(db, shan.expected, shan.session.scannedIds)
    assert.equal(pull.total, 11)
    scanAll(shan, shan.expected, 'check_out')
    assert.equal(packedProgress(db, 'job-shan'), 11)

    // --- Second job out: the wedding, and the overlap ---------------------
    // The seed promises V-Mount batteries 1-4 to BOTH the TVC and the
    // wedding: with no reservations, "first N units on the shelf" is the
    // only allocator anyone has. The batteries left on the TVC truck an
    // hour ago, so the tech grabs 5-8 — and the screen calls every one of
    // them 'Not on this job'. Finding `double-promise` (first sighting).
    const wed = openSession('job-wedding', 'out', at(0, -1, 13))
    const overlap = wed.expected.filter((id) => outTracker.has(id))
    assert.deepEqual(overlap, [
      'asset-vmount-1', 'asset-vmount-2', 'asset-vmount-3', 'asset-vmount-4',
    ])
    finding('double-promise')
    const wedOnShelf = wed.expected.filter((id) => !outTracker.has(id))
    scanAll(wed, wedOnShelf, 'check_out')
    scanAll(
      wed,
      ['asset-vmount-5', 'asset-vmount-6', 'asset-vmount-7', 'asset-vmount-8'],
      'check_out',
      ['unexpected'],
    )
    // The ring undercounts: 7 of 11 promised items left, though 11 physical
    // items are out — off-list swaps are invisible to packedProgress.
    assert.equal(packedProgress(db, 'job-wedding'), 7)
    const wedSummary = buildSummary({
      jobLabel: 'Wedding', mode: 'out',
      expected: wed.expected,
      recorded: wed.session.scannedIds,
      assumed: [], unknownTags: [],
      facts: () => undefined,
    })
    assert.equal(wedSummary.scanned, 11)
    assert.equal(wedSummary.missing.length, 4) // cries wolf on the swap
    assert.equal(wedSummary.exceptions.length, 4)

    // 11 TVC + 11 wedding + 1 pre-existing (FX6-03 on the documentary).
    assertPhysical()
    assert.equal(sqlOutSet().size, 23)

    // --- The TVC comes home on time ---------------------------------------
    assert.equal(dueStatus(iso(0, 0), at(0, 0, 18)).state, 'due_today')
    const shanBack = openSession('job-shan', 'in', at(0, 0, 18))
    assert.equal(shanBack.expected.length, 11)
    scanAll(shanBack, shanBack.expected, 'check_in')
    // Done — but the job cannot be closed from the app; it would sit on the
    // Today board forever. Pinned below at the doc job, workaround here.
    closeJob('job-shan')

    // --- First payments ---------------------------------------------------
    post('cust-bilal', 'payment', -25_000, { k: 0, d: 2, note: 'JazzCash' })
    post('cust-ayesha', 'payment', -15_000, { k: 0, d: 2, note: 'Cash' })
    // Imran's cheque, held since the drama shoot, is released after
    // inspection. The ledger kind exists; no screen writes it (see DEC).
    post('cust-imran', 'deposit_refund', -50_000, { k: 0, d: 2, note: 'Cheque returned' })

    // --- The wedding comes home a day early -------------------------------
    jobBack('job-wedding', 'cust-hamza', at(0, 2, 19), {
      k: 0, d: 2, chargeRs: 60_000, payRs: 60_000,
    })

    // --- The documentary limps home, 11 days late -------------------------
    const late = dueStatus(iso(0, -5), at(0, 6))
    assert.equal(late.state, 'overdue')
    assert.equal(late.daysLate, 11)
    // The by-the-book draft: 11 days × the FX6 still out = Rs 198,000 on a
    // Rs 55,000 job. The owner waives it — and the waiver leaves NO trace:
    // no entry, no note, nothing to show the client goodwill was extended.
    const draft = lateFeeDraft(late.daysLate, [rs(18_000)])
    assert.equal(draft.totalMinor, rs(198_000))
    finding('waived-fee-invisible')
    const docBack = openSession('job-doc', 'in', at(0, 6))
    assert.deepEqual(docBack.expected, ['asset-fx6-3'])
    scanAll(docBack, docBack.expected, 'check_in')

    // Everything is home, yet the documentary still claims its promised set
    // in every availability answer, because a finished job stays 'open':
    const answer = checkAvailability(
      db,
      matchKitList(parseKitList('1x Canon C300 Mark III'), demoCatalogue()),
      openJobCommitments(db),
      at(0, 7),
    )
    const c300 = answer.lines[0]
    assert.equal(c300.state, 'available')
    assert.ok(
      c300.committed.some((c) => c.jobLabel.startsWith('Documentary')),
      'ghost commitment from the unclosable job',
    )
    assert.match(availabilityNote(c300), /going to Documentary/)
    closeJob('job-doc')
    const after = checkAvailability(
      db,
      matchKitList(parseKitList('1x Canon C300 Mark III'), demoCatalogue()),
      openJobCommitments(db),
      at(0, 7),
    )
    assert.equal(after.lines[0].committed.length, 0)

    // --- Month end --------------------------------------------------------
    assertBooks()
    assertPhysical()
    assertNoLostScans()
    assert.equal(sqlOutSet().size, 0)
    const strip = moneyStrip(db, at(0, 9))
    assert.equal(strip.owedMinor, rs(50_000 + 40_000)) // Bilal + Ayesha
    assert.equal(strip.owingCount, 2)
    assert.equal(strip.earnedMonthMinor, monthCharged[0])
    assert.equal(monthCharged[0], rs(60_000)) // the wedding; payments are not income
  })

  // -------------------------------------------------------------- OCT (k=1)
  test('OCT — volume doubles; a case loses a cable; the first late fee', () => {
    addCustomer('cust-farhan', 'Farhan Malik', '0301 5544332')
    addCustomer('cust-sana', 'Sana Tariq', '0322 7788990')

    // A job made at the desk is born with NO customer — the charge buttons
    // would never render for it. Pinned before the wiring workaround.
    const o1 = createJob(db, {
      id: 'job-sim-o1', orgId: seed.orgId, label: 'Corporate shoot — Gulberg',
      contact: 'Farhan 0301 5544332', expectedBack: iso(1, -4),
      wants: [{ productId: 'prod-fx6', qty: 2 }, { productId: 'prod-xlr', qty: 4 }],
    })
    assert.equal(customerForJob(db, 'job-sim-o1'), null)
    wireJob('job-sim-o1', 'cust-farhan')
    const o1out = openSession('job-sim-o1', 'out', at(1, -9))
    scanAll(o1out, o1.expected, 'check_out')

    // --- The lost cable ---------------------------------------------------
    const o1back = openSession('job-sim-o1', 'in', at(1, -4))
    assert.equal(o1back.expected.length, 6)
    const missingCable = o1back.expected.find((id) => id.startsWith('asset-xlr'))
    const came = o1back.expected.filter((id) => id !== missingCable)
    scanAll(o1back, came, 'check_in')
    const o1summary = buildSummary({
      jobLabel: 'Corporate shoot', mode: 'in',
      expected: o1back.expected,
      recorded: o1back.session.scannedIds,
      assumed: [], unknownTags: [],
      facts: (id) => {
        const r = db.get(
          `select a.asset_code, coalesce(p.display_name, a.display_name) as name,
                  rt.replacement_minor
             from assets a
             left join products p on p.id = a.product_id
             left join product_rates rt on rt.product_id = a.product_id
            where a.id = ?`,
          [id],
        )
        return r
          ? { id, code: r.asset_code, name: r.name, replacementMinor: r.replacement_minor }
          : undefined
      },
    })
    assert.equal(o1summary.missing.length, 1)
    assert.equal(o1summary.missingValue.totalMinor, rs(8_000))
    post('cust-farhan', 'charge', 40_000, { k: 1, d: -4, jobId: 'job-sim-o1', note: '2x FX6 + cables, 5 days' })
    post('cust-farhan', 'damage_charge', 8_000, {
      k: 1, d: -4, jobId: 'job-sim-o1', assetId: missingCable, note: 'XLR not returned',
    })
    post('cust-farhan', 'payment', -40_000, { k: 1, d: -4, note: 'Cash' })
    // The cable was paid for — but it stays presence='out' on this job
    // forever. There is no terminal state (lost / sold / written off), so
    // the fleet count carries a ghost from here to year end.
    finding('no-terminal-asset-state')
    closeJob('job-sim-o1')
    assert.ok(sqlOutSet().has(missingCable))

    // --- The first late fee, and the order-of-operations trap -------------
    const o2 = makeJob('Fashion lookbook — Model Town', 'cust-sana',
      [{ productId: 'prod-komodo', qty: 1 }, { productId: 'prod-ronin', qty: 1 }],
      iso(1, 2), 'Sana 0322 7788990')
    const o2out = openSession(o2.id, 'out', at(1, -8))
    scanAll(o2out, o2.expected, 'check_out')

    const o2due = dueStatus(iso(1, 2), at(1, 5))
    assert.equal(o2due.daysLate, 3)
    // The draft the charge sheet would offer — computed, as the store does,
    // from the day rates of what is STILL OUT on the job:
    const ratesBefore = db
      .all(
        `select r.day_rate_minor from assets a
           left join product_rates r on r.product_id = a.product_id
          where a.current_job_id = ? and a.presence in ('out','in_transit')`,
        [o2.id],
      )
      .map((r) => (r.day_rate_minor === null ? null : Number(r.day_rate_minor)))
    assert.equal(lateFeeDraft(3, ratesBefore).totalMinor, rs(84_000))

    const o2back = openSession(o2.id, 'in', at(1, 5))
    scanAll(o2back, o2back.expected, 'check_in')

    // Same sheet opened AFTER the tech scanned the gear in: nothing is out,
    // so the draft collapses to an unpriced zero. The desk must charge the
    // fee BEFORE scanning — nothing says so. Finding `latefee-after-scan-zero`.
    const ratesAfter = db
      .all(
        `select r.day_rate_minor from assets a
           left join product_rates r on r.product_id = a.product_id
          where a.current_job_id = ? and a.presence in ('out','in_transit')`,
        [o2.id],
      )
      .map((r) => (r.day_rate_minor === null ? null : Number(r.day_rate_minor)))
    const collapsed = lateFeeDraft(3, ratesAfter)
    assert.equal(collapsed.totalMinor, 0)
    assert.equal(collapsed.priced, 0)
    assert.equal(moneyLabel(collapsed), null)
    finding('latefee-after-scan-zero')

    post('cust-sana', 'charge', 55_000, { k: 1, d: 5, jobId: o2.id, note: 'Komodo + Ronin, 3 days' })
    post('cust-sana', 'late_fee', 15_000, { k: 1, d: 5, jobId: o2.id, note: '3 days late — reduced' })
    post('cust-sana', 'payment', -70_000, { k: 1, d: 5, note: 'Bank transfer' })
    closeJob(o2.id)

    // --- Four more clean loops: the volume doubling -----------------------
    const o3 = jobOut('Mehndi — Cantt', 'cust-hamza',
      [{ productId: 'prod-fx6', qty: 1 }, { productId: 'prod-vmount', qty: 2 }],
      iso(1, -1), at(1, -3))
    jobBack(o3.id, 'cust-hamza', at(1, -1), { k: 1, d: -1, chargeRs: 25_000, payRs: 25_000 })

    const o4 = jobOut('Shan stills — round two', 'cust-bilal',
      [{ productId: 'prod-c300', qty: 1 }, { productId: 'prod-sigma1835', qty: 1 }],
      iso(1, 1), at(1, -2))
    jobBack(o4.id, 'cust-bilal', at(1, 1), { k: 1, d: 1, chargeRs: 28_000 }) // unpaid

    const o5 = jobOut('Drama serial — block B', 'cust-imran',
      [{ productId: 'prod-aputure600', qty: 2 }, { productId: 'prod-cstand', qty: 4 }],
      iso(1, 4), at(1, 0))
    jobBack(o5.id, 'cust-imran', at(1, 4), { k: 1, d: 4, chargeRs: 30_000, payRs: 30_000 })

    const o6 = jobOut('Podcast rig — Johar Town', 'cust-sana',
      [{ productId: 'prod-mixpre', qty: 1 }, { productId: 'prod-mkh416', qty: 1 }],
      iso(1, 6), at(1, 3))
    jobBack(o6.id, 'cust-sana', at(1, 6), { k: 1, d: 6, chargeRs: 12_000, payRs: 12_000 })

    // --- Month end --------------------------------------------------------
    assertBooks()
    assertPhysical()
    assertNoLostScans()
    assert.equal(sqlOutSet().size, 1) // the ghost cable
    const strip = moneyStrip(db, at(1, 9))
    assert.equal(strip.earnedMonthMinor, monthCharged[1])
    assert.equal(monthCharged[1], rs(40_000 + 8_000 + 55_000 + 15_000 + 25_000 + 28_000 + 30_000 + 12_000))
    assert.equal(books.get('cust-farhan').balance, rs(8_000))
    assert.equal(books.get('cust-bilal').balance, rs(78_000))
  })

  // -------------------------------------------------------------- NOV (k=2)
  test('NOV — three clients want the same camera; a new tech learns to scan', () => {
    // --- The double promise, now with cameras -----------------------------
    // Two clients book FX9s for the same weekend. createJob allocates from
    // presence='here' only — it does not know what OTHER open jobs already
    // promised. Both jobs are handed the SAME physical cameras.
    const n1 = makeJob('Shaadi — Bahria', 'cust-bilal',
      [{ productId: 'prod-fx9', qty: 2 }], iso(2, 4))
    const n2 = makeJob('Shaadi — Wapda Town', 'cust-sana',
      [{ productId: 'prod-fx9', qty: 2 }], iso(2, 5))
    const promisedTwice = n1.expected.filter((id) => n2.expected.includes(id))
    assert.ok(promisedTwice.length >= 1, 'the same unit promised to two jobs')
    finding('double-promise')
    finding('no-bookings')

    // --- The third client, and the blind spot in the demand log -----------
    // On the shelf everything looks fine (3 FX9s, none out yet), so the
    // answer is 'available' — with two commitment notes the owner must read
    // and weigh himself. He turns the third client away… and the turned-away
    // log records NOTHING, because only shelf-shortage lines count.
    const enquiry = checkAvailability(
      db,
      matchKitList(parseKitList('2x Sony FX9'), demoCatalogue()),
      openJobCommitments(db),
      at(2, 1),
    )
    assert.equal(enquiry.lines[0].state, 'available')
    assert.equal(enquiry.lines[0].onHand, 3)
    assert.equal(enquiry.lines[0].committed.length, 2)
    assert.equal(recordTurnedAway(db, enquiry.lines, at(2, 1)), 0)
    assert.deepEqual(turnedAwayThisMonth(db, 'prod-fx9', at(2, 1)), { times: 0, units: 0 })
    finding('turnaway-blind-to-commitments')

    // First truck wins: N1 takes its two cameras.
    const n1out = openSession(n1.id, 'out', at(2, 2, 6))
    scanAll(n1out, n1.expected, 'check_out')
    // N2's session opens against a list that names gear already on
    // Bilal's truck. The tech scans the one FX9 left ('unexpected' if not
    // on N2's list) and the summary reports the promised ones missing.
    const n2out = openSession(n2.id, 'out', at(2, 2, 7))
    const n2gone = n2.expected.filter((id) => outTracker.has(id))
    assert.ok(n2gone.length >= 1)
    const fx9Left = db
      .all(
        `select id from assets where product_id = 'prod-fx9' and presence = 'here'`,
      )
      .map((r) => r.id)
    assert.equal(fx9Left.length, 1)
    const onList = n2.expected.includes(fx9Left[0])
    scanAll(n2out, fx9Left, 'check_out', onList ? ['accepted'] : ['unexpected'])

    jobBack(n1.id, 'cust-bilal', at(2, 6), { k: 2, d: 6, chargeRs: 50_000, payRs: 50_000 })
    jobBack(n2.id, 'cust-sana', at(2, 7), { k: 2, d: 7, chargeRs: 25_000, payRs: 25_000, note: 'one camera short' })

    // --- The new tech's first week ----------------------------------------
    const n3 = makeJob('Interview setup — DHA', 'cust-hamza',
      [{ productId: 'prod-sachtler', qty: 1 }, { productId: 'prod-smallhd', qty: 1 },
       { productId: 'prod-vmount', qty: 2 }],
      iso(2, 12))
    const n3out = openSession(n3.id, 'out', at(2, 8))

    // Rescan: feedback, never a second write.
    const first = n3out.session.scan(tagOf.get(n3.expected[0]), 'check_out')
    assert.equal(first.outcome, 'accepted')
    expectedScanOps++
    outTracker.add(n3.expected[0])
    const again = n3out.session.scan(tagOf.get(n3.expected[0]), 'check_out')
    assert.equal(again.outcome, 'duplicate')
    assert.equal(again.outboxId, undefined)
    assertNoLostScans()

    // A label nobody bound (torn sheet, fresh sticker): recorded, not lost.
    const torn = n3out.session.scan('v1TORNLABELXXXXXXXXXXXXX', 'check_out')
    assert.equal(torn.outcome, 'unknown_tag')
    assert.ok(torn.outboxId)
    expectedScanOps++
    const facts = sessionScanFacts(decodeScanOps(db), n3out.session.id)
    assert.equal(facts.unknownTags.length, 1)

    // Tag under gaffer tape: the manual path.
    const manual = n3out.session.addManually(n3.expected[1], 'check_out')
    assert.equal(manual.outcome, 'accepted')
    expectedScanOps++
    outTracker.add(n3.expected[1])
    scanAll(n3out, n3.expected.slice(2), 'check_out')

    // --- The wrong-job scan, and the undo that does not exist -------------
    const n4 = jobOut('Music video — c500 day', 'cust-sana',
      [{ productId: 'prod-c500', qty: 1 }], iso(2, 12), at(2, 8, 9))
    const c500 = n4.expected[0]
    // Danish scans the C500 into the interview job. The app warns — and
    // records, because reality outranks the schedule. The projection now
    // says the camera is on the WRONG job.
    const wrong = n3out.session.scan(tagOf.get(c500), 'check_out')
    assert.equal(wrong.outcome, 'conflict')
    assert.equal(wrong.requiresReason, true)
    expectedScanOps++
    assert.equal(
      db.get(`select current_job_id as j from assets where id = ?`, [c500]).j,
      n3.id,
      'the mis-scan moved the camera onto the wrong job',
    )
    // There is no undo. The only repair is a compensating dance that writes
    // two more (false) movement facts into the permanent history:
    const fixer = new ScanSession(db, { deviceId: 'sim-phone', now: () => at(2, 8, 10) })
    const undo = fixer.scan(tagOf.get(c500), 'check_in')
    assert.equal(undo.outcome, 'accepted')
    expectedScanOps++
    const redoSession = new ScanSession(db, {
      deviceId: 'sim-phone', jobId: n4.id, expected: new Set([c500]),
      now: () => at(2, 8, 10),
    })
    const redo = redoSession.scan(tagOf.get(c500), 'check_out')
    assert.equal(redo.outcome, 'accepted')
    expectedScanOps++
    assert.equal(
      db.get(`select current_job_id as j from assets where id = ?`, [c500]).j,
      n4.id,
    )
    finding('no-scan-undo')

    jobBack(n3.id, 'cust-hamza', at(2, 12), { k: 2, d: 12, chargeRs: 20_000, payRs: 20_000 })
    jobBack(n4.id, 'cust-sana', at(2, 12), { k: 2, d: 12, chargeRs: 22_000, payRs: 22_000 })

    // --- Month end --------------------------------------------------------
    assertBooks()
    assertPhysical()
    assertNoLostScans()
    const strip = moneyStrip(db, at(2, 13))
    assert.equal(strip.earnedMonthMinor, monthCharged[2])
    assert.equal(monthCharged[2], rs(50_000 + 25_000 + 20_000 + 22_000))
  })

  // -------------------------------------------------------------- DEC (k=3)
  test('DEC — peak season: twelve concurrent jobs, a double charge, a deposit', () => {
    const roster = [
      ['cust-bilal',  [{ productId: 'prod-fx9', qty: 1 }, { productId: 'prod-cne', qty: 1 }, { productId: 'prod-vmount', qty: 3 }]],
      ['cust-hamza',  [{ productId: 'prod-fx6', qty: 2 }, { productId: 'prod-ronin', qty: 1 }, { productId: 'prod-vmount', qty: 2 }]],
      ['cust-sana',   [{ productId: 'prod-c300', qty: 1 }, { productId: 'prod-sigma1835', qty: 2 }]],
      ['cust-imran',  [{ productId: 'prod-komodo', qty: 1 }, { productId: 'prod-smallhd', qty: 1 }]],
      ['cust-ayesha', [{ productId: 'prod-aputure600', qty: 2 }, { productId: 'prod-cstand', qty: 3 }]],
      ['cust-hamza',  [{ productId: 'prod-aputure300', qty: 1 }, { productId: 'prod-forza', qty: 1 }]],
      ['cust-bilal',  [{ productId: 'prod-fx9', qty: 3 }, { productId: 'prod-samyang', qty: 1 }]], // asks for 3 FX9s
      ['cust-sana',   [{ productId: 'prod-fx6', qty: 1 }, { productId: 'prod-sigma50100', qty: 1 }]],
      ['cust-imran',  [{ productId: 'prod-mixpre', qty: 1 }, { productId: 'prod-mkh416', qty: 1 }, { productId: 'prod-xlr', qty: 4 }]],
      ['cust-hamza',  [{ productId: 'prod-sachtler', qty: 1 }, { productId: 'prod-sachdeva', qty: 2 }]],
      ['cust-ayesha', [{ productId: 'prod-c500', qty: 1 }, { productId: 'prod-vmount', qty: 2 }]],
      ['cust-bilal',  [{ productId: 'prod-cstand', qty: 4 }, { productId: 'prod-xlr', qty: 4 }]],
    ]
    const decJobs = []
    roster.forEach(([customerId, wants], i) => {
      const job = jobOut(`Peak day ${i + 1}`, customerId, wants, iso(3, -9 + i + 4), at(3, -9 + i, 6))
      decJobs.push({ job, customerId, backD: -9 + i + 4 })
    })

    // Peak scarcity is reported, never padded: the 3-FX9 ask got fewer.
    const d7 = decJobs[6]
    assert.ok(d7.job.expected.length < d7.job.requested, 'shortfall reported')
    assert.equal(d7.job.requested, 4)

    // Mid-peak coherence: the boards and the mirror agree with our tracker.
    assertPhysical()
    const board = dueBoard(db, at(3, 1))
    assert.ok(board.outJobs.length >= 8, `${board.outJobs.length} jobs with gear out at peak`)

    // --- The double charge, corrected in the open -------------------------
    const dupJob = decJobs[3] // Imran's Komodo day
    post('cust-imran', 'damage_charge', 30_000, { k: 3, d: 1, jobId: dupJob.job.id, note: 'Cracked monitor hood' })
    post('cust-imran', 'damage_charge', 30_000, { k: 3, d: 1, jobId: dupJob.job.id, note: 'Cracked monitor hood' })
    // Double-tap at the dock: two identical lines, no guard, no void. The
    // ledger is append-only (correct), but the only correction is an
    // 'adjustment' entry that NO screen can write. Finding `no-adjustment-door`.
    post('cust-imran', 'adjustment', -30_000, { k: 3, d: 1, note: 'Entered twice — corrected' })
    finding('no-adjustment-door')
    const imranEntries = customerView(db, 'cust-imran').entries
    assert.equal(imranEntries.filter((e) => e.kind === 'damage_charge').length, 2)
    assert.equal(imranEntries.filter((e) => e.kind === 'adjustment').length, 1)

    // --- The deposit, held and applied against damage ---------------------
    // Sana's big shaadi: Rs 100,000 held at checkout. The ledger projects
    // deposits perfectly — but only the seed has ever written these kinds;
    // no store method or screen exists. Finding `no-deposit-door`.
    const shaadi = decJobs[2]
    post('cust-sana', 'deposit_hold', 100_000, { k: 3, d: -7, jobId: shaadi.job.id, note: 'Cheque held' })
    post('cust-sana', 'charge', 90_000, { k: 3, d: -7, jobId: shaadi.job.id, note: 'C300 kit, shaadi week' })
    finding('no-deposit-door')

    // Returns, staggered.
    for (const { job, customerId, backD } of decJobs) {
      if (job.id === shaadi.job.id) {
        // Damage found at the dock; deposit applied; remainder refunded.
        const back = openSession(job.id, 'in', at(3, backD))
        scanAll(back, back.expected, 'check_in')
        post('cust-sana', 'damage_charge', 40_000, { k: 3, d: backD, jobId: job.id, note: 'Lens scratch' })
        post('cust-sana', 'deposit_apply', -40_000, { k: 3, d: backD, jobId: job.id, note: 'Held cheque applied' })
        post('cust-sana', 'deposit_refund', -60_000, { k: 3, d: backD, jobId: job.id, note: 'Balance of cheque returned' })
        post('cust-sana', 'payment', -50_000, { k: 3, d: backD, note: 'Cash' })
        closeJob(job.id)
        continue
      }
      jobBack(job.id, customerId, at(3, backD), {
        k: 3, d: backD, chargeRs: 20_000, payRs: 20_000,
      })
    }
    assert.equal(books.get('cust-sana').deposit, 0)
    // 90 charged + 40 damage − 40 applied − 50 paid = 40,000 still owed.
    assert.equal(
      customerView(db, 'cust-sana').balanceMinor,
      books.get('cust-sana').balance,
    )

    // --- Month end --------------------------------------------------------
    assertBooks()
    assertPhysical()
    assertNoLostScans()
    const strip = moneyStrip(db, at(3, 12))
    assert.equal(strip.earnedMonthMinor, monthCharged[3])
    assert.ok(countScanOps() > 190, `${countScanOps()} scans queued by December`)
  })

  // -------------------------------------------------------------- JAN (k=4)
  test('JAN — a camera drops on set: photos, damage, and the missing swap flow', () => {
    // Bilal's TVC week: the seeded FX9-01 goes out, photographed.
    const j1 = makeJob('TVC — Ferozepur Road', 'cust-bilal',
      [{ productId: 'prod-fx9', qty: 1 }, { productId: 'prod-sigma1835', qty: 1 }],
      iso(4, -3))
    assert.ok(j1.expected.includes('asset-fx9-1'))
    const j1out = openSession(j1.id, 'out', at(4, -7))
    const photosOut = new PhotoStore(db, { now: () => at(4, -7) })
    const cap = photosOut.capture({
      assetId: 'asset-fx9-1', jobId: j1.id, sessionId: j1out.session.id,
      side: 'out', localUri: 'data:,sim-out', bytes: 120_000, sha256: 'sim-jan-out',
    })
    assert.equal(cap.ok, true)
    scanAll(j1out, j1.expected, 'check_out')

    // Day 3: the camera drops on set. The client needs a replacement NOW.
    // There is no swap flow — the desk fakes it with a second one-line job.
    const j1b = jobOut('TVC — replacement body', 'cust-bilal',
      [{ productId: 'prod-c500', qty: 1 }], iso(4, -3), at(4, -4))
    assert.equal(j1b.expected.length, 1)
    finding('no-swap-flow')

    // The broken camera comes home; the 'in' photo shows the crack.
    const j1back = openSession(j1.id, 'in', at(4, -3))
    scanAll(j1back, j1back.expected, 'check_in')
    const photosIn = new PhotoStore(db, { now: () => at(4, -3) })
    assert.equal(
      photosIn.capture({
        assetId: 'asset-fx9-1', jobId: j1.id, sessionId: j1back.session.id,
        side: 'in', localUri: 'data:,sim-in', bytes: 130_000, sha256: 'sim-jan-in',
        note: 'Cracked top handle',
      }).ok,
      true,
    )
    // The dispute evidence: out/in pairs, seeded pair plus this one.
    const pairs = pairBySide(photosIn.forAsset('asset-fx9-1'))
    assert.equal(pairs.length, 2)
    const mine = pairs.find((p) => p.out?.sha256 === 'sim-jan-out')
    assert.ok(mine?.in, 'the new out photo paired with the new in photo')
    assert.equal(mine.in.sha256, 'sim-jan-in')
    assert.ok(mine.in.capturedAt >= mine.out.capturedAt)

    // Out of service: no screen can mark health. SQL stands in.
    db.exec(`update assets set health = 'needs_check' where id = 'asset-fx9-1'`)
    finding('no-health-door')
    const avail = checkAvailability(
      db,
      matchKitList(parseKitList('1x Sony FX9'), demoCatalogue()),
      openJobCommitments(db),
      at(4, -2),
    )
    assert.equal(avail.lines[0].onHand, 2) // 3 units minus the hurt one

    // The claim: rental + damage on the khata, partly paid.
    post('cust-bilal', 'charge', 35_000, { k: 4, d: -3, jobId: j1.id, assetId: 'asset-fx9-1', note: 'FX9 day rate x2' })
    post('cust-bilal', 'damage_charge', 150_000, { k: 4, d: -3, jobId: j1.id, assetId: 'asset-fx9-1', note: 'Top handle + mount repair' })
    post('cust-bilal', 'payment', -100_000, { k: 4, d: -2, note: 'Bank transfer' })
    closeJob(j1.id)
    jobBack(j1b.id, 'cust-bilal', at(4, -3), { k: 4, d: -3, chargeRs: 20_000, payRs: 20_000 })

    // The payback bar now counts the Rs 150,000 damage RECOVERY as
    // 'earnings' — the bar celebrates a repair bill. Finding `payback-counts-damage`.
    const earnings = assetEarnings(db, 'asset-fx9-1')
    assert.equal(earnings.earnedMinor, rs(60_000 + 45_000 + 35_000 + 150_000))
    assert.equal(earnings.jobs, 3)
    finding('payback-counts-damage')

    // Farhan's last job — it will never come back (see FEB).
    const f1 = jobOut('Music video — night shoot', 'cust-farhan',
      [{ productId: 'prod-fx6', qty: 1 }, { productId: 'prod-sigma50100', qty: 1 }],
      iso(4, 8), at(4, 5), 'Farhan 0301 5544332')
    post('cust-farhan', 'charge', 30_000, { k: 4, d: 5, jobId: f1.id, note: 'FX6 + 50-100, 3 days' })
    assert.equal(f1.expected.length, 2)

    assertBooks()
    assertPhysical()
    assertNoLostScans()
    const strip = moneyStrip(db, at(4, 10))
    assert.equal(strip.earnedMonthMinor, monthCharged[4])
  })

  // -------------------------------------------------------------- FEB (k=5)
  test('FEB — collections: statements out, one client vanishes, a write-off', () => {
    // Statements to every debtor — one at a time; there is no batch send.
    // Five of them after December: Sana's post-deposit remainder and
    // Imran's dock damage rode into the new year too.
    const debtors = customersByBalance(db).filter((c) => c.balanceMinor > 0)
    assert.deepEqual(
      debtors.map((c) => c.id).sort(),
      ['cust-ayesha', 'cust-bilal', 'cust-farhan', 'cust-imran', 'cust-sana'].sort(),
    )
    for (const c of debtors) {
      const view = customerView(db, c.id)
      const text = monthlyStatementText(
        {
          customerName: view.name,
          houseName: seed.houseName,
          entries: view.entries,
          nowMs: at(5, 0),
          paymentLine: 'JazzCash: 0300 1234567',
        },
        L,
      )
      // The closing balance is the whole projection, not just the month.
      assert.ok(text.includes(formatRupees(view.balanceMinor)), `${c.id} closing balance`)
      assert.ok(text.includes('JazzCash: 0300 1234567'))
    }

    // The statements work: Sana clears her shaadi remainder and Imran his
    // dock damage within the week.
    post('cust-sana', 'payment', -40_000, { k: 5, d: 4, note: 'Bank transfer — after statement' })
    post('cust-imran', 'payment', -30_000, { k: 5, d: 5, note: 'Cash — after statement' })
    assert.equal(customerView(db, 'cust-sana').balanceMinor, 0)
    assert.equal(customerView(db, 'cust-imran').balanceMinor, 0)

    // Farhan has vanished with an FX6 and a lens. The nudge exists…
    const f1row = dueBoard(db, at(5, 0)).outJobs.find((j) =>
      j.label.startsWith('Music video'),
    )
    assert.ok(f1row)
    assert.equal(f1row.due.state, 'overdue')
    const phone = parsePhoneNumber('Farhan 0301 5544332')
    const nudge = whatsAppNudgeUrl(
      phone,
      overdueNudgeMessage({
        jobLabel: f1row.label,
        itemsSummary: 'Sony FX6 + 1 more',
        dueLabel: f1row.due.label,
      }),
    )
    assert.match(nudge, /^https:\/\/wa\.me\//)
    // …and that is ALL that exists. No blacklist flag, no theft report
    // export (serials + photos for the police / partner houses), no way to
    // mark the customer. Finding `no-blacklist-or-theft-export`.
    finding('no-blacklist-or-theft-export')

    // The write-off: an 'adjustment' clears the money — indistinguishable
    // in kind from a discount or a data fix — and the Rs 2.6M of GEAR he
    // kept appears on no book at all.
    post('cust-farhan', 'adjustment', -38_000, { k: 5, d: 8, note: 'Written off — client absconded' })
    finding('write-off-illegible')
    assert.equal(books.get('cust-farhan').balance, 0)
    assert.ok(
      !customersByBalance(db).some((c) => c.id === 'cust-farhan' && c.balanceMinor > 0),
    )
    // The stolen gear stays 'out' forever; the board shows red forever.
    finding('no-terminal-asset-state')

    // A quiet rental keeps February honest.
    const feb1 = jobOut('Corporate AGM — PC Hotel', 'cust-imran',
      [{ productId: 'prod-aputure300', qty: 1 }, { productId: 'prod-mixpre', qty: 1 }],
      iso(5, 4), at(5, 2))
    jobBack(feb1.id, 'cust-imran', at(5, 4), { k: 5, d: 4, chargeRs: 18_000, payRs: 18_000 })

    assertBooks()
    assertPhysical()
    assertNoLostScans()
  })

  // -------------------------------------------------------------- MAR (k=6)
  test('MAR — Ramzan slowdown: what did each camera earn, and what cannot be asked', () => {
    // Per-asset earnings answer cleanly — for one asset at a time.
    const fx9 = assetEarnings(db, 'asset-fx9-1')
    assert.equal(fx9.earnedMinor, rs(290_000))
    assert.equal(fx9.paybackPct, Math.round((rs(290_000) / rs(3_500_000)) * 100))

    // Dead stock: the unpriced tripods earned nothing and have no payback
    // bar — honest. But NOTHING ranks the fleet or reports idle days; the
    // owner must open every asset page one by one. Finding `no-utilization-read`.
    const tripod = assetEarnings(db, 'asset-sachdeva-1')
    assert.equal(tripod.earnedMinor, 0)
    assert.equal(tripod.paybackPct, null)
    finding('no-utilization-read')

    // Past months ARE answerable by the API — the strip takes any clock…
    assert.equal(moneyStrip(db, at(1, 0)).earnedMonthMinor, monthCharged[1])
    assert.equal(moneyStrip(db, at(3, 0)).earnedMonthMinor, monthCharged[3])
    // …but no screen passes anything except Date.now(). The owner cannot
    // see October from March. Finding `no-month-history-screen`.
    finding('no-month-history-screen')

    // Ramzan trickle.
    const m1 = jobOut('Iftar transmission — set light', 'cust-hamza',
      [{ productId: 'prod-forza', qty: 1 }], iso(6, 6), at(6, 3))
    jobBack(m1.id, 'cust-hamza', at(6, 6), { k: 6, d: 6, chargeRs: 12_000, payRs: 12_000 })

    assertBooks()
    assertNoLostScans()
  })

  // -------------------------------------------------------------- APR (k=7)
  test('APR — Eid rush, and the partner house gear that has to pretend to be owned', () => {
    // The rush finds the shelf short: six big lights wanted, five fit to rent.
    const ask = checkAvailability(
      db,
      matchKitList(parseKitList('6x Aputure 600D Pro'), demoCatalogue()),
      openJobCommitments(db),
      at(7, -8),
    )
    assert.equal(ask.lines[0].state, 'short')
    assert.equal(ask.lines[0].onHand, 5) // 4 seeded − 1 faulty + 2 imported
    assert.equal(recordTurnedAway(db, ask.lines, at(7, -8)), 1)
    assert.deepEqual(turnedAwayThisMonth(db, 'prod-aputure600', at(7, -8)), {
      times: 1, units: 1,
    })

    // The vendor borrows two from a partner house. There is no sub-rent-in
    // intake: the only door is the import, which stamps ownership='owned'.
    // The partner's lights become indistinguishable from the fleet, and the
    // cost owed to the partner lands on no book. Finding `no-subrent-intake`.
    const csv = 'Item,Qty,Code\nAputure 600D Pro,2,AP600P'
    const { rows, rejected } = readRows(parseCsv(csv), { name: 0, quantity: 1, code: 2 })
    applyPlan(planImport(rows, currentCatalogue(), rejected))
    const borrowed = db.get(
      `select count(*) as n from assets a join products p on p.id = a.product_id
        where p.display_name = 'Aputure 600D Pro' and a.ownership = 'owned'`,
    )
    assert.equal(Number(borrowed.n), 8) // all eight read as owned — two are not
    finding('no-subrent-intake')

    const again = checkAvailability(
      db,
      matchKitList(parseKitList('6x Aputure 600D Pro'), demoCatalogue()),
      openJobCommitments(db),
      at(7, -6),
    )
    assert.equal(again.lines[0].state, 'available')

    // Eid loops.
    const e1 = jobOut('Eid shoot — six lights', 'cust-ayesha',
      [{ productId: 'prod-aputure600', qty: 6 }, { productId: 'prod-cstand', qty: 6 }],
      iso(7, -2), at(7, -5))
    assert.equal(e1.expected.length, 12)
    jobBack(e1.id, 'cust-ayesha', at(7, -2), { k: 7, d: -2, chargeRs: 90_000, payRs: 90_000 })
    const e2 = jobOut('Eid day 2 — family films', 'cust-hamza',
      [{ productId: 'prod-fx6', qty: 2 }, { productId: 'prod-ronin', qty: 1 }],
      iso(7, 0), at(7, -1))
    jobBack(e2.id, 'cust-hamza', at(7, 0), { k: 7, d: 0, chargeRs: 45_000, payRs: 45_000 })

    assertBooks()
    assertPhysical()
    assertNoLostScans()
    assert.equal(moneyStrip(db, at(7, 10)).earnedMonthMinor, monthCharged[7])
  })

  // -------------------------------------------------------------- MAY (k=8)
  test('MAY — the cheque bounces: correction semantics and the debt clock', () => {
    const may1 = jobOut('Drama finale — Bahria set', 'cust-imran',
      [{ productId: 'prod-komodo', qty: 1 }, { productId: 'prod-cne', qty: 1 }],
      iso(8, -1), at(8, -4))
    jobBack(may1.id, 'cust-imran', at(8, -1), { k: 8, d: -1, chargeRs: 40_000 })
    post('cust-imran', 'payment', -40_000, { k: 8, d: -1, hour: 14, note: 'Cheque 114202' })
    assert.equal(customerView(db, 'cust-imran').balanceMinor, books.get('cust-imran').balance)

    // Six days later the bank returns the cheque. The only correction is
    // the same doorless 'adjustment', and the client's statement will read
    // 'adjustment +Rs 40,000' — as if the HOUSE made an error.
    post('cust-imran', 'adjustment', 40_000, { k: 8, d: 5, note: 'Cheque 114202 bounced' })
    finding('no-adjustment-door')

    // Pinned semantics: the debt clock RESET. 'Owed since' now points at
    // the bounce, not the original charge — the book believes the debt is
    // six days younger than it is. Finding `debt-age-resets-on-bounce`.
    const entries = customerView(db, 'cust-imran').entries
    assert.equal(oldestUnpaidMs(entries), at(8, 5))
    assert.notEqual(oldestUnpaidMs(entries), at(8, -1))
    finding('debt-age-resets-on-bounce')

    const card = balanceCardText(
      {
        customerName: 'Imran Qureshi', houseName: seed.houseName,
        entries, paymentLine: null,
      },
      L,
    )
    assert.ok(card.includes(L.kindLabel('adjustment')))

    assertBooks()
    assertNoLostScans()
  })

  // -------------------------------------------------------------- JUN (k=9)
  test('JUN — the gear ages, and nothing counts the wear', () => {
    // The FX9's ledger says 3 jobs — but only because two rental charges
    // happened to carry its asset id. The SCANS know the truth: the outbox
    // holds every checkout this year, and nothing reads it for service.
    const fx9Outs = decodeScanOps(db).filter(
      (op) => op.assetId === 'asset-fx9-1' && op.eventType === 'check_out',
    )
    assert.ok(fx9Outs.length >= 3, `${fx9Outs.length} recorded checkouts`)
    assert.equal(assetEarnings(db, 'asset-fx9-1').jobs, 3)
    finding('no-service-tracking')

    // The repair itself — Rs 45,000 to the camera technician — has NOWHERE
    // to go. The ledger is customer-only; there is no expense side, so
    // "what did this camera COST me" and any profit figure are unknowable.
    finding('no-expense-book')

    const jun1 = jobOut('Session video — studio day', 'cust-sana',
      [{ productId: 'prod-c300', qty: 1 }, { productId: 'prod-mkh416', qty: 1 }],
      iso(9, 2), at(9, 0))
    jobBack(jun1.id, 'cust-sana', at(9, 2), { k: 9, d: 2, chargeRs: 26_000, payRs: 26_000 })

    assertBooks()
    assertNoLostScans()
  })

  // -------------------------------------------------------------- JUL (k=10)
  test('JUL — stocktake: how close can lookup mode get to a cycle count?', () => {
    // A retired label (peeled sticker) resolves without confidence — right.
    // But retiring it took SQL: no screen retires a tag either.
    db.exec(`update asset_tags set status = 'retired' where asset_id = 'asset-sachdeva-3'`)
    assert.equal(lookupTag(db, tagOf.get('asset-sachdeva-3')).kind, 'retired')

    // The tech walks every rack pointing the camera at labels. Lookup mode
    // answers each one and writes NOTHING — the scan-free invariant holds.
    const outboxBefore = Number(db.get(`select count(*) as n from outbox`).n)
    let found = 0
    for (const [assetId, code] of tagOf) {
      const hit = lookupTag(db, code)
      if (hit.kind === 'found') {
        assert.equal(hit.assetId, assetId)
        found++
      }
    }
    assert.equal(found, tagOf.size - 1) // all but the retired label
    assert.equal(Number(db.get(`select count(*) as n from outbox`).n), outboxBefore)

    // But a stocktake is a DIFF, and only half of it exists. The mirror
    // says these items are on the shelf:
    const hereSet = db
      .all(`select id from assets where presence = 'here'`)
      .map((r) => r.id)
    // The tech cannot find C-Stand #8 anywhere. The app still answers
    // 'here' with full confidence, and there is nowhere to record the
    // disagreement — no missing state, no count session, no discrepancy
    // list. Finding `no-cycle-count`.
    assert.ok(hereSet.includes('asset-cstand-8'))
    assert.equal(lookupTag(db, tagOf.get('asset-cstand-8')).kind, 'found')
    finding('no-cycle-count')

    assertPhysical()
    assertNoLostScans()
  })

  // -------------------------------------------------------------- AUG (k=11)
  test('AUG — year close: the owner’s annual questions, answered and unanswerable', () => {
    // One last loop so August is a real month.
    const aug1 = jobOut('Azadi spot — one day', 'cust-bilal',
      [{ productId: 'prod-fx6', qty: 1 }], iso(11, 1), at(11, 0))
    jobBack(aug1.id, 'cust-bilal', at(11, 1), { k: 11, d: 1, chargeRs: 18_000, payRs: 18_000 })

    // Q1 — "What did the year bill?" The ledger holds it to the paisa; the
    // app can only ever show ONE month at a time (see MAR).
    const sqlTotal = Number(
      db.get(
        `select sum(amount_minor) as t from customer_ledger_entries
          where kind in ('charge','late_fee','damage_charge')`,
      ).t,
    )
    const seededCharges = rs(60_000 + 45_000 + 80_000 + 55_000 + 40_000)
    const simCharges = monthCharged.reduce((a, b) => a + b, 0)
    assert.equal(sqlTotal, seededCharges + simCharges)

    // Q2 — "Who is my best client?" Lifetime value is IN the entries every
    // khata page loads, but no list ranks it; the owed list ranks debt.
    const lifetime = (id) =>
      customerView(db, id).entries
        .filter((e) => CHARGE_KINDS.has(e.kind))
        .reduce((n, e) => n + e.amountMinor, 0)
    assert.ok(lifetime('cust-bilal') > lifetime('cust-farhan'))
    finding('no-lifetime-value-view')

    // Q3 — "Who is my worst payer?" Ayesha's Rs 40,000 has been owed since
    // the seeded charge — before the pilot even began. The book knows.
    const ayeshaSince = oldestUnpaidMs(customerView(db, 'cust-ayesha').entries)
    assert.ok(ayeshaSince !== null && ayeshaSince < at(0, -10))

    // Q4 — "Which camera earned best?" Per-asset answers exist; there is no
    // fleet leaderboard, so the owner opens asset pages one by one (MAR).
    assert.ok(
      assetEarnings(db, 'asset-fx9-1').earnedMinor >
        assetEarnings(db, 'asset-fx6-1').earnedMinor,
    )

    // --- The final reconciliation -----------------------------------------
    assertBooks()
    assertPhysical()
    assertNoLostScans()

    // Still out after a year, and correctly so: Farhan's stolen FX6 and
    // lens, and October's ghost cable. The board still shows the theft red.
    const stillOut = sqlOutSet()
    assert.equal(stillOut.size, 3)
    const board = dueBoard(db, at(11, 5))
    const theft = board.outJobs.find((j) => j.label.startsWith('Music video'))
    assert.ok(theft)
    assert.equal(theft.due.state, 'overdue')
    assert.ok(theft.due.daysLate > 150, `${theft.due.daysLate} days late and counting`)

    // The money strip agrees with the hand-kept books to the paisa.
    const strip = moneyStrip(db, at(11, 5))
    const expectedOwed = [...books.values()]
      .filter((b) => b.balance > 0)
      .reduce((n, b) => n + b.balance, 0)
    assert.equal(strip.owedMinor, expectedOwed)

    // A year of scanning: several hundred ops, none lost, none phantom.
    assert.ok(countScanOps() > 240, `${countScanOps()} scan ops over the year`)
  })

  // ------------------------------------------------------------ the ledger
  test('the year’s findings are exactly the documented set', () => {
    // One id per wall the year hit. If a feature ships and a wall comes
    // down, remove its id here AND its section in docs/year-in-the-life.md.
    assert.deepEqual(
      [...FINDINGS].sort(),
      [
        'clock-welds',
        'debt-age-resets-on-bounce',
        'double-promise',
        'duplicate-asset-code',
        'import-apply-welded',
        'latefee-after-scan-zero',
        'no-add-customer',
        'no-adjustment-door',
        'no-blacklist-or-theft-export',
        'no-bookings',
        'no-close-job',
        'no-customer-on-desk-job',
        'no-cycle-count',
        'no-deposit-door',
        'no-expense-book',
        'no-health-door',
        'no-lifetime-value-view',
        'no-month-history-screen',
        'no-scan-undo',
        'no-service-tracking',
        'no-subrent-intake',
        'no-swap-flow',
        'no-terminal-asset-state',
        'no-utilization-read',
        'payback-counts-damage',
        'turnaway-blind-to-commitments',
        'waived-fee-invisible',
        'write-off-illegible',
      ],
    )
  })
})

// ---------------------------------------------------------------- utilities

/** The live products table, for a second-import plan mid-year. */
function currentCatalogue() {
  return db
    .all(`select id, display_name from products order by display_name`)
    .map((r) => ({ id: r.id, name: r.display_name ?? 'Unnamed' }))
}

let importBatch = 0

/**
 * DemoStore.applyImport, replicated for Node (finding `import-apply-welded`:
 * the real one is welded to the sql.js driver in store.ts and cannot run or
 * be reused here). Same rules: one transaction, ambiguous rows never merged,
 * serials only on single-unit rows.
 */
function applyPlan(plan) {
  const batch = ++importBatch
  let products = 0
  db.transaction(() => {
    const idFor = new Map()
    for (const { row, verdict } of plan.rows) {
      if (verdict.kind === 'rejected' || verdict.kind === 'ambiguous') continue
      let productId
      if (verdict.kind === 'existing' && !verdict.productId.startsWith('file:')) {
        productId = verdict.productId
      } else {
        const key = row.name.toLowerCase().trim()
        const already = idFor.get(key)
        if (already) {
          productId = already
        } else {
          productId = `prod-imported-${batch}-${slug(row.name)}-${products}`
          db.exec(
            `insert into products (id, org_id, display_name, category) values (?, ?, ?, ?)`,
            [productId, seed.orgId, row.name, row.category ?? 'other'],
          )
          idFor.set(key, productId)
          products++
        }
      }
      for (let i = 1; i <= row.quantity; i++) {
        const assetId = `asset-imported-${batch === 1 ? '' : `${batch}-`}${slug(row.name)}-${row.line}-${i}`
        const code = row.code ? `${row.code}-${String(i).padStart(2, '0')}` : assetId
        db.exec(
          `insert into assets
             (id, org_id, product_id, asset_code, serial_number, display_name,
              presence, health, ownership, current_location_id, current_job_id, updated_at)
           values (?, ?, ?, ?, ?, ?, 'here', 'ok', 'owned', null, null, ?)`,
          [
            assetId, seed.orgId, productId, code,
            row.quantity === 1 ? row.serial : null,
            row.name, new Date().toISOString(),
          ],
        )
        // Later imports need tags too, bound the same way the first was.
        if (batch > 1) {
          const tag = `v1SIMB${batch}${String(row.line).padStart(2, '0')}${String(i).padStart(2, '0')}AAAAAAAAAAAA`.slice(0, 24)
          db.exec(
            `insert into asset_tags (tag_code, asset_id, status) values (?, ?, 'active')`,
            [tag, assetId],
          )
          tagOf.set(assetId, tag)
        }
      }
    }
  })
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}
