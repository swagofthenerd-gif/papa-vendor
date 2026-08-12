import { DatabaseSync } from 'node:sqlite'
import type { Row, SqlDriver, SqlValue } from './driver.ts'

/**
 * node:sqlite driver.
 *
 * For tests, and only tests — production uses Capacitor SQLite on Android and
 * wa-sqlite over OPFS on the web. It exists because the offline engine has to
 * be exercised against a REAL SQLite: sync bugs produce wrong data rather than
 * crashes and surface weeks later as inventory that does not match reality, so
 * "reproducible at a desk" is the difference between catching them and not.
 */
export class NodeSqliteDriver implements SqlDriver {
  private readonly db: DatabaseSync
  private depth = 0

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec('pragma foreign_keys = on')
  }

  exec(sql: string, params: SqlValue[] = []): void {
    if (params.length === 0) { this.db.exec(sql); return }
    this.db.prepare(sql).run(...params)
  }

  all<T = Row>(sql: string, params: SqlValue[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  get<T = Row>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  /** Nested calls join the outer transaction rather than opening a second one,
   *  which SQLite does not support and which would silently commit early. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) { this.depth++; try { return fn() } finally { this.depth-- } }
    this.db.exec('begin')
    this.depth = 1
    try {
      const out = fn()
      this.db.exec('commit')
      return out
    } catch (err) {
      this.db.exec('rollback')
      throw err
    } finally {
      this.depth = 0
    }
  }

  close(): void { this.db.close() }
}
