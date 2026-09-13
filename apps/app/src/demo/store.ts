import {
  PhotoStore,
  ScanSession,
  VoiceNoteStore,
  lookupTag,
  voidScan,
  markTerminal,
  markFound,
  swapAsset,
  cycleCountDiff,
  recordServiced,
  type VoiceCaptureResult,
  type VoiceNoteRow,
  type VoidScanResult,
  type Disposition,
  type SwapFlag,
  type SwapResult,
  type CountDiff,
  caseManifest,
  hasContents,
  pairBySide,
  balanceCardText,
  buildPullList,
  checkAvailability,
  indicativeDayTotal,
  monthlyStatementText,
  matchKitList,
  moneyLabel,
  formatRupees,
  parseKitList,
  overdueNudgeMessage,
  parsePhoneNumber,
  replySummary,
  whatsAppNudgeUrl,
  type AvailabilitySummary,
  type AvailabilityWindow,
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
import {
  Outbox,
  PostgrestTransport,
  SyncLoop,
  enrol,
  ensureDeviceId,
  forgetSession,
  metaGet,
  migrateLocal,
  needsPinGate,
  pinSwitch,
  sessionOf,
  signOut,
  type EnrolInput,
  type EnrolResult,
  type OutboxRow,
  type PinSwitchResult,
  type Session,
  type SignOutResult,
  type SyncStatusView,
} from '@papa/core'
import { SqlJsDriver } from './sqljs-driver.ts'
import { demoCatalogue, seedDemo, type DemoSeed } from './seed.ts'
import { DEMO_SCHEMA } from './read-model.ts'
import { NETWORK_SCHEMA } from './network.ts'
import { notifySync } from '../sync-tick.ts'
import { SessionRegistry, type SessionMode } from './sessions.ts'
import {
  applyImport,
  assetFacts,
  closedJobs,
  closeJob,
  collapseHistory,
  createJob,
  dayRateFor,
  decodeScanOps,
  dueBoard,
  itemsSummary,
  lastSessionRecord,
  openJob,
  openJobCommitments,
  openJobs,
  outItemNames,
  packedProgress,
  reopenJob,
  sessionScanFacts,
  setExpectedBack,
  shelfContents,
  shelves,
  stillOutCount,
  substitutesFor,
  expectedOnShelf,
  flagForManager,
  managerFlaggedAt,
  sehat,
  serviceFacts,
  type Sehat,
  type ServiceFacts,
  type CloseJobResult,
  type ClosedJobRow,
  type OpenJobRow,
  type SubstituteRow,
} from './read-model.ts'
import { dayAccount, type DayAccount } from './hisaab.ts'
import {
  jobMargin,
  monthProfit,
  recordExpense,
  reverseExpense,
  type JobMargin,
  type MonthProfit,
} from './kharcha.ts'
import type { ExpenseKind } from '@papa/core'
import {
  assetEarnings,
  chargedButReturned,
  createCustomer,
  customerForJob,
  customersByBalance,
  customerView,
  khataLabels,
  lateFeeDraftFor,
  moneyStrip,
  recordReversalOf,
  paymentLine,
  paymentQr,
  recordEntry,
  recordTurnedAway,
  setPaymentLine,
  setPaymentQr,
  turnedAwayThisMonth,
  turnedAwayByReason,
  type AssetEarnings,
  type ChargedButReturned,
  type CustomerListRow,
  type CustomerView,
  type LateFeeDraftView,
  type MoneyStrip,
} from './khata.ts'
import {
  availabilityFor,
  bookingConfirmText,
  bookingSettings,
  bookingView,
  calendar,
  cancelBooking,
  confirmBooking,
  convertBookingToJob,
  createBooking,
  extendBooking,
  extensionPreview,
  listBookings,
  noteSubRent,
  planConfirm,
  promisedStrip,
  pruneExpiredPencils,
  reallocateReservation,
  substitutesForReservation,
  type BookingFilter,
  type BookingRow,
  type BookingView,
  type CalendarDay,
  type CancelBookingResult,
  type ConfirmBookingResult,
  type ConfirmOptions,
  type ConvertBookingResult,
  type CreateBookingInput,
  type CreateBookingResult,
  type ConfirmPlan,
  type ExtendBookingResult,
  type ExtendOptions,
  type PromisedStrip,
  type ReallocateResult,
  type ReservationSubstitute,
  type SubRentIntent,
} from './bookings.ts'
import {
  escalationStep,
  promisedSoon,
  type BookingAvailability,
  type CalendarKind,
  type ExtensionCollision,
  type BookingSettings,
  type PromisedSoon,
  type RateCardKnobs,
} from '@papa/core'
import {
  calendarDays,
  clearCalendarDay,
  quoteFor,
  quoteForLines,
  quoteTextOf,
  rateCard,
  setCalendarDay,
  setLineOverride,
  setRate,
  setRateCard,
  type CalendarDayRow,
  type EnquiryLine,
  type QuoteView,
  type RateCardView,
  type SetCalendarDayResult,
  type SetLineOverrideResult,
  type SetRateCardResult,
  type SetRateResult,
} from './quotes.ts'
import { STR } from '../strings.ts'
import { getLang } from '../lang.ts'
import { buildParchi } from '../parchi.ts'
// --- network --- (0025)
import { buildParchiEscPos, parchiDocFromText, type ShortageLine } from '@papa/core'
import {
  askTheMarket,
  assignAttendant,
  attendantNames,
  closeSubHire,
  crewFor,
  partner,
  partnerMoney,
  partners,
  publicPhone,
  publicTagUrlBase,
  recordSubHireIn,
  recordSubHireOut,
  removePartner,
  setPublicPhone,
  setPublicTagUrlBase,
  staff,
  stolenBroadcast,
  stolenBroadcastFacts,
  subHireForAsset,
  subHireForJob,
  subHires,
  unassignAttendant,
  upsertPartner,
  type CloseSubHireResult,
  type CrewMember,
  type CrewResult,
  type PartnerMoney,
  type PartnerRow,
  type RecordSubHireInInput,
  type RecordSubHireInResult,
  type RecordSubHireOutInput,
  type RecordSubHireOutResult,
  type RemovePartnerResult,
  type StaffRow,
  type SubHireFilter,
  type SubHireRow,
  type UpsertPartnerInput,
  type UpsertPartnerResult,
} from './network.ts'
import { buildProveIt } from '../prove-it.ts'
import { buildTheftReport, theftLabels } from '../theft-report.ts'
import { buildGintiReport, gintiLabels } from '../ginti-report.ts'
import { statusSentence } from '../status.ts'
import type { GearRow } from '../routes/Gear.tsx'
import type { OutRow, TodayStats } from '../routes/Today.tsx'
import type { AssetHistoryRow, AssetView } from '../routes/Asset.tsx'
import { buildSummary, type SessionSummary } from '../session-summary.ts'

/** How a new job names its khata: an existing customer, a fresh name typed
 *  at the sheet, or none at all (the nephew case — legal, unchargeable). */
export type JobCustomerChoice =
  | { kind: 'existing'; id: string }
  | { kind: 'new'; name: string; phone: string | null }
  | null

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
/**
 * Which server the store talks to (W9).
 *
 *   demo — the pretend house, seeded on open, no server: the outbox fills
 *          and never drains, and every chip says so.
 *   live — an enrolled phone: seed skipped, the mirrors filled by the
 *          SyncLoop from the real server, every queued op replayed there.
 *
 * ONE class, not two. The screens, the read models and the write sides are
 * identical in both modes; only who fills the mirrors and who drains the
 * outbox differs, and that is one field and one loop.
 */
export type StoreMode = 'demo' | 'live'

/**
 * The app's own tables a re-key must rewrite when the server renames a
 * thing (core's REKEY_COLUMNS covers the mirrors; these are the demo-side
 * tables read-model.ts and network.ts own).
 */
const APP_REKEY_COLUMNS: Record<string, string[]> = {
  job_expected: ['job_id', 'asset_id'],
  job_meta: ['job_id'],
  scan_sessions: ['job_id'],
  customers: ['id'],
  customer_ledger_entries: ['customer_id', 'job_id', 'asset_id'],
  org_expenses: ['asset_id', 'job_id', 'booking_id'],
  demand_log: ['product_id'],
  partner_customer_links: ['partner_house_id', 'customer_id'],
  product_rates: ['product_id'],
}

/** One "needs attention" card: a parked op and everything parked behind it. */
export interface AttentionCard {
  rootId: string
  op: string
  code: string
  message: string
  seq: number
  createdAt: number
  /** Ops parked only because they depended on this one. */
  blocked: number
}

export interface MemberRow {
  id: string
  name: string
  role: string
  hasPin: boolean
  current: boolean
}

export class DemoStore {
  readonly db: SqlDriver
  seed: DemoSeed
  catalogue: CatalogueItem[]
  mode: StoreMode
  /** The background loop, attached in live mode. Never awaited by a screen. */
  loop: SyncLoop | null = null
  private transport: PostgrestTransport | null = null

  /**
   * Sessions keyed by (job, direction) — see sessions.ts for why there are
   * several and what each entry snapshots. One live session here was the bug:
   * opening a return mid-prep destroyed the prep's dedupe set, and every
   * rescan on resuming wrote a duplicate op.
   */
  private sessions: SessionRegistry
  readonly photos: PhotoStore
  readonly voice: VoiceNoteStore

  private constructor(db: SqlDriver, seed: DemoSeed, mode: StoreMode, deviceId: string) {
    this.db = db
    this.seed = seed
    this.mode = mode
    this.catalogue = demoCatalogue()
    this.sessions = new SessionRegistry(db, deviceId, (jobId, mode) =>
      this.expectedFor(jobId, mode),
    )
    // A deliberately small budget in the demo — a few megabytes rather than
    // 512 — so the "device full" refusal is reachable by a person trying the
    // app for ten minutes, instead of being a branch nobody ever sees.
    this.photos = new PhotoStore(db, { budgetBytes: 6 * 1024 * 1024 })
    // Same reasoning for the voice budget: ~2MB is twenty-odd notes, so the
    // honest refusal is a reachable demo state, not a theoretical branch.
    this.voice = new VoiceNoteStore(db, { budgetBytes: 2 * 1024 * 1024 })
  }

  /**
   * Open the phone's database and decide the mode: a session token present
   * means an enrolled phone (live); otherwise the demo house is seeded. The
   * browser build's database is in memory, so it always opens demo — the
   * Enrol screen switches the SAME store to live for the life of the page
   * (goLive), and the Android build's persisted database boots straight
   * into the live branch.
   */
  static async open(): Promise<DemoStore> {
    const db = await SqlJsDriver.open()
    migrateLocal(db)
    const session = sessionOf(db)
    if (session) {
      db.exec(DEMO_SCHEMA)
      db.exec(NETWORK_SCHEMA)
      const store = new DemoStore(db, liveSeed(session), 'live', session.deviceId)
      store.refreshCatalogue()
      store.attachLoop(session)
      return store
    }
    const seed = seedDemo(db)
    return new DemoStore(db, seed, 'demo', 'demo-device')
  }

  // ---- the pipe (W9) ------------------------------------------------------

  /** The live session, or null in demo mode. */
  session(): Session | null {
    return sessionOf(this.db)
  }

  /** Enrol this phone and switch the store to live. */
  async enrol(input: Omit<EnrolInput, 'deviceId'> & { serverUrl: string }): Promise<EnrolResult> {
    const deviceId = ensureDeviceId(this.db)
    const transport = this.transportFor(input.serverUrl)
    const r = await enrol(this.db, transport, { ...input, deviceId })
    if (!r.ok) return r
    this.goLive(r.session)
    return r
  }

  /**
   * Become the enrolled phone. From demo mode the pretend house is cleared
   * first — mirrors, the demo's own tables, AND the demo outbox: those scans
   * were of pretend gear, and replaying them at a real server would only
   * park as cards. ASSUMPTION: see docs/assumptions.md#enrol-clears-demo
   */
  private goLive(session: Session): void {
    if (this.mode === 'demo') {
      this.db.transaction(() => {
        for (const t of [
          'assets', 'asset_tags', 'asset_containment', 'locations', 'jobs', 'products',
          'bookings', 'booking_lines', 'asset_reservations', 'stock_reservations', 'stock_lots',
          'rate_cards', 'rate_card_entries', 'org_calendar_days', 'partner_houses', 'sub_hires',
          'job_attendants', 'members', 'outbox', 'id_map', 'pending_uploads', 'condition_photos',
          'voice_notes', 'job_expected', 'job_meta', 'scan_sessions', 'product_rates', 'customers',
          'customer_ledger_entries', 'org_expenses', 'demand_log', 'staff', 'partner_customer_links',
        ]) {
          this.db.exec(`delete from ${t}`)
        }
        this.db.exec(`delete from sync_meta where key in ('pull_cursor', 'clock_offset_ms')`)
      })
    }
    this.mode = 'live'
    this.seed = liveSeed(session)
    this.catalogue = []
    this.sessions = new SessionRegistry(this.db, session.deviceId, (jobId, mode) =>
      this.expectedFor(jobId, mode),
    )
    this.attachLoop(session)
  }

  private transportFor(serverUrl: string): PostgrestTransport {
    return new PostgrestTransport({
      baseUrl: serverUrl,
      sessionToken: () => metaGet(this.db, 'session_token') ?? null,
    })
  }

  private attachLoop(session: Session): void {
    this.loop?.stop()
    this.transport = this.transportFor(session.serverUrl ?? '')
    this.loop = new SyncLoop({
      db: this.db,
      transport: this.transport,
      deviceId: session.deviceId,
      rekeyColumns: APP_REKEY_COLUMNS,
      onChange: () => this.afterSync(),
    })
    this.loop.start()
  }

  /**
   * After any cycle that changed rows: the kit-list reader's catalogue is
   * rebuilt from the mirror, and the crew roster (network.ts's `staff`
   * table, ASSUMPTION #staff-roster) is the members mirror — copied, so
   * network.ts keeps its one join and the demo keeps its seed. Then the
   * screens are told.
   */
  private afterSync(): void {
    this.refreshCatalogue()
    this.db.transaction(() => {
      this.db.exec(`delete from staff where id not in (select id from members)`)
      this.db.exec(
        `insert into staff (id, org_id, display_name, role)
         select id, org_id, display_name, role from members where true
         on conflict (id) do update set display_name = excluded.display_name, role = excluded.role`,
      )
    })
    notifySync()
  }

  /** Ask the loop to run now. Fire-and-forget from the UI. */
  kickSync(): void {
    void this.loop?.kick()
  }

  /** What Settings → This phone and the chips read. Null in demo mode. */
  syncView(): SyncStatusView | null {
    return this.loop?.status() ?? null
  }

  deviceId(): string {
    return metaGet(this.db, 'device_id') ?? 'demo-device'
  }

  deviceLabel(): string {
    return metaGet(this.db, 'device_label') ?? ''
  }

  /** Who may pick this phone up, the current holder marked. */
  members(): MemberRow[] {
    const current = this.session()?.userId ?? null
    return this.db
      .all<{ id: string; display_name: string; role: string; has_pin: number }>(
        `select id, display_name, role, has_pin from members order by display_name`,
      )
      .map((r) => ({
        id: r.id, name: r.display_name, role: r.role,
        hasPin: Number(r.has_pin) === 1, current: r.id === current,
      }))
  }

  needsPinGate(): boolean {
    return needsPinGate(this.db)
  }

  async pinSwitch(userId: string, pin: string): Promise<PinSwitchResult> {
    if (!this.transport) return { ok: false, reason: 'refused', message: 'demo mode' }
    const r = await pinSwitch(this.db, this.transport, userId, pin, {
      online: this.loop?.status().online ?? true,
    })
    if (r.ok) this.seed = liveSeed(this.session()!)
    return r
  }

  /** Sign out: refused while anything is queued; needs the server; then the
   *  phone forgets the house and reopens as the demo. */
  async signOut(): Promise<SignOutResult> {
    if (!this.transport) return { ok: false, reason: 'refused', message: 'demo mode' }
    const r = await signOut(this.db, this.transport)
    if (!r.ok) return r
    this.loop?.stop()
    this.loop = null
    this.transport = null
    this.mode = 'demo'
    forgetSession(this.db)
    this.db.exec(`delete from staff`)
    this.seed = seedDemo(this.db)
    this.catalogue = demoCatalogue()
    this.sessions = new SessionRegistry(this.db, 'demo-device', (jobId, mode) =>
      this.expectedFor(jobId, mode),
    )
    return r
  }

  /**
   * The "needs attention" cards: every parked op the server itself refused,
   * with the count of ops parked behind it. ONE card per refusal, never
   * one per blocked child (outbox.ts, the DAG rule).
   */
  attentionCards(): AttentionCard[] {
    const failed = new Outbox(this.db).failures()
    const byId = new Map(failed.map((r) => [r.id, r]))
    const rootOf = (row: OutboxRow): string => {
      let cur = row
      const seen = new Set<string>()
      while (cur.error_code === 'blocked_by_dependency' && cur.depends_on && !seen.has(cur.id)) {
        seen.add(cur.id)
        const parent = byId.get(cur.depends_on)
        if (!parent) break
        cur = parent
      }
      return cur.id
    }
    const cards = new Map<string, AttentionCard>()
    for (const row of failed) {
      if (row.error_code === 'blocked_by_dependency') continue
      cards.set(row.id, {
        rootId: row.id, op: row.op, code: row.error_code ?? '', message: row.error_detail ?? '',
        seq: row.seq, createdAt: row.created_at, blocked: 0,
      })
    }
    for (const row of failed) {
      if (row.error_code !== 'blocked_by_dependency') continue
      const card = cards.get(rootOf(row))
      if (card) card.blocked++
    }
    return [...cards.values()].sort((a, b) => a.seq - b.seq)
  }

  /**
   * Drop a parked card and everything behind it. The server never took
   * these rows, so nothing on it changes — but the phone's optimistic
   * mirror may still show what they promised; the next pull is the truth.
   */
  dismissCard(rootId: string): number {
    const failed = new Outbox(this.db).failures()
    const children = new Map<string, string[]>()
    for (const r of failed) {
      if (r.depends_on) children.set(r.depends_on, [...(children.get(r.depends_on) ?? []), r.id])
    }
    const doomed: string[] = []
    const queue = [rootId]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (doomed.includes(id)) continue
      doomed.push(id)
      queue.push(...(children.get(id) ?? []))
    }
    this.db.transaction(() => {
      for (const id of doomed) this.db.exec(`delete from outbox where id = ? and state = 'failed'`, [id])
    })
    return doomed.length
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
   * Undo a mis-scan. Append-only stays intact: the wrong op keeps its
   * queue row and a `void_scan` referencing it queues behind it; the
   * projection re-derives and every history reader skips the voided op.
   * See voidScan in @papa/core.
   */
  voidScan(outboxId: string): VoidScanResult {
    return voidScan(this.db, outboxId)
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
      // The overdue ladder (ASSUMPTION #escalation-ladder): the rung this
      // job sits on, and ONE action for it. The manager rung remembers
      // that it was pulled, so the card can say so instead of asking twice.
      const escalation = j.due.state === 'overdue' ? escalationStep(j.due.daysLate ?? 0) : null
      return {
        id: j.id,
        label: j.label,
        out: j.out,
        contact: j.contact,
        phone,
        expectedBack: j.expectedBack,
        due: j.due,
        nudgeUrl,
        nudgeText: overdueNudgeMessage({
          jobLabel: j.label,
          itemsSummary: itemsSummary(outItemNames(this.db, j.id)),
          dueLabel: j.due.label,
        }),
        escalation,
        managerFlaggedAt: managerFlaggedAt(this.db, j.id),
        hasSummary: this.hasSummary(j.id),
        customer: j.customer,
      }
    })
  }

  /** The ladder's last rung: hand this job to the manager, once. Returns
   *  the WhatsApp text the owner forwards — the escalation is a message,
   *  not a silent flag. */
  escalateToManager(jobId: string, nowMs: number = Date.now()): string | null {
    const row = this.outJobsDue(nowMs).find((j) => j.id === jobId)
    if (!row || !flagForManager(this.db, jobId, nowMs)) return null
    return STR.bookingManagerEscalationText(
      row.label,
      row.due.daysLate ?? 0,
      itemsSummary(outItemNames(this.db, jobId)),
      row.customer?.name ?? null,
    )
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
   * Apply a reviewed import plan — the real routine lives in read-model.ts
   * (applyImport) so it runs under Node; this binds the org, the clock and
   * the catalogue refresh the matcher needs.
   */
  applyImport(plan: ImportPlan): { products: number; units: number; renumbered: number } {
    const result = applyImport(this.db, this.seed.orgId, plan)
    this.refreshCatalogue()
    return result
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
  checkKitList(
    text: string,
    window: AvailabilityWindow | null = null,
    nowMs: number = Date.now(),
  ): AvailabilitySummary {
    const matched = matchKitList(parseKitList(text), this.catalogue)
    return checkAvailability(this.db, matched, openJobCommitments(this.db), nowMs, window)
  }

  /** Re-answer a list after the desk has resolved a line by hand. With a
   *  window, confirmed bookings over it are subtracted before the verdict
   *  (the commitment layer, 0022 D6). */
  recheck(
    lines: MatchedLine[],
    window: AvailabilityWindow | null = null,
    nowMs: number = Date.now(),
  ): AvailabilitySummary {
    return checkAvailability(this.db, lines, openJobCommitments(this.db), nowMs, window)
  }

  /**
   * The WhatsApp reply for an answered list, with one money line under it:
   * the sum of the resolved lines' day rates, SAID TO BE INDICATIVE — a
   * day-rate sum is not a quote; duration, discounts and the owner's
   * judgement are not in the data, and the owner types the real number.
   * Unresolved and rateless lines ride in the label's own '+N unpriced';
   * when nothing is priced the line is omitted entirely.
   */
  replyText(summary: AvailabilitySummary, window: AvailabilityWindow | null = null): string {
    const reply = replySummary(summary)
    // With dates, the reply carries THE quote — the same pipeline the
    // booking page runs, indicative until it is a confirmed booking.
    if (window) {
      const q = this.quoteForLines(enquiryLines(summary), window.startMs, window.endMs, null)
      if (q.lines.length === 0) return reply
      const line = STR.quoteReplyLine(formatRupees(q.totals.subtotalMinor), q.steps.weekRule.billableDays)
      const honesty = q.totals.unpricedCount > 0
        ? ` ${STR.quoteReplyIndicative(q.totals.unpricedCount)}` : ''
      return `${reply}\n\n${line}${honesty}`
    }
    const label = moneyLabel(
      indicativeDayTotal(summary.lines, (id) => dayRateFor(this.db, id)),
    )
    return label === null
      ? reply
      : `${reply}\n\nIndicative: ${label} per day — final quote from the desk.`
  }

  // ------------------------------------------------------------ quotes
  // The rate card, the calendar and the quote (0024 on the phone); the
  // rules live in @papa/core pricing.ts and the reads/writes in quotes.ts.

  /** THE booking's quote — price_booking's trace, from the mirror. */
  quoteFor(bookingId: string): QuoteView | null {
    return quoteFor(this.db, bookingId)
  }

  /** An indicative quote for a kit list BEFORE a booking exists. */
  quoteForLines(
    lines: EnquiryLine[],
    startMs: number,
    endMs: number,
    customerId: string | null,
  ): QuoteView {
    return quoteForLines(this.db, lines, startMs, endMs, customerId)
  }

  /** The WhatsApp quote for any quote view — an enquiry's included. */
  quoteTextOf(quote: QuoteView): string {
    return quoteTextOf(this.db, STR, this.seed.houseName, quote)
  }

  /** The owner's last word on one line (0024 D8); a null rate clears it. */
  setLineOverride(
    lineId: string,
    rateMinor: number | null,
    reason: string,
    nowMs: number = Date.now(),
  ): SetLineOverrideResult {
    return setLineOverride(this.db, lineId, rateMinor, reason, nowMs)
  }

  rateCard(): RateCardView | null {
    return rateCard(this.db)
  }

  /** Set (or with null remove) one product's day rate on the default card. */
  setRate(productId: string, dayRateMinor: number | null, nowMs: number = Date.now()): SetRateResult {
    return setRate(this.db, this.seed.orgId, productId, dayRateMinor, nowMs)
  }

  setRateCard(patch: Partial<RateCardKnobs> & { name?: string }, nowMs: number = Date.now()): SetRateCardResult {
    return setRateCard(this.db, this.seed.orgId, patch, nowMs)
  }

  calendarDays(): CalendarDayRow[] {
    return calendarDays(this.db)
  }

  setCalendarDay(
    day: string,
    kind: CalendarKind,
    name: string,
    rateMultiplier: number,
    nowMs: number = Date.now(),
  ): SetCalendarDayResult {
    return setCalendarDay(this.db, this.seed.orgId, day, kind, name, rateMultiplier, nowMs)
  }

  clearCalendarDay(day: string, kind: CalendarKind, nowMs: number = Date.now()): boolean {
    return clearCalendarDay(this.db, day, kind, nowMs)
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
        disposition: string | null
        location_name: string | null
        job_label: string | null
      }>(
        `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name,
                p.category, a.presence, a.health, a.disposition,
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
        disposition: (r.disposition as GearRow['disposition']) ?? null,
        locationName: r.location_name,
        jobLabel: r.job_label,
      }))
  }

  /** The counters on the Today board. `nowMs` injectable so the one store
   *  read that answers "today" can be asked about another day. */
  stats(nowMs: number = Date.now()): TodayStats {
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
    const due = dueBoard(this.db, nowMs)
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
      disposition: string | null
      serial_number: string | null
      product_id: string | null
      location_name: string | null
      job_label: string | null
      tag_code: string | null
    }>(
      `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name,
              p.category, a.presence, a.health, a.disposition, a.serial_number, a.product_id,
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

    // collapseHistory folds a restart's rescan echo into one row with a
    // ×N marker — the queue keeps every op; only the story is tidied.
    const history: AssetHistoryRow[] = collapseHistory(
      decodeScanOps(this.db)
        .filter((op) => op.assetId === assetId)
        .reverse() // newest first — it reads as a story, latest chapter on top
        .map((op) => ({
          id: op.outboxId,
          event: op.eventType,
          at: new Date(op.createdAt).toLocaleString(),
          entryMethod: op.entryMethod,
          jobLabel: op.jobId ? (this.job(op.jobId)?.label ?? null) : null,
          actor: this.seed.userName,
        })),
    )

    return {
      id: row.id,
      code: row.asset_code ?? '—',
      name: row.display_name ?? 'Unnamed',
      category: row.category ?? 'other',
      presence: (row.presence as AssetView['presence']) ?? 'here',
      health: (row.health as AssetView['health']) ?? 'ok',
      disposition: (row.disposition as AssetView['disposition']) ?? null,
      locationName: row.location_name,
      jobLabel: row.job_label,
      serial: row.serial_number,
      productId: row.product_id,
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
    const found = this.lastSessionFacts(jobId)
    return found ? this.summaryOf(found) : null
  }

  /** buildSummary over one job's last session — the shape both the handover
   *  card and the parchi are built from, so they can never disagree. */
  private summaryOf(found: NonNullable<ReturnType<DemoStore['lastSessionFacts']>>): SessionSummary {
    const { job, rec, facts } = found
    return buildSummary({
      jobLabel: job.label,
      mode: rec.mode,
      expected: rec.expected,
      ...facts,
      facts: (id) => assetFacts(this.db, id),
    })
  }

  /**
   * The challan text the handover screen renders as a QR code — the parchi.
   * Built from the same session record and queue read as the summary, so the
   * gate pass and the screen above it can never tell different stories.
   */
  parchiText(jobId: string, nowMs: number = Date.now()): string | null {
    const found = this.lastSessionFacts(jobId)
    if (!found) return null
    const { job, rec, facts } = found
    const summary = this.summaryOf(found)

    return buildParchi({
      houseName: this.seed.houseName,
      jobLabel: job.label,
      mode: rec.mode,
      whenMs: nowMs,
      items: facts.recorded.map((id) => {
        const f = assetFacts(this.db, id)
        return { code: f?.code ?? null, name: f?.name ?? null }
      }),
      assumedCount: facts.assumed.length,
      shortfall: summary.missing.map((m) => ({ code: m.code, name: m.name })),
      // The same money the handover header shows, so the challan and the
      // screen above it cannot name two different figures for one shortfall.
      shortfallValueLabel: moneyLabel(summary.missingValue),
      // --- network --- the crew line: who went with the kit (0025 D7).
      attendants: attendantNames(this.db, jobId),
    })
  }

  /** Din ka hisaab — the whole day, computed locally. See hisaab.ts. */
  dayAccount(nowMs: number = Date.now()): DayAccount {
    return dayAccount(this.db, nowMs)
  }

  /**
   * The tech's alibi card for one item — see prove-it.ts. Everything on it
   * comes from stored facts (the mirror, the queue, the photo table); no
   * clock is read, because the card asserts the past, not the present.
   */
  proveItText(assetId: string): string | null {
    const asset = this.assetView(assetId)
    if (!asset) return null

    // Newest scan of this asset in the queue — the queue is what was
    // actually written, and on a real phone it is the only record there is
    // until a sync happens. Same source as the asset page's history.
    const last = decodeScanOps(this.db)
      .filter((op) => op.assetId === assetId)
      .at(-1)

    const photos = this.db.get<{ n: number }>(
      `select count(*) as n from condition_photos where asset_id = ?`,
      [assetId],
    )

    return buildProveIt({
      houseName: this.seed.houseName,
      code: asset.code,
      name: asset.name,
      statusLine: statusSentence(
        { presence: asset.presence, health: asset.health },
        { jobLabel: asset.jobLabel, locationName: asset.locationName },
      ),
      lastScan: last
        ? {
            eventType: last.eventType,
            whenMs: last.createdAt,
            jobLabel: last.jobId ? (this.job(last.jobId)?.label ?? null) : null,
            entryMethod: last.entryMethod,
          }
        : null,
      photoCount: Number(photos?.n ?? 0),
    })
  }

  /**
   * The most recent session on a job — live entry first, durable record
   * second — with its scans read back from the QUEUE, not from the screen:
   * the queue is what was actually written, and on a real phone it is the
   * only record that exists until a sync happens. Shared by the summary and
   * the parchi.
   */
  private lastSessionFacts(jobId: string): {
    job: OpenJobRow
    rec: { id: string; mode: 'out' | 'in'; expected: string[] }
    facts: ReturnType<typeof sessionScanFacts>
  } | null {
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

    return { job, rec, facts: sessionScanFacts(decodeScanOps(this.db), rec.id) }
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
   *
   * The customer rides in at birth — existing, typed fresh at the sheet,
   * or honestly absent (the nephew case; the job then cannot take a
   * charge, and the charge buttons never render for it). This is the door
   * the year simulation ran a whole pilot without: a desk job that cannot
   * meet a customer makes the money book unreachable from its own front
   * door (`no-customer-on-desk-job`).
   */
  createJobFromLines(
    lines: MatchedLine[],
    input: {
      label: string
      contact: string | null
      expectedBack: string | null
      customer?: JobCustomerChoice
    },
  ): { jobId: string; allocated: number; requested: number } {
    const wants = lines
      .filter((l): l is MatchedLine & { productId: string } => !!l.productId)
      .map((l) => ({ productId: l.productId, qty: l.quantity }))

    const choice = input.customer ?? null
    const customerId =
      choice === null
        ? null
        : choice.kind === 'existing'
          ? choice.id
          : this.createCustomer(choice.name, choice.phone)

    const jobId = `job-${crypto.randomUUID()}`
    const result = createJob(this.db, {
      id: jobId,
      orgId: this.seed.orgId,
      label: input.label,
      contact: input.contact,
      expectedBack: input.expectedBack,
      customerId,
      wants,
    })
    return { jobId, allocated: result.expected.length, requested: result.requested }
  }

  /** A new khata, by name. Null for a blank name — see createCustomer. */
  createCustomer(name: string, phone: string | null): string | null {
    return createCustomer(this.db, { orgId: this.seed.orgId, name, phone })
  }

  /** The close rule's number for one job — the honest disabled reason. */
  stillOut(jobId: string): number {
    return stillOutCount(this.db, jobId)
  }

  /**
   * End a job. Mirrors the server's close_job rule exactly (0018 D3):
   * refused while anything still projects onto the job. The refusal is a
   * RESULT, not an exception — the button renders it as its disabled
   * reason, never as a crash.
   */
  closeJob(jobId: string, nowMs: number = Date.now()): CloseJobResult {
    return closeJob(this.db, jobId, nowMs)
  }

  /** The undo — the job returns to every board and availability answer. */
  reopenJob(jobId: string): boolean {
    return reopenJob(this.db, jobId)
  }

  /** Every closed job, newest first — the "Closed jobs" door. */
  closedJobs(): ClosedJobRow[] {
    return closedJobs(this.db)
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

  // ---- the money book (Phase B) -----------------------------------------
  // Thin doors onto khata.ts: every rule lives there (and in @papa/core's
  // ledger.ts) where plain Node can assert it; the store only binds the
  // database, the clock and the active string table.

  /** Every customer with their projected balance, biggest debt first. */
  customers(): CustomerListRow[] {
    return customersByBalance(this.db)
  }

  /** One customer's whole khata page, or null. */
  customer(id: string): CustomerView | null {
    return customerView(this.db, id)
  }

  /** The Today board's money strip, from the local book only. */
  moneyStrip(nowMs: number = Date.now()): MoneyStrip {
    return moneyStrip(this.db, nowMs)
  }

  /**
   * Money received — a PAST FACT, written as a negative line. The method the
   * cash arrived by rides in the note, beside whatever the desk added.
   *
   * `whenMs` lets the fact be BACKDATED — "the client paid me yesterday,
   * I'm entering it this morning" is an everyday truth the ledger must be
   * able to state, or the statement books it in the wrong day (and at a
   * month edge, the wrong month). The default is still now.
   */
  recordPayment(
    customerId: string,
    amountMinor: number,
    method: string,
    note: string | null,
    whenMs: number = Date.now(),
  ): void {
    recordEntry(this.db, {
      orgId: this.seed.orgId,
      customerId,
      kind: 'payment',
      amountMinor: -Math.abs(amountMinor),
      note: note && note.trim().length > 0 ? `${method} — ${note.trim()}` : method,
      createdAt: whenMs,
    })
  }

  /** The customer a job belongs to — how the dock finds the khata. Null when
   *  the job has no customer wired, and the charge buttons then never render. */
  customerForJob(jobId: string): { id: string; name: string } | null {
    return customerForJob(this.db, jobId)
  }

  /**
   * The dock's "charge client": a damage/extras charge agreed at the counter,
   * written onto the job's customer. Returns false — writing nothing — when
   * no customer is wired, because a charge with no khata to land in is money
   * recorded into a void.
   */
  chargeClient(
    jobId: string,
    amountMinor: number,
    note: string | null,
    whenMs: number = Date.now(),
  ): boolean {
    const customer = this.customerForJob(jobId)
    if (!customer || amountMinor <= 0) return false
    recordEntry(this.db, {
      orgId: this.seed.orgId,
      customerId: customer.id,
      kind: 'damage_charge',
      amountMinor,
      jobId,
      note,
      createdAt: whenMs,
    })
    return true
  }

  /**
   * The late-fee DRAFT for an overdue return — priced from what came back
   * in the return session as well as what is still out, so the natural
   * dock order (scan in first, open the sheet second) cannot collapse it
   * to zero. Null unless the job is actually overdue with a customer to
   * charge — the sheet must never open on a guess. The figure is a draft
   * the owner edits and confirms; nothing here writes. See khata.ts.
   */
  lateFeeDraftFor(jobId: string, nowMs: number = Date.now()): LateFeeDraftView | null {
    return lateFeeDraftFor(this.db, jobId, nowMs)
  }

  /** The confirmed late fee — the owner's figure, not the draft's. */
  recordLateFee(
    jobId: string,
    amountMinor: number,
    note: string | null,
    whenMs: number = Date.now(),
  ): boolean {
    const customer = this.customerForJob(jobId)
    if (!customer || amountMinor <= 0) return false
    recordEntry(this.db, {
      orgId: this.seed.orgId,
      customerId: customer.id,
      kind: 'late_fee',
      amountMinor,
      jobId,
      note,
      createdAt: whenMs,
    })
    return true
  }

  /** The "send balance" card for one customer, in the app's language, with
   *  the payment line under it when one is configured. */
  balanceText(customerId: string): string | null {
    const c = this.customer(customerId)
    if (!c) return null
    return balanceCardText(
      {
        customerName: c.name,
        houseName: this.seed.houseName,
        entries: c.entries,
        paymentLine: paymentLine(this.db),
      },
      khataLabels(STR),
    )
  }

  /** The month's statement for one customer — WhatsApp-forwardable text. */
  statementText(customerId: string, nowMs: number = Date.now()): string | null {
    const c = this.customer(customerId)
    if (!c) return null
    return monthlyStatementText(
      {
        customerName: c.name,
        houseName: this.seed.houseName,
        entries: c.entries,
        nowMs,
        paymentLine: paymentLine(this.db),
      },
      khataLabels(STR),
    )
  }

  /** What one unit has earned, and how far it has paid for itself. */
  assetEarnings(assetId: string): AssetEarnings {
    return assetEarnings(this.db, assetId)
  }

  /**
   * Uncorrected charges whose item has since been scanned home — the
   * NEEDS-A-DECISION notices for the khata and the session summary.
   * POLICY (owner may overrule): surfaced, never auto-reversed.
   */
  chargedButReturned(filter: { jobId?: string; customerId?: string } = {}): ChargedButReturned[] {
    return chargedButReturned(this.db).filter(
      (n) =>
        (filter.jobId === undefined || n.jobId === filter.jobId) &&
        (filter.customerId === undefined || n.customerId === filter.customerId),
    )
  }

  /** Write the correction a notice drafted — the owner's confirm tap. */
  reverseEntry(entryId: string, whenMs: number = Date.now()): boolean {
    return recordReversalOf(
      this.db,
      this.seed.orgId,
      entryId,
      STR.customerReversedNote,
      whenMs,
    )
  }

  /**
   * Kharcha — money the house PAID OUT, the ledger's other half (0019).
   * A past fact like a payment, so `whenMs` backdates it the same way.
   * Returns false — writing nothing — for a non-positive amount.
   */
  recordExpense(
    input: {
      kind: ExpenseKind
      amountMinor: number
      assetId?: string | null
      jobId?: string | null
      /** The booking this cost belongs to (0024 D9): it nets out of the quote. */
      bookingId?: string | null
      counterparty?: string | null
      note?: string | null
    },
    whenMs: number = Date.now(),
  ): boolean {
    return (
      recordExpense(this.db, {
        orgId: this.seed.orgId,
        kind: input.kind,
        amountMinor: input.amountMinor,
        assetId: input.assetId ?? null,
        jobId: input.jobId ?? null,
        bookingId: input.bookingId ?? null,
        counterparty: input.counterparty ?? null,
        note: input.note ?? null,
        createdAt: whenMs,
      }) !== null
    )
  }

  /** Void one expense forward-only — the reversal row copies its target;
   *  a double-tap cannot over-credit the house. See kharcha.ts. */
  reverseExpense(expenseId: string, whenMs: number = Date.now()): boolean {
    return reverseExpense(
      this.db,
      this.seed.orgId,
      expenseId,
      STR.kharchaReversedNote,
      whenMs,
    )
  }

  /** What one job actually made: its ledger income minus its expenses. */
  jobMargin(jobId: string): JobMargin {
    return jobMargin(this.db, jobId)
  }

  /** The month's bottom line — earned − spent, from the local book only. */
  monthProfit(nowMs: number = Date.now()): MonthProfit {
    return monthProfit(this.db, nowMs)
  }

  /** The demand this product's shortage turned away this month. */
  turnedAwayFor(
    productId: string,
    nowMs: number = Date.now(),
  ): { times: number; units: number } {
    return turnedAwayThisMonth(this.db, productId, nowMs)
  }

  /** Persist the shortages of an answered kit list at the moment the answer
   *  is USED — reply copied, or a job made from it. See khata.ts. */
  recordTurnedAway(summary: AvailabilitySummary, nowMs: number = Date.now()): number {
    return recordTurnedAway(this.db, summary.lines, nowMs)
  }

  /** This month's turned-away units for a product, split by why — shelf
   *  short vs already promised on the calendar. */
  turnedAwayByReason(productId: string, nowMs: number = Date.now()): { short: number; committed: number } {
    return turnedAwayByReason(this.db, productId, nowMs)
  }


  /** 'JazzCash: 0300 1234567' — or null; the money documents omit it then. */
  paymentLine(): string | null {
    return paymentLine(this.db)
  }

  setPaymentLine(value: string | null): void {
    setPaymentLine(this.db, value)
  }

  /** The payment QR as a data URL, or null. This device only. */
  paymentQr(): string | null {
    return paymentQr(this.db)
  }

  setPaymentQr(dataUrl: string | null): void {
    setPaymentQr(this.db, dataUrl)
  }

  // ---- the fleet lifecycle (Wave 2, migration 0020) ---------------------
  // Thin doors onto @papa/core's fleet.ts and the app's report builders. The
  // owner/manager gate is the server's (submit_scan_batch); the demo has one
  // user, so the door is plain — the projection is the whole truth offline.

  /**
   * Declare an item lost, stolen or sold — it leaves the fleet, off its job,
   * with a reason. A sale amount rides the event note, NOT the money book
   * (0020 D3). See markTerminal in @papa/core.
   */
  markTerminal(
    assetId: string,
    disposition: Disposition,
    opts: { note?: string | null; saleAmountMinor?: number | null } = {},
  ): void {
    markTerminal(this.db, {
      assetId,
      disposition,
      note: opts.note ?? null,
      saleAmountMinor: opts.saleAmountMinor ?? null,
    })
  }

  /** Bring a terminal item home — the recovery door. */
  markFound(assetId: string): void {
    markFound(this.db, { assetId })
  }

  /** Substitutes fit to swap onto a job — same product first. */
  substitutesFor(brokenAssetId: string): SubstituteRow[] {
    return substitutesFor(this.db, brokenAssetId)
  }

  /**
   * The crisis-day swap: a substitute onto the broken item's live job in one
   * atomic flow — both movements recorded, the broken one flagged. Refusals
   * are RESULTS, not throws, so the sheet can render them. See swapAsset.
   */
  swapOntoJob(
    brokenAssetId: string,
    substituteAssetId: string,
    opts: { flag?: SwapFlag; note?: string | null } = {},
  ): SwapResult {
    const broken = this.db.get<{ current_job_id: string | null }>(
      `select current_job_id from assets where id = ?`,
      [brokenAssetId],
    )
    if (!broken?.current_job_id) return { outcome: 'not_on_job' }
    return swapAsset(this.db, {
      jobId: broken.current_job_id,
      brokenAssetId,
      substituteAssetId,
      flag: opts.flag,
      note: opts.note ?? null,
    })
  }

  /**
   * The theft report for a stolen item — the police / insurance card, built
   * from local facts (the mirror, the queue, the photo table) in the app's
   * language. Null unless the item is actually stolen: the loud card is only
   * honest when the state behind it is.
   */
  theftReportText(assetId: string): string | null {
    const asset = this.assetView(assetId)
    if (!asset || asset.disposition !== 'stolen') return null

    const last = decodeScanOps(this.db)
      .filter((op) => op.assetId === assetId && op.eventType !== 'mark_stolen')
      .at(-1)
    const photos = this.db.get<{ n: number }>(
      `select count(*) as n from condition_photos where asset_id = ?`,
      [assetId],
    )

    return buildTheftReport(
      {
        houseName: this.seed.houseName,
        item: { code: asset.code, name: asset.name, serial: asset.serial },
        photoCount: Number(photos?.n ?? 0),
        lastSeen: last
          ? {
              whenMs: last.createdAt,
              jobLabel: last.jobId ? (this.job(last.jobId)?.label ?? null) : null,
              place: asset.locationName,
            }
          : null,
        contactLine: this.paymentLine(),
      },
      theftLabels(STR),
    )
  }

  /** Shelves to count against, for the ginti picker. */
  shelves(): { id: string; name: string }[] {
    return shelves(this.db)
  }

  /** A shelf's live contents — the ginti checklist rows. */
  gearOnShelf(locationId: string): { id: string; code: string; name: string }[] {
    return shelfContents(this.db, locationId)
  }

  /**
   * A ginti (cycle count) session against one shelf. Opens a count session,
   * takes the ids the tech scanned, writes an inventory_count event for each
   * SEEN item (non-destructive: last_scanned_at moves, presence does not),
   * and returns the diff plus a copyable discrepancy report. Missing items
   * are surfaced for the owner to decide — never auto-marked lost (0020 D6).
   */
  runGinti(
    locationId: string,
    seenAssetIds: string[],
  ): { diff: CountDiff; report: string; shelfName: string } {
    const shelfName =
      this.db.get<{ name: string | null }>(`select name from locations where id = ?`, [locationId])
        ?.name ?? 'Shelf'
    const expected = expectedOnShelf(this.db, locationId)
    const diff = cycleCountDiff(expected, seenAssetIds)

    // Write the SEEN sightings as counted events, one session. Non-destructive
    // by the reducer's design: inventory_count moves last_scanned_at and the
    // shelf, never presence.
    const session = new ScanSession(this.db, {
      deviceId: 'demo-device',
      expected: new Set(expected),
    })
    for (const id of seenAssetIds) {
      session.scan(this.tagFor(id) ?? id, 'inventory_count')
    }

    const facts = (id: string) => {
      const f = assetFacts(this.db, id)
      return { code: f?.code ?? null, name: f?.name ?? null }
    }
    const report = buildGintiReport(
      {
        shelf: shelfName,
        okCount: diff.ok.length,
        missing: diff.missing.map(facts),
        unexpected: diff.unexpected.map(facts),
      },
      gintiLabels(STR),
    )
    return { diff, report, shelfName }
  }

  // ---- the living fleet (Wave 3, migration 0021) -------------------------

  /** One unit's wear facts — the asset page's service and cycle lines. */
  serviceFacts(assetId: string): ServiceFacts | null {
    return serviceFacts(this.db, assetId)
  }

  /** The Sehat surface: service-due, cycle-ceiling and dead-stock groups. */
  sehat(nowMs: number = Date.now()): Sehat {
    return sehat(this.db, nowMs)
  }

  /**
   * The Serviced door — note + optional cost in ONE flow (0021 D2): when a
   * cost is given, a repair lands on the kharcha book named to this unit
   * (its cost history and the payback bar's denominator move), and the
   * serviced event carries the expense link the server validates. One
   * transaction: the drivers nest, so the meter reset and the money line
   * cannot land without each other.
   */
  recordServiced(
    assetId: string,
    input: { note?: string | null; costMinor?: number | null; counterparty?: string | null } = {},
    whenMs: number = Date.now(),
  ): void {
    this.db.transaction(() => {
      let expenseId: string | null = null
      if (typeof input.costMinor === 'number' && input.costMinor > 0) {
        expenseId = recordExpense(this.db, {
          orgId: this.seed.orgId,
          kind: 'repair',
          amountMinor: input.costMinor,
          assetId,
          counterparty: input.counterparty ?? null,
          note: input.note ?? null,
          createdAt: whenMs,
        })
      }
      recordServiced(this.db, {
        assetId,
        note: input.note ?? null,
        expenseId,
        now: () => whenMs,
      })
    })
  }

  /**
   * An awaaz note — spoken evidence, stored like a condition photo: the
   * refusal is a RESULT the screen renders (how many notes still wait),
   * never a silent eviction. Demo-honest: nothing uploads.
   */
  captureVoiceNote(input: {
    assetId?: string | null
    jobId?: string | null
    sessionId?: string | null
    durationMs: number
    dataUri: string
    bytes: number
    mime?: string | null
  }): VoiceCaptureResult {
    return this.voice.capture({
      assetId: input.assetId ?? null,
      jobId: input.jobId ?? null,
      sessionId: input.sessionId ?? null,
      durationMs: input.durationMs,
      localUri: input.dataUri,
      bytes: input.bytes,
      mime: input.mime ?? null,
    })
  }

  /** Everything spoken over one item, newest first — inline playback. */
  voiceNotesFor(assetId: string): VoiceNoteRow[] {
    return this.voice.forAsset(assetId)
  }

  // ---- the promise calendar (Phase C, 0022) -------------------------------
  // Thin doors onto demo/bookings.ts and @papa/core bookings.ts: every rule
  // lives there under plain Node; the store binds the database, the org,
  // the clock and the active string table. Every write here also queues
  // the matching RPC op for the pipe to replay — nothing is confirmed
  // server-side until it drains, and the sync strip says so.

  /** The org's buffers, pencil TTL and credential threshold. */
  bookingSettings(): BookingSettings {
    return bookingSettings(this.db)
  }

  /** Bookings for a list, soonest start first; 'live' hides dead pencils. */
  bookings(filter: BookingFilter = {}, nowMs: number = Date.now()): BookingRow[] {
    return listBookings(this.db, filter, nowMs)
  }

  booking(id: string, nowMs: number = Date.now()): BookingView | null {
    return bookingView(this.db, id, nowMs)
  }

  /** One row per day of the month, with the bookings touching it and the
   *  season shading (ASSUMPTION #wedding-season). */
  calendar(monthStartMs: number, nowMs: number = Date.now()): CalendarDay[] {
    return calendar(this.db, monthStartMs, nowMs)
  }

  /** The three-layer answer (0022 D6): here-now / pencilled / confirmed. */
  availabilityFor(
    productId: string,
    startMs: number,
    endMs: number,
    nowMs: number = Date.now(),
  ): BookingAvailability {
    return availabilityFor(this.db, productId, startMs, endMs, nowMs)
  }

  /** A pencil or draft, or a pencil confirmed in the same breath. Refusals
   *  are RESULTS: a collision names the winner, a shortfall the count. */
  createBooking(input: CreateBookingInput, nowMs: number = Date.now()): CreateBookingResult {
    return createBooking(this.db, this.seed.orgId, input, nowMs)
  }

  /** What confirm would do, before it does it — the Confirm sheet's preview. */
  planConfirm(id: string, opts: ConfirmOptions = {}, nowMs: number = Date.now()): ConfirmPlan {
    return planConfirm(this.db, id, opts, nowMs)
  }

  /** Confirm = allocate (override 3), behind the credential gate (D9). */
  confirmBooking(
    id: string,
    opts: ConfirmOptions = {},
    nowMs: number = Date.now(),
  ): ConfirmBookingResult {
    return confirmBooking(this.db, this.seed.orgId, id, opts, nowMs)
  }

  cancelBooking(id: string, reason: string | null, nowMs: number = Date.now()): CancelBookingResult {
    return cancelBooking(this.db, id, reason, nowMs)
  }

  /** The extension-collision preview (D10), read-only: who a new end breaks. */
  extensionPreview(id: string, newEndMs: number, nowMs: number = Date.now()) {
    return extensionPreview(this.db, id, newEndMs, nowMs)
  }

  /** Extends, or names who breaks. Collisions covered by a sub-rent intent
   *  are written over — see ExtendOptions. */
  extendBooking(
    id: string,
    newEndMs: number,
    nowMs: number = Date.now(),
    opts: ExtendOptions = {},
  ): ExtendBookingResult {
    return extendBooking(this.db, id, newEndMs, nowMs, undefined, opts)
  }

  /** The substitute door: move another booking's claim to a free unit of
   *  the same product, so the extension no longer breaks it. */
  reallocateReservation(
    reservationId: string,
    newAssetId: string,
    forBookingId: string | null = null,
    nowMs: number = Date.now(),
  ): ReallocateResult {
    return reallocateReservation(this.db, reservationId, newAssetId, nowMs, undefined, forBookingId)
  }

  substitutesForReservation(reservationId: string): ReservationSubstitute[] {
    return substitutesForReservation(this.db, reservationId)
  }

  /** The reservation a collision card points at — the rival's claim on
   *  that unit — so the substitute door knows what to move. */
  reservationFor(collision: ExtensionCollision): string | null {
    if (collision.kind !== 'asset') return null
    return this.db.get<{ id: string }>(
      `select id from asset_reservations where booking_id = ? and asset_id = ? and state = 'confirmed' limit 1`,
      [collision.bookingId, collision.assetId],
    )?.id ?? null
  }

  /** The sub-rent door: intent on the note, an op for the pipe. */
  noteSubRent(id: string, intent: SubRentIntent, nowMs: number = Date.now()) {
    return noteSubRent(this.db, id, intent, STR, nowMs)
  }

  /** The Today board's Promised section. */
  promisedStrip(nowMs: number = Date.now()): PromisedStrip {
    return promisedStrip(this.db, nowMs)
  }

  /** A customer's phone as a dial-able number, or null. */
  customerPhone(customerId: string): string | null {
    const c = this.db.get<{ phone: string | null }>(`select phone from customers where id = ?`, [customerId])
    return parsePhoneNumber(c?.phone ?? null)
  }

  /** The bridge (D8): the confirmed booking becomes the job on the board. */
  convertBookingToJob(id: string, nowMs: number = Date.now()): ConvertBookingResult {
    return convertBookingToJob(this.db, this.seed.orgId, id, nowMs)
  }

  /** Opportunistic pruning (D7) — every write already runs it; a screen
   *  may call it on open so a dead pencil reads cancelled. */
  pruneExpiredPencils(nowMs: number = Date.now()): number {
    return pruneExpiredPencils(this.db, nowMs)
  }

  /** The WhatsApp confirmation, in the active language; null unless confirmed. */
  bookingConfirmText(id: string, nowMs: number = Date.now()): string | null {
    return bookingConfirmText(this.db, STR, this.seed.houseName, id, nowMs)
  }

  /** The scanner's warning: this unit is promised to a confirmed booking
   *  whose hold begins inside the horizon (48h). */
  promisedSoon(assetId: string, nowMs: number = Date.now()): PromisedSoon | null {
    return promisedSoon(this.db, assetId, nowMs)
  }

  // ---- the network (0025) ------------------------------------------------
  // Thin doors onto network.ts: partner houses, sub-hire in and out, crew,
  // the stolen broadcast, ask the market, the thermal parchi. Every rule
  // lives there where plain Node asserts it; the store binds the database,
  // the clock, the org and the active language.

  partners(): PartnerRow[] {
    return partners(this.db)
  }

  partner(id: string): PartnerRow | null {
    return partner(this.db, id)
  }

  upsertPartner(input: UpsertPartnerInput, nowMs: number = Date.now()): UpsertPartnerResult {
    return upsertPartner(this.db, this.seed.orgId, input, nowMs)
  }

  /** Refused while a sub-hire with the partner is still open. */
  removePartner(id: string, nowMs: number = Date.now()): RemovePartnerResult {
    return removePartner(this.db, id, nowMs)
  }

  /** Gear borrowed from a partner — a unit when a serial is given, the
   *  expense when a cost is, always the row and the op. */
  recordSubHireIn(input: RecordSubHireInInput, nowMs: number = Date.now()): RecordSubHireInResult {
    return recordSubHireIn(this.db, this.seed.orgId, input, nowMs)
  }

  /** Gear lent to a partner — the 'Sub-hire → X' job on the board. */
  recordSubHireOut(input: RecordSubHireOutInput, nowMs: number = Date.now()): RecordSubHireOutResult {
    return recordSubHireOut(this.db, this.seed.orgId, input, nowMs)
  }

  /** It came back (out) or went home (in). Refusals are results. */
  closeSubHire(id: string, returnedAtMs: number = Date.now(), nowMs: number = Date.now()): CloseSubHireResult {
    return closeSubHire(this.db, id, returnedAtMs, nowMs)
  }

  subHires(filter: SubHireFilter = {}): SubHireRow[] {
    return subHires(this.db, filter)
  }

  /** The sub-hire behind a job — how the board stamps SUB-HIRE. */
  subHireForJob(jobId: string): SubHireRow | null {
    return subHireForJob(this.db, jobId)
  }

  /** The open sub-hire that borrowed this unit in, when it is one. */
  subHireForAsset(assetId: string): SubHireRow | null {
    return subHireForAsset(this.db, assetId)
  }

  /** Both books on one line: what we owe them, what they owe us. */
  partnerMoney(id: string): PartnerMoney {
    return partnerMoney(this.db, id)
  }

  /** Units of a product fit to lend: owned, in the fleet, on the shelf. */
  lendableUnits(productId: string): { id: string; code: string }[] {
    return this.db
      .all<{ id: string; asset_code: string | null }>(
        `select id, asset_code from assets
          where product_id = ? and ownership = 'owned' and disposition is null
            and presence = 'here' and health = 'ok'
          order by asset_code`,
        [productId],
      )
      .map((r) => ({ id: r.id, code: r.asset_code ?? '—' }))
  }

  /** Whether a unit may be lent on: owned, still in the fleet. */
  lendable(assetId: string): boolean {
    const a = this.db.get<{ ownership: string | null; disposition: string | null }>(
      `select ownership, disposition from assets where id = ?`,
      [assetId],
    )
    return !!a && (a.ownership ?? 'owned') === 'owned' && a.disposition === null
  }

  staff(): StaffRow[] {
    return staff(this.db)
  }

  crewFor(jobId: string): CrewMember[] {
    return crewFor(this.db, jobId)
  }

  assignAttendant(
    jobId: string,
    userId: string,
    role: 'attendant' | 'driver' = 'attendant',
    nowMs: number = Date.now(),
  ): CrewResult {
    return assignAttendant(this.db, this.seed.orgId, jobId, userId, role, nowMs)
  }

  unassignAttendant(jobId: string, userId: string, nowMs: number = Date.now()): CrewResult {
    return unassignAttendant(this.db, jobId, userId, nowMs)
  }

  /** The facts behind the partner-group line; null unless stolen. */
  stolenBroadcastFacts(assetId: string) {
    return stolenBroadcastFacts(this.db, assetId, this.seed.houseName)
  }

  /** The partner-group line for a stolen unit, in the active language. */
  stolenBroadcastText(assetId: string): string | null {
    return stolenBroadcast(this.db, assetId, this.seed.houseName, getLang())
  }

  /** The ask-the-market message, in the active language. */
  askTheMarket(shortage: ShortageLine[]): string {
    return askTheMarket(this.db, shortage, this.seed.houseName, getLang())
  }

  publicTagUrlBase(): string | null {
    return publicTagUrlBase(this.db)
  }

  setPublicTagUrlBase(value: string | null): void {
    setPublicTagUrlBase(this.db, value)
  }

  publicPhone(): string | null {
    return publicPhone(this.db)
  }

  setPublicPhone(value: string | null): void {
    setPublicPhone(this.db, value)
  }

  /** The parchi as printer bytes (58mm, 32 columns) — null when no
   *  session was ever recorded on the job. Bytes only; where they go is
   *  the ThermalPrinter seam (print/thermal.ts). */
  thermalParchiBytes(jobId: string, nowMs: number = Date.now()): Uint8Array | null {
    const text = this.parchiText(jobId, nowMs)
    return text ? buildParchiEscPos(parchiDocFromText(text), { width: 32 }) : null
  }

  /** The active tag for an asset — how a ginti scan names it. */
  private tagFor(assetId: string): string | null {
    return (
      this.db.get<{ tag_code: string }>(
        `select tag_code from asset_tags where asset_id = ? and status = 'active' limit 1`,
        [assetId],
      )?.tag_code ?? null
    )
  }
}

/** A safe, stable id fragment from a product name. */

/** The resolved lines of an answered kit list, as the quote pipeline
 *  takes them — unresolved lines are not priced, they are named. */
export function enquiryLines(summary: AvailabilitySummary): EnquiryLine[] {
  return summary.lines
    .filter((l) => l.productId)
    .map((l) => ({ productId: l.productId as string, productName: l.productName ?? l.raw, qty: l.quantity }))
}

/**
 * The seed-shaped facts a live store carries: the org from the session,
 * the person holding the phone, no demo tags and no demo jobs. The house
 * name is the parchi letterhead; the org's name is not mirrored yet, so
 * the enrolled person's org id stands in until a settings row carries it.
 */
function liveSeed(session: Session): DemoSeed {
  return {
    orgId: session.orgId,
    houseName: session.role ? session.displayName : '',
    userName: session.displayName,
    tags: [],
    jobs: [],
  }
}
