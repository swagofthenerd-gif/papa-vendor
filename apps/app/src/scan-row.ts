import type { ScanResult } from '@papa/core'

/**
 * The session-list row — the pure part.
 *
 * In a .ts module, like status.ts and hold.ts, so it can be asserted without a
 * build step. Node strips TYPES from .ts at runtime but cannot transform JSX,
 * so anything living in a .tsx file is untestable. What a row looks like after
 * a scan is exactly the logic worth testing.
 */

export interface ScanRow extends ScanResult {
  key: string
  at: number
}

/**
 * The row's class list.
 *
 * Built as a template rather than an array plus filter plus join. That version
 * allocated four objects per row per render, and this list re-renders on every
 * single scan — 300 rows by mid-morning.
 */
export function scanRowClass(outcome: ScanResult['outcome'], isPulsing: boolean): string {
  return `scan-row is-${outcome}${isPulsing ? ' is-pulsing' : ''}`
}

/**
 * Whether a row needs to re-render.
 *
 * Extracted so the memo comparison is TESTABLE. A memo whose comparison is
 * subtly wrong is worse than no memo: it silently stops the screen updating,
 * and the symptom is "the scanner missed one" — which is the single fastest
 * way to lose a tech's trust in the whole system.
 *
 * Deliberately explicit rather than a shallow compare over every prop. A row's
 * contents never change once it has been added — only its pulsing state does —
 * so those are the only two things worth comparing.
 */
export function scanRowChanged(
  prev: { row: ScanRow; isPulsing: boolean },
  next: { row: ScanRow; isPulsing: boolean },
): boolean {
  return prev.row !== next.row || prev.isPulsing !== next.isPulsing
}
