/**
 * The ginti discrepancy report — the stocktake's forwardable summary.
 *
 * A cycle count is a DIFF (cycleCountDiff in @papa/core): expected on this
 * shelf vs actually seen. When the walk is done, the owner wants one block
 * of text — what matched, what is MISSING (expected, never scanned), what
 * was found here but the book had elsewhere. Missing items are a decision
 * for a person (found somewhere else, or truly lost); this report SURFACES
 * them, and deliberately writes no terminal state (0020 D2).
 *
 * A builder like parchi.ts / theft-report.ts: pure, labels-bag driven, so
 * it renders identically in both languages and can be golden-tested.
 */

import type { StrTable } from './strings.ts'

export interface GintiLabels {
  heading: string
  shelfLine: (shelf: string) => string
  missingHeading: string
  unexpectedHeading: string
  okLine: (n: number) => string
  decide: string
  clean: string
}

export interface GintiReportRow {
  code: string | null
  name: string | null
}

export interface GintiReportInput {
  shelf: string
  okCount: number
  missing: GintiReportRow[]
  unexpected: GintiReportRow[]
}

function row(r: GintiReportRow): string {
  return `${r.code ?? '—'}  ${r.name ?? 'item'}`
}

/** The ginti-report words from the active string table. */
export function gintiLabels(str: StrTable): GintiLabels {
  return {
    heading: str.fleetGintiReportHeading,
    shelfLine: (shelf) => str.fleetGintiReportShelf(shelf),
    missingHeading: str.fleetGintiReportMissing,
    unexpectedHeading: str.fleetGintiReportUnexpected,
    okLine: (n) => str.fleetGintiReportOkLine(n),
    decide: str.fleetGintiReportDecide,
    clean: str.fleetGintiClean,
  }
}

export function buildGintiReport(input: GintiReportInput, L: GintiLabels): string {
  const lines: string[] = []
  lines.push(L.heading)
  lines.push(L.shelfLine(input.shelf))
  lines.push('')
  lines.push(L.okLine(input.okCount))

  if (input.missing.length > 0) {
    lines.push('')
    lines.push(L.missingHeading)
    for (const r of input.missing) lines.push(row(r))
  }
  if (input.unexpected.length > 0) {
    lines.push('')
    lines.push(L.unexpectedHeading)
    for (const r of input.unexpected) lines.push(row(r))
  }

  lines.push('')
  lines.push(
    input.missing.length === 0 && input.unexpected.length === 0
      ? L.clean
      : L.decide,
  )
  return lines.join('\n')
}
