import {
  liveExpenses,
  monthBounds,
  totalExpenses,
  type ExpenseKind,
  type ExpenseView,
  type SqlDriver,
} from '@papa/core'
import { NAMES, defaultIds, enqueueOp, type OpIds } from './ops.ts'

/**
 * The expense book's read model — the kharcha queries, in a plain .ts
 * module like khata.ts and hisaab.ts so every rule here is assertable
 * under plain Node against a real SQLite.
 *
 * WHAT WRITES LOOK LIKE. `recordExpense` is the only write and it is an
 * INSERT; `reverseExpense` voids a row by inserting a further row that
 * names it (void-pair semantics — see @papa/core expenses.ts). Money the
 * house paid out is a PAST FACT, so by the CONTRIBUTING offline rule
 * everything here works with no server; the server twin is migration
 * 0019's org_expenses and its RPCs — and since W11 each insert queues
 * that RPC (`record_expense` / `reverse_expense`, the 0024 shape with
 * `p_booking_id` and `p_spent_at`) with the row's phone-minted id as
 * `client_expense_id`, chained behind the last op naming the job, the
 * booking, the unit or the row it reverses (ops.ts).
 *
 * MONTH BOUNDARIES ARE THE DEVICE'S CALENDAR (monthBounds — the PKT month
 * the vendor means), computed here at read time from the raw rows. The
 * server's monthly_profit view buckets coarsely by UTC server_time and
 * says so; this module is where the vendor's own month is honest.
 */

export interface ExpenseRow extends ExpenseView {
  assetId: string | null
  jobId: string | null
  /** The booking this cost belongs to (0024 D9). */
  bookingId: string | null
  counterparty: string | null
  note: string | null
  reversalOf: string | null
  /** Joined for display; null when the link is absent. */
  assetCode: string | null
  jobLabel: string | null
}

function rowsWhere(db: SqlDriver, where: string, params: (string | number)[]): ExpenseRow[] {
  return db
    .all<{
      id: string
      kind: string
      amount_minor: number
      asset_id: string | null
      job_id: string | null
      booking_id: string | null
      counterparty: string | null
      note: string | null
      reversal_of: string | null
      created_at: number
      asset_code: string | null
      job_label: string | null
    }>(
      `select e.id, e.kind, e.amount_minor, e.asset_id, e.job_id, e.booking_id,
              e.counterparty, e.note, e.reversal_of, e.created_at,
              a.asset_code, j.label as job_label
         from org_expenses e
         left join assets a on a.id = e.asset_id
         left join jobs j on j.id = e.job_id
        ${where}
        order by e.created_at, e.rowid`,
      params,
    )
    .map((r) => ({
      id: r.id,
      kind: r.kind as ExpenseKind,
      amountMinor: Number(r.amount_minor),
      createdAt: Number(r.created_at),
      assetId: r.asset_id,
      jobId: r.job_id,
      bookingId: r.booking_id,
      counterparty: r.counterparty,
      note: r.note,
      reversalOf: r.reversal_of,
      assetCode: r.asset_code,
      jobLabel: r.job_label,
    }))
}

/** The whole book, oldest first. Reversed pairs still load — the filter is
 *  the reader's job (liveExpenses), same as the ledger's supersession. */
export function expenseRows(db: SqlDriver): ExpenseRow[] {
  return rowsWhere(db, '', [])
}

export interface RecordExpenseInput {
  /** Caller-supplied id, like RecordEntryInput's — tests pass readable ids. */
  id?: string
  orgId: string
  kind: ExpenseKind
  /** Minor units, POSITIVE — an expense is money that left. */
  amountMinor: number
  assetId?: string | null
  jobId?: string | null
  /** The booking this cost belongs to (0024 D9) — nets out of its quote. */
  bookingId?: string | null
  counterparty?: string | null
  note?: string | null
  /** Backdatable — "paid the workshop last Tuesday, recording it now". */
  createdAt: number
}

/** `null` = no op: the server mints this row inside ANOTHER op that
 *  follows (record_sub_hire_in's expense). See khata.ts QueueIds. */
export type QueueIds = OpIds | null

/** Append one line to the expense book. Returns the id, or null for a
 *  non-positive amount: a zero-rupee expense is a record of nothing, and
 *  a negative one is a reversal wearing a costume. The op rides the
 *  row's own clock as `p_spent_at`, so a backdated bill is backdated on
 *  the server too. */
export function recordExpense(
  db: SqlDriver,
  input: RecordExpenseInput,
  ids: QueueIds = defaultIds(input.createdAt),
): string | null {
  if (!Number.isFinite(input.amountMinor) || input.amountMinor <= 0) return null
  const id = input.id ?? `exp-${crypto.randomUUID()}`
  const amount = Math.round(input.amountMinor)
  const counterparty = input.counterparty?.trim() || null
  const note = input.note?.trim() || null
  db.transaction(() => {
    db.exec(
      `insert into org_expenses
         (id, org_id, kind, amount_minor, asset_id, job_id, booking_id, counterparty, note,
          reversal_of, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
      [
        id, input.orgId, input.kind, amount,
        input.assetId ?? null, input.jobId ?? null, input.bookingId ?? null,
        counterparty, note, input.createdAt,
      ],
    )
    if (!ids) return
    enqueueOp(db, ids, 'record_expense', {
      client_expense_id: id,
      p_kind: input.kind,
      p_amount_minor: amount,
      p_asset_id: input.assetId ?? null,
      p_job_id: input.jobId ?? null,
      p_counterparty: counterparty,
      p_note: note,
      p_spent_at: new Date(input.createdAt).toISOString(),
      p_booking_id: input.bookingId ?? null,
    }, [
      ...NAMES.job(input.jobId),
      ...NAMES.booking(input.bookingId),
      ...NAMES.asset(input.assetId),
    ])
  })
  return id
}

/**
 * Void one expense, forward-only: a reversal row copying the target's kind,
 * amount and links, so no caller can mis-copy them — the exact shape of the
 * server's reverse_expense. Refuses a second reversal of the same row and
 * a reversal of a reversal; a double-tap cannot over-credit the house.
 */
export function reverseExpense(
  db: SqlDriver,
  orgId: string,
  expenseId: string,
  note: string | null,
  whenMs: number,
  ids: OpIds = defaultIds(whenMs),
): boolean {
  const t = db.get<{
    kind: string
    amount_minor: number
    asset_id: string | null
    job_id: string | null
    booking_id: string | null
    counterparty: string | null
    reversal_of: string | null
  }>(
    `select kind, amount_minor, asset_id, job_id, booking_id, counterparty, reversal_of
       from org_expenses where id = ?`,
    [expenseId],
  )
  if (!t || t.reversal_of !== null) return false
  const already = db.get<{ one: number }>(
    `select 1 as one from org_expenses where reversal_of = ?`,
    [expenseId],
  )
  if (already) return false
  const id = `exp-${crypto.randomUUID()}`
  db.transaction(() => {
    db.exec(
      `insert into org_expenses
         (id, org_id, kind, amount_minor, asset_id, job_id, booking_id, counterparty, note,
          reversal_of, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, orgId, t.kind, Number(t.amount_minor),
        t.asset_id, t.job_id, t.booking_id, t.counterparty, note?.trim() || null,
        expenseId, whenMs,
      ],
    )
    // The server copies the target's links itself (0024 reverse_expense);
    // the op names only the target — behind the op that created it.
    enqueueOp(db, ids, 'reverse_expense', {
      client_expense_id: id,
      p_expense_id: expenseId,
      p_note: note?.trim() || null,
    }, NAMES.expense(expenseId))
  })
  return true
}

export interface KharchaSlice {
  /** The window's live expenses, oldest first. */
  rows: ExpenseRow[]
  totalMinor: number
}

/** What the house spent inside [startMs, endMs) — live rows only. The
 *  hisaab passes its own dayBounds; this module owns no calendar. */
export function kharchaBetween(
  db: SqlDriver,
  startMs: number,
  endMs: number,
): KharchaSlice {
  // The live filter runs over the WHOLE book, not the window's slice: a
  // reversal written today must void a row written yesterday.
  const rows = liveExpenses(expenseRows(db)).filter(
    (e) => e.createdAt >= startMs && e.createdAt < endMs,
  )
  return { rows, totalMinor: rows.reduce((n, e) => n + e.amountMinor, 0) }
}

export interface MonthProfit {
  monthLabel: string
  /** Live charge-side ledger lines this month — what the month billed,
   *  minus anything a reversal voided (a charged-then-returned item is
   *  not income; the asset_earnings precedent). */
  earnedMinor: number
  /** Live expenses this month. */
  spentMinor: number
  /** earned − spent. Negative months read as the honest loss they are. */
  profitMinor: number
  /** How many live expense rows the month holds — the empty state's fact. */
  expenseCount: number
}

/**
 * The month's bottom line, from the two sides of the local book — the
 * vendor's-dream question ("what did the month actually make") as one
 * read. Month boundary = the device's calendar month (monthBounds),
 * computed here where it is rendered; see the module note.
 */
export function monthProfit(db: SqlDriver, nowMs: number): MonthProfit {
  const month = monthBounds(nowMs)
  const earned = db.get<{ total: number | null }>(
    `select sum(amount_minor) as total from customer_ledger_entries
      where kind in ('charge', 'late_fee', 'damage_charge')
        and created_at >= ? and created_at < ?
        and id not in (select reversal_of from customer_ledger_entries
                        where reversal_of is not null)`,
    [month.startMs, month.endMs],
  )
  const spent = liveExpenses(expenseRows(db)).filter(
    (e) => e.createdAt >= month.startMs && e.createdAt < month.endMs,
  )
  const earnedMinor = Number(earned?.total ?? 0)
  const spentMinor = spent.reduce((n, e) => n + e.amountMinor, 0)
  return {
    monthLabel: month.label,
    earnedMinor,
    spentMinor,
    profitMinor: earnedMinor - spentMinor,
    expenseCount: spent.length,
  }
}

export interface JobMargin {
  /** Live charge-side ledger lines naming the job. */
  incomeMinor: number
  /** Live expenses naming the job — the sub-hire that rescued it — or
   *  the booking it was born from (W11). */
  expenseMinor: number
  marginMinor: number
  expenseCount: number
}

/**
 * What one job actually made — mirrors the server's job_margin view
 * (0019, widened by 0028). A cost tagged to the BOOKING the job came from
 * counts too, when it names no other job: the desk borrows at the
 * enquiry, before the job exists, and tags the bill to the pencil; the
 * job the pencil becomes must see it (was the year's wall
 * `subhire-cost-unlinkable`; `booking_sub_hire_cost` already read both
 * links from the booking's side).
 */
export function jobMargin(db: SqlDriver, jobId: string): JobMargin {
  const income = db.get<{ total: number | null }>(
    `select sum(amount_minor) as total from customer_ledger_entries
      where job_id = ? and kind in ('charge', 'late_fee', 'damage_charge')
        and id not in (select reversal_of from customer_ledger_entries
                        where reversal_of is not null)`,
    [jobId],
  )
  const bookingId = db.get<{ booking_id: string | null }>(
    `select booking_id from jobs where id = ?`, [jobId],
  )?.booking_id ?? null
  const rows = liveExpenses(expenseRows(db)).filter(
    (e) => e.jobId === jobId || (e.jobId === null && bookingId !== null && e.bookingId === bookingId),
  )
  const incomeMinor = Number(income?.total ?? 0)
  const expenseMinor = rows.reduce((n, e) => n + e.amountMinor, 0)
  return {
    incomeMinor,
    expenseMinor,
    marginMinor: incomeMinor - expenseMinor,
    expenseCount: rows.length,
  }
}

export interface AssetCosts {
  /** Live repair expenses naming the unit. */
  repairMinor: number
  repairCount: number
  /** A live 'purchase' expense naming the unit, when one was recorded. */
  purchaseExpenseMinor: number
}

/** What one unit has COST — the other half of the payback question. */
export function assetCosts(db: SqlDriver, assetId: string): AssetCosts {
  const rows = liveExpenses(expenseRows(db)).filter((e) => e.assetId === assetId)
  const repairs = rows.filter((e) => e.kind === 'repair')
  return {
    repairMinor: repairs.reduce((n, e) => n + e.amountMinor, 0),
    repairCount: repairs.length,
    purchaseExpenseMinor: rows
      .filter((e) => e.kind === 'purchase')
      .reduce((n, e) => n + e.amountMinor, 0),
  }
}

/** Re-exported for screens that sum an arbitrary slice. */
export { liveExpenses, totalExpenses }
