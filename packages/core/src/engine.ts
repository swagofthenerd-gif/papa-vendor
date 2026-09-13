import type { SqlDriver } from './db/driver.ts'
import { metaGet, metaSet } from './meta.ts'
import { Outbox, syncStatus, type SyncTone } from './outbox.ts'
import { PullApplier, type PullPayload } from './pull.ts'
import { SyncEngine, TransportError, type FlushReport, type Transport } from './sync.ts'

/**
 * The sync loop — the background process the UI never waits on (W9).
 *
 * One cycle is: pull every page the server has → apply each (the applier
 * replays this phone's unsent writes on top, so a tech never watches their
 * own scan undo itself) → flush the outbox until it is drained or the
 * network says wait → if anything the server renamed landed, pull once
 * more so the server's children (a booking's lines and claims) replace
 * the phone's guesses without waiting for the next poll.
 *
 * WHEN IT RUNS. On start, on `online`, on the app coming to the foreground,
 * on a timer, and whenever something kicks it (a scan session finishing,
 * a booking placed). Kicks coalesce: a cycle in flight is asked to run
 * once more when it ends, never twice at once — two flushes interleaving
 * would send the same batch twice, and two applies would race the cursor.
 *
 * WHAT IT REMEMBERS (sync_meta): last_pull_at, last_flush_at, last_error
 * and last_error_at, so Settings → This phone can say when the phone last
 * heard from the server and what the last complaint was. A dead session
 * (28000) is remembered as `session_dead` so the shell can send the person
 * to re-enrol instead of retrying forever.
 *
 * ASSUMPTION: a 30-second poll when the app is open, plus the event kicks.
 * See docs/assumptions.md#sync-poll-interval
 */

export interface PullTransport extends Transport {
  pull(cursor: number, limit?: number): Promise<PullPayload>
}

export interface SyncLoopOptions {
  db: SqlDriver
  transport: PullTransport
  deviceId: string
  /** Connectivity, read per cycle. Defaults to navigator.onLine, else true. */
  online?: () => boolean
  now?: () => number
  pullLimit?: number
  flushLimit?: number
  /** 0 disables the timer (tests, the proof). */
  pollMs?: number
  /** Extra tables a re-key rewrites (the app's own). */
  rekeyColumns?: Record<string, string[]>
  /** Called after any cycle that changed local rows — the UI's tick. */
  onChange?: () => void
  /** The window to hang connectivity listeners on; absent under Node. */
  target?: EventTarget & { document?: { visibilityState?: string } }
}

export interface CycleReport {
  pulled: number
  pages: number
  flushes: FlushReport[]
  error: string | null
}

export interface SyncStatusView {
  online: boolean
  running: boolean
  pending: number
  failures: number
  oldestAgeMs: number
  cursor: number
  lastPullAt: number | null
  lastFlushAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  sessionDead: boolean
  tone: SyncTone
  text: string
}

const MAX_PAGES_PER_CYCLE = 50
const MAX_FLUSHES_PER_CYCLE = 20

export class SyncLoop {
  private readonly db: SqlDriver
  private readonly transport: PullTransport
  private readonly engine: SyncEngine
  private readonly applier: PullApplier
  private readonly outbox: Outbox
  private readonly online: () => boolean
  private readonly now: () => number
  private readonly pullLimit: number
  private readonly flushLimit: number
  private readonly pollMs: number
  private readonly onChange: (() => void) | undefined
  private readonly target: SyncLoopOptions['target']

  private running: Promise<CycleReport> | null = null
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private readonly onEvent = () => { void this.kick() }

  constructor(opts: SyncLoopOptions) {
    this.db = opts.db
    this.transport = opts.transport
    this.now = opts.now ?? Date.now
    this.engine = new SyncEngine(opts.db, opts.transport, opts.deviceId, {
      rekeyColumns: opts.rekeyColumns, now: this.now,
    })
    this.applier = new PullApplier(opts.db)
    this.outbox = new Outbox(opts.db, this.now)
    this.online = opts.online ?? defaultOnline
    this.pullLimit = opts.pullLimit ?? 2000
    this.flushLimit = opts.flushLimit ?? 50
    this.pollMs = opts.pollMs ?? 30_000
    this.onChange = opts.onChange
    this.target = opts.target ?? defaultTarget()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.target?.addEventListener('online', this.onEvent)
    this.target?.addEventListener('visibilitychange', this.onEvent)
    this.schedule()
    void this.kick()
  }

  stop(): void {
    this.started = false
    this.target?.removeEventListener('online', this.onEvent)
    this.target?.removeEventListener('visibilitychange', this.onEvent)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.started || this.pollMs <= 0) return
    this.timer = setTimeout(() => { void this.kick() }, this.pollMs)
  }

  /**
   * Run a cycle now, or ask the running one to go again when it ends.
   * Returns the cycle's report — the UI ignores it; the proof reads it.
   */
  kick(): Promise<CycleReport> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.cycle().finally(() => {
      this.running = null
      this.schedule()
      if (this.again) {
        this.again = false
        void this.kick()
      }
    })
    return this.running
  }

  private async cycle(): Promise<CycleReport> {
    const report: CycleReport = { pulled: 0, pages: 0, flushes: [], error: null }
    if (!this.online()) return report
    let changed = false
    try {
      changed = await this.pullAll(report)
      let mapped = 0
      for (let i = 0; i < MAX_FLUSHES_PER_CYCLE; i++) {
        const f = await this.engine.flush(true, this.flushLimit, this.now())
        report.flushes.push(f)
        if (f.acked > 0 || f.failed.length > 0 || f.dispatched > 0) changed = true
        mapped += f.mapped
        if (f.stopped) break
        if (f.acked === 0 && f.dispatched === 0) break
      }
      if (report.flushes.length > 0) metaSet(this.db, 'last_flush_at', this.now())
      if (mapped > 0) changed = await this.pullAll(report) || changed
      metaSet(this.db, 'last_error', '')
    } catch (err) {
      report.error = err instanceof Error ? err.message : String(err)
      metaSet(this.db, 'last_error', report.error)
      metaSet(this.db, 'last_error_at', this.now())
      if (err instanceof TransportError && err.code === '28000') {
        metaSet(this.db, 'session_dead', '1')
        changed = true
      }
    }
    if (changed) this.onChange?.()
    return report
  }

  /** Pull until the server says there is nothing more. Returns whether
   *  any row landed. */
  private async pullAll(report: CycleReport): Promise<boolean> {
    let changed = false
    for (let page = 0; page < MAX_PAGES_PER_CYCLE; page++) {
      const sent = this.now()
      const payload = await this.transport.pull(this.applier.cursor(), this.pullLimit)
      const at = this.now()
      const serverMs = Date.parse(payload.server_time)
      if (Number.isFinite(serverMs)) this.engine.recordClockOffset(serverMs, sent, at)
      const applied = this.applier.apply(payload)
      report.pages++
      report.pulled += applied.upserted + applied.deleted
      if (applied.upserted + applied.deleted > 0) changed = true
      metaSet(this.db, 'last_pull_at', at)
      if (!payload.has_more) break
    }
    return changed
  }

  /** The Backed-up chip and Settings → This phone read this. */
  status(): SyncStatusView {
    const online = this.online()
    const pending = this.outbox.pendingCount()
    const failures = this.outbox.failures().length
    const oldestAgeMs = this.outbox.oldestPendingAgeMs(this.now())
    const { tone, text } = syncStatus(online, pending, oldestAgeMs, failures)
    const lastError = metaGet(this.db, 'last_error')
    return {
      online,
      running: this.running !== null,
      pending,
      failures,
      oldestAgeMs,
      cursor: this.applier.cursor(),
      lastPullAt: metaNumberOrNull(this.db, 'last_pull_at'),
      lastFlushAt: metaNumberOrNull(this.db, 'last_flush_at'),
      lastError: lastError ? lastError : null,
      lastErrorAt: metaNumberOrNull(this.db, 'last_error_at'),
      sessionDead: metaGet(this.db, 'session_dead') === '1',
      tone,
      text,
    }
  }
}

/** A stored timestamp, or null when absent, blank, unparseable or zero. */
function metaNumberOrNull(db: SqlDriver, key: string): number | null {
  const n = Number(metaGet(db, key) ?? '')
  return Number.isFinite(n) && n !== 0 ? n : null
}

function defaultOnline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator
  return typeof nav?.onLine === 'boolean' ? nav.onLine : true
}

function defaultTarget(): SyncLoopOptions['target'] {
  const w = (globalThis as { window?: SyncLoopOptions['target'] }).window
  return w ?? undefined
}
