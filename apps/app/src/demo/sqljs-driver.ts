import initSqlJs, { type Database } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { Row, SqlDriver, SqlValue } from '@papa/core'

/**
 * A SqlDriver backed by sql.js — SQLite compiled to WebAssembly.
 *
 * WHY sql.js AND NOT wa-sqlite, which driver.ts names as the eventual web
 * driver: SqlDriver is entirely SYNCHRONOUS, and that is not an accident. The
 * scan handler may not await anything (CONTRIBUTING principle 1), so every
 * method here has to return a value, not a promise. wa-sqlite's API is async
 * throughout, so adopting it means either an async SqlDriver — which would let
 * a network-shaped await back into the scan path by construction — or a worker
 * and a synchronisation trick. sql.js is synchronous once loaded, so the whole
 * question disappears.
 *
 * The cost is that the database lives in memory and is lost on refresh. For a
 * demo that is the correct trade; for the real console it is not, and that is
 * the point at which this gets revisited rather than now.
 *
 * `init` is the only async part, and it happens once at startup, before any
 * screen renders.
 */
export class SqlJsDriver implements SqlDriver {
  private readonly db: Database
  private depth = 0

  private constructor(db: Database) {
    this.db = db
    this.db.run('pragma foreign_keys = on')
  }

  static async open(): Promise<SqlJsDriver> {
    const SQL = await initSqlJs({ locateFile: () => wasmUrl })
    return new SqlJsDriver(new SQL.Database())
  }

  exec(sql: string, params: SqlValue[] = []): void {
    if (params.length === 0) { this.db.run(sql); return }
    this.db.run(sql, params)
  }

  all<T = Row>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      const out: T[] = []
      while (stmt.step()) out.push(stmt.getAsObject() as T)
      return out
    } finally {
      stmt.free()
    }
  }

  get<T = Row>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  /**
   * Nested calls join the outer transaction rather than opening a second one.
   * Copied in shape from NodeSqliteDriver deliberately: SQLite does not nest,
   * and a second `begin` would silently commit the first one early — which on
   * the outbox means a scan written without its queue row, the one failure the
   * transaction exists to prevent.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++
      try { return fn() } finally { this.depth-- }
    }
    this.db.run('begin')
    this.depth = 1
    try {
      const out = fn()
      this.db.run('commit')
      return out
    } catch (err) {
      this.db.run('rollback')
      throw err
    } finally {
      this.depth = 0
    }
  }
}
