import type { SqlDriver } from './db/driver.ts'
import { Outbox } from './outbox.ts'

/**
 * The scan handler.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *     Zero NETWORK in the scan handler — but never zero LOCAL checks.
 *
 * Nothing here awaits anything. Decode -> local lookup -> optimistic write ->
 * return. A tech holding a 40kg case in one hand must see the scan register in
 * under 100ms, always, including in a basement with no bars. Any version of
 * this function that returns a Promise resolved by the network has already
 * failed, however fast the server is.
 *
 * But "no network" is not "no checks". The device's own SQLite already knows
 * this camera is checked out to a different job. Warning from local data costs
 * microseconds, and the alternative — telling only the desk — fails at exactly
 * the moment it matters: at 06:14 the desk is closed, two trucks leave, and
 * one crew reaches a set in Raiwind with no A-cam.
 */

export type ScanOutcome =
  | 'accepted'
  | 'duplicate'
  | 'unexpected'
  | 'unknown_tag'
  | 'conflict'

export interface ScanResult {
  outcome: ScanOutcome
  assetId?: string
  assetCode?: string
  displayName?: string
  /** Shown on the row. Never a modal, never a toast that vanishes. */
  message?: string
  /** Set when the tech must give a reason before the row settles. */
  requiresReason?: boolean
  outboxId?: string
}

export interface ScanSessionOptions {
  deviceId: string
  jobId?: string | null
  /** Asset ids the session expects, for a pull or return against a list. */
  expected?: Set<string>
  /** Measured (server_now - device_now). Recorded, never used to rewrite. */
  clockOffsetMs?: number
  now?: () => number
  newId?: () => string
}

interface AssetRow {
  id: string
  asset_code: string | null
  display_name: string | null
  presence: string
  current_job_id: string | null
}

/**
 * One scan session — a pull, a return, or a cycle count.
 *
 * Holds the per-session dedupe set. Suppression lasts the WHOLE SESSION rather
 * than the architecture's 2 seconds: two seconds double-counts an item scanned
 * twice five seconds apart, which is a thing techs do constantly when they are
 * not sure the first one took.
 */
export class ScanSession {
  readonly id: string
  private readonly outbox: Outbox
  private readonly seen = new Map<string, string>()   // assetId -> outboxId
  private readonly now: () => number
  private readonly newId: () => string

  private readonly db: SqlDriver
  private readonly opts: ScanSessionOptions

  constructor(db: SqlDriver, opts: ScanSessionOptions) {
    this.db = db
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? (() => crypto.randomUUID())
    this.id = this.newId()
    this.outbox = new Outbox(db)
  }

  /** Assets recorded so far, in scan order. */
  get scannedIds(): string[] {
    return [...this.seen.keys()]
  }

  /** Expected but not yet scanned — the shortfall, shown while the truck is
   *  still in the yard rather than discovered on somebody's set. */
  get outstanding(): string[] {
    if (!this.opts.expected) return []
    return [...this.opts.expected].filter((id) => !this.seen.has(id))
  }

  /**
   * A decoded tag.
   *
   * Synchronous by design — see the header. The return value drives the haptic
   * and the row; there is no loading state on a scan, ever.
   */
  scan(tagCode: string, eventType = 'check_out'): ScanResult {
    const tag = this.db.get<{ asset_id: string | null; status: string }>(
      `select asset_id, status from asset_tags where tag_code = ?`,
      [tagCode],
    )

    // An unknown tag is RECORDED, not rejected. It may be a label bound on
    // another device since this one last synced. A scan that silently vanishes
    // is how a tech learns the app cannot be trusted.
    if (!tag?.asset_id) {
      const outboxId = this.enqueue({ tag_code: tagCode, event_type: eventType })
      return {
        outcome: 'unknown_tag',
        message: 'Unknown tag — will resolve when this phone syncs',
        outboxId,
      }
    }

    const asset = this.db.get<AssetRow>(
      `select a.id, a.asset_code, p.display_name, a.presence, a.current_job_id
         from assets a left join products p on p.id = a.product_id
        where a.id = ?`,
      [tag.asset_id],
    )
    if (!asset) {
      const outboxId = this.enqueue({ tag_code: tagCode, event_type: eventType })
      return { outcome: 'unknown_tag', message: 'Unknown item', outboxId }
    }

    const base = {
      assetId: asset.id,
      assetCode: asset.asset_code ?? undefined,
      displayName: asset.display_name ?? undefined,
    }

    // Duplicate. Suppress the WRITE, never the FEEDBACK. Silence is
    // indistinguishable from "the camera didn't see it" — the tech rescans,
    // gets nothing, and concludes the scanner is broken, which is precisely
    // how the system dies. The caller fires a distinct double-tick and pulses
    // the existing row.
    if (this.seen.has(asset.id)) {
      return { ...base, outcome: 'duplicate', message: 'Already in this session' }
    }

    // THE LOCAL CONFLICT CHECK.
    if (
      eventType === 'check_out' &&
      asset.presence === 'out' &&
      asset.current_job_id &&
      asset.current_job_id !== this.opts.jobId
    ) {
      const job = this.db.get<{ label: string }>(`select label from jobs where id = ?`, [
        asset.current_job_id,
      ])
      const outboxId = this.enqueue({
        asset_id: asset.id,
        event_type: eventType,
        entry_method: 'scanned',
      })
      this.seen.set(asset.id, outboxId)

      // Records anyway. The truck is real and reality outranks the schedule —
      // but nobody walks away from a collision they could have caught in the
      // yard.
      return {
        ...base,
        outcome: 'conflict',
        message: `Shows as OUT to ${job?.label ?? 'another job'}`,
        requiresReason: true,
        outboxId,
      }
    }

    const unexpected = this.opts.expected ? !this.opts.expected.has(asset.id) : false
    const outboxId = this.enqueue({
      asset_id: asset.id,
      event_type: eventType,
      entry_method: 'scanned',
    })
    this.seen.set(asset.id, outboxId)

    // An unexpected item does not increment the count and does not stop the
    // line. Two inline buttons on the row; neither is required.
    return {
      ...base,
      outcome: unexpected ? 'unexpected' : 'accepted',
      message: unexpected ? 'Not on this job' : undefined,
      outboxId,
    }
  }

  /**
   * The manual fallback — search by code or name, tap to add.
   *
   * Its ABSENCE is what the research names as the single biggest abandonment
   * trigger. A tag under gaffer tape at 06:05 with no path forward teaches a
   * tech on day one that the app has no answer for the real world, and by week
   * three they are back to the paper register.
   *
   * Recorded as entry_method='manual' so it stays visible and countable rather
   * than pretending to be a scan.
   */
  addManually(assetId: string, eventType = 'check_out'): ScanResult {
    const asset = this.db.get<AssetRow>(
      `select a.id, a.asset_code, p.display_name, a.presence, a.current_job_id
         from assets a left join products p on p.id = a.product_id where a.id = ?`,
      [assetId],
    )
    if (!asset) return { outcome: 'unknown_tag', message: 'No such item' }

    if (this.seen.has(asset.id)) {
      return { outcome: 'duplicate', assetId: asset.id, message: 'Already in this session' }
    }

    const outboxId = this.enqueue({
      asset_id: asset.id,
      event_type: eventType,
      entry_method: 'manual',
    })
    this.seen.set(asset.id, outboxId)

    return {
      outcome: 'accepted',
      assetId: asset.id,
      assetCode: asset.asset_code ?? undefined,
      displayName: asset.display_name ?? undefined,
      outboxId,
    }
  }

  /**
   * Bulk-confirm a case's contents WITHOUT scanning each child.
   *
   * Recorded as entry_method='assumed', which is the whole point: it is
   * countable, visible on the manifest, and EXCLUDED FROM DISPUTE EVIDENCE.
   *
   * The alternative — walking the containment tree on a case scan and emitting
   * ordinary check_out events — converts "we believe this is in the case" into
   * a recorded fact with a timestamp and an actor. When the plate turns out to
   * have been pulled on Tuesday and never scanned back, the system then states
   * with total confidence that today's client took it. They did not, and the
   * evidence is a fabrication the database generated.
   */
  confirmContents(assetIds: string[], eventType = 'check_out'): ScanResult[] {
    return assetIds.map((assetId) => {
      if (this.seen.has(assetId)) {
        return { outcome: 'duplicate' as const, assetId }
      }
      const outboxId = this.enqueue({
        asset_id: assetId,
        event_type: eventType,
        entry_method: 'assumed',
      })
      this.seen.set(assetId, outboxId)
      return { outcome: 'accepted' as const, assetId, outboxId }
    })
  }

  private enqueue(payload: Record<string, unknown>): string {
    const id = this.newId()
    const deviceTime = new Date(this.now()).toISOString()

    this.db.transaction(() => {
      this.outbox.enqueue({
        id,
        op: 'submit_scan_batch',
        payload: {
          ...payload,
          session_id: this.id,
          job_id: this.opts.jobId ?? null,
          device_time: deviceTime,
          clock_offset_ms: this.opts.clockOffsetMs ?? 0,
        },
      })

      // Optimistic local projection, in the SAME transaction as the queue row.
      // If these could separate, the UI would show a scan that will never be
      // sent — the tech believes the gear is accounted for and it is not.
      if (typeof payload.asset_id === 'string') {
        const presence =
          payload.event_type === 'check_out'
            ? 'out'
            : payload.event_type === 'check_in'
              ? 'here'
              : null
        if (presence) {
          this.db.exec(
            `update assets set presence = ?, current_job_id = ?, last_scanned_at = ? where id = ?`,
            [
              presence,
              presence === 'out' ? (this.opts.jobId ?? null) : null,
              deviceTime,
              payload.asset_id,
            ],
          )
        }
      }
    })

    return id
  }
}
