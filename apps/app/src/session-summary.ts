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

export interface SessionLine {
  key: string
  code: string | null
  name: string | null
  outcome: 'accepted' | 'assumed' | 'missing' | 'unexpected' | 'conflict' | 'unknown'
  note?: string
}

export interface SessionSummary {
  jobLabel: string
  mode: 'out' | 'in'
  expected: number
  scanned: number
  assumed: number
  missing: SessionLine[]
  exceptions: SessionLine[]
}

/** What the caller knows about one item, without any database in the way. */
export interface ItemFacts {
  id: string
  code: string | null
  name: string | null
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

  const line = (id: string, outcome: SessionLine['outcome'], note?: string): SessionLine => {
    const f = input.facts(id)
    return { key: id, code: f?.code ?? null, name: f?.name ?? null, outcome, note }
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
  const lines: string[] = []
  lines.push(summary.mode === 'out' ? `OUT — ${summary.jobLabel}` : `BACK — ${summary.jobLabel}`)
  lines.push('')
  lines.push(`${summary.scanned} of ${summary.expected} items scanned`)
  if (summary.assumed > 0) lines.push(`${summary.assumed} confirmed by case, not seen`)

  if (summary.missing.length > 0) {
    lines.push('')
    lines.push('Still to come:')
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
