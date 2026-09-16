import type {
  DeviceDriverFactory,
  DeviceKeyProvider,
  Row,
  SqlDriver,
  SqlValue,
} from '@papa/core'

/**
 * The device database: SQLCipher on Android, reached through a SYNCHRONOUS
 * JavaScript bridge.
 *
 * ---------------------------------------------------------------------------
 * WHY A BRIDGE AND NOT A CAPACITOR PLUGIN
 *
 * `SqlDriver` is synchronous. exec/all/get/transaction return values, not
 * promises, and that is the load-bearing decision of the whole offline
 * engine: the scan handler may not await anything (CONTRIBUTING principle 1),
 * so every read model, every projection and every test is written against a
 * driver that answers immediately. Making it async is a rewrite of the engine
 * and would let a network-shaped `await` back into the scan path by
 * construction.
 *
 * Capacitor plugin calls are asynchronous — they cross the bridge as JSON
 * messages and resolve on a later task. There is no way to await one inside a
 * synchronous function.
 *
 * `@JavascriptInterface` is the exception. A method Android exposes with
 * `addJavascriptInterface` is called SYNCHRONOUSLY from JavaScript, on the
 * calling thread, and returns a String. That is exactly the shape SqlDriver
 * needs, so the database bridge is a `@JavascriptInterface` object and NOT a
 * Capacitor plugin. The printer, which is nowhere near the scan path, is an
 * ordinary async plugin-shaped bridge (see ../print/bt-printer.ts).
 *
 * THE JAVA SURFACE IS DELIBERATELY TINY — six SQL methods, the key, the wipe
 * and a diagnostic header read. Everything else is here, in TypeScript, where
 * it can be tested under Node against a fake bridge of the same shape
 * (apps/app/test/device-driver.test.mjs). Java that cannot be unit-tested on
 * this machine is Java that is verified by reading, and reading is how the
 * last three defects got in.
 *
 * VALUES CROSS AS JSON, in the driver's three types only: string | number |
 * null. Not booleans (node:sqlite refuses them, so the tested driver and the
 * shipped driver agree), not blobs (the schema has none — photo bytes live on
 * the filesystem behind PhotoStore).
 * ---------------------------------------------------------------------------
 */

/**
 * The Java object on `window.PapaSql`.
 *
 * Every method returns a String because that is all `@JavascriptInterface`
 * can return. Two conventions, both checked here:
 *   - open/exec/begin/commit/rollback/wipe return `''` on success and the
 *     error message otherwise. An empty string can never be a real error, so
 *     there is no ambiguity to resolve.
 *   - all/key return JSON: a row array / `{"key":"…"}` on success, and
 *     `{"error":"…"}` on failure. An object where an array belongs is the
 *     failure signal, so a driver that forgets to check gets a type error
 *     rather than silently seeing zero rows.
 */
export interface PapaSqlBridge {
  /** Open (or create) the database with this passphrase. */
  open(keyB64: string): string
  /** One statement, no rows out. `paramsJson` is a JSON array. */
  exec(sql: string, paramsJson: string): string
  /** Rows out, as a JSON array of objects. */
  all(sql: string, paramsJson: string): string
  begin(): string
  commit(): string
  rollback(): string
  /** Read-or-create the device key. `{"key":"<base64>"}` or `{"error":"…"}`. */
  key(): string
  /** Delete the key AND the database file. Guarded in TypeScript, not here. */
  wipe(): string
  /**
   * The first bytes of the database file as lowercase hex, or `''` when there
   * is no file yet.
   *
   * Diagnostic, and it earns its place: it is what lets the phone show its
   * own proof that the file on disk is ciphertext, without a cable and adb.
   * A plaintext SQLite file begins with the ASCII "SQLite format 3\0"
   * (53514c69746520666f726d6174203300); a SQLCipher file begins with its
   * random salt. The This-phone screen renders the difference.
   */
  header(): string
}

/** The name the refusal error and the This-phone screen both use. */
export const CAPACITOR_SQLCIPHER = 'capacitor-sqlcipher'

/** How many bytes `header()` is asked for, and the screen compares. */
export const HEADER_BYTES = 16

/** The magic a PLAINTEXT SQLite file starts with. Never seen on a device. */
export const PLAINTEXT_MAGIC_HEX = '53514c69746520666f726d6174203300'

/** Anything the bridge refused: a failed statement, a failed open, a wipe. */
export class DeviceSqlError extends Error {
  // Explicit field + assignment, never a constructor parameter property:
  // Node strips types but cannot EMIT code, and a parameter property is a
  // code transform. The same constraint packages/core lives under, and it
  // is what lets this module be tested under Node at all.
  readonly sql: string | undefined

  constructor(message: string, sql?: string) {
    super(sql ? `${message} — while running: ${sql.slice(0, 200)}` : message)
    this.name = 'DeviceSqlError'
    this.sql = sql
  }
}

/**
 * A wipe was asked for while evidence was still only on this phone.
 *
 * device-key.ts's comment on `wipe()` is load-bearing: unsent scans, unsent
 * photos and unsent voice notes exist NOWHERE ELSE — not on the server, not
 * anywhere — so a wipe has to be a deliberate act with a flush attempted
 * first, never an automatic response to something transient. `force` is the
 * deliberate act; this error is what happens without it.
 */
export class UnsentEvidenceError extends Error {
  readonly unsent: number | null

  constructor(unsent: number | null) {
    super(
      unsent === null
        ? 'Refusing to wipe: this phone has not been opened, so what is still unsent cannot be counted. ' +
            'Open the database first, or pass force if the data is genuinely being abandoned.'
        : `Refusing to wipe: ${unsent} piece${unsent === 1 ? '' : 's'} of evidence (queued writes, ` +
            `un-uploaded photos or voice notes) exist only on this phone. Sync first, or pass force.`,
    )
    this.name = 'UnsentEvidenceError'
    this.unsent = unsent
  }
}

/** The bridge, or null in a browser. Never throws — absence is the browser. */
export function papaSqlBridge(): PapaSqlBridge | null {
  const host = globalThis as unknown as { PapaSql?: Partial<PapaSqlBridge> }
  const bridge = host.PapaSql
  if (!bridge) return null
  const required: (keyof PapaSqlBridge)[] = [
    'open', 'exec', 'all', 'begin', 'commit', 'rollback', 'key', 'wipe', 'header',
  ]
  // A partial bridge is a BUILD mismatch (a new web bundle on an old shell),
  // and treating it as "no bridge" would silently fall back to the in-memory
  // browser database on a real phone — a whole day's scans lost at the next
  // kill. Absent is the browser; partial is a fault.
  const missing = required.filter((m) => typeof bridge[m] !== 'function')
  if (missing.length === required.length) return null
  if (missing.length > 0) {
    throw new DeviceSqlError(
      `The Android SQL bridge is missing ${missing.join(', ')} — the web bundle and the app shell are different builds.`,
    )
  }
  return bridge as PapaSqlBridge
}

/**
 * Split a script into single statements.
 *
 * Android's `execSQL` runs ONE statement; `migrateLocal` hands the driver
 * whole scripts (LOCAL_SCHEMA, DEMO_SCHEMA, NETWORK_SCHEMA and each migration
 * step). Splitting happens here rather than in Java for the reason the whole
 * file gives: this runs under Node in the test suite, and a naive `.split(';')`
 * — which is what Java would have got — cuts inside string literals and
 * inside the `--` comments the schema is full of.
 *
 * Handles `--` line comments, `/* … *\/` blocks, `'…'` literals with `''`
 * escapes, `"…"` and `[…]` and backtick identifiers. No trigger bodies exist
 * in the local schema; a `begin … end` block would need more than this and
 * the guard below says so out loud.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = []
  let current = ''
  let i = 0
  while (i < script.length) {
    const c = script[i]!
    const next = script[i + 1]
    if (c === '-' && next === '-') {
      while (i < script.length && script[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < script.length && !(script[i] === '*' && script[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === `'` || c === '"' || c === '`') {
      current += c
      i++
      while (i < script.length) {
        if (script[i] === c && script[i + 1] === c) { current += c + c; i += 2; continue }
        if (script[i] === c) { current += c; i++; break }
        current += script[i]
        i++
      }
      continue
    }
    if (c === '[') {
      while (i < script.length && script[i] !== ']') { current += script[i]; i++ }
      current += ']'
      i++
      continue
    }
    if (c === ';') {
      if (current.trim().length > 0) out.push(current.trim())
      current = ''
      i++
      continue
    }
    current += c
    i++
  }
  if (current.trim().length > 0) out.push(current.trim())
  return out
}

/**
 * Params, checked before they cross.
 *
 * `JSON.stringify([NaN])` is `[null]`. A NaN timestamp would therefore land
 * in the database as NULL with nothing raised anywhere — the exact shape of
 * bug this codebase treats as the worst kind, because it surfaces weeks later
 * as a row that renders blank. Every value is checked instead.
 */
export function encodeParams(params: SqlValue[]): string {
  for (const [index, p] of params.entries()) {
    if (p === null) continue
    if (typeof p === 'string') continue
    if (typeof p === 'number') {
      if (Number.isFinite(p)) continue
      throw new DeviceSqlError(`Parameter ${index + 1} is ${String(p)}; SQLite has no such number.`)
    }
    throw new DeviceSqlError(
      `Parameter ${index + 1} is a ${typeof p}; the driver takes string, number or null only.`,
    )
  }
  return JSON.stringify(params)
}

/**
 * SqlDriver over the bridge.
 *
 * Nested `transaction()` calls JOIN the outer transaction rather than opening
 * a second one — a depth counter, the same shape as NodeSqliteDriver and
 * SqlJsDriver, character for character in behaviour. SQLite does not nest
 * transactions, and a second `begin` would silently commit the first early,
 * which on the outbox means a scan written WITHOUT its queue row: the one
 * failure the transaction exists to prevent.
 *
 * Savepoints were considered and rejected. They would let an inner failure
 * roll back only the inner work, which sounds strictly better — but it would
 * make the shipped driver behave differently from the two drivers every test
 * in the repo runs against, and a behavioural difference between the tested
 * and the shipped database layer is precisely how offline bugs become
 * inventory that does not match reality. Parity is worth more than the
 * nicety. If savepoints are wanted later they belong in all three drivers, in
 * one commit, with the outbox tests re-run.
 */
export class CapacitorSqlcipherDriver implements SqlDriver {
  private readonly bridge: PapaSqlBridge
  private depth = 0

  constructor(bridge: PapaSqlBridge) {
    this.bridge = bridge
  }

  exec(sql: string, params: SqlValue[] = []): void {
    // Params belong to ONE statement: a script with placeholders is a caller
    // error, not something to guess at, so it is passed through whole.
    if (params.length > 0) {
      this.said(this.bridge.exec(sql, encodeParams(params)), sql)
      return
    }
    for (const statement of splitStatements(sql)) {
      this.said(this.bridge.exec(statement, '[]'), statement)
    }
  }

  all<T = Row>(sql: string, params: SqlValue[] = []): T[] {
    const raw = this.bridge.all(sql, encodeParams(params))
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new DeviceSqlError(`The SQL bridge answered with something that is not JSON: ${raw.slice(0, 200)}`, sql)
    }
    if (Array.isArray(parsed)) return parsed as T[]
    const message = (parsed as { error?: unknown } | null)?.error
    throw new DeviceSqlError(typeof message === 'string' ? message : `Unexpected answer: ${raw.slice(0, 200)}`, sql)
  }

  get<T = Row>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++
      try { return fn() } finally { this.depth-- }
    }
    this.said(this.bridge.begin())
    this.depth = 1
    try {
      const out = fn()
      this.said(this.bridge.commit())
      return out
    } catch (err) {
      // A rollback that itself fails must not replace the real error: the
      // caller needs to know what went wrong inside the transaction, not
      // that the cleanup was also unhappy.
      try { this.said(this.bridge.rollback()) } catch { /* the original error wins */ }
      throw err
    } finally {
      this.depth = 0
    }
  }

  /** The first bytes of the file on disk, as hex. `''` before any write. */
  header(): string {
    return this.bridge.header()
  }

  private said(answer: string, sql?: string): void {
    if (answer === '') return
    throw new DeviceSqlError(answer, sql)
  }
}

/**
 * The factory `openDeviceDatabase` will accept.
 *
 * `protection: 'encrypted'` is a CLAIM, and a claim is worth nothing on its
 * own — so it is backed twice. Here: an empty key never reaches `open`.
 * In Java: the bridge refuses a key that is empty or that is not the key the
 * Keystore holds, so a caller who somehow got past this cannot open the file
 * unencrypted either. SQLCipher opens an empty-keyed database in PLAINTEXT
 * without error, which makes this the most dangerous single line in the wave.
 */
export function capacitorSqlcipherFactory(bridge: PapaSqlBridge): DeviceDriverFactory {
  return {
    protection: 'encrypted',
    name: CAPACITOR_SQLCIPHER,
    open(key: string): SqlDriver {
      if (key.length === 0) {
        throw new DeviceSqlError(
          'Refusing to open the device database with an empty key: SQLCipher would open it in plaintext and say nothing.',
        )
      }
      const said = bridge.open(key)
      if (said !== '') throw new DeviceSqlError(said)
      return new CapacitorSqlcipherDriver(bridge)
    },
  }
}

/**
 * How much evidence exists ONLY on this phone — or null if it cannot be told.
 *
 * The three device-only kinds that a wipe destroys irrecoverably: queued
 * writes (the outbox keeps only what the server has not provably taken —
 * delivered rows are deleted), un-uploaded condition photos, and un-uploaded
 * voice notes. `sync_meta` and `id_map` are device-only too but they are
 * memory, not evidence: losing them costs a re-sync, not a fact.
 *
 * A MISSING TABLE IS ZERO; ANY OTHER FAILURE IS NULL. The difference
 * matters, because null refuses the wipe. A database opened before
 * `migrateLocal` genuinely has nothing to lose. A query that fails for any
 * other reason — the file locked, the database half-open, something nobody
 * has thought of — is a question that could not be answered, and answering
 * "nothing" to it would be the automatic response to a transient condition
 * that device-key.ts's comment on `wipe()` forbids in as many words.
 */
export function unsentEvidence(db: SqlDriver): number | null {
  let unknown = false
  const count = (sql: string): number => {
    try {
      return Number(db.get<{ n: number }>(sql)?.n ?? 0)
    } catch (e) {
      if (/no such table/i.test(e instanceof Error ? e.message : String(e))) return 0
      unknown = true
      return 0
    }
  }
  const total =
    count(`select count(*) as n from outbox`) +
    count(`select count(*) as n from condition_photos where uploaded = 0`) +
    count(`select count(*) as n from voice_notes where uploaded = 0`)
  return unknown ? null : total
}

/**
 * The key, from the Android Keystore by way of EncryptedSharedPreferences.
 *
 * device-key.ts settles the design and this only implements it: 32 random
 * bytes generated ONCE on first open, held in EncryptedSharedPreferences
 * whose master key lives in the Keystore (hardware-backed where the phone has
 * the hardware, non-exportable either way), `setUserAuthenticationRequired`
 * false — the PIN gates the SESSION, the Keystore holds the KEY, and they
 * protect different things.
 *
 * THE KEY DOES CROSS INTO JAVASCRIPT, and that is worth saying plainly rather
 * than hiding: `DeviceKeyProvider.getKey()` returns the passphrase, because
 * SqlDriver is synchronous and the passphrase is what SQLCipher's `PRAGMA key`
 * takes. So for the life of the app process the key is reachable from the
 * WebView's heap. What that costs and what it does not is written down in
 * docs/android.md; the alternative — an opaque handle — would mean the
 * contract's empty-key guard guarded nothing, which is a worse trade.
 *
 * ASSUMPTION: the key crosses as a PASSPHRASE, so SQLCipher derives the file
 * key with PBKDF2 at its default iteration count — a few hundred
 * milliseconds once, at open, unmeasured on a cheap phone.
 * See docs/assumptions.md#sqlcipher-kdf-cost
 */
export class CapacitorKeyProvider implements DeviceKeyProvider {
  /**
   * @param unsent How much evidence is unsent, or null when the database is
   *   not open and it cannot be known. Null refuses a wipe: "cannot count"
   *   is not "nothing to lose".
   */
  private readonly bridge: PapaSqlBridge
  private readonly unsent: () => number | null

  constructor(bridge: PapaSqlBridge, unsent: () => number | null = () => null) {
    this.bridge = bridge
    this.unsent = unsent
  }

  async getKey(): Promise<string> {
    const raw = this.bridge.key()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new DeviceSqlError(`The Keystore bridge answered with something that is not JSON: ${raw.slice(0, 200)}`)
    }
    const answer = parsed as { key?: unknown; error?: unknown } | null
    if (typeof answer?.error === 'string') throw new DeviceSqlError(answer.error)
    if (typeof answer?.key !== 'string') throw new DeviceSqlError('The Keystore bridge returned no key.')
    // Not a length check on a secret's contents — a check that the provider
    // did not hand back the one value SQLCipher reads as "no encryption".
    if (answer.key.length === 0) throw new DeviceSqlError('The Keystore returned an empty key.')
    return answer.key
  }

  /**
   * Destroy the key and the database file.
   *
   * `force` widens the contract's `wipe(): Promise<void>` rather than
   * replacing it, so this is still a DeviceKeyProvider — and a caller who
   * passes nothing gets the refusing behaviour, which is the right default
   * for the one operation in the app that cannot be undone.
   */
  async wipe(force = false): Promise<void> {
    if (!force) {
      const unsent = this.unsent()
      if (unsent === null || unsent > 0) throw new UnsentEvidenceError(unsent)
    }
    const said = this.bridge.wipe()
    if (said !== '') throw new DeviceSqlError(said)
  }
}
