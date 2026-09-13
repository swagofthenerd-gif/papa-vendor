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
 * THE CLOCK WELDS ARE GONE. Outbox.enqueue, SessionRegistry and the store's
 * money writes all take an injectable clock now, so this file drives the
 * REAL SessionRegistry on the simulated calendar and every outbox row's
 * created_at agrees with its payload's device_time. Money still posts
 * through recordEntry (the store's sql.js driver cannot load under Node),
 * but the store methods accept `whenMs`, so a payment can be backdated.
 *
 * THE SECOND YEAR (W8). The same twelve months, re-lived against the
 * finished app: the shaadi jobs are BOOKINGS first (pencil → confirm →
 * convert), quotes go out priced through the six named steps with the
 * desk's overrides and the season's multiplier, a partner's FX9 rescues a
 * truck and goes home as returned_to_owner, an extension collision is
 * settled through the substitute door, the thermal parchi's bytes are
 * built for a real job, the overdue ladder's last rung fires on the
 * chronic late payer, and a unit the ginti could not find goes STOLEN
 * with the partner broadcast in one line. The import is the real routine
 * now (applyImport lives in read-model.ts — was `import-apply-welded`).
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import {
  LOCAL_SCHEMA,
  ScanSession,
  PhotoStore,
  allocateUnitCodes,
  lookupTag,
  voidScan,
  markTerminal,
  markFound,
  swapAsset,
  cycleCountDiff,
  recordServiced,
  dueStatus,
  lateFeeDraft,
  checkAvailability,
  escalationStep,
  buildParchiEscPos,
  parchiDocFromText,
  ESCPOS_INIT,
  ESCPOS_CUT,
  HOUR_MS,
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
  localDate,
  DEFAULT_TIMEZONE,
} from '@papa/core'
import { seedDemo, demoCatalogue } from '../src/demo/seed.ts'
import {
  applyImport,
  closeJob,
  createJob,
  decodeScanOps,
  dueBoard,
  flagForManager,
  managerFlaggedAt,
  openJob,
  openJobs,
  openJobCommitments,
  packedProgress,
  sehat,
  serviceFacts,
  sessionScanFacts,
  setExpectedBack,
} from '../src/demo/read-model.ts'
import { SessionRegistry } from '../src/demo/sessions.ts'
import {
  assetEarnings,
  createCustomer,
  customerForJob,
  customersByBalance,
  customerView,
  isoDate,
  khataLabels,
  lateFeeDraftFor,
  moneyStrip,
  recordEntry,
  recordTurnedAway,
  turnedAwayByReason,
  turnedAwayThisMonth,
} from '../src/demo/khata.ts'
import {
  bookingView,
  cancelBooking,
  confirmBooking,
  convertBookingToJob,
  createBooking,
  extendBooking,
  extensionPreview,
  noteSubRent,
  reallocateReservation,
  substitutesForReservation,
} from '../src/demo/bookings.ts'
import {
  assetCosts,
  jobMargin,
  monthProfit,
  recordExpense,
} from '../src/demo/kharcha.ts'
import {
  calendarDays,
  clearCalendarDay,
  quoteFor,
  quoteForLines,
  quoteTextOf,
  setCalendarDay,
  setLineOverride,
} from '../src/demo/quotes.ts'
import { buildSummary } from '../src/session-summary.ts'
import { buildTheftReport, theftLabels } from '../src/theft-report.ts'
import { buildGintiReport, gintiLabels } from '../src/ginti-report.ts'
import { STR_EN } from '../src/strings.ts'
// --- network --- (0025): the partner doors and the parchi's crew line.
import {
  askTheMarket,
  assignAttendant,
  attendantNames,
  closeSubHire,
  partnerMoney,
  recordSubHireIn,
  recordSubHireOut,
  setPublicPhone,
  stolenBroadcast,
} from '../src/demo/network.ts'
import { buildParchi } from '../src/parchi.ts'

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

/** Expense minor units posted per simulated month — the OTHER book. The
 *  seed's own expense history sits in the real current month, before
 *  simulated month 0, so it never drifts into these windows. */
const monthSpent = new Array(12).fill(0)

/** Every kharcha line the year posts goes through here — the expense
 *  twin of post(). Returns the id so a reversal could name it. */
function spend(kind, rupees, opts) {
  const id = recordExpense(db, {
    orgId: seed.orgId,
    kind,
    amountMinor: rs(rupees),
    assetId: opts.assetId ?? null,
    jobId: opts.jobId ?? null,
    counterparty: opts.counterparty ?? null,
    note: opts.note ?? null,
    createdAt: at(opts.k, opts.d ?? 0, opts.hour ?? 12),
  })
  assert.ok(id, 'the expense wrote')
  monthSpent[opts.k] += rs(rupees)
  return id
}

/** The month's bottom line agrees with the hand-kept books to the paisa:
 *  earned − spent, both sides re-derived from the real tables. */
function assertMonthProfit(k) {
  const p = monthProfit(db, at(k, 10, 0))
  assert.equal(p.earnedMinor, monthCharged[k], `month ${k} earned`)
  assert.equal(p.spentMinor, monthSpent[k], `month ${k} spent`)
  assert.equal(p.profitMinor, monthCharged[k] - monthSpent[k], `month ${k} profit`)
}

/** Every ledger line this year posts goes through here. Returns the entry
 *  id, so a later 'reversal' can name the line it voids. */
function post(customerId, kind, rupees, opts) {
  const amountMinor = rs(rupees)
  const whenMs = at(opts.k, opts.d ?? 0, opts.hour ?? 12)
  const id = recordEntry(db, {
    orgId: seed.orgId,
    customerId,
    kind,
    amountMinor,
    jobId: opts.jobId ?? null,
    assetId: opts.assetId ?? null,
    note: opts.note ?? null,
    reversalOf: opts.reversalOf ?? null,
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
  return id
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
 * The REAL SessionRegistry, on the simulated clock. The clock welds are
 * fixed: the registry stamps session starts from its injected `now`, hands
 * the same clock to every ScanSession it opens, and the outbox stamps each
 * queued row with it — so the queue, the session record and the payloads
 * all tell one story about when a scan happened.
 */
let simNow = at(0, -10)
const registry = new SessionRegistry(
  db,
  'sim-phone',
  (jobId, mode) =>
    mode === 'out' ? (openJob(db, jobId)?.expected ?? []) : physicallyOut(jobId),
  () => simNow,
)

function openSession(jobId, mode, whenMs) {
  simNow = whenMs
  return registry.open(jobId, mode)
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

// ----------------------------------------------------- the B0 doors, real
// The year's first run did all three of these with direct SQL and pinned
// them as its #1 finding (`no-add-customer`, `no-customer-on-desk-job`,
// `no-close-job`). Phase B0 shipped the doors — createCustomer, createJob's
// customerId, closeJob — so the simulation now walks through them like a
// vendor would, and the walls are gone from the findings ledger.

/** A customer the desk typed in — the real door, with the test's id. */
function addCustomer(id, name, phone) {
  assert.equal(createCustomer(db, { id, orgId: seed.orgId, name, phone }), id)
  books.set(id, { balance: 0, deposit: 0 })
}

/** Close a finished job — refused unless everything is home, so the
 *  assertion IS the close rule holding. */
function mustClose(jobId, whenMs) {
  const closed = closeJob(db, jobId, whenMs)
  assert.deepEqual(closed, { ok: true }, `${jobId} closes once everything is home`)
}

// --- network --- ids for the partner doors, on the simulated clock.
let netSeq = 0
const netIds = (whenMs) => ({ now: () => whenMs, newId: () => `net-${++netSeq}` })

// ------------------------------------------------------------ the import
// The REAL applyImport (read-model.ts) runs under Node now, so the year
// imports through the same routine the Import screen calls — was finding
// `import-apply-welded`, whose line-for-line replica lived at the foot of
// this file. New units get labels the way the rack did in September.

/** Bind a fresh label to every imported unit that has none — the tagging
 *  afternoon after an import. Returns the ids in tagging order. */
function bindImportedTags(label, whenMs) {
  const binder = new ScanSession(db, { deviceId: 'sim-phone', now: () => whenMs })
  const untagged = db
    .all(
      `select a.id from assets a
        where a.id like 'asset-imported-%'
          and not exists (select 1 from asset_tags t where t.asset_id = a.id)
        order by a.id`,
    )
    .map((r) => r.id)
  untagged.forEach((assetId, i) => {
    const code = `v1SIM${label}${String(i + 1).padStart(2, '0')}AAAAAAAAAAAAAA`
    const r = binder.bindTag(code, assetId)
    assert.equal(r.outcome, 'accepted')
    tagOf.set(assetId, code)
    assert.equal(lookupTag(db, code).assetId, assetId)
  })
  return { binder, imported: untagged }
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
    customerId,
    wants,
  })
  assert.equal(customerForJob(db, id)?.id, customerId, 'born chargeable')
  return { id, expected: result.expected, requested: result.requested }
}

/** The common loop: create, wire, scan out everything allocated. */
function jobOut(label, customerId, wants, dueIso, whenMs, contact = null) {
  const job = makeJob(label, customerId, wants, dueIso, contact)
  const out = openSession(job.id, 'out', whenMs)
  scanAll(out, job.expected, 'check_out')
  return job
}

/** Return everything physically out on a job, then charge/pay/close —
 *  the whole dock ritual, through the real doors. */
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
    // An hour after the charge — the natural rhythm of a dock settlement.
    // (Same-millisecond ties are safe now: the book carries rowid as the
    // re-sort tie-break; pinned in khata.test.mjs.)
    post(customerId, 'payment', -money.payRs, { k, d: money.d, hour: 13, jobId, note: 'Cash' })
  }
  mustClose(jobId, whenMs)
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

    // The REAL routine, on the simulated clock (was `import-apply-welded`:
    // applyImport used to live in store.ts beside the sql.js driver, and
    // this file carried a replica). It reports what it made — and that
    // three sticker codes were renumbered past the shelf's: the FX9 and
    // both Aputures (see the next block for why that matters).
    assert.deepEqual(applyImport(db, seed.orgId, plan, at(0, -4)), { products: 2, units: 8, renumbered: 3 })

    // The demo seeds a placeholder Eid at ×1.25 (ASSUMPTION #demo-eid);
    // Eid moves, so the desk clears it on day one and types the real one
    // when the date is known (APR). It also keeps the year's quotes from
    // depending on which real month the run happens to start in.
    for (const d of calendarDays(db).filter((d) => d.kind === 'holiday')) {
      assert.equal(clearCalendarDay(db, d.day, d.kind, at(0, -4)), true)
    }

    // The import used to give the new FX9 unit the code FX9-01 — the SAME
    // visible code as the seeded FX9-01, so two cameras answered to one
    // sticker in manual search. Fixed: allocateUnitCodes collision-checks
    // the file's codes against the shelf and CONTINUES numbering, so the
    // imported unit lands as FX9-03 and every visible code stays unique.
    const dupes = db.get(
      `select count(*) as n from assets where asset_code = 'FX9-01'`,
    )
    assert.equal(Number(dupes.n), 1)
    const importedFx9 = db.get(
      `select asset_code from assets
        where id like 'asset-imported-%' and display_name = 'Sony FX9'`,
    )
    assert.equal(importedFx9.asset_code, 'FX9-03')

    // --- Tagging the imported rack ----------------------------------------
    const { binder, imported } = bindImportedTags('SEP', at(0, -3))
    assert.equal(imported.length, 8)
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

    // The clock welds are gone: the registry's session record AND the
    // outbox row both carry the simulated instant, not the machine's —
    // so the hisaab's day grouping and the asset history tell one story.
    assert.equal(
      Number(db.get(`select started_at from scan_sessions where id = ?`, [shan.session.id]).started_at),
      at(0, -1, 6),
    )
    assert.equal(
      Number(db.get(`select created_at from outbox where op = 'submit_scan_batch' order by seq desc limit 1`).created_at),
      at(0, -1, 6),
    )

    // --- Second job out: the wedding, through the calendar ----------------
    // The seed promises V-Mount batteries 1-4 to BOTH the TVC and the
    // wedding. The year's first run pinned that as `double-promise`: with
    // no reservations, "first N units on the shelf" was the only allocator
    // anyone had, and the wedding truck left with four 'Not on this job'
    // rows. Now the promise lives on the calendar (0022): the TVC's four
    // batteries are HELD by name for its day, so the wedding's confirm
    // allocates around them — the other four leave, and every row is
    // accepted. The seeded wedding job, with its stale list, is closed
    // unused; the truck runs on the booking's job — and the booking is a
    // PENCIL first: Hamza's agency says "hold it", the desk holds it for
    // the 24h TTL (ASSUMPTION #hold-ttl), the deposit lands, the desk
    // confirms, and only then does a truck exist.
    const tvcHold = createBooking(db, seed.orgId, {
      customerId: 'cust-bilal', startMs: at(0, -1, 6), endMs: at(0, 0, 18),
      lines: ['asset-vmount-1', 'asset-vmount-2', 'asset-vmount-3', 'asset-vmount-4'].map((assetId) => ({ assetId })),
      status: 'confirmed', note: 'TVC batteries, by name',
    }, at(0, -2, 10))
    assert.equal(tvcHold.ok, true, 'the TVC hold confirms')
    const wedBooking = createBooking(db, seed.orgId, {
      customerId: 'cust-hamza', startMs: at(0, -1, 13), endMs: at(0, 2, 19),
      lines: [
        { productId: 'prod-fx6', qty: 2 }, { productId: 'prod-sigma50100', qty: 1 },
        { productId: 'prod-ronin', qty: 1 }, { productId: 'prod-vmount', qty: 4 },
        { productId: 'prod-sachdeva', qty: 2 }, { productId: 'prod-aputure300', qty: 1 },
      ],
      status: 'pencil', note: 'Wedding — Gulberg',
    }, at(0, -2, 9))
    assert.equal(wedBooking.ok, true, 'the pencil is held')
    assert.equal(wedBooking.status, 'pencil')
    assert.equal(wedBooking.pencilExpiresAtMs, at(0, -2, 9) + 24 * HOUR_MS, 'the 24h TTL, from the desk clock')
    assert.equal(bookingView(db, wedBooking.bookingId, at(0, -2, 10)).stamp, 'pencil')
    assert.equal(bookingView(db, wedBooking.bookingId, at(0, -2, 10)).assetReservations.length, 0, 'a pencil on products claims no unit yet')
    const wedConfirm = confirmBooking(db, seed.orgId, wedBooking.bookingId, {}, at(0, -2, 11))
    assert.equal(wedConfirm.ok, true, 'the wedding confirms around the hold')
    assert.equal(wedConfirm.credentialGate, 'not_needed', 'Hamza is verified')
    assert.equal(bookingView(db, wedBooking.bookingId, at(0, -2, 12)).stamp, 'confirmed')
    assert.deepEqual(
      db.all(`select op from outbox where payload like ? order by seq`, [`%"${wedBooking.bookingId}"%`]).map((r) => r.op),
      ['create_booking', 'confirm_booking'],
      'two ops, the way the server insists',
    )
    const wedUnits = wedConfirm.allocations.map((a) => a.assetId)
    assert.equal(wedUnits.length, 11)
    assert.ok(
      !wedUnits.some((id) => ['asset-vmount-1', 'asset-vmount-2', 'asset-vmount-3', 'asset-vmount-4'].includes(id)),
      'the calendar gave the wedding the OTHER batteries',
    )
    // --- The wedding is QUOTED before it leaves (0024 on the phone) ------
    // 3d 6h → 4 calendar days → a 4-day remainder is capped at the 3-day
    // week: 3 billable days (a remainder never costs more than the week it
    // almost is) over the card: FX6 ×2 at 18,000, the 50-100 at 9,000, the
    // Ronin at 8,000, four batteries at 1,500, the 300X at 7,000 — and the
    // Sachdeva line UNPRICED, counted, never zero. Hamza haggles at the
    // desk; the owner gives the FX6s at 15,000 with the reason kept, the
    // card rate remembered beside it, and the total moves by exactly
    // 2 × 3 × 3,000.
    const wedQuote = quoteFor(db, wedBooking.bookingId)
    assert.equal(wedQuote.steps.billableDays.calendarDays, 4)
    assert.equal(wedQuote.steps.weekRule.billableDays, 3)
    assert.equal(wedQuote.totals.subtotalMinor, rs(3 * (36_000 + 9_000 + 8_000 + 6_000 + 7_000)))
    assert.equal(wedQuote.totals.unpricedCount, 1)
    assert.equal(wedQuote.totals.indicative, true, 'an unpriced line keeps a confirmed booking indicative')
    const fx6Line = wedQuote.lines.find((l) => l.productId === 'prod-fx6')
    const walkIn = setLineOverride(db, fx6Line.lineId, rs(15_000), 'Hamza — regular, agreed at the desk', at(0, -2, 11))
    assert.equal(walkIn.ok, true)
    assert.equal(walkIn.originalRateMinor, rs(18_000))
    const wedQuote2 = quoteFor(db, wedBooking.bookingId)
    assert.equal(wedQuote2.totals.subtotalMinor, rs(3 * (30_000 + 9_000 + 8_000 + 6_000 + 7_000)))
    assert.equal(wedQuote2.totals.overriddenCount, 1)
    assert.equal(wedQuote2.lines.find((l) => l.productId === 'prod-fx6').override.reason, 'Hamza — regular, agreed at the desk')
    assert.equal(
      db.get(`select count(*) as n from outbox where op = 'set_line_rate_override'`).n, 1,
      'the override is queued as the server\'s op',
    )

    const wedJob = convertBookingToJob(db, seed.orgId, wedBooking.bookingId, at(0, -1, 12))
    assert.equal(wedJob.ok, true)
    assert.equal(wedJob.expected, 11, 'the job promises exactly the units confirm bound')
    mustClose('job-wedding', at(0, -1, 12)) // the seeded duplicate list, never used
    const wed = openSession(wedJob.jobId, 'out', at(0, -1, 13))
    const overlap = wed.expected.filter((id) => outTracker.has(id))
    assert.deepEqual(overlap, [], 'nothing on the wedding list is on the TVC truck')
    scanAll(wed, wed.expected, 'check_out')
    // The ring counts the whole list: no off-list swap, no wolf-crying.
    assert.equal(packedProgress(db, wedJob.jobId), 11)
    const wedSummary = buildSummary({
      jobLabel: 'Wedding', mode: 'out',
      expected: wed.expected,
      recorded: wed.session.scannedIds,
      assumed: [], unknownTags: [],
      facts: () => undefined,
    })
    assert.equal(wedSummary.scanned, 11)
    assert.equal(wedSummary.missing.length, 0)
    assert.equal(wedSummary.exceptions.length, 0)

    // 11 TVC + 11 wedding + 1 pre-existing (FX6-03 on the documentary).
    assertPhysical()
    assert.equal(sqlOutSet().size, 23)

    // --- The TVC comes home on time ---------------------------------------
    assert.equal(dueStatus(iso(0, 0), at(0, 0, 18)).state, 'due_today')
    const shanBack = openSession('job-shan', 'in', at(0, 0, 18))
    assert.equal(shanBack.expected.length, 11)
    scanAll(shanBack, shanBack.expected, 'check_in')
    // Done — and closed, through the real door (was `no-close-job`).
    mustClose('job-shan', at(0, 0, 18))

    // --- First payments ---------------------------------------------------
    post('cust-bilal', 'payment', -25_000, { k: 0, d: 2, note: 'JazzCash' })
    post('cust-ayesha', 'payment', -15_000, { k: 0, d: 2, note: 'Cash' })
    // Imran's cheque, held since the drama shoot, is released after
    // inspection. The ledger kind exists; no screen writes it (see DEC).
    post('cust-imran', 'deposit_refund', -50_000, { k: 0, d: 2, note: 'Cheque returned' })

    // --- The wedding comes home a day early -------------------------------
    jobBack(wedJob.jobId, 'cust-hamza', at(0, 2, 19), {
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

    // Everything is home, but until the desk actually CLOSES the job it
    // keeps claiming its promised set in every availability answer — an
    // open job's promise is a promise. One tap ends it, and the ghost
    // leaves the enquiry screen with it (was the `no-close-job` wall; now
    // the designed behaviour, pinned end to end).
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
      'an open finished job still claims its set',
    )
    assert.match(availabilityNote(c300), /going to Documentary/)
    mustClose('job-doc', at(0, 6, 13))
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

    // A job made at the desk is born WITH its customer now — makeJob
    // asserts the khata link on every creation (was
    // `no-customer-on-desk-job`, the year's #1 wall). The nephew case
    // stays legal: createJob without customerId still works, pinned in
    // create-job.test.mjs.
    const o1 = makeJob('Corporate shoot — Gulberg', 'cust-farhan',
      [{ productId: 'prod-fx6', qty: 2 }, { productId: 'prod-xlr', qty: 4 }],
      iso(1, -4), 'Farhan 0301 5544332')
    const o1out = openSession(o1.id, 'out', at(1, -9))
    scanAll(o1out, o1.expected, 'check_out')

    // --- The lost cable ---------------------------------------------------
    const o1back = openSession(o1.id, 'in', at(1, -4))
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
    post('cust-farhan', 'charge', 40_000, { k: 1, d: -4, jobId: o1.id, note: '2x FX6 + cables, 5 days' })
    post('cust-farhan', 'damage_charge', 8_000, {
      k: 1, d: -4, jobId: o1.id, assetId: missingCable, note: 'XLR not returned',
    })
    post('cust-farhan', 'payment', -40_000, { k: 1, d: -4, note: 'Cash' })
    // The replacement cable is BOUGHT — and the buying lands on a book:
    // a purchase expense, counterparty and all (the expense side shipped;
    // was part of `no-expense-book`).
    spend('purchase', 1_500, {
      k: 1, d: -3, counterparty: 'Hall Road', note: 'Replacement XLR 5m',
    })
    // The cable was paid for — but it is still presence='out' on this job,
    // so the CLOSE RULE refuses first: a job cannot end while its projection
    // says gear is at the client's. The refusal is right.
    const refused = closeJob(db, o1.id, at(1, -4, 13))
    assert.deepEqual(refused, { ok: false, reason: 'still_out', stillOut: 1 })
    assert.ok(sqlOutSet().has(missingCable))

    // NOW the terminal state exists (0020, was `no-terminal-asset-state`):
    // the owner marks the paid-for cable LOST — it leaves the fleet, off the
    // job, in one append-only event — and the job closes at last. The ghost
    // that used to sit on the board from October to year-end is gone.
    const lost = markTerminal(db, {
      assetId: missingCable, disposition: 'lost',
      note: 'Client paid the damage; cable never came back', now: () => at(1, -4, 13),
    })
    assert.ok(lost.outboxId)
    expectedScanOps++
    outTracker.delete(missingCable)
    const goneCable = db.get(
      `select presence, disposition, current_job_id from assets where id = ?`,
      [missingCable],
    )
    assert.equal(goneCable.presence, 'gone')
    assert.equal(goneCable.disposition, 'lost')
    assert.equal(goneCable.current_job_id, null)
    mustClose(o1.id, at(1, -4, 14))

    // --- The lookbook is QUOTED first (0024): the golden math, an override
    // Sana's DP pastes the list; the desk pencils it and the quote prices
    // it through the six named steps: 10d 6h → 11 calendar days → one
    // 3-day week plus a remainder capped at the week = 6 billable days,
    // Komodo 20,000 + Ronin 8,000 on the card. Sana asks for the Komodo at
    // 17,000; the override is the FINAL day rate (ASSUMPTION
    // #override-final), the reason kept, the card rate remembered beside
    // it, and the total moves by exactly 6 × 3,000. She is new, so the
    // confirm logs the manager's override of the credential gate; then the
    // booking becomes the job the truck runs.
    const o2Booking = createBooking(db, seed.orgId, {
      customerId: 'cust-sana', startMs: at(1, -8), endMs: at(1, 2, 18),
      lines: [{ productId: 'prod-komodo', qty: 1 }, { productId: 'prod-ronin', qty: 1 }],
      status: 'pencil', note: 'Fashion lookbook — Model Town',
    }, at(1, -9, 10))
    assert.equal(o2Booking.ok, true)
    const o2Quote = quoteFor(db, o2Booking.bookingId)
    assert.equal(o2Quote.steps.billableDays.calendarDays, 11)
    assert.deepEqual(
      [o2Quote.steps.weekRule.weeks, o2Quote.steps.weekRule.remainderDays, o2Quote.steps.weekRule.remainderBilled, o2Quote.steps.weekRule.billableDays],
      [1, 4, 3, 6],
    )
    assert.equal(o2Quote.totals.subtotalMinor, rs(6 * (20_000 + 8_000)))
    assert.equal(o2Quote.totals.unpricedCount, 0)
    assert.deepEqual(o2Quote.totals.indicativeReasons, ['not_confirmed'], 'a pencil is indicative for one reason only')
    const komodoLine = o2Quote.lines.find((l) => l.productId === 'prod-komodo')
    const haggled = setLineOverride(db, komodoLine.lineId, rs(17_000), 'Sana — lookbook budget, agreed', at(1, -9, 11))
    assert.equal(haggled.ok, true)
    assert.equal(haggled.originalRateMinor, rs(20_000))
    const o2Quote2 = quoteFor(db, o2Booking.bookingId)
    assert.equal(o2Quote2.totals.subtotalMinor, rs(6 * (17_000 + 8_000)))
    assert.equal(o2Quote2.totals.overriddenCount, 1)
    assert.equal(o2Quote2.lines.find((l) => l.productId === 'prod-komodo').multiplierApplied, false, 'an override never takes a multiplier')
    const o2Confirm = confirmBooking(db, seed.orgId, o2Booking.bookingId, { credentialOverrideNote: 'Cheque held — Sana is new' }, at(1, -9, 12))
    assert.equal(o2Confirm.ok, true)
    assert.equal(o2Confirm.credentialGate, 'overridden')
    assert.equal(quoteFor(db, o2Booking.bookingId).totals.indicative, false, 'confirmed and every line priced: the number is final')
    const o2Text = quoteTextOf(db, STR_EN, seed.houseName, quoteFor(db, o2Booking.bookingId)).split('\n')
    assert.equal(o2Text[3], '6 billable days (11 on the calendar)')
    assert.equal(o2Text[5], 'RED Komodo 6K × 1 · 6 days · Rs 17,000/day = Rs 102,000')
    assert.ok(o2Text.includes('Total: Rs 150,000'))
    const o2Convert = convertBookingToJob(db, seed.orgId, o2Booking.bookingId, at(1, -8, 5))
    assert.equal(o2Convert.ok, true)
    const o2 = { id: o2Convert.jobId, expected: openJob(db, o2Convert.jobId).expected }
    assert.equal(o2.expected.length, 2, 'the job promises exactly the units confirm bound')
    assert.equal(customerForJob(db, o2.id)?.id, 'cust-sana', 'born chargeable')

    // --- The first late fee, and the order-of-operations trap -------------
    const o2out = openSession(o2.id, 'out', at(1, -8))
    scanAll(o2out, o2.expected, 'check_out')

    const o2due = dueStatus(iso(1, 2), at(1, 5))
    assert.equal(o2due.daysLate, 3)
    // The charge sheet's draft with the gear still out: 3 days × the
    // Komodo + Ronin day rates = Rs 84,000.
    const draftBefore = lateFeeDraftFor(db, o2.id, at(1, 5))
    assert.equal(draftBefore.daysLate, 3)
    assert.equal(draftBefore.draft.totalMinor, rs(84_000))

    const o2back = openSession(o2.id, 'in', at(1, 5))
    scanAll(o2back, o2back.expected, 'check_in')

    // Same sheet opened AFTER the tech scanned the gear in — the natural
    // dock order. The draft HOLDS: it prices what came back in the return
    // session and dates the fee from the return scan, not from the
    // shortfall that just healed, so the desk sees the same Rs 84,000 an
    // hour later. (Was finding `latefee-after-scan-zero`.)
    const draftAfter = lateFeeDraftFor(db, o2.id, at(1, 5, 14))
    assert.equal(draftAfter.daysLate, 3)
    assert.equal(draftAfter.draft.totalMinor, rs(84_000))
    assert.equal(draftAfter.draft.priced, 2)
    assert.notEqual(moneyLabel(draftAfter.draft), null)

    post('cust-sana', 'charge', 55_000, { k: 1, d: 5, jobId: o2.id, note: 'Komodo + Ronin, 3 days' })
    post('cust-sana', 'late_fee', 15_000, { k: 1, d: 5, jobId: o2.id, note: '3 days late — reduced' })
    post('cust-sana', 'payment', -70_000, { k: 1, d: 5, note: 'Bank transfer' })
    mustClose(o2.id, at(1, 5, 15))

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
    assert.equal(sqlOutSet().size, 0) // the cable is GONE, not a ghost 'out'
    const strip = moneyStrip(db, at(1, 9))
    assert.equal(strip.earnedMonthMinor, monthCharged[1])
    assert.equal(monthCharged[1], rs(40_000 + 8_000 + 55_000 + 15_000 + 25_000 + 28_000 + 30_000 + 12_000))
    assert.equal(books.get('cust-farhan').balance, rs(8_000))
    assert.equal(books.get('cust-bilal').balance, rs(78_000))
    assertMonthProfit(1)
  })

  // -------------------------------------------------------------- NOV (k=2)
  test('NOV — three clients want the same camera; a new tech learns to scan', () => {
    // --- The double promise, now IMPOSSIBLE --------------------------------
    // Two clients want FX9s for the same weekend. Bilal books first and
    // his confirm binds two bodies. Sana's DP wants one of THOSE bodies by
    // name; her confirm is refused BY NAME — 'already promised to booking
    // #N (Bilal Hussain)' — and her pencil stands. The desk substitutes:
    // Bilal's claim on that body moves to the third FX9, Sana's confirm
    // goes through on the one she asked for, and both trucks leave with
    // different cameras. (Was `double-promise` and `no-bookings`.)
    const b1 = createBooking(db, seed.orgId, {
      customerId: 'cust-bilal', startMs: at(2, 2, 6), endMs: at(2, 4, 18),
      lines: [{ productId: 'prod-fx9', qty: 2 }], status: 'confirmed', note: 'Shaadi — Bahria',
    }, at(2, 0, 10))
    assert.equal(b1.ok, true)
    assert.equal(b1.confirm.allocations.length, 2)
    const wantedBody = b1.confirm.allocations[0]
    const b2 = createBooking(db, seed.orgId, {
      customerId: 'cust-sana', startMs: at(2, 2, 7), endMs: at(2, 5, 18),
      lines: [{ assetId: wantedBody.assetId }], status: 'confirmed', note: 'Shaadi — Wapda Town',
      credentialOverrideNote: 'Cheque held at the desk',
    }, at(2, 0, 13))
    assert.equal(b2.ok, false)
    assert.ok('collision' in b2, 'refused as a named collision, never a raw error')
    assert.equal(b2.collision.bookingNo, b1.bookingNo)
    assert.equal(b2.collision.customerName, 'Bilal Hussain')
    assert.equal(b2.collision.assetCode, wantedBody.assetCode)
    assert.equal(bookingView(db, b2.bookingId, at(2, 0, 13)).stamp, 'pencil', 'her pencil stands')
    // The substitute door (reallocate_reservation): Bilal keeps two FX9s,
    // just not that one. The third body is the only free unit for his
    // dates, and it is exactly what the picker offers.
    const bilalClaim = db.get(
      `select id from asset_reservations where booking_id = ? and asset_id = ?`,
      [b1.bookingId, wantedBody.assetId],
    )
    const offered = substitutesForReservation(db, bilalClaim.id)
    assert.equal(offered.length, 1)
    const moved = reallocateReservation(db, bilalClaim.id, offered[0].id, at(2, 0, 14))
    assert.equal(moved.ok, true)
    const b2c = confirmBooking(db, seed.orgId, b2.bookingId, { credentialOverrideNote: 'Cheque held at the desk' }, at(2, 0, 15))
    assert.equal(b2c.ok, true)
    assert.equal(b2c.credentialGate, 'overridden', 'Sana is new; the manager logged why')
    assert.deepEqual(b2c.allocations.map((a) => a.assetId), [wantedBody.assetId])
    const bilalUnits = bookingView(db, b1.bookingId, at(2, 0, 15)).assetReservations.map((r) => r.assetId)
    assert.ok(!bilalUnits.includes(wantedBody.assetId), 'Bilal no longer holds the body Sana asked for')

    // --- The third client, and the demand log that now SEES commitments ---
    // On the shelf all three FX9s are here, so a dateless answer is
    // 'available'. Asked WITH the weekend's dates, the answer subtracts
    // the three confirmed claims: none free — and recordTurnedAway counts
    // the refusal as COMMITTED demand, which is precisely the wedding-
    // season signal the buy log was built for. (Was
    // `turnaway-blind-to-commitments`.)
    const enquiry = checkAvailability(
      db,
      matchKitList(parseKitList('2x Sony FX9'), demoCatalogue()),
      openJobCommitments(db),
      at(2, 1),
      { startMs: at(2, 2, 8), endMs: at(2, 4, 12) },
    )
    assert.equal(enquiry.lines[0].onHand, 3)
    assert.equal(enquiry.lines[0].confirmedOverlap, 3)
    assert.equal(enquiry.lines[0].state, 'none')
    assert.equal(enquiry.lines[0].shortReason, 'committed')
    assert.equal(recordTurnedAway(db, enquiry.lines, at(2, 1)), 1)
    assert.deepEqual(turnedAwayThisMonth(db, 'prod-fx9', at(2, 1)), { times: 1, units: 2 })
    assert.deepEqual(turnedAwayByReason(db, 'prod-fx9', at(2, 1)), { short: 0, committed: 2 })

    // Both trucks leave — with different FX9s, every row accepted.
    const n1 = { id: convertBookingToJob(db, seed.orgId, b1.bookingId, at(2, 2, 5)).jobId }
    const n2 = { id: convertBookingToJob(db, seed.orgId, b2.bookingId, at(2, 2, 5)).jobId }
    n1.expected = openJob(db, n1.id).expected
    n2.expected = openJob(db, n2.id).expected
    assert.equal(n1.expected.length, 2)
    assert.equal(n2.expected.length, 1)
    assert.ok(!n1.expected.some((id) => n2.expected.includes(id)), 'no unit promised to two jobs')
    assert.equal(customerForJob(db, n1.id)?.id, 'cust-bilal', 'born chargeable')
    const n1out = openSession(n1.id, 'out', at(2, 2, 6))
    scanAll(n1out, n1.expected, 'check_out')
    const n2out = openSession(n2.id, 'out', at(2, 2, 7))
    scanAll(n2out, n2.expected, 'check_out')
    assert.equal(
      db.get(`select count(*) as n from assets where product_id = 'prod-fx9' and presence = 'out'`).n,
      3,
      'all three FX9s out, on two trucks',
    )

    jobBack(n1.id, 'cust-bilal', at(2, 6), { k: 2, d: 6, chargeRs: 50_000, payRs: 50_000 })
    jobBack(n2.id, 'cust-sana', at(2, 7), { k: 2, d: 7, chargeRs: 25_000, payRs: 25_000 })

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

    // --- The wrong-job scan, and the undo that now exists -----------------
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
    // ONE op undoes it: void_scan names the wrong op and queues behind it.
    // The queue stays append-only — the wrong row keeps its place — but
    // the projection re-derives from what remains and every history reader
    // skips the voided op: no fabricated round-trip, no phantom repair.
    // (Was finding `no-scan-undo`.)
    const undone = voidScan(db, wrong.outboxId, { now: () => at(2, 8, 10) })
    assert.equal(undone.outcome, 'voided')
    const restored = db.get(
      `select current_job_id as j, presence as p from assets where id = ?`,
      [c500],
    )
    assert.equal(restored.j, n4.id, 'back on the job it really left on')
    assert.equal(restored.p, 'out')
    // The camera's history holds NO trace of the interview job — and no
    // false check_in/check_out pair invented to repair the mistake.
    const c500Story = decodeScanOps(db).filter((op) => op.assetId === c500)
    assert.ok(c500Story.every((op) => op.jobId !== n3.id))
    assert.equal(c500Story.length, 1) // the one true checkout

    jobBack(n3.id, 'cust-hamza', at(2, 12), { k: 2, d: 12, chargeRs: 20_000, payRs: 20_000 })
    jobBack(n4.id, 'cust-sana', at(2, 12), { k: 2, d: 12, chargeRs: 22_000, payRs: 22_000 })

    // --- The crisis-day swap, for real (was `no-swap-flow`) ----------------
    // A V-Mount dies on set mid-shoot; the client needs a live one NOW. The
    // desk swaps a fresh battery onto the SAME job in one flow: the dead one
    // comes home and is flagged, the substitute goes out on the job, and the
    // rental stays one job's story — no faked second job splitting the charge
    // and orphaning the evidence (the wall JAN used to hit). Three linked
    // events in one session, through the real swapAsset door.
    const swapJob = makeJob('Corporate AV — Mall Road', 'cust-hamza',
      [{ productId: 'prod-vmount', qty: 3 }], iso(2, 10))
    const swapOut = openSession(swapJob.id, 'out', at(2, 9, 6))
    scanAll(swapOut, swapJob.expected, 'check_out')

    const deadBattery = swapJob.expected[0]
    const spareBattery = db.get(
      `select id from assets
        where product_id = 'prod-vmount' and presence = 'here' and health = 'ok'
        order by asset_code limit 1`,
    ).id
    const swap = swapAsset(db, {
      jobId: swapJob.id, brokenAssetId: deadBattery, substituteAssetId: spareBattery,
      note: 'Battery died on set', now: () => at(2, 9, 10),
    })
    assert.equal(swap.outcome, 'swapped')
    expectedScanOps += 3 // check_in + flag + check_out, all real ops
    outTracker.delete(deadBattery)
    outTracker.add(spareBattery)

    // The substitute is out on the SAME job; the dead one is home and flagged.
    assert.equal(
      db.get(`select current_job_id as j from assets where id = ?`, [spareBattery]).j,
      swapJob.id,
    )
    const deadRow = db.get(
      `select presence, current_job_id, health from assets where id = ?`,
      [deadBattery],
    )
    assert.equal(deadRow.presence, 'here')
    assert.equal(deadRow.current_job_id, null)
    assert.equal(deadRow.health, 'quarantined')
    // All three movements carry one session id — the swap reads as one act,
    // not three loose scans (the JAN fake could never link them).
    const swapSession = new Set(
      db
        .all(`select payload from outbox where op = 'submit_scan_batch'`)
        .map((r) => JSON.parse(r.payload))
        .filter((p) => p.swap && (p.asset_id === deadBattery || p.asset_id === spareBattery))
        .map((p) => p.session_id),
    )
    assert.equal(swapSession.size, 1)

    jobBack(swapJob.id, 'cust-hamza', at(2, 10), { k: 2, d: 10, chargeRs: 15_000, payRs: 15_000 })

    // --- Month end --------------------------------------------------------
    assertBooks()
    assertPhysical()
    assertNoLostScans()
    const strip = moneyStrip(db, at(2, 13))
    assert.equal(strip.earnedMonthMinor, monthCharged[2])
    assert.equal(monthCharged[2], rs(50_000 + 25_000 + 20_000 + 22_000 + 15_000))
  })

  // --- network --- (0025) ---------------------------------------- NOV, cont.
  test('NOV — the network: a borrowed FX9 rescues a third shaadi truck and goes home as returned_to_owner', () => {
    // A third shaadi wants one more FX9 than the house owns. The shelf says
    // short; the desk asks the market — one message, the shortage named.
    const ask4 = () => checkAvailability(
      db, matchKitList(parseKitList('4x Sony FX9'), demoCatalogue()), openJobCommitments(db), at(2, 7, 18),
    )
    assert.equal(ask4().lines[0].onHand, 3)
    assert.equal(ask4().lines[0].state, 'short')
    const askText = askTheMarket(
      db,
      [{ productId: 'prod-fx9', productName: 'Sony FX9', qty: 1, fromMs: at(2, 9, 6), untilMs: at(2, 11, 18) }],
      seed.houseName,
      'en',
    )
    assert.match(askText, /^Ravi Light & Grip — looking for gear\n\n1 x Sony FX9 · /)

    // The truck the loaner will ride: born first, so the sub-hire's cost
    // lands on ITS margin (the job_margin / booking_sub_hire_cost line).
    const shaadi = makeJob('Shaadi — Gulberg', 'cust-hamza', [{ productId: 'prod-fx9', qty: 1 }], iso(2, 11))

    // Kamran says yes. With a serial the loaner joins the fleet as
    // BORROWED, with a local code after the imported FX9-03, and its cost
    // rides the kharcha book in Kamran's name.
    const loan = recordSubHireIn(db, seed.orgId, {
      partnerId: 'partner-kamran', productId: 'prod-fx9',
      startMs: at(2, 9, 6), endMs: at(2, 11, 18),
      serial: 'KR-FX9-0042', agreedCostMinor: rs(30_000), jobId: shaadi.id, note: 'Shaadi weekend',
    }, at(2, 8), netIds(at(2, 8)))
    assert.equal(loan.ok, true)
    assert.equal(loan.assetCode, 'FX9-04')
    monthSpent[2] += rs(30_000)
    assert.equal(jobMargin(db, shaadi.id).expenseMinor, rs(30_000))
    assert.equal(
      db.get(`select ownership from assets where id = ?`, [loan.assetId]).ownership,
      'sub_rented_in',
    )
    // A label on it, and the shelf count says four.
    const loanTag = 'v1LOANERFX9KAMRAN0000001'
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values (?, ?, 'active')`, [loanTag, loan.assetId])
    tagOf.set(loan.assetId, loanTag)
    assert.equal(ask4().lines[0].onHand, 4)
    assert.equal(ask4().lines[0].state, 'available')

    // Crew on the truck — and the parchi says who went with the kit.
    assert.deepEqual(assignAttendant(db, seed.orgId, shaadi.id, 'user-usman', 'attendant', at(2, 8), netIds(at(2, 8))).attendantNames, ['Usman'])
    assert.deepEqual(assignAttendant(db, seed.orgId, shaadi.id, 'user-danish', 'driver', at(2, 8), netIds(at(2, 8))).attendantNames, ['Usman', 'Danish'])
    assert.deepEqual(openJob(db, shaadi.id).attendantNames, ['Usman', 'Danish'])

    // The truck leaves: the owned FX9 on the list, the loaner as the extra
    // the desk added at the dock — recorded, not refused.
    const out = openSession(shaadi.id, 'out', at(2, 9, 6))
    scanAll(out, shaadi.expected, 'check_out')
    scanAll(out, [loan.assetId], 'check_out', ['unexpected'])
    assert.equal(db.get(`select current_job_id as j from assets where id = ?`, [loan.assetId]).j, shaadi.id)
    const parchi = buildParchi({
      houseName: seed.houseName, jobLabel: 'Shaadi — Gulberg', mode: 'out', whenMs: at(2, 9, 6),
      items: [...shaadi.expected, loan.assetId].map((id) => {
        const r = db.get(`select asset_code from assets where id = ?`, [id])
        return { code: r.asset_code, name: 'Sony FX9' }
      }),
      assumedCount: 0, shortfall: [], shortfallValueLabel: null,
      attendants: attendantNames(db, shaadi.id),
    })
    assert.match(parchi, /\nWith: Usman, Danish\n\nOUT \(2\):\n/)
    assert.match(parchi, /FX9-04 {2}Sony FX9/)

    // It cannot go home while it is out on a job.
    assert.deepEqual(closeSubHire(db, loan.subHireId, at(2, 10), at(2, 10), netIds(at(2, 10))), { ok: false, reason: 'unit_out' })

    // Back, charged, closed — then home to Kamran: gone + returned_to_owner
    // through the plain retire verb, and the Gone filter's word is never
    // 'retired' (ASSUMPTION #returned-to-owner).
    jobBack(shaadi.id, 'cust-hamza', at(2, 11, 20), { k: 2, d: 11, chargeRs: 45_000, payRs: 45_000 })
    const home = closeSubHire(db, loan.subHireId, at(2, 12), at(2, 12), netIds(at(2, 12)))
    assert.deepEqual(home, { ok: true, jobClosed: false, returnedToOwner: true })
    expectedScanOps++ // the retire event
    const row = db.get(`select presence, disposition, current_job_id from assets where id = ?`, [loan.assetId])
    assert.equal(row.presence, 'gone')
    assert.equal(row.disposition, 'returned_to_owner')
    assert.equal(row.current_job_id, null)
    assert.equal(STR_EN.fleetDispositionWord('returned_to_owner'), 'returned to owner')
    assert.notEqual(STR_EN.fleetDispositionWord('returned_to_owner'), STR_EN.fleetDispositionWord('retired'))
    assert.equal(Number(db.get(`select count(*) as n from assets where disposition = 'retired'`).n), 0)
    assert.equal(ask4().lines[0].onHand, 3, 'the loaner is out of the fleet count')
    assert.equal(partnerMoney(db, 'partner-kamran').weOweMinor, rs(30_000))

    assertBooks()
    assertPhysical()
    assertNoLostScans()
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
        mustClose(job.id, at(3, backD))
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

    // --- The last week of peak is already promised ------------------------
    // Hamza's confirmed booking holds two FX9s for the month's last week.
    // A new client asks for two over the same dates: the shelf has three,
    // the calendar has one free — the desk turns them away and the log
    // counts it as COMMITTED demand, the buy signal (was
    // `turnaway-blind-to-commitments`).
    const peakHold = createBooking(db, seed.orgId, {
      customerId: 'cust-hamza', startMs: at(3, 8, 9), endMs: at(3, 10, 18),
      lines: [{ productId: 'prod-fx9', qty: 2 }], status: 'confirmed',
    }, at(3, 5, 10))
    assert.equal(peakHold.ok, true)
    const peakAsk = checkAvailability(
      db,
      matchKitList(parseKitList('2x Sony FX9'), demoCatalogue()),
      openJobCommitments(db),
      at(3, 6),
      { startMs: at(3, 8, 9), endMs: at(3, 10, 18) },
    )
    assert.equal(peakAsk.lines[0].onHand, 3)
    assert.equal(peakAsk.lines[0].confirmedOverlap, 2)
    assert.equal(peakAsk.lines[0].state, 'short')
    assert.equal(peakAsk.lines[0].shortReason, 'committed')
    assert.equal(recordTurnedAway(db, peakAsk.lines, at(3, 6)), 1)
    assert.deepEqual(turnedAwayByReason(db, 'prod-fx9', at(3, 6)), { short: 0, committed: 1 })

    // --- The wedding-season multiplier, visible on a quote (0024 D6/D7) ---
    // The desk marks the last week of peak as SEASON at ×1.25 — data typed
    // under Settings → Rates, never a rule in code (ASSUMPTION
    // #seasonal-pricing seeds the months at 1.0) — and Hamza's confirmed
    // hold prices with it on every card-rate line: 2d 9h → 3 calendar days
    // → 3 billable; 2 × 3 × Rs 25,000 × 1.25 = Rs 187,500, final because
    // it is confirmed and every line is priced. The text names the day.
    const seasonDay = localDate(at(3, 8, 9), DEFAULT_TIMEZONE)
    assert.equal(setCalendarDay(db, seed.orgId, seasonDay, 'season', 'Wedding season', 1.25, at(3, 5, 11)).ok, true)
    const peakQuote = quoteFor(db, peakHold.bookingId)
    assert.equal(peakQuote.steps.billableDays.calendarDays, 3)
    assert.equal(peakQuote.steps.weekRule.billableDays, 3)
    assert.equal(peakQuote.steps.calendarMultiplier.multiplier, 1.25)
    assert.equal(peakQuote.steps.calendarMultiplier.drivenBy.kind, 'season')
    assert.ok(peakQuote.lines.every((l) => l.multiplierApplied), 'no override on this one: the season applies to every line')
    assert.equal(peakQuote.totals.subtotalMinor, rs(187_500))
    assert.equal(peakQuote.totals.indicative, false)
    assert.match(
      quoteTextOf(db, STR_EN, seed.houseName, peakQuote),
      new RegExp(`Wedding season on ${seasonDay}: ×1\\.25 on the whole booking`),
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
  test('JAN — a camera drops on set: photos, damage, and the real swap', () => {
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

    // Day 3: the camera drops on set. The client needs a replacement NOW —
    // and now there is a REAL swap (was `no-swap-flow`, demonstrated NOV):
    // the broken FX9 comes home and is flagged, a C500 goes out on the SAME
    // job, and the rental stays one job's story. No faked second job, no
    // split charge, no orphaned photo evidence.
    const swap = swapAsset(db, {
      jobId: j1.id, brokenAssetId: 'asset-fx9-1', substituteAssetId: 'asset-c500-1',
      note: 'FX9 dropped on set — top handle cracked', now: () => at(4, -4),
    })
    assert.equal(swap.outcome, 'swapped')
    expectedScanOps += 3
    outTracker.delete('asset-fx9-1')
    outTracker.add('asset-c500-1')
    assert.equal(
      db.get(`select current_job_id as j from assets where id = 'asset-c500-1'`).j,
      j1.id,
      'the substitute is out on the same job',
    )

    // The broken camera is home, off the job, and flagged by the swap — the
    // 'in' photo (the crack) pairs with the out photo taken this morning.
    const brokenRow = db.get(
      `select presence, current_job_id, health from assets where id = 'asset-fx9-1'`,
    )
    assert.equal(brokenRow.presence, 'here')
    assert.equal(brokenRow.current_job_id, null)
    assert.equal(brokenRow.health, 'quarantined')
    const photosIn = new PhotoStore(db, { now: () => at(4, -3) })
    assert.equal(
      photosIn.capture({
        assetId: 'asset-fx9-1', jobId: j1.id, sessionId: null,
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

    // The swap flagged the broken FX9 quarantined, so it drops out of
    // availability with no SQL health hack. But the general health door is
    // still missing — a "this is broken" toggle with no swap behind it has
    // no screen (`no-health-door` stands, narrowed).
    finding('no-health-door')
    const avail = checkAvailability(
      db,
      matchKitList(parseKitList('1x Sony FX9'), demoCatalogue()),
      openJobCommitments(db),
      at(4, -2),
    )
    assert.equal(avail.lines[0].onHand, 2) // 3 units minus the flagged one

    // The claim: rental + damage on the khata, partly paid.
    post('cust-bilal', 'charge', 35_000, { k: 4, d: -3, jobId: j1.id, assetId: 'asset-fx9-1', note: 'FX9 day rate x2' })
    post('cust-bilal', 'damage_charge', 150_000, { k: 4, d: -3, jobId: j1.id, assetId: 'asset-fx9-1', note: 'Top handle + mount repair' })
    post('cust-bilal', 'payment', -100_000, { k: 4, d: -2, note: 'Bank transfer' })

    // The job comes home — sigma and the swapped-in C500 (the FX9 is already
    // back). Then it closes cleanly, one job start to finish.
    const j1back = openSession(j1.id, 'in', at(4, -3))
    scanAll(j1back, j1back.expected, 'check_in')
    mustClose(j1.id, at(4, -2, 13))

    // The payback bar counts RENTAL money only: the Rs 150,000 damage
    // RECOVERY stays on Bilal's khata but never inflates the camera's
    // earnings — a repair bill is not a celebration. (Was finding
    // `payback-counts-damage`.)
    const earnings = assetEarnings(db, 'asset-fx9-1')
    assert.equal(earnings.earnedMinor, rs(60_000 + 45_000 + 35_000))
    assert.equal(earnings.jobs, 3)

    // THE REPAIR ITSELF — Rs 45,000 to the workshop — finally has a book
    // to land on (was `no-expense-book`, the wall JUN used to mourn): a
    // repair expense naming the camera it fixed, counterparty and all.
    spend('repair', 45_000, {
      k: 4, d: 0, assetId: 'asset-fx9-1',
      counterparty: 'Sharif Camera Works', note: 'Top handle + mount',
    })
    // The camera's cost history knows it — this January's bill beside the
    // seed's own Rs 45,000 repair story on the same unit — and the
    // payback bar's denominator honestly carries both: replacement value
    // plus every live repair.
    const costs = assetCosts(db, 'asset-fx9-1')
    assert.equal(costs.repairMinor, rs(45_000 + 45_000))
    assert.equal(costs.repairCount, 2)
    const after = assetEarnings(db, 'asset-fx9-1')
    assert.equal(after.costMinor, rs(3_500_000 + 90_000))
    assert.equal(
      after.paybackPct,
      Math.round((after.earnedMinor / rs(3_590_000)) * 100),
    )

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
    // January's bottom line carries the repair: the crisis month is the
    // first whose profit is not simply its billing.
    assertMonthProfit(4)
  })

  // --- network --- (0025) ---------------------------------------- JAN, cont.
  test('JAN — the network: a Komodo lent to Kamran rides a real job, and their khata carries the charge', () => {
    const unit = db.get(
      `select id, asset_code from assets
        where product_id = 'prod-komodo' and presence = 'here' and ownership = 'owned'
          and disposition is null order by asset_code limit 1`,
    )
    assert.ok(unit, 'a Komodo on the shelf to lend')
    const lend = recordSubHireOut(db, seed.orgId, {
      partnerId: 'partner-kamran', startMs: at(4, 6, 8), endMs: at(4, 9, 18),
      assetId: unit.id, agreedChargeMinor: rs(20_000), note: 'Komodo, 3 days',
    }, at(4, 5), netIds(at(4, 5)))
    assert.equal(lend.ok, true)
    assert.equal(lend.jobLabel, 'Sub-hire → Kamran Rentals')
    // The partner is a customer now (D3): a khata row born with the charge.
    books.set(lend.customerId, { balance: rs(20_000), deposit: 0 })
    monthCharged[4] += rs(20_000)
    const khata = customerView(db, lend.customerId)
    assert.equal(khata.name, 'Kamran Rentals')
    assert.equal(khata.balanceMinor, rs(20_000))
    assert.equal(khata.entries[0].jobId, lend.jobId)
    assert.equal(khata.entries[0].assetId, unit.id)
    assert.deepEqual(openJob(db, lend.jobId).expected, [unit.id], 'the unit is promised on the sub-hire job')

    // The desk scans it out onto the job like any client's (D4).
    const out = openSession(lend.jobId, 'out', at(4, 6, 8))
    scanAll(out, [unit.id], 'check_out')
    assert.deepEqual(
      closeSubHire(db, lend.subHireId, at(4, 9), at(4, 9), netIds(at(4, 9))),
      { ok: false, reason: 'job_still_out', stillOut: 1 },
    )

    // Back, settled in cash at the door, closed — the job with it.
    const back = openSession(lend.jobId, 'in', at(4, 9, 18))
    scanAll(back, back.expected, 'check_in')
    post(lend.customerId, 'payment', -20_000, { k: 4, d: 9, hour: 19, jobId: lend.jobId, note: 'Cash' })
    assert.deepEqual(
      closeSubHire(db, lend.subHireId, at(4, 9, 20), at(4, 9, 20), netIds(at(4, 9, 20))),
      { ok: true, jobClosed: true, returnedToOwner: false },
    )
    assert.equal(openJob(db, lend.jobId), null, 'off the board')
    const money = partnerMoney(db, 'partner-kamran')
    assert.equal(money.theyOweMinor, 0)
    assert.equal(money.weOweMinor, rs(30_000), "November's loan is still on the kharcha book")
    assert.equal(money.customerId, lend.customerId)

    assertBooks()
    assertPhysical()
    assertNoLostScans()
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

    // The write-off now has its own kind — legible on every statement as
    // 'write-off', never mistakable for a discount or a data fix (POLICY,
    // owner may overrule; no screen writes it yet — `no-adjustment-door`).
    post('cust-farhan', 'write_off', -38_000, { k: 5, d: 8, note: 'Written off — client absconded' })
    assert.equal(L.kindLabel('write_off'), 'write-off')
    assert.equal(books.get('cust-farhan').balance, 0)
    assert.ok(
      !customersByBalance(db).some((c) => c.id === 'cust-farhan' && c.balanceMinor > 0),
    )

    // The GEAR side finally has a home too (0020, was the terminal half of
    // `no-blacklist-or-theft-export` and `no-terminal-asset-state`): the
    // owner marks the absconded FX6 and lens STOLEN — they leave the fleet,
    // off the ghost job — and the theft report builds the police/insurance
    // card from local facts: code, serial, photo count, last-seen, contact.
    const stolenJobId = f1row.id
    const stolen = db.all(
      `select id, asset_code, serial_number from assets
        where current_job_id = ? and presence = 'out' order by asset_code`,
      [stolenJobId],
    )
    assert.equal(stolen.length, 2)
    for (const a of stolen) {
      const r = markTerminal(db, {
        assetId: a.id, disposition: 'stolen',
        note: 'Client absconded — FIR filed', now: () => at(5, 8),
      })
      assert.ok(r.outboxId)
      expectedScanOps++
      outTracker.delete(a.id)
    }
    // Gone + stolen + off the job: the red row leaves the board (the loss is
    // recorded as a disposition, not an eternal 'out'), and the job can close.
    const fx6 = stolen.find((a) => a.asset_code.startsWith('FX6'))
    const goneFx6 = db.get(
      `select presence, disposition, current_job_id from assets where id = ?`,
      [fx6.id],
    )
    assert.equal(goneFx6.presence, 'gone')
    assert.equal(goneFx6.disposition, 'stolen')
    assert.equal(goneFx6.current_job_id, null)
    mustClose(stolenJobId, at(5, 8, 12))

    // THE THEFT REPORT — the export the year had nothing for. Serials, code,
    // photo count, last-seen, and the org's contact, forwardable to police or
    // a partner house. (The public tag resolver's stolen notice is the
    // server half, pinned in 0020_fleet_lifecycle_test.sql.)
    const lastScan = decodeScanOps(db)
      .filter((op) => op.assetId === fx6.id && op.eventType !== 'mark_stolen')
      .at(-1)
    const theft = buildTheftReport(
      {
        houseName: seed.houseName,
        item: { code: fx6.asset_code, name: 'Sony FX6', serial: fx6.serial_number },
        photoCount: 0,
        lastSeen: lastScan
          ? { whenMs: lastScan.createdAt, jobLabel: f1row.label, place: null }
          : null,
        contactLine: 'JazzCash: 0300 1234567',
      },
      theftLabels(STR_EN),
    )
    assert.match(theft, /THEFT REPORT/)
    assert.match(theft, /reported STOLEN/)
    assert.ok(theft.includes(fx6.asset_code))
    assert.match(theft, /Contact: JazzCash: 0300 1234567/)
    assert.match(theft, new RegExp(seed.houseName))
    // The blacklist flag on the CUSTOMER is still missing — the theft export
    // ships, the customer-side blacklist door does not yet.
    finding('no-blacklist')

    // --- An extension collides; the SUBSTITUTE door settles it (0022 D10)
    // Bilal holds FX9-02 — the body he always takes — for three days; Sana
    // has the same body, by name, the day after. Bilal calls: two more
    // days. The preview names Sana, the unit and when her hold begins, and
    // changes nothing; the extension is refused with the collision as
    // data. This time a substitute EXISTS: Sana's claim moves onto another
    // FX9 through reallocate_reservation (chained under Bilal's booking, so
    // the server replays the move before the extend), Bilal's extension
    // writes behind it, and no unit ever carries two confirmed claims.
    const bilalFx9 = createBooking(db, seed.orgId, {
      customerId: 'cust-bilal', startMs: at(5, 10, 9), endMs: at(5, 12, 18),
      lines: [{ assetId: 'asset-fx9-2' }], status: 'confirmed', note: 'Agency stills — FX9-02 as always',
    }, at(5, 8, 10))
    assert.equal(bilalFx9.ok, true)
    const sanaFx9 = createBooking(db, seed.orgId, {
      customerId: 'cust-sana', startMs: at(5, 13, 9), endMs: at(5, 14, 18),
      lines: [{ assetId: 'asset-fx9-2' }], status: 'confirmed',
      credentialOverrideNote: 'Regular since October',
    }, at(5, 8, 11))
    assert.equal(sanaFx9.ok, true, 'her window starts after his hold ends — no collision yet')
    const febPreview = extensionPreview(db, bilalFx9.bookingId, at(5, 14, 18), at(5, 11, 9))
    assert.equal(febPreview.collisions.length, 1)
    const blocking = febPreview.collisions[0]
    assert.equal(blocking.kind, 'asset')
    assert.equal(blocking.bookingNo, sanaFx9.bookingNo)
    assert.equal(blocking.customerName, 'Sana Tariq')
    assert.equal(blocking.assetCode, 'FX9-02')
    assert.equal(bookingView(db, bilalFx9.bookingId, at(5, 11, 9)).customerEndMs, at(5, 12, 18), 'the preview changed nothing')
    const febRefused = extendBooking(db, bilalFx9.bookingId, at(5, 14, 18), at(5, 11, 9))
    assert.equal(febRefused.extended, false)
    assert.equal(febRefused.collisions[0].bookingNo, sanaFx9.bookingNo)
    const sanaClaim = db.get(`select id from asset_reservations where booking_id = ?`, [sanaFx9.bookingId])
    const febOffered = substitutesForReservation(db, sanaClaim.id)
    assert.ok(febOffered.length >= 1, 'another FX9 is free over her window')
    assert.ok(!febOffered.some((o) => o.id === 'asset-fx9-2'), 'the body under dispute is never offered')
    const febMoved = reallocateReservation(db, sanaClaim.id, febOffered[0].id, at(5, 11, 10), undefined, bilalFx9.bookingId)
    assert.equal(febMoved.ok, true)
    assert.equal(bookingView(db, sanaFx9.bookingId, at(5, 11, 10)).assetReservations[0].assetId, febOffered[0].id)
    const febExtended = extendBooking(db, bilalFx9.bookingId, at(5, 14, 18), at(5, 11, 11))
    assert.equal(febExtended.extended, true)
    assert.equal(febExtended.customerEndMs, at(5, 14, 18))
    const febChain = db.all(
      `select op, id, depends_on from outbox where op in ('reallocate_reservation', 'extend_booking') and seq > (
         select max(seq) from outbox where op = 'confirm_booking' and payload like ?) order by seq`,
      [`%"${sanaFx9.bookingId}"%`],
    )
    assert.deepEqual(febChain.map((o) => o.op), ['reallocate_reservation', 'extend_booking'])
    assert.equal(febChain[1].depends_on, febChain[0].id, 'the extension replays only after the substitute lands')
    assert.equal(
      Number(db.get(
        `select count(*) as n from asset_reservations a join asset_reservations b
            on a.asset_id = b.asset_id and a.id < b.id
           join bookings ba on ba.id = a.booking_id join bookings bb on bb.id = b.booking_id
          where a.state = 'confirmed' and b.state = 'confirmed'
            and ba.status = 'confirmed' and bb.status = 'confirmed'
            and a.blocked_from < b.blocked_until and b.blocked_from < a.blocked_until`,
      ).n),
      0,
      'no unit carries two overlapping confirmed claims',
    )
    // Bilal's booking becomes his truck; Sana's shoot is postponed and the
    // pencil-turned-promise is released through the cancel door.
    const febJob = convertBookingToJob(db, seed.orgId, bilalFx9.bookingId, at(5, 10, 8))
    assert.equal(febJob.ok, true)
    const febOut = openSession(febJob.jobId, 'out', at(5, 10, 9))
    assert.deepEqual(febOut.expected, ['asset-fx9-2'])
    scanAll(febOut, febOut.expected, 'check_out')
    assert.deepEqual(cancelBooking(db, sanaFx9.bookingId, 'Postponed to March', at(5, 12)), { ok: true, bookingId: sanaFx9.bookingId, bookingNo: sanaFx9.bookingNo })
    assert.equal(Number(db.get(`select count(*) as n from asset_reservations where booking_id = ?`, [sanaFx9.bookingId]).n), 0, 'her claim is released')
    jobBack(febJob.jobId, 'cust-bilal', at(5, 14, 19), { k: 5, d: 14, chargeRs: 125_000, payRs: 125_000 })

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
    // Per-asset earnings answer cleanly — for one asset at a time. Rental
    // money only: January's Rs 150,000 damage recovery is not in the bar.
    const fx9 = assetEarnings(db, 'asset-fx9-1')
    assert.equal(fx9.earnedMinor, rs(140_000))
    assert.equal(fx9.paybackPct, Math.round((rs(140_000) / rs(3_500_000)) * 100))

    // The unpriced tripods earned nothing and have no payback bar — honest.
    const tripod = assetEarnings(db, 'asset-sachdeva-1')
    assert.equal(tripod.earnedMinor, 0)
    assert.equal(tripod.paybackPct, null)

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

    // --- A client keeps the gear two days longer ----------------------------
    // Hamza has the house's one C500 for three days; Sana has it the day
    // after he brings it back. Hamza calls: two more days. The preview
    // (0022 D10) names who is waiting — Sana, the unit, when her hold
    // begins — and nothing changes until the desk settles it. The only
    // C500 has no substitute, so the desk sub-rents one for Sana: the
    // intent lands on Hamza's note, and the extension writes behind it.
    const hamzaC500 = createBooking(db, seed.orgId, {
      customerId: 'cust-hamza', startMs: at(6, 8, 9), endMs: at(6, 10, 18),
      lines: [{ productId: 'prod-c500', qty: 1 }], status: 'confirmed', note: 'Drama promo',
    }, at(6, 1, 10))
    assert.equal(hamzaC500.ok, true)
    const sanaC500 = createBooking(db, seed.orgId, {
      customerId: 'cust-sana', startMs: at(6, 11, 9), endMs: at(6, 12, 18),
      lines: [{ productId: 'prod-c500', qty: 1 }], status: 'confirmed',
      credentialOverrideNote: 'Regular since October',
    }, at(6, 1, 11))
    assert.equal(sanaC500.ok, true)
    const preview = extensionPreview(db, hamzaC500.bookingId, at(6, 12, 18), at(6, 10, 9))
    assert.equal(preview.collisions.length, 1)
    const waiting = preview.collisions[0]
    assert.equal(waiting.kind, 'asset')
    assert.equal(waiting.bookingNo, sanaC500.bookingNo)
    assert.equal(waiting.customerName, 'Sana Tariq')
    assert.equal(waiting.assetCode, 'C500-01')
    assert.equal(waiting.theirFromMs, at(6, 11, 7), 'her hold begins two hours before her pickup')
    assert.equal(bookingView(db, hamzaC500.bookingId, at(6, 10, 9)).customerEndMs, at(6, 10, 18), 'the preview changed nothing')
    // No other C500 to move her onto; the extension is refused by name…
    const theirClaim = db.get(`select id from asset_reservations where booking_id = ?`, [sanaC500.bookingId])
    assert.deepEqual(substitutesForReservation(db, theirClaim.id), [])
    const refused = extendBooking(db, hamzaC500.bookingId, at(6, 12, 18), at(6, 10, 9))
    assert.equal(refused.extended, false)
    assert.equal(refused.collisions[0].bookingNo, sanaC500.bookingNo)
    // …until the sub-rent intent is on record.
    const noted = noteSubRent(db, hamzaC500.bookingId, {
      productId: waiting.productId, productName: waiting.productName, qty: 1,
      forBookingId: waiting.bookingId, forBookingNo: waiting.bookingNo,
    }, STR_EN, at(6, 10, 10))
    assert.equal(noted.ok, true)
    assert.match(noted.note, new RegExp(`Sub-rent Canon C500 Mark II ×1 for #${sanaC500.bookingNo}`))
    const extended = extendBooking(db, hamzaC500.bookingId, at(6, 12, 18), at(6, 10, 11), undefined, { acknowledged: [waiting] })
    assert.equal(extended.extended, true)
    assert.equal(extended.customerEndMs, at(6, 12, 18))
    const chain = db.all(
      `select op, depends_on, id from outbox
        where op in ('sub_rent_intent', 'extend_booking') and payload like ? order by seq`,
      [`%"${hamzaC500.bookingId}"%`],
    )
    assert.deepEqual(chain.map((o) => o.op), ['sub_rent_intent', 'extend_booking'])
    assert.equal(chain[1].depends_on, chain[0].id, 'the extension replays only after the sub-rent lands')
    assert.equal(bookingView(db, sanaC500.bookingId, at(6, 10, 11)).assetReservations[0].assetId, 'asset-c500-1',
      'her claim on the unit stands until the partner unit covers it')

    // DEAD STOCK IS NOW A READ, not a wall (0021 D4 — was the idle-days
    // half of `no-utilization-read`): the Xeen set, never rented all year,
    // and the idle Sachdeva both surface with the idle capital priced —
    // while the light that just worked Ramzan does not.
    const idle = sehat(db, at(6, 10))
    const deadIds = idle.deadStock.map((r) => r.id)
    assert.ok(deadIds.includes('asset-samyang-1'), 'the Rs 4.5M Xeen set is dead stock')
    assert.ok(deadIds.includes('asset-sachdeva-3'), 'the unpriced tripod too')
    assert.ok(!deadIds.includes(m1.expected[0]), 'a unit rented this month is working, not idle')
    assert.ok(idle.deadStockValue.totalMinor >= rs(4_500_000), 'the idleness is said in money')
    // What REMAINS of the finding is the ranking: no fleet leaderboard of
    // earners — the owner still opens asset pages one by one (AUG Q4).
    finding('no-utilization-read')

    assertBooks()
    assertNoLostScans()
  })

  // -------------------------------------------------------------- APR (k=7)
  test('APR — Eid rush: the partner house helps out, and its bill lands on the book', () => {
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

    // The vendor borrows two from a partner house. The import puts the
    // units on the shelf (still stamped ownership='owned' — flipping that
    // flag from an intake door is Phase E1 cross-hire polish, noted in
    // the year doc), and the COST owed to the partner now lands on the
    // book as a sub-hire expense tied to the job it rescues — the money
    // half of what was `no-subrent-intake`, shipped.
    const csv = 'Item,Qty,Code\nAputure 600D Pro,2,AP600P'
    const { rows, rejected } = readRows(parseCsv(csv), { name: 0, quantity: 1, code: 2 })
    assert.deepEqual(
      applyImport(db, seed.orgId, planImport(rows, currentCatalogue(), rejected), at(7, -7)),
      { products: 0, units: 2, renumbered: 0 },
    )
    assert.equal(bindImportedTags('APR', at(7, -7, 13)).imported.length, 2)
    const borrowed = db.get(
      `select count(*) as n from assets a join products p on p.id = a.product_id
        where p.display_name = 'Aputure 600D Pro' and a.ownership = 'owned'`,
    )
    assert.equal(Number(borrowed.n), 8) // shelf count; the partner's bill is below

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

    // --- The thermal parchi, bytes built for THIS job (0025 client wave) --
    // The gate pass the guard reads is the same text the handover screen
    // renders as a QR; on paper it is an ESC/POS stream: init, the
    // letterhead centred/bold/double-size, the body at 32 columns, the QR
    // block, three feed lines, the cut. Pure bytes — deterministic, ASCII
    // by construction — and the hardware is still unverified (see
    // production-readiness: no printer has fed paper).
    const parchiText = buildParchi({
      houseName: seed.houseName, jobLabel: 'Eid shoot — six lights', mode: 'out', whenMs: at(7, -5),
      items: e1.expected.map((id) => {
        const r = db.get(
          `select a.asset_code, coalesce(p.display_name, a.display_name) as name
             from assets a left join products p on p.id = a.product_id where a.id = ?`,
          [id],
        )
        return { code: r.asset_code, name: r.name }
      }),
      assumedCount: 0, shortfall: [], shortfallValueLabel: null,
      attendants: attendantNames(db, e1.id),
    })
    assert.match(parchiText, /\nOUT \(12\):\n/)
    const parchiBytes = buildParchiEscPos(parchiDocFromText(parchiText), { width: 32 })
    assert.deepEqual([...parchiBytes.slice(0, 2)], [...ESCPOS_INIT])
    assert.deepEqual([...parchiBytes.slice(2, 11)], [0x1b, 0x61, 1, 0x1b, 0x45, 1, 0x1d, 0x21, 0x11], 'centred, bold, double-size letterhead')
    assert.deepEqual([...parchiBytes.slice(-4)], [...ESCPOS_CUT])
    const asBytes = (text) => [...text].map((c) => c.charCodeAt(0))
    const holds = (hay, needle) => hay.some((_, i) => needle.every((b, j) => hay[i + j] === b))
    assert.ok(holds([...parchiBytes], asBytes('Eid shoot - six lights')), 'the em dash is folded to ASCII')
    assert.ok(!holds([...parchiBytes], [0xe2, 0x80, 0x94]), 'no UTF-8 dash reaches the paper — a clone prints garbage for it')
    assert.ok(holds([...parchiBytes], asBytes('OUT (12):')), 'the count the gate reads is on the paper')
    assert.ok(holds([...parchiBytes], [0x1d, 0x28, 0x6b]), 'the QR block is there')
    assert.deepEqual([...buildParchiEscPos(parchiDocFromText(parchiText), { width: 32 })], [...parchiBytes], 'the same job prints the same bytes')

    // The partner house's bill, tied to the job its lights rescued.
    spend('sub_hire', 30_000, {
      k: 7, d: -5, jobId: e1.id,
      counterparty: 'Roshan Light House', note: '2x 600D, Eid week',
    })
    jobBack(e1.id, 'cust-ayesha', at(7, -2), { k: 7, d: -2, chargeRs: 90_000, payRs: 90_000 })
    // Margin at a glance: what the Eid job billed, minus what the partner
    // was owed for making it possible — the read the handover now shows.
    const eidMargin = jobMargin(db, e1.id)
    assert.equal(eidMargin.incomeMinor, rs(90_000))
    assert.equal(eidMargin.expenseMinor, rs(30_000))
    assert.equal(eidMargin.marginMinor, rs(60_000))
    const e2 = jobOut('Eid day 2 — family films', 'cust-hamza',
      [{ productId: 'prod-fx6', qty: 2 }, { productId: 'prod-ronin', qty: 1 }],
      iso(7, 0), at(7, -1))
    jobBack(e2.id, 'cust-hamza', at(7, 0), { k: 7, d: 0, chargeRs: 45_000, payRs: 45_000 })

    // --- Eid's second week is already promised ---------------------------
    // Hamza's confirmed booking holds four of the seven fit big lights. A
    // client asks for six over those dates: seven on the shelf, three
    // free — short by three, and the log counts them as COMMITTED demand
    // beside the month's earlier shelf shortage.
    const eidHold = createBooking(db, seed.orgId, {
      customerId: 'cust-hamza', startMs: at(7, 5, 9), endMs: at(7, 6, 18),
      lines: [{ productId: 'prod-aputure600', qty: 4 }], status: 'confirmed',
    }, at(7, 1, 10))
    assert.equal(eidHold.ok, true)
    const eidAsk = checkAvailability(
      db,
      matchKitList(parseKitList('6x Aputure 600D Pro'), demoCatalogue()),
      openJobCommitments(db),
      at(7, 2),
      { startMs: at(7, 5, 9), endMs: at(7, 6, 18) },
    )
    assert.equal(eidAsk.lines[0].onHand, 7, 'seven fit to rent — the faulty seeded light stays off the count')
    assert.equal(eidAsk.lines[0].confirmedOverlap, 4)
    assert.equal(eidAsk.lines[0].state, 'short')
    assert.equal(eidAsk.lines[0].shortReason, 'committed')
    assert.equal(recordTurnedAway(db, eidAsk.lines, at(7, 2)), 1)
    assert.deepEqual(turnedAwayThisMonth(db, 'prod-aputure600', at(7, 2)), { times: 2, units: 4 })
    assert.deepEqual(turnedAwayByReason(db, 'prod-aputure600', at(7, 2)), { short: 1, committed: 3 })

    // --- The same enquiry, PRICED, before any booking exists (0024) ------
    // The desk marks Eid on the first day of the ask at ×1.25 (the
    // calendar is data — Eid moves), and the pasted list becomes a quote
    // through the same six steps the server runs: 1d 9h → 2 calendar days
    // → 2 billable; 6 × 2 × Rs 12,000 × 1.25 = Rs 180,000, indicative
    // because nothing is confirmed, the note naming the driving day.
    const eidDay = localDate(at(7, 5, 9), DEFAULT_TIMEZONE)
    assert.equal(setCalendarDay(db, seed.orgId, eidDay, 'holiday', 'Eid ul-Adha', 1.25, at(7, 2)).ok, true)
    const eidQuote = quoteForLines(
      db,
      [{ productId: 'prod-aputure600', productName: 'Aputure 600D Pro', qty: 6 }],
      at(7, 5, 9), at(7, 6, 18), 'cust-hamza',
    )
    assert.equal(eidQuote.steps.billableDays.calendarDays, 2)
    assert.equal(eidQuote.steps.weekRule.billableDays, 2)
    assert.equal(eidQuote.steps.calendarMultiplier.multiplier, 1.25)
    assert.equal(eidQuote.steps.calendarMultiplier.drivenBy.name, 'Eid ul-Adha')
    assert.equal(eidQuote.lines[0].lineTotalMinor, rs(180_000))
    assert.equal(eidQuote.totals.subtotalMinor, rs(180_000))
    assert.equal(eidQuote.totals.indicative, true)
    assert.deepEqual(eidQuote.totals.indicativeReasons, ['not_confirmed'])
    assert.equal(eidQuote.flags.depositHint, 'lighter', 'Hamza is the fast lane by now')
    const eidText = quoteTextOf(db, STR_EN, seed.houseName, eidQuote).split('\n')
    assert.equal(eidText[0], 'Ravi Light & Grip — quote')
    assert.equal(eidText[1], 'For: Hamza Saeed')
    assert.equal(eidText[3], '2 billable days (2 on the calendar)')
    assert.equal(eidText[5], 'Aputure 600D Pro × 6 · 2 days · Rs 12,000/day = Rs 180,000')
    assert.equal(eidText[7], `Eid ul-Adha on ${eidDay}: ×1.25 on the whole booking`)
    assert.equal(eidText[9], 'Total: Rs 180,000')
    assert.equal(eidText[10], 'Indicative — not confirmed yet.')
    assert.equal(eidText[11], 'Deposit: half deposit')

    assertBooks()
    assertPhysical()
    assertNoLostScans()
    assert.equal(moneyStrip(db, at(7, 10)).earnedMonthMinor, monthCharged[7])
    // Eid's bottom line nets the partner out: rush income minus sub-hire.
    assertMonthProfit(7)
  })

  // -------------------------------------------------------------- MAY (k=8)
  test('MAY — the cheque bounces: correction semantics and the debt clock', () => {
    // --- The overdue ladder's last rung fires on the chronic late payer --
    // Ayesha — owed since before the pilot — takes the C300 and does not
    // bring it back. The ladder (ASSUMPTION #escalation-ladder) climbs
    // from the stored due date on the phone's own clock: day 1 a nudge,
    // day 3 a call, day 7 the late-fee draft, day 14 the manager, with a
    // blacklist to CONSIDER — a decision, never an automatic flag. The
    // desk escalates: one local flag (ASSUMPTION #manager-flag) and the
    // board says when. The blacklist door itself still does not exist
    // (`no-blacklist`, pinned in FEB).
    const chronic = jobOut('Documentary pickups — Walled City', 'cust-ayesha',
      [{ productId: 'prod-c300', qty: 1 }], iso(8, -6), at(8, -9))
    const rungs = [1, 3, 7, 14].map((d) => escalationStep(dueStatus(iso(8, -6), at(8, -6 + d)).daysLate))
    assert.deepEqual(rungs.map((r) => r.action), ['whatsapp_nudge', 'call', 'late_fee_draft', 'manager_escalation'])
    assert.equal(rungs[3].considerBlacklist, true)
    assert.equal(escalationStep(dueStatus(iso(8, -6), at(8, -6, 14)).daysLate ?? 0), null, 'nothing before day 1')
    const lateRow = dueBoard(db, at(8, 8)).outJobs.find((j) => j.id === chronic.id)
    assert.equal(lateRow.due.state, 'overdue')
    assert.equal(lateRow.due.daysLate, 14)
    assert.equal(managerFlaggedAt(db, chronic.id), null)
    assert.equal(flagForManager(db, chronic.id, at(8, 8)), true)
    assert.equal(managerFlaggedAt(db, chronic.id), new Date(at(8, 8)).toISOString())
    assert.equal(flagForManager(db, chronic.id, at(8, 9)), true)
    assert.equal(managerFlaggedAt(db, chronic.id), new Date(at(8, 8)).toISOString(), 'escalated once; a second tap keeps the first date')
    // Day 15 it comes home; the by-the-book draft is 15 × Rs 20,000. The
    // desk charges the rental and a reduced fee — unpaid, like everything
    // else on Ayesha's page.
    assert.equal(lateFeeDraftFor(db, chronic.id, at(8, 9)).draft.totalMinor, rs(15 * 20_000))
    jobBack(chronic.id, 'cust-ayesha', at(8, 9), { k: 8, d: 9, chargeRs: 40_000 })
    post('cust-ayesha', 'late_fee', 60_000, { k: 8, d: 9, jobId: chronic.id, note: '15 days late — reduced' })

    const may1 = jobOut('Drama finale — Bahria set', 'cust-imran',
      [{ productId: 'prod-komodo', qty: 1 }, { productId: 'prod-cne', qty: 1 }],
      iso(8, -1), at(8, -4))
    jobBack(may1.id, 'cust-imran', at(8, -1), { k: 8, d: -1, chargeRs: 40_000 })
    const chequeId = post('cust-imran', 'payment', -40_000, {
      k: 8, d: -1, hour: 14, note: 'Cheque 114202',
    })
    assert.equal(customerView(db, 'cust-imran').balanceMinor, books.get('cust-imran').balance)

    // Six days later the bank returns the cheque. The correction now has a
    // NAME: a 'reversal' that points at the payment it voids. The client's
    // statement reads 'reversed', never 'adjustment' — the house made no
    // error — though no screen writes it yet (`no-adjustment-door` holds).
    post('cust-imran', 'reversal', 40_000, {
      k: 8, d: 5, note: 'Cheque 114202 bounced', reversalOf: chequeId,
    })
    finding('no-adjustment-door')

    // The debt clock SURVIVES the bounce: the voided payment and its
    // reversal cancel in time as well as in money, so 'owed since' points
    // at the original charge — the number collections pressure runs on is
    // six weeks, not six days. (Was finding `debt-age-resets-on-bounce`.)
    const entries = customerView(db, 'cust-imran').entries
    assert.equal(oldestUnpaidMs(entries), at(8, -1))

    const card = balanceCardText(
      {
        customerName: 'Imran Qureshi', houseName: seed.houseName,
        entries, paymentLine: null,
      },
      L,
    )
    assert.ok(card.includes(L.kindLabel('reversal')))

    assertBooks()
    assertNoLostScans()
  })

  // -------------------------------------------------------------- JUN (k=9)
  test('JUN — the gear ages, and now the wear is counted', () => {
    // The FX9's ledger says 3 jobs — but only because two rental charges
    // happened to carry its asset id. The SCANS know the truth: the outbox
    // holds every checkout this year, and since 0021 the projection READS
    // it — the service meter grew past its synced 120 with every rental
    // the year recorded. (Was finding `no-service-tracking`, the JUN wall.)
    const fx9Outs = decodeScanOps(db).filter(
      (op) => op.assetId === 'asset-fx9-1' && op.eventType === 'check_out',
    )
    assert.ok(fx9Outs.length >= 3, `${fx9Outs.length} recorded checkouts`)
    assert.equal(assetEarnings(db, 'asset-fx9-1').jobs, 3)

    const worn = serviceFacts(db, 'asset-fx9-1')
    assert.ok(worn.daysSinceService > 120, `the meter grew with use (${worn.daysSinceService})`)
    assert.equal(worn.dueAfter, 100)
    assert.equal(worn.due, true, 'past the threshold')
    assert.ok(
      sehat(db, at(9, 3)).serviceDue.some((r) => r.id === 'asset-fx9-1'),
      'and the Sehat surface names the unit',
    )

    // The desk services it — ONE flow: the workshop bill lands on the
    // kharcha book named to the camera, and the serviced event carries the
    // link the server validates (0021 D2).
    const svcExpense = spend('repair', 15_000, {
      k: 9, d: 3, assetId: 'asset-fx9-1',
      counterparty: 'Sharif Camera Works', note: 'Annual service',
    })
    recordServiced(db, {
      assetId: 'asset-fx9-1', note: 'Annual service', expenseId: svcExpense,
      now: () => at(9, 3, 15),
    })
    expectedScanOps++

    const rested = serviceFacts(db, 'asset-fx9-1')
    assert.equal(rested.daysSinceService, 0, 'the meter reset')
    assert.equal(rested.due, false)
    assert.ok(
      !sehat(db, at(9, 4)).serviceDue.some((r) => r.id === 'asset-fx9-1'),
      'the nudge stands down',
    )

    // The repair history — Rs 45,000 to the camera technician in January
    // (was `no-expense-book`), the seed's own story, and today's service
    // bill: "what did this camera COST me" answers from the same page
    // that says what it earned, and June can still ask January's profit.
    const fx9Costs = assetCosts(db, 'asset-fx9-1')
    assert.equal(fx9Costs.repairMinor, rs(105_000)) // seed + Jan + today
    assert.equal(monthProfit(db, at(4, 10, 0)).spentMinor, monthSpent[4])

    const jun1 = jobOut('Session video — studio day', 'cust-sana',
      [{ productId: 'prod-c300', qty: 1 }, { productId: 'prod-mkh416', qty: 1 }],
      iso(9, 2), at(9, 0))
    jobBack(jun1.id, 'cust-sana', at(9, 2), { k: 9, d: 2, chargeRs: 26_000, payRs: 26_000 })

    assertBooks()
    assertNoLostScans()
  })

  // -------------------------------------------------------------- JUL (k=10)
  test('JUL — the stocktake: a real ginti, and the seeded discrepancy caught', () => {
    // A retired label (peeled sticker) resolves without confidence — right.
    db.exec(`update asset_tags set status = 'retired' where asset_id = 'asset-sachdeva-3'`)
    assert.equal(lookupTag(db, tagOf.get('asset-sachdeva-3')).kind, 'retired')

    // Lookup mode still writes NOTHING — the scan-free invariant holds.
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

    // Now the OTHER half of a stocktake exists (0020, was `no-cycle-count`):
    // the diff. The book says these live items sit on Grip Bay —
    const gripExpected = db
      .all(
        `select id from assets
          where current_location_id = 'loc-grip' and presence = 'here'
            and disposition is null
          order by asset_code`,
      )
      .map((r) => r.id)
    assert.ok(gripExpected.includes('asset-cstand-8'), 'the book puts C-Stand #8 on Grip Bay')

    // The tech walks Grip Bay and scans everything actually there. C-Stand #8
    // is NOT — someone walked it off and never scanned it (the seeded
    // discrepancy). And a Sachdeva tripod the book had on Rack C turns up here
    // instead — the count found gear the mirror had misplaced.
    const seen = gripExpected.filter((id) => id !== 'asset-cstand-8')
    seen.push('asset-sachdeva-1') // stray: the book says Rack C

    const diff = cycleCountDiff(gripExpected, seen)
    assert.deepEqual(diff.missing, ['asset-cstand-8'])
    assert.ok(diff.unexpected.includes('asset-sachdeva-1'))

    // Finishing writes an inventory_count for every SEEN item — and the write
    // is NON-DESTRUCTIVE: a count asserts "seen on the shelf", never a
    // movement, so presence is untouched. Pin it on the first seen item.
    const before = db.get(`select presence from assets where id = ?`, [seen[0]])
    const countSession = new ScanSession(db, { deviceId: 'sim-phone', now: () => at(10, 0) })
    for (const id of seen) {
      const r = countSession.scan(tagOf.get(id), 'inventory_count')
      assert.ok(r.outboxId)
      expectedScanOps++
    }
    assert.equal(
      db.get(`select presence from assets where id = ?`, [seen[0]]).presence,
      before.presence,
      'a cycle count never moved the item it counted',
    )

    // The copyable discrepancy report names the missing and the stray, and
    // defers the found-vs-lost decision to the owner (never auto-marks).
    const facts = (id) => {
      const r = db.get(
        `select a.asset_code, coalesce(p.display_name, a.display_name) as name
           from assets a left join products p on p.id = a.product_id where a.id = ?`,
        [id],
      )
      return { code: r?.asset_code ?? null, name: r?.name ?? null }
    }
    const report = buildGintiReport(
      {
        shelf: 'Grip Bay',
        okCount: diff.ok.length,
        missing: diff.missing.map(facts),
        unexpected: diff.unexpected.map(facts),
      },
      gintiLabels(STR_EN),
    )
    assert.match(report, /GINTI/)
    assert.match(report, /MISSING/)
    assert.ok(report.includes('CST-08'))
    assert.match(report, /Missing items are for you to decide/)

    // --- The owner decides: STOLEN, and the partner group hears it (0025 D9)
    // Nobody has seen C-Stand #8 since the Eid trucks. It leaves the fleet
    // as a disposition — the count never did that by itself — and the
    // broadcast is one line in the group's language, the other second,
    // the house's public phone on it (a unit that is not stolen has no
    // broadcast at all: the loud line is only honest when the state is).
    setPublicPhone(db, '0300 1234567')
    const stolenStand = markTerminal(db, {
      assetId: 'asset-cstand-8', disposition: 'stolen',
      note: 'Missing at the July ginti', now: () => at(10, 0, 14),
    })
    assert.ok(stolenStand.outboxId)
    expectedScanOps++
    assert.equal(db.get(`select disposition from assets where id = 'asset-cstand-8'`).disposition, 'stolen')
    const shout = stolenBroadcast(db, 'asset-cstand-8', seed.houseName, 'ur')
    assert.match(shout, /^CHORI \/ STOLEN — C-Stand \(CST-08\), tag v1[A-Za-z0-9]+\. Yeh Ravi Light & Grip ka saman hai/)
    assert.match(shout, /0300 1234567 par call karein\. \/ This item was stolen from Ravi Light & Grip\./)
    assert.equal(stolenBroadcast(db, seen[0], seed.houseName, 'en'), null, 'no broadcast for a unit that is home')

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

    // Q1b — "What did the year actually MAKE?" The vendor's-dream question
    // the expense book existed to answer (was `no-expense-book`): earned
    // minus spent, month by month, agrees with the hand-kept books to the
    // paisa. (The seeded rows live before month 0, so the simulated
    // months sum clean.)
    const yearSpent = monthSpent.reduce((a, b) => a + b, 0)
    assert.ok(yearSpent > 0, 'the year recorded real expenses')
    let profitSum = 0
    for (let k = 0; k < 12; k++) profitSum += monthProfit(db, at(k, 10, 0)).profitMinor
    assert.equal(profitSum, simCharges - yearSpent)

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
    // …and each page's payback bar carries the year's repairs in its
    // denominator: the FX9's Rs 3.5M plus the seed's, January's and
    // June's bills, against rental money only.
    const fx9Payback = assetEarnings(db, 'asset-fx9-1')
    assert.equal(fx9Payback.costMinor, rs(3_500_000 + 105_000))
    assert.equal(fx9Payback.paybackPct, Math.round((fx9Payback.earnedMinor / fx9Payback.costMinor) * 100))

    // Q5 — "What did I turn away, and why?" The demand log by reason,
    // summed over the year's months: every FX9 refusal was a COMMITTED
    // one — the shelf had the bodies, the calendar had promised them — and
    // the Eid lights split one shelf shortage from three promised units.
    // That is the buy signal: one more FX9 would have taken three jobs.
    const yearTurnedAway = (productId) => {
      const sum = { short: 0, committed: 0 }
      for (let k = 0; k < 12; k++) {
        const r = turnedAwayByReason(db, productId, at(k, 10))
        sum.short += r.short
        sum.committed += r.committed
      }
      return sum
    }
    assert.deepEqual(yearTurnedAway('prod-fx9'), { short: 0, committed: 3 })
    assert.deepEqual(yearTurnedAway('prod-aputure600'), { short: 1, committed: 3 })

    // --- The final reconciliation -----------------------------------------
    assertBooks()
    assertPhysical()
    assertNoLostScans()

    // Nothing hangs 'out' at year end any more. The three items that used to
    // stay red forever — October's paid-for cable, February's stolen FX6 and
    // lens — now have terminal states (0020): the cable is 'lost', the two
    // absconded units are 'stolen' (and July's ginti sent a third unit the
    // same way), all off their jobs. The loss is RECORDED, as a disposition,
    // instead of an eternal ghost on the coming-back board.
    const stillOut = sqlOutSet()
    assert.equal(stillOut.size, 0)
    const gone = db.all(
      `select disposition, count(*) as n from assets
        where disposition is not null group by disposition order by disposition`,
    )
    // --- network --- November's loaner went home as returned_to_owner —
    // a fourth terminal row that must never read 'retired'.
    assert.deepEqual(
      gone.map((r) => [r.disposition, Number(r.n)]),
      [['lost', 1], ['returned_to_owner', 1], ['stolen', 3]],
    )
    // The absconded job left the coming-back board when its gear went stolen —
    // no red row, because the truth is now "gone", not "late".
    const board = dueBoard(db, at(11, 5))
    assert.equal(
      board.outJobs.find((j) => j.label.startsWith('Music video')),
      undefined,
      'a stolen-out job is no longer a late row — its gear left the fleet',
    )

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
    // Phase B0 took three ids off this list — `no-add-customer`,
    // `no-customer-on-desk-job`, `no-close-job` — by shipping the doors;
    // the expense book (0019) took two more — `no-expense-book`,
    // `no-subrent-intake`. Wave 2 (the fleet lifecycle, 0020) took three:
    // `no-terminal-asset-state`, `no-swap-flow`, `no-cycle-count`; the
    // theft half of `no-blacklist-or-theft-export` shipped too, narrowing
    // that id to `no-blacklist`. Wave 3 (the living fleet, 0021) takes
    // `no-service-tracking` off the list — the JUN nudge is real: the
    // meter grows with the year's scans, the Sehat surface names the
    // unit, and the desk services it with the cost landing on the book.
    // Dead stock is a read too, asserted in MAR, so
    // `no-utilization-read` NARROWS to the missing earners leaderboard.
    // Wave 5 (the promise calendar, 0022 + the client) takes three:
    // `no-bookings`, `double-promise` — SEP's wedding and NOV's two
    // shaadi trucks now leave with different units because the calendar
    // refuses the second promise BY NAME — and
    // `turnaway-blind-to-commitments`: an enquiry asked with dates
    // subtracts confirmed claims and the log counts the committed refusal.
    // The second year (W8) takes `import-apply-welded`: applyImport lives
    // in read-model.ts and the year drives the real routine twice. The
    // eight that remain are Phase B polish doors the waves did not build
    // — each explained in docs/year-in-the-life.md.
    assert.deepEqual(
      [...FINDINGS].sort(),
      [
        'no-adjustment-door',
        'no-blacklist',
        'no-deposit-door',
        'no-health-door',
        'no-lifetime-value-view',
        'no-month-history-screen',
        'no-utilization-read',
        'waived-fee-invisible',
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
