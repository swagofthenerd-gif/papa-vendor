import {
  DEFAULT_BOOKING_SETTINGS,
  HOUR_MS,
  Outbox,
  blockedPeriod,
  bookingAvailability,
  bookingDateLabel,
  extendedWindow,
  extensionCollisions,
  isLivePencil,
  loadAssetReservations,
  loadBooking,
  loadBookings,
  loadLines,
  loadStockReservations,
  msOf,
  overlaps,
  pencilCountdown,
  seasonFor,
  type AssetReservation,
  type Booking,
  type BookingAvailability,
  type BookingLine,
  type BookingSettings,
  type BookingStatus,
  type ExtensionCollision,
  type PencilCountdown,
  type Season,
  type SqlDriver,
  type StockReservation,
} from '@papa/core'
import { createJob } from './read-model.ts'
import { getSetting, isoDate, setSetting } from './khata.ts'
import { NAMES, defaultIds, lastOpNaming, type OpIds } from './ops.ts'
import type { StrTable } from '../strings.ts'

/**
 * The booking read model AND write side, on the phone — the khata.ts
 * pattern: a plain .ts module, every query and every rule assertable under
 * plain Node against a real SQLite, with store.ts a thin wiring layer.
 *
 * WHAT A WRITE IS HERE. Every write does two things in ONE transaction:
 * it updates the local mirror optimistically (the calendar the desk sees
 * offline), and it enqueues an outbox op NAMED AFTER THE 0022 RPC with a
 * payload shaped like that RPC's arguments — `p_customer_id`,
 * `p_customer_period`, `p_lines`… — so the future sync pipe replays the
 * queue against the server unchanged. The server then re-runs the same
 * rules under its own locks and constraints; where the phone said yes and
 * the server says no (a rival desk confirmed first while this one was
 * offline), the op fails, its subtree fails with it, and the desk hears
 * about it as one card (packages/core outbox.ts). The two ids the RPCs do
 * not take — `client_booking_id`, `client_job_id` — ride beside the `p_*`
 * args so the pipe can map the server's minted ids back onto the mirror.
 *
 * THE SEMANTICS ARE 0022's, so the optimistic view and the server's truth
 * agree: the gapless number (D12), the buffer defaults into blocked_period
 * (D2), the pencil TTL (D7), least-utilised allocation (D4), the nameable
 * collision (D5), bulk capacity as a peak (D6), the credential gate on
 * confirm (D9), the extension-collision list as data (D10), one live job
 * per booking (D8), and opportunistic pruning of expired pencils on every
 * write (D7). CONTRIBUTING principle 2 still holds: confirming allocates
 * a scarce resource and NEEDS the server — what this module does is let
 * the desk work while the pipe is down, honestly labelled as waiting to
 * send, exactly as a scan is.
 */

// ------------------------------------------------------------- settings

const SETTING_KEYS = {
  prep: 'prep_buffer_hours',
  turnaround: 'turnaround_buffer_hours',
  ttl: 'pencil_ttl_hours',
  threshold: 'new_customer_value_threshold_minor',
  counter: 'booking_next_no',
} as const

/** The org's booking knobs from app_settings, defaults from @papa/core —
 *  the one place a buffer or a TTL is read. */
export function bookingSettings(db: SqlDriver): BookingSettings {
  const num = (key: string, fallback: number): number => {
    const raw = getSetting(db, key)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  const d = DEFAULT_BOOKING_SETTINGS
  return {
    prepBufferHours: num(SETTING_KEYS.prep, d.prepBufferHours),
    turnaroundBufferHours: num(SETTING_KEYS.turnaround, d.turnaroundBufferHours),
    pencilTtlHours: num(SETTING_KEYS.ttl, d.pencilTtlHours),
    valueThresholdMinor: num(SETTING_KEYS.threshold, d.valueThresholdMinor),
  }
}

/**
 * The gapless local number (mirror of D12). The counter lives in
 * app_settings and moves inside the create transaction, so a refused
 * create never burns a number. It also never falls below the highest
 * number already mirrored, so a synced booking and a locally minted one
 * cannot share a number on this phone.
 */
function nextBookingNo(db: SqlDriver): number {
  const counter = Number(getSetting(db, SETTING_KEYS.counter) ?? 1)
  const highest = Number(db.get<{ m: number | null }>(`select max(booking_no) as m from bookings`)?.m ?? 0)
  const no = Math.max(Number.isFinite(counter) ? counter : 1, highest + 1)
  setSetting(db, SETTING_KEYS.counter, String(no + 1))
  return no
}

// ---------------------------------------------------------------- shapes

const iso = (ms: number): string => new Date(ms).toISOString()

/** The server's tstzrange literal, '[)' — what the RPC argument takes. */
const tstzrange = (fromMs: number, untilMs: number): string =>
  `["${iso(fromMs)}","${iso(untilMs)}")`

/** The clock and id mint every write takes — ops.ts's, under the name
 *  the booking wave gave it. */
export type BookingIds = OpIds
export { defaultIds }

export interface BookingLineView extends BookingLine {
  productName: string
  assetCode: string | null
  /** Units bound to this line at confirm (serialized), by code. */
  allocated: { assetId: string; assetCode: string }[]
}

export interface BookingRow extends Booking {
  season: Season
  pencil: PencilCountdown
  /** 'draft' | 'pencil' | 'confirmed' | 'cancelled' — with an expired
   *  pencil that has not been pruned yet reading as 'expired', so a list
   *  never shows a dead hold as live. */
  stamp: BookingStatus | 'expired'
  itemCount: number
  /** The live job this booking became, when it has (D8). */
  job: { id: string; label: string; status: string } | null
}

export interface BookingView extends BookingRow {
  lines: BookingLineView[]
  assetReservations: AssetReservation[]
  stockReservations: StockReservation[]
}

export interface BookingFilter {
  /** 'live' = drafts, live pencils and confirmed — what the calendar shows. */
  status?: BookingStatus | 'live' | 'expired'
  customerId?: string
  /** Bookings whose CUSTOMER window touches [fromMs, untilMs). */
  fromMs?: number
  untilMs?: number
}

function stampOf(b: Booking, nowMs: number): BookingRow['stamp'] {
  if (b.status === 'pencil' && !isLivePencil(b, nowMs)) return 'expired'
  return b.status
}

function jobOf(db: SqlDriver, bookingId: string): BookingRow['job'] {
  const j = db.get<{ id: string; label: string | null; status: string }>(
    `select id, label, status from jobs where booking_id = ? order by status limit 1`,
    [bookingId],
  )
  return j ? { id: j.id, label: j.label ?? '', status: j.status } : null
}

function rowOf(db: SqlDriver, b: Booking, nowMs: number): BookingRow {
  const count = db.get<{ n: number | null }>(
    `select sum(qty) as n from booking_lines where booking_id = ?`, [b.id],
  )
  return {
    ...b,
    season: seasonFor(b.customerStartMs),
    pencil: pencilCountdown(b, nowMs),
    stamp: stampOf(b, nowMs),
    itemCount: Number(count?.n ?? 0),
    job: jobOf(db, b.id),
  }
}

/** Bookings for a list, soonest start first. */
export function listBookings(db: SqlDriver, filter: BookingFilter, nowMs: number): BookingRow[] {
  return loadBookings(db)
    .filter((b) => {
      if (filter.customerId && b.customerId !== filter.customerId) return false
      if (filter.fromMs !== undefined && filter.untilMs !== undefined
          && !overlaps(b.customerStartMs, b.customerEndMs, filter.fromMs, filter.untilMs)) return false
      const stamp = stampOf(b, nowMs)
      switch (filter.status) {
        case undefined: return true
        case 'live': return stamp === 'draft' || stamp === 'pencil' || stamp === 'confirmed'
        default: return stamp === filter.status
      }
    })
    .sort((a, b) => a.customerStartMs - b.customerStartMs || a.bookingNo - b.bookingNo)
    .map((b) => rowOf(db, b, nowMs))
}

export function bookingView(db: SqlDriver, id: string, nowMs: number): BookingView | null {
  const b = loadBooking(db, id)
  if (!b) return null
  const reservations = loadAssetReservations(db, id)
  const lines = loadLines(db, id).map((l): BookingLineView => {
    const product = l.productId
      ? db.get<{ display_name: string | null }>(`select display_name from products where id = ?`, [l.productId])
      : null
    const asset = l.assetId
      ? db.get<{ asset_code: string | null; display_name: string | null; product_name: string | null; product_id: string | null }>(
          `select a.asset_code, a.display_name, p.display_name as product_name, p.id as product_id
             from assets a left join products p on p.id = a.product_id where a.id = ?`,
          [l.assetId],
        )
      : null
    const allocated = reservations
      .filter((r) => r.bookingLineId === l.id)
      .map((r) => ({
        assetId: r.assetId,
        assetCode:
          db.get<{ asset_code: string | null }>(`select asset_code from assets where id = ?`, [r.assetId])
            ?.asset_code ?? r.assetId,
      }))
    return {
      ...l,
      // A demanded unit's line names no product of its own; the view
      // resolves it through the unit ONCE here, so every sheet that asks
      // 'what product is this line' reads one field (the way quotes.ts
      // does) instead of re-querying the asset.
      productId: l.productId ?? asset?.product_id ?? null,
      productName: product?.display_name ?? asset?.product_name ?? asset?.display_name ?? '',
      assetCode: asset?.asset_code ?? null,
      allocated,
    }
  })
  return {
    ...rowOf(db, b, nowMs),
    lines,
    assetReservations: reservations,
    stockReservations: loadStockReservations(db, id),
  }
}

export interface CalendarDay {
  dayMs: number
  season: Season
  confirmed: BookingRow[]
  pencilled: BookingRow[]
}

/** One row per day of the month containing `monthStartMs`, each with the
 *  bookings whose CUSTOMER window touches it. Live pencils only; an
 *  expired one is a dead conversation and stays off the calendar. */
export function calendar(db: SqlDriver, monthStartMs: number, nowMs: number): CalendarDay[] {
  const first = new Date(monthStartMs)
  const y = first.getFullYear()
  const m = first.getMonth()
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  const live = listBookings(db, { status: 'live' }, nowMs)
  const days: CalendarDay[] = []
  for (let d = 1; d <= daysInMonth; d++) {
    const dayMs = new Date(y, m, d).getTime()
    const next = new Date(y, m, d + 1).getTime()
    const touching = live.filter((b) => overlaps(b.customerStartMs, b.customerEndMs, dayMs, next))
    days.push({
      dayMs,
      season: seasonFor(dayMs),
      confirmed: touching.filter((b) => b.stamp === 'confirmed'),
      pencilled: touching.filter((b) => b.stamp === 'pencil'),
    })
  }
  return days
}

/** The month's two headline numbers — distinct confirmed bookings and
 *  distinct live pencils touching any day of it — for the calendar's
 *  heading and the desk's calendar door alike. */
export function monthCounts(days: CalendarDay[]): { confirmed: number; pencilled: number } {
  return {
    confirmed: new Set(days.flatMap((d) => d.confirmed.map((b) => b.id))).size,
    pencilled: new Set(days.flatMap((d) => d.pencilled.map((b) => b.id))).size,
  }
}

export interface PromisedStrip {
  /** Confirmed bookings whose customer window begins inside the horizon
   *  and that have not become a job yet — the convert-to-job candidates. */
  startingSoon: BookingRow[]
  /** Live pencils that die before local midnight — the countdown rows. */
  pencilsToday: BookingRow[]
}

/** The board's "Promised" section. Horizon 48h, the scanner's own. */
export function promisedStrip(db: SqlDriver, nowMs: number, horizonMs: number = 48 * HOUR_MS): PromisedStrip {
  const live = listBookings(db, { status: 'live' }, nowMs)
  const d = new Date(nowMs)
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return {
    startingSoon: live.filter((b) =>
      b.stamp === 'confirmed' && b.job === null
      && b.customerStartMs >= nowMs && b.customerStartMs < nowMs + horizonMs),
    pencilsToday: live.filter((b) =>
      b.stamp === 'pencil' && b.pencilExpiresAtMs !== null && b.pencilExpiresAtMs < midnight),
  }
}

export function availabilityFor(
  db: SqlDriver,
  productId: string,
  startMs: number,
  endMs: number,
  nowMs: number,
): BookingAvailability {
  return bookingAvailability(db, productId, startMs, endMs, nowMs)
}

// --------------------------------------------------------------- pruning

/**
 * Opportunistic pruning (D7): every expired pencil becomes cancelled with
 * cancel_reason 'pencil_expired' and its claims are released. Called at
 * the top of every write, exactly where the server calls its own. No
 * outbox op — the server prunes for itself on its next booking write, and
 * until then its predicate already reads the pencil as dead.
 */
export function pruneExpiredPencils(db: SqlDriver, nowMs: number): number {
  const expired = loadBookings(db).filter((b) => b.status === 'pencil' && !isLivePencil(b, nowMs))
  if (expired.length === 0) return 0
  db.transaction(() => {
    for (const b of expired) {
      db.exec(`delete from asset_reservations where booking_id = ?`, [b.id])
      db.exec(`delete from stock_reservations where booking_id = ?`, [b.id])
      db.exec(
        `update bookings set status = 'cancelled', cancel_reason = 'pencil_expired',
                pencil_expires_at = null, updated_at = ? where id = ?`,
        [iso(nowMs), b.id],
      )
    }
  })
  return expired.length
}

// ---------------------------------------------------------- the ops chain

/**
 * The most recent queued op for a booking — what the next op for the
 * same booking depends on, so the pipe replays create → confirm → extend
 * in the order the desk did them. Matched on the client id the payload
 * carries; JSON.stringify writes it as exactly this substring. Exported
 * for network.ts: a sub-hire IN that rescues a booking chains here too.
 */
export function lastBookingOp(db: SqlDriver, bookingId: string): string | null {
  // ops.ts's match — under the phone's name and, once the pipe has re-keyed
  // the booking (W9), the server's, so the chain stays one chain and a
  // refused confirm parks its convert too — plus the sub-rent intent's key.
  return lastOpNaming(db, [...NAMES.booking(bookingId), { key: 'for_booking_id', id: bookingId }])
}

export function enqueueBookingOp(
  db: SqlDriver,
  ids: BookingIds,
  op: string,
  bookingId: string,
  payload: Record<string, unknown>,
): string {
  const outbox = new Outbox(db, ids.now)
  const id = ids.newId()
  outbox.enqueue({ id, op, payload, dependsOn: lastBookingOp(db, bookingId) })
  return id
}

// ------------------------------------------------------------- create

export type NewBookingLine = { productId: string; qty: number } | { assetId: string }

export interface CreateBookingInput {
  customerId: string
  startMs: number
  endMs: number
  lines: NewBookingLine[]
  /** 'confirmed' = create as a pencil and confirm in the same breath — two
   *  ops, the way the server insists (create_booking refuses 'confirmed'). */
  status: 'draft' | 'pencil' | 'confirmed'
  note?: string | null
  /** For the confirmed path only: the manager's logged reason when the
   *  credential gate would otherwise refuse (override 16). */
  credentialOverrideNote?: string | null
}

export type CreateBookingResult =
  | {
      ok: true
      bookingId: string
      bookingNo: number
      status: BookingStatus
      blockedStartMs: number
      blockedEndMs: number
      pencilExpiresAtMs: number | null
      /** Present when status was 'confirmed': what the confirm did. */
      confirm?: ConfirmBookingResult
    }
  | { ok: false; reason: 'bad_period' | 'no_lines' | 'no_customer' | 'bad_qty' }
  | { ok: false; reason: 'unknown_product' | 'consumable'; productId: string }
  | { ok: false; reason: 'unknown_asset' | 'not_rentable'; assetId: string }
  | { ok: false; collision: Collision; bookingId: string; bookingNo: number }
  | { ok: false; reason: 'short'; short: Shortfall; bookingId: string; bookingNo: number }
  | ConfirmRefusal & { bookingId: string; bookingNo: number }

export function createBooking(
  db: SqlDriver,
  orgId: string,
  input: CreateBookingInput,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): CreateBookingResult {
  pruneExpiredPencils(db, nowMs)

  if (!(input.endMs > input.startMs)) return { ok: false, reason: 'bad_period' }
  if (input.lines.length === 0) return { ok: false, reason: 'no_lines' }
  const customer = db.get<{ id: string; name: string }>(
    `select id, name from customers where id = ?`, [input.customerId],
  )
  if (!customer) return { ok: false, reason: 'no_customer' }

  // Validate every line before touching the counter (D12: a refused
  // create never burns a number).
  type Resolved =
    | { kind: 'product'; productId: string; qty: number; trackingMode: 'serialized' | 'bulk' }
    | { kind: 'asset'; assetId: string }
  const resolved: Resolved[] = []
  for (const line of input.lines) {
    if ('assetId' in line) {
      const a = db.get<{ id: string; disposition: string | null; rentable: number | null }>(
        `select id, disposition, rentable from assets where id = ?`, [line.assetId],
      )
      if (!a) return { ok: false, reason: 'unknown_asset', assetId: line.assetId }
      if (a.disposition !== null || (a.rentable ?? 1) === 0) {
        return { ok: false, reason: 'not_rentable', assetId: line.assetId }
      }
      resolved.push({ kind: 'asset', assetId: a.id })
    } else {
      if (!(line.qty >= 1)) return { ok: false, reason: 'bad_qty' }
      const p = db.get<{ id: string; tracking_mode: string | null }>(
        `select id, tracking_mode from products where id = ?`, [line.productId],
      )
      if (!p) return { ok: false, reason: 'unknown_product', productId: line.productId }
      if (p.tracking_mode === 'consumable') return { ok: false, reason: 'consumable', productId: p.id }
      resolved.push({
        kind: 'product', productId: p.id, qty: line.qty,
        trackingMode: p.tracking_mode === 'bulk' ? 'bulk' : 'serialized',
      })
    }
  }

  const settings = bookingSettings(db)
  const status: BookingStatus = input.status === 'draft' ? 'draft' : 'pencil'
  const blocked = blockedPeriod(input.startMs, input.endMs, settings)
  const pencilExpiresAtMs = status === 'pencil'
    ? nowMs + settings.pencilTtlHours * HOUR_MS
    : null
  const note = input.note?.trim() || null
  const bookingId = `bk-${ids.newId()}`

  const bookingNo = db.transaction(() => {
    const no = nextBookingNo(db)
    db.exec(
      `insert into bookings (id, org_id, booking_no, customer_id, customer_name, status,
         customer_from, customer_until, blocked_from, blocked_until, pencil_expires_at,
         note, cancel_reason, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
      [bookingId, orgId, no, customer.id, customer.name, status,
       iso(input.startMs), iso(input.endMs), iso(blocked.blockedStartMs), iso(blocked.blockedEndMs),
       pencilExpiresAtMs === null ? null : iso(pencilExpiresAtMs), note, iso(nowMs)],
    )
    const rpcLines: Record<string, unknown>[] = []
    for (const r of resolved) {
      const lineId = `bl-${ids.newId()}`
      if (r.kind === 'asset') {
        db.exec(
          `insert into booking_lines (id, org_id, booking_id, product_id, asset_id, qty)
           values (?, ?, ?, null, ?, 1)`,
          [lineId, orgId, bookingId, r.assetId],
        )
        rpcLines.push({ asset_id: r.assetId })
        // A pencil's claim on a demanded unit is recorded but never blocks.
        if (status === 'pencil') {
          db.exec(
            `insert into asset_reservations (id, org_id, booking_id, booking_line_id, asset_id,
               blocked_from, blocked_until, state) values (?, ?, ?, ?, ?, ?, ?, 'pencil')`,
            [`ar-${ids.newId()}`, orgId, bookingId, lineId, r.assetId,
             iso(blocked.blockedStartMs), iso(blocked.blockedEndMs)],
          )
        }
      } else {
        db.exec(
          `insert into booking_lines (id, org_id, booking_id, product_id, asset_id, qty)
           values (?, ?, ?, ?, null, ?)`,
          [lineId, orgId, bookingId, r.productId, r.qty],
        )
        rpcLines.push({ product_id: r.productId, qty: r.qty })
        if (status === 'pencil' && r.trackingMode === 'bulk') {
          db.exec(
            `insert into stock_reservations (id, org_id, booking_id, booking_line_id, product_id,
               qty, blocked_from, blocked_until, state) values (?, ?, ?, ?, ?, ?, ?, ?, 'pencil')`,
            [`sr-${ids.newId()}`, orgId, bookingId, lineId, r.productId, r.qty,
             iso(blocked.blockedStartMs), iso(blocked.blockedEndMs)],
          )
        }
      }
    }
    enqueueBookingOp(db, ids, 'create_booking', bookingId, {
      client_booking_id: bookingId,
      p_customer_id: customer.id,
      p_customer_period: tstzrange(input.startMs, input.endMs),
      p_lines: rpcLines,
      p_status: status,
      p_note: note,
      p_pencil_ttl: status === 'pencil' ? `${settings.pencilTtlHours} hours` : null,
    })
    return no
  })

  const created = {
    ok: true as const,
    bookingId,
    bookingNo,
    status,
    blockedStartMs: blocked.blockedStartMs,
    blockedEndMs: blocked.blockedEndMs,
    pencilExpiresAtMs,
  }
  if (input.status !== 'confirmed') return created

  const confirm = confirmBooking(
    db, orgId, bookingId, { credentialOverrideNote: input.credentialOverrideNote }, nowMs, ids,
  )
  if (confirm.ok) return { ...created, status: 'confirmed', pencilExpiresAtMs: null, confirm }
  // The pencil stands — the desk sees exactly why the promise did not.
  return { ...confirm, bookingId, bookingNo }
}

// ------------------------------------------------------------ confirm

export interface Collision {
  assetId: string
  assetCode: string
  bookingId: string
  bookingNo: number
  customerName: string
}

export interface Shortfall {
  productId: string
  productName: string
  wanted: number
  available: number
  /** The confirmed booking already holding the product over the window,
   *  when there is one to name. */
  winner: { bookingId: string; bookingNo: number; customerName: string } | null
}

export interface ConfirmOptions {
  /** Override 7: the hold can be shortened at confirm, never below the
   *  customer window. */
  blockedPeriod?: { startMs: number; endMs: number } | null
  credentialOverrideNote?: string | null
}

export type ConfirmRefusal =
  | { ok: false; reason: 'not_found' | 'cancelled' | 'already_confirmed' | 'blacklisted' | 'blocked_period_uncovers_customer' }
  | {
      ok: false
      reason: 'needs_credentials'
      exposureMinor: number
      thresholdMinor: number
      /** HONESTY: the phone holds no credential rows. This gate read the
       *  local customers.credentials_verified flag; the server re-runs
       *  its derived verified_customers view on replay. */
      gate: 'local_flag'
    }
  | { ok: false; collision: Collision }
  | { ok: false; reason: 'short'; short: Shortfall }

export type ConfirmBookingResult =
  | {
      ok: true
      bookingId: string
      bookingNo: number
      blockedStartMs: number
      blockedEndMs: number
      exposureMinor: number
      allocations: { lineId: string; assetId: string; assetCode: string }[]
      credentialGate: 'not_needed' | 'overridden'
    }
  | ConfirmRefusal

/** Summed replacement value of what the booking promises (D9; ASSUMPTION
 *  #booking-exposure). Unpriced gear counts zero here, as on the server. */
function exposureOf(db: SqlDriver, lines: BookingLine[]): number {
  let total = 0
  for (const l of lines) {
    if (l.assetId) {
      const r = db.get<{ v: number | null }>(
        `select r.replacement_minor as v from assets a
           left join product_rates r on r.product_id = a.product_id where a.id = ?`,
        [l.assetId],
      )
      total += Number(r?.v ?? 0)
    } else if (l.productId) {
      const r = db.get<{ v: number | null }>(
        `select replacement_minor as v from product_rates where product_id = ?`, [l.productId],
      )
      total += l.qty * Number(r?.v ?? 0)
    }
  }
  return total
}

function winnerOnAsset(db: SqlDriver, assetId: string, startMs: number, endMs: number, notBooking: string): Collision | null {
  const rows = db.all<{
    booking_id: string; booking_no: number; customer_name: string | null
    asset_code: string | null; blocked_from: string; blocked_until: string
  }>(
    `select b.id as booking_id, b.booking_no, b.customer_name, a.asset_code,
            r.blocked_from, r.blocked_until
       from asset_reservations r
       join bookings b on b.id = r.booking_id
       join assets a on a.id = r.asset_id
      where r.asset_id = ? and r.state = 'confirmed' and b.status = 'confirmed'
        and r.booking_id <> ?
      order by b.booking_no`,
    [assetId, notBooking],
  )
  for (const r of rows) {
    if (!overlaps(msOf(r.blocked_from), msOf(r.blocked_until), startMs, endMs)) continue
    return {
      assetId,
      assetCode: r.asset_code ?? assetId,
      bookingId: r.booking_id,
      bookingNo: Number(r.booking_no),
      customerName: r.customer_name ?? '',
    }
  }
  return null
}

/** What confirm WOULD do — the refusal it would return, or the units and
 *  bulk claims it would bind. Pure over the mirror: the Confirm sheet shows
 *  this before the desk commits, and confirmBooking commits exactly it. */
export type ConfirmPlan =
  | ConfirmRefusal
  | {
      ok: true
      blockedStartMs: number
      blockedEndMs: number
      exposureMinor: number
      needsCredentials: boolean
      overrideNote: string | null
      plan: { lineId: string; assetId: string; assetCode: string; upgrade: boolean }[]
      bulkPlan: { lineId: string; productId: string; qty: number }[]
    }

export function planConfirm(
  db: SqlDriver,
  bookingId: string,
  opts: ConfirmOptions,
  nowMs: number,
): ConfirmPlan {
  const b = loadBooking(db, bookingId)
  if (!b) return { ok: false, reason: 'not_found' }
  if (b.status === 'cancelled') return { ok: false, reason: 'cancelled' }
  if (b.status === 'confirmed') return { ok: false, reason: 'already_confirmed' }

  // Blacklist is refusal, not paperwork (0017 rule).
  const customer = db.get<{ blacklisted: number; credentials_verified: number }>(
    `select blacklisted, credentials_verified from customers where id = ?`, [b.customerId],
  )
  if (customer && Number(customer.blacklisted) === 1) return { ok: false, reason: 'blacklisted' }

  const lines = loadLines(db, bookingId)
  const settings = bookingSettings(db)
  const exposureMinor = exposureOf(db, lines)
  // D9: needs credentials when the exposure crosses the threshold AND the
  // customer is not known-verified. The phone's knowledge of "verified" is
  // one local flag — the result says so.
  const needsCredentials =
    exposureMinor >= settings.valueThresholdMinor
    && Number(customer?.credentials_verified ?? 0) !== 1
  const overrideNote = opts.credentialOverrideNote?.trim() || null
  if (needsCredentials && !overrideNote) {
    return {
      ok: false, reason: 'needs_credentials', exposureMinor,
      thresholdMinor: settings.valueThresholdMinor, gate: 'local_flag',
    }
  }

  const blockedStartMs = opts.blockedPeriod?.startMs ?? b.blockedStartMs
  const blockedEndMs = opts.blockedPeriod?.endMs ?? b.blockedEndMs
  if (!(blockedEndMs > blockedStartMs)
      || blockedStartMs > b.customerStartMs || blockedEndMs < b.customerEndMs) {
    return { ok: false, reason: 'blocked_period_uncovers_customer' }
  }

  // Units demanded BY NAME are spoken for before the auto-pick runs.
  const picked = new Set(lines.filter((l) => l.assetId).map((l) => l.assetId as string))
  const plan: { lineId: string; assetId: string; assetCode: string; upgrade: boolean }[] = []
  const bulkPlan: { lineId: string; productId: string; qty: number }[] = []

  for (const l of lines) {
    if (l.assetId) {
      const collision = winnerOnAsset(db, l.assetId, blockedStartMs, blockedEndMs, bookingId)
      if (collision) return { ok: false, collision }
      const code = db.get<{ asset_code: string | null }>(`select asset_code from assets where id = ?`, [l.assetId])
      plan.push({ lineId: l.id, assetId: l.assetId, assetCode: code?.asset_code ?? l.assetId, upgrade: true })
    } else if (l.productId && l.trackingMode === 'bulk') {
      const avail = bookingAvailability(db, l.productId, blockedStartMs, blockedEndMs, nowMs)
      // Our own pencil claim must not count against us: the server's peak
      // excludes this booking, and a pencil is never in the confirmed
      // layer anyway, so hereNow − confirmedOverlap is the right number.
      if (avail.available < l.qty) {
        const winner = db.all<{ id: string; booking_no: number; customer_name: string | null; blocked_from: string; blocked_until: string }>(
          `select b.id, b.booking_no, b.customer_name, r.blocked_from, r.blocked_until
             from stock_reservations r join bookings b on b.id = r.booking_id
            where r.product_id = ? and r.state = 'confirmed' and b.status = 'confirmed'
              and r.booking_id <> ?
            order by b.booking_no`,
          [l.productId, bookingId],
        ).find((r) => overlaps(msOf(r.blocked_from), msOf(r.blocked_until), blockedStartMs, blockedEndMs))
        const name = db.get<{ display_name: string | null }>(`select display_name from products where id = ?`, [l.productId])
        return {
          ok: false, reason: 'short',
          short: {
            productId: l.productId, productName: name?.display_name ?? '',
            wanted: l.qty, available: avail.available,
            winner: winner
              ? { bookingId: winner.id, bookingNo: Number(winner.booking_no), customerName: winner.customer_name ?? '' }
              : null,
          },
        }
      }
      bulkPlan.push({ lineId: l.id, productId: l.productId, qty: l.qty })
    } else if (l.productId) {
      // D4: least-utilised first — rental_days_since_service, then
      // cycle_count, then code — among fleet units with no confirmed
      // claim over the window.
      const candidates = db.all<{ id: string; asset_code: string | null }>(
        `select a.id, a.asset_code from assets a
          where a.product_id = ? and a.disposition is null
            and coalesce(a.rentable, 1) = 1 and a.presence <> 'gone'
          order by coalesce(a.rental_days_since_service, 0), coalesce(a.cycle_count, 0),
                   a.asset_code, a.id`,
        [l.productId],
      )
      let needed = l.qty
      for (const c of candidates) {
        if (needed === 0) break
        if (picked.has(c.id)) continue
        if (winnerOnAsset(db, c.id, blockedStartMs, blockedEndMs, bookingId)) continue
        picked.add(c.id)
        plan.push({ lineId: l.id, assetId: c.id, assetCode: c.asset_code ?? c.id, upgrade: false })
        needed--
      }
      if (needed > 0) {
        const name = db.get<{ display_name: string | null }>(`select display_name from products where id = ?`, [l.productId])
        return {
          ok: false, reason: 'short',
          short: {
            productId: l.productId, productName: name?.display_name ?? '',
            wanted: l.qty, available: l.qty - needed, winner: null,
          },
        }
      }
    }
  }

  return {
    ok: true, blockedStartMs, blockedEndMs, exposureMinor, needsCredentials, overrideNote, plan, bulkPlan,
  }
}

export function confirmBooking(
  db: SqlDriver,
  orgId: string,
  bookingId: string,
  opts: ConfirmOptions,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): ConfirmBookingResult {
  pruneExpiredPencils(db, nowMs)

  const planned = planConfirm(db, bookingId, opts, nowMs)
  if (!planned.ok) return planned
  const b = loadBooking(db, bookingId) as Booking
  const { blockedStartMs, blockedEndMs, exposureMinor, needsCredentials, overrideNote, plan, bulkPlan } = planned

  db.transaction(() => {
    for (const p of plan) {
      if (p.upgrade) {
        db.exec(
          `update asset_reservations set state = 'confirmed', blocked_from = ?, blocked_until = ?
            where booking_id = ? and booking_line_id = ?`,
          [iso(blockedStartMs), iso(blockedEndMs), bookingId, p.lineId],
        )
        const upgraded = db.get<{ n: number }>(
          `select count(*) as n from asset_reservations where booking_id = ? and booking_line_id = ?`,
          [bookingId, p.lineId],
        )
        if (Number(upgraded?.n ?? 0) > 0) continue
      }
      db.exec(
        `insert into asset_reservations (id, org_id, booking_id, booking_line_id, asset_id,
           blocked_from, blocked_until, state) values (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
        [`ar-${ids.newId()}`, orgId, bookingId, p.lineId, p.assetId, iso(blockedStartMs), iso(blockedEndMs)],
      )
    }
    for (const s of bulkPlan) {
      db.exec(
        `update stock_reservations set state = 'confirmed', blocked_from = ?, blocked_until = ?
          where booking_id = ? and booking_line_id = ?`,
        [iso(blockedStartMs), iso(blockedEndMs), bookingId, s.lineId],
      )
      const upgraded = db.get<{ n: number }>(
        `select count(*) as n from stock_reservations where booking_id = ? and booking_line_id = ?`,
        [bookingId, s.lineId],
      )
      if (Number(upgraded?.n ?? 0) > 0) continue
      db.exec(
        `insert into stock_reservations (id, org_id, booking_id, booking_line_id, product_id, qty,
           blocked_from, blocked_until, state) values (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
        [`sr-${ids.newId()}`, orgId, bookingId, s.lineId, s.productId, s.qty, iso(blockedStartMs), iso(blockedEndMs)],
      )
    }
    db.exec(
      `update bookings set status = 'confirmed', blocked_from = ?, blocked_until = ?,
              pencil_expires_at = null, updated_at = ? where id = ?`,
      [iso(blockedStartMs), iso(blockedEndMs), iso(nowMs), bookingId],
    )
    enqueueBookingOp(db, ids, 'confirm_booking', bookingId, {
      p_booking_id: bookingId,
      p_blocked_period: opts.blockedPeriod ? tstzrange(blockedStartMs, blockedEndMs) : null,
      p_credential_override_note: needsCredentials ? overrideNote : null,
    })
  })

  return {
    ok: true,
    bookingId,
    bookingNo: b.bookingNo,
    blockedStartMs,
    blockedEndMs,
    exposureMinor,
    allocations: plan.map((p) => ({ lineId: p.lineId, assetId: p.assetId, assetCode: p.assetCode })),
    credentialGate: needsCredentials ? 'overridden' : 'not_needed',
  }
}

// ------------------------------------------------------------ reallocate

export type ReallocateResult =
  | { ok: true; reservationId: string; assetId: string; assetCode: string }
  | { ok: false; reason: 'not_found' | 'unknown_asset' | 'not_rentable' | 'different_product' | 'not_confirmed' | 'already_held' }
  | { ok: false; collision: Collision }

/**
 * Override 3, the substitute door (0022 reallocate_reservation): move one
 * confirmed claim onto another unit of the SAME product, re-checked against
 * every other confirmed claim over the reservation's own window. A
 * collision names the winner, exactly as confirm does. Queued as the
 * server's op, chained after the reservation's booking so the replay sees
 * the confirm before the move.
 */
export function reallocateReservation(
  db: SqlDriver,
  reservationId: string,
  newAssetId: string,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
  /** The booking whose extension this move serves, if any — the op is
   *  chained under it too, so that booking's extend replays after it. */
  forBookingId: string | null = null,
): ReallocateResult {
  const r = db.get<{
    id: string; booking_id: string; asset_id: string; blocked_from: string; blocked_until: string; state: string
  }>(
    `select id, booking_id, asset_id, blocked_from, blocked_until, state
       from asset_reservations where id = ?`,
    [reservationId],
  )
  if (!r) return { ok: false, reason: 'not_found' }
  if (r.state !== 'confirmed') return { ok: false, reason: 'not_confirmed' }
  const oldProduct = db.get<{ product_id: string | null }>(
    `select product_id from assets where id = ?`, [r.asset_id],
  )?.product_id ?? null
  const a = db.get<{ id: string; asset_code: string | null; product_id: string | null; disposition: string | null; rentable: number | null; presence: string }>(
    `select id, asset_code, product_id, disposition, rentable, presence from assets where id = ?`,
    [newAssetId],
  )
  if (!a) return { ok: false, reason: 'unknown_asset' }
  if (a.product_id !== oldProduct) return { ok: false, reason: 'different_product' }
  if (a.disposition !== null || (a.rentable ?? 1) === 0 || a.presence === 'gone') {
    return { ok: false, reason: 'not_rentable' }
  }
  const from = msOf(r.blocked_from)
  const until = msOf(r.blocked_until)
  const collision = winnerOnAsset(db, a.id, from, until, r.booking_id)
  if (collision) return { ok: false, collision }
  // The booking's OWN other claim on that unit: the server's constraint
  // would refuse it too (one unit, two overlapping confirmed claims), and
  // "give them the body they already have" is not a substitution.
  if (heldBySameBooking(db, r.booking_id, a.id, r.id)) return { ok: false, reason: 'already_held' }

  db.transaction(() => {
    db.exec(`update asset_reservations set asset_id = ? where id = ?`, [a.id, r.id])
    db.exec(`update bookings set updated_at = ? where id = ?`, [iso(nowMs), r.booking_id])
    const payload: Record<string, unknown> = {
      client_booking_id: r.booking_id,
      p_reservation_id: r.id,
      p_new_asset_id: a.id,
    }
    if (forBookingId) payload.for_booking_id = forBookingId
    enqueueBookingOp(db, ids, 'reallocate_reservation', r.booking_id, payload)
  })
  return { ok: true, reservationId: r.id, assetId: a.id, assetCode: a.asset_code ?? a.id }
}

/** Whether a booking already holds a unit through another of its own
 *  confirmed claims. */
function heldBySameBooking(db: SqlDriver, bookingId: string, assetId: string, exceptReservationId: string): boolean {
  return !!db.get(
    `select 1 as one from asset_reservations
      where booking_id = ? and asset_id = ? and id <> ? and state = 'confirmed' limit 1`,
    [bookingId, assetId, exceptReservationId],
  )
}

export interface ReservationSubstitute {
  id: string
  code: string
  name: string
  /** Always true here — the RPC only takes the same product — kept so the
   *  swap sheet's row shape is reused unchanged. */
  sameProduct: boolean
}

/** Same-product units free over a reservation's window — what the
 *  substitute door can offer. Least-utilised first, the confirm order. */
export function substitutesForReservation(
  db: SqlDriver,
  reservationId: string,
): ReservationSubstitute[] {
  const r = db.get<{ booking_id: string; asset_id: string; blocked_from: string; blocked_until: string }>(
    `select booking_id, asset_id, blocked_from, blocked_until from asset_reservations where id = ?`,
    [reservationId],
  )
  if (!r) return []
  const product = db.get<{ product_id: string | null; name: string | null }>(
    `select a.product_id, coalesce(p.display_name, a.display_name) as name
       from assets a left join products p on p.id = a.product_id where a.id = ?`,
    [r.asset_id],
  )
  if (!product?.product_id) return []
  const from = msOf(r.blocked_from)
  const until = msOf(r.blocked_until)
  return db
    .all<{ id: string; asset_code: string | null }>(
      `select a.id, a.asset_code from assets a
        where a.product_id = ? and a.id <> ? and a.disposition is null
          and coalesce(a.rentable, 1) = 1 and a.presence <> 'gone'
        order by coalesce(a.rental_days_since_service, 0), coalesce(a.cycle_count, 0),
                 a.asset_code, a.id`,
      [product.product_id, r.asset_id],
    )
    .filter((a) => !winnerOnAsset(db, a.id, from, until, r.booking_id))
    .filter((a) => !heldBySameBooking(db, r.booking_id, a.id, reservationId))
    .map((a) => ({ id: a.id, code: a.asset_code ?? a.id, name: product.name ?? '', sameProduct: true }))
}

// ------------------------------------------------------------- cancel

export type CancelBookingResult =
  | { ok: true; bookingId: string; bookingNo: number }
  | { ok: false; reason: 'not_found' | 'already_cancelled' }
  | { ok: false; reason: 'job_open'; jobId: string; jobLabel: string }

/** Releases every claim. Refused while a live job carries the gear — the
 *  scan world owns that story (0022 cancel_booking). */
export function cancelBooking(
  db: SqlDriver,
  bookingId: string,
  reason: string | null,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): CancelBookingResult {
  pruneExpiredPencils(db, nowMs)
  const b = loadBooking(db, bookingId)
  if (!b) return { ok: false, reason: 'not_found' }
  if (b.status === 'cancelled') return { ok: false, reason: 'already_cancelled' }
  const job = db.get<{ id: string; label: string | null }>(
    `select id, label from jobs where booking_id = ? and status = 'open' limit 1`, [bookingId],
  )
  if (job) return { ok: false, reason: 'job_open', jobId: job.id, jobLabel: job.label ?? '' }

  const cleaned = reason?.trim() || null
  db.transaction(() => {
    db.exec(`delete from asset_reservations where booking_id = ?`, [bookingId])
    db.exec(`delete from stock_reservations where booking_id = ?`, [bookingId])
    db.exec(
      `update bookings set status = 'cancelled', cancel_reason = ?, pencil_expires_at = null,
              updated_at = ? where id = ?`,
      [cleaned, iso(nowMs), bookingId],
    )
    enqueueBookingOp(db, ids, 'cancel_booking', bookingId, {
      p_booking_id: bookingId,
      p_reason: cleaned,
    })
  })
  return { ok: true, bookingId, bookingNo: b.bookingNo }
}

// ------------------------------------------------------------- extend

export type ExtendBookingResult =
  | {
      extended: true
      bookingId: string
      bookingNo: number
      customerEndMs: number
      blockedEndMs: number
      collisions: []
    }
  | { extended: false; bookingId: string; bookingNo: number; collisions: ExtensionCollision[] }
  | { extended: false; reason: 'not_found' | 'cancelled' | 'ends_before_start'; collisions: [] }

/** The preview the extension screen renders: what a new end would break,
 *  and the window it would hold. Pure — nothing changes. */
export function extensionPreview(
  db: SqlDriver,
  bookingId: string,
  newCustomerEndMs: number,
  nowMs: number,
): { collisions: ExtensionCollision[]; customerEndMs: number; blockedEndMs: number } | null {
  const b = loadBooking(db, bookingId)
  if (!b) return null
  const win = extendedWindow(b, newCustomerEndMs)
  return { collisions: extensionCollisions(db, bookingId, newCustomerEndMs, nowMs), ...win }
}

/** The identity of one collision card — a booking and the unit or product
 *  it holds — so an acknowledged card can be matched to a live collision. */
export function collisionKey(c: ExtensionCollision): string {
  return c.kind === 'asset'
    ? `asset:${c.bookingId}:${c.assetId}`
    : `bulk:${c.bookingId}:${c.productId}`
}

export interface ExtendOptions {
  /**
   * Collisions the desk has covered by a sub-rent intent (noteSubRent):
   * the extension writes over them locally, and its op is chained after
   * the intent op so the server sees the sub-rent land first.
   * ASSUMPTION: a sub-rent intent is enough to hold the other client's
   * promise open. See docs/assumptions.md#sub-rent-intent
   */
  acknowledged?: ExtensionCollision[]
}

/** D10: the collision list as data, or the extension. The buffer tail the
 *  booking actually has is preserved (a confirm-time shortening survives). */
export function extendBooking(
  db: SqlDriver,
  bookingId: string,
  newCustomerEndMs: number,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
  opts: ExtendOptions = {},
): ExtendBookingResult {
  pruneExpiredPencils(db, nowMs)
  const b = loadBooking(db, bookingId)
  if (!b) return { extended: false, reason: 'not_found', collisions: [] }
  if (b.status === 'cancelled') return { extended: false, reason: 'cancelled', collisions: [] }
  if (newCustomerEndMs <= b.customerStartMs) {
    return { extended: false, reason: 'ends_before_start', collisions: [] }
  }

  const collisions = extensionCollisions(db, bookingId, newCustomerEndMs, nowMs)
  const covered = new Set((opts.acknowledged ?? []).map(collisionKey))
  const standing = collisions.filter((c) => !covered.has(collisionKey(c)))
  if (standing.length > 0) {
    return { extended: false, bookingId, bookingNo: b.bookingNo, collisions: standing }
  }

  const win = extendedWindow(b, newCustomerEndMs)
  db.transaction(() => {
    db.exec(`update asset_reservations set blocked_until = ? where booking_id = ?`,
      [iso(win.blockedEndMs), bookingId])
    db.exec(`update stock_reservations set blocked_until = ? where booking_id = ?`,
      [iso(win.blockedEndMs), bookingId])
    db.exec(
      `update bookings set customer_until = ?, blocked_until = ?, updated_at = ? where id = ?`,
      [iso(win.customerEndMs), iso(win.blockedEndMs), iso(nowMs), bookingId],
    )
    enqueueBookingOp(db, ids, 'extend_booking', bookingId, {
      p_booking_id: bookingId,
      p_new_customer_end: iso(newCustomerEndMs),
    })
  })
  return {
    extended: true, bookingId, bookingNo: b.bookingNo,
    customerEndMs: win.customerEndMs, blockedEndMs: win.blockedEndMs, collisions: [],
  }
}

export interface SubRentIntent {
  /** The product to sub-rent, by name for the note and by id for the pipe. */
  productId: string | null
  productName: string
  qty: number
  /** The booking the sub-rented unit will serve. */
  forBookingId: string
  forBookingNo: number
}

/**
 * The sub-rent door records INTENT: a line on the extending booking's note
 * ('Sub-rent FX9 ×1 for #5') and a `set_booking_note` op (0028, appending
 * that line to the server's note) chained under it, so the extension
 * queued next replays only after the intent is on the server's booking.
 * Nothing on the calendar moves — the other client's claim stands until a
 * real unit covers it (a sub-hire IN tagged to the booking chains behind
 * this op too, network.ts). Was the year's wall
 * `sub-rent-intent-unreplayable`: the old `sub_rent_intent` op had no RPC
 * and would have parked the extension with it.
 */
export function noteSubRent(
  db: SqlDriver,
  bookingId: string,
  intent: SubRentIntent,
  str: StrTable,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): { ok: true; note: string } | { ok: false; reason: 'not_found' } {
  const b = loadBooking(db, bookingId)
  if (!b) return { ok: false, reason: 'not_found' }
  const line = str.bookingSubRentNote(intent.productName, intent.qty, intent.forBookingNo)
  const note = b.note ? `${b.note}\n${line}` : line
  db.transaction(() => {
    db.exec(`update bookings set note = ?, updated_at = ? where id = ?`, [note, iso(nowMs), bookingId])
    enqueueBookingOp(db, ids, 'set_booking_note', bookingId, {
      p_booking_id: bookingId,
      p_note: line,
      p_append: true,
      // Not RPC arguments (the dispatcher sends only `p_*`): the intent's
      // facts, kept on the op so the queue can still say what was meant.
      for_booking_id: intent.forBookingId,
      product_id: intent.productId,
      qty: intent.qty,
    })
  })
  return { ok: true, note }
}

// ------------------------------------------------------ convert to job

export type ConvertBookingResult =
  | { ok: true; jobId: string; bookingNo: number; expected: number }
  | { ok: false; reason: 'not_found' | 'not_confirmed' | 'already_has_job' }

/**
 * The bridge (D8): a confirmed booking becomes the job the scan world runs,
 * through the SAME createJob path the desk's walk-in uses — label, customer
 * and expected_back from the booking's own facts, and the promised set
 * being the units confirm actually bound, not a fresh first-N pick.
 */
export function convertBookingToJob(
  db: SqlDriver,
  orgId: string,
  bookingId: string,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): ConvertBookingResult {
  pruneExpiredPencils(db, nowMs)
  const b = loadBooking(db, bookingId)
  if (!b) return { ok: false, reason: 'not_found' }
  if (b.status !== 'confirmed') return { ok: false, reason: 'not_confirmed' }
  if (db.get(`select 1 as one from jobs where booking_id = ?`, [bookingId])) {
    return { ok: false, reason: 'already_has_job' }
  }
  const customer = db.get<{ phone: string | null }>(
    `select phone from customers where id = ?`, [b.customerId],
  )
  const bound = loadAssetReservations(db, bookingId)
    .filter((r) => r.state === 'confirmed')
    .map((r) => r.assetId)
  const jobId = `job-${ids.newId()}`

  const result = db.transaction(() => {
    const r = createJob(db, {
      id: jobId,
      orgId,
      label: `B#${b.bookingNo} — ${b.customerName}`,
      contact: customer?.phone ?? null,
      expectedBack: isoDate(b.customerEndMs),
      customerId: b.customerId,
      wants: [],
      expectedAssetIds: bound,
    })
    db.exec(`update jobs set booking_id = ? where id = ?`, [bookingId, jobId])
    enqueueBookingOp(db, ids, 'convert_booking_to_job', bookingId, {
      p_booking_id: bookingId,
      client_job_id: jobId,
    })
    return r
  })
  return { ok: true, jobId, bookingNo: b.bookingNo, expected: result.expected.length }
}

// ------------------------------------------------- the confirmation text

/**
 * The WhatsApp confirmation the desk sends the client — plain text, both
 * tables, golden-tested. Only a CONFIRMED booking has one: a pencil is a
 * conversation, and sending "confirmed" for it would be the double-promise
 * the whole phase exists to end.
 */
export function bookingConfirmText(
  db: SqlDriver,
  str: StrTable,
  houseName: string,
  bookingId: string,
  nowMs: number,
): string | null {
  const v = bookingView(db, bookingId, nowMs)
  if (!v || v.status !== 'confirmed') return null
  const out: string[] = [
    str.bookingConfirmTitle(houseName),
    str.bookingConfirmNo(v.bookingNo),
    str.bookingConfirmFor(v.customerName),
    str.bookingConfirmWindow(bookingDateLabel(v.customerStartMs), bookingDateLabel(v.customerEndMs)),
    '',
    str.bookingConfirmItems,
  ]
  for (const l of v.lines) {
    const name = l.assetCode ? `${l.productName} ${l.assetCode}` : l.productName
    out.push(str.bookingConfirmLine(l.qty, name))
  }
  if (v.note) out.push('', str.bookingConfirmNote(v.note))
  out.push('', str.bookingConfirmFooter)
  return out.join('\n')
}
