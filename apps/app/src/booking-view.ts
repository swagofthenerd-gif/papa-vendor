import {
  DAY_MS,
  HOUR_MS,
  MONTHS_SHORT,
  WEEKDAYS_SHORT,
  bookingDateLabel,
  dayStartMs,
  formatRupees,
  type ExtensionCollision,
} from '@papa/core'
import type { Collision, ConfirmRefusal } from './demo/bookings.ts'
import { STR } from './strings.ts'

/**
 * The booking screens' pure helpers — month arithmetic for the calendar
 * grid, the date-time input round trip, the labels the scanner and the
 * collision cards stamp, and the refusal sentences the sheets share. In
 * a plain .ts module, like status.ts and scan-row.ts, so every one of
 * them is assertable under Node.
 *
 * LOCAL TIME THROUGHOUT. The desk and the client are in the same city;
 * a booking's day is the day on the wall calendar, never the UTC one —
 * the same rule bookingDateLabel and dayStartMs already follow in core.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** Local midnight on the first of the month containing `ms`. */
export function monthStartOf(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** The first of the month `delta` months away (negative allowed). */
export function shiftMonth(monthStartMs: number, delta: number): number {
  const d = new Date(monthStartMs)
  return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime()
}

/** 'September 2026' — the calendar's month heading. */
export function monthLabel(monthStartMs: number): string {
  const d = new Date(monthStartMs)
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** 'Thu 21' — the scan row's promised stamp, short enough for a row. */
export function shortDayLabel(ms: number): string {
  const d = new Date(ms)
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()}`
}

/** 'Thu 21 Sep' — the day heading under the grid, and the asset page's
 *  promised stamp. */
export function dayLabel(ms: number): string {
  const d = new Date(ms)
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`
}

/**
 * The month as rows of seven, Monday first (the week a Lahore desk
 * writes), padded with nulls before the first and after the last day so
 * the grid is always whole rows. Day keys are local midnights, the same
 * keys the calendar read model uses, so a cell and its bookings match by
 * equality.
 */
export function monthGrid(monthStartMs: number): (number | null)[][] {
  const first = new Date(monthStartMs)
  const y = first.getFullYear()
  const m = first.getMonth()
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  // getDay: Sun=0. Monday-first offset: Mon=0 … Sun=6.
  const lead = (first.getDay() + 6) % 7
  const cells: (number | null)[] = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d).getTime())
  while (cells.length % 7 !== 0) cells.push(null)
  const rows: (number | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}

export const WEEKDAYS_MON_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Local 'YYYY-MM-DDTHH:MM' for a datetime-local input. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The input's value back to local epoch ms; null for anything unparseable. */
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!m) return null
  const ms = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0,
  ).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** A sensible default pickup: tomorrow 09:00 local. */
export function defaultPickupMs(nowMs: number): number {
  return dayStartMs(nowMs) + DAY_MS + 9 * HOUR_MS
}

/** A sensible default return: the day after the pickup, 18:00 local. */
export function defaultReturnMs(pickupMs: number): number {
  return dayStartMs(pickupMs) + DAY_MS + 18 * HOUR_MS
}

/** The collision card's first line: which unit or bulk shortfall. */
export function collisionSubject(c: ExtensionCollision): string {
  return c.kind === 'asset' ? c.assetCode : `${c.shortBy} × ${c.productName}`
}

/** When the rival's hold begins, in the calendar's one date voice. */
export function collisionStarts(c: ExtensionCollision): string {
  return bookingDateLabel(c.theirFromMs)
}

/** 'FX9-02 is already promised to booking #5 (Bilal)' — the one sentence
 *  for a unit collision, wherever confirm or a substitution meets one. */
export function collisionSentence(c: Pick<Collision, 'assetCode' | 'bookingNo' | 'customerName'>): string {
  return STR.bookingCollision(c.assetCode, c.bookingNo, c.customerName)
}

/** A confirm refusal as one sentence — the Confirm sheet's and the new
 *  booking sheet's shared voice, so a shortfall or the credential gate
 *  reads the same whichever door the desk came through. */
export function explainConfirmRefusal(p: ConfirmRefusal, bookingNo: number): string {
  if ('collision' in p) return collisionSentence(p.collision)
  switch (p.reason) {
    case 'short': return STR.bookingShort(p.short.available, p.short.wanted, p.short.productName)
    case 'needs_credentials': return STR.bookingNeedsCredentials(formatRupees(p.exposureMinor))
    case 'blacklisted': return STR.bookingBlacklisted
    case 'not_found': return STR.bookingNotFound
    case 'cancelled': return STR.bookingIsCancelled(bookingNo)
    case 'already_confirmed': return STR.bookingAlreadyConfirmed(bookingNo)
    case 'blocked_period_uncovers_customer': return STR.bookingBlockedPeriodUncovers
  }
}
