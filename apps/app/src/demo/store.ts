import {
  LOCAL_SCHEMA,
  PhotoStore,
  ScanSession,
  lookupTag,
  caseManifest,
  hasContents,
  pairBySide,
  buildPullList,
  checkAvailability,
  matchKitList,
  parseKitList,
  overdueNudgeMessage,
  parsePhoneNumber,
  whatsAppNudgeUrl,
  type AvailabilitySummary,
  type CatalogueItem,
  type CaptureResult,
  type ImportPlan,
  type CaseManifest,
  type PhotoPair,
  type MatchedLine,
  type PullListView,
  type SqlDriver,
  type TagLookup,
} from '@papa/core'
import { SqlJsDriver } from './sqljs-driver.ts'
import { demoCatalogue, seedDemo, type DemoSeed } from './seed.ts'
import { SessionRegistry, type SessionMode } from './sessions.ts'
import {
  createJob,
  decodeScanOps,
  dueBoard,
  itemsSummary,
  lastSessionRecord,
  openJob,
  openJobCommitments,
  openJobs,
  outItemNames,
  packedProgress,
  sessionScanFacts,
  setExpectedBack,
  type OpenJobRow,
} from './read-model.ts'
import type { GearRow } from '../routes/Gear.tsx'
import type { OutRow, TodayStats } from '../routes/Today.tsx'
import type { AssetHistoryRow, AssetView } from '../routes/Asset.tsx'
import { buildSummary, type SessionSummary } from '../session-summary.ts'

/**
 * The demo's one piece of state: a real local database with the demo house in
 * it, plus whichever scan sessions are open.
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

  /**
   * Sessions keyed by (job, direction) — see sessions.ts for why there are
   * several and what each entry snapshots. One live session here was the bug:
   * opening a return mid-prep destroyed the prep's dedupe set, and every
   * rescan on resuming wrote a duplicate op.
   */
  private readonly sessions: SessionRegistry
  readonly photos: PhotoStore

  private constructor(db: SqlDriver, seed: DemoSeed) {
    this.db = db
    this.seed = seed
    this.catalogue = demoCatalogue()
    this.sessions = new SessionRegistry(db, 'demo-device', (jobId, mode) =>
      this.expectedFor(jobId, mode),
    )
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

  /**
   * The open jobs, FROM THE DATABASE, sorted by departure. The seed keeps a
   * copy for the tests, but the board reads the tables — that is what lets a
   * job created at the desk appear here indistinguishable from a seeded one.
   */
  jobs(): OpenJobRow[] {
    return openJobs(this.db)
  }

  job(jobId: string): OpenJobRow | undefined {
    return openJob(this.db, jobId) ?? undefined
  }

  /**
   * The session for a job and direction, created on first use and then kept.
   *
   * Kept — with its dedupe set and expected snapshot — even while OTHER
   * sessions run: the registry resumes it when the tech comes back, so a
   * return opened mid-prep no longer resets the prep's progress. The
   * lifecycle lives in sessions.ts.
   */
  sessionFor(jobId: string, mode: SessionMode = 'out'): ScanSession {
    return this.sessions.open(jobId, mode).session
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
  expectedFor(jobId: string, mode: SessionMode): string[] {
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

  /** Complete the session the tech just finished — and only that one. Any
   *  other job's half-scanned session stays open behind it. */
  endSession(): void {
    this.sessions.endCurrent()
  }

  /**
   * Resolve a label WITHOUT recording anything — the "where is this thing?"
   * question. Answered entirely from the local mirror: no session, no outbox
   * op, no projection change. See lookupTag in @papa/core for the rules.
   */
  lookup(tagCode: string): TagLookup {
    return lookupTag(this.db, tagCode)
  }

  /**
   * The COMING BACK board: jobs with gear physically out, overdue pinned
   * first, each row carrying its locally computed due label — plus the two
   * affordances the desk actually uses on a late job: the WhatsApp nudge
   * (when a confident number exists) and the last handover summary (when a
   * session was ever recorded).
   */
  outJobsDue(nowMs: number = Date.now()): OutRow[] {
    return dueBoard(this.db, nowMs).outJobs.map((j) => {
      const phone = parsePhoneNumber(j.contact)
      const nudgeUrl =
        phone && j.due.state === 'overdue'
          ? whatsAppNudgeUrl(
              phone,
              overdueNudgeMessage({
                jobLabel: j.label,
                itemsSummary: itemsSummary(outItemNames(this.db, j.id)),
                dueLabel: j.due.label,
              }),
            )
          : null
      return {
        id: j.id,
        label: j.label,
        out: j.out,
        contact: j.contact,
        expectedBack: j.expectedBack,
        due: j.due,
        nudgeUrl,
        hasSummary: this.hasSummary(j.id),
      }
    })
  }

  pullList(jobId: string, mode: SessionMode = 'out'): PullListView | null {
    if (!this.job(jobId)) return null
    const entry = this.sessions.open(jobId, mode)
    return buildPullList(this.db, entry.expected, entry.session.scannedIds)
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
    const current = this.sessions.current()
    return this.photos.capture({
      assetId: input.assetId,
      jobId: current?.jobId ?? null,
      sessionId: current?.session.id ?? null,
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

  /**
   * Answer a pasted WhatsApp kit list against the demo catalogue — with the
   * open jobs' claims attached, so a short line says WHEN another unit comes
   * back instead of leaving the owner to reconstruct it from memory.
   */
  checkKitList(text: string): AvailabilitySummary {
    const matched = matchKitList(parseKitList(text), this.catalogue)
    return checkAvailability(this.db, matched, openJobCommitments(this.db))
  }

  /** Re-answer a list after the desk has resolved a line by hand. */
  recheck(lines: MatchedLine[]): AvailabilitySummary {
    return checkAvailability(this.db, lines, openJobCommitments(this.db))
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
    // Overdue and due-back come from the same dueBoard read the COMING BACK
    // list renders from, so the counter and the list it deep-links to can
    // never disagree. Jobs whose expected_back is free text land in neither
    // number — 'no date' is not late, it is unknown, and it stays that way.
    const due = dueBoard(this.db, Date.now())
    return {
      outNow: Number(row?.out_now ?? 0),
      onShelf: Number(row?.on_shelf ?? 0),
      dueBack: due.dueBack,
      overdue: due.overdue,
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

    const history: AssetHistoryRow[] = decodeScanOps(this.db)
      .filter((op) => op.assetId === assetId)
      .reverse() // newest first — it reads as a story, latest chapter on top
      .map((op) => ({
        id: op.outboxId,
        event: op.eventType,
        at: new Date(op.createdAt).toLocaleString(),
        entryMethod: op.entryMethod,
        jobLabel: op.jobId ? (this.job(op.jobId)?.label ?? null) : null,
        actor: this.seed.userName,
      }))

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
    if (!job) return null

    // The job's most recently opened LIVE session — the one the tech just
    // held "finish" on — when there is one. When there is not (the session
    // was completed, or the app reloaded), the same facts come from the
    // scan_sessions row written when it opened: summaries used to die with
    // the in-memory session, which meant "done" on the handover card
    // destroyed the only record of the morning the desk could read.
    const entry = this.sessions.peek(jobId)
    const rec = entry
      ? { id: entry.session.id, mode: entry.mode, expected: entry.expected }
      : lastSessionRecord(this.db, jobId)
    if (!rec) return null

    // Read back from the QUEUE, not from the screen: the queue is what was
    // actually written, and on a real phone it is the only record that exists
    // until a sync happens.
    const facts = sessionScanFacts(decodeScanOps(this.db), rec.id)

    return buildSummary({
      jobLabel: job.label,
      mode: rec.mode,
      expected: rec.expected,
      ...facts,
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

  /**
   * How many of a job's expected items are already recorded, for the Today
   * list. Reads the job's own OUT session — the "going out" board's number —
   * so several half-packed jobs each show their progress at once, instead of
   * only whichever one was touched last.
   */
  scannedCount(jobId: string): number {
    // The live session when one exists — it also counts off-list additions.
    // Otherwise the mirror itself: promised items whose projection already
    // says they left on this job. Without the fallback, a reload zeroed
    // every ring on the board while the vans stayed loaded.
    return (
      this.sessions.peek(jobId, 'out')?.session.scannedIds.length ??
      packedProgress(this.db, jobId)
    )
  }

  /**
   * A job born at the desk — from an answered kit list, or from nothing
   * (the walk-in). Resolved lines become the promised set via the same
   * job_expected table the seed writes, so the new job is on the board,
   * scannable and counted by availability the moment this returns. Lines
   * the matcher never resolved are LEFT OUT, not guessed in.
   */
  createJobFromLines(
    lines: MatchedLine[],
    input: { label: string; contact: string | null; expectedBack: string | null },
  ): { jobId: string; allocated: number; requested: number } {
    const wants = lines
      .filter((l): l is MatchedLine & { productId: string } => !!l.productId)
      .map((l) => ({ productId: l.productId, qty: l.quantity }))

    const jobId = `job-${crypto.randomUUID()}`
    const result = createJob(this.db, {
      id: jobId,
      orgId: this.seed.orgId,
      label: input.label,
      contact: input.contact,
      expectedBack: input.expectedBack,
      wants,
    })
    return { jobId, allocated: result.expected.length, requested: result.requested }
  }

  /** Set or clear a job's due date. ISO in, honest 'no date' when cleared. */
  setDueDate(jobId: string, value: string | null): void {
    setExpectedBack(this.db, jobId, value)
  }

  /** A session was recorded on this job at some point, so its handover is
   *  reviewable — live or finished. */
  hasSummary(jobId: string): boolean {
    return lastSessionRecord(this.db, jobId) !== null
  }
}

/** A safe, stable id fragment from a product name. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}
