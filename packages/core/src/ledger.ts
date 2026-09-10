import { formatRupees, totalRates, type MoneyTotal } from './money.ts'

/**
 * The udhaar ledger — the money book's pure heart.
 *
 * APPEND-ONLY BY DESIGN (PLAN.md override #14): `customer_ledger_entries`
 * rows are written once and never updated; the balance is a PROJECTION over
 * them, computed here. A mutable running total beside a payments table
 * drifts invisibly until a customer disputes it — accountants settled this
 * six hundred years ago and the scan log settled it again last month.
 *
 * SIGN CONVENTION, stated once: a positive amount is money the CUSTOMER
 * OWES (charge, late fee, damage); a negative amount is money RECEIVED or
 * credited (payment, an adjustment in the customer's favour). Deposits are
 * NOT debt in either direction — they are the customer's money sitting in
 * the house's drawer — so the three deposit kinds project into a separate
 * `depositHeldMinor` pot and never touch the balance, with ONE exception:
 * `deposit_apply` moves held money onto the debt, so it reduces both the
 * pot and the balance (its amount is negative, like a payment).
 *
 * Everything here is a pure function of (entries, now): no clock reads, no
 * database, so the same figures render on an offline phone and in a test.
 * Recording money received is a PAST FACT and therefore offline-safe by the
 * CONTRIBUTING rule; nothing in this module allocates anything.
 */

export type LedgerEntryKind =
  | 'charge'
  | 'payment'
  | 'deposit_hold'
  | 'deposit_apply'
  | 'deposit_refund'
  | 'late_fee'
  | 'damage_charge'
  | 'adjustment'

/** One ledger line, as the projection and the text builders read it. */
export interface LedgerEntryView {
  kind: LedgerEntryKind
  /** Signed minor units (paisa). Positive = owed, negative = received. */
  amountMinor: number
  /** Epoch ms, device clock — a past fact, labelled as such elsewhere. */
  createdAt: number
  /**
   * Insertion order (rowid on device) — the tie-break when two entries
   * share a millisecond. Without it, a charge/payment pair written in the
   * same ms flips order after re-sorting the screen's newest-first rows,
   * momentarily dipping the running balance and resetting the owed-since
   * clock. Optional so hand-built test entries still type; absent ties
   * keep their input order.
   */
  seq?: number
  jobLabel?: string | null
  note?: string | null
}

export interface LedgerProjection {
  /** What the customer owes right now. Negative means the house owes THEM. */
  balanceMinor: number
  /** Security money physically held, not part of the debt either way. */
  depositHeldMinor: number
}

const DEPOSIT_KINDS: ReadonlySet<LedgerEntryKind> = new Set([
  'deposit_hold',
  'deposit_apply',
  'deposit_refund',
])

/** Book order: written time, then insertion order — the same tie-break
 *  `rowsFor`'s SQL uses, so a re-sort can never disagree with the page. */
function byBookOrder(a: LedgerEntryView, b: LedgerEntryView): number {
  return a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0)
}

/** Kinds that put money ON the book — the earned side of the account. */
export const CHARGE_KINDS: ReadonlySet<LedgerEntryKind> = new Set([
  'charge',
  'late_fee',
  'damage_charge',
])

/**
 * The projection. Balance sums every non-deposit line plus `deposit_apply`
 * (held money paying a debt); the pot sums the three deposit kinds — hold
 * positive, apply and refund negative, so the pot drains as it is used.
 */
export function projectLedger(entries: LedgerEntryView[]): LedgerProjection {
  let balance = 0
  let deposit = 0
  for (const e of entries) {
    if (DEPOSIT_KINDS.has(e.kind)) {
      deposit += e.amountMinor
      if (e.kind === 'deposit_apply') balance += e.amountMinor
    } else {
      balance += e.amountMinor
    }
  }
  return { balanceMinor: balance, depositHeldMinor: deposit }
}

/**
 * Since when has this balance been owed?
 *
 * Walks the book oldest-first accumulating the running balance and returns
 * the timestamp of the entry that last took it above zero — i.e. the start
 * of the CURRENT stretch of debt, which is what "oldest unpaid" honestly
 * means on a running account (a payment that clears the book resets the
 * clock; a partial payment does not). Null when nothing is owed now.
 */
export function oldestUnpaidMs(entries: LedgerEntryView[]): number | null {
  const ordered = [...entries].sort(byBookOrder)
  let balance = 0
  let since: number | null = null
  for (const e of ordered) {
    if (DEPOSIT_KINDS.has(e.kind) && e.kind !== 'deposit_apply') continue
    balance += e.amountMinor
    if (balance > 0) {
      if (since === null) since = e.createdAt
    } else {
      since = null
    }
  }
  return balance > 0 ? since : null
}

/**
 * The late-fee draft: days late × the day rates of what came back late.
 *
 * A DRAFT, NEVER A CHARGE — the owner edits and confirms, because the fee is
 * a relationship decision, not arithmetic (vendor-dream-plan Phase B item 3).
 * The honesty rule from money.ts applies: rateless items land in `unpriced`
 * instead of pricing at zero, and when nothing is priced the caller gets a
 * total it must not render as 'Rs 0'.
 */
export function lateFeeDraft(
  daysLate: number,
  dayRatesMinor: (number | null | undefined)[],
): MoneyTotal {
  const perDay = totalRates(dayRatesMinor)
  return {
    totalMinor: perDay.totalMinor * Math.max(0, daysLate),
    priced: perDay.priced,
    unpriced: perDay.unpriced,
  }
}

/**
 * How far an asset has paid for itself.
 *
 * Null when the replacement value is unknown — a payback bar against a
 * made-up denominator is the confident lie this codebase refuses to tell.
 * The percentage is NOT clamped: 130% is the celebratory fact itself.
 */
export function paybackPercent(
  earnedMinor: number,
  replacementMinor: number | null | undefined,
): number | null {
  if (replacementMinor === null || replacementMinor === undefined) return null
  if (replacementMinor <= 0) return null
  return Math.round((earnedMinor / replacementMinor) * 100)
}

/** '+Rs 40,000' / '-Rs 20,000' — the signed voice of a ledger column.
 *  Zero renders unsigned: an adjustment of nothing carries no direction. */
export function signedRupees(minor: number): string {
  const abs = formatRupees(Math.abs(minor))
  if (minor > 0) return `+${abs}`
  if (minor < 0) return `-${abs}`
  return abs
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** '9 Aug' — deterministic, no locale; the date voice of the book's rows. */
export function ledgerDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** The local calendar month containing `nowMs`, with its statement label. */
export function monthBounds(nowMs: number): {
  startMs: number
  endMs: number
  label: string
} {
  const d = new Date(nowMs)
  return {
    startMs: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
    endMs: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(),
    label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  }
}

/**
 * Every word the two money documents say, as data.
 *
 * The builders below are share-content (they leave the app in a WhatsApp
 * message), but unlike the parchi they are read by the CLIENT, so they
 * follow the chrome's language choice: the app fills this shape from STR,
 * and the tests fill it from both tables. Keeping the shape here keeps the
 * builders pure and the wording in exactly one place per language.
 */
export interface KhataStrings {
  /** 'Hisaab — Bilal Hussain' */
  balanceTitle: (customerName: string) => string
  /** 'Statement — Bilal Hussain · Sep 2026' */
  statementTitle: (customerName: string, monthLabel: string) => string
  /** 'Balance: Rs 58,000' */
  balanceLine: (rupees: string) => string
  /** 'Closing balance: Rs 58,000' */
  closingLine: (rupees: string) => string
  /** Said when nothing is owed — a khata that only speaks when money is
   *  due reads as a threat, not an account. */
  nothingOwed: string
  /** 'Owed since 9 Aug' */
  owedSince: (date: string) => string
  /** One word per entry kind, the row vocabulary of the book. */
  kindLabel: (kind: LedgerEntryKind) => string
  /** Statement body when the month recorded nothing. */
  nothingThisMonth: string
}

export interface BalanceCardInput {
  customerName: string
  houseName: string
  /** The whole book for this customer, any order. */
  entries: LedgerEntryView[]
  /** 'JazzCash: 0300 1234567' when the org configured one, else null. */
  paymentLine: string | null
}

/**
 * The "send balance" card — one compact WhatsApp message: what is owed,
 * the last three entries, since when, and how to pay. Sent from the
 * owner's own phone; the app only drafts (authority stays with the sender).
 */
export function balanceCardText(input: BalanceCardInput, L: KhataStrings): string {
  const { balanceMinor } = projectLedger(input.entries)
  const lines: string[] = []
  lines.push(L.balanceTitle(input.customerName))
  lines.push(input.houseName)
  lines.push('')
  lines.push(
    balanceMinor > 0 ? L.balanceLine(formatRupees(balanceMinor)) : L.nothingOwed,
  )

  const recent = [...input.entries].sort(byBookOrder).slice(-3)
  if (recent.length > 0) {
    lines.push('')
    for (const e of recent) {
      lines.push(
        `${ledgerDate(e.createdAt)}  ${L.kindLabel(e.kind)}  ${signedRupees(e.amountMinor)}`,
      )
    }
  }

  const since = oldestUnpaidMs(input.entries)
  if (since !== null) {
    lines.push('')
    lines.push(L.owedSince(ledgerDate(since)))
  }
  if (input.paymentLine && balanceMinor > 0) {
    lines.push(input.paymentLine)
  }
  return lines.join('\n')
}

export interface StatementInput {
  customerName: string
  houseName: string
  /** The whole book; the builder does its own month filtering. */
  entries: LedgerEntryView[]
  /** Any instant inside the statement month. */
  nowMs: number
  paymentLine: string | null
}

/**
 * The monthly statement — the month's entries and the closing balance, one
 * WhatsApp-forwardable text in the hisaab's plain voice. Closing balance is
 * the projection over EVERYTHING up to month end, not just the month shown:
 * a statement whose bottom line ignored last month's debt would be a lie
 * with a letterhead.
 */
export function monthlyStatementText(input: StatementInput, L: KhataStrings): string {
  const month = monthBounds(input.nowMs)
  const ordered = [...input.entries].sort(byBookOrder)
  const inMonth = ordered.filter(
    (e) => e.createdAt >= month.startMs && e.createdAt < month.endMs,
  )
  const upToEnd = ordered.filter((e) => e.createdAt < month.endMs)

  const lines: string[] = []
  lines.push(`${L.statementTitle(input.customerName, month.label)}`)
  lines.push(input.houseName)
  lines.push('')

  if (inMonth.length === 0) {
    lines.push(L.nothingThisMonth)
  } else {
    for (const e of inMonth) {
      const where = e.jobLabel ? ` — ${e.jobLabel}` : ''
      lines.push(
        `${ledgerDate(e.createdAt)}  ${L.kindLabel(e.kind)}${where}  ${signedRupees(e.amountMinor)}`,
      )
    }
  }

  lines.push('')
  lines.push(L.closingLine(formatRupees(projectLedger(upToEnd).balanceMinor)))
  if (input.paymentLine) lines.push(input.paymentLine)
  return lines.join('\n')
}
