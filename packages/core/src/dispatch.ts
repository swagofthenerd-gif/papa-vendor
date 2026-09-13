import type { SqlDriver, SqlValue } from './db/driver.ts'

/**
 * The dispatcher's rules — how a non-scan op crosses the wire (W9).
 *
 * Scans are the easy case: submit_scan_batch is idempotent per (device,
 * client_seq), the event id is the outbox id, and the server's reply names
 * every op. Everything else — a pencil, a partner house, a borrowed unit —
 * is an RPC the server was built to be called ONCE, that mints its OWN ids,
 * and whose reply is the only place those ids appear. Three rules follow,
 * and they all live here:
 *
 *   1. EXACTLY ONCE. Every non-scan op goes through `replay_op(op_id, rpc,
 *      args)` (0027), which runs the named RPC and files a receipt keyed by
 *      (device, outbox id). A lost response — the server committed, the
 *      phone never heard — is retried, the receipt answers instead of the
 *      RPC, and the phone gets the ORIGINAL reply. Without this a flaky
 *      tunnel books the same camera twice.
 *
 *   2. THE SERVER NAMES THINGS. The phone mints a prefixed id (`bk-…`,
 *      `job-…`) so the desk can keep working offline, writes it into the
 *      mirror, and rides it beside the RPC args as `client_*`. The server's
 *      reply carries the real id; ID_REPLY_RULES says which reply field
 *      answers which client key. The pair is recorded in `id_map`, the
 *      local rows are RE-KEYED to the server's name in the same transaction
 *      as the ack (REKEY_COLUMNS), and every later op still naming the
 *      client id is rewritten before it is sent. From that moment the phone
 *      and the server call the thing by one name.
 *      ASSUMPTION: the phone adopts the server's id the moment the server
 *      accepts. See docs/assumptions.md#server-name-wins
 *
 *   3. A GUESS IS A PREFIX. Rows the phone authored optimistically carry a
 *      prefixed id; rows from the server are bare uuids. That is how the
 *      pull knows which booking lines and reservations were the phone's
 *      guess and replaces them with the server's (pull.ts, "child rows").
 *      The write sides already mint this way; `isClientMinted` is the one
 *      place the rule is spelled.
 */

/** A phone-minted id: anything that is not a bare uuid. */
export function isClientMinted(id: string): boolean {
  return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

/** The SQL form of isClientMinted, for a `where` clause on a text id. */
export const CLIENT_MINTED_SQL =
  `not (length(id) = 36 and id glob '????????-????-????-????-????????????')`

export interface IdReplyRule {
  /** The payload key carrying the phone's id. */
  client: string
  /** The reply field holding the server's id, or '$' for a scalar reply. */
  reply: string
  kind: string
}

/**
 * Per op: which reply field names the server id for which client key.
 * An op absent here mints nothing the phone needs to remember.
 */
export const ID_REPLY_RULES: Record<string, IdReplyRule[]> = {
  create_booking: [{ client: 'client_booking_id', reply: 'booking_id', kind: 'booking' }],
  convert_booking_to_job: [{ client: 'client_job_id', reply: '$', kind: 'job' }],
  upsert_partner_house: [{ client: 'client_partner_id', reply: 'id', kind: 'partner_house' }],
  record_sub_hire_in: [
    { client: 'client_sub_hire_id', reply: 'sub_hire_id', kind: 'sub_hire' },
    { client: 'client_asset_id', reply: 'asset_id', kind: 'asset' },
    { client: 'client_expense_id', reply: 'expense_id', kind: 'expense' },
  ],
  record_sub_hire_out: [
    { client: 'client_sub_hire_id', reply: 'sub_hire_id', kind: 'sub_hire' },
    { client: 'client_job_id', reply: 'job_id', kind: 'job' },
    { client: 'client_customer_id', reply: 'customer_id', kind: 'customer' },
    { client: 'client_ledger_entry_id', reply: 'ledger_entry_id', kind: 'ledger_entry' },
  ],
  upsert_rate_card: [{ client: 'client_card_id', reply: 'id', kind: 'rate_card' }],
  set_calendar_day: [{ client: 'client_day_id', reply: 'id', kind: 'calendar_day' }],
}

/**
 * Where a mirrored id can appear locally, table by table — the columns a
 * re-key rewrites. Core tables only; the app passes its own (job_expected,
 * scan_sessions, the ledger…) through SyncEngine's `rekeyColumns`.
 */
export const REKEY_COLUMNS: Record<string, string[]> = {
  assets: ['id', 'product_id', 'current_location_id', 'current_parent_id', 'current_job_id'],
  asset_tags: ['asset_id'],
  asset_containment: ['parent_asset_id', 'child_asset_id'],
  jobs: ['id', 'customer_id', 'booking_id'],
  bookings: ['id', 'customer_id'],
  booking_lines: ['id', 'booking_id', 'product_id', 'asset_id'],
  asset_reservations: ['id', 'booking_id', 'booking_line_id', 'asset_id'],
  stock_reservations: ['id', 'booking_id', 'booking_line_id', 'product_id'],
  rate_cards: ['id'],
  rate_card_entries: ['id', 'rate_card_id', 'product_id'],
  org_calendar_days: ['id'],
  partner_houses: ['id'],
  sub_hires: [
    'id', 'partner_house_id', 'booking_id', 'job_id', 'product_id', 'asset_id',
    'expense_id', 'ledger_entry_id',
  ],
  job_attendants: ['job_id', 'user_id'],
  condition_photos: ['asset_id', 'job_id'],
  voice_notes: ['asset_id', 'job_id'],
}

/**
 * The per-op argument shape, where the payload is not already `p_*` keyed.
 * bind_tag predates the convention (its payload is the scan-shaped
 * {tag_code, asset_id, device_time}).
 */
const ARGS_FOR: Record<string, (payload: Record<string, unknown>) => Record<string, unknown>> = {
  bind_tag: (p) => ({ p_tag_code: p.tag_code, p_asset_id: p.asset_id }),
}

/** The RPC arguments for an op: its `p_*` keys, client keys stripped. */
export function argsOf(op: string, payload: Record<string, unknown>): Record<string, unknown> {
  const shaped = ARGS_FOR[op]
  if (shaped) return shaped(payload)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (k.startsWith('p_')) out[k] = v
  }
  return out
}

export class IdMap {
  private readonly db: SqlDriver
  private readonly now: () => number

  constructor(db: SqlDriver, now: () => number = Date.now) {
    this.db = db
    this.now = now
  }

  serverIdFor(clientId: string): string | null {
    return this.db.get<{ server_id: string }>(
      `select server_id from id_map where client_id = ?`, [clientId],
    )?.server_id ?? null
  }

  record(clientId: string, serverId: string, kind: string): void {
    this.db.exec(
      `insert into id_map (client_id, server_id, kind, mapped_at) values (?, ?, ?, ?)
       on conflict (client_id) do update set server_id = excluded.server_id, kind = excluded.kind`,
      [clientId, serverId, kind, this.now()],
    )
  }

  /**
   * Rewrite every string in a value that is a known client id — deep, so an
   * id inside `p_lines` is caught as surely as a top-level `p_booking_id`.
   * The map is small (one row per thing this phone named first), so the
   * lookup per string is one indexed read.
   */
  rewrite<T>(value: T): T {
    const seen = new Map<string, string | null>()
    const lookup = (s: string): string => {
      if (!seen.has(s)) seen.set(s, this.serverIdFor(s))
      return seen.get(s) ?? s
    }
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return lookup(v)
      if (Array.isArray(v)) return v.map(walk)
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x)
        return out
      }
      return v
    }
    return walk(value) as T
  }

  /**
   * The mappings an op's reply announces, per ID_REPLY_RULES. Returns the
   * pairs so the caller can re-key in the same transaction.
   */
  mappingsFrom(op: string, payload: Record<string, unknown>, reply: unknown): Array<{ clientId: string; serverId: string; kind: string }> {
    const rules = ID_REPLY_RULES[op]
    if (!rules) return []
    const out: Array<{ clientId: string; serverId: string; kind: string }> = []
    for (const rule of rules) {
      const clientId = payload[rule.client]
      if (typeof clientId !== 'string' || clientId.length === 0) continue
      const serverId = rule.reply === '$'
        ? reply
        : (reply && typeof reply === 'object' ? (reply as Record<string, unknown>)[rule.reply] : undefined)
      if (typeof serverId !== 'string' || serverId.length === 0) continue
      if (serverId === clientId) continue
      out.push({ clientId, serverId, kind: rule.kind })
    }
    return out
  }
}

/**
 * Rename one id everywhere it is stored locally. The caller owns the
 * transaction. `columns` is REKEY_COLUMNS merged with whatever the app adds.
 */
export function rekeyLocal(
  db: SqlDriver,
  clientId: string,
  serverId: string,
  columns: Record<string, string[]> = REKEY_COLUMNS,
): number {
  let touched = 0
  for (const [table, cols] of Object.entries(columns)) {
    for (const col of cols) {
      // The table may not exist on this database (an app table on a bare
      // core schema, or the reverse); asking sqlite_master first keeps the
      // re-key from failing on a table it was told about but never saw.
      if (!tableExists(db, table)) break
      db.exec(`update ${table} set ${col} = ? where ${col} = ?`, [serverId, clientId] as SqlValue[])
      touched++
    }
  }
  return touched
}

const knownTables = new WeakMap<SqlDriver, Set<string>>()
function tableExists(db: SqlDriver, table: string): boolean {
  let set = knownTables.get(db)
  if (!set) { set = new Set(); knownTables.set(db, set) }
  if (set.has(table)) return true
  const row = db.get<{ one: number }>(
    `select 1 as one from sqlite_master where type = 'table' and name = ?`, [table],
  )
  if (row) set.add(table)
  return row !== undefined
}
