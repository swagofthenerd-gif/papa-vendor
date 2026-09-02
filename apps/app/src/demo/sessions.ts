import { ScanSession, type SqlDriver } from '@papa/core'

/**
 * The open scan sessions — the pure part.
 *
 * In a .ts module, like scan-row.ts and session-summary.ts, so it can be
 * asserted without a build step — and apart from store.ts, whose sql.js
 * driver cannot load under plain Node at all.
 *
 * THE REGRESSION THIS SHAPE EXISTS TO PREVENT. The store used to hold exactly
 * ONE live session, so opening a return mid-prep destroyed the prep session's
 * dedupe set and expected snapshot. Coming back to the prep, every rescan
 * read as a fresh scan and wrote a second op — the morning quietly
 * double-counted. Sessions are therefore keyed by (job, direction): each
 * keeps its own ScanSession and its own expected snapshot, switching jobs
 * RESUMES rather than rebuilds, and finishing one touches only that one.
 */

/**
 * The direction a session runs in. Deliberately narrower than nav's ScanMode:
 * 'lookup' has no entry here because looking something up opens no session
 * and writes nothing.
 */
export type SessionMode = 'out' | 'in'

export interface SessionEntry {
  readonly jobId: string
  readonly mode: SessionMode
  readonly session: ScanSession
  /**
   * What this session is looking for, captured when it opened.
   *
   * A SNAPSHOT, not a live query. On a return the expected set is "what is
   * physically out on this job", and checking an item in removes it from that
   * query — so re-asking on every render shrank the denominator as the tech
   * worked: four items to find became "0 of 1" after three scans. A total
   * that melts while you look at it is the fastest way to lose someone's
   * trust in the screen, and it hides the one number that matters, which is
   * how many are still missing.
   */
  readonly expected: string[]
}

export class SessionRegistry {
  private readonly entries = new Map<string, SessionEntry>()
  /** The entry most recently opened — the one photos attach to and the one
   *  "done" on the handover card completes. */
  private currentKey: string | null = null
  /** The direction most recently opened per job, so a handover card reached
   *  with only a job id lands on the session the tech just finished. */
  private readonly lastMode = new Map<string, SessionMode>()

  // Plain assignments rather than parameter properties: Node runs these .ts
  // modules by stripping types only, and a parameter property is a transform,
  // not a type — it would make this module untestable (the whole reason it
  // is a module).
  private readonly db: SqlDriver
  private readonly deviceId: string
  private readonly expectedFor: (jobId: string, mode: SessionMode) => string[]

  constructor(
    db: SqlDriver,
    deviceId: string,
    expectedFor: (jobId: string, mode: SessionMode) => string[],
  ) {
    this.db = db
    this.deviceId = deviceId
    this.expectedFor = expectedFor
  }

  /**
   * The session for a job and direction, created on first use and then KEPT.
   *
   * Kept rather than rebuilt because the session owns the "already scanned in
   * this session" set, and that suppression lasts the whole session by design
   * (scan.ts) — rebuilding it would make every duplicate read as a fresh scan
   * and quietly double-count the morning.
   */
  open(jobId: string, mode: SessionMode): SessionEntry {
    const key = entryKey(jobId, mode)
    let entry = this.entries.get(key)
    if (!entry) {
      const expected = this.expectedFor(jobId, mode)
      entry = {
        jobId,
        mode,
        expected,
        session: new ScanSession(this.db, {
          deviceId: this.deviceId,
          jobId,
          expected: new Set(expected),
        }),
      }
      this.entries.set(key, entry)
    }
    this.currentKey = key
    this.lastMode.set(jobId, mode)
    return entry
  }

  /**
   * An existing session, without creating one. With no direction given it is
   * the job's most recently opened one — what a handover card means by "the
   * session on this job".
   */
  peek(jobId: string, mode?: SessionMode): SessionEntry | null {
    const m = mode ?? this.lastMode.get(jobId)
    if (!m) return null
    return this.entries.get(entryKey(jobId, m)) ?? null
  }

  /** The entry most recently opened, if it is still running. */
  current(): SessionEntry | null {
    return this.currentKey ? this.entries.get(this.currentKey) ?? null : null
  }

  /**
   * Complete the current session — and ONLY that one.
   *
   * Ending everything here is exactly the single-session bug wearing a
   * different hat: "done" on the wedding's handover must not throw away the
   * TVC prep still half-scanned in the yard.
   */
  endCurrent(): void {
    if (!this.currentKey) return
    const entry = this.entries.get(this.currentKey)
    this.entries.delete(this.currentKey)
    if (entry && this.lastMode.get(entry.jobId) === entry.mode) {
      this.lastMode.delete(entry.jobId)
    }
    this.currentKey = null
  }
}

/** A newline can appear in neither a job id nor a mode, so the pair cannot
 *  collide with a different pair — same trick as scan.ts's seenKey. */
function entryKey(jobId: string, mode: SessionMode): string {
  return `${jobId}\n${mode}`
}
