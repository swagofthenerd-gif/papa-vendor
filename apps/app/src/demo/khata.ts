import {
  CHARGE_KINDS,
  monthBounds,
  projectLedger,
  paybackPercent,
  type KhataStrings,
  type LedgerEntryKind,
  type LedgerEntryView,
  type SqlDriver,
} from '@papa/core'
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
       from job_customer jc join jobs j on j.id = jc.job_id
      where jc.customer_id = ?
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

/** The customer a job belongs to, or null — how a dock charge finds a khata. */
export function customerForJob(db: SqlDriver, jobId: string): { id: string; name: string } | null {
  const row = db.get<{ id: string; name: string }>(
    `select c.id, c.name from job_customer jc
       join customers c on c.id = jc.customer_id
      where jc.job_id = ?`,
    [jobId],
  )
  return row ?? null
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
        `select distinct jc.customer_id from job_customer jc
           join jobs j on j.id = jc.job_id
          where j.status = 'open' and j.expected_back = ?`,
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
  /** Charge-side ledger money carrying this asset's id. */
  earnedMinor: number
  /** Distinct jobs those lines belong to. */
  jobs: number
  replacementMinor: number | null
  /** Earned ÷ replacement, or null when the replacement is unknown —
   *  no bar against a made-up denominator. */
  paybackPct: number | null
}

/** What one unit has earned, from the lines that name it. */
export function assetEarnings(db: SqlDriver, assetId: string): AssetEarnings {
  const row = db.get<{ total: number | null; jobs: number }>(
    // count(distinct job_id) skips nulls: a line with no job still earns,
    // it just does not add a job to the 'across N jobs' count.
    `select sum(amount_minor) as total,
            count(distinct job_id) as jobs
       from customer_ledger_entries
      where asset_id = ? and kind in ('charge', 'late_fee', 'damage_charge')`,
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
  return {
    earnedMinor: earned,
    jobs: Number(row?.jobs ?? 0),
    replacementMinor: replacement,
    paybackPct: paybackPercent(earned, replacement),
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
  lines: { productId?: string | null; wanted: number; onHand: number; state: string }[],
  nowMs: number,
): number {
  const date = isoDate(nowMs)
  let recorded = 0
  db.transaction(() => {
    for (const l of lines) {
      if (!l.productId) continue
      if (l.state !== 'short' && l.state !== 'none') continue
      const qty = Math.max(0, l.wanted - Math.max(0, l.onHand))
      if (qty === 0) continue
      db.exec(
        `insert into demand_log (id, product_id, qty, date) values (?, ?, ?, ?)`,
        [`dem-${crypto.randomUUID()}`, l.productId, qty, date],
      )
      recorded++
    }
  })
  return recorded
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
    owedSince: str.customerOwedSince,
    kindLabel: (kind) => str.customerKindLabel(kind),
    nothingThisMonth: str.customerNothingThisMonth,
  }
}

/** Charge-side kinds, re-exported for screens that classify rows. */
export { CHARGE_KINDS }
