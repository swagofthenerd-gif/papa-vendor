/**
 * The parchi — the paper gate pass, without the paper.
 *
 * At the gate the guard's job is to count lines and match names; the challan
 * is the instrument of that authority. There is no thermal printer yet (the
 * review's lens 4 wants one), so the interim mechanism is phone-to-phone:
 * this builds a PLAIN TEXT challan that the handover screen renders as a QR
 * code, and the guard's phone reads it with ANY camera app or WhatsApp's
 * camera — no app install, no network, on either side.
 *
 * PLAIN TEXT IS THE WHOLE DESIGN. A URL or JSON payload would need our app on
 * the reading phone, which the gate does not have. What the guard sees after
 * scanning is the challan itself, ready to forward on WhatsApp.
 *
 * CAPACITY IS A HARD PHYSICAL BUDGET. A QR code that grows past ~version 21
 * (101x101 modules) stops scanning reliably phone-screen-to-phone-camera in
 * warehouse light. So every free-text field is clipped and both lists are
 * capped with '+N more' — but the COUNTS are always the full counts, because
 * counting is what the gate does. The caps below are sized so the worst-case
 * challan stays under PARCHI_MAX_CHARS, and the test encodes that worst case
 * and asserts the resulting QR version. A truncated name still counts; a QR
 * that will not scan is a gate pass that does not exist.
 *
 * In a `.ts` module, like session-summary.ts, so it runs under plain Node in
 * the tests with no build step. Pure: (facts in, text out), no clock reads —
 * the caller passes `whenMs`, which is what makes the output deterministic.
 */
import { stamp } from './stamp.ts'

export interface ParchiLine {
  code: string | null
  name: string | null
}

export interface ParchiInput {
  /** The rental house's name — the letterhead of the challan. */
  houseName: string
  jobLabel: string
  mode: 'out' | 'in'
  /** The moment the parchi is issued, from the caller's clock. */
  whenMs: number
  /** Every item recorded this session, trust-confirmed ones included. */
  items: ParchiLine[]
  /** How many of `items` were taken on trust rather than seen. */
  assumedCount: number
  /** Expected but not recorded — the lines the gate should ask about. */
  shortfall: ParchiLine[]
  /**
   * The shortfall's money as a PRE-FORMATTED label ('Rs 43,000 +2 unpriced')
   * or null when nothing in it is priced. The caller formats because it owns
   * the rates and the honesty split; the challan only carries the sentence.
   */
  shortfallValueLabel: string | null
}

/**
 * The whole-challan budget, in characters. Version 21 at error level M holds
 * 714 BYTES, and QR counts bytes: the em dash and every truncation mark are
 * three bytes each, so the char budget sits well under the byte ceiling. The
 * caps below are sized so the worst case (test: `huge`) lands inside both —
 * the capacity test asks the encoder itself, which is the honest referee.
 */
export const PARCHI_MAX_CHARS = 660

/** Listed rows are capped; the counts never are. One row was reclaimed from
 *  each list when the shortfall's Value line landed — money on the challan
 *  buys more at the gate than the tenth listed item ever did, and the counts
 *  (which is what the gate reads) are untouched. */
export const PARCHI_MAX_ITEM_ROWS = 9
export const PARCHI_MAX_SHORT_ROWS = 4

const MAX_HOUSE_CHARS = 28
const MAX_JOB_CHARS = 40
const MAX_CODE_CHARS = 10
const MAX_NAME_CHARS = 16
// 'Rs 99,999,999 +99 unpriced' is 26; anything longer is clipped, because a
// scannable QR outranks the last digits of an implausible number.
const MAX_VALUE_CHARS = 30

/** Clip to a budget, marking the cut. The mark spends one of the n chars so
 *  a clipped value can never exceed an unclipped one's budget. */
function clip(value: string, n: number): string {
  const s = value.trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function row(line: ParchiLine): string {
  const code = clip(line.code ?? '-', MAX_CODE_CHARS)
  const name = clip(line.name ?? 'item', MAX_NAME_CHARS)
  return `${code}  ${name}`
}

/** A capped list: up to `cap` rows, then one '+N more' line. */
function listed(lines: ParchiLine[], cap: number): string[] {
  const out = lines.slice(0, cap).map(row)
  if (lines.length > cap) out.push(`+${lines.length - cap} more`)
  return out
}

export function buildParchi(input: ParchiInput): string {
  const coming = input.mode === 'in'
  const verb = coming ? 'BACK' : 'OUT'
  const lines: string[] = []

  lines.push(`PARCHI — ${clip(input.houseName, MAX_HOUSE_CHARS)}`)
  lines.push(clip(input.jobLabel, MAX_JOB_CHARS))
  lines.push(`${verb} ${stamp(input.whenMs)}`)
  lines.push('')

  // The list section is always present, even at zero — a gate pass with no
  // item section reads as torn, not as empty.
  lines.push(`${verb} (${input.items.length}):`)
  lines.push(...listed(input.items, PARCHI_MAX_ITEM_ROWS))

  if (input.shortfall.length > 0) {
    lines.push('')
    // Same vocabulary rule as manifestText: on the way out the rest follows;
    // on the way back a gap is gear at a client's site.
    lines.push(`${coming ? 'STILL OUT' : 'SHORT'} (${input.shortfall.length}):`)
    lines.push(...listed(input.shortfall, PARCHI_MAX_SHORT_ROWS))
    if (input.shortfallValueLabel) {
      // Money on the shortfall, clipped like every free-ish field so a
      // runaway label cannot cost the QR its scannability. No label when
      // nothing is priced — the gate counts lines either way.
      lines.push(`Value: ${clip(input.shortfallValueLabel, MAX_VALUE_CHARS)}`)
    }
  }

  lines.push('')
  if (input.assumedCount > 0) {
    // On the challan as a count, never as item rows: trust-confirmed items
    // are countable at the gate but must not read as observations.
    lines.push(`${input.assumedCount} taken on trust, not seen`)
  }
  lines.push(
    `Lines: ${input.items.length} ${coming ? 'back' : 'out'}, ${input.shortfall.length} short`,
  )

  return lines.join('\n')
}
