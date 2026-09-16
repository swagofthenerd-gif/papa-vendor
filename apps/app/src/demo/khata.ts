import {
  CHARGE_KINDS,
  dueStatus,
  lateFeeDraft,
  monthBounds,
  projectLedger,
  SETTLED_ENTRY_IDS_SQL,
  paybackPercent,
  type DepositHint,
  type KhataStrings,
  type LedgerEntryKind,
  type LedgerEntryView,
  type MoneyTotal,
  type SqlDriver,
} from '@papa/core'
import { defaultCardRateSql, decodeScanOps, lastSessionRecord, openJob } from './read-model.ts'
import { assetCosts, billedBetween } from './kharcha.ts'
import { NAMES, defaultIds, enqueueOp, type QueueIds } from './ops.ts'
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
 * module works with no server. Since W11 every insert here also queues
 * the server's own door (`record_payment` / `record_ledger_entry`, 0017/
 * 0018; `create_customer`, 0028) with the row's phone-minted id riding as
 * `client_*`, chained behind whatever op last named the customer, the job
 * or the line it reverses (ops.ts) — so a khata written in a basement
 * lands on the server in the order the desk wrote it.
 */

export interface CustomerListRow {
  id: string
  name: string
  phone: string | null
  balanceMinor: number
  depositHeldMinor: number
  /** The do-not-rent stamp, on the list as well as the page (W13): the
   *  owed list is where the desk looks before calling a client back. */
  blacklisted: boolean
}

export interface LedgerRow extends LedgerEntryView {
  id: string
  jobId: string | null
  assetId: string | null
  reversalOf: string | null
  /** The earlier line this one supersedes (the server's own column). */
  correctsEntryId: string | null
  /** The deposit this line belongs to — the three deposit kinds only. */
  depositId: string | null
}

/**
 * A line and the line that settled it, as ONE story (W13, the
 * `no-adjustment-door` and `waived-fee-invisible` doors).
 *
 * The book stays append-only and both rows stay in `entries` — the client
 * saw both happen, and every projection still sums both. This is the
 * READING: the corrected line is struck through and the settlement's own
 * words sit under it, so a correction is never two mystery rows the owner
 * has to pair up in his head. `kind` is the settling line's kind, which is
 * the whole vocabulary: 'reversal' undid it, 'write_off' forgave it.
 */
export interface Settled {
  /** The settling line's id — the row a screen does NOT render on its own. */
  byId: string
  kind: LedgerEntryKind
  amountMinor: number
  note: string | null
  createdAt: number
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
  /** Settled line id → the line that settled it (reversal or write-off).
   *  The page renders the pair as one row; both are still in `entries`. */
  settled: Map<string, Settled>
  /** The do-not-rent decision (W13): the flag 0022's confirm gate reads,
   *  with the sentence the desk wrote beside it. */
  blacklisted: boolean
  blacklistReason: string | null
  blacklistedAt: number | null
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
      corrects_entry_id: string | null
      deposit_id: string | null
      job_label: string | null
    }>(
      // rowid rides along as `seq` so pure re-sorts downstream
      // (oldestUnpaidMs, the statement builders) break created_at ties
      // exactly the way this ORDER BY does — a same-millisecond
      // charge/payment pair must never flip and dip the running balance.
      `select e.id, e.kind, e.amount_minor, e.job_id, e.asset_id, e.note,
              e.created_at, e.rowid as seq, e.reversal_of, e.corrects_entry_id,
              e.deposit_id, j.label as job_label
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
      correctsEntryId: r.corrects_entry_id,
      depositId: r.deposit_id,
      note: r.note,
      jobLabel: r.job_label,
    }))
}

/**
 * Which lines were settled by which, from the two links the server owns:
 * `reversal_of` (a reversal voided it) and `corrects_entry_id` (a
 * write-off forgave it, a later line superseded it). Keyed by the SETTLED
 * line's id — one home for the pairing, read by the khata page, the
 * lifetime-value view and the waiver read alike.
 */
export function settlements(entries: LedgerRow[]): Map<string, Settled> {
  const present = new Set(entries.map((e) => e.id))
  const out = new Map<string, Settled>()
  for (const e of entries) {
    const target = e.reversalOf ?? e.correctsEntryId
    if (!target || !present.has(target)) continue
    // First settlement wins: a second row naming the same line is refused
    // at every write side, so this can only be old or synced data — and a
    // line that reads as settled twice reads as nothing at all.
    if (out.has(target)) continue
    out.set(target, {
      byId: e.id,
      kind: e.kind,
      amountMinor: e.amountMinor,
      note: e.note ?? null,
      createdAt: e.createdAt,
    })
  }
  return out
}

/** Every customer with their projected balance, biggest debt first —
 *  the reading order of the owed list. */
export function customersByBalance(db: SqlDriver): CustomerListRow[] {
  return db
    .all<{ id: string; name: string; phone: string | null; blacklisted: number }>(
      `select id, name, phone, blacklisted from customers order by name`,
    )
    .map((c) => {
      const p = projectLedger(rowsFor(db, c.id))
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        balanceMinor: p.balanceMinor,
        depositHeldMinor: p.depositHeldMinor,
        blacklisted: Number(c.blacklisted) === 1,
      }
    })
    .sort((a, b) => b.balanceMinor - a.balanceMinor)
}

/** One customer's whole page: projection, book, linked jobs. */
export function customerView(db: SqlDriver, id: string): CustomerView | null {
  const c = db.get<{
    id: string
    name: string
    phone: string | null
    blacklisted: number
    blacklist_reason: string | null
    blacklisted_at: number | null
  }>(
    `select id, name, phone, blacklisted, blacklist_reason, blacklisted_at
       from customers where id = ?`,
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
    settled: settlements(entries),
    blacklisted: Number(c.blacklisted) === 1,
    blacklistReason: c.blacklist_reason,
    blacklistedAt: c.blacklisted_at === null ? null : Number(c.blacklisted_at),
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
export function createCustomer(
  db: SqlDriver,
  input: CreateCustomerInput,
  ids: QueueIds = defaultIds(Date.now()),
): string | null {
  const name = input.name.trim()
  if (name.length === 0) return null
  const id = input.id ?? `cust-${crypto.randomUUID()}`
  const phone = input.phone?.trim() || null
  db.transaction(() => {
    db.exec(
      `insert into customers (id, org_id, name, phone, note) values (?, ?, ?, ?, null)`,
      [id, input.orgId, name, phone],
    )
    // The server's door (0028 create_customer) — nothing before it, so the
    // op stands alone; the ledger lines and jobs that follow chain here.
    if (ids) {
      enqueueOp(db, ids, 'create_customer', {
        client_customer_id: id,
        p_name: name,
        p_phone: phone,
      }, [])
    }
  })
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
  /** The earlier line this one supersedes without voiding it — the server's
   *  `corrects_entry_id` (0017). A waived late fee's write-off names the fee
   *  here, because the server allows `p_reversal_of` on 'reversal' alone
   *  and a forgiven fee is a decision, not an error. */
  correctsEntryId?: string | null
  /** For the three deposit kinds: the `deposits` row the line belongs to
   *  (deposits.ts). The server's own link, and only deposit kinds carry it. */
  depositId?: string | null
  createdAt: number
}

/** Deposit lines move only through the server's hold/apply/refund state
 *  machine (0017 D4), which writes its own ledger row inside each RPC — so
 *  a deposit line on the phone queues NO op of its own: the deposit op
 *  (deposits.ts) is what carries it, and a second op would be a second row. */
const DEPOSIT_KINDS: ReadonlySet<string> = new Set(['deposit_hold', 'deposit_apply', 'deposit_refund'])

/**
 * Append one line to the book. Insert-only — there is no update path;
 * a mistake is corrected by a further entry (a 'reversal' naming it).
 *
 * The op (W11): a payment goes to `record_payment` (the positive amount
 * received — the server stores the negative fact, exactly as this row
 * does); everything else to `record_ledger_entry` with the SIGNED amount
 * the row carries and, for a reversal, `p_reversal_of`. The server's row
 * is stamped with its own clock: a backdated `createdAt` stays the
 * phone's day until the money lane syncs back (ASSUMPTION #ledger-server-time,
 * docs/assumptions.md#ledger-server-time). Chained behind the last op
 * naming the customer, the job, or the line reversed.
 */
export function recordEntry(
  db: SqlDriver,
  input: RecordEntryInput,
  ids: QueueIds = defaultIds(input.createdAt),
): string {
  const id = `led-${crypto.randomUUID()}`
  db.transaction(() => {
    db.exec(
      `insert into customer_ledger_entries
         (id, org_id, customer_id, kind, amount_minor, job_id, asset_id, note,
          reversal_of, corrects_entry_id, deposit_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.orgId, input.customerId, input.kind, input.amountMinor,
        input.jobId ?? null, input.assetId ?? null, input.note ?? null,
        input.reversalOf ?? null, input.correctsEntryId ?? null,
        input.depositId ?? null, input.createdAt,
      ],
    )
    if (!ids || DEPOSIT_KINDS.has(input.kind)) return
    const named = [
      ...NAMES.customer(input.customerId),
      ...NAMES.job(input.jobId),
      ...NAMES.ledgerEntry(input.reversalOf),
      ...NAMES.ledgerEntry(input.correctsEntryId),
    ]
    if (input.kind === 'payment') {
      enqueueOp(db, ids, 'record_payment', {
        client_ledger_entry_id: id,
        p_customer_id: input.customerId,
        p_amount_minor: Math.abs(input.amountMinor),
        p_job_id: input.jobId ?? null,
        p_note: input.note ?? null,
      }, named)
      return
    }
    enqueueOp(db, ids, 'record_ledger_entry', {
      client_ledger_entry_id: id,
      p_customer_id: input.customerId,
      p_entry_kind: input.kind,
      p_amount_minor: input.amountMinor,
      p_job_id: input.jobId ?? null,
      p_asset_id: input.assetId ?? null,
      p_note: input.note ?? null,
      p_reversal_of: input.reversalOf ?? null,
      p_corrects_entry_id: input.correctsEntryId ?? null,
    }, named)
  })
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

  // What the month billed — the SAME read the hisaab's bottom line uses
  // (kharcha.ts billedBetween), so the board and the month's statement
  // can never disagree about the figure. Live lines only: a reversed
  // charge was never income, and neither was a late fee the owner waived.
  const month = monthBounds(nowMs)

  return {
    owedMinor: owing.reduce((n, c) => n + c.balanceMinor, 0),
    dueTodayMinor: owing
      .filter((c) => dueToday.has(c.id))
      .reduce((n, c) => n + c.balanceMinor, 0),
    earnedMonthMinor: billedBetween(db, month.startMs, month.endMs),
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
        and id not in (${SETTLED_ENTRY_IDS_SQL})`,
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
  // SETTLED, not merely reversed — the WHOLE rule (SETTLED_ENTRY_IDS_SQL),
  // which counts a write-off as well as a reversal. Reading only
  // `reversal_of` left a charge that had been WRITTEN OFF still offering
  // "charged, then it came back — Reverse?": the tap called reverseEntry,
  // the ledger refused it as already settled, nothing was written and the
  // card came back unarmed. A button that can never do anything is worse
  // than no button, because the owner keeps pressing it.
  // The union takes its column name from its first branch, so the rows
  // come back as `reversal_of` whichever half matched.
  const settled = new Set(
    db
      .all<{ reversal_of: string }>(SETTLED_ENTRY_IDS_SQL)
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
    if (settled.has(r.id)) continue
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

// ------------------------------------ W13: the correction door (0018 D6)

/**
 * Why a line cannot be settled. Every one of these is the phone refusing
 * BEFORE the write, matching what the server would say — a refusal the
 * desk can read is worth more than a parked card an hour later.
 */
export type SettleRefusal =
  | 'not_found'
  /** A reason is the point: override 18 says the owner's judgement is
   *  never fought and always RECORDED, and the server's own
   *  ledger_override_has_reason constraint refuses a note-less write-off. */
  | 'no_reason'
  | 'already_settled'
  /** A reversal or a write-off is itself a settlement; settling one would
   *  be a correction of a correction, which reads as nothing at all. */
  | 'is_settlement'
  /** Deposit money moves only through hold/apply/refund (0017 D4). */
  | 'deposit_line'

export type SettleResult =
  | { ok: true; id: string }
  | { ok: false; reason: SettleRefusal }

const SETTLEMENT_KINDS: ReadonlySet<string> = new Set(['reversal', 'write_off', 'adjustment'])

/** The five checks both doors share, and the target's own facts. */
function settleTarget(
  db: SqlDriver,
  entryId: string,
  reason: string | null,
):
  | { ok: true; row: { customerId: string; amountMinor: number; jobId: string | null; assetId: string | null }; note: string }
  | { ok: false; reason: SettleRefusal } {
  const note = (reason ?? '').trim()
  if (note.length === 0) return { ok: false, reason: 'no_reason' }
  const e = db.get<{
    customer_id: string
    kind: string
    amount_minor: number
    job_id: string | null
    asset_id: string | null
    deposit_id: string | null
  }>(
    `select customer_id, kind, amount_minor, job_id, asset_id, deposit_id
       from customer_ledger_entries where id = ?`,
    [entryId],
  )
  if (!e) return { ok: false, reason: 'not_found' }
  if (e.deposit_id !== null) return { ok: false, reason: 'deposit_line' }
  if (SETTLEMENT_KINDS.has(e.kind)) return { ok: false, reason: 'is_settlement' }
  const already = db.get<{ one: number }>(
    `select 1 as one from customer_ledger_entries
      where reversal_of = ? or corrects_entry_id = ?`,
    [entryId, entryId],
  )
  if (already) return { ok: false, reason: 'already_settled' }
  return {
    ok: true,
    note,
    row: {
      customerId: e.customer_id,
      amountMinor: Number(e.amount_minor),
      jobId: e.job_id,
      assetId: e.asset_id,
    },
  }
}

/**
 * "Correct this" — a `reversal` naming the line, negating it exactly
 * (0018 D6). The line the desk got wrong: a double-tapped charge, a
 * payment that bounced, a charge for an item that turned up.
 *
 * POLICY (owner may overrule): runs only from the owner's confirm tap —
 * nothing calls this automatically. Refuses a second settlement of the
 * same entry, so a double-tap cannot flip the correction into a discount.
 * The amount is COPIED from the target and negated here, so no caller can
 * mis-type it — the same discipline reverseExpense keeps.
 */
export function correctEntry(
  db: SqlDriver,
  input: { orgId: string; entryId: string; reason: string | null; whenMs: number },
  ids: QueueIds = defaultIds(input.whenMs),
): SettleResult {
  const t = settleTarget(db, input.entryId, input.reason)
  if (!t.ok) return t
  const id = recordEntry(db, {
    orgId: input.orgId,
    customerId: t.row.customerId,
    kind: 'reversal',
    amountMinor: -t.row.amountMinor,
    jobId: t.row.jobId,
    assetId: t.row.assetId,
    note: t.note,
    reversalOf: input.entryId,
    createdAt: input.whenMs,
  }, ids)
  return { ok: true, id }
}

/**
 * "Write it off" — debt the house has GIVEN UP collecting, which is not
 * the same act as a correction and must never print as one (ledger.ts: a
 * write-off is goodwill or an absconded client; an adjustment is a data
 * fix). The line is named through `corrects_entry_id`, the server's own
 * forward-pointing link, because `record_ledger_entry` allows
 * `p_reversal_of` on kind 'reversal' alone.
 *
 * Refused for a line the customer does not owe on: writing off a payment
 * would hand the client money they never asked for.
 */
export function writeOffEntry(
  db: SqlDriver,
  input: { orgId: string; entryId: string; reason: string | null; whenMs: number },
  ids: QueueIds = defaultIds(input.whenMs),
): SettleResult {
  const t = settleTarget(db, input.entryId, input.reason)
  if (!t.ok) return t
  if (t.row.amountMinor <= 0) return { ok: false, reason: 'is_settlement' }
  const id = recordEntry(db, {
    orgId: input.orgId,
    customerId: t.row.customerId,
    kind: 'write_off',
    amountMinor: -t.row.amountMinor,
    jobId: t.row.jobId,
    assetId: t.row.assetId,
    note: t.note,
    correctsEntryId: input.entryId,
    createdAt: input.whenMs,
  }, ids)
  return { ok: true, id }
}

/**
 * Write the correction a charged-then-returned notice drafted. The older,
 * narrower door, kept as the notice's one-tap: same machinery, the app's
 * own words as the reason.
 */
export function recordReversalOf(
  db: SqlDriver,
  orgId: string,
  entryId: string,
  note: string | null,
  whenMs: number,
): boolean {
  return correctEntry(db, { orgId, entryId, reason: note, whenMs }, defaultIds(whenMs)).ok
}

/**
 * "Waive it" — the drafted late fee the owner chooses NOT to charge
 * (year papercut `waived-fee-invisible`: SEP forgave eleven days on the
 * documentary and nothing recorded the goodwill, so next quarter nobody
 * remembered Ayesha had already had her favour).
 *
 * THE HONEST SHAPE, chosen between the two the brief allowed: the fee is
 * WRITTEN and then WRITTEN OFF, one transaction, two lines that net to
 * nothing. The alternatives are both worse. A write-off alone would
 * credit the client money they were never charged — the balance would go
 * negative by the size of the favour. An `adjustment` would move the
 * balance too and would print as the house correcting its own error,
 * which a waiver is not: the fee was right, and the house chose not to
 * take it. The pair is what actually happened, and the khata reads it as
 * one story ("Rs 4,000 late fee — waived on 12 Sep") because the
 * write-off names the fee through `corrects_entry_id`.
 *
 * The balance is unchanged, the earned-money sums drop the fee (a waived
 * fee never earned anything — SETTLED_ENTRY_IDS_SQL), and both lines are
 * on the statement the client reads, which is the point: the goodwill is
 * visible to the person who received it.
 */
export function waiveLateFee(
  db: SqlDriver,
  input: {
    orgId: string
    jobId: string
    /** The drafted figure, minor units, positive — the owner's number. */
    amountMinor: number
    reason: string | null
    whenMs: number
  },
  ids: QueueIds = defaultIds(input.whenMs),
): SettleResult {
  const reason = (input.reason ?? '').trim()
  if (reason.length === 0) return { ok: false, reason: 'no_reason' }
  const customer = customerForJob(db, input.jobId)
  if (!customer) return { ok: false, reason: 'not_found' }
  const amount = Math.round(input.amountMinor)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'not_found' }

  let feeId = ''
  db.transaction(() => {
    feeId = recordEntry(db, {
      orgId: input.orgId,
      customerId: customer.id,
      kind: 'late_fee',
      amountMinor: amount,
      jobId: input.jobId,
      note: reason,
      createdAt: input.whenMs,
    }, ids)
    recordEntry(db, {
      orgId: input.orgId,
      customerId: customer.id,
      kind: 'write_off',
      amountMinor: -amount,
      jobId: input.jobId,
      note: reason,
      correctsEntryId: feeId,
      createdAt: input.whenMs,
    }, ids)
  })
  return { ok: true, id: feeId }
}

export interface WaivedFee {
  /** The fee line — the amount the client did not pay. */
  entryId: string
  customerId: string
  amountMinor: number
  jobId: string | null
  jobLabel: string | null
  reason: string | null
  /** When the waiver was written. */
  waivedAt: number
}

/**
 * Fees this customer was forgiven — a `late_fee` settled by a
 * `write_off`. No new table: the pair IS the record, and this is the
 * read that lets a screen say it in one sentence ("Rs 4,000 late fee —
 * waived on 12 Sep") next quarter, when the same client asks again.
 */
export function waivedFees(db: SqlDriver, customerId: string): WaivedFee[] {
  const entries = rowsFor(db, customerId)
  const settled = settlements(entries)
  const out: WaivedFee[] = []
  for (const e of entries) {
    const s = settled.get(e.id)
    if (!s || e.kind !== 'late_fee' || s.kind !== 'write_off') continue
    out.push({
      entryId: e.id,
      customerId,
      amountMinor: e.amountMinor,
      jobId: e.jobId,
      jobLabel: e.jobLabel ?? null,
      reason: s.note,
      waivedAt: s.createdAt,
    })
  }
  return out
}

// ------------------- W13: what this client has been worth (`no-lifetime-value-view`)

export interface LifetimeValue {
  /** Live charge-side money ever written on this khata — what the house
   *  billed them, with anything reversed or waived left out. */
  chargedMinor: number
  /** Money received, all time. */
  paidMinor: number
  /** Debt the house gave up on money it was actually owed — the honest
   *  other column, and a real loss. */
  writtenOffMinor: number
  /** Fees the house chose never to insist on: a write-off that cancels the
   *  LATE FEE it names (`corrects_entry_id` → a `late_fee` entry), whether
   *  that is the waiver door or a fee forgiven later. Kept APART from writtenOffMinor because the two are different
   *  facts about a client — a courtesy costs the house nothing it ever had,
   *  a write-off is money chased and lost — and because the charge side
   *  excludes a waived fee (SETTLED_ENTRY_IDS_SQL), so counting waivers as
   *  written off printed "billed Rs 55,000, written off Rs 234,000": more
   *  forgiven than was ever charged, which is not a sentence about this
   *  client that anyone can read. */
  waivedMinor: number
  /** Money held as security right now (the pot, not the balance). */
  depositHeldMinor: number
  /** Distinct jobs the money touched. NOT the jobs table's count: a job
   *  with no money on it earned the house nothing, and this number is
   *  about worth. */
  jobs: number
  /** The first and last money this khata ever saw, epoch ms — null on an
   *  empty book. The book's own dates, not a jobs-table guess. */
  firstAt: number | null
  lastAt: number | null
  /** charged ÷ jobs, or null with no jobs — never a zero-denominator
   *  average dressed up as 'Rs 0'. */
  averageJobMinor: number | null
}

/**
 * What this client has been worth (year finding
 * `no-lifetime-value-view`: "sitting in the entries every khata page
 * already loads; the owed list just doesn't show it").
 *
 * Every figure is a sum over the append-only book — no new table, no
 * stored total, nothing that can drift. The charge side uses the one
 * settled rule (SETTLED_ENTRY_IDS_SQL), so a reversed charge and a
 * waived fee are not "worth": the house never had that money.
 *
 * THE HONEST LIMIT, said on the screen: this is what THIS PHONE's book
 * knows. A khata that predates the app, or a ledger that has not synced
 * back, is a shorter history than the client's real one — the numbers
 * are a floor, not a lifetime.
 */
export function lifetimeValue(db: SqlDriver, customerId: string): LifetimeValue {
  const row = db.get<{
    charged: number | null
    paid: number | null
    written_off: number | null
    waived: number | null
    jobs: number
    first_at: number | null
    last_at: number | null
  }>(
    `select
       (select sum(e.amount_minor) from customer_ledger_entries e
         where e.customer_id = ? and e.kind in ('charge', 'late_fee', 'damage_charge')
           and e.id not in (${SETTLED_ENTRY_IDS_SQL})) as charged,
       (select sum(-e.amount_minor) from customer_ledger_entries e
         where e.customer_id = ? and e.kind = 'payment') as paid,
       -- The two give-ups, told apart by WHAT was forgiven, not by whether
       -- the write-off names a line: a line write-off names its charge too.
       -- A late fee let go is a courtesy; a charge or a damage bill given
       -- up is money the house worked for and lost, and so is a balance
       -- write-off (which names nothing).
       (select sum(-e.amount_minor) from customer_ledger_entries e
         where e.customer_id = ? and e.kind = 'write_off'
           and (e.corrects_entry_id is null or exists (
             select 1 from customer_ledger_entries t
              where t.id = e.corrects_entry_id and t.kind <> 'late_fee'))) as written_off,
       (select sum(-e.amount_minor) from customer_ledger_entries e
         where e.customer_id = ? and e.kind = 'write_off'
           and exists (select 1 from customer_ledger_entries t
             where t.id = e.corrects_entry_id and t.kind = 'late_fee')) as waived,
       (select count(distinct e.job_id) from customer_ledger_entries e
         where e.customer_id = ? and e.job_id is not null
           and e.kind in ('charge', 'late_fee', 'damage_charge')
           and e.id not in (${SETTLED_ENTRY_IDS_SQL})) as jobs,
       (select min(e.created_at) from customer_ledger_entries e
         where e.customer_id = ?) as first_at,
       (select max(e.created_at) from customer_ledger_entries e
         where e.customer_id = ?) as last_at`,
    [customerId, customerId, customerId, customerId, customerId, customerId, customerId],
  )
  const charged = Number(row?.charged ?? 0)
  const jobs = Number(row?.jobs ?? 0)
  const p = projectLedger(rowsFor(db, customerId))
  return {
    chargedMinor: charged,
    paidMinor: Number(row?.paid ?? 0),
    writtenOffMinor: Number(row?.written_off ?? 0),
    waivedMinor: Number(row?.waived ?? 0),
    depositHeldMinor: p.depositHeldMinor,
    jobs,
    firstAt: row?.first_at === null || row?.first_at === undefined ? null : Number(row.first_at),
    lastAt: row?.last_at === null || row?.last_at === undefined ? null : Number(row.last_at),
    averageJobMinor: jobs === 0 ? null : Math.round(charged / jobs),
  }
}

// --------------------------- W13: the do-not-rent decision (0029)

export type BlacklistResult =
  | { ok: true; blacklisted: boolean }
  | { ok: false; reason: 'not_found' | 'no_reason' }

/**
 * "Do not rent to this client" — the switch the gate never had (year
 * finding `no-blacklist`).
 *
 * 0022 D9's confirm gate has refused a blacklisted customer since W5 and
 * `customers.blacklisted` has existed since 0017, but nothing could set
 * it: FEB's absconded client and the day-14 rung's "consider a
 * blacklist" both ended in a shrug. The door is 0029's
 * `set_customer_blacklisted`, owner/manager on the server and audited
 * there.
 *
 * A REASON IS REQUIRED to switch it on and not to lift it: refusing a
 * person future business is the decision that needs a sentence beside it
 * (override 18), while letting them back in refuses nobody. The server
 * keeps the reason in the audit log — the column is a boolean — so the
 * phone keeps its own copy for the stamp to say out loud.
 *
 * ASSUMPTION: the flag is local and sent, like credentials_verified; a
 * second phone learns it when customers sync, which they do not yet.
 * See docs/assumptions.md#local-blacklist-flag
 */
export function setBlacklisted(
  db: SqlDriver,
  input: { customerId: string; on: boolean; reason: string | null; whenMs: number },
  ids: QueueIds = defaultIds(input.whenMs),
): BlacklistResult {
  const reason = (input.reason ?? '').trim() || null
  if (input.on && reason === null) return { ok: false, reason: 'no_reason' }
  const c = db.get<{ blacklisted: number }>(
    `select blacklisted from customers where id = ?`, [input.customerId],
  )
  if (!c) return { ok: false, reason: 'not_found' }

  db.transaction(() => {
    db.exec(
      `update customers
          set blacklisted = ?, blacklist_reason = ?, blacklisted_at = ?
        where id = ?`,
      [
        input.on ? 1 : 0,
        input.on ? reason : null,
        input.on ? input.whenMs : null,
        input.customerId,
      ],
    )
    if (!ids) return
    enqueueOp(db, ids, 'set_customer_blacklisted', {
      p_customer_id: input.customerId,
      p_on: input.on,
      p_reason: reason,
    }, NAMES.customer(input.customerId))
  })
  return { ok: true, blacklisted: input.on }
}

/**
 * "Write off what's owed" — the WHOLE outstanding balance, given up.
 *
 * The line-scoped door above forgives one charge; this one forgives an
 * ACCOUNT, and it exists because the ledger is a running account: a
 * payment is not allocated to a charge, so after Rs 40,000 paid against
 * Rs 78,000 billed there is no such thing as "the unpaid lines". What
 * the desk actually decides on an absconded client is "we are not
 * chasing the Rs 38,000", and that is one write-off naming no line.
 *
 * Refused when nothing is owed — writing off a zero (or a credit) would
 * hand the client money. A reason is required, like every settlement.
 */
export function writeOffBalance(
  db: SqlDriver,
  input: { orgId: string; customerId: string; reason: string | null; whenMs: number },
  ids: QueueIds = defaultIds(input.whenMs),
): SettleResult {
  const reason = (input.reason ?? '').trim()
  if (reason.length === 0) return { ok: false, reason: 'no_reason' }
  const view = customerView(db, input.customerId)
  if (!view) return { ok: false, reason: 'not_found' }
  if (view.balanceMinor <= 0) return { ok: false, reason: 'already_settled' }
  const id = recordEntry(db, {
    orgId: input.orgId,
    customerId: input.customerId,
    kind: 'write_off',
    amountMinor: -view.balanceMinor,
    note: reason,
    createdAt: input.whenMs,
  }, ids)
  return { ok: true, id }
}

export interface DuplicateEntry {
  /** The SECOND line — the one a correction would settle. */
  entryId: string
  firstId: string
  customerId: string
  customerName: string
  kind: LedgerEntryKind
  amountMinor: number
  /** How far apart the two were written, in seconds. */
  secondsApart: number
}

/**
 * The double-tap guard, as a NOTICE rather than a refusal (year finding
 * `no-adjustment-door`, second half: "same customer + amount + kind
 * within a few seconds is a confirmable duplicate, not a silent second
 * line").
 *
 * A write is never blocked — the dock's charge sheet must not argue with
 * a person who says the client owes it twice, and two identical charges
 * genuinely happen (two cracked filters). But two identical charge-side
 * lines on one khata within `withinMs` are worth a question, so the pair
 * surfaces on the page with the ordinary one-tap correction behind it,
 * exactly like the charged-then-returned notice. Settled lines are out:
 * a corrected duplicate is a story that finished.
 *
 * ASSUMPTION: 20 seconds is the double-tap window. Unvalidated — a desk
 * that enters two real charges a few seconds apart would see one extra
 * question. See docs/assumptions.md#duplicate-window
 */
export const DUPLICATE_WINDOW_MS = 20_000

export function duplicateEntries(
  db: SqlDriver,
  withinMs: number = DUPLICATE_WINDOW_MS,
): DuplicateEntry[] {
  const rows = db.all<{
    id: string
    customer_id: string
    customer_name: string
    kind: string
    amount_minor: number
    created_at: number
  }>(
    `select e.id, e.customer_id, c.name as customer_name, e.kind,
            e.amount_minor, e.created_at
       from customer_ledger_entries e
       join customers c on c.id = e.customer_id
      where e.kind in ('charge', 'late_fee', 'damage_charge')
        and e.id not in (${SETTLED_ENTRY_IDS_SQL})
      order by e.customer_id, e.kind, e.amount_minor, e.created_at, e.rowid`,
  )
  const out: DuplicateEntry[] = []
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    if (a.customer_id !== b.customer_id || a.kind !== b.kind) continue
    if (Number(a.amount_minor) !== Number(b.amount_minor)) continue
    const gap = Number(b.created_at) - Number(a.created_at)
    if (gap < 0 || gap > withinMs) continue
    out.push({
      entryId: b.id,
      firstId: a.id,
      customerId: b.customer_id,
      customerName: b.customer_name,
      kind: b.kind as LedgerEntryKind,
      amountMinor: Number(b.amount_minor),
      secondsApart: Math.round(gap / 1000),
    })
  }
  return out
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
      `select (${defaultCardRateSql('a.product_id')}) as day_rate_minor from assets a where a.id = ?`,
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
 * ASSUMPTION: local only — the server has no demand table. See
 * docs/assumptions.md#local-only-writes
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
  /** The deposit ladder (0025 D10). ASSUMPTION: see docs/assumptions.md#deposit-hint */
  depositHint: DepositHint
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
  const depositHint: DepositHint = blacklisted ? 'refuse'
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
