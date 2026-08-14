-- ============================================================================
-- 0011 — Making a silent device visible
--
-- The readiness ledger states the gap plainly: "a device with 400 queued
-- writes for three days is invisible." It is the failure that quietly voids
-- the product's promise — the desk believes inventory is live, three days of
-- scans are sitting on a phone in someone's pocket, and every screen looks
-- normal.
--
-- ---------------------------------------------------------------------------
-- WHAT THE SERVER CAN AND CANNOT KNOW, because this shapes the whole design
--
-- `devices.queued_writes` looks like the obvious signal and it is nearly
-- useless. Read the write path: submit_scan_batch only ever sets it to ZERO,
-- on success. Nothing else writes it. And even if the device reported its
-- depth, that report can only arrive WHEN THE DEVICE CAN REACH THE SERVER —
-- which is exactly when the queue is being drained.
--
--   A device with 400 queued writes and no signal cannot tell anyone it has
--   400 queued writes. That is not an implementation gap; it is the shape of
--   the problem.
--
-- So the only honest signal is SILENCE. `last_synced_at` growing old is the
-- one thing the server observes without the device's cooperation, and it is
-- what this view is built on. queued_writes is carried through as context —
-- "it had 12 pending when we last heard from it" — and never as the trigger.
--
-- The escalation matches outbox.ts's syncStatus(): being offline is NORMAL in
-- a Lahore warehouse and must stay calm, because an app that cries wolf about
-- expected conditions teaches people to ignore it. Age is what makes silence
-- abnormal.
-- ============================================================================

alter table alerts drop constraint alerts_kind_check;
alter table alerts add constraint alerts_kind_check check (kind in (
  'double_checkout', 'late_event', 'stale_device_import',
  'checkout_while_out', 'unresolved_tag', 'count_discrepancy',
  -- New. Distinct from stale_device_import, which is about events ARRIVING
  -- late from a device; this is about a device that has stopped arriving at
  -- all. Naming them apart matters because the responses differ: one is
  -- "review this data", the other is "go find this phone".
  'device_not_syncing'
));

-- ---------------------------------------------------------------------------
-- sync_health — one row per device, with the silence made legible
--
-- A view rather than a table: it is derived state, and a materialised copy
-- would be one more thing to keep correct for no gain at this size.
--
-- RLS is inherited from `devices`, so a manager sees their own org's phones
-- and nothing else, with no org filter written here. Same rule as pull_changes
-- — a hand-written tenancy filter alongside RLS is a second place to get it
-- wrong, and the two eventually disagree.
-- ---------------------------------------------------------------------------
-- `security_invoker = true` is NOT optional and NOT a detail.
--
-- A Postgres view defaults to running with the privileges of its OWNER. The
-- owner here is the migration role, which is a superuser, and SUPERUSERS
-- BYPASS RLS — so the default makes this view a cross-tenant read of every
-- device in every org, reachable by any authenticated user.
--
-- This is the same trap 0004 documents for SECURITY DEFINER functions,
-- wearing different clothes, and it is easier to miss here because a view
-- looks like a query rather than like code. It was caught only because the
-- test asserts tenancy on a MONITORING SURFACE — the kind of place nobody
-- thinks of as a data surface.
create view sync_health with (security_invoker = true) as
select
  d.id                as device_id,
  d.org_id,
  d.label,
  d.last_user_id,
  u.display_name      as last_user_name,
  d.last_seen_at,
  d.last_synced_at,
  d.queued_writes     as last_reported_queue,
  extract(epoch from (now() - coalesce(d.last_synced_at, d.created_at))) / 3600.0
                      as hours_since_sync,
  case
    -- Never synced at all. A phone that was set up and then never used is a
    -- different problem from one that stopped, and it is usually an onboarding
    -- failure — someone installed the app and walked away.
    when d.last_synced_at is null then 'never_synced'
    when d.last_synced_at < now() - interval '72 hours' then 'critical'
    when d.last_synced_at < now() - interval '24 hours' then 'stale'
    else 'ok'
  end                 as status
  from devices d
  left join users u on u.id = d.last_user_id;

comment on view sync_health is
  'Per-device sync freshness. Built on silence (last_synced_at), not on queued_writes — an offline device cannot report its own queue depth.';

grant select on sync_health to papa_app;

-- ---------------------------------------------------------------------------
-- raise_stale_device_alerts — turn silence into something with a name on it
--
-- The ledger's own framing is the requirement: an actionable alert "with a
-- name attached". "Device WH-02 has not synced in 3 days" is ignorable;
-- "WH-02, last used by Bilal, has not synced since Tuesday" gets a phone call.
--
-- SECURITY DEFINER and cross-org, because this runs from a scheduler with no
-- org context. It is the third and last DEFINER function in the schema, and
-- like the other two it takes no user input and does no user-controlled
-- querying — it reads devices and writes alerts keyed by the org_id already on
-- those rows.
-- ---------------------------------------------------------------------------
create or replace function raise_stale_device_alerts(
  p_threshold interval default '24 hours'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with stale as (
    select d.id, d.org_id, d.label, d.last_synced_at,
           coalesce(u.display_name, 'nobody') as who
      from devices d
      left join users u on u.id = d.last_user_id
     where d.last_synced_at is not null
       and d.last_synced_at < now() - p_threshold
       -- Idempotent. A scheduler runs this hourly; re-raising the same alert
       -- every hour is how an alert channel becomes noise people mute, and a
       -- muted channel is worse than no channel because it looks like one.
       and not exists (
         select 1 from alerts a
          where a.org_id = d.org_id
            and a.kind = 'device_not_syncing'
            and a.resolved_at is null
            and a.payload ->> 'device_id' = d.id
       )
  )
  insert into alerts (org_id, kind, severity, owner_role, channel, title, detail, payload)
  select
    s.org_id, 'device_not_syncing',
    case when s.last_synced_at < now() - interval '72 hours' then 'critical' else 'warn' end,
    'manager', 'whatsapp',
    format('%s has not synced since %s',
           coalesce(nullif(s.label, ''), s.id),
           to_char(s.last_synced_at, 'Dy DD Mon HH24:MI')),
    format('Last used by %s. Any scans made on it since then are still on the phone and are not in the system. They are not lost — they send as soon as it gets signal.',
           s.who),
    jsonb_build_object('device_id', s.id, 'last_synced_at', s.last_synced_at)
    from stale s;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

comment on function raise_stale_device_alerts(interval) is
  'Raises one open alert per silent device. Idempotent — will not re-raise while an unresolved alert exists for that device.';

-- ---------------------------------------------------------------------------
-- resolve_stale_device_alerts — close them when the phone comes back
--
-- Without this the alert list only grows, and a list that only grows is one
-- nobody reads. A device that syncs again has answered the question the alert
-- asked.
-- ---------------------------------------------------------------------------
create or replace function resolve_stale_device_alerts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update alerts a
     set resolved_at = now(),
         resolution_note = 'device synced again'
    from devices d
   where a.kind = 'device_not_syncing'
     and a.resolved_at is null
     and a.payload ->> 'device_id' = d.id
     and d.last_synced_at > (a.payload ->> 'last_synced_at')::timestamptz;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function raise_stale_device_alerts(interval) from public;
revoke all on function resolve_stale_device_alerts() from public;
