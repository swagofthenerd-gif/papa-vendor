import type { SqlDriver } from './db/driver.ts'

/**
 * Bookings — the promise calendar's rules, on the phone (migration 0022,
 * PLAN.md phase 2; vendor-dream-plan Phase C).
 *
 * WHAT THIS FILE IS. The pure, importable half of the booking world: the
 * types the mirror tables carry, THE one definition of a live pencil, the
 * three-layer availability answer, the extension-collision list, the
 * scanner's "promised soon" warning, and two calendar rules (season and
 * the overdue ladder). Every function here is a pure function of (the
 * local mirror, an injected clock) — no network, no `Date.now()` inside
 * the logic, the CONTRIBUTING hard rule for anything time-derived.
 *
 * THE SEMANTICS ARE 0022's, VERBATIM. Each function names the server
 * decision it mirrors (D3, D6, D7, D10) and copies its predicates rather
 * than re-deriving them, because the whole point is that the phone's
 * optimistic view and the server's truth AGREE: a desk that sees "2
 * available" offline must not be told "1" once the pipe connects.
 *
 *   * ranges are '[)' — back-to-back bookings (one ends 10:00, the next
 *     begins 10:00) touch without colliding (D3);
 *   * a pencil is a conversation, never a promise: it is reported, it is
 *     never subtracted (D6);
 *   * a live pencil is status = 'pencil' AND pencil_expires_at > now —
 *     a predicate over a stored timestamp, never a cron (D7);
 *   * bulk capacity is a PEAK over the window, not a sum (D6).
 *
 * The write side (create / confirm / cancel / extend / convert, the
 * outbox ops that replay them server-side) lives in the app's read-model
 * module beside the demo tables it also needs; this file owns the rules
 * both sides read.
 */

export type BookingStatus = 'draft' | 'pencil' | 'confirmed' | 'cancelled'
export type TrackingMode = 'serialized' | 'bulk'
export type ReservationState = 'pencil' | 'confirmed'

export interface Booking {
  id: string
  orgId: string
  bookingNo: number
  customerId: string
  /** Denormalised onto the sync projection — the phone never carries the
   *  customers table (PII guard, 0009/0015), but a promise without a name
   *  is not a promise anyone can act on. */
  customerName: string
  status: BookingStatus
  /** What the client agreed to (override 7). */
  customerStartMs: number
  customerEndMs: number
  /** What the fleet is actually held for: customer ± buffers (override 7).
   *  The exclusion constraint and every availability answer run on THIS. */
  blockedStartMs: number
  blockedEndMs: number
  pencilExpiresAtMs: number | null
  note: string | null
  cancelReason: string | null
}

export interface BookingLine {
  id: string
  bookingId: string
  /** "N of this product" — allocation happens at confirm (override 3)… */
  productId: string | null
  /** …or "THIS unit", when the client demands a particular serial. */
  assetId: string | null
  qty: number
  trackingMode: TrackingMode
}

export interface AssetReservation {
  id: string
  bookingId: string
  bookingLineId: string
  assetId: string
  blockedStartMs: number
  blockedEndMs: number
  state: ReservationState
}

export interface StockReservation {
  id: string
  bookingId: string
  bookingLineId: string
  productId: string
  qty: number
  blockedStartMs: number
  blockedEndMs: number
  state: ReservationState
}

/**
 * The org's booking knobs. ONE home for the defaults: every caller that
 * needs a buffer or a TTL reads them from a settings object built here,
 * never from a literal at the call site.
 */
export interface BookingSettings {
  /** ASSUMPTION: 2h before. See docs/assumptions.md#buffer-defaults */
  prepBufferHours: number
  /** ASSUMPTION: 4h after. See docs/assumptions.md#buffer-defaults */
  turnaroundBufferHours: number
  /** ASSUMPTION: 24h. See docs/assumptions.md#hold-ttl */
  pencilTtlHours: number
  /** The credential gate's exposure threshold, minor units (0017:
   *  new_customer_value_threshold_minor; ASSUMPTION Rs 100,000). */
  valueThresholdMinor: number
}

export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  prepBufferHours: 2,
  turnaroundBufferHours: 4,
  pencilTtlHours: 24,
  valueThresholdMinor: 10_000_000,
}

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

/** The blocked window a customer window implies under these settings
 *  (0022 create_booking, override 7). */
export function blockedPeriod(
  customerStartMs: number,
  customerEndMs: number,
  settings: BookingSettings,
): { blockedStartMs: number; blockedEndMs: number } {
  return {
    blockedStartMs: customerStartMs - settings.prepBufferHours * HOUR_MS,
    blockedEndMs: customerEndMs + settings.turnaroundBufferHours * HOUR_MS,
  }
}

// ------------------------------------------------------------ the pencil

/**
 * THE definition of a live pencil (0022 D7), stated once: status = pencil
 * AND it has not yet expired. Every list, count and availability layer
 * that says "pencilled" calls this. Expiry is a predicate over a stored
 * timestamp — an offline phone reaches the same verdict the server does.
 */
export function isLivePencil(
  b: { status: BookingStatus; pencilExpiresAtMs: number | null },
  nowMs: number,
): boolean {
  return b.status === 'pencil'
    && b.pencilExpiresAtMs !== null
    && b.pencilExpiresAtMs > nowMs
}

export interface PencilCountdown {
  expired: boolean
  /** Never negative — an expired pencil reads 0 left, not −3h. */
  msLeft: number
  /** Label-ready parts: whole hours, then the remaining minutes. */
  hours: number
  minutes: number
}

/** How long a pencil has left, for the countdown chip. A booking that is
 *  not a pencil (or has no expiry) counts as expired: nothing to count. */
export function pencilCountdown(
  b: { status: BookingStatus; pencilExpiresAtMs: number | null },
  nowMs: number,
): PencilCountdown {
  if (!isLivePencil(b, nowMs)) return { expired: true, msLeft: 0, hours: 0, minutes: 0 }
  const msLeft = (b.pencilExpiresAtMs as number) - nowMs
  const totalMinutes = Math.floor(msLeft / 60_000)
  return {
    expired: false,
    msLeft,
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  }
}

// --------------------------------------------------------- interval math

/** '[)' overlap (0022 D3): two windows collide only when each starts
 *  before the other ends. Equal end/start touch legally. */
export function overlaps(
  aStartMs: number, aEndMs: number,
  bStartMs: number, bEndMs: number,
): boolean {
  return aStartMs < bEndMs && bStartMs < aEndMs
}

export interface WeightedInterval {
  startMs: number
  endMs: number
  qty: number
}

/**
 * The max simultaneous quantity over a window — THE peak helper (0022
 * stock_reserved_peak). A sweep line: clamp each interval to the window,
 * drop the empties, then walk the endpoints in time order with ends
 * before starts at the same instant (so '[)' neighbours never stack).
 * Used for both the pencil and the confirmed layer of bulk availability,
 * and for the bulk half of the extension check — one definition.
 */
export function peakOverlap(
  intervals: WeightedInterval[],
  windowStartMs: number,
  windowEndMs: number,
): number {
  const events: { at: number; delta: number }[] = []
  for (const iv of intervals) {
    const start = Math.max(iv.startMs, windowStartMs)
    const end = Math.min(iv.endMs, windowEndMs)
    if (start >= end || iv.qty <= 0) continue
    events.push({ at: start, delta: iv.qty }, { at: end, delta: -iv.qty })
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let running = 0
  let peak = 0
  for (const e of events) {
    running += e.delta
    if (running > peak) peak = running
  }
  return peak
}

// ------------------------------------------------------- mirror readers

interface BookingRow {
  id: string
  org_id: string
  booking_no: number
  customer_id: string
  customer_name: string | null
  status: string
  customer_from: string
  customer_until: string
  blocked_from: string
  blocked_until: string
  pencil_expires_at: string | null
  note: string | null
  cancel_reason: string | null
}

/** Epoch ms from a mirrored ISO timestamp; NaN-proof (a malformed value
 *  reads as 0 rather than poisoning every comparison downstream). */
export function msOf(iso: string | null | undefined): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

const BOOKING_COLUMNS = `id, org_id, booking_no, customer_id, customer_name, status,
  customer_from, customer_until, blocked_from, blocked_until,
  pencil_expires_at, note, cancel_reason`

function bookingOf(r: BookingRow): Booking {
  return {
    id: r.id,
    orgId: r.org_id,
    bookingNo: Number(r.booking_no),
    customerId: r.customer_id,
    customerName: r.customer_name ?? '',
    status: r.status as BookingStatus,
    customerStartMs: msOf(r.customer_from),
    customerEndMs: msOf(r.customer_until),
    blockedStartMs: msOf(r.blocked_from),
    blockedEndMs: msOf(r.blocked_until),
    pencilExpiresAtMs: r.pencil_expires_at ? msOf(r.pencil_expires_at) : null,
    note: r.note,
    cancelReason: r.cancel_reason,
  }
}

export function loadBooking(db: SqlDriver, bookingId: string): Booking | null {
  const r = db.get<BookingRow>(`select ${BOOKING_COLUMNS} from bookings where id = ?`, [bookingId])
  return r ? bookingOf(r) : null
}

/** Every mirrored booking, oldest number first — the caller filters. */
export function loadBookings(db: SqlDriver): Booking[] {
  return db
    .all<BookingRow>(`select ${BOOKING_COLUMNS} from bookings order by booking_no`)
    .map(bookingOf)
}

export function loadLines(db: SqlDriver, bookingId: string): BookingLine[] {
  return db
    .all<{
      id: string; booking_id: string; product_id: string | null
      asset_id: string | null; qty: number; tracking_mode: string | null
    }>(
      // A demanded unit's tracking mode is its product's — always
      // serialized, since only serialized gear has units to demand.
      `select l.id, l.booking_id, l.product_id, l.asset_id, l.qty,
              coalesce(p.tracking_mode, pa.tracking_mode, 'serialized') as tracking_mode
         from booking_lines l
         left join products p on p.id = l.product_id
         left join assets a on a.id = l.asset_id
         left join products pa on pa.id = a.product_id
        where l.booking_id = ?
        order by l.rowid`,
      [bookingId],
    )
    .map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      productId: r.product_id,
      assetId: r.asset_id,
      qty: Number(r.qty),
      trackingMode: r.tracking_mode === 'bulk' ? 'bulk' : 'serialized',
    }))
}

export function loadAssetReservations(db: SqlDriver, bookingId: string): AssetReservation[] {
  return db
    .all<{
      id: string; booking_id: string; booking_line_id: string; asset_id: string
      blocked_from: string; blocked_until: string; state: string
    }>(
      `select id, booking_id, booking_line_id, asset_id, blocked_from, blocked_until, state
         from asset_reservations where booking_id = ? order by rowid`,
      [bookingId],
    )
    .map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      bookingLineId: r.booking_line_id,
      assetId: r.asset_id,
      blockedStartMs: msOf(r.blocked_from),
      blockedEndMs: msOf(r.blocked_until),
      state: r.state as ReservationState,
    }))
}

export function loadStockReservations(db: SqlDriver, bookingId: string): StockReservation[] {
  return db
    .all<{
      id: string; booking_id: string; booking_line_id: string; product_id: string
      qty: number; blocked_from: string; blocked_until: string; state: string
    }>(
      `select id, booking_id, booking_line_id, product_id, qty, blocked_from, blocked_until, state
         from stock_reservations where booking_id = ? order by rowid`,
      [bookingId],
    )
    .map((r) => ({
      id: r.id,
      bookingId: r.booking_id,
      bookingLineId: r.booking_line_id,
      productId: r.product_id,
      qty: Number(r.qty),
      blockedStartMs: msOf(r.blocked_from),
      blockedEndMs: msOf(r.blocked_until),
      state: r.state as ReservationState,
    }))
}

// ---------------------------------------------------------- availability

export interface BookingAvailability {
  trackingMode: TrackingMode
  /** Physically on the shelf and fit, today — the shelf count for bulk,
   *  the live rentable fleet for serialized (minus units out right now
   *  when the window starts now). */
  hereNow: number
  /** Max simultaneous UNEXPIRED pencil claim over the window. Reported,
   *  never subtracted: a pencil is a conversation. */
  pencilledOverlap: number
  /** Max simultaneous confirmed claim over the window. Subtracted — a
   *  promise holds. */
  confirmedOverlap: number
  /** hereNow − confirmedOverlap, floored at zero. */
  available: number
}

/**
 * Bulk shelf count: the movements ledger already subtracted what is out
 * (0022 stock_on_hand). Zero when nothing is mirrored — the honest floor.
 */
function stockOnHand(db: SqlDriver, productId: string): number {
  const r = db.get<{ n: number | null }>(
    `select sum(qty_on_hand) as n from stock_lots where product_id = ?`,
    [productId],
  )
  return Number(r?.n ?? 0)
}

/**
 * Peak reserved qty of a bulk product over a window, in one state,
 * optionally ignoring one booking (0022 stock_reserved_peak). A pencil
 * claim only counts while its booking is a live pencil; a confirmed
 * claim only while its booking is confirmed.
 */
function stockReservedPeak(
  db: SqlDriver,
  productId: string,
  startMs: number,
  endMs: number,
  state: ReservationState,
  nowMs: number,
  excludeBookingId: string | null = null,
): number {
  const rows = db.all<{
    qty: number; blocked_from: string; blocked_until: string
    status: string; pencil_expires_at: string | null; booking_id: string
  }>(
    `select r.qty, r.blocked_from, r.blocked_until, r.booking_id,
            b.status, b.pencil_expires_at
       from stock_reservations r
       join bookings b on b.id = r.booking_id
      where r.product_id = ? and r.state = ?`,
    [productId, state],
  )
  const live: WeightedInterval[] = []
  for (const r of rows) {
    if (excludeBookingId !== null && r.booking_id === excludeBookingId) continue
    const b = {
      status: r.status as BookingStatus,
      pencilExpiresAtMs: r.pencil_expires_at ? msOf(r.pencil_expires_at) : null,
    }
    if (state === 'pencil' && !isLivePencil(b, nowMs)) continue
    if (state === 'confirmed' && b.status !== 'confirmed') continue
    live.push({ startMs: msOf(r.blocked_from), endMs: msOf(r.blocked_until), qty: Number(r.qty) })
  }
  return peakOverlap(live, startMs, endMs)
}

/**
 * The three-layer answer (0022 D6, booking_availability), over the local
 * mirror. `startMs`/`endMs` are the window ASKED about — callers pass the
 * blocked window when they mean the fleet's hold, the customer window when
 * they mean the client's ask; this function does not widen either.
 */
export function bookingAvailability(
  db: SqlDriver,
  productId: string,
  startMs: number,
  endMs: number,
  nowMs: number,
): BookingAvailability {
  const product = db.get<{ tracking_mode: string | null }>(
    `select tracking_mode from products where id = ?`,
    [productId],
  )
  const trackingMode: TrackingMode = product?.tracking_mode === 'bulk' ? 'bulk' : 'serialized'

  if (trackingMode === 'bulk') {
    const hereNow = stockOnHand(db, productId)
    const pencilledOverlap = stockReservedPeak(db, productId, startMs, endMs, 'pencil', nowMs)
    const confirmedOverlap = stockReservedPeak(db, productId, startMs, endMs, 'confirmed', nowMs)
    return {
      trackingMode, hereNow, pencilledOverlap, confirmedOverlap,
      available: Math.max(hereNow - confirmedOverlap, 0),
    }
  }

  // Serialized: the live, rentable fleet — minus units physically out RIGHT
  // NOW when the window starts now: gear on a truck cannot make a pickup
  // that starts before it returns. A future window trusts the schedule
  // (the confirmed layer). Mirrors the server predicate exactly, health
  // included: it does not look at health, so neither does this.
  const startsNow = startMs <= nowMs ? 1 : 0
  const hereNow = Number(db.get<{ n: number }>(
    `select count(*) as n from assets
      where product_id = ? and disposition is null
        and coalesce(rentable, 1) = 1 and presence <> 'gone'
        and not (presence in ('out', 'in_transit') and ? = 1)`,
    [productId, startsNow],
  )?.n ?? 0)

  const confirmed = db.all<{ asset_id: string; blocked_from: string; blocked_until: string }>(
    `select r.asset_id, r.blocked_from, r.blocked_until
       from asset_reservations r
       join bookings b on b.id = r.booking_id
       join assets a on a.id = r.asset_id
      where a.product_id = ? and r.state = 'confirmed' and b.status = 'confirmed'`,
    [productId],
  )
  const confirmedUnits = new Set<string>()
  for (const r of confirmed) {
    if (overlaps(msOf(r.blocked_from), msOf(r.blocked_until), startMs, endMs)) {
      confirmedUnits.add(r.asset_id)
    }
  }

  // Pencils on serialized products live at the LINE level (allocation has
  // not happened yet), so the pencil layer counts asked-for qty.
  const pencils = db.all<{
    qty: number; blocked_from: string; blocked_until: string
    status: string; pencil_expires_at: string | null
  }>(
    `select l.qty, b.blocked_from, b.blocked_until, b.status, b.pencil_expires_at
       from booking_lines l
       join bookings b on b.id = l.booking_id
       left join assets a on a.id = l.asset_id
      where b.status = 'pencil'
        and (l.product_id = ? or a.product_id = ?)`,
    [productId, productId],
  )
  let pencilledOverlap = 0
  for (const p of pencils) {
    const b = {
      status: p.status as BookingStatus,
      pencilExpiresAtMs: p.pencil_expires_at ? msOf(p.pencil_expires_at) : null,
    }
    if (!isLivePencil(b, nowMs)) continue
    if (!overlaps(msOf(p.blocked_from), msOf(p.blocked_until), startMs, endMs)) continue
    pencilledOverlap += Number(p.qty)
  }

  const confirmedOverlap = confirmedUnits.size
  return {
    trackingMode, hereNow, pencilledOverlap, confirmedOverlap,
    available: Math.max(hereNow - confirmedOverlap, 0),
  }
}

// ---------------------------------------------------- extension collisions

export type ExtensionCollision =
  | {
      kind: 'asset'
      bookingId: string
      bookingNo: number
      customerName: string
      assetId: string
      assetCode: string
      productId: string | null
      productName: string
      theirFromMs: number
      theirUntilMs: number
    }
  | {
      kind: 'bulk'
      bookingId: string
      bookingNo: number
      customerName: string
      qty: number
      productId: string
      productName: string
      /** The shortfall this line would suffer under the new window —
       *  the two numbers the desk needs to sub-rent by. */
      wanted: number
      shortBy: number
      theirFromMs: number
      theirUntilMs: number
    }

/** The window an extension would hold the fleet for, preserving whatever
 *  buffer tail the booking actually has (a confirm-time shortening must
 *  survive the extension — 0022 extend_booking). */
export function extendedWindow(
  b: Booking,
  newCustomerEndMs: number,
): { customerEndMs: number; blockedEndMs: number } {
  const tail = b.blockedEndMs - b.customerEndMs
  return { customerEndMs: newCustomerEndMs, blockedEndMs: newCustomerEndMs + tail }
}

/**
 * Which downstream CONFIRMED promises a new end time breaks (0022 D10) —
 * per asset, per bulk shortfall, with booking numbers and customer names.
 * Pure over the mirror; the write side returns this as data with
 * extended=false and changes nothing. A pencil or draft has no confirmed
 * claims to break, so it collides with nothing.
 */
export function extensionCollisions(
  db: SqlDriver,
  bookingId: string,
  newCustomerEndMs: number,
  nowMs: number,
): ExtensionCollision[] {
  const b = loadBooking(db, bookingId)
  if (!b || b.status !== 'confirmed') return []
  const win = extendedWindow(b, newCustomerEndMs)
  const newStart = b.blockedStartMs
  const newEnd = win.blockedEndMs
  const out: ExtensionCollision[] = []

  for (const mine of loadAssetReservations(db, bookingId)) {
    if (mine.state !== 'confirmed') continue
    const rivals = db.all<{
      booking_id: string; booking_no: number; customer_name: string | null
      asset_id: string; asset_code: string | null; product_id: string | null
      product_name: string | null; blocked_from: string; blocked_until: string
    }>(
      `select b2.id as booking_id, b2.booking_no, b2.customer_name,
              r2.asset_id, a2.asset_code, a2.product_id,
              coalesce(p2.display_name, a2.display_name) as product_name,
              r2.blocked_from, r2.blocked_until
         from asset_reservations r2
         join bookings b2 on b2.id = r2.booking_id
         join assets a2 on a2.id = r2.asset_id
         left join products p2 on p2.id = a2.product_id
        where r2.asset_id = ? and r2.state = 'confirmed'
          and r2.booking_id <> ? and b2.status = 'confirmed'
        order by b2.booking_no, a2.asset_code`,
      [mine.assetId, bookingId],
    )
    for (const r of rivals) {
      const from = msOf(r.blocked_from)
      const until = msOf(r.blocked_until)
      if (!overlaps(from, until, newStart, newEnd)) continue
      if (out.some((c) => c.kind === 'asset' && c.bookingId === r.booking_id && c.assetId === r.asset_id)) continue
      out.push({
        kind: 'asset',
        bookingId: r.booking_id,
        bookingNo: Number(r.booking_no),
        customerName: r.customer_name ?? '',
        assetId: r.asset_id,
        assetCode: r.asset_code ?? r.asset_id,
        productId: r.product_id,
        productName: r.product_name ?? '',
        theirFromMs: from,
        theirUntilMs: until,
      })
    }
  }

  for (const mine of loadStockReservations(db, bookingId)) {
    if (mine.state !== 'confirmed') continue
    const onHand = stockOnHand(db, mine.productId)
    const peak = stockReservedPeak(
      db, mine.productId, newStart, newEnd, 'confirmed', nowMs, bookingId,
    )
    if (onHand - peak >= mine.qty) continue
    const shortBy = mine.qty - (onHand - peak)
    const rivals = db.all<{
      booking_id: string; booking_no: number; customer_name: string | null
      qty: number; product_name: string | null; blocked_from: string; blocked_until: string
    }>(
      `select b2.id as booking_id, b2.booking_no, b2.customer_name, r2.qty,
              p2.display_name as product_name, r2.blocked_from, r2.blocked_until
         from stock_reservations r2
         join bookings b2 on b2.id = r2.booking_id
         left join products p2 on p2.id = r2.product_id
        where r2.product_id = ? and r2.state = 'confirmed'
          and r2.booking_id <> ? and b2.status = 'confirmed'
        order by b2.booking_no`,
      [mine.productId, bookingId],
    )
    for (const r of rivals) {
      const from = msOf(r.blocked_from)
      const until = msOf(r.blocked_until)
      if (!overlaps(from, until, newStart, newEnd)) continue
      out.push({
        kind: 'bulk',
        bookingId: r.booking_id,
        bookingNo: Number(r.booking_no),
        customerName: r.customer_name ?? '',
        qty: Number(r.qty),
        productId: mine.productId,
        productName: r.product_name ?? '',
        wanted: mine.qty,
        shortBy,
        theirFromMs: from,
        theirUntilMs: until,
      })
    }
  }

  return out
}

// --------------------------------------------------------- promised soon

export interface PromisedSoon {
  bookingId: string
  bookingNo: number
  customerName: string
  /** Until the hold begins; zero or negative when it already has. */
  startsInMs: number
  blockedStartMs: number
  blockedEndMs: number
}

/** The scanner's warning: this unit is CONFIRMED to a booking whose hold
 *  begins within the horizon (or has already begun and not ended). A
 *  pencil is a conversation — it never warns. Nearest hold first. */
export function promisedSoon(
  db: SqlDriver,
  assetId: string,
  nowMs: number,
  horizonMs: number = 48 * HOUR_MS,
): PromisedSoon | null {
  const rows = db.all<{
    booking_id: string; booking_no: number; customer_name: string | null
    blocked_from: string; blocked_until: string
  }>(
    `select b.id as booking_id, b.booking_no, b.customer_name,
            r.blocked_from, r.blocked_until
       from asset_reservations r
       join bookings b on b.id = r.booking_id
      where r.asset_id = ? and r.state = 'confirmed' and b.status = 'confirmed'`,
    [assetId],
  )
  let best: PromisedSoon | null = null
  for (const r of rows) {
    const from = msOf(r.blocked_from)
    const until = msOf(r.blocked_until)
    if (until <= nowMs) continue
    if (from > nowMs + horizonMs) continue
    if (best && from >= best.blockedStartMs) continue
    best = {
      bookingId: r.booking_id,
      bookingNo: Number(r.booking_no),
      customerName: r.customer_name ?? '',
      startsInMs: from - nowMs,
      blockedStartMs: from,
      blockedEndMs: until,
    }
  }
  return best
}

// ------------------------------------------------------------- calendar

/** The short day and month names every booking label is written in —
 *  the calendar's day cells and headings build from these same two lists. */
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** 'Thu 17 Sep, 10:00' — the one way a booking instant is written, on the
 *  calendar and in the WhatsApp confirmation alike. Local time: the desk
 *  and the client are in the same city. */
export function bookingDateLabel(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}, ${hh}:${mm}`
}

/** Local calendar midnight of an instant — the calendar's day key. */
export function dayStartMs(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export type Season = 'wedding' | 'normal'

/**
 * ASSUMPTION: December–February is wedding season in Lahore — the months
 * the calendar shades and the desk expects to be booked 4–6 months out
 * (vendor-dream-plan Phase C1). Local calendar month of the given instant.
 * See docs/assumptions.md#wedding-season
 */
export function seasonFor(dateMs: number): Season {
  const month = new Date(dateMs).getMonth()   // 0 = Jan
  return month === 11 || month === 0 || month === 1 ? 'wedding' : 'normal'
}

export type EscalationAction =
  | 'whatsapp_nudge'
  | 'call'
  | 'late_fee_draft'
  | 'manager_escalation'

export interface EscalationStep {
  step: 1 | 2 | 3 | 4
  /** The day this rung begins. */
  fromDay: number
  action: EscalationAction
  /** Day 14: the manager also weighs a blacklist — a decision, never an
   *  automatic flag. */
  considerBlacklist: boolean
}

/**
 * ASSUMPTION: the overdue escalation ladder — day 1 WhatsApp nudge, day 3
 * a call, day 7 the late-fee draft, day 14 manager escalation with a
 * blacklist consideration. PLAN.md override 19 sketches "1 day → tech,
 * 3 days → manager WhatsApp, 14 days → a missing claim"; this is the
 * desk-facing reading of it, with the day-7 money rung the khata already
 * drafts. Each step carries the action kind a screen maps to ONE button.
 * See docs/assumptions.md#escalation-ladder
 */
export const ESCALATION_LADDER: readonly EscalationStep[] = [
  { step: 1, fromDay: 1, action: 'whatsapp_nudge', considerBlacklist: false },
  { step: 2, fromDay: 3, action: 'call', considerBlacklist: false },
  { step: 3, fromDay: 7, action: 'late_fee_draft', considerBlacklist: false },
  { step: 4, fromDay: 14, action: 'manager_escalation', considerBlacklist: true },
]

/** The rung a job this many whole days late sits on; null before day 1. */
export function escalationStep(daysLate: number): EscalationStep | null {
  let current: EscalationStep | null = null
  for (const rung of ESCALATION_LADDER) {
    if (daysLate >= rung.fromDay) current = rung
  }
  return current
}
