import { bookingDateLabel, dayStartMs, type ExtensionCollision } from '@papa/core'

/**
 * The booking screens' pure helpers — month arithmetic for the calendar
 * grid, the date-time input round trip, and the two labels the scanner
 * and the collision cards stamp. In a plain .ts module, like status.ts
 * and scan-row.ts, so every one of them is assertable under Node.
 *
 * LOCAL TIME THROUGHOUT. The desk and the client are in the same city;
 * a booking's day is the day on the wall calendar, never the UTC one —
 * the same rule bookingDateLabel and dayStartMs already follow in core.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
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

/** 'Thu 21' — a day cell's short name, and the promised stamp's day. */
export function shortDayLabel(ms: number): string {
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}`
}

/** 'Thu 21 Sep' — the day heading under the grid. */
export function dayLabel(ms: number): string {
  const d = new Date(ms)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`
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
  return dayStartMs(nowMs) + 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000
}

/** A sensible default return: the day after the pickup, 18:00 local. */
export function defaultReturnMs(pickupMs: number): number {
  return dayStartMs(pickupMs) + 24 * 60 * 60 * 1000 + 18 * 60 * 60 * 1000
}

/**
 * The scanner's annotation for a unit promised soon — booking number and
 * the day the hold begins, short enough for a row: ('#5', 'Thu 21').
 * The CSS uppercases the stamp; this returns the words.
 */
export function promisedStampParts(bookingNo: number, blockedStartMs: number): { no: string; day: string } {
  return { no: `#${bookingNo}`, day: shortDayLabel(blockedStartMs) }
}

/** The collision card's first line: which unit or bulk shortfall. */
export function collisionSubject(c: ExtensionCollision): string {
  return c.kind === 'asset' ? c.assetCode : `${c.shortBy} × ${c.productName}`
}

/** When the rival's hold begins, in the calendar's one date voice. */
export function collisionStarts(c: ExtensionCollision): string {
  return bookingDateLabel(c.theirFromMs)
}
