import type { SqlDriver } from './db/driver.ts'
import { placeholders } from './db/driver.ts'

/**
 * Group key for items with no location.
 *
 * A leading NUL cannot collide with any real location id. It was previously
 * written as a RAW NUL BYTE in the source, which made this file read as
 * `binary` to grep and ripgrep — so it was silently skipped by repo-wide
 * searches, including the one that went looking for this very pattern. Same
 * value, written as an escape, so the file stays text and tooling works.
 */
const NO_LOCATION = '\u0000unknown'

/**
 * The pull list, ordered the way a person walks.
 *
 * The architecture has locations AND pull lists and never connects them. That
 * connection is this file, and it is close to free: ordering the remaining
 * items by shelf instead of alphabetically means the tech crosses the
 * warehouse ONCE instead of ping-ponging across it for forty items.
 *
 * The screen shows the remaining work grouped by shelf ("Rack A ✓ · Rack B 6
 * left") rather than as a flat list, because "six left" is not actionable and
 * "six left on Rack B" is — it is a place to walk to.
 */

export interface PullListItem {
  assetId: string
  assetCode: string | null
  displayName: string | null
  locationId: string | null
  locationName: string | null
  /** Full path, e.g. "Warehouse / Rack A / Shelf 3" — how it is sorted. */
  locationPath: string | null
  scanned: boolean
}

export interface ShelfGroup {
  locationId: string | null
  locationName: string
  total: number
  remaining: number
  items: PullListItem[]
}

export interface PullListView {
  groups: ShelfGroup[]
  total: number
  scanned: number
  /** Everything still to find, in walking order. */
  outstanding: PullListItem[]
  complete: boolean
}

/**
 * Build the view for a set of expected assets.
 *
 * `scannedIds` comes from the live ScanSession, so this recomputes cheaply on
 * every scan — it is a pure function of local rows plus a Set.
 */
export function buildPullList(
  db: SqlDriver,
  expectedAssetIds: string[],
  scannedIds: Iterable<string>,
): PullListView {
  const scanned = new Set(scannedIds)

  if (expectedAssetIds.length === 0) {
    return { groups: [], total: 0, scanned: 0, outstanding: [], complete: true }
  }

  const marks = placeholders(expectedAssetIds.length)
  const rows = db.all<{
    id: string
    asset_code: string | null
    display_name: string | null
    location_id: string | null
    location_name: string | null
    location_path: string | null
  }>(
    `select a.id, a.asset_code, p.display_name,
            a.current_location_id as location_id,
            l.name as location_name, l.path as location_path
       from assets a
       left join products  p on p.id = a.product_id
       left join locations l on l.id = a.current_location_id
      where a.id in (${marks})`,
    expectedAssetIds,
  )

  // Indexed once, then driven from the expected list. The previous form built
  // the found items and then scanned the WHOLE array per expected id looking
  // for gaps — quadratic, on a list a big pull can push into the hundreds.
  //
  // Driving from expectedAssetIds also makes the guarantee structural rather
  // than a second step that could be forgotten: an expected asset the device
  // has never synced still appears, because it is the loop, not a patch to it.
  // Without that the count is wrong and the tech hunts for something the list
  // denies exists.
  const byId = new Map(rows.map((r) => [r.id, r]))
  const items: PullListItem[] = [...new Set(expectedAssetIds)].map((id) => {
    const r = byId.get(id)
    return {
      assetId: id,
      assetCode: r?.asset_code ?? null,
      displayName: r?.display_name ?? null,
      locationId: r?.location_id ?? null,
      locationName: r?.location_name ?? null,
      locationPath: r?.location_path ?? null,
      scanned: scanned.has(id),
    }
  })

  const byLocation = new Map<string, PullListItem[]>()
  for (const item of items) {
    const key = item.locationId ?? NO_LOCATION
    const group = byLocation.get(key)
    if (group) group.push(item)
    else byLocation.set(key, [item])
  }

  const groups: ShelfGroup[] = [...byLocation.entries()]
    .map(([key, groupItems]) => ({
      locationId: key === NO_LOCATION ? null : key,
      locationName: groupItems[0].locationName ?? 'Location unknown',
      total: groupItems.length,
      remaining: groupItems.filter((i) => !i.scanned).length,
      // Within a shelf, by code — that is the order things are physically
      // labelled, so the eye scans along the row rather than hunting.
      items: groupItems.sort((a, b) => (a.assetCode ?? '').localeCompare(b.assetCode ?? '')),
    }))
    .sort(sortGroups)

  const scannedCount = items.filter((i) => i.scanned).length

  return {
    groups,
    total: items.length,
    scanned: scannedCount,
    outstanding: groups.flatMap((g) => g.items.filter((i) => !i.scanned)),
    complete: scannedCount === items.length,
  }
}

/**
 * Shelves in walking order, with two deliberate exceptions.
 *
 * Finished shelves sink: there is no reason to walk back to a rack you have
 * cleared, and keeping it at the top costs a line of screen on a six-inch
 * phone.
 *
 * Unknown-location items sink furthest, because they need a different
 * behaviour entirely — searching rather than walking — and mixing them into
 * the route sends the tech to a shelf that will not have them.
 */
function sortGroups(a: ShelfGroup, b: ShelfGroup): number {
  const aDone = a.remaining === 0
  const bDone = b.remaining === 0
  if (aDone !== bDone) return aDone ? 1 : -1

  const aUnknown = a.locationId === null
  const bUnknown = b.locationId === null
  if (aUnknown !== bUnknown) return aUnknown ? 1 : -1

  const aPath = a.items[0]?.locationPath ?? a.locationName
  const bPath = b.items[0]?.locationPath ?? b.locationName
  return aPath.localeCompare(bPath, undefined, { numeric: true })
}

/**
 * The one-line summary under the progress bar.
 *
 * On a return this shows MONEY rather than a percentage. "54 of 60" with six
 * left is not 90% good — it is Rs 18,000 unaccounted for, and that is the
 * number that turns a chore into a decision.
 */
export function progressSummary(view: PullListView, maxGroups = 3): string {
  if (view.complete) return 'All accounted for'

  const parts = view.groups
    .filter((g) => g.remaining > 0)
    .slice(0, maxGroups)
    .map((g) => `${g.locationName} ${g.remaining} left`)

  const done = view.groups.filter((g) => g.remaining === 0).length
  const prefix = done > 0 ? `${done} shelf${done === 1 ? '' : 'ves'} clear · ` : ''
  return prefix + parts.join(' · ')
}
