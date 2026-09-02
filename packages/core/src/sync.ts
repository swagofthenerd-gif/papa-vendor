import type { SqlDriver } from './db/driver.ts'
import { metaGetNumber, metaSet } from './meta.ts'
import { Outbox, type OutboxRow } from './outbox.ts'

/**
 * The flush loop.
 *
 * Everything here happens in the background, behind the UI. Nothing on this
 * path is ever awaited by a scan.
 */

/** One row of the server's reply, mirroring `scan_submit_result`. */
export interface SubmitResult {
  client_seq: number
  event_id: string
  outcome: 'accepted' | 'duplicate'
  alert_kind: string | null
}

export interface Transport {
  submitScanBatch(deviceId: string, ops: unknown[]): Promise<SubmitResult[]>
}

export class TransportError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly clientSeq: number | null

  constructor(
    message: string,
    code: string,
    /**
     * Retryable means "the network or the server had a moment" — timeouts,
     * 5xx, DNS. Non-retryable means the server looked at this op and refused
     * it, and sending it again a thousand times will not change its mind.
     *
     * Getting this backwards in either direction is expensive: treat a
     * permanent failure as retryable and the queue never drains; treat a
     * transient one as permanent and a whole pull session gets parked because
     * a tunnel dropped.
     */
    retryable = true,
    /**
     * The client_seq of the op the server refused, when it says. The DB layer
     * includes it in the error payload where it can; a transport that sees it
     * should pass it through, because it turns "park something and hope" into
     * "park exactly the op the server named".
     */
    clientSeq: number | null = null,
  ) {
    super(message)
    this.code = code
    this.retryable = retryable
    this.clientSeq = clientSeq
    this.name = 'TransportError'
  }
}

export interface FlushReport {
  sent: number
  acked: number
  duplicates: number
  failed: string[]
  alerts: string[]
  stopped?: 'offline' | 'retry_later' | 'nothing_to_do'
}

export class SyncEngine {
  private readonly outbox: Outbox

  private readonly db: SqlDriver
  private readonly transport: Transport
  private readonly deviceId: string

  constructor(db: SqlDriver, transport: Transport, deviceId: string) {
    this.db = db
    this.transport = transport
    this.deviceId = deviceId
    this.outbox = new Outbox(db)
  }

  /**
   * Send what is ready.
   *
   * One batch per call, in seq order, all-or-nothing. A partial network
   * failure must never half-apply a pull session — the truck leaves loaded
   * with gear the system believes is on the shelf, and nobody finds out until
   * the next morning's prep.
   */
  async flush(online: boolean, limit = 50, now = Date.now()): Promise<FlushReport> {
    const empty = emptyReport()
    if (!online) return { ...empty, stopped: 'offline' }

    const batch = this.outbox.nextBatch(limit, now)
    if (batch.length === 0) return { ...empty, stopped: 'nothing_to_do' }

    this.outbox.markInflight(batch.map((r) => r.id))

    let results: SubmitResult[]
    try {
      results = await this.transport.submitScanBatch(this.deviceId, batch.map(toOp))
    } catch (err) {
      return this.handleBatchError(batch, err, now)
    }

    const report = { ...emptyReport(), sent: batch.length }
    this.settle(batch, results, report)
    return report
  }

  /**
   * Ack what the server accepted and tally the report.
   *
   * Matches on client_seq, not array position — the server may coalesce or
   * reorder, and matching by index would ack the wrong rows. An op with no
   * result stays queued and is retried next flush.
   */
  private settle(batch: OutboxRow[], results: SubmitResult[], report: FlushReport): void {
    const bySeq = new Map(results.map((r) => [r.client_seq, r]))
    const ack: string[] = []

    for (const row of batch) {
      const result = bySeq.get(row.seq)
      if (!result) continue     // unacknowledged: stays queued, retried next flush
      ack.push(row.id)
      if (result.outcome === 'duplicate') report.duplicates++
      if (result.alert_kind) report.alerts.push(result.alert_kind)
    }

    this.outbox.ack(ack)
    report.acked += ack.length
  }

  private async handleBatchError(batch: OutboxRow[], err: unknown, now: number): Promise<FlushReport> {
    const code = err instanceof TransportError ? err.code : 'unknown'
    const retryable = err instanceof TransportError ? err.retryable : true
    const detail = err instanceof Error ? err.message : String(err)

    if (retryable) {
      for (const row of batch) this.outbox.retryLater(row.id, code, detail, now)
      return { ...emptyReport(), sent: batch.length, stopped: 'retry_later' }
    }

    // Permanent. submit_scan_batch is all-or-nothing, so the op the server
    // refused can sit ANYWHERE in the batch — parking batch[0] on faith
    // parked an innocent op and left the real poison pending, to fail the
    // next flush, forever. So: park the op the server NAMES when it names
    // one, and bisect to find it when it does not.
    //
    // Either way the queue's DAG rule does the rest: fail() poisons the
    // parked op's whole depends_on closure (ScanSession writes those edges
    // for same-asset ordering), and everything else stays queued to resend in
    // seq order — one bad row must never freeze a warehouse's entire sync.
    // That is the failure mode that gets an app uninstalled.
    const report = { ...emptyReport(), sent: batch.length }
    const named = poisonClientSeq(err)
    const hit = named === null ? undefined : batch.find((r) => r.seq === named)

    if (hit || batch.length === 1) {
      report.failed.push(...this.outbox.fail((hit ?? batch[0]).id, code, detail))
      return report
    }

    const mid = Math.ceil(batch.length / 2)
    await this.isolate(batch.slice(0, mid), report, now)
    await this.isolate(batch.slice(mid), report, now)
    return report
  }

  /**
   * Bisection: resend ever-smaller sub-batches, in seq order, until the
   * poison op stands alone and can be parked by name.
   *
   * The good ops land as a side effect, which is the point — a permanent
   * error on a 50-op batch must cost the one bad op, not the morning. Ops
   * already cascade-failed by an earlier half are skipped, and a transport
   * (retryable) error stops the whole search: earlier ops are now backing
   * off, and sending later ones around them is the ordering violation
   * nextBatch exists to prevent.
   */
  private async isolate(rows: OutboxRow[], report: FlushReport, now: number): Promise<void> {
    const live = rows.filter((r) => !report.failed.includes(r.id))
    if (live.length === 0 || report.stopped === 'retry_later') return

    let results: SubmitResult[]
    try {
      results = await this.transport.submitScanBatch(this.deviceId, live.map(toOp))
    } catch (err) {
      const code = err instanceof TransportError ? err.code : 'unknown'
      const retryable = err instanceof TransportError ? err.retryable : true
      const detail = err instanceof Error ? err.message : String(err)

      if (retryable) {
        for (const row of live) this.outbox.retryLater(row.id, code, detail, now)
        report.stopped = 'retry_later'
        return
      }

      const named = poisonClientSeq(err)
      const hit = named === null ? undefined : live.find((r) => r.seq === named)
      if (hit || live.length === 1) {
        report.failed.push(...this.outbox.fail((hit ?? live[0]).id, code, detail))
        return
      }

      const mid = Math.ceil(live.length / 2)
      await this.isolate(live.slice(0, mid), report, now)
      await this.isolate(live.slice(mid), report, now)
      return
    }

    this.settle(live, results, report)
  }

  /**
   * Measure clock skew from a server timestamp, corrected for round-trip.
   *
   * Recorded, not acted on. The device time is never rewritten — its
   * divergence is diagnostic, and the server clamps on arrival anyway. The
   * threshold at which drift becomes worth correcting is an explicit guess
   * that wants real field data from the first twenty devices before it
   * becomes policy.
   */
  recordClockOffset(serverNowMs: number, requestSentMs: number, responseAtMs: number): number {
    const roundTrip = responseAtMs - requestSentMs
    const offset = serverNowMs + roundTrip / 2 - responseAtMs

    metaSet(this.db, 'clock_offset_ms', Math.round(offset))
    return Math.round(offset)
  }

  clockOffsetMs(): number {
    return metaGetNumber(this.db, 'clock_offset_ms')
  }
}

/**
 * A zero report.
 *
 * A FUNCTION, not a shared constant. A `const EMPTY` spread into `{...EMPTY}`
 * copies the array REFERENCES, so every report would share one `failed` and
 * one `alerts` array — and the first caller to push into either would silently
 * corrupt every other report in the process.
 */
function emptyReport(): FlushReport {
  return { sent: 0, acked: 0, duplicates: 0, failed: [], alerts: [] }
}

function toOp(row: OutboxRow): Record<string, unknown> {
  return { ...JSON.parse(row.payload), client_seq: row.seq, id: row.id }
}

/**
 * The client_seq of the op a permanent error is actually about, if the server
 * said. Read from the typed field first, then — DEFENSIVELY — from a JSON
 * error payload a transport passed through verbatim. The server includes it
 * where it can, not always, and a malformed payload must degrade to "not
 * named" (bisection) rather than throw inside error handling.
 */
function poisonClientSeq(err: unknown): number | null {
  if (!(err instanceof TransportError)) return null
  if (typeof err.clientSeq === 'number' && Number.isFinite(err.clientSeq)) {
    return err.clientSeq
  }
  try {
    const payload = JSON.parse(err.message) as { client_seq?: unknown }
    if (typeof payload.client_seq === 'number' && Number.isFinite(payload.client_seq)) {
      return payload.client_seq
    }
  } catch {
    // Not JSON — nothing named.
  }
  return null
}
