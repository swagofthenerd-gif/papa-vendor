import type { SqlDriver } from './db/driver.ts'
import { placeholders } from './db/driver.ts'
import type { MatchedLine } from './kit-list.ts'
import { compareDueDates, dueStatus } from './overdue.ts'

/**
 * Can we actually give them this?
 *
 * The second half of the pasted-kit-list flow. `kit-list.ts` decides WHAT the
 * client asked for; this decides whether it is on the shelf.
 *
 * Runs entirely against the local mirror, so the owner gets an answer with no
 * signal, standing in the warehouse, while the client is still on WhatsApp.
 * That immediacy is the whole value: an answer that arrives after a trip to a
 * desktop has already lost to a phone call to a competitor.
 *
 * ---------------------------------------------------------------------------
 * WHAT "AVAILABLE" MEANS HERE, AND WHAT IT DOES NOT
 *
 * This counts what is PHYSICALLY IN THE BUILDING AND FIT TO RENT right now. It
 * is deliberately NOT a booking check: bookings do not exist until phase 2, and
 * pretending to answer "is it free next Tuesday" with data that cannot support
 * it would be the worst kind of wrong — confident, specific, and unfounded.
 *
 * So the answer is "3 of these are here today", and the owner still applies
 * their own knowledge of what is promised. That is honest, and it is already
 * far faster than walking the shelves.
 */

export type AvailabilityState = 'available' | 'short' | 'none' | 'unknown'

/**
 * One open job that has a claim on some of the stock — either gear already
 * out on it, or gear promised to a departure that has not left yet. The
 * caller assembles these from whatever it knows (the jobs mirror, dispatch
 * state); this module only ranks and reports them. `expectedBack` is passed
 * through raw so the honesty rule holds end to end: unparseable stays
 * unparseable.
 */
export interface JobCommitment {
  jobId: string
  jobLabel: string
  /** Raw expected_back value from the jobs mirror. May be null or free text. */
  expectedBack: string | null
  /** Product ids of the items expected on this job, one entry per unit. */
  productIds: string[]
  /** True when the gear has physically left; false when it is still to go. */
  out: boolean
}

/** A commitment as it applies to ONE product line of the answer. */
export interface CommitmentNote {
  jobId: string
  jobLabel: string
  /** How many units of this product the job claims. */
  count: number
  /** Raw value, for callers that want to format their own. */
  expectedBack: string | null
  /**
   * Locally computed at answer time (CONTRIBUTING hard rule): 'back Thu 21
   * Sep', 'due today', '3 days late', or the honest 'no date'.
   */
  backLabel: string
  out: boolean
}

export interface AvailabilityLine extends MatchedLine {
  /** How many of this product are physically here and fit to rent. */
  onHand: number
  /** How many the client asked for, carried through from the parsed line. */
  wanted: number
  state: AvailabilityState
  /**
   * Which open jobs have a claim on this product, soonest-back first.
   * Empty when no commitments were supplied — the answer degrades to the
   * plain "here now" count, it never pretends to know about bookings.
   */
  committed: CommitmentNote[]
}

export interface AvailabilitySummary {
  lines: AvailabilityLine[]
  /** Lines that need a human before this list means anything. */
  needsAttention: number
  canFulfilEverything: boolean
}

/**
 * Count what is on the shelf, per product, in ONE query.
 *
 * Not one query per line: a pasted list is twenty lines and this runs on a
 * cheap Android, where twenty round trips through the SQLite bridge is a
 * visible pause at the exact moment the owner is trying to look responsive.
 */
function onHandByProduct(db: SqlDriver, productIds: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  if (productIds.length === 0) return counts

  const rows = db.all<{ product_id: string; n: number }>(
    `select product_id, count(*) as n
       from assets
      where product_id in (${placeholders(productIds.length)})
        -- 'here' only. Something out on another job is not available, and
        -- something quarantined or in for service must never be promised —
        -- a lens that ships broken costs more than one you declined.
        and presence = 'here'
        and health = 'ok'
      group by product_id`,
    productIds,
  )

  for (const r of rows) counts.set(r.product_id, Number(r.n))
  return counts
}

/**
 * The commitments that touch one product, ranked for reading.
 *
 * Soonest-expected-back first, no-date last (compareDueDates), because the
 * question behind the whole feature is "when can I have another one" and the
 * first row should be the answer. The back label is computed HERE, from the
 * stored date and the caller's clock — never fetched — so it works offline
 * and never disagrees with the overdue badge elsewhere in the app.
 */
function commitmentNotes(
  productId: string,
  commitments: JobCommitment[],
  nowMs: number,
): CommitmentNote[] {
  const notes: CommitmentNote[] = []

  for (const job of commitments) {
    const count = job.productIds.filter((id) => id === productId).length
    if (count === 0) continue
    notes.push({
      jobId: job.jobId,
      jobLabel: job.jobLabel,
      count,
      expectedBack: job.expectedBack,
      backLabel: dueStatus(job.expectedBack, nowMs).label,
      out: job.out,
    })
  }

  notes.sort((a, b) => compareDueDates(a.expectedBack, b.expectedBack))
  return notes
}

/**
 * One line's stock story as text: '2 here now · 1 out on Shan Foods TVC,
 * back Thu 21 Sep'. Pure formatting over the structured data, kept in core so
 * the demo, the device app and the WhatsApp reply all say it the same way.
 *
 * An unresolved line has no story to tell and says so.
 */
export function availabilityNote(line: AvailabilityLine): string {
  if (line.state === 'unknown') return 'unconfirmed item — no count'

  const parts = [`${line.onHand} here now`]
  for (const c of line.committed) {
    const where = c.out ? `out on ${c.jobLabel}` : `going to ${c.jobLabel}`
    parts.push(`${c.count} ${where}, ${c.backLabel}`)
  }
  return parts.join(' · ')
}

/**
 * Answer a whole pasted list.
 *
 * A line the parser was not confident about reports `unknown` rather than a
 * number. Counting stock for a product nobody has confirmed is the same
 * mistake as auto-matching it: a real figure attached to a guess reads as
 * fact, and the owner quotes it.
 */
export function checkAvailability(
  db: SqlDriver,
  matched: MatchedLine[],
  // Optional: what the owner already knows is promised. Without it the answer
  // stays exactly what it was — an honest shelf count. With it, "1 short"
  // becomes "1 short, but one comes back Thursday", which is the sentence the
  // owner was going to reconstruct from memory anyway.
  commitments: JobCommitment[] = [],
  nowMs: number = Date.now(),
): AvailabilitySummary {
  const ids = [...new Set(matched.map((m) => m.productId).filter((id): id is string => !!id))]
  const counts = onHandByProduct(db, ids)

  const lines: AvailabilityLine[] = matched.map((m) => {
    const wanted = m.quantity

    if (!m.productId) {
      // No stock figure for a guess — and no commitment notes either, for
      // the same reason: data attached to an unconfirmed match reads as
      // confirmation.
      return { ...m, onHand: 0, wanted, state: 'unknown', committed: [] }
    }

    const onHand = counts.get(m.productId) ?? 0
    const state: AvailabilityState =
      onHand >= wanted ? 'available' : onHand > 0 ? 'short' : 'none'

    return {
      ...m,
      onHand,
      wanted,
      state,
      committed: commitmentNotes(m.productId, commitments, nowMs),
    }
  })

  return {
    lines,
    // Both kinds of "a person must look at this": lines that could not be
    // identified, and lines that cannot be filled. Counted together because
    // from the owner's side they are the same job — the things stopping this
    // list from being a yes.
    needsAttention: lines.filter((l) => l.state !== 'available').length,
    canFulfilEverything: lines.every((l) => l.state === 'available'),
  }
}

/**
 * One line for the reply.
 *
 * Written to be pasted straight back into WhatsApp, because that is where the
 * conversation is and retyping it is where the time goes. Plain text, no
 * formatting that a paste will mangle.
 */
export function replySummary(summary: AvailabilitySummary): string {
  const out: string[] = []

  for (const l of summary.lines) {
    const name = l.productName ?? l.raw
    if (l.state === 'available') out.push(`✅ ${l.wanted}x ${name}`)
    else if (l.state === 'short') out.push(`⚠️ ${name} — only ${l.onHand} of ${l.wanted} available`)
    else if (l.state === 'none') out.push(`❌ ${name} — none available`)
    // An unresolved line is reported as UNRESOLVED, never quietly dropped.
    // Dropping it would send a reply that silently ignores something the
    // client asked for, and they will notice on the truck rather than now.
    else out.push(`❓ ${l.raw} — please confirm which item you mean`)
  }

  return out.join('\n')
}
