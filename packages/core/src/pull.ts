import type { SqlDriver, SqlValue } from './db/driver.ts'

/**
 * Applying a pull to the local mirrors.
 *
 * THE PROBLEM THIS FILE EXISTS TO SOLVE:
 *
 * A pull carries the server's view. The device may be holding scans the
 * server has not seen yet. Apply the server's view naively and the tech
 * watches their own scan UNDO ITSELF on screen — the row flips from "out" back
 * to "here" seconds after they scanned it, for no reason they can see.
 *
 * That is not a cosmetic glitch. It is the exact moment a person decides the
 * app is unreliable, and from then on they check the shelf instead. Adoption
 * is a cliff, not a curve, and this is one of the ways off it.
 *
 * So: mirrors are replaced by the server's rows, and then every pending
 * optimistic write is REPLAYED on top. The device's own unsent truth always
 * wins locally until the server has actually seen it.
 */

export interface PullPayload {
  cursor: number
  has_more: boolean
  server_time: string
  tables: Record<string, Array<Record<string, unknown>>>
}

/** Mirror tables and the columns we keep locally. */
const MIRROR_COLUMNS: Record<string, string[]> = {
  products: ['id', 'org_id', 'display_name', 'category'],
  assets: [
    'id', 'org_id', 'product_id', 'asset_code', 'serial_number', 'is_container',
    'presence', 'health', 'ownership', 'current_location_id', 'current_parent_id',
    'current_job_id', 'last_scanned_at', 'notes', 'updated_at',
  ],
  asset_tags: ['tag_code', 'asset_id', 'status'],
  locations: ['id', 'org_id', 'name', 'kind', 'path', 'code'],
  jobs: ['id', 'org_id', 'label', 'contact', 'expected_back', 'status'],
}

/** The primary key each mirror is keyed on locally. */
const MIRROR_KEY: Record<string, string> = {
  products: 'id',
  assets: 'id',
  asset_tags: 'tag_code',
  locations: 'id',
  jobs: 'id',
}

export interface ApplyReport {
  cursor: number
  upserted: number
  deleted: number
  /** Assets whose local optimistic state was preserved over the server's. */
  protectedAssets: string[]
}

export class PullApplier {
  private readonly db: SqlDriver

  constructor(db: SqlDriver) {
    this.db = db
  }

  cursor(): number {
    const row = this.db.get<{ value: string }>(
      `select value from sync_meta where key = 'pull_cursor'`,
    )
    return row ? Number(row.value) : 0
  }

  /**
   * Apply one page.
   *
   * Idempotent: replaying the same page changes nothing. That matters because
   * a page can arrive twice — the response was received but the app was killed
   * before the cursor was persisted, which on a warehouse phone with an
   * aggressive OEM battery killer is a routine Tuesday.
   */
  apply(payload: PullPayload): ApplyReport {
    return this.db.transaction(() => {
      let upserted = 0
      let deleted = 0

      for (const [table, rows] of Object.entries(payload.tables ?? {})) {
        const columns = MIRROR_COLUMNS[table]
        const key = MIRROR_KEY[table]
        // Tables synced by the server but not mirrored locally (kit templates,
        // containment) are ignored rather than erroring — the server may add a
        // table before this build knows about it, and a hard failure there
        // would stop sync entirely for an older client.
        if (!columns || !key) continue

        for (const row of rows) {
          // Soft deletes ARE the tombstones: a deleted row keeps syncing, and
          // the client removes it. That is what makes a delete impossible to
          // miss for a device that was offline when it happened.
          if (row.deleted_at) {
            this.db.exec(`delete from ${table} where ${key} = ?`, [row[key] as SqlValue])
            deleted++
            continue
          }

          const values = columns.map((c) => normalise(row[c]))
          this.db.exec(
            `insert into ${table} (${columns.join(', ')})
             values (${columns.map(() => '?').join(', ')})
             on conflict (${key}) do update set
               ${columns.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(', ')}`,
            values,
          )
          upserted++
        }
      }

      const protectedAssets = this.replayPendingWrites()

      this.db.exec(
        `insert into sync_meta (key, value) values ('pull_cursor', ?)
         on conflict (key) do update set value = excluded.value`,
        [String(payload.cursor)],
      )

      return { cursor: payload.cursor, upserted, deleted, protectedAssets }
    })
  }

  /**
   * Re-apply the optimistic effect of every unsent write.
   *
   * Runs INSIDE the same transaction as the upserts, so there is never a
   * moment — not even one frame — where the UI could render the server's stale
   * view of an asset the tech has just scanned.
   *
   * Ordered by seq so that a check_out followed by a check_in lands the same
   * way it was scanned.
   */
  private replayPendingWrites(): string[] {
    const pending = this.db.all<{ payload: string }>(
      `select payload from outbox where state in ('pending','inflight') order by seq`,
    )
    const touched = new Set<string>()

    for (const { payload } of pending) {
      let op: Record<string, unknown>
      try {
        op = JSON.parse(payload)
      } catch {
        continue      // a malformed row must not stop the whole sync
      }

      const assetId = op.asset_id
      if (typeof assetId !== 'string') continue

      const presence =
        op.event_type === 'check_out' ? 'out' : op.event_type === 'check_in' ? 'here' : null
      if (!presence) continue

      this.db.exec(
        `update assets set presence = ?, current_job_id = ? where id = ?`,
        [presence, presence === 'out' ? ((op.job_id as SqlValue) ?? null) : null, assetId],
      )
      touched.add(assetId)
    }

    return [...touched]
  }

  /**
   * Wipe the mirrors and start over, keeping the outbox.
   *
   * The recovery path for a corrupted or hopelessly stale local database. It
   * MUST NOT touch the outbox: those rows exist nowhere else, and clearing
   * them would silently destroy scans the server has never seen. That is the
   * single most destructive thing this codebase could do, so it is spelled out
   * rather than left to whoever writes the settings screen.
   */
  resetMirrors(): void {
    this.db.transaction(() => {
      for (const table of Object.keys(MIRROR_COLUMNS)) {
        this.db.exec(`delete from ${table}`)
      }
      this.db.exec(`delete from sync_meta where key = 'pull_cursor'`)
    })
  }
}

/** SQLite has no boolean and no undefined. */
function normalise(v: unknown): SqlValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  return String(v)
}
