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

/** presence, or null when this event type does not move an asset. */
function presenceFor(eventType: unknown): string | null {
  if (eventType === 'check_out') return 'out'
  if (eventType === 'check_in') return 'here'
  return null
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

  // `last_scanned_at` is only written when the op carries a time. It always
  // does in practice — ScanSession stamps every payload — but coalescing in
  // SQL rather than defaulting in JS means a malformed op degrades to "leave
  // the timestamp alone" instead of writing a wrong one.
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

  return assetId
}
