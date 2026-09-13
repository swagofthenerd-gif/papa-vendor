import type { SqlDriver } from './db/driver.ts'
import { metaGetNumber, metaSet } from './meta.ts'
import { Outbox, type OutboxRow } from './outbox.ts'
import { IdMap, REKEY_COLUMNS, argsOf, rekeyLocal } from './dispatch.ts'

/**
 * The flush loop.
 *
 * Everything here happens in the background, behind the UI. Nothing on this
 * path is ever awaited by a scan.
 *
 * TWO KINDS OF OP, ONE ORDER (W9). The queue holds scans (submit_scan_batch,
 * and void_scan — a correction that rides the same batch) and everything
 * else (a pencil, a partner house, a rate). A flush walks the batch in
 * strict seq order and cuts it into SEGMENTS: a run of scan-kind ops is one
 * submit_scan_batch call (all-or-nothing, bisected on a permanent error —
 * the rules below); every other op is one replay_op call (dispatch.ts).
 * Strictly in order, because a check_out of a borrowed unit must not reach
 * the server before the record_sub_hire_in that creates the unit, and the
 * only ordering the queue promises is seq.
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
  /**
   * Call one RPC by name (W9). Optional so a scan-only transport — every
   * test double before the pipe — keeps satisfying the interface; a queue
   * that holds a non-scan op against such a transport backs that op off
   * rather than losing it.
   */
  rpc?<T>(name: string, args: Record<string, unknown>): Promise<T>
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
  /** Non-scan ops the server accepted this flush (W9). */
  dispatched: number
  /** Client ids the server renamed this flush (W9). */
  mapped: number
  stopped?: 'offline' | 'retry_later' | 'nothing_to_do'
}

/** What replay_op (0027) answers. */
interface ReplayReply {
  reply: unknown
  duplicate: boolean
}

export interface SyncEngineOptions {
  /** Extra tables and columns a re-key rewrites, beyond REKEY_COLUMNS. */
  rekeyColumns?: Record<string, string[]>
  now?: () => number
}

/** Ops that ride submit_scan_batch. */
function isScanKind(op: string): boolean {
  return op === 'submit_scan_batch' || op === 'void_scan'
}

export class SyncEngine {
  private readonly outbox: Outbox
  private readonly idMap: IdMap
  private readonly rekeyColumns: Record<string, string[]>

  private readonly db: SqlDriver
  private readonly transport: Transport
  private readonly deviceId: string

  constructor(db: SqlDriver, transport: Transport, deviceId: string, opts: SyncEngineOptions = {}) {
    this.db = db
    this.transport = transport
    this.deviceId = deviceId
    this.outbox = new Outbox(db, opts.now)
    this.idMap = new IdMap(db, opts.now)
    this.rekeyColumns = { ...REKEY_COLUMNS, ...(opts.rekeyColumns ?? {}) }
  }

  /**
   * Send what is ready.
   *
   * One batch per call, in seq order, cut into segments (see the header).
   * A scan segment is all-or-nothing. A partial network failure must never
   * half-apply a pull session — the truck leaves loaded with gear the
   * system believes is on the shelf, and nobody finds out until the next
   * morning's prep.
   */
  async flush(online: boolean, limit = 50, now = Date.now()): Promise<FlushReport> {
    const empty = emptyReport()
    if (!online) return { ...empty, stopped: 'offline' }

    const batch = this.outbox.nextBatch(limit, now)
    if (batch.length === 0) return { ...empty, stopped: 'nothing_to_do' }

    const report = emptyReport()
    let index = 0
    while (index < batch.length && report.stopped !== 'retry_later') {
      const head = batch[index]!
      // An op parked by an earlier segment's cascade is skipped, not sent.
      if (report.failed.includes(head.id)) { index++; continue }

      if (isScanKind(head.op)) {
        const run: OutboxRow[] = []
        while (index < batch.length && isScanKind(batch[index]!.op)) run.push(batch[index++]!)
        await this.sendScans(run, report, now)
      } else {
        await this.dispatchOne(head, report, now)
        index++
      }
    }
    return report
  }

  // ------------------------------------------------------------ scans

  private async sendScans(run: OutboxRow[], report: FlushReport, now: number): Promise<void> {
    const live = run.filter((r) => !report.failed.includes(r.id))
    if (live.length === 0) return
    this.outbox.markInflight(live.map((r) => r.id))
    report.sent += live.length

    let results: SubmitResult[]
    try {
      results = await this.transport.submitScanBatch(this.deviceId, live.map((r) => this.wireScan(r)))
    } catch (err) {
      await this.parkOrBisect(live, err, report, now)
      return
    }
    this.settle(live, results, report)
  }

  /**
   * A scan on the wire, with every id the server has since renamed
   * rewritten: a check_out of a borrowed unit recorded on this phone names
   * the phone's `asset-…` id, and the server knows the unit only by the id
   * record_sub_hire_in's reply gave it (dispatch.ts, rule 2).
   */
  private wireScan(row: OutboxRow): Record<string, unknown> {
    return this.idMap.rewrite(toScanOp(row))
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

  /**
   * Turn a send error into queue state — retry the lot, or park the one bad op.
   *
   * On a retryable error every op backs off and the flush stops: the network
   * had a moment, not the ops.
   *
   * On a permanent error submit_scan_batch is all-or-nothing, so the op the
   * server refused can sit ANYWHERE in the batch — parking batch[0] on faith
   * parked an innocent op and left the real poison pending, to fail the next
   * flush, forever. So: park the op the server NAMES when it names one, and
   * bisect (via isolate) to find it when it does not.
   *
   * Either way the queue's DAG rule does the rest: fail() poisons the parked
   * op's whole depends_on closure (ScanSession writes those edges for
   * same-asset ordering), and everything else stays queued to resend in seq
   * order — one bad row must never freeze a warehouse's entire sync. That is
   * the failure mode that gets an app uninstalled.
   */
  private async parkOrBisect(rows: OutboxRow[], err: unknown, report: FlushReport, now: number): Promise<void> {
    const code = err instanceof TransportError ? err.code : 'unknown'
    const retryable = err instanceof TransportError ? err.retryable : true
    const detail = err instanceof Error ? err.message : String(err)

    if (retryable) {
      for (const row of rows) this.outbox.retryLater(row.id, code, detail, now)
      report.stopped = 'retry_later'
      return
    }

    const named = poisonClientSeq(err)
    const hit = named === null ? undefined : rows.find((r) => r.seq === named)
    if (hit || rows.length === 1) {
      report.failed.push(...this.outbox.fail((hit ?? rows[0]!).id, code, detail))
      return
    }

    const mid = Math.ceil(rows.length / 2)
    await this.isolate(rows.slice(0, mid), report, now)
    await this.isolate(rows.slice(mid), report, now)
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
      results = await this.transport.submitScanBatch(this.deviceId, live.map((r) => this.wireScan(r)))
    } catch (err) {
      await this.parkOrBisect(live, err, report, now)
      return
    }

    this.settle(live, results, report)
  }

  // --------------------------------------------------------- dispatch

  /**
   * One non-scan op, through replay_op (dispatch.ts explains the three
   * rules). A retryable error backs it off and stops the flush; a verdict
   * parks it AND its dependency closure — the pencil's confirm and the
   * job it would have become fall as one card, with the server's own words
   * on it.
   */
  private async dispatchOne(row: OutboxRow, report: FlushReport, now: number): Promise<void> {
    if (!this.transport.rpc) {
      // A transport that cannot dispatch is a network that cannot carry
      // this op: back off, never park. Nothing is lost, only delayed.
      this.outbox.retryLater(row.id, 'no_rpc', 'transport has no rpc()', now)
      report.stopped = 'retry_later'
      return
    }

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>
    } catch {
      report.failed.push(...this.outbox.fail(row.id, 'bad_payload', 'payload is not JSON'))
      return
    }

    this.outbox.markInflight([row.id])
    report.sent++
    const args = this.idMap.rewrite(argsOf(row.op, payload))

    let answer: ReplayReply
    try {
      answer = await this.transport.rpc<ReplayReply>('replay_op', {
        p_op_id: row.id,
        p_rpc: row.op,
        p_args: args,
      })
    } catch (err) {
      const code = err instanceof TransportError ? err.code : 'unknown'
      const retryable = err instanceof TransportError ? err.retryable : true
      const detail = err instanceof Error ? err.message : String(err)
      if (retryable) {
        this.outbox.retryLater(row.id, code, detail, now)
        report.stopped = 'retry_later'
        return
      }
      report.failed.push(...this.outbox.fail(row.id, code, detail))
      return
    }

    // The reply, the mapping, the re-key and the ack: one transaction, so
    // a phone killed mid-way either still holds the op (and replays it,
    // answered by the receipt) or holds the server's names everywhere.
    this.db.transaction(() => {
      const reply = answer && typeof answer === 'object' && 'reply' in answer ? answer.reply : answer
      for (const m of this.idMap.mappingsFrom(row.op, payload, reply)) {
        this.idMap.record(m.clientId, m.serverId, m.kind)
        rekeyLocal(this.db, m.clientId, m.serverId, this.rekeyColumns)
        report.mapped++
      }
      this.outbox.ack([row.id])
    })
    report.acked++
    report.dispatched++
    if (answer && typeof answer === 'object' && answer.duplicate) report.duplicates++
  }

  // ------------------------------------------------------------ clock

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
  return { sent: 0, acked: 0, duplicates: 0, failed: [], alerts: [], dispatched: 0, mapped: 0 }
}

/**
 * The wire shape of one scan-kind op. The outbox id doubles as the event id
 * (submit_scan_batch: `coalesce(op->>'id', uuid_generate_v7())`), which is
 * what lets a void name its target without a round-trip: a `void_scan` is
 * sent as a CORRECTION — the voided op's own event type, `corrects_event_id`
 * = the voided outbox id, entry_method 'manual' — so the server's append-only
 * log records the undo the way CONTRIBUTING requires (corrections point
 * forward) and its projection rebuilds without either event.
 */
export function toScanOp(row: OutboxRow): Record<string, unknown> {
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  if (row.op === 'void_scan') {
    return {
      id: row.id,
      client_seq: row.seq,
      asset_id: payload.asset_id ?? null,
      tag_code: payload.voided_tag_code ?? null,
      event_type: payload.voided_event_type ?? 'check_in',
      job_id: payload.voided_job_id ?? null,
      corrects_event_id: payload.voids,
      entry_method: 'manual',
      note: 'voided on device',
      device_time: payload.device_time,
      payload: { void: true },
    }
  }
  return { ...payload, client_seq: row.seq, id: row.id }
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
