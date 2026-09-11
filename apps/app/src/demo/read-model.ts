import {
  compareDueDates,
  dueStatus,
  voidedScanIds,
  type DueStatus,
  type JobCommitment,
  type MoneyTotal,
  type SqlDriver,
} from '@papa/core'

/**
 * The demo's read model — the pure part of store.ts.
 *
 * In a .ts module, like sessions.ts and session-summary.ts, so every query
 * here runs under plain Node against node:sqlite in the tests, while store.ts
 * (whose sql.js driver cannot load under Node) stays a thin wiring layer.
 * The 2026-09-02 review's deferred cleanup — "lift the read-model SQL out of
 * store.ts" — starts here: new queries land in this module, not the store.
 */

/**
 * Demo-only tables, applied by seedDemo AFTER the real LOCAL_SCHEMA.
 *
 * `job_expected` — which specific assets a job promises. Wave 1 kept the
 * expected sets in a JS array on the seed object, which meant a job created
 * at the desk could never behave like a seeded one: nothing DB-side knew what
 * it expected. One table fixes that for the board, the scanner and the
 * availability answer at once.
 *
 * `job_meta` — departure time. Kept out of the mirrored `jobs` table on
 * purpose: that table's shape is the server's, and widening a mirror for a
 * demo-only column is how a fake schema drifts away from the real one.
 *
 * `scan_sessions` — one row per session ever opened, written when it opens.
 * The outbox already holds every scan keyed by session_id; this adds the only
 * facts the outbox does not carry (mode, and the expected snapshot the
 * session was reconciling against), so a finished session's handover summary
 * can be rebuilt after the in-memory session is gone.
 *
 * `product_rates` — day rate and replacement value per product, MINOR units
 * (paisa), following the server's `_minor` convention. A demo-side table for
 * the same reason as `job_meta`: the `products` mirror's shape is the
 * server's, and the server keeps money in rate cards (phase 2), not on the
 * product row. Both columns nullable ON PURPOSE — a product with no rate
 * reports 'no rate' and is counted as unpriced in every total, never priced
 * at zero.
 */
export const DEMO_SCHEMA = /* sql */ `
create table if not exists job_expected (
  job_id   text not null,
  asset_id text not null,
  primary key (job_id, asset_id)
);
create index if not exists job_expected_asset_idx on job_expected (asset_id);

create table if not exists job_meta (
  job_id     text primary key,
  departs_at text
);

create table if not exists scan_sessions (
  id            text primary key,
  job_id        text not null,
  mode          text not null,
  started_at    integer not null,
  expected_json text not null
);
create index if not exists scan_sessions_job_idx on scan_sessions (job_id, started_at);

create table if not exists product_rates (
  product_id        text primary key,
  day_rate_minor    integer,
  replacement_minor integer
);

-- The money book (vendor-dream-plan Phase B; PLAN.md override #14).
-- customers and customer_ledger_entries mirror the shapes the server
-- will own. The job↔customer link lives on jobs.customer_id itself now:
-- 0017 gave the server that column and 0018 syncs it, so the mirror
-- carries it for real and the demo-only job_customer shim is gone — a
-- fake link table beside a real column is exactly the drift the old
-- comment warned about.
-- The ledger is APPEND-ONLY: nothing in this codebase updates or deletes a
-- row, and the balance is a projection (see @papa/core ledger.ts).
create table if not exists customers (
  id     text primary key,
  org_id text not null,
  name   text not null,
  phone  text,
  note   text
);
create index if not exists jobs_customer_idx on jobs (customer_id);

create table if not exists customer_ledger_entries (
  id           text primary key,
  org_id       text not null,
  customer_id  text not null,
  kind         text not null,
  amount_minor integer not null,
  job_id       text,
  asset_id     text,
  note         text,
  -- For kind 'reversal': the id of the entry this line voids. The link is
  -- what lets projections treat the pair as if the voided entry never
  -- happened (the debt clock, asset earnings) while both lines stay on
  -- the page. Server side this column is a follow-up migration.
  reversal_of  text,
  created_at   integer not null
);
create index if not exists ledger_customer_idx on customer_ledger_entries (customer_id, created_at);
create index if not exists ledger_asset_idx on customer_ledger_entries (asset_id);

-- The expense side of the book (0019): what the HOUSE paid out — repairs,
-- sub-hire, purchases. Mirrors the server's org_expenses shape. Same
-- append-only discipline as the ledger: nothing updates or deletes a row;
-- a mistake is voided by a further row naming it (reversal_of, void-PAIR
-- semantics — both rows leave every sum; see @papa/core expenses.ts).
-- Every amount is positive; profit is always a read.
create table if not exists org_expenses (
  id           text primary key,
  org_id       text not null,
  kind         text not null,
  amount_minor integer not null,
  asset_id     text,
  job_id       text,
  counterparty text,
  note         text,
  reversal_of  text,
  created_at   integer not null
);
create index if not exists expenses_created_idx on org_expenses (created_at);
create index if not exists expenses_asset_idx on org_expenses (asset_id);
create index if not exists expenses_job_idx on org_expenses (job_id);

-- The turned-away demand log: one row per shortage the enquiry answer was
-- actually USED for (reply copied, or a job made) — the buy signal.
create table if not exists demand_log (
  id         text primary key,
  product_id text not null,
  qty        integer not null,
  date       text not null
);
create index if not exists demand_log_product_idx on demand_log (product_id, date);

-- Small org settings — the payment line and QR the money documents carry.
create table if not exists app_settings (
  key   text primary key,
  value text
);
`

export interface OpenJobRow {
  id: string
  label: string
  contact: string | null
  expectedBack: string | null
  departsAt: string | null
  /** The khata this job's money lands in — null for the nephew case. */
  customer: { id: string; name: string } | null
  /** Asset ids this job promises, from job_expected. */
  expected: string[]
}

/**
 * Order the board the way the morning runs: earliest departure first.
 * Departure times are 'HH:MM' so lexical order IS time order; jobs without
 * one (walk-ins created at the desk) sort last rather than shuffling into
 * the timed run. Ties compare 0 so a stable sort leaves them alone.
 */
export function compareJobsByDeparture(
  a: { departsAt: string | null },
  b: { departsAt: string | null },
): number {
  if (a.departsAt === null && b.departsAt === null) return 0
  if (a.departsAt === null) return 1
  if (b.departsAt === null) return -1
  return a.departsAt < b.departsAt ? -1 : a.departsAt > b.departsAt ? 1 : 0
}

/** Every open job, with its promised assets, sorted by departure. */
export function openJobs(db: SqlDriver): OpenJobRow[] {
  const rows = db.all<{
    id: string
    label: string | null
    contact: string | null
    expected_back: string | null
    departs_at: string | null
    customer_id: string | null
    customer_name: string | null
  }>(
    `select j.id, j.label, j.contact, j.expected_back, m.departs_at,
            c.id as customer_id, c.name as customer_name
       from jobs j
       left join job_meta m on m.job_id = j.id
       left join customers c on c.id = j.customer_id
      where j.status = 'open'`,
  )

  const expected = new Map<string, string[]>()
  for (const r of db.all<{ job_id: string; asset_id: string }>(
    `select job_id, asset_id from job_expected order by asset_id`,
  )) {
    const list = expected.get(r.job_id) ?? []
    list.push(r.asset_id)
    expected.set(r.job_id, list)
  }

  return rows
    .map((r) => ({
      id: r.id,
      label: r.label ?? 'Unnamed job',
      contact: r.contact,
      expectedBack: r.expected_back,
      departsAt: r.departs_at,
      customer:
        r.customer_id && r.customer_name
          ? { id: r.customer_id, name: r.customer_name }
          : null,
      expected: expected.get(r.id) ?? [],
    }))
    .sort(compareJobsByDeparture)
}

/** One open job by id, or null. Same shape as the list, for card screens. */
export function openJob(db: SqlDriver, jobId: string): OpenJobRow | null {
  return openJobs(db).find((j) => j.id === jobId) ?? null
}

/**
 * How many of a job's PROMISED items have physically left on it.
 *
 * The fallback behind the Today progress ring when no live session exists —
 * after a reload, or on a phone that never opened the session. The scan
 * projection already wrote presence='out' and current_job_id, so the mirror
 * itself can answer; a live ScanSession, when there is one, supersedes this
 * because it also counts off-list items the tech added.
 */
export function packedProgress(db: SqlDriver, jobId: string): number {
  const row = db.get<{ n: number }>(
    `select count(*) as n
       from job_expected e
       join assets a on a.id = e.asset_id
      where e.job_id = ? and a.current_job_id = ? and a.presence = 'out'`,
    [jobId, jobId],
  )
  return Number(row?.n ?? 0)
}

export interface OutDueRow {
  id: string
  label: string
  contact: string | null
  expectedBack: string | null
  /** The khata the return's money will land in, when one is wired. */
  customer: { id: string; name: string } | null
  /** Items physically out on this job right now. */
  out: number
  /** Locally computed at read time — the CONTRIBUTING time rule. */
  due: DueStatus
  /** Replacement value of what is out — what this job is holding, in money.
   *  Unpriced items are counted, never folded in as zero. */
  value: MoneyTotal
}

/** Reading order for the coming-back list: the ones costing money first. */
const DUE_RANK: Record<DueStatus['state'], number> = {
  overdue: 0,
  due_today: 1,
  upcoming: 2,
  unknown: 3,
}

/**
 * The "coming back" board: every job with gear physically out, its due state
 * computed here from the stored date and the caller's clock — overdue pinned
 * first, then soonest-due, dateless last. Also the source of the Today strip's
 * overdue / due-back counters, so the number and the list it links to can
 * never disagree.
 */
export function dueBoard(
  db: SqlDriver,
  nowMs: number,
): { outJobs: OutDueRow[]; overdue: number; dueBack: number } {
  const outJobs = db
    .all<{
      job_id: string
      n: number
      priced: number
      total_minor: number | null
      label: string | null
      contact: string | null
      expected_back: string | null
      customer_id: string | null
      customer_name: string | null
    }>(
      // count(r.replacement_minor) counts only non-null values, so priced
      // and n - priced are exactly the split moneyLabel needs — an item
      // without a rate raises the unpriced count instead of pricing at zero.
      `select a.current_job_id as job_id, count(*) as n,
              count(r.replacement_minor) as priced,
              sum(r.replacement_minor) as total_minor,
              j.label, j.contact, j.expected_back,
              c.id as customer_id, c.name as customer_name
         from assets a
         left join jobs j on j.id = a.current_job_id
         left join customers c on c.id = j.customer_id
         left join product_rates r on r.product_id = a.product_id
        where a.current_job_id is not null
          and a.presence in ('out', 'in_transit')
        group by a.current_job_id`,
    )
    .map((r): OutDueRow => ({
      id: r.job_id,
      label: r.label ?? 'Gear out with no job',
      contact: r.contact,
      expectedBack: r.expected_back,
      customer:
        r.customer_id && r.customer_name
          ? { id: r.customer_id, name: r.customer_name }
          : null,
      out: Number(r.n),
      due: dueStatus(r.expected_back, nowMs),
      value: {
        totalMinor: Number(r.total_minor ?? 0),
        priced: Number(r.priced),
        unpriced: Number(r.n) - Number(r.priced),
      },
    }))
    .sort(
      (a, b) =>
        DUE_RANK[a.due.state] - DUE_RANK[b.due.state] ||
        compareDueDates(a.expectedBack, b.expectedBack),
    )

  return {
    outJobs,
    overdue: outJobs.filter((j) => j.due.state === 'overdue').length,
    dueBack: outJobs.filter((j) => j.due.state === 'due_today').length,
  }
}

export interface CreateJobInput {
  id: string
  orgId: string
  label: string
  contact: string | null
  /** ISO date or null. Free text is not offered here — the input is a date
   *  field precisely so new jobs are born with a date the board can rank. */
  expectedBack: string | null
  /** The khata this job's money will land in. Optional — the nephew case
   *  (a job with no customer) stays legal, it just cannot take a charge. */
  customerId?: string | null
  /** Product id and how many units, from resolved kit-list lines. */
  wants: { productId: string; qty: number }[]
}

/**
 * Create a job the way the seed creates one: a jobs row plus a job_expected
 * set, in one transaction, so it looks identical to a seeded job on the
 * board, in a scan session, and in the availability answer.
 *
 * Allocation picks specific rentable units (here, healthy) in asset-code
 * order — the same first-N-units rule the seed uses. If fewer units are on
 * the shelf than asked for, the job gets what exists and the shortfall is
 * REPORTED, never padded: promising a unit that is not there is the exact
 * lie the availability screen refuses to tell.
 */
export function createJob(
  db: SqlDriver,
  input: CreateJobInput,
): { expected: string[]; requested: number } {
  const expected: string[] = []
  let requested = 0

  db.transaction(() => {
    db.exec(
      `insert into jobs (id, org_id, label, contact, expected_back, status, customer_id)
       values (?, ?, ?, ?, ?, 'open', ?)`,
      [
        input.id, input.orgId, input.label, input.contact, input.expectedBack,
        input.customerId ?? null,
      ],
    )
    db.exec(`insert into job_meta (job_id, departs_at) values (?, null)`, [input.id])

    for (const want of input.wants) {
      requested += want.qty
      const units = db.all<{ id: string }>(
        `select id from assets
          where product_id = ? and presence = 'here' and health = 'ok'
          order by asset_code
          limit ?`,
        [want.productId, want.qty],
      )
      for (const u of units) expected.push(u.id)
    }

    for (const assetId of expected) {
      db.exec(
        `insert into job_expected (job_id, asset_id) values (?, ?)`,
        [input.id, assetId],
      )
    }
  })

  return { expected, requested }
}

/**
 * Set or clear a job's due date. Nothing fancy on purpose — this is the demo
 * store, and expected_back is a mirror column the real product would round-
 * trip through an RPC. Clearing produces the honest 'no date', never a guess.
 */
export function setExpectedBack(
  db: SqlDriver,
  jobId: string,
  value: string | null,
): void {
  db.exec(`update jobs set expected_back = ? where id = ?`, [value, jobId])
}

/** How many assets the projection still puts on this job — the close rule's
 *  number, shared by the button's disabled reason and the refusal itself. */
export function stillOutCount(db: SqlDriver, jobId: string): number {
  const row = db.get<{ n: number }>(
    `select count(*) as n from assets
      where current_job_id = ? and presence in ('out', 'in_transit')`,
    [jobId],
  )
  return Number(row?.n ?? 0)
}

export type CloseJobResult =
  | { ok: true }
  | { ok: false; reason: 'still_out'; stillOut: number }
  | { ok: false; reason: 'not_open' }

/**
 * End a job. THE RULE, mirroring the server's close_job (0018 D3) exactly:
 * a job may close only when no asset still projects onto it — a check_in
 * clears current_job_id, so a row still pointing here has not come home.
 * Refused, never forced: the ghost cable and the absconded client keep
 * their jobs open and their board rows red, because that is the truth
 * until a terminal state for gear exists.
 */
export function closeJob(db: SqlDriver, jobId: string, nowMs: number): CloseJobResult {
  const job = db.get<{ status: string }>(
    `select status from jobs where id = ?`,
    [jobId],
  )
  if (!job || job.status !== 'open') return { ok: false, reason: 'not_open' }

  const stillOut = stillOutCount(db, jobId)
  if (stillOut > 0) return { ok: false, reason: 'still_out', stillOut }

  db.exec(
    `update jobs set status = 'closed', closed_at = ? where id = ?`,
    [new Date(nowMs).toISOString(), jobId],
  )
  return { ok: true }
}

/** The undo — the board resurrects the job, commitments and all. On the
 *  server this is owner/manager-only and audited (0018); the demo has one
 *  user, so the door is plain. */
export function reopenJob(db: SqlDriver, jobId: string): boolean {
  const job = db.get<{ status: string }>(
    `select status from jobs where id = ?`,
    [jobId],
  )
  if (!job || job.status !== 'closed') return false
  db.exec(`update jobs set status = 'open', closed_at = null where id = ?`, [jobId])
  return true
}

export interface ClosedJobRow {
  id: string
  label: string
  customer: { id: string; name: string } | null
  /** Epoch ms, or null for a job closed before closed_at existed. */
  closedAt: number | null
  /** Assets whose projection STILL points at this closed job — the ghost
   *  cable, shown honestly instead of hidden by the close. Zero for a
   *  job closed through closeJob, which refuses while any remain; non-zero
   *  only for rows closed by older seeds or by sync. */
  neverCameBack: number
}

/** Every closed job, newest first — the "Closed jobs" door's list. */
export function closedJobs(db: SqlDriver): ClosedJobRow[] {
  return db
    .all<{
      id: string
      label: string | null
      closed_at: string | null
      customer_id: string | null
      customer_name: string | null
      never_back: number
    }>(
      `select j.id, j.label, j.closed_at,
              c.id as customer_id, c.name as customer_name,
              (select count(*) from assets a
                where a.current_job_id = j.id
                  and a.presence in ('out', 'in_transit')) as never_back
         from jobs j
         left join customers c on c.id = j.customer_id
        where j.status = 'closed'
        order by j.closed_at desc, j.rowid desc`,
    )
    .map((r) => ({
      id: r.id,
      label: r.label ?? 'Unnamed job',
      customer:
        r.customer_id && r.customer_name
          ? { id: r.customer_id, name: r.customer_name }
          : null,
      closedAt: r.closed_at ? Date.parse(r.closed_at) : null,
      neverCameBack: Number(r.never_back ?? 0),
    }))
}

/**
 * What the open jobs already claim, for checkAvailability's commitments
 * parameter: one entry per open job with a promised set, product ids one per
 * unit, `out` true once its gear has physically left. This is what turns
 * "1 short" into "1 short, but one comes back Thursday" on the enquiry
 * screen — assembled here so the answer and the Today board read the same
 * tables.
 */
export function openJobCommitments(db: SqlDriver): JobCommitment[] {
  const outByJob = new Set(
    db
      .all<{ job_id: string }>(
        `select distinct current_job_id as job_id from assets
          where current_job_id is not null and presence in ('out', 'in_transit')`,
      )
      .map((r) => r.job_id),
  )

  const productsByJob = new Map<string, string[]>()
  for (const r of db.all<{ job_id: string; product_id: string | null }>(
    `select e.job_id, a.product_id
       from job_expected e join assets a on a.id = e.asset_id`,
  )) {
    if (!r.product_id) continue
    const list = productsByJob.get(r.job_id) ?? []
    list.push(r.product_id)
    productsByJob.set(r.job_id, list)
  }

  return openJobs(db)
    .filter((j) => (productsByJob.get(j.id)?.length ?? 0) > 0)
    .map((j) => ({
      jobId: j.id,
      jobLabel: j.label,
      expectedBack: j.expectedBack,
      productIds: productsByJob.get(j.id) ?? [],
      out: outByJob.has(j.id),
    }))
}

/** One queued scan, decoded. The outbox payload is JSON; this is the ONE
 *  place that knows which fields a scan op carries. */
export interface DecodedScanOp {
  outboxId: string
  sessionId: string | null
  assetId: string | null
  jobId: string | null
  eventType: string
  entryMethod: string
  createdAt: number
}

/**
 * Every scan op in the queue, oldest first.
 *
 * Three screens used to decode the payload themselves (asset history, the
 * live handover, and now the rebuilt one); three copies of "what is in a
 * scan op" is how one of them quietly stops agreeing with the others when a
 * field is renamed. They all read this instead.
 *
 * VOIDED OPS ARE SKIPPED HERE, once, for every reader: an op a `void_scan`
 * names stays in the queue (append-only truth, and the server may already
 * hold it) but is no longer a fact any history, summary or hisaab may
 * repeat.
 */
export function decodeScanOps(db: SqlDriver): DecodedScanOp[] {
  const voided = voidedScanIds(db)
  return db
    .all<{ id: string; payload: string; created_at: number }>(
      `select id, payload, created_at from outbox
        where op = 'submit_scan_batch' order by seq`,
    )
    .filter((o) => !voided.has(o.id))
    .map((o) => {
      const op = JSON.parse(o.payload) as Record<string, unknown>
      return {
        outboxId: o.id,
        sessionId: typeof op.session_id === 'string' ? op.session_id : null,
        assetId: typeof op.asset_id === 'string' ? op.asset_id : null,
        jobId: typeof op.job_id === 'string' ? op.job_id : null,
        eventType: String(op.event_type ?? 'check_out'),
        entryMethod: String(op.entry_method ?? 'scanned'),
        createdAt: Number(o.created_at),
      }
    })
}

/**
 * What one session actually recorded, derived from the queue. Shared by the
 * live handover and the rebuilt one so the two can never tell different
 * stories about the same morning.
 */
export function sessionScanFacts(
  ops: DecodedScanOp[],
  sessionId: string,
): { recorded: string[]; assumed: string[]; unknownTags: { key: string }[] } {
  const recorded: string[] = []
  const assumed: string[] = []
  const unknownTags: { key: string }[] = []

  for (const op of ops) {
    if (op.sessionId !== sessionId) continue
    if (!op.assetId) {
      unknownTags.push({ key: op.outboxId })
      continue
    }
    recorded.push(op.assetId)
    if (op.entryMethod === 'assumed') assumed.push(op.assetId)
  }

  return { recorded, assumed, unknownTags }
}

/**
 * Collapse an asset history's echoes for display.
 *
 * A rescan after a device kill legitimately writes a second op (the
 * per-session dedupe died with the process; the projection stays right
 * regardless — pinned in stress-registry.test.mjs). POLICY (owner may
 * overrule): the WRITE stays — the queue is append-only truth — but the
 * history VIEW folds consecutive rows repeating the same event on the
 * same job into one row with a count, rendered as a "×2" marker, so a
 * restart's echo reads as one return instead of two movements.
 *
 * Consecutive-only on purpose: a genuine out → in → out again on the same
 * job alternates events and never folds.
 */
export function collapseHistory<T extends { event: string; jobLabel: string | null }>(
  rows: T[],
): (T & { times: number })[] {
  const out: (T & { times: number })[] = []
  for (const r of rows) {
    const prev = out[out.length - 1]
    if (prev && prev.event === r.event && prev.jobLabel === r.jobLabel) {
      prev.times++
      continue
    }
    out.push({ ...r, times: 1 })
  }
  return out
}

export interface SessionRecord {
  id: string
  jobId: string
  mode: 'out' | 'in'
  startedAt: number
  expected: string[]
}

/** Written the moment a session opens, so finishing (or crashing) later
 *  cannot lose the facts the summary needs. */
export function recordSessionStart(db: SqlDriver, rec: SessionRecord): void {
  db.exec(
    `insert or replace into scan_sessions (id, job_id, mode, started_at, expected_json)
     values (?, ?, ?, ?, ?)`,
    [rec.id, rec.jobId, rec.mode, rec.startedAt, JSON.stringify(rec.expected)],
  )
}

/**
 * The most recently opened session ever recorded on a job — live or long
 * finished. This is what makes a handover reviewable after the in-memory
 * session dies: mode and the expected snapshot come from here, the scans
 * from the outbox.
 */
export function lastSessionRecord(
  db: SqlDriver,
  jobId: string,
): SessionRecord | null {
  const row = db.get<{
    id: string
    job_id: string
    mode: string
    started_at: number
    expected_json: string
  }>(
    // rowid breaks started_at ties: two sessions opened inside the same
    // millisecond (finish prep, immediately open the return) must resolve
    // to the LATER one, and a UUID comparison decides that by coin flip.
    `select id, job_id, mode, started_at, expected_json from scan_sessions
      where job_id = ? order by started_at desc, rowid desc limit 1`,
    [jobId],
  )
  if (!row) return null
  return {
    id: row.id,
    jobId: row.job_id,
    mode: row.mode === 'in' ? 'in' : 'out',
    startedAt: Number(row.started_at),
    expected: JSON.parse(row.expected_json) as string[],
  }
}

/**
 * Code and display name for one asset — the shape buildSummary's `facts`
 * callback wants. The store inlined this join once and the parchi and the
 * day's account both need it too; three inline copies of the same coalesce
 * is how one of them quietly stops preferring the product name.
 */
export function assetFacts(
  db: SqlDriver,
  id: string,
): {
  id: string
  code: string | null
  name: string | null
  dayRateMinor: number | null
  replacementMinor: number | null
} | undefined {
  const row = db.get<{
    asset_code: string | null
    display_name: string | null
    day_rate_minor: number | null
    replacement_minor: number | null
  }>(
    `select a.asset_code, coalesce(p.display_name, a.display_name) as display_name,
            r.day_rate_minor, r.replacement_minor
       from assets a
       left join products p on p.id = a.product_id
       left join product_rates r on r.product_id = a.product_id
      where a.id = ?`,
    [id],
  )
  return row
    ? {
        id,
        code: row.asset_code,
        name: row.display_name,
        dayRateMinor: row.day_rate_minor === null ? null : Number(row.day_rate_minor),
        replacementMinor: row.replacement_minor === null ? null : Number(row.replacement_minor),
      }
    : undefined
}

/** A product's day rate in minor units, or null — 'no rate', not zero. */
export function dayRateFor(db: SqlDriver, productId: string): number | null {
  const row = db.get<{ day_rate_minor: number | null }>(
    `select day_rate_minor from product_rates where product_id = ?`,
    [productId],
  )
  return row?.day_rate_minor === null || row?.day_rate_minor === undefined
    ? null
    : Number(row.day_rate_minor)
}

/**
 * Substitutes for a swap: everything fit to send off the shelf — here,
 * healthy, not terminal — with the broken item's product marked so the UI
 * can lead with same-product options (the CLIENT's usual preference, never a
 * server rule). Ordered same-product-first, then by code.
 */
export interface SubstituteRow {
  id: string
  code: string
  name: string
  sameProduct: boolean
}

export function substitutesFor(
  db: SqlDriver,
  brokenAssetId: string,
): SubstituteRow[] {
  const broken = db.get<{ product_id: string | null }>(
    `select product_id from assets where id = ?`,
    [brokenAssetId],
  )
  const productId = broken?.product_id ?? null

  return db
    .all<{
      id: string
      asset_code: string | null
      display_name: string | null
      product_id: string | null
    }>(
      `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name,
              a.product_id
         from assets a
         left join products p on p.id = a.product_id
        where a.id <> ?
          and a.presence = 'here'
          and a.health = 'ok'
          and a.disposition is null
        order by a.asset_code`,
      [brokenAssetId],
    )
    .map((r) => ({
      id: r.id,
      code: r.asset_code ?? '—',
      name: r.display_name ?? 'Unnamed',
      sameProduct: productId !== null && r.product_id === productId,
    }))
    .sort((a, b) => Number(b.sameProduct) - Number(a.sameProduct))
}

/** The shelf's live contents as rows (id, code, name) — the ginti checklist.
 *  Same predicate as expectedOnShelf; this carries the display fields. */
export function shelfContents(
  db: SqlDriver,
  locationId: string,
): { id: string; code: string; name: string }[] {
  return db
    .all<{ id: string; asset_code: string | null; display_name: string | null }>(
      `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name
         from assets a
         left join products p on p.id = a.product_id
        where a.current_location_id = ?
          and a.presence = 'here'
          and a.disposition is null
        order by a.asset_code`,
      [locationId],
    )
    .map((r) => ({ id: r.id, code: r.asset_code ?? '—', name: r.display_name ?? 'Unnamed' }))
}

/** Shelves (locations) to count against, for the ginti picker. */
export function shelves(db: SqlDriver): { id: string; name: string }[] {
  return db
    .all<{ id: string; name: string | null }>(
      `select id, name from locations order by name`,
    )
    .map((r) => ({ id: r.id, name: r.name ?? 'Shelf' }))
}

/** What the mirror says is on a shelf right now — the EXPECTED side of a
 *  ginti diff. Live fleet only: a terminal item is not "missing", it is
 *  gone, and a shelf's count should not cry wolf over it. */
export function expectedOnShelf(db: SqlDriver, locationId: string): string[] {
  return db
    .all<{ id: string }>(
      `select id from assets
        where current_location_id = ?
          and presence = 'here'
          and disposition is null
        order by asset_code`,
      [locationId],
    )
    .map((r) => r.id)
}

// ------------------------------------------------------------------ sehat
// The fleet-health reads (0021; vendor-dream-plan Phase D 1–2/6): the
// service nudge, the cycle ceiling and dead stock — all pure reads over the
// mirror plus the queue, because the inputs were already on the device (the
// JUN finding's exact words) and only the readers were missing.

/** The default idle window, in days. The server's dead_stock view reads the
 *  org's own setting; the demo has one org and this constant. */
export const DEAD_STOCK_DAYS = 90

export interface ServiceFacts {
  /** Rental days worked since the last serviced event — the usage meter. */
  daysSinceService: number
  /** The product's threshold, or null: no threshold, no nudge. */
  dueAfter: number | null
  /** Over (or at) the threshold — the NEEDS-A-LOOK state. */
  due: boolean
  /** Whether this product counts cycles (the battery flag). */
  countCycles: boolean
  cycleCount: number
  retireAfterCycles: number | null
  /** At or past the cycle ceiling. */
  cyclesOver: boolean
}

/** One unit's wear facts, for the asset page's service and cycle lines. */
export function serviceFacts(db: SqlDriver, assetId: string): ServiceFacts | null {
  const row = db.get<{
    rental_days_since_service: number | null
    cycle_count: number | null
    service_due_after_rental_days: number | null
    count_cycles: number | null
    retire_after_cycles: number | null
  }>(
    `select a.rental_days_since_service, a.cycle_count,
            p.service_due_after_rental_days, p.count_cycles, p.retire_after_cycles
       from assets a
       left join products p on p.id = a.product_id
      where a.id = ?`,
    [assetId],
  )
  if (!row) return null
  const days = Number(row.rental_days_since_service ?? 0)
  const dueAfter =
    row.service_due_after_rental_days === null || row.service_due_after_rental_days === undefined
      ? null
      : Number(row.service_due_after_rental_days)
  const cycles = Number(row.cycle_count ?? 0)
  const ceiling =
    row.retire_after_cycles === null || row.retire_after_cycles === undefined
      ? null
      : Number(row.retire_after_cycles)
  return {
    daysSinceService: days,
    dueAfter,
    due: dueAfter !== null && days >= dueAfter,
    countCycles: Number(row.count_cycles ?? 0) === 1,
    cycleCount: cycles,
    retireAfterCycles: ceiling,
    cyclesOver: ceiling !== null && cycles >= ceiling,
  }
}

export interface SehatServiceRow {
  id: string
  code: string
  name: string
  days: number
  dueAfter: number
}

export interface SehatCycleRow {
  id: string
  code: string
  name: string
  cycles: number
  ceiling: number
}

export interface SehatDeadRow {
  id: string
  code: string
  name: string
  idleDays: number
  replacementMinor: number | null
}

export interface Sehat {
  serviceDue: SehatServiceRow[]
  cyclesOver: SehatCycleRow[]
  deadStock: SehatDeadRow[]
  /** Replacement value of the dead stock — priced/unpriced split carried,
   *  so 'Rs 45,00,000 +1 unpriced' stays honest (the moneyLabel rule). */
  deadStockValue: MoneyTotal
  deadStockDays: number
}

/**
 * The Sehat read — the fleet's health as three lists, each row a door to
 * its asset page.
 *
 * Live fleet only throughout (disposition null): terminal gear is gone,
 * not sick. DEAD STOCK, the demo's rule: on the shelf (an item OUT is
 * working, not idle), and its last check_out — from this device's queue,
 * the only movement record the demo has — or, never rented here, its
 * last_scanned_at, is older than the window. An asset with NO anchor at
 * all is excluded rather than declared idle: 'never seen moving' is not
 * the same fact as '90+ days idle', and the server's dead_stock view
 * (which has created_at and the whole log) is the authority.
 */
export function sehat(
  db: SqlDriver,
  nowMs: number,
  deadStockDays: number = DEAD_STOCK_DAYS,
): Sehat {
  const serviceDue: SehatServiceRow[] = db
    .all<{ id: string; asset_code: string | null; display_name: string | null; days: number; due_after: number }>(
      `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name,
              a.rental_days_since_service as days, p.service_due_after_rental_days as due_after
         from assets a
         join products p on p.id = a.product_id
        where a.disposition is null
          and p.service_due_after_rental_days is not null
          and a.rental_days_since_service >= p.service_due_after_rental_days
        order by a.rental_days_since_service - p.service_due_after_rental_days desc`,
    )
    .map((r) => ({
      id: r.id,
      code: r.asset_code ?? '—',
      name: r.display_name ?? 'Unnamed',
      days: Number(r.days),
      dueAfter: Number(r.due_after),
    }))

  const cyclesOver: SehatCycleRow[] = db
    .all<{ id: string; asset_code: string | null; display_name: string | null; cycles: number; ceiling: number }>(
      `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name,
              a.cycle_count as cycles, p.retire_after_cycles as ceiling
         from assets a
         join products p on p.id = a.product_id
        where a.disposition is null
          and p.count_cycles = 1
          and p.retire_after_cycles is not null
          and a.cycle_count >= p.retire_after_cycles
        order by a.cycle_count - p.retire_after_cycles desc`,
    )
    .map((r) => ({
      id: r.id,
      code: r.asset_code ?? '—',
      name: r.display_name ?? 'Unnamed',
      cycles: Number(r.cycles),
      ceiling: Number(r.ceiling),
    }))

  // Last checkout per asset, from the queue — the demo's movement record.
  const lastOut = new Map<string, number>()
  for (const op of decodeScanOps(db)) {
    if (op.eventType !== 'check_out' || !op.assetId) continue
    lastOut.set(op.assetId, Math.max(lastOut.get(op.assetId) ?? 0, op.createdAt))
  }

  const cutoff = nowMs - deadStockDays * 24 * 60 * 60 * 1000
  const deadStock: SehatDeadRow[] = db
    .all<{
      id: string
      asset_code: string | null
      display_name: string | null
      last_scanned_at: string | null
      replacement_minor: number | null
    }>(
      `select a.id, a.asset_code, coalesce(p.display_name, a.display_name) as display_name,
              a.last_scanned_at, r.replacement_minor
         from assets a
         left join products p on p.id = a.product_id
         left join product_rates r on r.product_id = a.product_id
        where a.disposition is null
          and a.presence = 'here'
        order by a.asset_code`,
    )
    .flatMap((r) => {
      const scanned = r.last_scanned_at ? Date.parse(r.last_scanned_at) : NaN
      const anchor = lastOut.get(r.id) ?? (Number.isNaN(scanned) ? null : scanned)
      if (anchor === null || anchor >= cutoff) return []
      return [{
        id: r.id,
        code: r.asset_code ?? '—',
        name: r.display_name ?? 'Unnamed',
        idleDays: Math.floor((nowMs - anchor) / (24 * 60 * 60 * 1000)),
        replacementMinor:
          r.replacement_minor === null || r.replacement_minor === undefined
            ? null
            : Number(r.replacement_minor),
      }]
    })
    .sort((a, b) => b.idleDays - a.idleDays)

  const priced = deadStock.filter((d) => d.replacementMinor !== null)
  return {
    serviceDue,
    cyclesOver,
    deadStock,
    deadStockValue: {
      totalMinor: priced.reduce((n, d) => n + (d.replacementMinor ?? 0), 0),
      priced: priced.length,
      unpriced: deadStock.length - priced.length,
    },
    deadStockDays,
  }
}

/** Names of the items physically out on a job, for the nudge message. */
export function outItemNames(db: SqlDriver, jobId: string): string[] {
  return db
    .all<{ name: string | null }>(
      `select coalesce(p.display_name, a.display_name) as name
         from assets a left join products p on p.id = a.product_id
        where a.current_job_id = ? and a.presence in ('out', 'in_transit')
        order by a.asset_code`,
      [jobId],
    )
    .map((r) => r.name ?? 'item')
}

/**
 * The shortfall as one WhatsApp-sized phrase: 'Sony FX6', 'Sony FX6 + 2
 * more'. The full list belongs on the handover screen; a nudge that recites
 * nineteen item names stops being polite.
 */
export function itemsSummary(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  return `${names[0]} + ${names.length - 1} more`
}
