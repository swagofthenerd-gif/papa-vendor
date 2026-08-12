import type { SqlDriver } from './db/driver.ts'

/**
 * The outbox.
 *
 * THE INVARIANT, stated once so it settles every future argument:
 *
 *     The queue is a DAG. Failure poisons the SUBTREE, never just the node.
 *
 * The architecture asserted three rules that cannot all hold at once —
 * "strictly ordered, stop on first failure", "all-or-nothing batches", and
 * "after 8 attempts skip the poison pill". Skipping breaks the ordering the
 * first rule exists to guarantee, and anything queued behind the skipped op
 * then executes against a missing prerequisite. What happens to a check_in
 * whose check_out was skipped? Undefined behaviour, in the one component that
 * must be deterministic.
 *
 * Resolved here by making the cascade explicit: a failed op fails its entire
 * dependency closure, and the whole chain surfaces as ONE item needing
 * attention rather than twelve.
 */

export type OutboxState = 'pending' | 'inflight' | 'failed'

export interface OutboxRow {
  id: string
  seq: number
  op: string
  payload: string
  depends_on: string | null
  state: OutboxState
  attempts: number
  next_retry_at: number | null
  error_code: string | null
  error_detail: string | null
  created_at: number
}

export interface EnqueueInput {
  id: string
  op: string
  payload: unknown
  dependsOn?: string | null
}

/** Backoff, capped. Plus an immediate flush on `online` and on app foreground. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000, 300_000, 1_800_000]

/**
 * After this many attempts an op is parked rather than retried forever. A
 * single bad row must never freeze a warehouse's entire sync — that is the
 * failure mode that gets an app uninstalled.
 */
export const MAX_ATTEMPTS = 8

export class Outbox {
  // Explicit field + assignment rather than a constructor parameter property.
  // Node's strip-only TypeScript removes types but cannot EMIT code, and a
  // parameter property is a code transform. The whole package must therefore
  // avoid parameter properties, enums, namespaces and decorators — that is
  // the price of running the offline engine's tests against a real SQLite
  // with no build step, and it is worth paying.
  private readonly db: SqlDriver

  constructor(db: SqlDriver) {
    this.db = db
  }

  /**
   * The monotonic per-device sequence.
   *
   * NEVER resets, including after every row has been retired and the table is
   * empty — `max(seq)` over live rows would restart at 1 and collide with
   * (device_id, client_seq) pairs the server has already accepted, which the
   * server would then correctly report as duplicates. The scans would be
   * silently dropped and the tech would never know.
   */
  nextSeq(): number {
    const row = this.db.get<{ value: string | null }>(
      `select value from sync_meta where key = 'outbox_seq'`,
    )
    const next = (row?.value ? Number(row.value) : 0) + 1
    this.db.exec(
      `insert into sync_meta (key, value) values ('outbox_seq', ?)
       on conflict (key) do update set value = excluded.value`,
      [String(next)],
    )
    return next
  }

  enqueue(input: EnqueueInput): OutboxRow {
    return this.db.transaction(() => {
      const seq = this.nextSeq()
      this.db.exec(
        `insert into outbox (id, seq, op, payload, depends_on, state, created_at)
         values (?, ?, ?, ?, ?, 'pending', ?)`,
        [input.id, seq, input.op, JSON.stringify(input.payload), input.dependsOn ?? null, Date.now()],
      )
      return this.byId(input.id)!
    })
  }

  byId(id: string): OutboxRow | undefined {
    return this.db.get<OutboxRow>(`select * from outbox where id = ?`, [id])
  }

  /**
   * The next batch to send, in strict seq order.
   *
   * Stops at the first op that is not ready — either still backing off, or
   * blocked behind an unsent dependency. Sending past a gap is what produces
   * "checked in before it was checked out", and the throughput is not worth it.
   */
  nextBatch(limit = 50, now = Date.now()): OutboxRow[] {
    const rows = this.db.all<OutboxRow>(
      `select * from outbox where state in ('pending','inflight') order by seq`,
    )
    const batch: OutboxRow[] = []

    for (const row of rows) {
      if (row.next_retry_at !== null && row.next_retry_at > now) break
      if (row.depends_on && this.isUnsettled(row.depends_on)) break
      batch.push(row)
      if (batch.length >= limit) break
    }
    return batch
  }

  private isUnsettled(id: string): boolean {
    // A dependency is settled when it is gone (acked and deleted). A `failed`
    // dependency is NOT settled — it blocks, and the cascade below will have
    // failed this row too.
    return this.byId(id) !== undefined
  }

  markInflight(ids: string[]): void {
    if (ids.length === 0) return
    this.db.exec(
      `update outbox set state = 'inflight' where id in (${ids.map(() => '?').join(',')})`,
      ids,
    )
  }

  /**
   * The server accepted it — or reported it as a duplicate, which is the same
   * thing. A retry after a timeout where the server actually succeeded happens
   * daily on a flaky mobile network; treating that as an error is how a queue
   * wedges forever.
   */
  ack(ids: string[]): void {
    if (ids.length === 0) return
    this.db.exec(`delete from outbox where id in (${ids.map(() => '?').join(',')})`, ids)
  }

  /**
   * A retryable failure — network, timeout, 5xx. Backs off and stays queued.
   */
  retryLater(id: string, code: string, detail = '', now = Date.now()): void {
    const row = this.byId(id)
    if (!row) return
    const attempts = row.attempts + 1

    if (attempts >= MAX_ATTEMPTS) {
      this.fail(id, code, detail)
      return
    }

    this.db.exec(
      `update outbox set state = 'pending', attempts = ?, next_retry_at = ?,
              error_code = ?, error_detail = ? where id = ?`,
      [attempts, now + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)], code, detail, id],
    )
  }

  /**
   * A permanent failure. Parks this op AND its entire dependency closure.
   *
   * The cascade is the whole point. Marking only the node would leave its
   * children queued against a prerequisite that will never land, and the next
   * flush would apply a check_in for a check_out the server never saw.
   *
   * Returns every id that was failed, so the UI can surface the chain as ONE
   * card in "needs attention" rather than twelve separate alarms.
   */
  fail(id: string, code: string, detail = ''): string[] {
    return this.db.transaction(() => {
      const failed: string[] = []
      const queue = [id]

      while (queue.length > 0) {
        const current = queue.shift()!
        if (failed.includes(current)) continue
        const row = this.byId(current)
        if (!row) continue

        this.db.exec(
          `update outbox set state = 'failed', error_code = ?, error_detail = ?,
                  next_retry_at = null where id = ?`,
          [current === id ? code : 'blocked_by_dependency', current === id ? detail : `blocked by ${id}`, current],
        )
        failed.push(current)

        for (const child of this.db.all<{ id: string }>(
          `select id from outbox where depends_on = ?`,
          [current],
        )) {
          queue.push(child.id)
        }
      }
      return failed
    })
  }

  /** Everything parked, for the "needs attention" list. */
  failures(): OutboxRow[] {
    return this.db.all<OutboxRow>(`select * from outbox where state = 'failed' order by seq`)
  }

  pendingCount(): number {
    return (
      this.db.get<{ n: number }>(
        `select count(*) as n from outbox where state in ('pending','inflight')`,
      )?.n ?? 0
    )
  }

  /** Oldest unsent write, in ms. Drives the status strip's escalation. */
  oldestPendingAgeMs(now = Date.now()): number {
    const row = this.db.get<{ created_at: number }>(
      `select min(created_at) as created_at from outbox where state in ('pending','inflight')`,
    )
    return row?.created_at ? now - row.created_at : 0
  }
}

/**
 * How the status strip should read.
 *
 * Escalates by AGE, not by state. "Offline, 14 scans waiting" is normal and
 * must stay calm — being offline is expected here and an app that acts broken
 * teaches people to ignore it. But after three days, 400 queued writes is not
 * normal, it is a broken device, and a calm neutral strip actively conceals
 * that from the one person who could fix it.
 *
 * Note "waiting to send", never "saved". Both are true; only one tells the
 * person what has actually happened.
 */
export type SyncTone = 'hidden' | 'calm' | 'accent' | 'attention'

export function syncStatus(
  online: boolean,
  pending: number,
  oldestAgeMs: number,
  failures: number,
): { tone: SyncTone; text: string } {
  if (failures > 0) {
    return { tone: 'attention', text: `${failures} need${failures === 1 ? 's' : ''} your attention` }
  }
  // Absent, not green. A permanent "all good" indicator is noise people learn
  // to stop seeing within a week.
  if (online && pending === 0) return { tone: 'hidden', text: '' }

  if (pending === 0) return { tone: 'calm', text: 'Offline' }

  const label = `${pending} scan${pending === 1 ? '' : 's'} waiting to send`
  const hours = oldestAgeMs / 3_600_000

  if (hours >= 24 || pending > 200) {
    return { tone: 'attention', text: `${label} — this phone has not synced in a while` }
  }
  if (hours >= 12) return { tone: 'accent', text: label }
  return { tone: 'calm', text: online ? label : `Offline · ${label}` }
}
