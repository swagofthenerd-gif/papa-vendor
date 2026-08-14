import type { SqlDriver } from './db/driver.ts'
import { placeholders } from './db/driver.ts'
import type { MatchedLine } from './kit-list.ts'

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

export interface AvailabilityLine extends MatchedLine {
  /** How many of this product are physically here and fit to rent. */
  onHand: number
  /** How many the client asked for, carried through from the parsed line. */
  wanted: number
  state: AvailabilityState
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
 * Answer a whole pasted list.
 *
 * A line the parser was not confident about reports `unknown` rather than a
 * number. Counting stock for a product nobody has confirmed is the same
 * mistake as auto-matching it: a real figure attached to a guess reads as
 * fact, and the owner quotes it.
 */
export function checkAvailability(db: SqlDriver, matched: MatchedLine[]): AvailabilitySummary {
  const ids = [...new Set(matched.map((m) => m.productId).filter((id): id is string => !!id))]
  const counts = onHandByProduct(db, ids)

  const lines: AvailabilityLine[] = matched.map((m) => {
    const wanted = m.quantity

    if (!m.productId) {
      return { ...m, onHand: 0, wanted, state: 'unknown' }
    }

    const onHand = counts.get(m.productId) ?? 0
    const state: AvailabilityState =
      onHand >= wanted ? 'available' : onHand > 0 ? 'short' : 'none'

    return { ...m, onHand, wanted, state }
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
