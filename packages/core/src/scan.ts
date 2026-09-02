import type { SqlDriver } from './db/driver.ts'
import { Outbox } from './outbox.ts'
import { projectOp } from './project.ts'

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
  | 'retired_tag'
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
  /** Label of the job it is currently out on, for the conflict message. */
  job_label: string | null
}

/**
 * How long the same tag is ignored after it decodes.
 *
 * The camera sees a sticker roughly sixty times a second, so without this one
 * held-up label becomes sixty rows. It is NOT the session dedupe — that lives
 * in ScanSession and lasts the whole session on purpose. This is only about
 * the camera staring at the same thing, so it is short enough that a
 * deliberate rescan a couple of seconds later still gets its double-tick,
 * which is the feedback that tells the tech the scanner is alive.
 */
export const SAME_TAG_QUIET_MS = 1_500

/**
 * The decode-side debounce — one per open camera, not per session.
 *
 * The quiet window runs from the last decode that was ACCEPTED, never the
 * last one merely seen: if a suppressed frame refreshed it, a label held up
 * to the camera would renew its own window sixty times a second and never
 * re-fire.
 */
export class SameTagDebounce {
  private readonly quietMs: number
  private readonly lastAccepted = new Map<string, number>()

  constructor(quietMs = SAME_TAG_QUIET_MS) {
    this.quietMs = quietMs
  }

  /** Whether this decode should be handled, recording it if so. */
  accept(tagCode: string, now = Date.now()): boolean {
    const last = this.lastAccepted.get(tagCode)
    if (last !== undefined && now - last < this.quietMs) return false
    this.lastAccepted.set(tagCode, now)
    return true
  }
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
  // Keyed by asset AND event type. Same asset, same event is the rescan case
  // and is swallowed; same asset, DIFFERENT event is two real things
  // happening to one camera — gear that goes out and comes home in a single
  // session must not have its check_in eaten as a 'duplicate'.
  private readonly seen = new Set<string>()           // `assetId\n eventType`
  private readonly recorded = new Set<string>()       // asset ids, scan order
  private readonly lastOp = new Map<string, string>() // assetId -> outboxId
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
    return [...this.recorded]
  }

  /** Expected but not yet scanned — the shortfall, shown while the truck is
   *  still in the yard rather than discovered on somebody's set. */
  get outstanding(): string[] {
    if (!this.opts.expected) return []
    return [...this.opts.expected].filter((id) => !this.recorded.has(id))
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

    // A RETIRED OR LOST label keeps its asset_id — that IS the historical
    // record — but it must never resolve with full confidence. A peeled
    // label found on the floor and stuck back on the wrong case would scan
    // as whatever it USED to be on, and the wrong camera goes out under the
    // right name, with no warning anywhere. The scan is still recorded (the
    // label is physically in front of the camera; reality outranks the
    // mirror), but by tag_code only, so the server — which knows why the
    // label was revoked — decides what it means.
    if (tag?.asset_id && tag.status !== 'active') {
      const outboxId = this.enqueue({ tag_code: tagCode, event_type: eventType })
      return {
        outcome: 'retired_tag',
        message: tag.status === 'lost'
          ? 'This label was reported lost — check what it is stuck to'
          : 'This label was retired — use the item’s current label',
        outboxId,
      }
    }

    // An unknown tag is RECORDED, not rejected. It may be a label bound on
    // another device since this one last synced. A scan that silently vanishes
    // is how a tech learns the app cannot be trusted.
    //
    // Two ways to be unknown — no tag row, or a tag pointing at an asset this
    // device has not synced — and they take the identical action. Only the
    // wording differs, because the tech can act on the difference: an unknown
    // TAG usually means a fresh label, an unknown ITEM means a stale mirror.
    const asset = tag?.asset_id ? this.loadAsset(tag.asset_id) : undefined
    if (!asset) {
      const outboxId = this.enqueue({ tag_code: tagCode, event_type: eventType })
      return {
        outcome: 'unknown_tag',
        message: tag?.asset_id
          ? 'Unknown item'
          : 'Unknown tag — will resolve when this phone syncs',
        outboxId,
      }
    }

    const base = this.baseResult(asset)

    // Duplicate. Suppress the WRITE, never the FEEDBACK. Silence is
    // indistinguishable from "the camera didn't see it" — the tech rescans,
    // gets nothing, and concludes the scanner is broken, which is precisely
    // how the system dies. The caller fires a distinct double-tick and pulses
    // the existing row.
    if (this.seen.has(seenKey(asset.id, eventType))) {
      return { ...base, outcome: 'duplicate', message: 'Already in this session' }
    }

    // THE LOCAL CONFLICT CHECK.
    if (
      eventType === 'check_out' &&
      asset.presence === 'out' &&
      asset.current_job_id &&
      asset.current_job_id !== this.opts.jobId
    ) {
      const outboxId = this.enqueue({
        asset_id: asset.id,
        event_type: eventType,
        entry_method: 'scanned',
      })
      this.remember(asset.id, eventType, outboxId)

      // Records anyway. The truck is real and reality outranks the schedule —
      // but nobody walks away from a collision they could have caught in the
      // yard.
      return {
        ...base,
        outcome: 'conflict',
        message: `Shows as OUT to ${asset.job_label ?? 'another job'}`,
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
    this.remember(asset.id, eventType, outboxId)

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
    const asset = this.loadAsset(assetId)
    if (!asset) return { outcome: 'unknown_tag', message: 'No such item' }

    if (this.seen.has(seenKey(asset.id, eventType))) {
      // baseResult, matching scan(). This branch used to return only the id,
      // so a duplicate added by hand lost its code and name and the row went
      // blank in the UI — copy-paste drift between two paths that must agree.
      return { ...this.baseResult(asset), outcome: 'duplicate', message: 'Already in this session' }
    }

    const outboxId = this.enqueue({
      asset_id: asset.id,
      event_type: eventType,
      entry_method: 'manual',
    })
    this.remember(asset.id, eventType, outboxId)

    return { ...this.baseResult(asset), outcome: 'accepted', outboxId }
  }

  /**
   * Attach a label to an item.
   *
   * This is how a house gets tagged in the first place: print a sheet, walk a
   * rack, scan a label, pick what it is stuck to. Without it the labels are
   * decoration and the whole fleet has to be entered some other way.
   *
   * IT REFUSES TO MOVE A LABEL THAT IS ALREADY IN USE. Rebinding silently is
   * the worst outcome available here: the tag's entire history quietly
   * transfers to a different camera, and every past scan of the old one now
   * reads as the new one. Two items would also answer to the same label, so
   * scanning either produces the wrong answer with total confidence. Moving a
   * label is a real operation and it belongs at the desk, with a reason
   * attached — not on a phone at 6am.
   */
  bindTag(tagCode: string, assetId: string): ScanResult {
    const existing = this.db.get<{ asset_id: string | null }>(
      `select asset_id from asset_tags where tag_code = ?`,
      [tagCode],
    )

    if (existing?.asset_id && existing.asset_id !== assetId) {
      const other = this.loadAsset(existing.asset_id)
      return {
        outcome: 'conflict',
        message: `That label is already on ${other?.display_name ?? 'another item'}`,
        assetId: existing.asset_id,
        assetCode: other?.asset_code ?? undefined,
        displayName: other?.display_name ?? undefined,
      }
    }

    const asset = this.loadAsset(assetId)
    if (!asset) return { outcome: 'unknown_tag', message: 'No such item' }

    const id = this.newId()
    this.db.transaction(() => {
      this.outbox.enqueue({
        id,
        op: 'bind_tag',
        payload: { tag_code: tagCode, asset_id: assetId, device_time: new Date(this.now()).toISOString() },
      })
      // The local mapping is written straight away so the very next scan of
      // this label resolves. The server is the authority, but a tech who
      // rescans what they just tagged and gets "unknown" concludes it did not
      // work and does it again.
      this.db.exec(
        `insert into asset_tags (tag_code, asset_id, status) values (?, ?, 'active')
         on conflict (tag_code) do update set asset_id = excluded.asset_id, status = 'active'`,
        [tagCode, assetId],
      )
    })

    return { ...this.baseResult(asset), outcome: 'accepted', message: 'Label attached', outboxId: id }
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
      // THE SAME DRIFT AS addManually HAD, in a third place: this used to
      // return the bare id, so every bulk-confirmed row rendered as "Unknown
      // item" with no code — on the one screen where the whole point is
      // reading what you have taken on trust. All three paths now go through
      // baseResult, so a row cannot come back nameless again.
      const asset = this.loadAsset(assetId)
      const base = asset ? this.baseResult(asset) : { assetId }

      if (this.seen.has(seenKey(assetId, eventType))) {
        return { ...base, outcome: 'duplicate' as const, message: 'Already in this session' }
      }
      const outboxId = this.enqueue({
        asset_id: assetId,
        event_type: eventType,
        entry_method: 'assumed',
      })
      this.remember(assetId, eventType, outboxId)
      return { ...base, outcome: 'accepted' as const, message: 'Taken on trust', outboxId }
    })
  }

  /**
   * The asset behind an id, with its product name.
   *
   * One query, used by both the scan path and the manual path. They had two
   * copies differing only in whitespace, which is two places to forget the
   * left join the day an asset has no product — and an intake-by-scan asset
   * legitimately has none until the desk enriches it.
   */
  private loadAsset(assetId: string): AssetRow | undefined {
    // The jobs join costs nothing — it is an indexed lookup on a primary key
    // alongside one this query already does — and it removes a whole separate
    // round trip from the CONFLICT path, which is the slowest path in the
    // scan loop and the one a tech hits when something is already wrong.
    return this.db.get<AssetRow>(
      `select a.id, a.asset_code, p.display_name, a.presence, a.current_job_id,
              j.label as job_label
         from assets a
         left join products p on p.id = a.product_id
         left join jobs     j on j.id = a.current_job_id
        where a.id = ?`,
      [assetId],
    )
  }

  /** The identity fields every ScanResult carries, in one place. */
  private baseResult(asset: AssetRow): Pick<ScanResult, 'assetId' | 'assetCode' | 'displayName'> {
    return {
      assetId: asset.id,
      assetCode: asset.asset_code ?? undefined,
      displayName: asset.display_name ?? undefined,
    }
  }

  /**
   * Marks an asset+event as recorded, and the op as the asset's latest.
   * Every path that enqueues for a known asset ends here, so the dedupe set
   * and the ordering chain cannot drift apart.
   */
  private remember(assetId: string, eventType: string, outboxId: string): void {
    this.seen.add(seenKey(assetId, eventType))
    this.recorded.add(assetId)
    this.lastOp.set(assetId, outboxId)
  }

  private enqueue(payload: Record<string, unknown>): string {
    const id = this.newId()
    const deviceTime = new Date(this.now()).toISOString()

    // Built once and used for both the queue row and the projection, so the
    // two can never disagree about job_id or device_time — they are literally
    // the same object.
    const op = {
      ...payload,
      session_id: this.id,
      job_id: this.opts.jobId ?? null,
      device_time: deviceTime,
      clock_offset_ms: this.opts.clockOffsetMs ?? 0,
    }

    // ORDERING, made real. The outbox's rule — a permanent failure poisons
    // its depends_on subtree — only protects anything if the edges exist,
    // and until now nothing wrote them. A second event for the SAME asset in
    // this session (its check_in after its check_out) genuinely depends on
    // the first: applied without it, the server sees "checked in before it
    // was checked out". So it gets a real edge, and a parked check_out drags
    // its check_in down with it instead of letting it ship alone. Ops for
    // DIFFERENT assets stay independent on purpose — one bad row must never
    // freeze a warehouse's entire sync.
    const dependsOn =
      typeof payload.asset_id === 'string'
        ? this.lastOp.get(payload.asset_id) ?? null
        : null

    this.db.transaction(() => {
      this.outbox.enqueue({ id, op: 'submit_scan_batch', payload: op, dependsOn })

      // Optimistic local projection, in the SAME transaction as the queue row.
      // If these could separate, the UI would show a scan that will never be
      // sent — the tech believes the gear is accounted for and it is not.
      //
      // Shared with the pull replay path; see project.ts for why that matters.
      projectOp(this.db, op)
    })

    return id
  }
}

/** The session dedupe key. A newline can appear in neither an id nor an
 *  event type, so the pair cannot collide with a different pair. */
function seenKey(assetId: string, eventType: string): string {
  return `${assetId}\n${eventType}`
}
