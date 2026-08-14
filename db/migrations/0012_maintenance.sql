-- ============================================================================
-- 0012 — Scheduled maintenance, and knowing whether it ran
--
-- The ledger lists these as separate one-liners: "`prune_rate_limits()` exists;
-- nothing calls it. Needs a cron." Expired `device_sessions` accumulate the
-- same way. Individually each is a cron entry and barely worth a migration.
--
-- ---------------------------------------------------------------------------
-- THE ACTUAL PROBLEM IS NOT THE MISSING CRON. IT IS THE SILENT ONE.
--
-- Adding three scheduler entries takes an afternoon. What happens next is the
-- part worth designing for: a cron that is misconfigured, or that works for
-- eight months and then stops when a project is migrated or a key rotates,
-- looks EXACTLY like a cron that is working. Nothing errors. Tables grow
-- slowly. The first symptom is a bill or a slow query, months later, with no
-- way to tell when it stopped.
--
-- That is the same failure shape as 0011's silent device, and it takes the
-- same answer: THE ABSENCE OF WORK MUST BE OBSERVABLE. So every task records
-- that it ran, and `maintenance_health` reports what is overdue. A scheduler
-- that dies is then visible in the same place a phone that dies is.
--
-- One entry point rather than three, so there is one thing to schedule and one
-- thing to check. Adding a task later means editing this function, not
-- remembering to add another cron line — the remembering is what fails.
-- ============================================================================

create table maintenance_runs (
  id          bigserial primary key,
  task        text        not null,
  ran_at      timestamptz not null default now(),
  duration_ms integer     not null,
  result      jsonb       not null default '{}'::jsonb,
  ok          boolean     not null default true,
  error       text
);

create index maintenance_runs_task_idx on maintenance_runs (task, ran_at desc);

comment on table maintenance_runs is
  'One row per maintenance task execution. Exists so a scheduler that stops is visible; see maintenance_health.';

-- ---------------------------------------------------------------------------
-- How often each task is expected to run
--
-- A table rather than constants in the function, because "overdue" is the
-- whole point and it needs to be readable by whatever ends up doing alerting
-- without parsing plpgsql.
-- ---------------------------------------------------------------------------
create table maintenance_schedule (
  task          text primary key,
  expected_every interval not null,
  -- Grace before overdue. A cron that runs hourly and is four minutes late is
  -- normal; alerting on that produces exactly the noise 0011 avoids.
  grace         interval not null default '1 hour'
);

insert into maintenance_schedule (task, expected_every, grace) values
  ('prune_rate_limits',        '1 hour',  '2 hours'),
  ('prune_device_sessions',    '1 day',   '6 hours'),
  ('stale_device_alerts',      '1 hour',  '2 hours');

-- ---------------------------------------------------------------------------
-- prune_device_sessions — expired sessions are not a revocation record
--
-- Deleting an EXPIRED session is safe and is not the same act as revoking one.
-- A session past `expires_at` already grants nothing; the row is only storage.
-- `revocations` is the durable record of a deliberate withdrawal of access and
-- is deliberately NOT touched here — losing it would let a revoked device look
-- merely expired, which is a different and much weaker statement.
-- ---------------------------------------------------------------------------
create or replace function prune_device_sessions(p_grace interval default '30 days')
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  delete from device_sessions where expires_at < now() - p_grace;
  get diagnostics n = row_count;
  return n;
end
$$;

comment on function prune_device_sessions(interval) is
  'Removes long-expired sessions. Never touches revocations — that record must outlive the session it revoked.';

-- ---------------------------------------------------------------------------
-- run_maintenance — the single scheduler entry point
--
-- Each task is wrapped so ONE failure does not abandon the others. A pruning
-- error that also silently skipped the stale-device alerts would take out the
-- monitoring at the same moment something is already wrong, which is precisely
-- when it is needed.
-- ---------------------------------------------------------------------------
create or replace function run_maintenance()
returns table (task text, ok boolean, result jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_res   jsonb;
begin
  -- prune_rate_limits -------------------------------------------------------
  v_start := clock_timestamp();
  begin
    v_res := jsonb_build_object('deleted', prune_rate_limits());
    insert into maintenance_runs (task, duration_ms, result, ok)
    values ('prune_rate_limits',
            extract(milliseconds from clock_timestamp() - v_start)::int, v_res, true);
    return query select 'prune_rate_limits'::text, true, v_res;
  exception when others then
    insert into maintenance_runs (task, duration_ms, ok, error)
    values ('prune_rate_limits',
            extract(milliseconds from clock_timestamp() - v_start)::int, false, sqlerrm);
    return query select 'prune_rate_limits'::text, false, jsonb_build_object('error', sqlerrm);
  end;

  -- prune_device_sessions ---------------------------------------------------
  v_start := clock_timestamp();
  begin
    v_res := jsonb_build_object('deleted', prune_device_sessions());
    insert into maintenance_runs (task, duration_ms, result, ok)
    values ('prune_device_sessions',
            extract(milliseconds from clock_timestamp() - v_start)::int, v_res, true);
    return query select 'prune_device_sessions'::text, true, v_res;
  exception when others then
    insert into maintenance_runs (task, duration_ms, ok, error)
    values ('prune_device_sessions',
            extract(milliseconds from clock_timestamp() - v_start)::int, false, sqlerrm);
    return query select 'prune_device_sessions'::text, false, jsonb_build_object('error', sqlerrm);
  end;

  -- stale device alerts -----------------------------------------------------
  v_start := clock_timestamp();
  begin
    v_res := jsonb_build_object(
      'raised',   raise_stale_device_alerts(),
      'resolved', resolve_stale_device_alerts());
    insert into maintenance_runs (task, duration_ms, result, ok)
    values ('stale_device_alerts',
            extract(milliseconds from clock_timestamp() - v_start)::int, v_res, true);
    return query select 'stale_device_alerts'::text, true, v_res;
  exception when others then
    insert into maintenance_runs (task, duration_ms, ok, error)
    values ('stale_device_alerts',
            extract(milliseconds from clock_timestamp() - v_start)::int, false, sqlerrm);
    return query select 'stale_device_alerts'::text, false, jsonb_build_object('error', sqlerrm);
  end;
end
$$;

comment on function run_maintenance() is
  'The one thing to schedule. Each task is isolated so one failure does not abandon the rest.';

-- ---------------------------------------------------------------------------
-- maintenance_health — is the scheduler alive?
--
-- The question this whole migration exists to answer. A task that has NEVER
-- run reports overdue rather than absent, because "no rows" is the answer a
-- dashboard renders as blank and a person reads as fine.
-- ---------------------------------------------------------------------------
create view maintenance_health with (security_invoker = true) as
select
  s.task,
  s.expected_every,
  last.ran_at        as last_run_at,
  last.ok            as last_run_ok,
  last.error         as last_error,
  (last.ran_at is null
   or last.ran_at < now() - (s.expected_every + s.grace)) as overdue
  from maintenance_schedule s
  left join lateral (
    select r.ran_at, r.ok, r.error
      from maintenance_runs r
     where r.task = s.task
     order by r.ran_at desc
     limit 1
  ) last on true;

comment on view maintenance_health is
  'Overdue = the scheduler is not running this task. A task that never ran is overdue, not absent.';

-- Operator-level. papa_app has no business running or reading these: they are
-- cross-org by nature and carry no tenant dimension to scope by.
revoke all on function run_maintenance() from public;
revoke all on function prune_device_sessions(interval) from public;
