import type { SqlDriver } from './db/driver.ts'

/**
 * Voice notes — the awaaz note (0021; vendor-dream-plan Phase D5).
 *
 * Bykea's lesson, applied: typing is the barrier. The tech holding a
 * scratched lens at the dock will not thumb out a paragraph, but they will
 * hold a button and say "yeh scratch pehle se tha, Hamza ke shoot pe bhi
 * tha" — ten spoken seconds that settle an argument three weeks later.
 *
 * THE STORAGE MODEL IS THE CONDITION-PHOTOS MODEL, EXACTLY. Both rules
 * that look like policy and are actually correctness (photos.ts):
 *
 * 1. NOTHING HERE EVER DELETES A NOTE THAT HAS NOT BEEN UPLOADED. When the
 *    budget is full, `capture()` REFUSES and says so. Evicting the oldest
 *    to make room trades a recoverable problem (a person walks to a
 *    laptop) for an unrecoverable one: the spoken half of a dispute, gone.
 * 2. THE DEVICE CLOCK IS NEVER PRESENTED AS FACT. `capturedAt` is the
 *    phone's clock, labelled as such; only a server's own stamp is
 *    evidence.
 *
 * Demo-honest: nothing uploads yet. The rows queue in pending_uploads
 * beside the photos and the sync strip counts them the same way.
 */

export interface VoiceNoteRow {
  id: string
  assetId: string | null
  jobId: string | null
  sessionId: string | null
  durationMs: number
  /** The DEVICE's clock at capture. Untrusted; always labelled as such. */
  capturedAt: number
  bytes: number
  mime: string | null
  localUri: string
  uploaded: boolean
}

export interface VoiceCaptureInput {
  assetId?: string | null
  jobId?: string | null
  sessionId?: string | null
  durationMs: number
  /** Where the bytes live. A data URI in the browser, a file path on Android. */
  localUri: string
  bytes: number
  mime?: string | null
}

export type VoiceCaptureResult =
  | { ok: true; note: VoiceNoteRow }
  | { ok: false; reason: 'device_full'; waiting: number; bytesWaiting: number }

/**
 * How much un-uploaded audio the device holds before it stops accepting
 * more. Smaller than the photo budget on purpose: a minute of Opus is
 * ~100KB, so even this holds hours of speech — and the refusal message is
 * reachable long before the disk is.
 */
export const DEFAULT_VOICE_BUDGET_BYTES = 64 * 1024 * 1024

export class VoiceNoteStore {
  private readonly db: SqlDriver
  private readonly budgetBytes: number
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    db: SqlDriver,
    opts: { budgetBytes?: number; now?: () => number; newId?: () => string } = {},
  ) {
    this.db = db
    this.budgetBytes = opts.budgetBytes ?? DEFAULT_VOICE_BUDGET_BYTES
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Record a note, or refuse and say why. Refusing is a real outcome, not
   * an error: the caller shows how many notes are still waiting to send,
   * which is the number that tells a person what to actually do about it.
   */
  capture(input: VoiceCaptureInput): VoiceCaptureResult {
    const pending = this.pendingStats()
    if (pending.bytes + input.bytes > this.budgetBytes) {
      return {
        ok: false,
        reason: 'device_full',
        waiting: pending.count,
        bytesWaiting: pending.bytes,
      }
    }

    const note: VoiceNoteRow = {
      id: this.newId(),
      assetId: input.assetId ?? null,
      jobId: input.jobId ?? null,
      sessionId: input.sessionId ?? null,
      durationMs: input.durationMs,
      capturedAt: this.now(),
      bytes: input.bytes,
      mime: input.mime ?? null,
      localUri: input.localUri,
      uploaded: false,
    }

    // The row and its upload queue entry are written together, the photo
    // rule: if they could separate, the app would show a note that will
    // never leave the phone.
    this.db.transaction(() => {
      this.db.exec(
        `insert into voice_notes
           (id, asset_id, job_id, session_id, duration_ms, captured_at, bytes, mime, local_uri, uploaded)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          note.id, note.assetId, note.jobId, note.sessionId, note.durationMs,
          note.capturedAt, note.bytes, note.mime, note.localUri,
        ],
      )
      this.db.exec(
        `insert into pending_uploads (id, local_uri, target_path, sha256, bytes, state, created_at)
         values (?, ?, ?, null, ?, 'pending', ?)`,
        // Audio blobs are not content-addressed like photos (no hash is
        // computed at the mic); the id-keyed path still cannot overwrite,
        // because ids are minted once.
        [note.id, note.localUri, `voice/${note.id}`, note.bytes, note.capturedAt],
      )
    })

    return { ok: true, note }
  }

  /** Every note spoken over one asset, newest first. */
  forAsset(assetId: string): VoiceNoteRow[] {
    return this.db
      .all<Record<string, never>>(
        `select * from voice_notes where asset_id = ? order by captured_at desc`,
        [assetId],
      )
      .map(toRow)
  }

  /** Every note spoken during one scan session, newest first. */
  forSession(sessionId: string): VoiceNoteRow[] {
    return this.db
      .all<Record<string, never>>(
        `select * from voice_notes where session_id = ? order by captured_at desc`,
        [sessionId],
      )
      .map(toRow)
  }

  /** How much speech is still only on this phone. */
  pendingStats(): { count: number; bytes: number } {
    const row = this.db.get<{ n: number; b: number | null }>(
      `select count(*) as n, sum(bytes) as b from voice_notes where uploaded = 0`,
    )
    return { count: Number(row?.n ?? 0), bytes: Number(row?.b ?? 0) }
  }
}

function toRow(r: Record<string, unknown>): VoiceNoteRow {
  return {
    id: String(r.id),
    assetId: r.asset_id === null ? null : String(r.asset_id),
    jobId: r.job_id === null ? null : String(r.job_id),
    sessionId: r.session_id === null ? null : String(r.session_id),
    durationMs: Number(r.duration_ms),
    capturedAt: Number(r.captured_at),
    bytes: Number(r.bytes),
    mime: r.mime === null ? null : String(r.mime),
    localUri: String(r.local_uri),
    uploaded: Number(r.uploaded) === 1,
  }
}
