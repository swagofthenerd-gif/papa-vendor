/**
 * Pricing — the quote pipeline, on the phone (migration 0024, PLAN.md
 * phase 3; vendor-dream-plan C3–C4).
 *
 * WHAT THIS FILE IS. The ONE local home of price_booking(): the same six
 * named steps, in the same fixed order, over plain inputs — so the desk
 * can quote a pasted kit list offline and the number it says is THE SAME
 * NUMBER the server's trace will carry once the booking exists. Every
 * rule below names the 0024 decision it mirrors and copies the predicate
 * rather than re-deriving it; the golden fixtures in the 0024 pgTAP file
 * are copied verbatim into packages/core/test/pricing.test.mjs.
 *
 *   1 billable_days        calendar days from the customer window (24h
 *                          from pickup, ceil, never below 1 — D2), dated
 *                          in the org timezone; the card's weekend mask
 *                          drops named dates (D3); min_billable_days
 *                          floors the count → counted_days
 *   2 week_rule            weeks × week_equals_days + least(remainder,
 *                          week_equals_days) → billable_days (D4)
 *   3 card_rates           per-line day rate from the card; a missing
 *                          entry is UNPRICED — counted, never zero (D5)
 *   4 calendar_multiplier  the MAX rate_multiplier of any calendar day
 *                          inside the span, booking-wide (D6/D7)
 *   5 overrides            a logged manual rate is the FINAL day rate —
 *                          the multiplier does not apply on top (D8)
 *   6 totals               subtotal, unpriced count, sub-hire cost,
 *                          margin, indicative (D5/D9)
 *
 * Pure: no database, no clock. The app's read model (apps/app/src/demo/
 * quotes.ts) loads the mirror rows and hands them in; the WhatsApp text
 * builder at the bottom takes a strings object so both language tables
 * can be golden-tested.
 */

import { DAY_MS } from './bookings.ts'

export type CalendarKind = 'holiday' | 'season'

/** The card's three knobs (0024 rate_cards). */
export interface RateCardKnobs {
  weekEqualsDays: number
  minBillableDays: number
  /** ISO weekdays (1 = Monday … 7 = Sunday) that do NOT bill. */
  weekendMask: number[]
}

export interface RateCardInfo extends RateCardKnobs {
  id: string
  name: string
  isDefault: boolean
}

/** One dated calendar row (0024 org_calendar_days). `day` is 'YYYY-MM-DD'. */
export interface CalendarDayInput {
  day: string
  kind: CalendarKind
  name: string
  rateMultiplier: number
}

export interface QuoteLineInput {
  /** The booking line's id when one exists; an enquiry has none. */
  lineId?: string | null
  productId: string | null
  productName: string
  assetId?: string | null
  assetCode?: string | null
  qty: number
  /** The logged override (0024 D8): the FINAL day rate. */
  overrideRateMinor?: number | null
  /** The card rate at override time, for the struck-through original. */
  originalRateMinor?: number | null
  overrideReason?: string | null
}

export type QuoteStatus = 'draft' | 'pencil' | 'confirmed' | 'cancelled' | 'enquiry'

export interface PriceQuoteInput {
  customerStartMs: number
  customerEndMs: number
  /** IANA zone the dates are read in. ASSUMPTION: the org's zone is
   *  Asia/Karachi until a setting says otherwise.
   *  See docs/assumptions.md#quote-timezone */
  timezone?: string
  card: RateCardInfo | null
  /** productId → day rate in minor units, from the card's live entries.
   *  A product absent here is UNPRICED (D5). */
  entries: Map<string, number>
  calendarDays: CalendarDayInput[]
  lines: QuoteLineInput[]
  subHireCostMinor: number
  status: QuoteStatus
}

export type IndicativeReason = 'unpriced_lines' | 'not_confirmed' | 'no_rate_card'

export interface QuoteLine {
  lineId: string | null
  productId: string | null
  productName: string
  assetId: string | null
  assetCode: string | null
  qty: number
  billableDays: number
  cardRateMinor: number | null
  override: { rateMinor: number; originalRateMinor: number | null; reason: string | null } | null
  effectiveRateMinor: number | null
  multiplier: number
  multiplierApplied: boolean
  priced: boolean
  lineTotalMinor: number | null
}

export interface QuoteTotals {
  subtotalMinor: number
  pricedCount: number
  unpricedCount: number
  overriddenCount: number
  subHireCostMinor: number
  marginMinor: number
  indicative: boolean
  indicativeReasons: IndicativeReason[]
}

export interface QuoteSteps {
  billableDays: {
    step: 1
    name: 'billable_days'
    timezone: string
    firstDay: string
    calendarDays: number
    weekendMask: number[]
    weekendDaysDropped: number
    droppedDates: string[]
    minBillableDays: number
    minApplied: boolean
    countedDays: number
  }
  weekRule: {
    step: 2
    name: 'week_rule'
    weekEqualsDays: number
    weeks: number
    remainderDays: number
    remainderBilled: number
    billableDays: number
  }
  cardRates: {
    step: 3
    name: 'card_rates'
    rateCardId: string | null
    pricedLines: number
    unpricedLines: number
  }
  calendarMultiplier: {
    step: 4
    name: 'calendar_multiplier'
    multiplier: number
    drivenBy: CalendarDayInput | null
  }
  overrides: { step: 5; name: 'overrides'; overriddenLines: number }
  totals: { step: 6; name: 'totals' } & QuoteTotals
}

export interface Quote {
  status: QuoteStatus
  customerStartMs: number
  customerEndMs: number
  rateCard: RateCardInfo | null
  steps: QuoteSteps
  lines: QuoteLine[]
  totals: QuoteTotals
}

/** The documented defaults the server falls back to without a card. */
export const DEFAULT_RATE_CARD_KNOBS: RateCardKnobs = {
  // ASSUMPTION: a week bills as 3 day-rates. See docs/assumptions.md#week-rate
  weekEqualsDays: 3,
  minBillableDays: 1,
  // ASSUMPTION: every day bills unless the card opts a weekend out.
  // See docs/assumptions.md#weekend-free
  weekendMask: [],
}

/** ASSUMPTION: the org timezone until orgs.timezone is mirrored.
 *  See docs/assumptions.md#quote-timezone */
export const DEFAULT_TIMEZONE = 'Asia/Karachi'

// ---------------------------------------------------------------- dates

/** 'YYYY-MM-DD' of an instant in a zone (0024 D2: dated in the org's
 *  timezone). Intl does the zone arithmetic; nothing here guesses DST. */
export function localDate(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** 'YYYY-MM-DD' + n days, on the calendar (UTC arithmetic over a date
 *  that carries no time, so no zone can move it). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + n * DAY_MS
  const x = new Date(t)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}`
}

/** ISO weekday of 'YYYY-MM-DD': 1 = Monday … 7 = Sunday (Postgres isodow). */
export function isoWeekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()   // 0 = Sunday
  return dow === 0 ? 7 : dow
}

// ------------------------------------------------------------ the pipeline

export function priceQuote(input: PriceQuoteInput): Quote {
  const timezone = input.timezone ?? DEFAULT_TIMEZONE
  const card = input.card
  const hasCard = card !== null
  // Without a card the knobs fall back to their documented defaults so the
  // day math still renders; every line is unpriced regardless.
  const weekDays = card?.weekEqualsDays ?? DEFAULT_RATE_CARD_KNOBS.weekEqualsDays
  const minDays = card?.minBillableDays ?? DEFAULT_RATE_CARD_KNOBS.minBillableDays
  const mask = hasCard ? card.weekendMask : []

  // ---- step 1: billable_days (D2, D3) ------------------------------------
  // ASSUMPTION: a rental day is 24h from pickup, dated in the org timezone.
  // See docs/assumptions.md#rental-day
  const firstDay = localDate(input.customerStartMs, timezone)
  const calendarDays = Math.max(
    1, Math.ceil((input.customerEndMs - input.customerStartMs) / DAY_MS),
  )
  const droppedDates: string[] = []
  for (let i = 0; i < calendarDays; i++) {
    const day = addDays(firstDay, i)
    if (mask.includes(isoWeekday(day))) droppedDates.push(day)
  }
  let counted = calendarDays - droppedDates.length
  let minApplied = false
  if (counted < minDays) { counted = minDays; minApplied = true }

  // ---- step 2: week_rule (D4) --------------------------------------------
  const weeks = Math.floor(counted / 7)
  const remainder = counted % 7
  const remainderBilled = Math.min(remainder, weekDays)
  const billable = weeks * weekDays + remainderBilled

  // ---- step 4: calendar_multiplier (D7) — computed before the line loop
  // because every line reads it; reported in step order below. The server
  // orders by multiplier desc, day, kind and takes the first row.
  const lastDayExclusive = addDays(firstDay, calendarDays)
  const inside = input.calendarDays
    .filter((d) => d.day >= firstDay && d.day < lastDayExclusive)
    .sort((a, b) =>
      b.rateMultiplier - a.rateMultiplier
      || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)
      || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
  const driver = inside[0] ?? null
  const multiplier = driver?.rateMultiplier ?? 1

  // ---- steps 3 and 5 per line: card_rates, overrides (D5, D8) ------------
  const lines: QuoteLine[] = []
  let pricedN = 0
  let unpricedN = 0
  let cardPricedN = 0
  let cardUnpricedN = 0
  let overrideN = 0
  let subtotal = 0
  for (const l of input.lines) {
    const cardRate = hasCard && l.productId !== null
      ? (input.entries.get(l.productId) ?? null)
      : null
    if (cardRate === null) cardUnpricedN++; else cardPricedN++

    let effective: number | null
    let applied: boolean
    const overrideRate = l.overrideRateMinor ?? null
    if (overrideRate !== null) {
      // D8: the override is the final day rate; no multiplier on top.
      // ASSUMPTION: see docs/assumptions.md#override-final
      effective = overrideRate
      applied = false
      overrideN++
    } else {
      effective = cardRate
      applied = cardRate !== null
    }

    let total: number | null
    if (effective === null) {
      total = null
      unpricedN++
    } else {
      total = Math.round(l.qty * billable * effective * (applied ? multiplier : 1))
      pricedN++
      subtotal += total
    }

    lines.push({
      lineId: l.lineId ?? null,
      productId: l.productId,
      productName: l.productName,
      assetId: l.assetId ?? null,
      assetCode: l.assetCode ?? null,
      qty: l.qty,
      billableDays: billable,
      cardRateMinor: cardRate,
      override: overrideRate === null ? null : {
        rateMinor: overrideRate,
        originalRateMinor: l.originalRateMinor ?? null,
        reason: l.overrideReason ?? null,
      },
      effectiveRateMinor: effective,
      multiplier: applied ? multiplier : 1,
      multiplierApplied: applied,
      priced: effective !== null,
      lineTotalMinor: total,
    })
  }

  // ---- step 6: totals (D5, D9) -------------------------------------------
  const reasons: IndicativeReason[] = []
  if (unpricedN > 0) reasons.push('unpriced_lines')
  if (input.status !== 'confirmed') reasons.push('not_confirmed')
  if (!hasCard) reasons.push('no_rate_card')
  const totals: QuoteTotals = {
    subtotalMinor: subtotal,
    pricedCount: pricedN,
    unpricedCount: unpricedN,
    overriddenCount: overrideN,
    subHireCostMinor: input.subHireCostMinor,
    marginMinor: subtotal - input.subHireCostMinor,
    // The server's boolean reads exactly these two; 'no_rate_card' is a
    // reason on its own (every card-priced line is unpriced anyway).
    indicative: unpricedN > 0 || input.status !== 'confirmed',
    indicativeReasons: reasons,
  }

  return {
    status: input.status,
    customerStartMs: input.customerStartMs,
    customerEndMs: input.customerEndMs,
    rateCard: card,
    steps: {
      billableDays: {
        step: 1, name: 'billable_days', timezone, firstDay, calendarDays,
        weekendMask: mask, weekendDaysDropped: droppedDates.length, droppedDates,
        minBillableDays: minDays, minApplied, countedDays: counted,
      },
      weekRule: {
        step: 2, name: 'week_rule', weekEqualsDays: weekDays, weeks,
        remainderDays: remainder, remainderBilled, billableDays: billable,
      },
      cardRates: {
        step: 3, name: 'card_rates', rateCardId: card?.id ?? null,
        pricedLines: cardPricedN, unpricedLines: cardUnpricedN,
      },
      calendarMultiplier: { step: 4, name: 'calendar_multiplier', multiplier, drivenBy: driver },
      overrides: { step: 5, name: 'overrides', overriddenLines: overrideN },
      totals: { step: 6, name: 'totals', ...totals },
    },
    lines,
    totals,
  }
}

// ------------------------------------------------------ the WhatsApp text

/** The deposit ladder the quote stamps beside the client (0025 D10).
 *  ASSUMPTION: see docs/assumptions.md#deposit-hint */
export type DepositHint = 'refuse' | 'lighter' | 'standard' | 'full'

/**
 * The words the quote message is written in — supplied by the app's
 * string tables (the KhataStrings pattern), so the text is golden-tested
 * in both languages and core never imports the chrome.
 */
export interface QuoteStrings {
  /** 'Ravi Light & Grip — quote' */
  title: (houseName: string) => string
  /** 'For: Bilal Hussain' */
  forCustomer: (name: string) => string
  /** 'From Thu 17 Sep, 10:00 to Sat 19 Sep, 10:00' */
  window: (from: string, until: string) => string
  /** '2 billable days' — the day count the lines multiply by. */
  days: (billableDays: number, calendarDays: number) => string
  /** 'FX9 × 2 · 6 days · Rs 25,000/day = Rs 300,000' */
  line: (name: string, qty: number, days: number, rate: string, total: string) => string
  /** 'Sachdeva Tripod × 2 · unpriced' */
  lineUnpriced: (name: string, qty: number) => string
  /** 'Eid ul-Fitr on 10 Apr: ×1.25 on the whole booking' */
  multiplierNote: (name: string, day: string, multiplier: string) => string
  /** 'Total: Rs 307,200' */
  total: (rupees: string) => string
  /** 'Indicative — 2 items unpriced, final quote from the desk.' */
  indicativeUnpriced: (n: number) => string
  /** 'Indicative — not yet confirmed.' */
  indicativeNotConfirmed: string
  /** 'Deposit: half deposit — verified client' */
  depositLine: (hint: DepositHint) => string
  /** 'Pay: JazzCash 0300 1234567' */
  payment: (line: string) => string
  footer: string
}

export interface QuoteTextInput {
  quote: Quote
  houseName: string
  customerName: string | null
  /** The two instants in the app's one date voice (bookingDateLabel). */
  fromLabel: string
  untilLabel: string
  formatRupees: (minor: number) => string
  depositHint: DepositHint | null
  paymentLine: string | null
}

/** The quote as it leaves the phone in a WhatsApp message — plain text,
 *  every line honest: unpriced items are named, never summed as zero, and
 *  an indicative quote says so before the total. */
export function quoteText(input: QuoteTextInput, str: QuoteStrings): string {
  const { quote } = input
  const rs = input.formatRupees
  const out: string[] = [str.title(input.houseName)]
  if (input.customerName) out.push(str.forCustomer(input.customerName))
  out.push(str.window(input.fromLabel, input.untilLabel))
  out.push(str.days(quote.steps.weekRule.billableDays, quote.steps.billableDays.calendarDays))
  out.push('')
  for (const l of quote.lines) {
    const name = quoteLineName(l)
    if (l.priced && l.effectiveRateMinor !== null && l.lineTotalMinor !== null) {
      out.push(str.line(name, l.qty, l.billableDays, rs(l.effectiveRateMinor), rs(l.lineTotalMinor)))
    } else {
      out.push(str.lineUnpriced(name, l.qty))
    }
  }
  const driver = quote.steps.calendarMultiplier.drivenBy
  if (driver && quote.steps.calendarMultiplier.multiplier > 1) {
    out.push('', str.multiplierNote(driver.name, driver.day, `×${trimNumber(driver.rateMultiplier)}`))
  }
  out.push('', str.total(rs(quote.totals.subtotalMinor)))
  if (quote.totals.unpricedCount > 0) out.push(str.indicativeUnpriced(quote.totals.unpricedCount))
  else if (quote.totals.indicative) out.push(str.indicativeNotConfirmed)
  if (input.depositHint) out.push(str.depositLine(input.depositHint))
  if (input.paymentLine) out.push(str.payment(input.paymentLine))
  out.push('', str.footer)
  return out.join('\n')
}

/** How a line is named on the challan and in the message alike: the
 *  product, then the unit's code when the line is a specific unit
 *  ('Sony FX9 FX9-01'). One home, so the sheet and the text agree. */
export function quoteLineName(l: Pick<QuoteLine, 'productName' | 'assetCode'>): string {
  return l.assetCode ? `${l.productName} ${l.assetCode}` : l.productName
}

/** '1.25' → '1.25', '1.10' → '1.1', '1.0' → '1' — a multiplier as a person
 *  would write it on a challan. */
export function trimNumber(n: number): string {
  return String(Number(n.toFixed(3)))
}
