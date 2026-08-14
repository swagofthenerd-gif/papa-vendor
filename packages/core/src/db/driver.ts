/**
 * The narrowest SQLite surface the core needs.
 *
 * Deliberately tiny, because it has three very different implementations:
 *   - Capacitor SQLite on Android (the warehouse scanner)
 *   - wa-sqlite over OPFS on the web (the desk console)
 *   - node:sqlite in tests
 *
 * Keeping it to four methods means the offline engine can be exercised against
 * a real SQLite in tests with no native modules and no build step, which is
 * the only way the sync logic gets tested at all. Offline bugs produce WRONG
 * DATA rather than crashes, and are discovered weeks later as inventory that
 * does not match reality — so they have to be reproducible at a desk.
 */
export interface SqlDriver {
  /** Statements with no result: DDL, INSERT, UPDATE. */
  exec(sql: string, params?: SqlValue[]): void
  /** Rows out. */
  all<T = Row>(sql: string, params?: SqlValue[]): T[]
  /** First row, or undefined. */
  get<T = Row>(sql: string, params?: SqlValue[]): T | undefined
  /**
   * Run a unit of work atomically.
   *
   * Load-bearing for the outbox: enqueuing a scan writes BOTH the optimistic
   * local state and the queue row. If those can separate, the UI shows a scan
   * that will never be sent, which is the single worst failure mode available
   * to us — the tech believes the gear is accounted for and it is not.
   */
  transaction<T>(fn: () => T): T
}

export type SqlValue = string | number | null
export type Row = Record<string, SqlValue>

/**
 * `?, ?, ?` for an IN clause or a VALUES row.
 *
 * Hand-rolled as `xs.map(() => '?').join(', ')` in four places. Centralised
 * mainly so the empty case has ONE answer: `in ()` is a syntax error in
 * SQLite, and each of those four sites was one unguarded empty array away
 * from it.
 */
export function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ')
}
