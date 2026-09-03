/**
 * Rupees, formatted and totalled.
 *
 * Money is stored in MINOR UNITS (paisa) everywhere, matching the server's
 * `_minor` column convention (booking_lines.original_rate_minor, the fraud
 * gate's value threshold). Display rounds to whole rupees — nobody in this
 * market quotes paisa on a rental line.
 *
 * GROUPING IS WESTERN (25,000 / 250,000), not lakh-style (2,50,000). Both are
 * seen in Pakistan; rate cards, invoices and bank statements this product sits
 * beside overwhelmingly use western grouping, and the asset codes next to
 * these figures are LTR Latin anyway. One convention, everywhere, and it is
 * this one — revisit with the pilot vendor if their paper challans disagree.
 *
 * THE HONESTY RULE FOR TOTALS. A product with no seeded rate contributes
 * nothing to a total and is COUNTED as unpriced instead: 'Rs 43,000 +2
 * unpriced' is a true sentence, 'Rs 43,000' over a list where two lines were
 * silently worth zero is the confident lie this codebase keeps refusing to
 * tell. When NOTHING is priced there is no number at all — the label is null
 * and the caller says 'no rate', never 'Rs 0'.
 */

/** 'Rs 25,000' from 2_500_000 paisa. Deterministic, no locale. */
export function formatRupees(minor: number): string {
  const rupees = Math.round(minor / 100)
  const sign = rupees < 0 ? '-' : ''
  const grouped = String(Math.abs(rupees)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `Rs ${sign}${grouped}`
}

export interface MoneyTotal {
  /** Sum of the priced entries only, in minor units. */
  totalMinor: number
  /** How many entries carried a rate. */
  priced: number
  /** How many did not — reported, never folded in as zero. */
  unpriced: number
}

/** Total a list of per-item values, null/undefined meaning "no rate". */
export function totalRates(values: (number | null | undefined)[]): MoneyTotal {
  let totalMinor = 0
  let priced = 0
  let unpriced = 0
  for (const v of values) {
    if (v === null || v === undefined) unpriced++
    else {
      totalMinor += v
      priced++
    }
  }
  return { totalMinor, priced, unpriced }
}

/**
 * A total as a label: 'Rs 43,000', 'Rs 43,000 +2 unpriced' — or null when
 * nothing was priced, because 'Rs 0' over an unpriced list is a claim the
 * data cannot support. The caller decides what silence looks like.
 */
export function moneyLabel(total: MoneyTotal): string | null {
  if (total.priced === 0) return null
  const suffix = total.unpriced > 0 ? ` +${total.unpriced} unpriced` : ''
  return `${formatRupees(total.totalMinor)}${suffix}`
}

/**
 * The indicative day-rate total for an answered kit list: rate × quantity
 * over the RESOLVED lines. Unresolved lines and rateless products both land
 * in `unpriced` (counted per line) — a quote that silently priced half the
 * list is worse than no quote. The caller labels the result 'indicative',
 * because a day-rate sum is not a quote: duration, discounts and the owner's
 * judgement are not in the data.
 */
export function indicativeDayTotal(
  lines: { productId?: string | null; quantity: number }[],
  rateFor: (productId: string) => number | null,
): MoneyTotal {
  return totalRates(
    lines.map((l) => {
      if (!l.productId) return null
      const rate = rateFor(l.productId)
      return rate === null ? null : rate * l.quantity
    }),
  )
}
