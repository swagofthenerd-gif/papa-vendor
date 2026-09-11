import {
  Outbox,
  liveExpenses,
  markTerminal,
  projectLedger,
  stolenBroadcastText,
  askTheMarketText,
  type BroadcastLang,
  type LedgerEntryKind,
  type ShortageLine,
  type SqlDriver,
  type StolenBroadcastFacts,
} from '@papa/core'
import { closeJob, createJob, stillOutCount } from './read-model.ts'
import { createCustomer, getSetting, recordEntry, setSetting } from './khata.ts'
import { expenseRows, recordExpense } from './kharcha.ts'

/**
 * The network on the phone — partner houses, sub-hire in and out, crew on
 * the job, the stolen broadcast facts and the ask-the-market text
 * (migration 0025; vendor-dream-plan Phase E). A plain .ts module in the
 * khata.ts / bookings.ts tradition: every rule here runs under Node
 * against a real SQLite (test/network.test.mjs), and store.ts only binds
 * the database, the clock and the string table.
 *
 * WHAT WRITES LOOK LIKE. Each door mirrors its RPC's refusals as RESULTS
 * (never throws — the sheet renders the reason), writes the local rows
 * optimistically in ONE transaction, and queues the RPC op the server
 * replays. Partner houses and sub-hires never sync back (0025 D1/D2: the
 * phone is PII, the amounts are commercial), so on this wave the local
 * rows ARE the desk's copy; on the real pipe the desk role reads them
 * through RPC-backed reads and the write path is unchanged.
 *
 * THE MONEY GOES ON THE BOOK IT BELONGS TO (0025 D2). Borrowing IN writes
 * an org_expenses row through recordExpense (kind sub_hire, counterparty
 * = the partner's name) — so job_margin and the kharcha book see it with
 * no new code. Lending OUT writes a ledger charge on the partner's
 * CUSTOMER row (D3: a partner that borrows is a customer, found by name
 * or created, linked here so the page can find its khata). A null amount
 * writes NO money row (D6 — ASSUMPTION #sub-hire-unpriced): the sub-hire
 * is the counted, unpriced fact.
 *
 * LENDING OUT RIDES THE SCAN WORLD (D4): the lend creates an ordinary job
 * 'Sub-hire → <partner>' through createJob, and the desk scans the unit
 * out onto it like any client's. presence='out' + current_job_id = the
 * sub-hire job IS "lent to Kamran"; there is no second flag.
 *
 * BORROWING IN IS AN assets ROW (D5): with a serial, the unit joins the
 * mirror with ownership='sub_rented_in' and a locally minted code (the
 * server mints its own; ASSUMPTION #local-asset-code). From then on it
 * tags, scans and counts like any unit. Coming home is a `retire` event
 * the projection stamps returned_to_owner (project.ts).
 */

// ---------------------------------------------------------------- schema

/**
 * Demo-only tables beside the 0025 mirrors in LOCAL_SCHEMA:
 *
 *   staff — the house's people, for the crew picker. The server has
 *   users + memberships (0001/0016); the phone carries no user table yet
 *   (pre-auth), so the demo seeds a short roster. ASSUMPTION #staff-roster.
 *
 *   partner_customer_links — which customer row a partner house borrows
 *   under (D3), so the partner page can open its khata without a second
 *   name match. Mirrors customers.is_partner, which the local customers
 *   table does not carry.
 */
export const NETWORK_SCHEMA = /* sql */ `
create table if not exists staff (
  id           text primary key,
  org_id       text not null,
  display_name text not null,
  role         text not null default 'tech'
);
create table if not exists partner_customer_links (
  partner_house_id text primary key,
  customer_id      text not null
);
`

const iso = (ms: number): string => new Date(ms).toISOString()
const tstzrange = (fromMs: number, untilMs: number): string => `[${iso(fromMs)},${iso(untilMs)})`

export interface NetworkIds {
  now: () => number
  newId: () => string
}

const defaultIds = (nowMs: number): NetworkIds => ({
  now: () => nowMs,
  newId: () => crypto.randomUUID(),
})

// -------------------------------------------------------------- partners

export interface PartnerRow {
  id: string
  name: string
  phone: string | null
  city: string
  notes: string | null
  whatsappGroupNote: string | null
  /** Open sub-hires with this partner, by direction — what the remove
   *  door refuses on, and what the list row says at a glance. */
  openIn: number
  openOut: number
}

interface PartnerDbRow {
  id: string
  name: string
  phone: string | null
  city: string
  notes: string | null
  whatsapp_group_note: string | null
  open_in: number
  open_out: number
}

const PARTNER_SELECT = `
  select p.id, p.name, p.phone, p.city, p.notes, p.whatsapp_group_note,
         (select count(*) from sub_hires s where s.partner_house_id = p.id
            and s.returned_at is null and s.direction = 'in') as open_in,
         (select count(*) from sub_hires s where s.partner_house_id = p.id
            and s.returned_at is null and s.direction = 'out') as open_out
    from partner_houses p`

function partnerOf(r: PartnerDbRow): PartnerRow {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    city: r.city,
    notes: r.notes,
    whatsappGroupNote: r.whatsapp_group_note,
    openIn: Number(r.open_in),
    openOut: Number(r.open_out),
  }
}

/** Every live partner house, by name. */
export function partners(db: SqlDriver): PartnerRow[] {
  return db
    .all<PartnerDbRow>(`${PARTNER_SELECT} where p.deleted_at is null order by lower(p.name)`)
    .map(partnerOf)
}

/** One live partner, or null. */
export function partner(db: SqlDriver, id: string): PartnerRow | null {
  const r = db.get<PartnerDbRow>(`${PARTNER_SELECT} where p.id = ? and p.deleted_at is null`, [id])
  return r ? partnerOf(r) : null
}

export interface UpsertPartnerInput {
  /** Given on edit; absent to create. */
  id?: string | null
  name: string
  phone?: string | null
  city?: string | null
  notes?: string | null
  whatsappGroupNote?: string | null
}

export type UpsertPartnerResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'blank_name' | 'duplicate_name' | 'not_found' }

/**
 * Create or edit a partner house — the RPC's rules: a name is required,
 * one spelling per org (case-insensitive), city defaults to Lahore, and
 * on edit a blank field KEEPS the old value (null means "keep").
 */
export function upsertPartner(
  db: SqlDriver,
  orgId: string,
  input: UpsertPartnerInput,
  nowMs: number,
  ids: NetworkIds = defaultIds(nowMs),
): UpsertPartnerResult {
  const name = input.name.trim()
  if (name.length === 0) return { ok: false, reason: 'blank_name' }
  const clean = (v: string | null | undefined): string | null => {
    const t = v?.trim() ?? ''
    return t.length === 0 ? null : t
  }

  const twin = db.get<{ id: string }>(
    `select id from partner_houses where lower(name) = lower(?) and deleted_at is null`,
    [name],
  )
  if (twin && twin.id !== input.id) return { ok: false, reason: 'duplicate_name' }

  const outbox = new Outbox(db, ids.now)
  if (!input.id) {
    const id = `partner-${ids.newId()}`
    db.transaction(() => {
      db.exec(
        `insert into partner_houses
           (id, org_id, name, phone, whatsapp_group_note, city, notes, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, orgId, name, clean(input.phone), clean(input.whatsappGroupNote),
          clean(input.city) ?? 'Lahore', clean(input.notes), iso(nowMs), iso(nowMs),
        ],
      )
      outbox.enqueue({
        id: ids.newId(),
        op: 'upsert_partner_house',
        payload: {
          client_partner_id: id,
          p_name: name,
          p_phone: clean(input.phone),
          p_whatsapp_group_note: clean(input.whatsappGroupNote),
          p_city: clean(input.city),
          p_notes: clean(input.notes),
        },
      })
    })
    return { ok: true, id }
  }

  const id = input.id
  const existing = db.get<{ id: string }>(
    `select id from partner_houses where id = ? and deleted_at is null`,
    [id],
  )
  if (!existing) return { ok: false, reason: 'not_found' }
  db.transaction(() => {
    db.exec(
      `update partner_houses
          set name = ?,
              phone = coalesce(?, phone),
              whatsapp_group_note = coalesce(?, whatsapp_group_note),
              city = coalesce(?, city),
              notes = coalesce(?, notes),
              updated_at = ?
        where id = ?`,
      [
        name, clean(input.phone), clean(input.whatsappGroupNote), clean(input.city),
        clean(input.notes), iso(nowMs), id,
      ],
    )
    outbox.enqueue({
      id: ids.newId(),
      op: 'upsert_partner_house',
      payload: {
        client_partner_id: id,
        p_id: id,
        p_name: name,
        p_phone: clean(input.phone),
        p_whatsapp_group_note: clean(input.whatsappGroupNote),
        p_city: clean(input.city),
        p_notes: clean(input.notes),
      },
      dependsOn: lastPartnerOp(db, id),
    })
  })
  return { ok: true, id }
}

export type RemovePartnerResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'open_sub_hires'; open: number }

/** Soft-delete — refused while a sub-hire with this partner is still open:
 *  the gear (or the money) has not come home. The RPC's rule. */
export function removePartner(
  db: SqlDriver,
  id: string,
  nowMs: number,
  ids: NetworkIds = defaultIds(nowMs),
): RemovePartnerResult {
  const p = partner(db, id)
  if (!p) return { ok: false, reason: 'not_found' }
  const open = p.openIn + p.openOut
  if (open > 0) return { ok: false, reason: 'open_sub_hires', open }
  db.transaction(() => {
    db.exec(`update partner_houses set deleted_at = ?, updated_at = ? where id = ?`, [iso(nowMs), iso(nowMs), id])
    new Outbox(db, ids.now).enqueue({
      id: ids.newId(),
      op: 'remove_partner_house',
      payload: { client_partner_id: id, p_id: id },
      dependsOn: lastPartnerOp(db, id),
    })
  })
  return { ok: true }
}

/** The most recent queued op naming this partner — what the next one
 *  chains behind, so the pipe replays create → edit → sub-hire in order.
 *  Matched on the client id JSON.stringify writes verbatim. */
function lastPartnerOp(db: SqlDriver, partnerId: string): string | null {
  const row = db.get<{ id: string }>(
    `select id from outbox
      where state in ('pending', 'inflight') and payload like ?
      order by seq desc limit 1`,
    [`%"client_partner_id":"${partnerId}"%`],
  )
  return row?.id ?? null
}

/** The most recent queued op for a sub-hire — close chains behind record. */
function lastSubHireOp(db: SqlDriver, subHireId: string): string | null {
  const row = db.get<{ id: string }>(
    `select id from outbox
      where state in ('pending', 'inflight') and payload like ?
      order by seq desc limit 1`,
    [`%"client_sub_hire_id":"${subHireId}"%`],
  )
  return row?.id ?? null
}

/** The most recent queued op for a booking — a sub-hire IN that rescues
 *  a booking replays after the booking's own ops (and after the extension
 *  screen's sub_rent_intent, ASSUMPTION #sub-rent-intent). Same match as
 *  bookings.ts's lastBookingOp, kept here so this module stays standalone. */
function lastBookingOp(db: SqlDriver, bookingId: string): string | null {
  const row = db.get<{ id: string }>(
    `select id from outbox
      where state in ('pending', 'inflight')
        and (payload like ? or payload like ? or payload like ?)
      order by seq desc limit 1`,
    [
      `%"client_booking_id":"${bookingId}"%`,
      `%"p_booking_id":"${bookingId}"%`,
      `%"for_booking_id":"${bookingId}"%`,
    ],
  )
  return row?.id ?? null
}

// ---------------------------------------------------- the partner-customer

/**
 * The partner's row on the udhaar book (D3): the linked customer, else
 * the live customer with the same name (case-insensitive), else a new
 * one — and the link is written either way. ASSUMPTION #partner-is-customer.
 */
export function ensurePartnerCustomer(db: SqlDriver, orgId: string, partnerId: string): string | null {
  const p = partner(db, partnerId)
  if (!p) return null
  const linked = db.get<{ customer_id: string }>(
    `select l.customer_id from partner_customer_links l
       join customers c on c.id = l.customer_id
      where l.partner_house_id = ?`,
    [partnerId],
  )
  if (linked) return linked.customer_id
  const byName = db.get<{ id: string }>(
    `select id from customers where lower(name) = lower(?) order by rowid limit 1`,
    [p.name],
  )
  const customerId =
    byName?.id ?? createCustomer(db, { id: `cust-${crypto.randomUUID()}`, orgId, name: p.name, phone: p.phone })
  if (!customerId) return null
  db.exec(
    `insert into partner_customer_links (partner_house_id, customer_id) values (?, ?)
     on conflict(partner_house_id) do update set customer_id = excluded.customer_id`,
    [partnerId, customerId],
  )
  return customerId
}

/** The partner's customer row, when one has been made — the khata door. */
export function partnerCustomerId(db: SqlDriver, partnerId: string): string | null {
  return (
    db.get<{ customer_id: string }>(
      `select customer_id from partner_customer_links where partner_house_id = ?`,
      [partnerId],
    )?.customer_id ?? null
  )
}

// --------------------------------------------------------------- sub-hire

export type SubHireDirection = 'in' | 'out'

export interface SubHireRow {
  id: string
  direction: SubHireDirection
  partnerId: string
  partnerName: string
  productId: string
  productName: string
  qty: number
  assetId: string | null
  assetCode: string | null
  bookingId: string | null
  jobId: string | null
  jobLabel: string | null
  fromMs: number
  untilMs: number
  /** The agreed money, minor units — null is 'unpriced', never zero. */
  agreedMinor: number | null
  returnedAtMs: number | null
  note: string | null
  createdAtMs: number
}

interface SubHireDbRow {
  id: string
  direction: string
  partner_house_id: string
  partner_name: string
  product_id: string
  product_name: string | null
  qty: number
  asset_id: string | null
  asset_code: string | null
  booking_id: string | null
  job_id: string | null
  job_label: string | null
  period_from: string
  period_until: string
  agreed_cost_minor: number | null
  agreed_charge_minor: number | null
  returned_at: string | null
  note: string | null
  created_at: string
}

const SUB_HIRE_SELECT = `
  select s.id, s.direction, s.partner_house_id, p.name as partner_name,
         s.product_id, pr.display_name as product_name, s.qty,
         s.asset_id, a.asset_code, s.booking_id, s.job_id, j.label as job_label,
         s.period_from, s.period_until, s.agreed_cost_minor, s.agreed_charge_minor,
         s.returned_at, s.note, s.created_at
    from sub_hires s
    join partner_houses p on p.id = s.partner_house_id
    left join products pr on pr.id = s.product_id
    left join assets a on a.id = s.asset_id
    left join jobs j on j.id = s.job_id`

function subHireOf(r: SubHireDbRow): SubHireRow {
  const direction = r.direction === 'out' ? 'out' : 'in'
  return {
    id: r.id,
    direction,
    partnerId: r.partner_house_id,
    partnerName: r.partner_name,
    productId: r.product_id,
    productName: r.product_name ?? 'item',
    qty: Number(r.qty),
    assetId: r.asset_id,
    assetCode: r.asset_code,
    bookingId: r.booking_id,
    jobId: r.job_id,
    jobLabel: r.job_label,
    fromMs: Date.parse(r.period_from),
    untilMs: Date.parse(r.period_until),
    agreedMinor:
      direction === 'in'
        ? (r.agreed_cost_minor === null ? null : Number(r.agreed_cost_minor))
        : (r.agreed_charge_minor === null ? null : Number(r.agreed_charge_minor)),
    returnedAtMs: r.returned_at ? Date.parse(r.returned_at) : null,
    note: r.note,
    createdAtMs: Date.parse(r.created_at),
  }
}

export interface SubHireFilter {
  open?: boolean
  direction?: SubHireDirection
  partnerId?: string
}

/** Sub-hires, newest first; open ones before closed when unfiltered. */
export function subHires(db: SqlDriver, filter: SubHireFilter = {}): SubHireRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (filter.open === true) where.push('s.returned_at is null')
  if (filter.open === false) where.push('s.returned_at is not null')
  if (filter.direction) { where.push('s.direction = ?'); params.push(filter.direction) }
  if (filter.partnerId) { where.push('s.partner_house_id = ?'); params.push(filter.partnerId) }
  const sql = `${SUB_HIRE_SELECT}${where.length ? ` where ${where.join(' and ')}` : ''}
    order by (s.returned_at is not null), s.created_at desc, s.rowid desc`
  return db.all<SubHireDbRow>(sql, params).map(subHireOf)
}

export function subHire(db: SqlDriver, id: string): SubHireRow | null {
  const r = db.get<SubHireDbRow>(`${SUB_HIRE_SELECT} where s.id = ?`, [id])
  return r ? subHireOf(r) : null
}

/** The open sub-hire that borrowed this unit in, when it is one. */
export function subHireForAsset(db: SqlDriver, assetId: string): SubHireRow | null {
  const r = db.get<SubHireDbRow>(
    `${SUB_HIRE_SELECT} where s.asset_id = ? order by (s.returned_at is not null), s.created_at desc limit 1`,
    [assetId],
  )
  return r ? subHireOf(r) : null
}

/** The sub-hire behind a job — how the board knows to stamp SUB-HIRE. */
export function subHireForJob(db: SqlDriver, jobId: string): SubHireRow | null {
  const r = db.get<SubHireDbRow>(`${SUB_HIRE_SELECT} where s.job_id = ? limit 1`, [jobId])
  return r ? subHireOf(r) : null
}

/**
 * A locally minted asset code for a borrowed unit: the product's existing
 * prefix ('FX9' from 'FX9-01') and the next free number, or the product
 * name's first word when the house owns none. The server's
 * generate_asset_code mints the real one on replay — ASSUMPTION
 * #local-asset-code: the phone's code is a stand-in for the label until
 * the pull overwrites it.
 */
export function nextAssetCode(db: SqlDriver, productId: string): string {
  const codes = db
    .all<{ asset_code: string | null }>(`select asset_code from assets where product_id = ?`, [productId])
    .map((r) => r.asset_code ?? '')
    .filter((c) => c.length > 0)
  let prefix: string | null = null
  let max = 0
  for (const c of codes) {
    const m = /^(.*)-(\d+)$/.exec(c)
    if (!m) continue
    prefix ??= m[1]
    if (m[1] === prefix) max = Math.max(max, Number(m[2]))
  }
  if (prefix === null) {
    const name = db.get<{ display_name: string | null }>(
      `select display_name from products where id = ?`,
      [productId],
    )?.display_name ?? 'UNIT'
    prefix = name.split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'UNIT'
  }
  let n = max + 1
  for (;;) {
    const code = `${prefix}-${String(n).padStart(2, '0')}`
    const taken = db.get<{ id: string }>(`select id from assets where asset_code = ?`, [code])
    if (!taken) return code
    n++
  }
}

export interface RecordSubHireInInput {
  partnerId: string
  productId: string
  startMs: number
  endMs: number
  qty?: number
  agreedCostMinor?: number | null
  serial?: string | null
  bookingId?: string | null
  jobId?: string | null
  note?: string | null
}

export type SubHireInRefusal =
  | 'no_partner' | 'no_product' | 'bad_period' | 'bad_qty' | 'bad_cost'
  | 'serial_needs_one' | 'not_serialized' | 'serial_in_fleet'

export type RecordSubHireInResult =
  | {
      ok: true
      subHireId: string
      partnerName: string
      assetId: string | null
      assetCode: string | null
      expenseId: string | null
    }
  | { ok: false; reason: SubHireInRefusal }

/**
 * Gear borrowed from a partner — the RPC's rules, then in one transaction:
 * the unit (with a serial: ownership sub_rented_in, a local code, on the
 * product's shelf), the expense (with a cost: through recordExpense, so
 * the kharcha book and the job's margin see it), the sub_hires row, and
 * the op. Chained behind the booking's ops when it rescues a booking.
 */
export function recordSubHireIn(
  db: SqlDriver,
  orgId: string,
  input: RecordSubHireInInput,
  nowMs: number,
  ids: NetworkIds = defaultIds(nowMs),
): RecordSubHireInResult {
  const p = partner(db, input.partnerId)
  if (!p) return { ok: false, reason: 'no_partner' }
  const product = db.get<{ id: string; display_name: string | null; tracking_mode: string | null }>(
    `select id, display_name, tracking_mode from products where id = ?`,
    [input.productId],
  )
  if (!product) return { ok: false, reason: 'no_product' }
  if (!(input.endMs > input.startMs)) return { ok: false, reason: 'bad_period' }
  const qty = input.qty ?? 1
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, reason: 'bad_qty' }
  const cost = input.agreedCostMinor ?? null
  if (cost !== null && !(Number.isFinite(cost) && cost > 0)) return { ok: false, reason: 'bad_cost' }
  const serial = input.serial?.trim() || null
  if (serial) {
    if (qty !== 1) return { ok: false, reason: 'serial_needs_one' }
    if ((product.tracking_mode ?? 'serialized') !== 'serialized') return { ok: false, reason: 'not_serialized' }
    const dup = db.get<{ id: string }>(
      `select id from assets where lower(serial_number) = lower(?)`,
      [serial],
    )
    if (dup) return { ok: false, reason: 'serial_in_fleet' }
  }
  const note = input.note?.trim() || null
  const productName = product.display_name ?? 'item'

  const subHireId = `sh-${ids.newId()}`
  let assetId: string | null = null
  let assetCode: string | null = null
  let expenseId: string | null = null

  db.transaction(() => {
    if (serial) {
      assetId = `asset-${ids.newId()}`
      assetCode = nextAssetCode(db, product.id)
      // The product's shelf, so the borrowed unit counts on a ginti of
      // the rack its siblings live on.
      const shelf = db.get<{ loc: string | null }>(
        `select current_location_id as loc from assets
          where product_id = ? and current_location_id is not null
          order by asset_code limit 1`,
        [product.id],
      )?.loc ?? null
      db.exec(
        `insert into assets
           (id, org_id, product_id, asset_code, serial_number, presence, health, ownership,
            current_location_id, notes, updated_at)
         values (?, ?, ?, ?, ?, 'here', 'ok', 'sub_rented_in', ?, ?, ?)`,
        [assetId, orgId, product.id, assetCode, serial, shelf, `Sub-hired from ${p.name}`, iso(nowMs)],
      )
    }
    if (cost !== null) {
      expenseId = recordExpense(db, {
        orgId,
        kind: 'sub_hire',
        amountMinor: cost,
        assetId,
        jobId: input.jobId ?? null,
        counterparty: p.name,
        note: note ?? `Sub-hire in: ${productName}`,
        createdAt: nowMs,
      })
    }
    db.exec(
      `insert into sub_hires
         (id, org_id, direction, partner_house_id, booking_id, job_id, product_id, qty,
          asset_id, period_from, period_until, agreed_cost_minor, expense_id, note, created_at)
       values (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        subHireId, orgId, p.id, input.bookingId ?? null, input.jobId ?? null, product.id, qty,
        assetId, iso(input.startMs), iso(input.endMs), cost, expenseId, note, iso(nowMs),
      ],
    )
    new Outbox(db, ids.now).enqueue({
      id: ids.newId(),
      op: 'record_sub_hire_in',
      payload: {
        client_sub_hire_id: subHireId,
        client_partner_id: p.id,
        client_asset_id: assetId,
        client_expense_id: expenseId,
        p_partner_house_id: p.id,
        p_product_id: product.id,
        p_period: tstzrange(input.startMs, input.endMs),
        p_qty: qty,
        p_agreed_cost_minor: cost,
        p_serial_number: serial,
        p_booking_id: input.bookingId ?? null,
        p_job_id: input.jobId ?? null,
        p_note: note,
      },
      dependsOn:
        (input.bookingId ? lastBookingOp(db, input.bookingId) : null) ?? lastPartnerOp(db, p.id),
    })
  })

  return { ok: true, subHireId, partnerName: p.name, assetId, assetCode, expenseId }
}

export interface RecordSubHireOutInput {
  partnerId: string
  startMs: number
  endMs: number
  /** A specific unit, or a product and a count. */
  assetId?: string | null
  productId?: string | null
  qty?: number
  agreedChargeMinor?: number | null
  note?: string | null
}

export type SubHireOutRefusal =
  | 'no_partner' | 'no_product' | 'no_asset' | 'bad_period' | 'bad_qty' | 'bad_charge'
  | 'asset_gone' | 'asset_borrowed' | 'asset_needs_one' | 'no_customer'

export type RecordSubHireOutResult =
  | {
      ok: true
      subHireId: string
      partnerName: string
      jobId: string
      jobLabel: string
      customerId: string
      ledgerEntryId: string | null
    }
  | { ok: false; reason: SubHireOutRefusal }

/** The label the sub-hire job wears — the RPC's exact spelling. */
export const subHireJobLabel = (partnerName: string): string => `Sub-hire → ${partnerName}`

/**
 * Gear lent to a partner: the partner's customer row (D3), the sub-hire
 * JOB the desk scans against (D4, through createJob with the unit — or
 * the product's count — promised on it), the ledger charge when priced
 * (D6), the sub_hires row, and the op. The job lands on the Today board
 * in Going out with the SUB-HIRE stamp.
 */
export function recordSubHireOut(
  db: SqlDriver,
  orgId: string,
  input: RecordSubHireOutInput,
  nowMs: number,
  ids: NetworkIds = defaultIds(nowMs),
): RecordSubHireOutResult {
  const p = partner(db, input.partnerId)
  if (!p) return { ok: false, reason: 'no_partner' }
  if (!(input.endMs > input.startMs)) return { ok: false, reason: 'bad_period' }
  const qty = input.qty ?? 1
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, reason: 'bad_qty' }
  const charge = input.agreedChargeMinor ?? null
  if (charge !== null && !(Number.isFinite(charge) && charge > 0)) return { ok: false, reason: 'bad_charge' }

  let productId = input.productId ?? null
  const assetId = input.assetId ?? null
  if (assetId) {
    const a = db.get<{ product_id: string | null; ownership: string | null; disposition: string | null }>(
      `select product_id, ownership, disposition from assets where id = ?`,
      [assetId],
    )
    if (!a) return { ok: false, reason: 'no_asset' }
    if (a.disposition !== null) return { ok: false, reason: 'asset_gone' }
    if ((a.ownership ?? 'owned') !== 'owned') return { ok: false, reason: 'asset_borrowed' }
    if (qty !== 1) return { ok: false, reason: 'asset_needs_one' }
    if (productId && productId !== a.product_id) return { ok: false, reason: 'no_product' }
    productId = a.product_id
  }
  const product = productId
    ? db.get<{ id: string; display_name: string | null }>(`select id, display_name from products where id = ?`, [productId])
    : null
  if (!product) return { ok: false, reason: 'no_product' }
  const note = input.note?.trim() || null
  const productName = product.display_name ?? 'item'

  const subHireId = `sh-${ids.newId()}`
  const jobId = `job-${ids.newId()}`
  const label = subHireJobLabel(p.name)
  let customerId: string | null = null
  let ledgerEntryId: string | null = null

  const ok = db.transaction(() => {
    customerId = ensurePartnerCustomer(db, orgId, p.id)
    if (!customerId) return false
    createJob(db, {
      id: jobId,
      orgId,
      label,
      contact: p.phone,
      expectedBack: isoDateLocal(input.endMs),
      customerId,
      wants: assetId ? [] : [{ productId: product.id, qty }],
      expectedAssetIds: assetId ? [assetId] : [],
    })
    if (charge !== null) {
      ledgerEntryId = recordEntry(db, {
        orgId,
        customerId,
        kind: 'charge' as LedgerEntryKind,
        amountMinor: charge,
        jobId,
        assetId,
        note: note ?? `Sub-hire out: ${productName}`,
        createdAt: nowMs,
      })
    }
    db.exec(
      `insert into sub_hires
         (id, org_id, direction, partner_house_id, job_id, product_id, qty, asset_id,
          period_from, period_until, agreed_charge_minor, ledger_entry_id, note, created_at)
       values (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        subHireId, orgId, p.id, jobId, product.id, qty, assetId,
        iso(input.startMs), iso(input.endMs), charge, ledgerEntryId, note, iso(nowMs),
      ],
    )
    new Outbox(db, ids.now).enqueue({
      id: ids.newId(),
      op: 'record_sub_hire_out',
      payload: {
        client_sub_hire_id: subHireId,
        client_partner_id: p.id,
        client_job_id: jobId,
        client_customer_id: customerId,
        client_ledger_entry_id: ledgerEntryId,
        p_partner_house_id: p.id,
        p_period: tstzrange(input.startMs, input.endMs),
        p_product_id: product.id,
        p_asset_id: assetId,
        p_qty: qty,
        p_agreed_charge_minor: charge,
        p_note: note,
      },
      dependsOn: lastPartnerOp(db, p.id),
    })
    return true
  })
  if (!ok || !customerId) return { ok: false, reason: 'no_customer' }

  return { ok: true, subHireId, partnerName: p.name, jobId, jobLabel: label, customerId, ledgerEntryId }
}

export type CloseSubHireResult =
  | { ok: true; jobClosed: boolean; returnedToOwner: boolean }
  | { ok: false; reason: 'not_found' | 'already_closed' | 'future' | 'before_start' | 'unit_out' }
  | { ok: false; reason: 'job_still_out'; stillOut: number }

/**
 * The gear went home (in) or came back (out) — the RPC's rules exactly:
 * in + unit: refused while the unit is still out on a job, else a
 *   `retire` event the projection stamps returned_to_owner (D5);
 * out: refused while anything still projects onto the sub-hire job (the
 *   0018 D3 close rule — scan it in first), else the job closes.
 * returned_at defaults to now, never the future, never before the start.
 */
export function closeSubHire(
  db: SqlDriver,
  id: string,
  returnedAtMs: number,
  nowMs: number,
  ids: NetworkIds = defaultIds(nowMs),
): CloseSubHireResult {
  const s = subHire(db, id)
  if (!s) return { ok: false, reason: 'not_found' }
  if (s.returnedAtMs !== null) return { ok: false, reason: 'already_closed' }
  if (returnedAtMs > nowMs) return { ok: false, reason: 'future' }
  if (returnedAtMs < s.fromMs) return { ok: false, reason: 'before_start' }

  let returnedToOwner = false
  let jobClosed = false

  if (s.direction === 'in' && s.assetId) {
    const a = db.get<{ presence: string; disposition: string | null }>(
      `select presence, disposition from assets where id = ?`,
      [s.assetId],
    )
    if (a && (a.presence === 'out' || a.presence === 'in_transit')) return { ok: false, reason: 'unit_out' }
  }
  if (s.direction === 'out' && s.jobId) {
    const job = db.get<{ status: string }>(`select status from jobs where id = ?`, [s.jobId])
    if (job?.status === 'open') {
      const stillOut = stillOutCount(db, s.jobId)
      if (stillOut > 0) return { ok: false, reason: 'job_still_out', stillOut }
    }
  }

  db.transaction(() => {
    if (s.direction === 'in' && s.assetId) {
      const a = db.get<{ disposition: string | null }>(`select disposition from assets where id = ?`, [s.assetId])
      if (a && a.disposition === null) {
        // D5: gone + returned_to_owner, via the log — markTerminal mints
        // the plain retire verb and project.ts derives the word.
        markTerminal(db, {
          assetId: s.assetId,
          disposition: 'returned_to_owner',
          note: `Returned to ${s.partnerName}`,
          now: () => returnedAtMs,
          newId: ids.newId,
        })
        returnedToOwner = true
      }
    }
    if (s.direction === 'out' && s.jobId) {
      const r = closeJob(db, s.jobId, returnedAtMs)
      jobClosed = r.ok
    }
    db.exec(`update sub_hires set returned_at = ? where id = ?`, [iso(returnedAtMs), id])
    new Outbox(db, ids.now).enqueue({
      id: ids.newId(),
      op: 'close_sub_hire',
      payload: {
        client_sub_hire_id: id,
        p_sub_hire_id: id,
        p_returned_at: iso(returnedAtMs),
      },
      dependsOn: lastSubHireOp(db, id),
    })
  })

  return { ok: true, jobClosed, returnedToOwner }
}

/** Local YYYY-MM-DD — what jobs.expected_back holds. */
function isoDateLocal(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------- partner money

export interface PartnerMoney {
  /** Live sub-hire expenses naming this partner — what the house owes
   *  (or has paid) them through the kharcha book. */
  weOweMinor: number
  weOweCount: number
  /** Their khata balance when they have borrowed from us; null when no
   *  customer row exists yet. Positive = they owe us. */
  theyOweMinor: number | null
  customerId: string | null
}

/** The partner page's money line, both books, projections only. */
export function partnerMoney(db: SqlDriver, partnerId: string): PartnerMoney {
  const p = partner(db, partnerId)
  const ours = p
    ? liveExpenses(expenseRows(db)).filter(
        (e) => e.kind === 'sub_hire' && (e.counterparty ?? '').toLowerCase() === p.name.toLowerCase(),
      )
    : []
  const customerId = partnerCustomerId(db, partnerId)
  let theyOwe: number | null = null
  if (customerId) {
    const rows = db.all<{ kind: string; amount_minor: number; created_at: number; reversal_of: string | null }>(
      `select kind, amount_minor, created_at, reversal_of from customer_ledger_entries
        where customer_id = ? order by created_at, rowid`,
      [customerId],
    )
    theyOwe = projectLedger(
      rows.map((r) => ({
        kind: r.kind as LedgerEntryKind,
        amountMinor: Number(r.amount_minor),
        createdAt: Number(r.created_at),
        reversalOf: r.reversal_of,
      })),
    ).balanceMinor
  }
  return {
    weOweMinor: ours.reduce((n, e) => n + e.amountMinor, 0),
    weOweCount: ours.length,
    theyOweMinor: theyOwe,
    customerId,
  }
}

// ------------------------------------------------------------------- crew

export interface StaffRow {
  id: string
  name: string
  role: string
}

/** The house's people, for the crew picker. ASSUMPTION #staff-roster. */
export function staff(db: SqlDriver): StaffRow[] {
  return db
    .all<{ id: string; display_name: string; role: string }>(
      `select id, display_name, role from staff order by display_name`,
    )
    .map((r) => ({ id: r.id, name: r.display_name, role: r.role }))
}

/** The crew line — jobs.attendant_names, the ONE home (the projection
 *  the server syncs; assign/unassign rewrite it locally). */
export function attendantNames(db: SqlDriver, jobId: string): string[] {
  const raw = db.get<{ a: string | null }>(`select attendant_names as a from jobs where id = ?`, [jobId])?.a
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export interface CrewMember {
  userId: string
  name: string
  role: 'attendant' | 'driver'
}

/** Who is on the job, in assignment order, with their ids — the chip row
 *  needs the id to unassign. */
export function crewFor(db: SqlDriver, jobId: string): CrewMember[] {
  return db
    .all<{ user_id: string; display_name: string; role: string }>(
      `select ja.user_id, s.display_name, ja.role
         from job_attendants ja join staff s on s.id = ja.user_id
        where ja.job_id = ? order by ja.created_at, ja.rowid`,
      [jobId],
    )
    .map((r) => ({ userId: r.user_id, name: r.display_name, role: r.role === 'driver' ? 'driver' : 'attendant' }))
}

function rewriteAttendantNames(db: SqlDriver, jobId: string): string[] {
  const names = crewFor(db, jobId).map((c) => c.name)
  db.exec(`update jobs set attendant_names = ? where id = ?`, [JSON.stringify(names), jobId])
  return names
}

export type CrewResult =
  | { ok: true; attendantNames: string[] }
  | { ok: false; reason: 'no_job' | 'cancelled' | 'no_user' | 'bad_role' }

/** Put a member on the crew (upsert: a second call changes the role). */
export function assignAttendant(
  db: SqlDriver,
  orgId: string,
  jobId: string,
  userId: string,
  role: 'attendant' | 'driver',
  nowMs: number,
  ids: NetworkIds = defaultIds(nowMs),
): CrewResult {
  if (role !== 'attendant' && role !== 'driver') return { ok: false, reason: 'bad_role' }
  const job = db.get<{ status: string }>(`select status from jobs where id = ?`, [jobId])
  if (!job) return { ok: false, reason: 'no_job' }
  if (job.status === 'cancelled') return { ok: false, reason: 'cancelled' }
  const user = db.get<{ id: string }>(`select id from staff where id = ?`, [userId])
  if (!user) return { ok: false, reason: 'no_user' }

  let names: string[] = []
  db.transaction(() => {
    db.exec(
      `insert into job_attendants (id, org_id, job_id, user_id, role, created_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(job_id, user_id) do update set role = excluded.role`,
      [`ja-${ids.newId()}`, orgId, jobId, userId, role, iso(nowMs)],
    )
    names = rewriteAttendantNames(db, jobId)
    new Outbox(db, ids.now).enqueue({
      id: ids.newId(),
      op: 'assign_attendant',
      payload: { client_job_id: jobId, p_job_id: jobId, p_user_id: userId, p_role: role },
    })
  })
  return { ok: true, attendantNames: names }
}

/** Take a member off the crew. Not on it: nothing written, names as they are. */
export function unassignAttendant(
  db: SqlDriver,
  jobId: string,
  userId: string,
  nowMs: number,
  ids: NetworkIds = defaultIds(nowMs),
): CrewResult {
  const job = db.get<{ status: string }>(`select status from jobs where id = ?`, [jobId])
  if (!job) return { ok: false, reason: 'no_job' }
  const on = db.get<{ id: string }>(
    `select id from job_attendants where job_id = ? and user_id = ?`,
    [jobId, userId],
  )
  if (!on) return { ok: true, attendantNames: attendantNames(db, jobId) }
  let names: string[] = []
  db.transaction(() => {
    db.exec(`delete from job_attendants where job_id = ? and user_id = ?`, [jobId, userId])
    names = rewriteAttendantNames(db, jobId)
    new Outbox(db, ids.now).enqueue({
      id: ids.newId(),
      op: 'unassign_attendant',
      payload: { client_job_id: jobId, p_job_id: jobId, p_user_id: userId },
    })
  })
  return { ok: true, attendantNames: names }
}

// ------------------------------------------------- the stolen broadcast

const PUBLIC_TAG_URL_BASE_KEY = 'public_tag_url_base'
const PUBLIC_PHONE_KEY = 'public_phone'

/** orgs.settings.public_tag_url_base, on this phone. ASSUMPTION #public-tag-url. */
export function publicTagUrlBase(db: SqlDriver): string | null {
  return getSetting(db, PUBLIC_TAG_URL_BASE_KEY)
}
export function setPublicTagUrlBase(db: SqlDriver, value: string | null): void {
  setSetting(db, PUBLIC_TAG_URL_BASE_KEY, value)
}
/** orgs.settings.public_phone — the number the partner group calls. */
export function publicPhone(db: SqlDriver): string | null {
  return getSetting(db, PUBLIC_PHONE_KEY)
}
export function setPublicPhone(db: SqlDriver, value: string | null): void {
  setSetting(db, PUBLIC_PHONE_KEY, value)
}

/**
 * The facts stolen_broadcast_text returns, from the mirror and the two
 * settings — null unless the unit is actually marked stolen (the loud
 * line is only honest when the state behind it is). public_url is the
 * base + the active tag code, null when either is missing.
 */
export function stolenBroadcastFacts(
  db: SqlDriver,
  assetId: string,
  orgName: string,
): StolenBroadcastFacts | null {
  const a = db.get<{
    asset_code: string | null
    serial_number: string | null
    disposition: string | null
    product_name: string | null
    tag_code: string | null
  }>(
    `select a.asset_code, a.serial_number, a.disposition, p.display_name as product_name,
            (select t.tag_code from asset_tags t where t.asset_id = a.id and t.status = 'active' limit 1) as tag_code
       from assets a left join products p on p.id = a.product_id
      where a.id = ?`,
    [assetId],
  )
  if (!a || a.disposition !== 'stolen') return null
  const base = publicTagUrlBase(db)?.trim().replace(/\/+$/, '') || null
  return {
    assetCode: a.asset_code,
    serialNumber: a.serial_number,
    productName: a.product_name,
    tagCode: a.tag_code,
    publicUrl: base && a.tag_code ? `${base}/${a.tag_code}` : null,
    orgName,
    orgPhone: publicPhone(db),
  }
}

/** The partner-group line for a stolen unit, or null when it is not. */
export function stolenBroadcast(
  db: SqlDriver,
  assetId: string,
  orgName: string,
  lang: BroadcastLang,
): string | null {
  const facts = stolenBroadcastFacts(db, assetId, orgName)
  return facts ? stolenBroadcastText(facts, lang) : null
}

/** The ask-the-market message from shortage lines. */
export function askTheMarket(
  db: SqlDriver,
  shortage: ShortageLine[],
  orgName: string,
  lang: BroadcastLang,
): string {
  return askTheMarketText(shortage, { name: orgName, phone: publicPhone(db) }, lang)
}

// ------------------------------------------------------------------- seed

/**
 * The demo's network: two partner houses the desk actually calls on a
 * shaadi weekend, and the house's roster for the crew line. No sub-hires
 * are seeded — the doors are the demo — but the wedding job leaves with
 * two people on it, so the board's crew chips have something to show.
 */
export function seedNetwork(db: SqlDriver, orgId: string, nowMs: number = Date.now()): void {
  db.exec(NETWORK_SCHEMA)
  const at = iso(nowMs)
  const partnersSeed: [string, string, string, string][] = [
    ['partner-kamran', 'Kamran Rentals', '0301 7788990', 'Lahore'],
    ['partner-zeeshan', 'Zeeshan Cine Hire', '0322 1122334', 'Lahore'],
  ]
  for (const [id, name, phone, city] of partnersSeed) {
    db.exec(
      `insert into partner_houses (id, org_id, name, phone, city, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [id, orgId, name, phone, city, at, at],
    )
  }
  const staffSeed: [string, string, string][] = [
    ['user-usman', 'Usman', 'tech'],
    ['user-danish', 'Danish', 'tech'],
    ['user-saqib', 'Saqib', 'driver'],
  ]
  for (const [id, name, role] of staffSeed) {
    db.exec(`insert into staff (id, org_id, display_name, role) values (?, ?, ?, ?)`, [id, orgId, name, role])
  }
  // The wedding truck leaves with a tech and a driver: the crew line has
  // something to show, and the parchi says who went with the kit.
  const crew: [string, string, string][] = [
    ['ja-seed-1', 'user-usman', 'attendant'],
    ['ja-seed-2', 'user-saqib', 'driver'],
  ]
  for (const [id, userId, role] of crew) {
    db.exec(
      `insert into job_attendants (id, org_id, job_id, user_id, role, created_at) values (?, ?, 'job-wedding', ?, ?, ?)`,
      [id, orgId, userId, role, at],
    )
  }
  rewriteAttendantNames(db, 'job-wedding')
  db.exec(`update jobs set attendant_names = '[]' where attendant_names is null`)
}
