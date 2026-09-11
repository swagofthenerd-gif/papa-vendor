import {
  CHARGE_KINDS,
  dueStatus,
  lateFeeDraft,
  monthBounds,
  projectLedger,
  paybackPercent,
  type KhataStrings,
  type LedgerEntryKind,
  type LedgerEntryView,
  type MoneyTotal,
  type SqlDriver,
} from '@papa/core'
import { DEFAULT_CARD_RATE_SQL, decodeScanOps, lastSessionRecord, openJob } from './read-model.ts'
import { assetCosts } from './kharcha.ts'
import type { StrTable } from '../strings.ts'

/**
 * The money book's read model — the khata queries, in a plain .ts module
 * like read-model.ts and hisaab.ts so every rule here is assertable under
 * plain Node against a real SQLite.
 *
 * WHAT WRITES LOOK LIKE. `recordEntry` is the ONLY write, and it is an
 * INSERT — the ledger is append-only (PLAN.md override #14) and every
 * balance on every screen is a projection over it via @papa/core's
 * projectLedger. Recording money received or a charge agreed at the dock
 * is a PAST FACT, so by the CONTRIBUTING offline rule everything in this
 * module works with no server; in the demo, as everywhere else, only the
 * server that would sync it is missing.
 */

export interface CustomerListRow {
  id: string
  name: string
  phone: string | null
  balanceMinor: number
  depositHeldMinor: number
}

export interface LedgerRow extends LedgerEntryView {
  id: string
  jobId: string | null
  assetId: string | null
  reversalOf: string | null
}

export interface CustomerLinkedJob {
  id: string
  label: string
  status: string
  expectedBack: string | null
}

export interface CustomerView {
  id: string
  name: string
  phone: string | null
  balanceMinor: number
  depositHeldMinor: number
  /** Newest first — the page reads as a story, latest entry on top. */
  entries: LedgerRow[]
  jobs: CustomerLinkedJob[]
}

function rowsFor(db: SqlDriver, customerId: string): LedgerRow[] {
  return db
    .all<{
      id: string
      kind: string
      amount_minor: number
      job_id: string | null
      asset_id: string | null
      note: string | null
      created_at: number
      seq: number
      reversal_of: string | null
      job_label: string | null
    }>(
      // rowid rides along as `seq` so pure re-sorts downstream
      // (oldestUnpaidMs, the statement builders) break created_at ties
      // exactly the way this ORDER BY does — a same-millisecond
      // charge/payment pair must never flip and dip the running balance.
      `select e.id, e.kind, e.amount_minor, e.job_id, e.asset_id, e.note,
              e.created_at, e.rowid as seq, e.reversal_of, j.label as job_label
         from customer_ledger_entries e
         left join jobs j on j.id = e.job_id
        where e.customer_id = ?
        order by e.created_at, e.rowid`,
      [customerId],
    )
    .map((r) => ({
      id: r.id,
      kind: r.kind as LedgerEntryKind,
      amountMinor: Number(r.amount_minor),
      createdAt: Number(r.created_at),
      seq: Number(r.seq),
      jobId: r.job_id,
      assetId: r.asset_id,
      reversalOf: r.reversal_of,
      note: r.note,
      jobLabel: r.job_label,
    }))
}

/** Every customer with their projected balance, biggest debt first —
 *  the reading order of the owed list. */
export function customersByBalance(db: SqlDriver): CustomerListRow[] {
  return db
    .all<{ id: string; name: string; phone: string | null }>(
      `select id, name, phone from customers order by name`,
    )
    .map((c) => {
      const p = projectLedger(rowsFor(db, c.id))
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        balanceMinor: p.balanceMinor,
        depositHeldMinor: p.depositHeldMinor,
      }
    })
    .sort((a, b) => b.balanceMinor - a.balanceMinor)
}

/** One customer's whole page: projection, book, linked jobs. */
export function customerView(db: SqlDriver, id: string): CustomerView | null {
  const c = db.get<{ id: string; name: string; phone: string | null }>(
    `select id, name, phone from customers where id = ?`,
    [id],
  )
  if (!c) return null
  const entries = rowsFor(db, id)
  const p = projectLedger(entries)
  const jobs = db.all<{
    id: string
    label: string | null
    status: string | null
    expected_back: string | null
  }>(
    `select j.id, j.label, j.status, j.expected_back
       from jobs j
      where j.customer_id = ?
      order by j.status = 'open' desc, j.label`,
    [id],
  )
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    balanceMinor: p.balanceMinor,
    depositHeldMinor: p.depositHeldMinor,
    entries: [...entries].reverse(),
    jobs: jobs.map((j) => ({
      id: j.id,
      label: j.label ?? 'Unnamed job',
      status: j.status ?? 'open',
      expectedBack: j.expected_back,
    })),
  }
}

/** The customer a job belongs to, or null — how a dock charge finds a khata.
 *  Reads jobs.customer_id, the real mirror column (0017/0018). */
export function customerForJob(db: SqlDriver, jobId: string): { id: string; name: string } | null {
  const row = db.get<{ id: string; name: string }>(
    `select c.id, c.name from jobs j
       join customers c on c.id = j.customer_id
      where j.id = ?`,
    [jobId],
  )
  return row ?? null
}

export interface CreateCustomerInput {
  /** Caller-supplied id, like CreateJobInput's — the store passes a uuid;
   *  tests pass readable ids. */
  id?: string
  orgId: string
  name: string
  phone?: string | null
}

/**
 * The add-customer door the year simulation ran a whole pilot without
 * (`no-add-customer`). A row, not a ceremony: customer records are not
 * evidence — the LEDGER is (0017's words) — so this is plain insert-tier
 * work, same as the server's direct-DML customers table. Returns the id,
 * or null for a blank name: a khata with no name cannot be found again,
 * and a silent empty row is how one gets lost.
 */
export function createCustomer(db: SqlDriver, input: CreateCustomerInput): string | null {
  const name = input.name.trim()
  if (name.length === 0) return null
  const id = input.id ?? `cust-${crypto.randomUUID()}`
  db.exec(
    `insert into customers (id, org_id, name, phone, note) values (?, ?, ?, ?, null)`,
    [id, input.orgId, name, input.phone?.trim() || null],
  )
  return id
}

export interface RecordEntryInput {
  orgId: string
  customerId: string
  kind: LedgerEntryKind
  /** Signed minor units — the caller states the direction explicitly. */
  amountMinor: number
  jobId?: string | null
  assetId?: string | null
  note?: string | null
  /** For kind 'reversal': the entry this line voids. */
  reversalOf?: string | null
  createdAt: number
}

/** Append one line to the book. Insert-only — there is no update path;
 *  a mistake is corrected by a further entry (a 'reversal' naming it). */
export function recordEntry(db: SqlDriver, input: RecordEntryInput): string {
  const id = `led-${crypto.randomUUID()}`
  db.exec(
    `insert into customer_ledger_entries
       (id, org_id, customer_id, kind, amount_minor, job_id, asset_id, note,
        reversal_of, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.orgId, input.customerId, input.kind, input.amountMinor,
      input.jobId ?? null, input.assetId ?? null, input.note ?? null,
      input.reversalOf ?? null, input.createdAt,
    ],
  )
  return id
}

export interface MoneyStrip {
  /** Sum of the positive balances — debts only, credits are not income. */
  owedMinor: number
  /** Balances of customers with an open job due back today: the money a
   *  finished return would put on the counter. */
  dueTodayMinor: number
  /** Charge-side entries written this month — what the month billed.
   *  ASSUMPTION: 'earned' = billed, not collected. Unvalidated wording;
   *  the pilot vendor may read it as cash in. See docs/assumptions.md */
  earnedMonthMinor: number
  /** Customers currently owing — the owed list's row count. */
  owingCount: number
}

/** The Today board's third strip, computed entirely from the local book. */
export function moneyStrip(db: SqlDriver, nowMs: number): MoneyStrip {
  const customers = customersByBalance(db)
  const owing = customers.filter((c) => c.balanceMinor > 0)

  // 'Due in today' rides on the same date the coming-back board uses, so
  // the two strips can never disagree about which day a job belongs to.
  const iso = isoDate(nowMs)
  const dueToday = new Set(
    db
      .all<{ customer_id: string }>(
        `select distinct j.customer_id from jobs j
          where j.status = 'open' and j.expected_back = ?
            and j.customer_id is not null`,
        [iso],
      )
      .map((r) => r.customer_id),
  )

  const month = monthBounds(nowMs)
  const earned = db.get<{ total: number | null }>(
    `select sum(amount_minor) as total from customer_ledger_entries
      where kind in ('charge', 'late_fee', 'damage_charge')
        and created_at >= ? and created_at < ?`,
    [month.startMs, month.endMs],
  )

  return {
    owedMinor: owing.reduce((n, c) => n + c.balanceMinor, 0),
    dueTodayMinor: owing
      .filter((c) => dueToday.has(c.id))
      .reduce((n, c) => n + c.balanceMinor, 0),
    earnedMonthMinor: Number(earned?.total ?? 0),
    owingCount: owing.length,
  }
}

export interface AssetEarnings {
  /** RENTAL money carrying this asset's id: charge + late_fee, minus
   *  anything a reversal later voided. Damage recovery is deliberately
   *  not in here — see assetEarnings. */
  earnedMinor: number
  /** Distinct jobs those lines belong to. */
  jobs: number
  replacementMinor: number | null
  /** Live repair expenses naming this unit — the kharcha book's half of
   *  the story (org_expenses, 0019). */
  repairMinor: number
  repairCount: number
  /** What the unit has COST: replacement value + repairs. Null when the
   *  replacement value is unknown — repairs alone are not "the cost of
   *  this camera", and pretending they are would invert the honesty rule
   *  (a tiny denominator makes every bar read paid-off). */
  costMinor: number | null
  /** Earned ÷ cost, or null when the cost is unknowable —
   *  no bar against a made-up denominator. */
  paybackPct: number | null
}

/**
 * What one unit has earned, from the lines that name it — and what it has
 * cost, from the expense book's rows that name it.
 *
 * DAMAGE IS NOT EARNINGS. A damage_charge stays on the customer's khata,
 * but a camera that gets broken often must not look like the fleet's best
 * performer — the payback bar celebrates rental money only (the year
 * report's `payback-counts-damage`). POLICY (owner may overrule):
 * corrected charges are out too — a line a 'reversal' later voided never
 * counts, so a charged-then-returned item does not keep phantom earnings.
 * POLICY (owner may overrule): the payback bar's DENOMINATOR is the
 * replacement value PLUS the unit's live repair costs — a camera that
 * needed a Rs 45,000 repair has genuinely cost more to keep earning, and
 * a bar that ignored that would celebrate payback the house has not had.
 * The unpriced rules hold: no replacement value on record means no bar,
 * with or without repairs. The SERVER's asset_earnings view matches the
 * earnings side (0018 D7); its cost twin is asset_cost_history (0019).
 */
export function assetEarnings(db: SqlDriver, assetId: string): AssetEarnings {
  const row = db.get<{ total: number | null; jobs: number }>(
    // count(distinct job_id) skips nulls: a line with no job still earns,
    // it just does not add a job to the 'across N jobs' count.
    `select sum(amount_minor) as total,
            count(distinct job_id) as jobs
       from customer_ledger_entries
      where asset_id = ? and kind in ('charge', 'late_fee')
        and id not in (select reversal_of from customer_ledger_entries
                        where reversal_of is not null)`,
    [assetId],
  )
  const rate = db.get<{ replacement_minor: number | null }>(
    `select r.replacement_minor from assets a
       join product_rates r on r.product_id = a.product_id
      where a.id = ?`,
    [assetId],
  )
  const earned = Number(row?.total ?? 0)
  const replacement =
    rate?.replacement_minor === null || rate?.replacement_minor === undefined
      ? null
      : Number(rate.replacement_minor)
  const costs = assetCosts(db, assetId)
  const cost = replacement === null ? null : replacement + costs.repairMinor
  return {
    earnedMinor: earned,
    jobs: Number(row?.jobs ?? 0),
    replacementMinor: replacement,
    repairMinor: costs.repairMinor,
    repairCount: costs.repairCount,
    costMinor: cost,
    paybackPct: paybackPercent(earned, cost),
  }
}

export interface ChargedButReturned {
  entryId: string
  customerId: string
  customerName: string
  kind: LedgerEntryKind
  amountMinor: number
  jobId: string
  jobLabel: string
  assetId: string
  assetCode: string
  assetName: string
}

/**
 * Charges whose item CAME BACK — the dock's "charged, then it turned up
 * on the other truck" case (pinned end to end in stress-money.test.mjs).
 *
 * POLICY (owner may overrule): this is a NEEDS-A-DECISION notice, never an
 * auto-reverse. A charge/damage_charge naming an asset and a job, not yet
 * corrected by a reversal, whose asset was scanned in AFTER the charge was
 * written, surfaces on the khata and the session summary with a one-tap
 * correction DRAFT — the reversal is written only when the owner confirms,
 * because "we keep the money anyway" (a genuinely lost accessory inside,
 * a negotiated settlement) is a real answer only a person can give.
 */
export function chargedButReturned(db: SqlDriver): ChargedButReturned[] {
  const reversed = new Set(
    db
      .all<{ reversal_of: string }>(
        `select reversal_of from customer_ledger_entries
          where reversal_of is not null`,
      )
      .map((r) => r.reversal_of),
  )
  const rows = db.all<{
    id: string
    customer_id: string
    customer_name: string
    kind: string
    amount_minor: number
    job_id: string
    job_label: string | null
    asset_id: string
    asset_code: string | null
    asset_name: string | null
    created_at: number
  }>(
    `select e.id, e.customer_id, c.name as customer_name, e.kind,
            e.amount_minor, e.job_id, j.label as job_label, e.asset_id,
            a.asset_code, coalesce(p.display_name, a.display_name) as asset_name,
            e.created_at
       from customer_ledger_entries e
       join customers c on c.id = e.customer_id
       left join jobs j on j.id = e.job_id
       join assets a on a.id = e.asset_id
       left join products p on p.id = a.product_id
      where e.kind in ('charge', 'damage_charge')
        and e.asset_id is not null and e.job_id is not null
      order by e.created_at, e.rowid`,
  )
  if (rows.length === 0) return []

  // "Came back" means a check_in scan recorded STRICTLY AFTER the charge —
  // the ordinary flow (gear home first, rental charged at the desk after)
  // must never cry wolf.
  const ops = decodeScanOps(db)
  const out: ChargedButReturned[] = []
  for (const r of rows) {
    if (reversed.has(r.id)) continue
    const cameBack = ops.some(
      (op) =>
        op.assetId === r.asset_id &&
        op.eventType === 'check_in' &&
        op.createdAt > Number(r.created_at),
    )
    if (!cameBack) continue
    out.push({
      entryId: r.id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      kind: r.kind as LedgerEntryKind,
      amountMinor: Number(r.amount_minor),
      jobId: r.job_id,
      jobLabel: r.job_label ?? 'Unnamed job',
      assetId: r.asset_id,
      assetCode: r.asset_code ?? '—',
      assetName: r.asset_name ?? 'Unnamed',
    })
  }
  return out
}

/**
 * Write the correction the notice drafted: a `reversal` naming the charge.
 * POLICY (owner may overrule): runs only from the owner's confirm tap —
 * nothing calls this automatically. Refuses a second reversal of the same
 * entry, so a double-tap cannot flip the correction into a discount.
 */
export function recordReversalOf(
  db: SqlDriver,
  orgId: string,
  entryId: string,
  note: string | null,
  whenMs: number,
): boolean {
  const e = db.get<{
    customer_id: string
    amount_minor: number
    job_id: string | null
    asset_id: string | null
  }>(
    `select customer_id, amount_minor, job_id, asset_id
       from customer_ledger_entries where id = ?`,
    [entryId],
  )
  if (!e) return false
  const already = db.get<{ one: number }>(
    `select 1 as one from customer_ledger_entries where reversal_of = ?`,
    [entryId],
  )
  if (already) return false
  recordEntry(db, {
    orgId,
    customerId: e.customer_id,
    kind: 'reversal',
    amountMinor: -Number(e.amount_minor),
    jobId: e.job_id,
    assetId: e.asset_id,
    note,
    reversalOf: entryId,
    createdAt: whenMs,
  })
  return true
}

export interface LateFeeDraftView {
  daysLate: number
  dueLabel: string
  perDay: MoneyTotal
  draft: MoneyTotal
}

/**
 * The late-fee draft for an overdue return — priced from the RETURN, never
 * from whatever happens to still be out.
 *
 * The dock's natural order — the tech scans everything in, THEN the desk
 * opens the charge sheet — used to collapse the draft to an unpriced zero,
 * because it priced off "still out on this job" and the scan-in had just
 * emptied that set. The owner saw no number exactly when he needed one,
 * and nothing said the order of operations mattered.
 *
 * The draft now prices the union of what is still out and what CAME BACK
 * in the job's most recent return session (the session knows), and the
 * days-late clock freezes at the moment the last item was scanned home —
 * a fee drafted an hour after the return must not keep growing while the
 * sheet sits open at the desk. Still a DRAFT: the owner edits and
 * confirms; nothing here writes.
 */
export function lateFeeDraftFor(
  db: SqlDriver,
  jobId: string,
  nowMs: number,
): LateFeeDraftView | null {
  const job = openJob(db, jobId)
  if (!job) return null
  if (!customerForJob(db, jobId)) return null

  const outIds = db
    .all<{ id: string }>(
      `select id from assets
        where current_job_id = ? and presence in ('out', 'in_transit')`,
      [jobId],
    )
    .map((r) => r.id)

  // What the most recent return session brought home, and when.
  const rec = lastSessionRecord(db, jobId)
  const returned: string[] = []
  let returnedAt: number | null = null
  if (rec && rec.mode === 'in') {
    for (const op of decodeScanOps(db)) {
      if (op.sessionId !== rec.id || op.eventType !== 'check_in' || !op.assetId) continue
      returned.push(op.assetId)
      returnedAt = Math.max(returnedAt ?? 0, op.createdAt)
    }
  }

  // Frozen at the return once everything is home; live while gear is out.
  const clockMs = outIds.length === 0 && returnedAt !== null ? returnedAt : nowMs
  const due = dueStatus(job.expectedBack, clockMs)
  if (due.state !== 'overdue' || !due.daysLate) return null

  const rates = [...new Set([...outIds, ...returned])].map((id) => {
    const r = db.get<{ day_rate_minor: number | null }>(
      `select (${DEFAULT_CARD_RATE_SQL}) as day_rate_minor from assets a where a.id = ?`,
      [id],
    )
    return r?.day_rate_minor === null || r?.day_rate_minor === undefined
      ? null
      : Number(r.day_rate_minor)
  })
  return {
    daysLate: due.daysLate,
    dueLabel: due.label,
    perDay: lateFeeDraft(1, rates),
    draft: lateFeeDraft(due.daysLate, rates),
  }
}

/** Local YYYY-MM-DD, same shape expected_back mirrors. */
export function isoDate(nowMs: number): string {
  const d = new Date(nowMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Persist the shortages of an answered kit list — one row per short line,
 * qty = the units that could NOT be offered. Called at the moment the
 * answer is USED (reply copied, or a job made from it), because a pasted
 * list the owner abandons was a draft, not a turned-away client.
 */
export function recordTurnedAway(
  db: SqlDriver,
  lines: {
    productId?: string | null
    wanted: number
    onHand: number
    state: string
    /** Units confirmed to bookings over the asked window (0 or absent
     *  when the enquiry carried no dates). */
    confirmedOverlap?: number
    /** 'committed' when the shelf could have filled it but the calendar
     *  could not — counted separately (year finding
     *  turnaway-blind-to-commitments). */
    shortReason?: 'short' | 'committed' | null
  }[],
  nowMs: number,
): number {
  const date = isoDate(nowMs)
  let recorded = 0
  db.transaction(() => {
    for (const l of lines) {
      if (!l.productId) continue
      if (l.state !== 'short' && l.state !== 'none') continue
      const free = Math.max(0, l.onHand - (l.confirmedOverlap ?? 0))
      const qty = Math.max(0, l.wanted - free)
      if (qty === 0) continue
      db.exec(
        `insert into demand_log (id, product_id, qty, date, reason) values (?, ?, ?, ?, ?)`,
        [`dem-${crypto.randomUUID()}`, l.productId, qty, date, l.shortReason ?? 'short'],
      )
      recorded++
    }
  })
  return recorded
}

/** The month's turned-away units split by why: the shelf was short, or
 *  the calendar had already promised it. Its own reader so the plain
 *  {times, units} shape above stays what every existing caller expects. */
export function turnedAwayByReason(
  db: SqlDriver,
  productId: string,
  nowMs: number,
): { short: number; committed: number } {
  const month = monthBounds(nowMs)
  const rows = db.all<{ reason: string; units: number | null }>(
    `select reason, sum(qty) as units from demand_log
      where product_id = ? and date >= ? and date < ?
      group by reason`,
    [productId, isoDate(month.startMs), isoDate(month.endMs)],
  )
  const out = { short: 0, committed: 0 }
  for (const r of rows) {
    if (r.reason === 'committed') out.committed += Number(r.units ?? 0)
    else out.short += Number(r.units ?? 0)
  }
  return out
}

/** How many times this product was turned away this month: incidents and
 *  units, so the page can say both honestly. */
export function turnedAwayThisMonth(
  db: SqlDriver,
  productId: string,
  nowMs: number,
): { times: number; units: number } {
  const month = monthBounds(nowMs)
  const row = db.get<{ times: number; units: number | null }>(
    `select count(*) as times, sum(qty) as units from demand_log
      where product_id = ? and date >= ? and date < ?`,
    [productId, isoDate(month.startMs), isoDate(month.endMs)],
  )
  return { times: Number(row?.times ?? 0), units: Number(row?.units ?? 0) }
}

// ------------------------------------------------------ the fast-lane flags

/** The deposit ladder (0025 D10). ASSUMPTION: see docs/assumptions.md#deposit-hint */
export type DepositHintKind = 'refuse' | 'lighter' | 'standard' | 'full'

/**
 * The phone's mirror of customer_quote_flags (0025 D10) — the same
 * shape, the same ladder: {verified, cleanHistory, blacklisted, fastLane,
 * cleanCompletedJobs, depositHint}. ONE home; the quote sheet and the
 * network wave both read it.
 */
export interface QuoteFlags {
  customerId: string
  name: string
  verified: boolean
  cleanHistory: boolean
  blacklisted: boolean
  fastLane: boolean
  cleanCompletedJobs: number
  depositHint: DepositHintKind
}

/**
 * The verified-client stamp, derived locally. The server reads
 * verified_customers (0017: a live verified credential, at least one
 * completed rental with no money shortfall, nothing currently short); the
 * phone carries no credential rows and no dispatch rows, so
 * ASSUMPTION #local-quote-flags: `verified` is the one local flag the
 * confirm gate already reads (#local-credential-flag), and a job is
 * "clean" when it is closed and its ledger lines (charges and payments
 * carrying its id, deposits aside) net to nothing owed. The server re-runs
 * its own view when the quote is replayed. See
 * docs/assumptions.md#local-quote-flags
 */
export function quoteFlags(db: SqlDriver, customerId: string): QuoteFlags | null {
  const c = db.get<{ id: string; name: string; blacklisted: number; credentials_verified: number }>(
    `select id, name, blacklisted, credentials_verified from customers where id = ?`,
    [customerId],
  )
  if (!c) return null
  const jobs = db.all<{ id: string; status: string | null; owed: number | null }>(
    `select j.id, j.status,
            (select sum(e.amount_minor) from customer_ledger_entries e
              where e.job_id = j.id and e.customer_id = j.customer_id
                and e.kind not in ('deposit_hold', 'deposit_apply', 'deposit_refund')) as owed
       from jobs j where j.customer_id = ?`,
    [customerId],
  )
  const cleanCompletedJobs = jobs.filter((j) => j.status === 'closed' && Number(j.owed ?? 0) <= 0).length
  const noOpenShortfall = !jobs.some((j) => Number(j.owed ?? 0) > 0)
  const verified = Number(c.credentials_verified) === 1
  const blacklisted = Number(c.blacklisted) === 1
  const fastLane = verified && !blacklisted && cleanCompletedJobs >= 1 && noOpenShortfall
  // ASSUMPTION: the deposit ladder. See docs/assumptions.md#deposit-hint
  const depositHint: DepositHintKind = blacklisted ? 'refuse'
    : fastLane ? 'lighter'
    : verified ? 'standard'
    : 'full'
  return {
    customerId: c.id,
    name: c.name,
    verified,
    cleanHistory: cleanCompletedJobs >= 1 && noOpenShortfall,
    blacklisted,
    fastLane,
    cleanCompletedJobs,
    depositHint,
  }
}

// --------------------------------------------------------------- settings

const PAYMENT_LINE_KEY = 'payment_line'
const PAYMENT_QR_KEY = 'payment_qr'

export function getSetting(db: SqlDriver, key: string): string | null {
  const row = db.get<{ value: string | null }>(
    `select value from app_settings where key = ?`,
    [key],
  )
  return row?.value ?? null
}

export function setSetting(db: SqlDriver, key: string, value: string | null): void {
  if (value === null || value.trim().length === 0) {
    db.exec(`delete from app_settings where key = ?`, [key])
    return
  }
  db.exec(
    `insert into app_settings (key, value) values (?, ?)
     on conflict(key) do update set value = excluded.value`,
    [key, value],
  )
}

/** 'JazzCash: 0300 1234567' — or null; the documents omit the line then. */
export function paymentLine(db: SqlDriver): string | null {
  return getSetting(db, PAYMENT_LINE_KEY)
}

export function setPaymentLine(db: SqlDriver, value: string | null): void {
  setSetting(db, PAYMENT_LINE_KEY, value)
}

/** The payment QR as a data URL, or null. Stored locally; never uploaded. */
export function paymentQr(db: SqlDriver): string | null {
  return getSetting(db, PAYMENT_QR_KEY)
}

export function setPaymentQr(db: SqlDriver, dataUrl: string | null): void {
  setSetting(db, PAYMENT_QR_KEY, dataUrl)
}

// ----------------------------------------------------------------- labels

/**
 * The money documents' words, from the active string table. A function of
 * the table rather than of STR directly so the tests can render the card
 * in BOTH languages without stubbing localStorage.
 */
export function khataLabels(str: StrTable): KhataStrings {
  return {
    balanceTitle: str.customerCardTitle,
    statementTitle: str.customerStatementTitle,
    balanceLine: str.customerCardBalanceLine,
    closingLine: str.customerStatementClosingLine,
    nothingOwed: str.customerNothingOwed,
    houseOwes: str.customerHouseOwes,
    owedSince: str.customerOwedSince,
    kindLabel: (kind) => str.customerKindLabel(kind),
    nothingThisMonth: str.customerNothingThisMonth,
  }
}

/** Charge-side kinds, re-exported for screens that classify rows. */
export { CHARGE_KINDS }
