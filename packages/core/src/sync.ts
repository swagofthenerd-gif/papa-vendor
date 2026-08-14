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
  ) {
    super(message)
    this.code = code
    this.retryable = retryable
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

    // Match on client_seq, not array position — the server may coalesce or
    // reorder, and matching by index would ack the wrong rows.
    const bySeq = new Map(results.map((r) => [r.client_seq, r]))
    const ack: string[] = []
    const alerts: string[] = []
    let duplicates = 0

    for (const row of batch) {
      const result = bySeq.get(row.seq)
      if (!result) continue     // unacknowledged: stays queued, retried next flush
      ack.push(row.id)
      if (result.outcome === 'duplicate') duplicates++
      if (result.alert_kind) alerts.push(result.alert_kind)
    }

    this.outbox.ack(ack)
    return { sent: batch.length, acked: ack.length, duplicates, failed: [], alerts }
  }

  private handleBatchError(batch: OutboxRow[], err: unknown, now: number): FlushReport {
    const code = err instanceof TransportError ? err.code : 'unknown'
    const retryable = err instanceof TransportError ? err.retryable : true
    const detail = err instanceof Error ? err.message : String(err)

    if (retryable) {
      for (const row of batch) this.outbox.retryLater(row.id, code, detail, now)
      return { ...emptyReport(), sent: batch.length, stopped: 'retry_later' }
    }

    // Permanent. Park the FIRST op and, through it, everything that depends on
    // it — the queue is a DAG and failure poisons the subtree. Later ops in
    // this batch that do not depend on it are left pending, because one bad
    // row must never freeze a warehouse's entire sync. That is the failure
    // mode that gets an app uninstalled.
    const failed = this.outbox.fail(batch[0].id, code, detail)
    return { ...emptyReport(), sent: batch.length, failed }
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
