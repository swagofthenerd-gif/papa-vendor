import {
  LOCAL_SCHEMA,
  ScanSession,
  buildPullList,
  checkAvailability,
  matchKitList,
  parseKitList,
  type AvailabilitySummary,
  type CatalogueItem,
  type MatchedLine,
  type PullListView,
  type SqlDriver,
} from '@papa/core'
import { SqlJsDriver } from './sqljs-driver.ts'
import { demoCatalogue, seedDemo, type DemoSeed } from './seed.ts'

/**
 * The demo's one piece of state: a real local database with the demo house in
 * it, plus whichever scan session is open.
 *
 * WHAT IS AND IS NOT PRETENDED HERE. The scan engine, the outbox, the pull
 * list, the kit-list reader and the local double-checkout check are the real
 * ones from `packages/core`, running against a real SQLite. What is faked is
 * only the SERVER: nothing is uploaded, so the outbox fills and never drains.
 * That is deliberate and visible — the sync strip reports scans waiting to
 * send, which is exactly what a phone in a basement shows.
 */
export class DemoStore {
  readonly db: SqlDriver
  readonly seed: DemoSeed
  readonly catalogue: CatalogueItem[]

  private session: ScanSession | null = null
  private sessionJobId: string | null = null

  private constructor(db: SqlDriver, seed: DemoSeed) {
    this.db = db
    this.seed = seed
    this.catalogue = demoCatalogue()
  }

  static async open(): Promise<DemoStore> {
    const db = await SqlJsDriver.open()
    db.exec(LOCAL_SCHEMA)
    const seed = seedDemo(db)
    return new DemoStore(db, seed)
  }

  jobs(): DemoSeed['jobs'] {
    return this.seed.jobs
  }

  job(jobId: string): DemoSeed['jobs'][number] | undefined {
    return this.seed.jobs.find((j) => j.id === jobId)
  }

  /**
   * The session for a job, created on first use and then kept.
   *
   * Kept rather than rebuilt because the session owns the "already scanned in
   * this session" set, and that suppression lasts the whole session by design
   * (scan.ts) — rebuilding it on a re-render would make every duplicate read
   * as a fresh scan and quietly double-count the morning.
   */
  sessionFor(jobId: string): ScanSession {
    if (this.session && this.sessionJobId === jobId) return this.session
    const job = this.job(jobId)
    this.session = new ScanSession(this.db, {
      deviceId: 'demo-device',
      jobId,
      expected: new Set(job?.expected ?? []),
    })
    this.sessionJobId = jobId
    return this.session
  }

  endSession(): void {
    this.session = null
    this.sessionJobId = null
  }

  pullList(jobId: string): PullListView | null {
    const job = this.job(jobId)
    if (!job) return null
    const session = this.sessionFor(jobId)
    return buildPullList(this.db, job.expected, session.scannedIds)
  }

  /** Everything on the shelf, for the manual "can't scan it" path. */
  searchAssets(query: string): { id: string; code: string; name: string }[] {
    const q = `%${query.trim()}%`
    return this.db
      .all<{ id: string; asset_code: string | null; display_name: string | null }>(
        `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name
           from assets a
           left join products p on p.id = a.product_id
          where a.asset_code like ? or coalesce(p.display_name, a.display_name) like ?
          order by a.asset_code
          limit 40`,
        [q, q],
      )
      .map((r) => ({ id: r.id, code: r.asset_code ?? '—', name: r.display_name ?? 'Unnamed' }))
  }

  /** Answer a pasted WhatsApp kit list against the demo catalogue. */
  checkKitList(text: string): AvailabilitySummary {
    const matched = matchKitList(parseKitList(text), this.catalogue)
    return checkAvailability(this.db, matched)
  }

  /** Re-answer a list after the desk has resolved a line by hand. */
  recheck(lines: MatchedLine[]): AvailabilitySummary {
    return checkAvailability(this.db, lines)
  }

  outboxCounts(): { pending: number; failures: number; oldestAgeMs: number } {
    const row = this.db.get<{ pending: number; failures: number; oldest: number | null }>(
      `select
         sum(case when state in ('pending','inflight') then 1 else 0 end) as pending,
         sum(case when state = 'failed' then 1 else 0 end) as failures,
         min(case when state in ('pending','inflight') then created_at end) as oldest
       from outbox`,
    )
    const oldest = row?.oldest ?? null
    return {
      pending: Number(row?.pending ?? 0),
      failures: Number(row?.failures ?? 0),
      oldestAgeMs: oldest === null ? 0 : Date.now() - Number(oldest),
    }
  }

  /** How many of a job's expected items are already recorded, for the Today list. */
  scannedCount(jobId: string): number {
    if (this.sessionJobId !== jobId || !this.session) return 0
    return this.session.scannedIds.length
  }
}
