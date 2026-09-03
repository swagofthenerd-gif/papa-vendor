/**
 * The handover summary — the pure part.
 *
 * In a `.ts` module, like status.ts, hold.ts and scan-row.ts, so it can be
 * asserted without a build step: Node strips TYPES at runtime but cannot
 * transform JSX, so anything living in a `.tsx` file is untestable. What the
 * numbers on this screen mean is exactly the logic worth testing.
 *
 * ONE RULE, ONE PLACE. The shortfall was first computed in the component and
 * the list was built in the store, and the two disagreed the moment an
 * off-list item was scanned — "3 not accounted for" printed directly above a
 * list of 4. That is the same failure mode the offline engine's `projectOp`
 * exists to prevent, and the cure is the same: the number and the list are
 * derived here, together, from one input.
 */
import { totalRates, type MoneyTotal } from '@papa/core'

export interface SessionLine {
  key: string
  code: string | null
  name: string | null
  outcome: 'accepted' | 'assumed' | 'missing' | 'unexpected' | 'conflict' | 'unknown'
  note?: string
  /**
   * What this line is worth, in minor units — replacement value coming BACK
   * (a gap there is gear at a client's site), day rate going OUT (revenue
   * still on the shelf). Null is 'no rate', never zero: PLAN.md's rule is
   * that "battery plate missing" is a chore and "Rs 12,000" is a decision,
   * and a made-up zero would quietly subtract from that decision.
   */
  valueMinor: number | null
}

export interface SessionSummary {
  jobLabel: string
  mode: 'out' | 'in'
  expected: number
  scanned: number
  assumed: number
  missing: SessionLine[]
  /** The missing lines' money, totalled with the unpriced count carried —
   *  the 'Rs 43,000 not back' figure, derived HERE beside the list it
   *  describes so the header and the rows cannot drift apart. */
  missingValue: MoneyTotal
  exceptions: SessionLine[]
}

/** What the caller knows about one item, without any database in the way. */
export interface ItemFacts {
  id: string
  code: string | null
  name: string | null
  /** Minor units (paisa); absent or null means 'no rate'. */
  dayRateMinor?: number | null
  replacementMinor?: number | null
}

export interface SummaryInput {
  jobLabel: string
  mode: 'out' | 'in'
  /** Item ids the job asked for. */
  expected: string[]
  /** Item ids recorded in this session, in scan order. */
  recorded: string[]
  /** Ids among `recorded` that were taken on trust rather than seen. */
  assumed: string[]
  /** Tags decoded that resolve to nothing this device has synced. */
  unknownTags: { key: string }[]
  /** Code and name for any id either list mentions. */
  facts: (id: string) => ItemFacts | undefined
}

export function buildSummary(input: SummaryInput): SessionSummary {
  const recorded = new Set(input.recorded)
  const expected = new Set(input.expected)
  const assumed = new Set(input.assumed)

  // Coming back, a gap is a potential claim: replacement value. Going out, a
  // gap is a day of revenue still on the shelf: day rate. Same source rule as
  // the section vocabulary — the money must mean what the heading says.
  const valueOf = (f: ItemFacts | undefined): number | null =>
    (input.mode === 'in' ? f?.replacementMinor : f?.dayRateMinor) ?? null

  const line = (id: string, outcome: SessionLine['outcome'], note?: string): SessionLine => {
    const f = input.facts(id)
    return {
      key: id,
      code: f?.code ?? null,
      name: f?.name ?? null,
      outcome,
      note,
      valueMinor: valueOf(f),
    }
  }

  const missing = input.expected
    .filter((id) => !recorded.has(id))
    .map((id) => line(id, 'missing'))

  const exceptions: SessionLine[] = [
    ...input.recorded
      .filter((id) => !expected.has(id))
      .map((id) => line(id, 'unexpected', 'Not on this job')),
    ...input.unknownTags.map((t) => ({
      key: t.key,
      code: null,
      name: 'Unknown tag',
      outcome: 'unknown' as const,
      note: 'A label this phone has never seen',
      valueMinor: null,
    })),
  ]

  return {
    jobLabel: input.jobLabel,
    mode: input.mode,
    expected: input.expected.length,
    // Seen with the camera or typed in — not the ones taken on trust, which
    // are counted separately precisely so they never pass as observations.
    scanned: [...recorded].filter((id) => !assumed.has(id)).length,
    assumed: [...recorded].filter((id) => assumed.has(id)).length,
    missing,
    missingValue: totalRates(missing.map((m) => m.valueMinor)),
    exceptions,
  }
}

/**
 * What is still on the shelf.
 *
 * The LENGTH OF THE LIST, never expected-minus-scanned. Those two part company
 * as soon as something off-list is scanned: nothing came off the shelf, but
 * the arithmetic drops by one anyway, and the screen then prints a number that
 * contradicts the list printed underneath it.
 */
export function shortfall(summary: SessionSummary): number {
  return summary.missing.length
}

/** The message a tech pastes into WhatsApp. Plain text, no formatting tricks. */
export function manifestText(summary: SessionSummary): string {
  const coming = summary.mode === 'in'
  const lines: string[] = []
  lines.push(coming ? `BACK — ${summary.jobLabel}` : `OUT — ${summary.jobLabel}`)
  lines.push('')
  lines.push(
    coming
      ? `${summary.scanned} of ${summary.expected} items back`
      : `${summary.scanned} of ${summary.expected} items scanned`,
  )
  if (summary.assumed > 0) lines.push(`${summary.assumed} confirmed by case, not seen`)

  if (summary.missing.length > 0) {
    lines.push('')
    // The heading a client reads decides what they do about it. "Still to
    // come" invites a reply tomorrow; "not come back yet" invites them to go
    // and look now, which is the only thing that finds gear.
    lines.push(coming ? 'Not come back yet:' : 'Still to come:')
    for (const m of summary.missing) lines.push(`- ${m.name ?? 'item'} (${m.code ?? '—'})`)
  }

  if (summary.exceptions.length > 0) {
    lines.push('')
    lines.push('Please note:')
    for (const e of summary.exceptions) {
      lines.push(`- ${e.name ?? 'item'} — ${e.note ?? 'needs a word'}`)
    }
  }

  return lines.join('\n')
}
