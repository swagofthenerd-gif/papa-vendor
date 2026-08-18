import {
  LOCAL_SCHEMA,
  PhotoStore,
  ScanSession,
  caseManifest,
  hasContents,
  pairBySide,
  buildPullList,
  checkAvailability,
  matchKitList,
  parseKitList,
  type AvailabilitySummary,
  type CatalogueItem,
  type CaptureResult,
  type ImportPlan,
  type CaseManifest,
  type PhotoPair,
  type MatchedLine,
  type PullListView,
  type SqlDriver,
} from '@papa/core'
import { SqlJsDriver } from './sqljs-driver.ts'
import { demoCatalogue, seedDemo, type DemoSeed } from './seed.ts'
import type { ScanMode } from '../nav.ts'
import type { GearRow } from '../routes/Gear.tsx'
import type { TodayStats } from '../routes/Today.tsx'
import type { AssetHistoryRow, AssetView } from '../routes/Asset.tsx'
import { buildSummary, type SessionSummary } from '../session-summary.ts'

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
  catalogue: CatalogueItem[]

  private session: ScanSession | null = null
  private sessionJobId: string | null = null
  private sessionMode: ScanMode = 'out'
  /**
   * What the OPEN session is looking for, captured when it opened.
   *
   * A SNAPSHOT, not a live query. On a return the expected set is "what is
   * physically out on this job", and checking an item in removes it from that
   * query — so re-asking on every render shrank the denominator as the tech
   * worked: four items to find became "0 of 1" after three scans. A total that
   * melts while you look at it is the fastest way to lose someone's trust in
   * the screen, and it hides the one number that matters, which is how many
   * are still missing.
   */
  private sessionExpected: string[] = []
  readonly photos: PhotoStore

  private constructor(db: SqlDriver, seed: DemoSeed) {
    this.db = db
    this.seed = seed
    this.catalogue = demoCatalogue()
    // A deliberately small budget in the demo — a few megabytes rather than
    // 512 — so the "device full" refusal is reachable by a person trying the
    // app for ten minutes, instead of being a branch nobody ever sees.
    this.photos = new PhotoStore(db, { budgetBytes: 6 * 1024 * 1024 })
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
  sessionFor(jobId: string, mode: ScanMode = 'out'): ScanSession {
    if (this.session && this.sessionJobId === jobId && this.sessionMode === mode) {
      return this.session
    }
    const expected = this.expectedFor(jobId, mode)
    this.session = new ScanSession(this.db, {
      deviceId: 'demo-device',
      jobId,
      expected: new Set(expected),
    })
    this.sessionJobId = jobId
    this.sessionMode = mode
    this.sessionExpected = expected
    return this.session
  }

  /**
   * What a session is looking for.
   *
   * GOING OUT it is the job's list — what was promised. COMING BACK it is what
   * is PHYSICALLY OUT on that job right now, which is a different set and the
   * only one that can answer "did everything come home".
   *
   * Reconciling a return against the original list instead would report a
   * shortfall for anything that never left in the first place — the four items
   * that followed on the 2pm run and the one the desk swapped at the door —
   * and a return screen that cries wolf on the normal case is one a tech stops
   * reading by the second week.
   */
  expectedFor(jobId: string, mode: ScanMode): string[] {
    const job = this.job(jobId)
    if (mode === 'out') return job?.expected ?? []
    return this.db
      .all<{ id: string }>(
        `select id from assets
          where current_job_id = ? and presence in ('out', 'in_transit')
          order by asset_code`,
        [jobId],
      )
      .map((r) => r.id)
  }

  endSession(): void {
    this.session = null
    this.sessionJobId = null
    this.sessionMode = 'out'
    this.sessionExpected = []
  }

  /** Which direction the open session is running in. */
  get openMode(): ScanMode {
    return this.sessionMode
  }

  /** Jobs with gear physically out, for the "bring it back" list. */
  jobsWithGearOut(): { id: string; label: string; out: number }[] {
    return this.db
      .all<{ job_id: string; n: number }>(
        `select current_job_id as job_id, count(*) as n from assets
          where current_job_id is not null and presence in ('out', 'in_transit')
          group by current_job_id`,
      )
      .map((r) => ({
        id: r.job_id,
        label: this.job(r.job_id)?.label ?? 'Gear out with no job',
        out: Number(r.n),
      }))
  }

  pullList(jobId: string, mode: ScanMode = 'out'): PullListView | null {
    if (!this.job(jobId)) return null
    const session = this.sessionFor(jobId, mode)
    return buildPullList(this.db, this.sessionExpected, session.scannedIds)
  }

  /**
   * Photograph an item's condition.
   *
   * Returns the engine's own result, refusal included, so the screen can say
   * how many photos are waiting rather than just failing.
   */
  capturePhoto(input: {
    assetId: string
    side: 'out' | 'in'
    dataUri: string
    bytes: number
    sha256: string
  }): CaptureResult {
    return this.photos.capture({
      assetId: input.assetId,
      jobId: this.sessionJobId,
      sessionId: this.session?.id ?? null,
      side: input.side,
      localUri: input.dataUri,
      bytes: input.bytes,
      sha256: input.sha256,
    })
  }

  /** The out/in comparison for one item. */
  photoPairs(assetId: string): PhotoPair[] {
    return pairBySide(this.photos.forAsset(assetId))
  }

  /** How much evidence exists only on this device. */
  photoBacklog(): { count: number; bytes: number } {
    return this.photos.pendingStats()
  }

  /** What a case claims to contain, or null if it contains nothing. */
  manifestFor(assetId: string): CaseManifest | null {
    if (!hasContents(this.db, assetId)) return null
    return caseManifest(this.db, assetId)
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

  /**
   * Apply an import plan.
   *
   * Everything lands in ONE transaction. A half-applied catalogue is the worst
   * outcome available here: the person has no way to tell which half went in,
   * and running the file again would double whatever did.
   *
   * Rows the planner could not decide are created as their OWN product, never
   * merged into the thing they resemble. That is the same refusal the kit-list
   * reader makes between C300 and C500, for the same reason.
   */
  applyImport(plan: ImportPlan): { products: number; units: number } {
    let products = 0
    let units = 0

    this.db.transaction(() => {
      const idFor = new Map<string, string>()

      for (const { row, verdict } of plan.rows) {
        if (verdict.kind === 'rejected') continue

        let productId: string
        if (verdict.kind === 'existing' && !verdict.productId.startsWith('file:')) {
          productId = verdict.productId
        } else {
          const key = row.name.toLowerCase().trim()
          const already = idFor.get(key)
          if (already) {
            productId = already
          } else {
            productId = `prod-imported-${slug(row.name)}-${products}`
            this.db.exec(
              `insert into products (id, org_id, display_name, category) values (?, ?, ?, ?)`,
              [productId, this.seed.orgId, row.name, row.category ?? 'other'],
            )
            idFor.set(key, productId)
            products++
          }
        }

        const locationId = row.location ? this.locationIdFor(row.location) : null
        for (let i = 1; i <= row.quantity; i++) {
          const assetId = `asset-imported-${slug(row.name)}-${row.line}-${i}`
          const code = row.code ? `${row.code}-${String(i).padStart(2, '0')}` : assetId
          this.db.exec(
            `insert into assets
               (id, org_id, product_id, asset_code, serial_number, display_name,
                presence, health, ownership, current_location_id, current_job_id, updated_at)
             values (?, ?, ?, ?, ?, ?, 'here', 'ok', 'owned', ?, null, ?)`,
            [
              assetId, this.seed.orgId, productId, code,
              // A serial belongs to ONE physical unit. Copying it onto every
              // unit of a multi-quantity row would put the same serial on
              // twelve batteries, which is worse than having none.
              row.quantity === 1 ? row.serial : null,
              row.name, locationId, new Date().toISOString(),
            ],
          )
          units++
        }
      }
    })

    this.refreshCatalogue()
    return { products, units }
  }

  /** A shelf by name, created on first sight so an import cannot lose one. */
  private locationIdFor(name: string): string {
    const existing = this.db.get<{ id: string }>(
      `select id from locations where lower(name) = lower(?)`,
      [name],
    )
    if (existing) return existing.id
    const id = `loc-imported-${slug(name)}`
    this.db.exec(
      `insert into locations (id, org_id, name, kind, path, code) values (?, ?, ?, 'shelf', ?, ?)`,
      [id, this.seed.orgId, name, name, name],
    )
    return id
  }

  /**
   * Re-read the catalogue the kit-list matcher uses.
   *
   * Load-bearing: the whole point of the import is that a client's message is
   * matched against the house's OWN names, and the matcher holds its list in
   * memory. Without this the app would import four hundred products and go on
   * answering enquiries from the demo's twenty-one.
   */
  private refreshCatalogue(): void {
    this.catalogue = this.db
      .all<{ id: string; display_name: string | null }>(
        `select id, display_name from products order by display_name`,
      )
      .map((r) => ({ id: r.id, name: r.display_name ?? 'Unnamed' }))
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

  /** The whole fleet, for the inventory screen. */
  gearRows(): GearRow[] {
    return this.db
      .all<{
        id: string
        asset_code: string | null
        display_name: string | null
        category: string | null
        presence: string
        health: string
        location_name: string | null
        job_label: string | null
      }>(
        `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name,
                p.category, a.presence, a.health,
                l.name as location_name, j.label as job_label
           from assets a
           left join products  p on p.id = a.product_id
           left join locations l on l.id = a.current_location_id
           left join jobs      j on j.id = a.current_job_id
          order by a.asset_code`,
      )
      .map((r) => ({
        id: r.id,
        code: r.asset_code ?? '—',
        name: r.display_name ?? 'Unnamed',
        category: r.category ?? 'other',
        presence: (r.presence as GearRow['presence']) ?? 'here',
        health: (r.health as GearRow['health']) ?? 'ok',
        locationName: r.location_name,
        jobLabel: r.job_label,
      }))
  }

  /** The counters on the Today board. */
  stats(): TodayStats {
    const row = this.db.get<{ out_now: number; on_shelf: number; attention: number }>(
      `select
         sum(case when presence in ('out','in_transit') then 1 else 0 end) as out_now,
         sum(case when presence = 'here' and health = 'ok' then 1 else 0 end) as on_shelf,
         sum(case when health <> 'ok' then 1 else 0 end) as attention
       from assets`,
    )
    return {
      outNow: Number(row?.out_now ?? 0),
      onShelf: Number(row?.on_shelf ?? 0),
      // No bookings yet, so nothing can be late by a date. Reported as zero
      // rather than invented, because a made-up overdue count is the fastest
      // way to teach an owner that the numbers here are decorative.
      dueBack: 0,
      overdue: 0,
      needsAttention: Number(row?.attention ?? 0),
    }
  }

  /**
   * One asset, with its history.
   *
   * The history is read back out of the OUTBOX. On a real device it comes from
   * the server's append-only scan log; here nothing is ever uploaded, so the
   * queue is the only record of what this phone did — which is exactly what
   * the queue is on a real phone in a basement, too.
   */
  assetView(assetId: string): AssetView | null {
    const row = this.db.get<{
      id: string
      asset_code: string | null
      display_name: string | null
      category: string | null
      presence: string
      health: string
      serial_number: string | null
      location_name: string | null
      job_label: string | null
      tag_code: string | null
    }>(
      `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name,
              p.category, a.presence, a.health, a.serial_number,
              l.name as location_name, j.label as job_label, t.tag_code
         from assets a
         left join products   p on p.id = a.product_id
         left join locations  l on l.id = a.current_location_id
         left join jobs       j on j.id = a.current_job_id
         left join asset_tags t on t.asset_id = a.id
        where a.id = ?`,
      [assetId],
    )
    if (!row) return null

    const history: AssetHistoryRow[] = this.db
      .all<{ id: string; payload: string; created_at: number }>(
        `select id, payload, created_at from outbox
          where op = 'submit_scan_batch' order by seq desc`,
      )
      .flatMap((o): AssetHistoryRow[] => {
        const op = JSON.parse(o.payload) as Record<string, unknown>
        if (op.asset_id !== assetId) return []
        const jobId = typeof op.job_id === 'string' ? op.job_id : null
        return [{
          id: o.id,
          event: String(op.event_type ?? 'check_out'),
          at: new Date(o.created_at).toLocaleString(),
          entryMethod: String(op.entry_method ?? 'scanned'),
          jobLabel: jobId ? (this.job(jobId)?.label ?? null) : null,
          actor: this.seed.userName,
        }]
      })

    return {
      id: row.id,
      code: row.asset_code ?? '—',
      name: row.display_name ?? 'Unnamed',
      category: row.category ?? 'other',
      presence: (row.presence as AssetView['presence']) ?? 'here',
      health: (row.health as AssetView['health']) ?? 'ok',
      locationName: row.location_name,
      jobLabel: row.job_label,
      serial: row.serial_number,
      tagCode: row.tag_code,
      history,
    }
  }

  /**
   * The handover summary for whatever session is open on this job.
   *
   * Composition, never completion: what was scanned, what was taken on trust,
   * and what is still on the shelf. There is no field here for "complete",
   * because there is no such fact.
   */
  sessionSummary(jobId: string): SessionSummary | null {
    const job = this.job(jobId)
    if (!job || this.sessionJobId !== jobId || !this.session) return null
    const sessionId = this.session.id
    const mode = this.sessionMode

    // Read back from the QUEUE, not from the screen: the queue is what was
    // actually written, and on a real phone it is the only record that exists
    // until a sync happens.
    const ops = this.db
      .all<{ id: string; payload: string }>(
        `select id, payload from outbox where op = 'submit_scan_batch' order by seq`,
      )
      .map((o) => ({ id: o.id, op: JSON.parse(o.payload) as Record<string, unknown> }))
      .filter((o) => o.op.session_id === sessionId)

    const recorded: string[] = []
    const assumed: string[] = []
    const unknownTags: { key: string }[] = []
    for (const { id, op } of ops) {
      const assetId = typeof op.asset_id === 'string' ? op.asset_id : null
      if (!assetId) { unknownTags.push({ key: id }); continue }
      recorded.push(assetId)
      if (op.entry_method === 'assumed') assumed.push(assetId)
    }

    return buildSummary({
      jobLabel: job.label,
      mode,
      expected: this.sessionExpected,
      recorded,
      assumed,
      unknownTags,
      facts: (id) => {
        const row = this.db.get<{ asset_code: string | null; display_name: string | null }>(
          `select a.asset_code, coalesce(p.display_name, a.display_name) as display_name
             from assets a left join products p on p.id = a.product_id where a.id = ?`,
          [id],
        )
        return row ? { id, code: row.asset_code, name: row.display_name } : undefined
      },
    })
  }

  /** How many of a job's expected items are already recorded, for the Today list. */
  scannedCount(jobId: string): number {
    if (this.sessionJobId !== jobId || !this.session) return 0
    return this.session.scannedIds.length
  }
}

/** A safe, stable id fragment from a product name. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}
