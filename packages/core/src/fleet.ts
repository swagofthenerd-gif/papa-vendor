import type { SqlDriver } from './db/driver.ts'
import { Outbox } from './outbox.ts'
import { projectOp } from './project.ts'

/**
 * The fleet lifecycle — the offline write side of terminal states and the
 * crisis-day swap (migration 0020; docs/year-in-the-life.md findings
 * `no-terminal-asset-state`, `no-swap-flow`).
 *
 * THE RULE THIS FILE OBEYS, same as scan.ts: zero network, optimistic write,
 * append-only queue. Marking gear lost/stolen/sold and swapping a substitute
 * onto a live job are PAST FACTS the owner is recording — offline-safe by the
 * CONTRIBUTING rule — so they enqueue scan ops and project locally exactly
 * like a scan. The server (submit_scan_batch, fifth edition) re-checks the
 * owner/manager gate; on the demo there is no server, and the projection is
 * the whole truth until one exists.
 *
 * EVERY MOVEMENT IS A REAL scan_events VERB. mark_lost / mark_stolen /
 * mark_sold join the 0003 vocabulary; the swap is check_in + flag_damage +
 * check_out, the existing verbs, linked by a shared session and by the
 * payload cross-references the server's swap_asset mints. Nothing here
 * invents a new kind of record — the evidence chain the log exists to be
 * stays intact.
 */

export type Disposition = 'lost' | 'stolen' | 'sold' | 'retired'

/** The event verb that declares each terminal outcome. `retired` rides the
 *  existing `retire` verb (0003); the other three are the 0020 additions. */
const MARK_EVENT: Record<Disposition, string> = {
  lost: 'mark_lost',
  stolen: 'mark_stolen',
  sold: 'mark_sold',
  retired: 'retire',
}

export interface MarkTerminalInput {
  assetId: string
  disposition: Disposition
  note?: string | null
  /** For a sale: the amount, minor units. Rides the event payload — NOT a
   *  ledger or expense row (0020 D3). A sale-income book is separate
   *  follow-up; recording it here as money would be a kind in disguise. */
  saleAmountMinor?: number | null
  now?: () => number
  newId?: () => string
  deviceId?: string
}

export interface FleetOpResult {
  outboxId: string
  assetId: string
}

/**
 * Declare an item lost, stolen, sold or retired.
 *
 * One append-only op, projected optimistically: the mirror goes
 * presence='gone', stamps the disposition, and — the load-bearing line —
 * clears current_job_id, which is what finally lets a job holding a
 * never-returned item close (the October ghost-cable wall). `markFound`
 * reverses it when the cable turns up.
 */
/**
 * Enqueue one manual scan op and project it, atomically — the shared body of
 * the single-op fleet writers (markTerminal, markFound). `extra` carries the
 * per-verb fields (a sale amount, say); `note` is trimmed and dropped when
 * empty. The append-only queue and the optimistic projection are written in
 * ONE transaction here, so every caller gets that discipline for free.
 */
function enqueueScanOp(
  db: SqlDriver,
  base: { assetId: string; eventType: string; note?: string | null; extra?: Record<string, unknown> },
  ids: { now: () => number; newId: () => string },
): FleetOpResult {
  const id = ids.newId()
  const outbox = new Outbox(db, ids.now)

  const payload: Record<string, unknown> = {
    asset_id: base.assetId,
    event_type: base.eventType,
    entry_method: 'manual',
    device_time: new Date(ids.now()).toISOString(),
    ...base.extra,
  }
  const note = base.note?.trim()
  if (note) payload.note = note

  db.transaction(() => {
    outbox.enqueue({ id, op: 'submit_scan_batch', payload })
    projectOp(db, payload)
  })

  return { outboxId: id, assetId: base.assetId }
}

export function markTerminal(
  db: SqlDriver,
  input: MarkTerminalInput,
): FleetOpResult {
  const sale =
    input.disposition === 'sold' && typeof input.saleAmountMinor === 'number'
      ? { sale_amount_minor: input.saleAmountMinor }
      : undefined

  return enqueueScanOp(
    db,
    {
      assetId: input.assetId,
      eventType: MARK_EVENT[input.disposition],
      note: input.note,
      extra: sale,
    },
    {
      now: input.now ?? Date.now,
      newId: input.newId ?? (() => crypto.randomUUID()),
    },
  )
}

/**
 * Bring a terminal item home — the recovery door. A lost cable found in a
 * case lining, a stolen camera the police return, a sale that fell through:
 * `found` clears the disposition and sets presence='here'. Deliberately NOT
 * owner-gated on the server (a driver scans it back); here it is the same
 * one-op write.
 */
export function markFound(
  db: SqlDriver,
  input: { assetId: string; note?: string | null; now?: () => number; newId?: () => string },
): FleetOpResult {
  return enqueueScanOp(
    db,
    { assetId: input.assetId, eventType: 'found', note: input.note },
    {
      now: input.now ?? Date.now,
      newId: input.newId ?? (() => crypto.randomUUID()),
    },
  )
}

export interface RecordServicedInput {
  assetId: string
  note?: string | null
  /** The org_expenses repair that paid for the work, when one was recorded
   *  in the same flow — the server validates the link (0021 D2: same org,
   *  kind=repair, this asset when the expense names one). */
  expenseId?: string | null
  now?: () => number
  newId?: () => string
}

/**
 * Record that a service was performed — the reset end of the usage nudge
 * (0021 D1/D2; vendor-dream-plan Phase D1, the Hilti pattern).
 *
 * One append-only op, projected optimistically: the local meter goes back
 * to zero the moment the desk taps confirm, and the server — which gates
 * this desk-tier like a money write — re-derives the same reset from its
 * own log. Deliberately NOT a health event: quarantine/release keep their
 * own vocabulary, and a service that also silently released a quarantined
 * unit would be two decisions wearing one tap.
 */
export function recordServiced(
  db: SqlDriver,
  input: RecordServicedInput,
): FleetOpResult {
  return enqueueScanOp(
    db,
    {
      assetId: input.assetId,
      eventType: 'serviced',
      note: input.note,
      // Nested under `payload` because that is the key submit_scan_batch
      // files into scan_events.payload — where the log's view reads it.
      extra: input.expenseId ? { payload: { expense_id: input.expenseId } } : undefined,
    },
    {
      now: input.now ?? Date.now,
      newId: input.newId ?? (() => crypto.randomUUID()),
    },
  )
}

export type SwapFlag = 'flag_damage' | 'quarantine'

export interface SwapInput {
  jobId: string
  brokenAssetId: string
  substituteAssetId: string
  /** How the broken item is flagged — the existing vocabulary (0020 D5). */
  flag?: SwapFlag
  note?: string | null
  now?: () => number
  newId?: () => string
}

export type SwapResult =
  | {
      outcome: 'swapped'
      checkedInEvent: string
      flagEvent: string
      checkedOutEvent: string
    }
  | { outcome: 'not_on_job' }
  | { outcome: 'substitute_unavailable'; reason: 'terminal' | 'off_shelf' | 'unfit' }
  | { outcome: 'same_asset' }

interface SwapAssetRow {
  id: string
  presence: string
  health: string
  disposition: string | null
  current_job_id: string | null
}

/**
 * The crisis-day swap, offline — the client twin of the server's swap_asset
 * (0020 D5). One transaction, three linked ops: the broken item's check_in
 * (off the job), a flag on it, and the substitute's check_out onto the SAME
 * job, so the rental stays one job's story and the damage names the broken
 * unit. The three share a session id; the flag and the substitute checkout
 * carry depends_on so a parked check_in drags them with it, and the payloads
 * cross-reference the way the server's do.
 *
 * The refusals mirror the RPC exactly: the broken item must be out on this
 * job, and the substitute must be fit — not terminal, on the shelf, healthy,
 * rentable. Cross-org cannot arise on a single-org device; the server owns
 * that check.
 */
export function swapAsset(db: SqlDriver, input: SwapInput): SwapResult {
  const now = input.now ?? Date.now
  const newId = input.newId ?? (() => crypto.randomUUID())
  const flag: SwapFlag = input.flag ?? 'flag_damage'
  const outbox = new Outbox(db, now)

  if (input.substituteAssetId === input.brokenAssetId) return { outcome: 'same_asset' }

  const broken = loadSwapAsset(db, input.brokenAssetId)
  if (!broken || broken.current_job_id !== input.jobId) return { outcome: 'not_on_job' }

  const sub = loadSwapAsset(db, input.substituteAssetId)
  if (!sub) return { outcome: 'substitute_unavailable', reason: 'off_shelf' }
  if (sub.disposition !== null) return { outcome: 'substitute_unavailable', reason: 'terminal' }
  if (sub.presence !== 'here') return { outcome: 'substitute_unavailable', reason: 'off_shelf' }
  if (sub.health !== 'ok') return { outcome: 'substitute_unavailable', reason: 'unfit' }
  // rentable is a server-side asset column; the local mirror does not carry
  // it (schema.ts), so unrentable substitutes are the RPC's refusal to make.

  const sessionId = newId()
  const deviceTime = new Date(now()).toISOString()
  const note = input.note?.trim() || null

  const eIn = newId()
  const eFlag = newId()
  const eOut = newId()

  const checkIn: Record<string, unknown> = {
    asset_id: input.brokenAssetId,
    event_type: 'check_in',
    entry_method: 'manual',
    job_id: input.jobId,
    session_id: sessionId,
    device_time: deviceTime,
    note,
    swap: true,
    substitute_asset_id: input.substituteAssetId,
    substitute_event_id: eOut,
  }
  const flagOp: Record<string, unknown> = {
    asset_id: input.brokenAssetId,
    event_type: flag,
    entry_method: 'manual',
    job_id: input.jobId,
    session_id: sessionId,
    device_time: deviceTime,
    note,
    implied_by_event_id: eIn,
    swap: true,
  }
  const checkOut: Record<string, unknown> = {
    asset_id: input.substituteAssetId,
    event_type: 'check_out',
    entry_method: 'manual',
    job_id: input.jobId,
    session_id: sessionId,
    device_time: deviceTime,
    note,
    implied_by_event_id: eIn,
    swap: true,
    replaces_asset_id: input.brokenAssetId,
    replaces_event_id: eIn,
  }

  db.transaction(() => {
    outbox.enqueue({ id: eIn, op: 'submit_scan_batch', payload: checkIn })
    projectOp(db, checkIn)
    // The flag depends on the check_in — it exists because the item came off
    // the job — and the substitute checkout depends on it too, so a parked
    // check_in never lets its consequences ship alone.
    outbox.enqueue({ id: eFlag, op: 'submit_scan_batch', payload: flagOp, dependsOn: eIn })
    projectOp(db, flagOp)
    outbox.enqueue({ id: eOut, op: 'submit_scan_batch', payload: checkOut, dependsOn: eIn })
    projectOp(db, checkOut)

    // projectOp does not move health (it owns presence/disposition/job only),
    // so the flag's effect on the mirror is written here — the same
    // optimistic honesty the scan path keeps: the broken item shows
    // quarantined immediately, not after a sync.
    db.exec(`update assets set health = 'quarantined' where id = ?`, [input.brokenAssetId])
  })

  return {
    outcome: 'swapped',
    checkedInEvent: eIn,
    flagEvent: eFlag,
    checkedOutEvent: eOut,
  }
}

function loadSwapAsset(db: SqlDriver, assetId: string): SwapAssetRow | undefined {
  return db.get<SwapAssetRow>(
    `select id, presence, health, disposition, current_job_id
       from assets where id = ?`,
    [assetId],
  )
}

/**
 * The cycle-count diff — the pure heart of ginti (0020 D6; the JUL stocktake
 * wall `no-cycle-count`).
 *
 * A stocktake is a DIFF: what the mirror says is on this shelf, against what
 * the tech actually scanned standing in front of it. Three buckets:
 *
 *   ok         — expected here and seen. The reassuring majority.
 *   missing    — expected on this shelf, never scanned. The owner decides
 *                found-elsewhere vs lost — this NEVER writes a terminal state
 *                (that is a judgement, 0020 D2); it only surfaces the gap.
 *   unexpected — scanned here but the mirror had it somewhere else (or gone).
 *                The stocktake found gear the system had misplaced.
 *
 * Pure set logic: expected ids in, seen ids in, three id lists out. The
 * counts written to the log (inventory_count events) are the SEEN set; the
 * missing list is a report for a human, not an auto-write.
 */
export interface CountDiff {
  ok: string[]
  missing: string[]
  unexpected: string[]
}

export function cycleCountDiff(expected: Iterable<string>, seen: Iterable<string>): CountDiff {
  const expectedSet = new Set(expected)
  const seenSet = new Set(seen)
  const ok: string[] = []
  const missing: string[] = []
  const unexpected: string[] = []

  for (const id of expectedSet) {
    if (seenSet.has(id)) ok.push(id)
    else missing.push(id)
  }
  for (const id of seenSet) {
    if (!expectedSet.has(id)) unexpected.push(id)
  }

  return { ok, missing, unexpected }
}
