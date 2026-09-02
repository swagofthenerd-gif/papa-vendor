import {
  compareDueDates,
  dueStatus,
  type DueStatus,
  type JobCommitment,
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
`

export interface OpenJobRow {
  id: string
  label: string
  contact: string | null
  expectedBack: string | null
  departsAt: string | null
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
  }>(
    `select j.id, j.label, j.contact, j.expected_back, m.departs_at
       from jobs j left join job_meta m on m.job_id = j.id
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
  /** Items physically out on this job right now. */
  out: number
  /** Locally computed at read time — the CONTRIBUTING time rule. */
  due: DueStatus
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
      label: string | null
      contact: string | null
      expected_back: string | null
    }>(
      `select a.current_job_id as job_id, count(*) as n,
              j.label, j.contact, j.expected_back
         from assets a
         left join jobs j on j.id = a.current_job_id
        where a.current_job_id is not null
          and a.presence in ('out', 'in_transit')
        group by a.current_job_id`,
    )
    .map((r): OutDueRow => ({
      id: r.job_id,
      label: r.label ?? 'Gear out with no job',
      contact: r.contact,
      expectedBack: r.expected_back,
      out: Number(r.n),
      due: dueStatus(r.expected_back, nowMs),
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
      `insert into jobs (id, org_id, label, contact, expected_back, status)
       values (?, ?, ?, ?, ?, 'open')`,
      [input.id, input.orgId, input.label, input.contact, input.expectedBack],
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
 */
export function decodeScanOps(db: SqlDriver): DecodedScanOp[] {
  return db
    .all<{ id: string; payload: string; created_at: number }>(
      `select id, payload, created_at from outbox
        where op = 'submit_scan_batch' order by seq`,
    )
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
