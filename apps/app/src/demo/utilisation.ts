import type { SqlDriver } from '@papa/core'
import { assetEarnings } from './khata.ts'
import { decodeScanOps } from './read-model.ts'

/**
 * How hard a unit works (year finding `no-utilization-read`, narrowed by
 * W3 to "no fleet ranking of earners — 'which camera earned best' still
 * means opening asset pages one at a time").
 *
 * FOUR NUMBERS, EACH FROM SOMETHING THAT ALREADY EXISTS: days out in a
 * window, from the out→in pairs in the scan log; rental days since
 * service, 0021's own meter; what the unit earned, from the ledger lines
 * that name it; and idle days, the dead-stock rule's own anchor. No new
 * table, no new projection, nothing stored.
 *
 * THE HONEST LIMIT, AND IT IS A REAL ONE. The phone's movement record is
 * its OWN QUEUE (`decodeScanOps`), which the pipe drains — and the assets
 * mirror carries no acquisition date, because `created_at` is not in the
 * pull projection. So:
 *
 *   * "days out" counts what this phone's log still holds, not the unit's
 *     life. On a phone that has synced and pruned, it is a floor.
 *   * "earned per day" is per day SINCE THIS PHONE FIRST SAW THE UNIT, not
 *     per day owned. A camera bought in 2019 and tagged last month reads
 *     as a month old here.
 *
 * Both are said on the screen, in the desk's words, because a number
 * whose limit is only in a code comment is a confident lie. The server's
 * own log and `created_at` are the authority when a utilisation view
 * lands there.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** The default window: 90 days, the same horizon the dead-stock rule uses,
 *  so "busy" and "idle" are measured against one calendar. */
export const UTILISATION_WINDOW_DAYS = 90

/** Local midnight of the date containing `ms` — days are the vendor's
 *  calendar dates, exactly as 0021's meter counts them (partial day = a
 *  full day), never 24-hour blocks. */
function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** One period a unit spent out, from the log. `endMs` null = still out. */
interface OutPeriod {
  assetId: string
  startMs: number
  endMs: number | null
}

/**
 * Every out→in period the phone's log holds, per asset, in order. A
 * check_out with no check_in after it is still out; a check_in with no
 * check_out before it is ignored rather than guessed at (a loose return
 * of gear this phone never saw leave is not evidence of a rental).
 */
export function outPeriods(db: SqlDriver): OutPeriod[] {
  const open = new Map<string, number>()
  const out: OutPeriod[] = []
  for (const op of decodeScanOps(db)) {
    if (!op.assetId) continue
    if (op.eventType === 'check_out') {
      // A second check_out with no return between: the first period ends
      // where the second begins, because one body cannot be out twice.
      const already = open.get(op.assetId)
      if (already !== undefined) out.push({ assetId: op.assetId, startMs: already, endMs: op.createdAt })
      open.set(op.assetId, op.createdAt)
      continue
    }
    if (op.eventType !== 'check_in') continue
    const started = open.get(op.assetId)
    if (started === undefined) continue
    out.push({ assetId: op.assetId, startMs: started, endMs: op.createdAt })
    open.delete(op.assetId)
  }
  for (const [assetId, startMs] of open) out.push({ assetId, startMs, endMs: null })
  return out.sort((a, b) => a.startMs - b.startMs)
}

/**
 * Distinct calendar DATES a set of periods covers inside
 * [fromMs, toMs] — counted as dates rather than summed hours, so a unit
 * out from Tuesday evening to Wednesday morning worked two days, the way
 * the rental-day rule and the service meter both count.
 */
export function daysCovered(
  periods: { startMs: number; endMs: number | null }[],
  fromMs: number,
  toMs: number,
): number {
  const dates = new Set<number>()
  for (const p of periods) {
    const start = Math.max(startOfDay(p.startMs), startOfDay(fromMs))
    const end = Math.min(startOfDay(p.endMs ?? toMs), startOfDay(toMs))
    // A guard, not a filter: one day of drift on a phone clock must not
    // spin this loop (or a period outside the window add a date).
    for (let d = start; d <= end; d = startOfDay(d + DAY_MS + DAY_MS / 2)) dates.add(d)
  }
  return dates.size
}

export interface Utilisation {
  assetId: string
  /** The window, in days — named so the screen never hardcodes 90. */
  windowDays: number
  /** Calendar days inside the window this unit was out, from the log. */
  daysOut: number
  /** daysOut ÷ windowDays as a whole percent — 'busy 34% of the last 90'. */
  busyPct: number
  /** 0021's meter: rental days worked since the last serviced event, and
   *  the product's threshold when it has one. Synced, not derived here. */
  rentalDaysSinceService: number
  serviceDueAfter: number | null
  /** Live rental money naming this unit (khata.ts assetEarnings). */
  earnedMinor: number
  /** Days since this phone first saw the unit at all — the denominator
   *  "per day owned" would want and cannot have. Null with no anchor. */
  knownDays: number | null
  /** earned ÷ knownDays, or null when there is no honest denominator —
   *  the payback bar's rule (no bar against a made-up number). */
  earnedPerDayMinor: number | null
  /** Days since the last check_out this phone's log holds; null when it
   *  has never seen the unit leave. 'Never seen moving' is not 'idle'. */
  idleDays: number | null
  /** Out right now — the reason idleDays is zero rather than unknown. */
  outNow: boolean
}

/** How hard ONE unit works, for its own page. */
export function utilisation(
  db: SqlDriver,
  assetId: string,
  nowMs: number,
  windowDays: number = UTILISATION_WINDOW_DAYS,
): Utilisation {
  const periods = outPeriods(db).filter((p) => p.assetId === assetId)
  const meter = db.get<{ days: number | null; due_after: number | null; last_scanned_at: string | null }>(
    `select a.rental_days_since_service as days,
            p.service_due_after_rental_days as due_after,
            a.last_scanned_at
       from assets a
       left join products p on p.id = a.product_id
      where a.id = ?`,
    [assetId],
  )
  const earned = assetEarnings(db, assetId).earnedMinor

  const scanned = meter?.last_scanned_at ? Date.parse(meter.last_scanned_at) : NaN
  const firstSeen = periods.length > 0
    ? periods[0].startMs
    : Number.isNaN(scanned) ? null : scanned
  const knownDays = firstSeen === null
    ? null
    : Math.max(1, Math.floor((nowMs - startOfDay(firstSeen)) / DAY_MS))

  const lastOut = periods.length > 0 ? periods[periods.length - 1].startMs : null
  const outNow = periods.some((p) => p.endMs === null)
  const daysOut = daysCovered(periods, nowMs - windowDays * DAY_MS, nowMs)

  return {
    assetId,
    windowDays,
    daysOut,
    busyPct: Math.round((daysOut / windowDays) * 100),
    rentalDaysSinceService: Number(meter?.days ?? 0),
    serviceDueAfter:
      meter?.due_after === null || meter?.due_after === undefined ? null : Number(meter.due_after),
    earnedMinor: earned,
    knownDays,
    earnedPerDayMinor: knownDays === null ? null : Math.round(earned / knownDays),
    idleDays: outNow ? 0 : lastOut === null ? null : Math.floor((nowMs - lastOut) / DAY_MS),
    outNow,
  }
}

export interface WorkerRow {
  id: string
  code: string
  name: string
  daysOut: number
  busyPct: number
  earnedMinor: number
  earnedPerDayMinor: number | null
}

/**
 * The fleet ranked by how hard it works — the AUG question ("which camera
 * earned best") that used to mean opening asset pages one at a time, and
 * the reason `no-utilization-read` stayed on the year's list after W3.
 *
 * Ordered by days out inside the window, then by money: a unit that
 * worked twenty days for Rs 400,000 outranks one that worked twenty for
 * Rs 40,000, and a unit nobody rented is last however valuable it is.
 * Live fleet only (disposition null) — terminal gear is gone, not idle.
 */
export function workedHardest(
  db: SqlDriver,
  nowMs: number,
  limit = 5,
  windowDays: number = UTILISATION_WINDOW_DAYS,
): WorkerRow[] {
  const byAsset = new Map<string, OutPeriod[]>()
  for (const p of outPeriods(db)) {
    const list = byAsset.get(p.assetId)
    if (list) list.push(p)
    else byAsset.set(p.assetId, [p])
  }
  const rows = db.all<{ id: string; asset_code: string | null; display_name: string | null }>(
    `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name
       from assets a
       left join products p on p.id = a.product_id
      where a.disposition is null
      order by a.asset_code`,
  )
  return rows
    .map((r) => {
      const periods = byAsset.get(r.id) ?? []
      const daysOut = daysCovered(periods, nowMs - windowDays * DAY_MS, nowMs)
      const earned = assetEarnings(db, r.id).earnedMinor
      return {
        id: r.id,
        code: r.asset_code ?? '—',
        name: r.display_name ?? 'Unnamed',
        daysOut,
        busyPct: Math.round((daysOut / windowDays) * 100),
        earnedMinor: earned,
        earnedPerDayMinor: daysOut === 0 ? null : Math.round(earned / daysOut),
      }
    })
    .filter((r) => r.daysOut > 0 || r.earnedMinor > 0)
    .sort((a, b) => b.daysOut - a.daysOut || b.earnedMinor - a.earnedMinor || a.code.localeCompare(b.code))
    .slice(0, limit)
}
