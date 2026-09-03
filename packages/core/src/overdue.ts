/**
 * Is it late yet?
 *
 * HARD RULE (CONTRIBUTING.md): any state transition triggered by the passage
 * of time must be derivable locally from stored timestamps, never only from a
 * server cron job. Overdue is the canonical case — an offline phone in the
 * warehouse must show the same red badge the desk sees, so everything here is
 * a pure function of (stored timestamp, now). No clock reads inside: the
 * caller passes `now`, which is also what makes the tests honest.
 *
 * `jobs.expected_back` is a Postgres `date` mirrored as text, but it has been
 * free-typed in this market's real workflows ("after eid", "monday ia").
 * Anything that does not parse is reported as `unknown` — with the honest
 * label "no date" — never guessed at. A confident wrong due date is worse
 * than an admitted missing one: the owner chases the wrong client, or worse,
 * doesn't chase the right one.
 */

export type DueState = 'due_today' | 'overdue' | 'upcoming' | 'unknown'

export interface DueStatus {
  state: DueState
  /** Whole calendar days past due. Present only when state is 'overdue'. */
  daysLate?: number
  /**
   * Ready-to-render text: 'due today', '3 days late', 'back Thu 21 Sep',
   * 'no date'. Kept short because it lives on a badge and in a WhatsApp line.
   */
  label: string
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Parse an expected_back value, or refuse.
 *
 * Only ISO-shaped values are accepted: `YYYY-MM-DD` (what the server column
 * actually holds) or a full ISO datetime. Everything else — free text, empty
 * string, a bare year — returns null. Deliberately NOT `Date.parse` on the
 * raw value: Date.parse happily invents dates out of strings like
 * "after eid 2026", and an invented date is exactly the lie this module
 * exists to avoid.
 *
 * Date-only values are constructed in LOCAL time. `new Date('2026-09-10')`
 * would parse as UTC midnight, which in any timezone west of Greenwich lands
 * on the 9th — a job due Friday showing as due Thursday.
 */
export function parseDueDate(value: string | null | undefined): Date | null {
  if (!value) return null

  const dateOnly = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(value)
  if (dateOnly) {
    const y = Number(dateOnly[1])
    const m = Number(dateOnly[2])
    const d = Number(dateOnly[3])
    const parsed = new Date(y, m - 1, d)
    // Reject rollover: new Date(2026, 1, 31) silently becomes March 3rd.
    // A due date that shifted itself by a month is not a due date.
    if (
      parsed.getFullYear() !== y ||
      parsed.getMonth() !== m - 1 ||
      parsed.getDate() !== d
    ) {
      return null
    }
    return parsed
  }

  // Full ISO datetimes only. The leading shape check is what keeps
  // Date.parse from creatively interpreting arbitrary text.
  if (!/^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null
  const t = Date.parse(value.trim())
  if (Number.isNaN(t)) return null
  return new Date(t)
}

/** Local-time midnight for the day containing `d`. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Whole calendar days from `due` to `now`, in local time. Positive = late.
 * Math.round because a DST transition makes one day 23 or 25 hours long, and
 * truncation would then be off by one for weeks.
 */
function calendarDaysLate(nowMs: number, due: Date): number {
  return Math.round((startOfDay(new Date(nowMs)) - startOfDay(due)) / DAY_MS)
}

/**
 * The due state of a job, computed at render time on the device.
 *
 * Calendar-day comparison, not hour comparison: a job due "2026-09-15" is
 * due TODAY for the whole of the 15th, and one day late from the first
 * minute of the 16th. That matches how the owner actually talks about it.
 */
export function dueStatus(
  expectedBack: string | null | undefined,
  nowMs: number,
): DueStatus {
  const due = parseDueDate(expectedBack)
  if (due === null) {
    // Honest, not clever. Free text like "after eid" means a human made a
    // note the machine cannot rank; say so rather than invent a date.
    return { state: 'unknown', label: 'no date' }
  }

  const late = calendarDaysLate(nowMs, due)
  if (late === 0) return { state: 'due_today', label: 'due today' }
  if (late > 0) {
    return {
      state: 'overdue',
      daysLate: late,
      label: late === 1 ? '1 day late' : `${late} days late`,
    }
  }
  return {
    state: 'upcoming',
    label: `back ${WEEKDAYS[due.getDay()]} ${due.getDate()} ${MONTHS[due.getMonth()]}`,
  }
}

/**
 * Order two expected_back values: earliest first, no-date last.
 *
 * Null-safe and unparseable-safe: anything without a real date sorts AFTER
 * everything with one, because a list of departures is read top-down under
 * time pressure and the rows you can act on by date belong at the top. Two
 * dateless rows compare equal (0) so a stable sort preserves their existing
 * order rather than shuffling them.
 */
export function compareDueDates(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const da = parseDueDate(a)
  const db = parseDueDate(b)
  if (da === null && db === null) return 0
  if (da === null) return 1
  if (db === null) return -1
  return da.getTime() - db.getTime()
}

/**
 * Comparator for job rows, by when they are expected back. Most-urgent
 * (earliest, i.e. most overdue) first; jobs with no usable date last.
 * Shaped for `jobs.sort(compareJobsByDue)` straight off the mirror.
 */
export function compareJobsByDue(
  a: { expected_back: string | null },
  b: { expected_back: string | null },
): number {
  return compareDueDates(a.expected_back, b.expected_back)
}
