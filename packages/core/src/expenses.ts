/**
 * The expense side of the money book — the kharcha's pure heart.
 *
 * The customer ledger (ledger.ts) records what the world owes the house;
 * this module records what the house paid out: the camera repair, the
 * partner house's sub-hire bill, the Hall Road cable run. Mirrors the
 * server's org_expenses (migration 0019) the way LedgerEntryView mirrors
 * customer_ledger_entries.
 *
 * TWO RULES, STATED ONCE:
 *
 *   1. EVERY AMOUNT IS POSITIVE. An expense is money that left, full stop.
 *      There is no sign convention to memorise and no negative row to
 *      mis-sum; profit is always a READ (earned − spent), never a stored
 *      figure — the same override-14 posture as the balance.
 *
 *   2. A REVERSAL VOIDS A PAIR. `reversalOf` names the row it voids and
 *      copies its kind and amount (the record stays legible); at read time
 *      BOTH rows leave every sum — the voidScan treatment, not the
 *      ledger's cancellation. The ledger keeps a reversal and its target
 *      in the sums because the CLIENT saw both lines and the statement
 *      must print both; the expense book is the house's own record, so
 *      the voided pair simply stops counting. Append-only stays intact:
 *      nothing here updates or deletes.
 *
 * Everything is a pure function of the rows: no clock, no database, so the
 * same figures render on an offline phone and in a test. Recording money
 * paid out is a PAST FACT and therefore offline-safe by the CONTRIBUTING
 * rule.
 */

export type ExpenseKind =
  | 'repair'
  | 'sub_hire'
  | 'purchase'
  | 'transport'
  | 'consumables'
  | 'misc'

/** The six kinds, in the order the entry sheet's chips read. Repair and
 *  sub-hire lead because they are the two the year actually hit. */
export const EXPENSE_KINDS: readonly ExpenseKind[] = [
  'repair', 'sub_hire', 'purchase', 'transport', 'consumables', 'misc',
]

/** One expense row, as the projections and the screens read it. */
export interface ExpenseView {
  id: string
  kind: ExpenseKind
  /** Minor units (paisa), ALWAYS positive — see rule 1. */
  amountMinor: number
  /** Epoch ms, device clock, backdatable — when the money actually left. */
  createdAt: number
  /** The gear a repair (or a unit's purchase) kept alive. */
  assetId?: string | null
  /** The job a sub-hire rescued. */
  jobId?: string | null
  /** Who was paid: the partner house, the workshop, the shop. */
  counterparty?: string | null
  note?: string | null
  /** For a reversal row: the expense this row voids — see rule 2. */
  reversalOf?: string | null
}

/**
 * The rows that still count: reversal rows and their targets both leave
 * (rule 2). A reversal whose target is not in the given list still drops
 * itself — half a void must not double-spend.
 */
export function liveExpenses<T extends ExpenseView>(entries: T[]): T[] {
  const voided = new Set<string>()
  for (const e of entries) {
    if (e.reversalOf) voided.add(e.reversalOf)
  }
  return entries.filter((e) => !e.reversalOf && !voided.has(e.id))
}

/** What the given rows actually spent — the sum over the live set. */
export function totalExpenses(entries: ExpenseView[]): number {
  let total = 0
  for (const e of liveExpenses(entries)) total += e.amountMinor
  return total
}
