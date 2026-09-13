import type { SqlDriver, SqlValue } from './db/driver.ts'

/**
 * The optimistic local projection — the ONLY writer of asset state on device.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE FUNCTION AND NOT TWO
 *
 * This rule was written twice: once in `ScanSession.enqueue` when a scan is
 * queued, and again in `PullApplier.replayPendingWrites` when a pull replays
 * unsent writes on top of the server's view. Two copies of "check_out means
 * presence=out, check_in means presence=here and clear the job".
 *
 * They had already drifted, in exactly the way that matters. The scan path set
 * `last_scanned_at`; the replay path did not — and `last_scanned_at` IS in the
 * pull's mirror columns. So every pull overwrote the tech's own scan timestamp
 * with the server's older one, and the replay never put it back.
 *
 * That is the "your own scan undoes itself" bug `pull.ts`'s header exists to
 * prevent, surviving in one column because the fix lived in one of two places.
 * A third event type would have landed in one copy and not the other.
 *
 * So both callers now pass the SAME SHAPE — the enqueued payload — through
 * here. There is one rule, and adding an event type is one edit.
 * ---------------------------------------------------------------------------
 */

/**
 * The subset of an enqueued op this projection reads. Deliberately the shape
 * `ScanSession` already builds and `PullApplier` already parses out of the
 * outbox, so neither caller has to translate — translation is where the two
 * copies drifted apart in the first place.
 */
export interface ProjectableOp {
  asset_id?: unknown
  event_type?: unknown
  job_id?: unknown
  device_time?: unknown
}

/**
 * Calendar days a rental touched — THE day-counting rule (0021 D1), stated
 * once for both sides of the wire: (in's date − out's date) + 1, so a
 * partial day counts as a full day and an out-and-back on one calendar day
 * counts 1. Wear is being estimated, not billed; a meter that rounds down
 * flatters the gear it exists to protect. Clock skew that puts the return
 * before the departure still counts 1 — the rental happened.
 *
 * Dates are taken in the clock that recorded the pair: the device's local
 * calendar here, the server's on the server — each side is consistent with
 * its own log, and the server's projection is the one that syncs down.
 */
export function rentalDaysBetween(outMs: number, inMs: number): number {
  const dayStart = (ms: number) => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((dayStart(inMs) - dayStart(outMs)) / 86_400_000) + 1
  return Math.max(1, days)
}

/**
 * What this check_in adds to the service meter (0021 D1): the days of the
 * out/in pair it closes, found by replaying the queue's ops for the same
 * asset and job in order — a check_out opens a pair, the next check_in
 * consumes it. A rescan echo consumes nothing (the pair is already closed)
 * and adds 0; a loose check_in with no job adds 0.
 *
 * The op is matched back to its walk position by device_time, because the
 * scan path and the pull-replay path both call projectOp per op and neither
 * hands over a queue id. Two check_ins for one asset+job stamped in the
 * same millisecond would collide; the later one wins, which mirrors the
 * walk. This is the OPTIMISTIC copy only — the server derives the same
 * rule from its own log and its count overwrites this one on every sync,
 * exactly as presence does. (Voided ops are not special-cased here: a void
 * re-derives presence, and the meter reconciles on the next pull.)
 */
function serviceDaysFor(db: SqlDriver, op: ProjectableOp, assetId: string): number {
  if (typeof op.job_id !== 'string' || typeof op.device_time !== 'string') return 0

  let pending: string | null = null
  let days = 0
  for (const row of db.all<{ payload: string }>(
    `select payload from outbox where op = 'submit_scan_batch' order by seq`,
  )) {
    let p: Record<string, unknown>
    try {
      p = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      continue
    }
    if (p.asset_id !== assetId || p.job_id !== op.job_id) continue
    if (p.event_type === 'check_out' && typeof p.device_time === 'string') {
      pending = p.device_time
    } else if (p.event_type === 'check_in') {
      const contribution = pending
        ? rentalDaysBetween(Date.parse(pending), Date.parse(String(p.device_time)))
        : 0
      pending = null
      if (p.device_time === op.device_time) days = contribution
    }
  }
  return days
}

/** Whether this asset's product counts check_out cycles (0021 D3) — the
 *  battery flag, mirrored from the server's products.count_cycles. */
function countsCycles(db: SqlDriver, assetId: string): boolean {
  const row = db.get<{ count_cycles: number | null }>(
    `select p.count_cycles from assets a
       join products p on p.id = a.product_id
      where a.id = ?`,
    [assetId],
  )
  return Number(row?.count_cycles ?? 0) === 1
}

/**
 * The events that move an asset's PRESENCE, mapped to where they leave it.
 * check_out/check_in are the everyday pair; the four fleet-lifecycle verbs
 * (0020) join them because the same rule must be written ONCE — the whole
 * reason this module exists (see the header). mark_* send it 'gone' and set
 * a disposition; `found` brings it home and clears one; `retire` retires it.
 * Everything else (move, count, flag, pack…) leaves presence alone.
 */
const PRESENCE_FOR: Record<string, string> = {
  check_out: 'out',
  check_in: 'here',
  mark_lost: 'gone',
  mark_stolen: 'gone',
  mark_sold: 'gone',
  retire: 'gone',
  found: 'here',
}

/** presence, or null when this event type does not move an asset. */
function presenceFor(eventType: unknown): string | null {
  return typeof eventType === 'string' ? (PRESENCE_FOR[eventType] ?? null) : null
}

/** The disposition an event stamps, or null. Mirrors the server reducer
 *  (0020 D1, fifth edition in 0025 D5): the mark_* verbs name why the item
 *  left, `found` clears it, and `retire` on a BORROWED unit (ownership =
 *  'sub_rented_in') stamps 'returned_to_owner' — "we scrapped it" and "we
 *  gave it back" must never read the same on the Gone filter. Derived from
 *  ownership, which the caller reads off the pre-update row, exactly as the
 *  server does. Undefined for every other event — leave the column as it was. */
export function dispositionFor(
  eventType: unknown,
  ownership: string | null | undefined = 'owned',
): { set: string | null } | undefined {
  switch (eventType) {
    case 'mark_lost':   return { set: 'lost' }
    case 'mark_stolen': return { set: 'stolen' }
    case 'mark_sold':   return { set: 'sold' }
    case 'retire':      return { set: ownership === 'sub_rented_in' ? 'returned_to_owner' : 'retired' }
    case 'found':       return { set: null }
    default:            return undefined
  }
}

/** The ownership axis of one unit, read before the projection writes — the
 *  one fact `retire` branches on. Null when the row is missing. */
function ownershipOf(db: SqlDriver, assetId: string): string | null {
  const row = db.get<{ ownership: string | null }>(
    `select ownership from assets where id = ?`,
    [assetId],
  )
  return row?.ownership ?? null
}

/** Whether an event takes the asset off its current job. A terminal item
 *  projects onto no job — the line that lets a ghost job finally close
 *  (0020 D2) — and a check_in clears it the way it always has. */
function clearsJob(eventType: unknown): boolean {
  return eventType === 'check_in'
    || eventType === 'mark_lost'
    || eventType === 'mark_stolen'
    || eventType === 'mark_sold'
}

/**
 * Apply one op's optimistic effect. Returns the asset id if it changed
 * anything, otherwise undefined — which is what lets the caller report which
 * assets were protected from the server's view without repeating the rules.
 *
 * The caller owns the transaction. `ScanSession` needs the queue row and this
 * write to be atomic, and `PullApplier` needs the whole replay inside the same
 * transaction as the upserts, so opening one here would break both.
 */
export function projectOp(db: SqlDriver, op: ProjectableOp): string | undefined {
  const assetId = op.asset_id
  if (typeof assetId !== 'string') return undefined

  // 0021 D2: a serviced event resets the service meter and touches nothing
  // else — no presence, no health, no cycles (a battery's cycles are its
  // life, not its maintenance). Handled before the presence gate because
  // serviced is deliberately not a movement.
  if (op.event_type === 'serviced') {
    db.exec(`update assets set rental_days_since_service = 0 where id = ?`, [assetId])
    return assetId
  }

  const presence = presenceFor(op.event_type)
  if (!presence) return undefined

  // 0021: the two usage meters ride the same update as presence, so the
  // optimistic mirror can never show a movement without its wear.
  const addDays = op.event_type === 'check_in' ? serviceDaysFor(db, op, assetId) : 0
  const addCycles = op.event_type === 'check_out' && countsCycles(db, assetId) ? 1 : 0

  const disposition = dispositionFor(op.event_type, ownershipOf(db, assetId))

  // `last_scanned_at` is only written when the op carries a time. It always
  // does in practice — ScanSession stamps every payload — but coalescing in
  // SQL rather than defaulting in JS means a malformed op degrades to "leave
  // the timestamp alone" instead of writing a wrong one.
  //
  // current_job_id: set on a checkout, cleared on check_in and on the three
  // terminal marks (0020 D2), left alone otherwise. disposition: written only
  // by the fleet-lifecycle verbs; every other event leaves the column
  // untouched (the `coalesce`-free branch below decides which SQL runs, so an
  // ordinary movement can never accidentally null a live item's disposition).
  if (disposition === undefined) {
    db.exec(
      `update assets
          set presence = ?,
              current_job_id = ?,
              rental_days_since_service = rental_days_since_service + ?,
              cycle_count = cycle_count + ?,
              last_scanned_at = coalesce(?, last_scanned_at)
        where id = ?`,
      [
        presence,
        presence === 'out' ? ((op.job_id as SqlValue) ?? null) : null,
        addDays,
        addCycles,
        typeof op.device_time === 'string' ? op.device_time : null,
        assetId,
      ],
    )
  } else {
    // A fleet-lifecycle verb. The job column is set only when the event
    // clears it (the three terminal marks); `found` and `retire` leave it as
    // it stands, so the update omits the column entirely rather than passing
    // a sentinel.
    const clearJob = clearsJob(op.event_type)
    db.exec(
      `update assets
          set presence = ?,
              disposition = ?,
              ${clearJob ? 'current_job_id = null,' : ''}
              last_scanned_at = coalesce(?, last_scanned_at)
        where id = ?`,
      [
        presence,
        disposition.set,
        typeof op.device_time === 'string' ? op.device_time : null,
        assetId,
      ],
    )
  }

  return assetId
}
