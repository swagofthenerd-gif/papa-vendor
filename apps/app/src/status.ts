/**
 * Asset status — the pure part.
 *
 * Deliberately a .ts module rather than living beside the component. Node can
 * strip TYPES from .ts at runtime but cannot transform JSX, so anything in a
 * .tsx file is untestable without a build step. Pure logic that decides what a
 * person sees is exactly the logic worth testing, so it lives here and the
 * component imports it.
 *
 * FOUR BUCKETS, NOT TWELVE. The full state is three columns
 * (presence / health / ownership), because a single twelve-value column cannot
 * represent a sub-rented lens that is currently out on a job. But three axes
 * cannot be rendered as one indicator either, so every glanceable surface
 * collapses to four buckets and the asset page spells out the rest in a
 * sentence, where there is time to read.
 */

export type Presence = 'here' | 'out' | 'in_transit' | 'gone'
export type Health = 'ok' | 'servicing' | 'quarantined'
export type Ownership = 'owned' | 'sub_rented_in'

export type Bucket = 'here' | 'out' | 'attention' | 'gone'

export interface AssetStatus {
  presence: Presence
  health: Health
  ownership?: Ownership
}

/**
 * Collapse three axes to one bucket.
 *
 * HEALTH WINS OVER PRESENCE. A camera that is physically on the shelf but
 * quarantined is not available, and showing it as HERE is the specific lie
 * that gets broken gear re-rented — which the research names as the most
 * damaging class of double-booking.
 */
export function toBucket({ presence, health }: AssetStatus): Bucket {
  if (presence === 'gone') return 'gone'
  if (health !== 'ok') return 'attention'
  if (presence === 'out' || presence === 'in_transit') return 'out'
  return 'here'
}

export const GLYPH: Record<Bucket, string> = {
  here: '●',       // ● filled circle
  out: '▸',        // ▸ right chevron
  attention: '▲',  // ▲ triangle
  gone: '○',       // ○ hollow circle
}

export const LABEL: Record<Bucket, string> = {
  here: 'Here',
  out: 'Out',
  attention: 'Needs a look',
  gone: 'Gone',
}

/**
 * The full state as a SENTENCE, for the asset page.
 *
 * Not a badge and not a row of chips: a person reading an asset page has time
 * to read, and "On job 482 since 3 Apr, due back tomorrow" answers the
 * question a badge only gestures at.
 */
export function statusSentence(
  status: AssetStatus,
  ctx: { jobLabel?: string | null; locationName?: string | null; since?: string | null } = {},
): string {
  const parts: string[] = []

  switch (status.presence) {
    case 'out':
      parts.push(ctx.jobLabel ? `On ${ctx.jobLabel}` : 'Out on a job')
      break
    case 'in_transit':
      parts.push(ctx.locationName ? `In transit on ${ctx.locationName}` : 'In transit')
      break
    case 'gone':
      parts.push('No longer in the fleet')
      break
    default:
      parts.push(ctx.locationName ? `Here, ${ctx.locationName}` : 'Here')
  }

  if (ctx.since) parts.push(`since ${ctx.since}`)
  if (status.health === 'servicing') parts.push('in service')
  if (status.health === 'quarantined') parts.push('quarantined — not bookable')
  if (status.ownership === 'sub_rented_in') parts.push('sub-rented in')

  return parts.join(' · ')
}
