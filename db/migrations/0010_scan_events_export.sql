-- ============================================================================
-- 0010 — The cold export of scan_events
--
-- `scan_events` is the ONE table that cannot be reconstructed from anything
-- else. Assets, presence and location are all projections of it and can be
-- replayed; the log itself has no upstream. The readiness ledger lists "no
-- cold export of scan_events" as a gap, and it is the gap that makes every
-- other backup decision cheaper — with an independent copy of the log, a
-- restore that loses recent state is recoverable, and PITR at $100/mo can
-- honestly wait for revenue.
--
-- ---------------------------------------------------------------------------
-- THE HAZARD, because this project has already been bitten by exactly it.
--
-- `server_seq` is a bigserial. Sequence values are handed out BEFORE commit
-- and transactions commit out of order, so:
--
--   txn A takes server_seq 100 · txn B takes 101 · B commits · A is still open
--
-- An exporter that reads "everything up to max(server_seq)" right now sees
-- 101, exports it, and records a cursor of 101. When A commits, row 100 exists
-- below the cursor and is NEVER exported. Silently, forever, in the one table
-- whose entire purpose is being evidence.
--
-- This is the same failure the sync cursor hit in 0005 — "a cursor bug that
-- skipped rows" — and the rule established there applies here unchanged:
-- THE CURSOR IS THE MINIMUM SAFE ADVANCE.
--
-- Two mechanisms, because one is a mitigation and the other is a detector:
--
--   1. A SETTLE LAG. Only export rows old enough that their transaction has
--      certainly finished. submit_scan_batch runs in single-digit
--      milliseconds, so the default of 15 minutes is roughly five orders of
--      magnitude of headroom.
--
--   2. A LEDGER AND A RECONCILIATION. The lag is a probability argument, and
--      probability arguments fail eventually and quietly. Every export batch
--      records how many rows it wrote; export_gap_check() compares the sum
--      against the true count below the cursor. If a row was ever skipped,
--      the numbers disagree and say so.
--
-- Mechanism 2 is the one that matters. A backup you cannot prove is complete
-- is a backup you will discover is incomplete at the worst possible moment.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- scan_export_state — one row, the cursor
-- ---------------------------------------------------------------------------
create table scan_export_state (
  id           boolean primary key default true constraint one_row check (id),
  cursor_seq   bigint not null default 0,
  updated_at   timestamptz not null default now()
);

insert into scan_export_state (id, cursor_seq) values (true, 0);

-- ---------------------------------------------------------------------------
-- scan_export_batches — the ledger that makes completeness checkable
--
-- Append-only in spirit and tiny in practice: one row per export run, so a
-- nightly job produces ~365 rows a year against the event log's billions.
-- ---------------------------------------------------------------------------
create table scan_export_batches (
  id           bigserial primary key,
  from_seq     bigint not null,      -- exclusive
  to_seq       bigint not null,      -- inclusive
  row_count    bigint not null,
  exported_at  timestamptz not null default now()
);

create index scan_export_batches_seq_idx on scan_export_batches (to_seq desc);

-- ---------------------------------------------------------------------------
-- export_scan_events — emit NDJSON for everything settled since the cursor
--
-- Returns one JSON object per line, which is the format that survives partial
-- writes: a truncated NDJSON file loses its last line and stays parseable,
-- where a truncated JSON array is entirely unreadable. For an artefact whose
-- job is to be there after something went wrong, that property is the whole
-- reason to prefer it.
--
-- Crosses org boundaries deliberately — this is operator-level backup, not a
-- tenant-facing read — so it is NOT granted to papa_app and must be run by the
-- maintenance role. That is also why it is SECURITY INVOKER: it should fail
-- loudly if called by a role without the privileges, rather than quietly
-- becoming a cross-tenant data export reachable from the application.
--
-- Advancing the cursor is the caller's job, via commit_scan_export(), and
-- deliberately separate: the rows must be DURABLE somewhere else before this
-- database forgets it needs to send them. An exporter that advanced its own
-- cursor would lose a batch to any upload that failed after the query.
-- ---------------------------------------------------------------------------
create or replace function export_scan_events(
  p_lag   interval default '15 minutes',
  p_limit integer  default 100000
)
returns table (server_seq bigint, line text)
language sql
stable
as $$
  select e.server_seq,
         jsonb_build_object(
           'id', e.id, 'org_id', e.org_id, 'asset_id', e.asset_id,
           'tag_code', e.tag_code, 'event_type', e.event_type,
           'entry_method', e.entry_method, 'job_id', e.job_id,
           'session_id', e.session_id,
           'from_location_id', e.from_location_id,
           'to_location_id', e.to_location_id,
           'parent_asset_id', e.parent_asset_id,
           'health', e.health, 'note', e.note,
           'actor_user_id', e.actor_user_id, 'device_id', e.device_id,
           'client_seq', e.client_seq,
           'device_time', e.device_time, 'clock_offset_ms', e.clock_offset_ms,
           'effective_time', e.effective_time, 'server_time', e.server_time,
           'server_seq', e.server_seq,
           'implied_by_event_id', e.implied_by_event_id,
           'corrects_event_id', e.corrects_event_id,
           'payload', e.payload, 'created_at', e.created_at
         )::text
    from scan_events e
   where e.server_seq > (select cursor_seq from scan_export_state)
     -- The settle lag. server_time is assigned by the server at insert, so
     -- unlike effective_time it cannot be steered by a device's wrong clock.
     and e.server_time < now() - p_lag
   order by e.server_seq
   limit p_limit;
$$;

comment on function export_scan_events(interval, integer) is
  'NDJSON export of settled scan_events past the cursor. Does NOT advance the cursor — call commit_scan_export() only after the data is durable elsewhere.';

-- ---------------------------------------------------------------------------
-- commit_scan_export — advance the cursor, and record what was written
-- ---------------------------------------------------------------------------
create or replace function commit_scan_export(
  p_to_seq    bigint,
  p_row_count bigint
)
returns void
language plpgsql
as $$
declare
  v_from bigint;
begin
  select cursor_seq into v_from from scan_export_state;

  -- Monotonic only. A rewind would silently re-export and, worse, corrupt the
  -- reconciliation by double-counting rows the ledger already claims.
  if p_to_seq < v_from then
    raise exception 'export cursor cannot move backwards (% -> %)', v_from, p_to_seq
      using errcode = 'check_violation';
  end if;

  if p_to_seq = v_from then
    return;   -- nothing was exported; not an error
  end if;

  insert into scan_export_batches (from_seq, to_seq, row_count)
  values (v_from, p_to_seq, p_row_count);

  update scan_export_state
     set cursor_seq = p_to_seq, updated_at = now()
   where id;
end
$$;

-- ---------------------------------------------------------------------------
-- export_gap_check — the detector
--
-- Compares rows the ledger claims to have exported against rows that actually
-- exist below the cursor. They must be equal. Any drift means the settle lag
-- was not enough and a row was skipped — which is otherwise completely silent.
--
-- Run it after every export. It is one indexed count against a table with a
-- few hundred rows, and it is the only thing standing between "we have
-- backups" and "we have backups that are complete".
-- ---------------------------------------------------------------------------
create or replace function export_gap_check()
returns table (cursor_seq bigint, exported_rows bigint, actual_rows bigint, missing bigint)
language sql
stable
as $$
  select s.cursor_seq,
         coalesce((select sum(row_count) from scan_export_batches), 0),
         (select count(*) from scan_events where server_seq <= s.cursor_seq),
         (select count(*) from scan_events where server_seq <= s.cursor_seq)
           - coalesce((select sum(row_count) from scan_export_batches), 0)
    from scan_export_state s;
$$;

comment on function export_gap_check() is
  'Zero `missing` means the cold export is provably complete below the cursor. Anything else means the settle lag failed and rows were skipped.';

-- Operator-level, not application-level. papa_app gets nothing here: these
-- functions read across every org by design.
revoke all on function export_scan_events(interval, integer) from public;
revoke all on function commit_scan_export(bigint, bigint) from public;
revoke all on function export_gap_check() from public;
