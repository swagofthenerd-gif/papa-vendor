import { CHARGE_KINDS, projectLedger, type LedgerEntryKind, type SqlDriver } from '@papa/core'
import { decodeScanOps, stillOutCount } from './read-model.ts'
import { customerView, recordEntry } from './khata.ts'
import { NAMES, defaultIds, enqueueOp, type QueueIds } from './ops.ts'

/**
 * Deposits — the security money in the drawer, and the three doors it
 * moves through (migration 0017 D4: `hold_deposit` / `apply_deposit` /
 * `refund_deposit`; year finding `no-deposit-door`).
 *
 * THE LEDGER IS STILL THE MONEY. Each of the three writes one ledger line
 * — a positive `deposit_hold`, a negative `deposit_apply`, a negative
 * `deposit_refund` — and `projectLedger` remains the only arithmetic:
 * held money is the customer's money sitting in the house's drawer, so it
 * has its own pot and never touches the balance, except that an APPLY
 * moves a rupee out of the pot and onto the debt in the same line
 * (@papa/core ledger.ts). The `deposits` row this module keeps beside
 * those lines is STATE, not money: how much came in, how much has been
 * spent against charges, whether the remainder went back.
 *
 * TAKING A DEPOSIT IS A PAST FACT — the cash or the cheque is in the
 * drawer — so all three work with no server, by the CONTRIBUTING rule.
 * Each queues the RPC it replays as, the phone's `dep-…` riding beside the
 * hold's arguments as `client_deposit_id` (the server's reply renames it —
 * dispatch.ts's ID_REPLY_RULES), and the apply and the refund chained
 * behind whatever op last named the deposit, so a deposit taken in a
 * basement and spent an hour later reaches the server in that order. The
 * ledger lines themselves queue NOTHING: the server writes them inside
 * the deposit RPCs, and a second op would be a second row.
 *
 * THE REFUND GATE IS THE POINT (override 15: "the most direct money-loss
 * path in the plan"). The server refuses a refund while the linked job is
 * not QC-clear and names every blocker. The phone must say the same thing
 * BEFORE the tap, not after — `refundBlockers` below is the local mirror
 * of `job_money_shortfalls`, honest about the half it cannot see.
 */

export type DepositState = 'held' | 'partially_applied' | 'refunded'

export interface DepositRow {
  id: string
  customerId: string
  jobId: string | null
  jobLabel: string | null
  amountMinor: number
  appliedMinor: number
  refundedMinor: number | null
  state: DepositState
  note: string | null
  heldAt: number
  /** What is left to apply or refund — amount less what is already spent. */
  remainingMinor: number
}

function rowsWhere(db: SqlDriver, where: string, params: (string | number)[]): DepositRow[] {
  return db
    .all<{
      id: string
      customer_id: string
      job_id: string | null
      job_label: string | null
      amount_minor: number
      applied_minor: number
      refunded_minor: number | null
      state: string
      note: string | null
      held_at: number
    }>(
      `select d.id, d.customer_id, d.job_id, j.label as job_label,
              d.amount_minor, d.applied_minor, d.refunded_minor, d.state,
              d.note, d.held_at
         from deposits d
         left join jobs j on j.id = d.job_id
        ${where}
        order by d.held_at, d.rowid`,
      params,
    )
    .map((r) => {
      const amount = Number(r.amount_minor)
      const applied = Number(r.applied_minor)
      return {
        id: r.id,
        customerId: r.customer_id,
        jobId: r.job_id,
        jobLabel: r.job_label,
        amountMinor: amount,
        appliedMinor: applied,
        refundedMinor: r.refunded_minor === null ? null : Number(r.refunded_minor),
        state: r.state as DepositState,
        note: r.note,
        heldAt: Number(r.held_at),
        remainingMinor: r.state === 'refunded' ? 0 : amount - applied,
      }
    })
}

/** One customer's deposits, oldest first — the khata's deposit section. */
export function depositsFor(db: SqlDriver, customerId: string): DepositRow[] {
  return rowsWhere(db, 'where d.customer_id = ?', [customerId])
}

/** One deposit, or null. */
export function depositRow(db: SqlDriver, id: string): DepositRow | null {
  return rowsWhere(db, 'where d.id = ?', [id])[0] ?? null
}

// --------------------------------------------------------------- the gate

/** One reason a refund is refused, in the server's own vocabulary. */
export interface RefundBlocker {
  reason: 'gear_still_out' | 'no_return_recorded' | 'damage_unresolved'
  /** How many items the reason counts — the number the sentence carries. */
  count: number
}

/**
 * The refund gate, locally — the mirror of the server's
 * `job_money_shortfalls` (0017 D6) over the facts this phone holds.
 *
 * Empty means "nothing this phone knows about blocks it". Three of the
 * server's reasons are derivable here:
 *
 *   gear_still_out     — the projection still puts items on the job. The
 *                        same predicate `closeJob` refuses on, so the two
 *                        can never disagree (one home per rule).
 *   no_return_recorded — gear went out on this job and no check_in for it
 *                        has been recorded on this phone.
 *   damage_unresolved  — something was flagged under this job and the unit
 *                        is still not health='ok'.
 *
 * The server's other three (an open dispatch, a return counted short, a
 * bulk-assumed return, an open count-discrepancy alert) read tables the
 * phone does not carry, and the desk is told so out loud: the sheet says
 * the server checks again, so a refund that looks clear here can still be
 * refused there — which parks one card, not a lost rupee.
 */
export function refundBlockers(db: SqlDriver, jobId: string | null): RefundBlocker[] {
  if (!jobId) return []
  const out: RefundBlocker[] = []

  const stillOut = stillOutCount(db, jobId)
  if (stillOut > 0) out.push({ reason: 'gear_still_out', count: stillOut })

  const ops = decodeScanOps(db).filter((o) => o.jobId === jobId)
  const went = new Set(ops.filter((o) => o.eventType === 'check_out').map((o) => o.assetId))
  const came = new Set(ops.filter((o) => o.eventType === 'check_in').map((o) => o.assetId))
  if (went.size > 0 && came.size === 0) {
    out.push({ reason: 'no_return_recorded', count: went.size })
  }

  const flagged = new Set(
    ops
      .filter((o) =>
        o.eventType === 'flag_damage' ||
        o.eventType === 'quarantine' ||
        o.eventType === 'send_to_service')
      .map((o) => o.assetId)
      .filter((id): id is string => id !== null),
  )
  const unhealthy = [...flagged].filter((id) => {
    const a = db.get<{ health: string | null }>(`select health from assets where id = ?`, [id])
    return (a?.health ?? 'ok') !== 'ok'
  })
  if (unhealthy.length > 0) {
    out.push({ reason: 'damage_unresolved', count: unhealthy.length })
  }

  return out
}

// -------------------------------------------------------------- the writes

export interface HoldDepositInput {
  /** Caller-supplied id, like RecordEntryInput's — tests pass readable ids. */
  id?: string
  orgId: string
  customerId: string
  /** Minor units, POSITIVE — a deposit is held as a positive amount. */
  amountMinor: number
  /** The job the deposit secures, or null for a standing one. The refund
   *  gate reads this job; a deposit against nothing is refundable at once. */
  jobId?: string | null
  /** 'Cash' / 'Cheque held — HBL 4471' — how the money is held. */
  note?: string | null
  heldAt: number
}

/**
 * Take a deposit. Returns the deposit's id, or null for a non-positive
 * amount — the server refuses one too, and a zero-rupee deposit is a
 * record of nothing.
 */
export function holdDeposit(
  db: SqlDriver,
  input: HoldDepositInput,
  ids: QueueIds = defaultIds(input.heldAt),
): string | null {
  if (!Number.isFinite(input.amountMinor) || input.amountMinor <= 0) return null
  const amount = Math.round(input.amountMinor)
  const id = input.id ?? `dep-${crypto.randomUUID()}`
  const jobId = input.jobId ?? null
  const note = input.note?.trim() || null

  db.transaction(() => {
    db.exec(
      `insert into deposits
         (id, org_id, customer_id, job_id, amount_minor, applied_minor,
          refunded_minor, state, note, held_at, refunded_at)
       values (?, ?, ?, ?, ?, 0, null, 'held', ?, ?, null)`,
      [id, input.orgId, input.customerId, jobId, amount, note, input.heldAt],
    )
    // The line, not an op of its own: the server writes its own inside
    // hold_deposit, and recordEntry queues nothing for a deposit kind.
    recordEntry(db, {
      orgId: input.orgId,
      customerId: input.customerId,
      kind: 'deposit_hold',
      amountMinor: amount,
      jobId,
      note,
      depositId: id,
      createdAt: input.heldAt,
    }, ids)
    if (!ids) return
    enqueueOp(db, ids, 'hold_deposit', {
      client_deposit_id: id,
      p_customer_id: input.customerId,
      p_amount_minor: amount,
      p_job_id: jobId,
      p_note: note,
    }, [...NAMES.customer(input.customerId), ...NAMES.job(jobId)])
  })
  return id
}

export type ApplyDepositResult =
  | { ok: true; entryId: string; remainingMinor: number }
  | { ok: false; reason: 'not_found' | 'not_applicable' | 'over_remaining'; remainingMinor: number }

/**
 * Spend held money against what the customer owes — the one line that does
 * both halves (0017 D4): the pot drops and the balance drops, same rupee.
 * Refused above what is left, exactly as the server refuses it, so a
 * double-tap cannot apply the same deposit twice.
 */
export function applyDeposit(
  db: SqlDriver,
  input: {
    orgId: string
    depositId: string
    amountMinor: number
    note?: string | null
    whenMs: number
  },
  ids: QueueIds = defaultIds(input.whenMs),
): ApplyDepositResult {
  const d = depositRow(db, input.depositId)
  if (!d) return { ok: false, reason: 'not_found', remainingMinor: 0 }
  if (d.state === 'refunded') {
    return { ok: false, reason: 'not_applicable', remainingMinor: d.remainingMinor }
  }
  const amount = Math.round(input.amountMinor)
  if (!Number.isFinite(amount) || amount <= 0 || amount > d.remainingMinor) {
    return { ok: false, reason: 'over_remaining', remainingMinor: d.remainingMinor }
  }
  const note = input.note?.trim() || null

  let entryId = ''
  db.transaction(() => {
    entryId = recordEntry(db, {
      orgId: input.orgId,
      customerId: d.customerId,
      kind: 'deposit_apply',
      amountMinor: -amount,
      jobId: d.jobId,
      note,
      depositId: d.id,
      createdAt: input.whenMs,
    }, ids)
    db.exec(
      `update deposits
          set applied_minor = applied_minor + ?, state = 'partially_applied'
        where id = ?`,
      [amount, d.id],
    )
    if (!ids) return
    enqueueOp(db, ids, 'apply_deposit', {
      client_deposit_id: d.id,
      p_deposit_id: d.id,
      p_amount_minor: amount,
      p_note: note,
    }, NAMES.deposit(d.id))
  })
  return { ok: true, entryId, remainingMinor: d.remainingMinor - amount }
}

export type RefundDepositResult =
  | { ok: true; entryId: string; refundedMinor: number }
  | { ok: false; reason: 'not_found' | 'already_refunded' | 'nothing_left' }
  | { ok: false; reason: 'job_not_clear'; blockers: RefundBlocker[] }

/**
 * Give the remainder back — the terminal transition, owner/manager on the
 * server (override 17) and gated there by the job's shortfalls. The gate is
 * re-run HERE so the desk can read the reason on the screen instead of
 * hearing it as a parked card an hour later; the server's verdict is still
 * the law.
 */
export function refundDeposit(
  db: SqlDriver,
  input: { orgId: string; depositId: string; note?: string | null; whenMs: number },
  ids: QueueIds = defaultIds(input.whenMs),
): RefundDepositResult {
  const d = depositRow(db, input.depositId)
  if (!d) return { ok: false, reason: 'not_found' }
  if (d.state === 'refunded') return { ok: false, reason: 'already_refunded' }
  if (d.remainingMinor <= 0) return { ok: false, reason: 'nothing_left' }

  const blockers = refundBlockers(db, d.jobId)
  if (blockers.length > 0) return { ok: false, reason: 'job_not_clear', blockers }

  const note = input.note?.trim() || null
  const remaining = d.remainingMinor
  let entryId = ''
  db.transaction(() => {
    entryId = recordEntry(db, {
      orgId: input.orgId,
      customerId: d.customerId,
      kind: 'deposit_refund',
      amountMinor: -remaining,
      jobId: d.jobId,
      note,
      depositId: d.id,
      createdAt: input.whenMs,
    }, ids)
    db.exec(
      `update deposits
          set refunded_minor = ?, refunded_at = ?, state = 'refunded'
        where id = ?`,
      [remaining, input.whenMs, d.id],
    )
    if (!ids) return
    enqueueOp(db, ids, 'refund_deposit', {
      client_deposit_id: d.id,
      p_deposit_id: d.id,
      p_note: note,
    }, NAMES.deposit(d.id))
  })
  return { ok: true, entryId, refundedMinor: remaining }
}

export interface ApplyTargets {
  /** Everything the customer owes right now — the usual answer, capped at
   *  what is still held so the sheet can never offer more than it has. */
  balanceMinor: number
  /** The live charge-side lines on the deposit's own job, newest first —
   *  "put it against the damage, not against the whole account". Empty for
   *  a standing deposit with no job. */
  charges: { id: string; kind: LedgerEntryKind; amountMinor: number; note: string | null }[]
}

/**
 * What a deposit can be applied TO — the sheet's own choices, derived here
 * rather than in the screen so the rule is assertable under Node.
 *
 * A settled line (reversed or written off) is not a bill any more, so it is
 * not offered; the balance is the projection the page already shows.
 */
export function applyTargets(db: SqlDriver, depositId: string): ApplyTargets {
  const d = depositRow(db, depositId)
  if (!d) return { balanceMinor: 0, charges: [] }
  const view = customerView(db, d.customerId)
  if (!view) return { balanceMinor: 0, charges: [] }
  const charges = d.jobId === null
    ? []
    : view.entries.filter(
        (e) => e.jobId === d.jobId && CHARGE_KINDS.has(e.kind) && !view.settled.has(e.id),
      )
  return {
    balanceMinor: Math.max(0, Math.min(view.balanceMinor, d.remainingMinor)),
    charges: charges.map((e) => ({
      id: e.id,
      kind: e.kind,
      amountMinor: e.amountMinor,
      note: e.note ?? null,
    })),
  }
}

/** The pot as the ledger projects it, for a screen that wants the one
 *  number beside the rows — the same projection the balance uses, so the
 *  section head and the tally can never disagree. */
export function depositHeldMinor(db: SqlDriver, customerId: string): number {
  const entries = db.all<{ kind: string; amount_minor: number; created_at: number }>(
    `select kind, amount_minor, created_at from customer_ledger_entries
      where customer_id = ? order by created_at, rowid`,
    [customerId],
  )
  return projectLedger(
    entries.map((e) => ({
      kind: e.kind as Parameters<typeof projectLedger>[0][number]['kind'],
      amountMinor: Number(e.amount_minor),
      createdAt: Number(e.created_at),
    })),
  ).depositHeldMinor
}
