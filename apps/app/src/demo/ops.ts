import { Outbox, type SqlDriver } from '@papa/core'

/**
 * The one home for "queue an op behind the last op that named this thing"
 * (W11 — every write crosses the pipe).
 *
 * Every write side on the phone does two things in one transaction: it
 * updates the local mirror optimistically and it enqueues an outbox op
 * NAMED AFTER THE SERVER RPC, its payload shaped like that RPC's `p_*`
 * arguments, with any id the phone minted riding beside them as
 * `client_*` (packages/core dispatch.ts explains the three rules). The
 * chain is what keeps the replay honest: a ledger line on a customer this
 * phone invented must reach the server AFTER the create_customer that
 * mints the customer, and a close_job after the create_job — the outbox
 * replays strictly in seq and parks a whole `depends_on` subtree when its
 * root is refused, so the dependency edge is the difference between "the
 * charge landed on the right khata" and "the charge parked as a card
 * because the customer did not exist yet".
 *
 * Matched on the id JSON.stringify writes verbatim, under both the phone's
 * name and — once the pipe has re-keyed the row — the server's (id_map),
 * so a chain queued across a rename stays one chain. bookings.ts's
 * lastBookingOp is the same match with the booking's extra keys.
 */

export interface OpIds {
  now: () => number
  newId: () => string
}

/** Real ids: the outbox id is replay_op's `p_op_id uuid`, so it must be one. */
export const defaultIds = (nowMs: number): OpIds => ({
  now: () => nowMs,
  newId: () => crypto.randomUUID(),
})

/** One thing an op may name: the payload key and the id under it. */
export interface Named {
  key: string
  id: string | null | undefined
}

/** The phone's own earlier names for a server id, from the pipe's id map
 *  (empty when the table is absent or the id was never renamed). */
export function clientNamesFor(db: SqlDriver, serverId: string): string[] {
  try {
    return db.all<{ client_id: string }>(
      `select client_id from id_map where server_id = ?`, [serverId],
    ).map((r) => r.client_id)
  } catch {
    return []
  }
}

/**
 * The most recent queued op whose payload names any of `named` — what the
 * next op on the same thing chains behind. Null when nothing pending names
 * them (a row the pull brought, or one whose op already landed).
 */
export function lastOpNaming(db: SqlDriver, named: Named[]): string | null {
  const patterns: string[] = []
  for (const n of named) {
    if (!n.id) continue
    for (const id of [n.id, ...clientNamesFor(db, n.id)]) patterns.push(`%"${n.key}":"${id}"%`)
  }
  if (patterns.length === 0) return null
  const row = db.get<{ id: string }>(
    `select id from outbox
      where state in ('pending', 'inflight')
        and (${patterns.map(() => 'payload like ?').join(' or ')})
      order by seq desc limit 1`,
    patterns,
  )
  return row?.id ?? null
}

/** Queue one op, chained behind whatever last named `named`. Returns the op id. */
export function enqueueOp(
  db: SqlDriver,
  ids: OpIds,
  op: string,
  payload: Record<string, unknown>,
  named: Named[],
): string {
  const id = ids.newId()
  new Outbox(db, ids.now).enqueue({ id, op, payload, dependsOn: lastOpNaming(db, named) })
  return id
}

/** The keys under which a customer, a job, a booking, an expense or a
 *  ledger line appears in a queued payload. */
export const NAMES = {
  customer: (id: string | null | undefined): Named[] => [
    { key: 'client_customer_id', id }, { key: 'p_customer_id', id },
  ],
  job: (id: string | null | undefined): Named[] => [
    { key: 'client_job_id', id }, { key: 'p_job_id', id },
  ],
  booking: (id: string | null | undefined): Named[] => [
    { key: 'client_booking_id', id }, { key: 'p_booking_id', id },
  ],
  asset: (id: string | null | undefined): Named[] => [
    { key: 'client_asset_id', id },
  ],
  expense: (id: string | null | undefined): Named[] => [
    { key: 'client_expense_id', id }, { key: 'p_expense_id', id },
  ],
  ledgerEntry: (id: string | null | undefined): Named[] => [
    { key: 'client_ledger_entry_id', id }, { key: 'p_reversal_of', id },
  ],
}
