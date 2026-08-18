import type { SqlDriver } from './db/driver.ts'

/**
 * Condition photos — the out/in comparison.
 *
 * This is the commercial argument for the whole product. Not "we know where
 * our gear is", which is a benefit; this is the story that travels between
 * rental houses: *"He said we scratched it. I sent him the photo from the day
 * it went out. He paid."*
 *
 * ---------------------------------------------------------------------------
 * TWO RULES THAT LOOK LIKE POLICY AND ARE ACTUALLY CORRECTNESS
 *
 * 1. NOTHING HERE EVER DELETES A PHOTO THAT HAS NOT BEEN UPLOADED.
 *    When the device fills up, `capture()` REFUSES and says so. The obvious
 *    alternative — evict the oldest to make room — trades a recoverable
 *    problem for an unrecoverable one: a blocked capture is a person walking
 *    to a laptop, while a deleted photo is the out-side half of a dispute,
 *    gone, and nobody finds out until a client claims for a crack.
 *
 * 2. THE DEVICE CLOCK IS NEVER PRESENTED AS FACT.
 *    `capturedAt` is whatever the phone believed at the time, and it is
 *    labelled as the phone's clock everywhere it is shown. The server stamps
 *    its own `receivedAt` on arrival, and only that one is evidence. A photo
 *    whose only timestamp came from the device that took it proves nothing
 *    against a determined counterparty — including the staff member who
 *    scratched the lens.
 * ---------------------------------------------------------------------------
 */

export type PhotoSide = 'out' | 'in'

export interface PhotoRow {
  id: string
  assetId: string
  jobId: string | null
  sessionId: string | null
  side: PhotoSide
  /** The DEVICE's clock at capture. Untrusted; always labelled as such. */
  capturedAt: number
  sha256: string | null
  bytes: number
  localUri: string
  note: string | null
  uploaded: boolean
}

export interface CaptureInput {
  assetId: string
  jobId?: string | null
  sessionId?: string | null
  side: PhotoSide
  /** Where the bytes live. A data URI in the browser, a file path on Android. */
  localUri: string
  bytes: number
  sha256?: string | null
  note?: string | null
}

export type CaptureResult =
  | { ok: true; photo: PhotoRow }
  | { ok: false; reason: 'device_full'; waiting: number; bytesWaiting: number }

/**
 * How much un-uploaded photo data the device will hold before it stops
 * accepting more.
 *
 * A real budget rather than "until the disk dies", because the failure at the
 * disk boundary is the operating system killing the app mid-write, and a
 * half-written photo is indistinguishable from a photo nobody took.
 */
export const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024

export class PhotoStore {
  private readonly db: SqlDriver
  private readonly budgetBytes: number
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    db: SqlDriver,
    opts: { budgetBytes?: number; now?: () => number; newId?: () => string } = {},
  ) {
    this.db = db
    this.budgetBytes = opts.budgetBytes ?? DEFAULT_BUDGET_BYTES
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Record a photo, or refuse and say why.
   *
   * Refusing is a real outcome, not an error: the caller shows the count of
   * photos still waiting to send, which is the number that tells a person what
   * to actually do about it.
   */
  capture(input: CaptureInput): CaptureResult {
    const pending = this.pendingStats()
    if (pending.bytes + input.bytes > this.budgetBytes) {
      return {
        ok: false,
        reason: 'device_full',
        waiting: pending.count,
        bytesWaiting: pending.bytes,
      }
    }

    const photo: PhotoRow = {
      id: this.newId(),
      assetId: input.assetId,
      jobId: input.jobId ?? null,
      sessionId: input.sessionId ?? null,
      side: input.side,
      capturedAt: this.now(),
      sha256: input.sha256 ?? null,
      bytes: input.bytes,
      localUri: input.localUri,
      note: input.note ?? null,
      uploaded: false,
    }

    // The row and its upload queue entry are written together. If they can
    // separate, the app shows a photo that will never leave the phone — which
    // reads to the owner exactly like evidence they have, and do not.
    this.db.transaction(() => {
      this.db.exec(
        `insert into condition_photos
           (id, asset_id, job_id, session_id, side, captured_at, sha256, bytes, local_uri, note, uploaded)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          photo.id, photo.assetId, photo.jobId, photo.sessionId, photo.side,
          photo.capturedAt, photo.sha256, photo.bytes, photo.localUri, photo.note,
        ],
      )
      this.db.exec(
        `insert into pending_uploads (id, local_uri, target_path, sha256, bytes, state, created_at)
         values (?, ?, ?, ?, ?, 'pending', ?)`,
        [
          photo.id,
          photo.localUri,
          // Content-addressed, so an overwrite is semantically impossible: the
          // path IS the hash of the bytes. A mutable storage path is what lets
          // a later photo quietly replace the one that was inconvenient.
          `photos/${photo.sha256 ?? photo.id}`,
          photo.sha256,
          photo.bytes,
          photo.capturedAt,
        ],
      )
    })

    return { ok: true, photo }
  }

  /** Everything photographed for one asset, newest first. */
  forAsset(assetId: string): PhotoRow[] {
    return this.db
      .all<Record<string, never>>(
        `select * from condition_photos where asset_id = ? order by captured_at desc`,
        [assetId],
      )
      .map(toRow)
  }

  /** Everything photographed during one scan session. */
  forSession(sessionId: string): PhotoRow[] {
    return this.db
      .all<Record<string, never>>(
        `select * from condition_photos where session_id = ? order by captured_at desc`,
        [sessionId],
      )
      .map(toRow)
  }

  /** How much is still only on this phone. */
  pendingStats(): { count: number; bytes: number } {
    const row = this.db.get<{ n: number; b: number | null }>(
      `select count(*) as n, sum(bytes) as b from condition_photos where uploaded = 0`,
    )
    return { count: Number(row?.n ?? 0), bytes: Number(row?.b ?? 0) }
  }

  /** Remaining room, for the "device filling up" warning before it is full. */
  budgetUsedFraction(): number {
    return this.pendingStats().bytes / this.budgetBytes
  }
}

function toRow(r: Record<string, unknown>): PhotoRow {
  return {
    id: String(r.id),
    assetId: String(r.asset_id),
    jobId: r.job_id === null ? null : String(r.job_id),
    sessionId: r.session_id === null ? null : String(r.session_id),
    side: String(r.side) === 'in' ? 'in' : 'out',
    capturedAt: Number(r.captured_at),
    sha256: r.sha256 === null ? null : String(r.sha256),
    bytes: Number(r.bytes),
    localUri: String(r.local_uri),
    note: r.note === null ? null : String(r.note),
    uploaded: Number(r.uploaded) === 1,
  }
}

/**
 * The comparison: what this asset looked like leaving, beside what it looked
 * like coming back.
 *
 * Pairs by NEAREST IN TIME AFTER, not by index. Pairing positionally breaks
 * the moment someone takes two photos of one side — which is the normal case,
 * because the second photo is usually of the thing that worried them — and a
 * mispaired comparison is worse than none: it shows a client a crack that was
 * already there and blames them for it.
 *
 * An unpaired photo is RETURNED, not dropped. "It went out, we have no photo
 * of it coming back" is itself a finding.
 */
export interface PhotoPair {
  assetId: string
  out: PhotoRow | null
  in: PhotoRow | null
}

export function pairBySide(photos: PhotoRow[]): PhotoPair[] {
  const outs = photos.filter((p) => p.side === 'out').sort((a, b) => a.capturedAt - b.capturedAt)
  const ins = photos.filter((p) => p.side === 'in').sort((a, b) => a.capturedAt - b.capturedAt)

  const pairs: PhotoPair[] = []
  const usedIns = new Set<string>()

  for (const out of outs) {
    const match = ins.find((i) => !usedIns.has(i.id) && i.capturedAt >= out.capturedAt)
    if (match) usedIns.add(match.id)
    pairs.push({ assetId: out.assetId, out, in: match ?? null })
  }

  // A return photographed with no out-side photo. Common and worth surfacing:
  // it means the gear left without evidence, which is the gap that costs money.
  for (const i of ins) {
    if (!usedIns.has(i.id)) pairs.push({ assetId: i.assetId, out: null, in: i })
  }

  return pairs
}
