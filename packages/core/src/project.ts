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
 *  (0020 D1): the mark_* verbs name why the item left, `found` clears it.
 *  Undefined for every other event — leave the column exactly as it was. */
function dispositionFor(eventType: unknown): { set: string | null } | undefined {
  switch (eventType) {
    case 'mark_lost':   return { set: 'lost' }
    case 'mark_stolen': return { set: 'stolen' }
    case 'mark_sold':   return { set: 'sold' }
    case 'retire':      return { set: 'retired' }
    case 'found':       return { set: null }
    default:            return undefined
  }
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

  const presence = presenceFor(op.event_type)
  if (!presence) return undefined

  const disposition = dispositionFor(op.event_type)

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
              last_scanned_at = coalesce(?, last_scanned_at)
        where id = ?`,
      [
        presence,
        presence === 'out' ? ((op.job_id as SqlValue) ?? null) : null,
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
