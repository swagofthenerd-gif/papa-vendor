import {
  DEFAULT_TIMEZONE,
  Outbox,
  bookingDateLabel,
  formatRupees,
  liveExpenses,
  loadBooking,
  priceQuote,
  quoteText,
  type CalendarDayInput,
  type CalendarKind,
  type DepositHint,
  type Quote,
  type QuoteLineInput,
  type QuoteStatus,
  type QuoteStrings,
  type RateCardInfo,
  type RateCardKnobs,
  type SqlDriver,
} from '@papa/core'
import { defaultIds, enqueueBookingOp, type BookingIds } from './bookings.ts'
import { expenseRows } from './kharcha.ts'
import { paymentLine, quoteFlags, type QuoteFlags } from './khata.ts'
import type { StrTable } from '../strings.ts'

/**
 * The quote read model AND write side, on the phone — the bookings.ts
 * pattern: a plain .ts module, every query and every rule assertable
 * under plain Node against a real SQLite, with store.ts a thin wiring
 * layer.
 *
 * THE PIPELINE LIVES IN @papa/core (pricing.ts). This module only loads
 * its inputs from the mirror — the default card and its entries, the
 * calendar rows, the booking's lines with their logged overrides, the
 * live expenses tagged to the booking — and hands them over; it never
 * adds a rule of its own (principle 4: one home). An enquiry BEFORE a
 * booking exists is priced through the same function with status
 * 'enquiry', so the desk's first number and the booking page's number
 * are one computation.
 *
 * WRITES ARE THE 0024 RPCs, QUEUED. setRate / setRateCard /
 * setCalendarDay / clearCalendarDay / setLineOverride each update the
 * mirror optimistically and enqueue an op named after the server
 * function with a `p_*`-shaped payload, exactly as the booking writes
 * do. The override is chained behind the booking's own op so the server
 * sees the line before the number on it.
 */

const iso = (ms: number): string => new Date(ms).toISOString()

// ---------------------------------------------------------------- the card

export interface RateRow {
  productId: string
  productName: string
  /** null = UNPRICED — no entry on the card, never zero. */
  dayRateMinor: number | null
}

export interface RateCardView extends RateCardInfo {
  /** Every catalogue product, priced or not, name order. */
  rates: RateRow[]
}

interface CardRow {
  id: string; name: string; is_default: number
  week_equals_days: number; min_billable_days: number; weekend_mask: string | null
}

function parseMask(raw: string | null): number[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(Number).filter((n) => n >= 1 && n <= 7) : []
  } catch {
    return []
  }
}

function cardOf(r: CardRow): RateCardInfo {
  return {
    id: r.id,
    name: r.name,
    isDefault: Number(r.is_default) === 1,
    weekEqualsDays: Number(r.week_equals_days),
    minBillableDays: Number(r.min_billable_days),
    weekendMask: parseMask(r.weekend_mask),
  }
}

/** The org's default card (0024 D10), or null when none is mirrored. */
export function defaultCard(db: SqlDriver): RateCardInfo | null {
  const r = db.get<CardRow>(
    `select id, name, is_default, week_equals_days, min_billable_days, weekend_mask
       from rate_cards where is_default = 1 order by id limit 1`,
  )
  return r ? cardOf(r) : null
}

/** productId → day rate on one card. */
export function rateEntries(db: SqlDriver, cardId: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of db.all<{ product_id: string; day_rate_minor: number }>(
    `select product_id, day_rate_minor from rate_card_entries where rate_card_id = ?`, [cardId],
  )) out.set(r.product_id, Number(r.day_rate_minor))
  return out
}

/** The Settings → Rates page: the default card's knobs and every
 *  product's rate on it, unpriced ones included (they are the work). */
export function rateCard(db: SqlDriver): RateCardView | null {
  const card = defaultCard(db)
  if (!card) return null
  const entries = rateEntries(db, card.id)
  const rates = db
    .all<{ id: string; display_name: string | null }>(
      `select id, display_name from products
        where coalesce(tracking_mode, 'serialized') <> 'consumable'
        order by display_name`,
    )
    .map((p) => ({
      productId: p.id,
      productName: p.display_name ?? '',
      dayRateMinor: entries.get(p.id) ?? null,
    }))
  return { ...card, rates }
}

/** The most recent queued op for a card — what the next op for the same
 *  card depends on (the entries replay after the card that holds them). */
function lastCardOp(db: SqlDriver, cardId: string): string | null {
  const row = db.get<{ id: string }>(
    `select id from outbox
      where state in ('pending', 'inflight')
        and (payload like ? or payload like ?)
      order by seq desc limit 1`,
    [`%"client_card_id":"${cardId}"%`, `%"p_rate_card_id":"${cardId}"%`],
  )
  return row?.id ?? null
}

function enqueueCardOp(
  db: SqlDriver, ids: BookingIds, op: string, cardId: string, payload: Record<string, unknown>,
): string {
  const outbox = new Outbox(db, ids.now)
  const id = ids.newId()
  outbox.enqueue({ id, op, payload, dependsOn: lastCardOp(db, cardId) })
  return id
}

export type SetRateResult =
  | { ok: true; cardId: string; productId: string; dayRateMinor: number | null }
  | { ok: false; reason: 'unknown_product' | 'negative' | 'no_card' }

/**
 * Set one product's day rate on the default card, or REMOVE it with null
 * (0024 upsert_rate_entry, D5): the line goes back to unpriced, never to
 * zero; 0 itself is a deliberate 'included'. Queued as the server's op.
 */
export function setRate(
  db: SqlDriver,
  orgId: string,
  productId: string,
  dayRateMinor: number | null,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): SetRateResult {
  const card = defaultCard(db)
  if (!card) return { ok: false, reason: 'no_card' }
  if (!db.get(`select 1 as one from products where id = ?`, [productId])) {
    return { ok: false, reason: 'unknown_product' }
  }
  if (dayRateMinor !== null && !(Number.isFinite(dayRateMinor) && dayRateMinor >= 0)) {
    return { ok: false, reason: 'negative' }
  }
  const rate = dayRateMinor === null ? null : Math.round(dayRateMinor)
  db.transaction(() => {
    if (rate === null) {
      db.exec(`delete from rate_card_entries where rate_card_id = ? and product_id = ?`, [card.id, productId])
    } else {
      // One entry per (card, product) — the server's uniqueness; the mirror
      // keys on id, so find the row before inserting a twin.
      const existing = db.get<{ id: string }>(
        `select id from rate_card_entries where rate_card_id = ? and product_id = ?`, [card.id, productId],
      )
      if (existing) {
        db.exec(`update rate_card_entries set day_rate_minor = ? where id = ?`, [rate, existing.id])
      } else {
        db.exec(
          `insert into rate_card_entries (id, org_id, rate_card_id, product_id, day_rate_minor)
           values (?, ?, ?, ?, ?)`,
          [`rce-${ids.newId()}`, orgId, card.id, productId, rate],
        )
      }
    }
    db.exec(`update rate_cards set updated_at = ? where id = ?`, [iso(nowMs), card.id])
    enqueueCardOp(db, ids, 'upsert_rate_entry', card.id, {
      p_rate_card_id: card.id,
      p_product_id: productId,
      p_day_rate_minor: rate,
    })
  })
  return { ok: true, cardId: card.id, productId, dayRateMinor: rate }
}

export type SetRateCardResult =
  | { ok: true; card: RateCardInfo }
  | { ok: false; reason: 'bad_week' | 'bad_min_days' | 'bad_mask' | 'bad_name' }

/**
 * Edit the default card's knobs, or create the first card when none is
 * mirrored (0024 upsert_rate_card, D10: the first live card is default).
 * Partial: an omitted knob keeps its value, the server's "null = keep".
 */
export function setRateCard(
  db: SqlDriver,
  orgId: string,
  patch: Partial<RateCardKnobs> & { name?: string },
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): SetRateCardResult {
  const existing = defaultCard(db)
  const name = (patch.name ?? existing?.name ?? 'Standard').trim()
  if (name.length === 0) return { ok: false, reason: 'bad_name' }
  const week = patch.weekEqualsDays ?? existing?.weekEqualsDays ?? 3
  const minDays = patch.minBillableDays ?? existing?.minBillableDays ?? 1
  const mask = [...new Set(patch.weekendMask ?? existing?.weekendMask ?? [])].sort((a, b) => a - b)
  if (!(week > 0 && week <= 7)) return { ok: false, reason: 'bad_week' }
  if (!(Number.isInteger(minDays) && minDays >= 1)) return { ok: false, reason: 'bad_min_days' }
  if (mask.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return { ok: false, reason: 'bad_mask' }

  const id = existing?.id ?? `card-${ids.newId()}`
  db.transaction(() => {
    db.exec(
      `insert into rate_cards (id, org_id, name, is_default, week_equals_days, min_billable_days,
         weekend_mask, updated_at)
       values (?, ?, ?, 1, ?, ?, ?, ?)
       on conflict (id) do update set
         name = excluded.name, week_equals_days = excluded.week_equals_days,
         min_billable_days = excluded.min_billable_days, weekend_mask = excluded.weekend_mask,
         updated_at = excluded.updated_at`,
      [id, orgId, name, week, minDays, JSON.stringify(mask), iso(nowMs)],
    )
    enqueueCardOp(db, ids, 'upsert_rate_card', id, {
      client_card_id: id,
      p_name: name,
      p_id: existing ? id : null,
      p_is_default: true,
      p_week_equals_days: week,
      p_min_billable_days: minDays,
      p_weekend_mask: mask,
    })
  })
  return {
    ok: true,
    card: { id, name, isDefault: true, weekEqualsDays: week, minBillableDays: minDays, weekendMask: mask },
  }
}

// ------------------------------------------------------------ the calendar

export interface CalendarDayRow extends CalendarDayInput {
  id: string
}

/** Every mirrored calendar row, day order — the Rates page's list and
 *  the pipeline's step-4 input alike. */
export function calendarDays(db: SqlDriver): CalendarDayRow[] {
  return db
    .all<{ id: string; day: string; kind: string; name: string; rate_multiplier: number }>(
      `select id, day, kind, name, rate_multiplier from org_calendar_days order by day, kind`,
    )
    .map((r) => ({
      id: r.id,
      day: r.day,
      kind: r.kind === 'season' ? 'season' : 'holiday',
      name: r.name,
      rateMultiplier: Number(r.rate_multiplier),
    }))
}

export type SetCalendarDayResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'bad_day' | 'bad_name' | 'bad_multiplier' }

/** Upsert one holiday/season day with its multiplier (0024 set_calendar_day,
 *  D6). One row per (day, kind), the server's uniqueness. */
export function setCalendarDay(
  db: SqlDriver,
  orgId: string,
  day: string,
  kind: CalendarKind,
  name: string,
  rateMultiplier: number,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): SetCalendarDayResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, reason: 'bad_day' }
  const cleaned = name.trim()
  if (cleaned.length === 0) return { ok: false, reason: 'bad_name' }
  if (!(rateMultiplier > 0 && rateMultiplier <= 10)) return { ok: false, reason: 'bad_multiplier' }
  const id = db.get<{ id: string }>(
    `select id from org_calendar_days where day = ? and kind = ?`, [day, kind],
  )?.id ?? `cal-${ids.newId()}`
  db.transaction(() => {
    db.exec(
      `insert into org_calendar_days (id, org_id, day, kind, name, rate_multiplier)
       values (?, ?, ?, ?, ?, ?)
       on conflict (id) do update set name = excluded.name, rate_multiplier = excluded.rate_multiplier`,
      [id, orgId, day, kind, cleaned, rateMultiplier],
    )
    new Outbox(db, ids.now).enqueue({
      id: ids.newId(),
      op: 'set_calendar_day',
      payload: { p_day: day, p_kind: kind, p_name: cleaned, p_rate_multiplier: rateMultiplier },
      dependsOn: null,
    })
  })
  return { ok: true, id }
}

/** Remove one calendar day (0024 clear_calendar_day). Returns whether a
 *  row was there to clear. */
export function clearCalendarDay(
  db: SqlDriver,
  day: string,
  kind: CalendarKind,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): boolean {
  const row = db.get<{ id: string }>(
    `select id from org_calendar_days where day = ? and kind = ?`, [day, kind],
  )
  if (!row) return false
  db.transaction(() => {
    db.exec(`delete from org_calendar_days where id = ?`, [row.id])
    new Outbox(db, ids.now).enqueue({
      id: ids.newId(),
      op: 'clear_calendar_day',
      payload: { p_day: day, p_kind: kind },
      dependsOn: null,
    })
  })
  return true
}

// ---------------------------------------------------------------- margin

/** Every LIVE expense tagged to the booking, or to the job it became
 *  (0024 D9, booking_sub_hire_cost) — any kind. ASSUMPTION: transport
 *  counts as much as the sub-hired lens. See docs/assumptions.md#sub-hire-cost */
export function subHireCostFor(db: SqlDriver, bookingId: string): number {
  const jobIds = new Set(
    db.all<{ id: string }>(`select id from jobs where booking_id = ?`, [bookingId]).map((r) => r.id),
  )
  const tagged = new Set(
    db.all<{ id: string }>(`select id from org_expenses where booking_id = ?`, [bookingId]).map((r) => r.id),
  )
  return liveExpenses(expenseRows(db))
    .filter((e) => tagged.has(e.id) || (e.jobId !== null && jobIds.has(e.jobId)))
    .reduce((n, e) => n + e.amountMinor, 0)
}

// ---------------------------------------------------------------- quotes

export interface QuoteView extends Quote {
  bookingId: string | null
  bookingNo: number | null
  customerId: string | null
  customerName: string | null
  /** The verified-client stamp (0025 D10), when there is a client. */
  flags: QuoteFlags | null
}

/** ASSUMPTION: the org timezone until orgs.timezone is mirrored.
 *  See docs/assumptions.md#quote-timezone */
export function quoteTimezone(): string {
  return DEFAULT_TIMEZONE
}

function linesOfBooking(db: SqlDriver, bookingId: string): QuoteLineInput[] {
  return db
    .all<{
      id: string; product_id: string | null; asset_id: string | null; qty: number
      rate_minor: number | null; original_rate_minor: number | null; override_reason: string | null
      product_name: string | null; asset_code: string | null
    }>(
      `select l.id, l.product_id, l.asset_id, l.qty,
              l.rate_minor, l.original_rate_minor, l.override_reason,
              coalesce(p.display_name, pa.display_name, a.display_name) as product_name,
              a.asset_code
         from booking_lines l
         left join products p on p.id = l.product_id
         left join assets a on a.id = l.asset_id
         left join products pa on pa.id = a.product_id
        where l.booking_id = ?
        order by l.rowid`,
      [bookingId],
    )
    .map((r) => ({
      lineId: r.id,
      productId: r.product_id ?? productOfAsset(db, r.asset_id),
      productName: r.product_name ?? '',
      assetId: r.asset_id,
      assetCode: r.asset_code,
      qty: Number(r.qty),
      overrideRateMinor: r.rate_minor === null ? null : Number(r.rate_minor),
      originalRateMinor: r.original_rate_minor === null ? null : Number(r.original_rate_minor),
      overrideReason: r.override_reason,
    }))
}

function productOfAsset(db: SqlDriver, assetId: string | null): string | null {
  if (!assetId) return null
  return db.get<{ product_id: string | null }>(`select product_id from assets where id = ?`, [assetId])?.product_id ?? null
}

function runPipeline(
  db: SqlDriver,
  lines: QuoteLineInput[],
  startMs: number,
  endMs: number,
  status: QuoteStatus,
  subHireCostMinor: number,
  timezone: string,
): Quote {
  const card = defaultCard(db)
  return priceQuote({
    customerStartMs: startMs,
    customerEndMs: endMs,
    timezone,
    card,
    entries: card ? rateEntries(db, card.id) : new Map(),
    calendarDays: calendarDays(db),
    lines,
    subHireCostMinor,
    status,
  })
}

/** THE booking's quote — the same trace price_booking returns, from the
 *  mirror. Null for a booking not on this phone. */
export function quoteFor(
  db: SqlDriver,
  bookingId: string,
  timezone: string = quoteTimezone(),
): QuoteView | null {
  const b = loadBooking(db, bookingId)
  if (!b) return null
  const quote = runPipeline(
    db, linesOfBooking(db, bookingId), b.customerStartMs, b.customerEndMs,
    b.status, subHireCostFor(db, bookingId), timezone,
  )
  return {
    ...quote,
    bookingId: b.id,
    bookingNo: b.bookingNo,
    customerId: b.customerId,
    customerName: b.customerName,
    flags: quoteFlags(db, b.customerId),
  }
}

export interface EnquiryLine {
  productId: string
  productName: string
  qty: number
}

/** An indicative quote for a kit list BEFORE a booking exists — the desk's
 *  first number, from the same pipeline. Status 'enquiry' keeps it
 *  indicative by construction; no override, no sub-hire cost yet. */
export function quoteForLines(
  db: SqlDriver,
  lines: EnquiryLine[],
  startMs: number,
  endMs: number,
  customerId: string | null,
  timezone: string = quoteTimezone(),
): QuoteView {
  const quote = runPipeline(
    db,
    lines.map((l) => ({ productId: l.productId, productName: l.productName, qty: l.qty })),
    startMs, endMs, 'enquiry', 0, timezone,
  )
  const customer = customerId
    ? db.get<{ id: string; name: string }>(`select id, name from customers where id = ?`, [customerId])
    : null
  return {
    ...quote,
    bookingId: null,
    bookingNo: null,
    customerId: customer?.id ?? null,
    customerName: customer?.name ?? null,
    flags: customer ? quoteFlags(db, customer.id) : null,
  }
}

export type SetLineOverrideResult =
  | { ok: true; lineId: string; bookingId: string; rateMinor: number | null; originalRateMinor: number | null }
  | { ok: false; reason: 'not_found' | 'cancelled' | 'needs_reason' | 'negative' }

/**
 * The owner's last word on one line (0024 set_line_rate_override, D8):
 * the FINAL day rate, reason required, the card rate at this moment kept
 * as the original. A null rate clears the override (reason still
 * required). Chained behind the booking's own op.
 */
export function setLineOverride(
  db: SqlDriver,
  lineId: string,
  rateMinor: number | null,
  reason: string,
  nowMs: number,
  ids: BookingIds = defaultIds(nowMs),
): SetLineOverrideResult {
  const cleaned = reason.trim()
  if (cleaned.length === 0) return { ok: false, reason: 'needs_reason' }
  if (rateMinor !== null && !(Number.isFinite(rateMinor) && rateMinor >= 0)) {
    return { ok: false, reason: 'negative' }
  }
  const line = db.get<{ id: string; booking_id: string; product_id: string | null; asset_id: string | null }>(
    `select id, booking_id, product_id, asset_id from booking_lines where id = ?`, [lineId],
  )
  if (!line) return { ok: false, reason: 'not_found' }
  const b = loadBooking(db, line.booking_id)
  if (!b) return { ok: false, reason: 'not_found' }
  if (b.status === 'cancelled') return { ok: false, reason: 'cancelled' }

  const card = defaultCard(db)
  const productId = line.product_id ?? productOfAsset(db, line.asset_id)
  const cardRate = card && productId ? (rateEntries(db, card.id).get(productId) ?? null) : null
  const rate = rateMinor === null ? null : Math.round(rateMinor)
  const original = rate === null ? null : cardRate

  db.transaction(() => {
    db.exec(
      `update booking_lines set rate_minor = ?, original_rate_minor = ?, override_reason = ?
        where id = ?`,
      [rate, original, rate === null ? null : cleaned, line.id],
    )
    db.exec(`update bookings set updated_at = ? where id = ?`, [iso(nowMs), b.id])
    enqueueBookingOp(db, ids, 'set_line_rate_override', b.id, {
      client_booking_id: b.id,
      p_line_id: line.id,
      p_rate_minor: rate,
      p_reason: cleaned,
    })
  })
  return { ok: true, lineId: line.id, bookingId: b.id, rateMinor: rate, originalRateMinor: original }
}

// ------------------------------------------------- the WhatsApp quote text

/** The strings the core text builder needs, from the active table — the
 *  khataLabels pattern, so both languages are golden-tested. */
export function quoteStrings(str: StrTable): QuoteStrings {
  return {
    title: str.quoteTextTitle,
    forCustomer: str.quoteTextFor,
    window: str.quoteTextWindow,
    days: str.quoteTextDays,
    line: str.quoteTextLine,
    lineUnpriced: str.quoteTextLineUnpriced,
    multiplierNote: str.quoteTextMultiplier,
    total: str.quoteTextTotal,
    indicativeUnpriced: str.quoteTextIndicativeUnpriced,
    indicativeNotConfirmed: str.quoteTextIndicativeNotConfirmed,
    depositLine: (hint: DepositHint) => str.quoteTextDeposit(str.quoteDepositHint(hint)),
    payment: str.quoteTextPayment,
    footer: str.quoteTextFooter,
  }
}

/** The quote as it leaves the phone — for a booking or an enquiry alike. */
export function quoteTextOf(
  db: SqlDriver,
  str: StrTable,
  houseName: string,
  quote: QuoteView,
): string {
  return quoteText({
    quote,
    houseName,
    customerName: quote.customerName,
    fromLabel: bookingDateLabel(quote.customerStartMs),
    untilLabel: bookingDateLabel(quote.customerEndMs),
    formatRupees,
    depositHint: quote.flags?.depositHint ?? null,
    paymentLine: paymentLine(db),
  }, quoteStrings(str))
}

/** One booking's quote text, or null when the booking is not on this phone. */
export function quoteTextFor(
  db: SqlDriver,
  str: StrTable,
  houseName: string,
  bookingId: string,
): string | null {
  const q = quoteFor(db, bookingId)
  return q ? quoteTextOf(db, str, houseName, q) : null
}
