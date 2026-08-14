import type { SqlDriver } from './db/driver.ts'

/**
 * `sync_meta` — the device's small key/value scratchpad.
 *
 * Three keys (`outbox_seq`, `pull_cursor`, `clock_offset_ms`) had each grown
 * their own copy of the same select / coerce / upsert triple in three
 * different files, and the copies had already diverged on the one thing that
 * matters: `row ? Number(row.value) : 0` and `row?.value ? Number(...) : 0`
 * disagree about a STORED ZERO. The second treats `"0"` as absent, because
 * `"0"` is falsy — so a legitimately-zero cursor reads as "never synced".
 *
 * That is the whole argument for this file. Not tidiness: three hand-rolled
 * copies of a coercion is three chances to get null-vs-zero wrong, and it had
 * already happened once.
 */

export function metaGet(db: SqlDriver, key: string): string | undefined {
  return db.get<{ value: string }>(`select value from sync_meta where key = ?`, [key])?.value
}

/**
 * Explicitly `=== undefined`, never a truthiness test. A stored `"0"` is a
 * real value and must survive the round trip.
 */
export function metaGetNumber(db: SqlDriver, key: string, fallback = 0): number {
  const raw = metaGet(db, key)
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function metaSet(db: SqlDriver, key: string, value: string | number): void {
  db.exec(
    `insert into sync_meta (key, value) values (?, ?)
     on conflict (key) do update set value = excluded.value`,
    [key, String(value)],
  )
}
