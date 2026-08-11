-- ============================================================================
-- 0003 — The scan event log and the asset projection
--
-- The ONLY event-sourced part of the system. Everything else is CRUD with an
-- audit log, deliberately: event sourcing costs query complexity, projection
-- rebuild machinery and a steep learning curve, and paying that across
-- customers, invoices and rate cards would be a mistake.
--
-- The scan loop is different in four ways that flip the calculus:
--
--   1. It IS the offline write path. Offline writes are inherently a log of
--      intents replayed against a server that has moved on. That is an event
--      log; the only question is whether you admit it.
--   2. Events compose; state mutations do not. "Asset X went out on job B at
--      06:14 by user U" is a complete fact, true regardless of what else
--      happened. "set presence = out" replayed later clobbers newer truth.
--   3. It is the evidentiary record. Damage disputes turn on who had it and
--      when. A mutable column cannot answer that; an immutable log can.
--   4. Projections can be rebuilt. Ship a reducer bug, fix it, replay. With
--      mutable state a bad deploy corrupts inventory permanently.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- devices — the physical phones
--
-- Needed for three things beyond bookkeeping: per-device outbox ordering,
-- idempotency on (device_id, client_seq), and the "WH-02 is offline and will
-- not see this — call Bilal" message the desk needs when it edits a job whose
-- pull is already in progress somewhere with no signal.
-- ---------------------------------------------------------------------------
create table devices (
  id            text primary key,          -- client-generated, stable per install
  org_id        uuid not null references orgs(id) on delete restrict,
  label         text not null default '',  -- 'WH-02'
  last_user_id  uuid references users(id) on delete restrict,

  last_seen_at        timestamptz,
  last_synced_at      timestamptz,
  -- Rolling median of (server_now - device_now). Recorded rather than acted on
  -- for now: the correction threshold is an explicit guess and wants real
  -- field data before it becomes policy.
  clock_offset_ms     bigint not null default 0,
  queued_writes       integer not null default 0,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index devices_org_seen_idx on devices (org_id, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- scan_events — append only, forever
--
-- ORDERING. This is the subtlest decision in the schema and it went through
-- two wrong versions before this one.
--
--   The architecture ordered by effective_time (device clock + measured
--   offset) first. Rejected: a phone four minutes off silently reorders an
--   entire org's history on every projection rebuild, reproducibly.
--
--   The first correction ordered by server_time (arrival) instead. ALSO
--   WRONG, and worse: a device that was offline for three weeks uploads
--   physically-old events that arrive last, so arrival order would apply them
--   as the newest truth and clobber three weeks of reality. That is precisely
--   the case the design must not get wrong.
--
--   What is actually correct: order by WHEN IT HAPPENED, but never trust the
--   device to claim a time it could not have observed. So effective_time is
--   CLAMPED — an event can never claim to have occurred after it arrived:
--
--       effective_time = least(device_time + clock_offset, server_time)
--
--   A device whose clock runs fast is pulled back to arrival time. A device
--   whose clock runs slow keeps its earlier time, which makes its events
--   apply as OLD — the safe direction, since old events do not clobber. Skew
--   can therefore mis-order an event only towards being ignored, never
--   towards silently overwriting newer truth.
--
--   server_seq breaks ties deterministically, which is what makes a
--   projection rebuild reproducible.
-- ---------------------------------------------------------------------------
create table scan_events (
  -- Client-generated UUIDv7. The device mints its own ids offline, which is
  -- what removes the ID-remapping problem from the sync design entirely.
  id            uuid primary key,
  org_id        uuid not null references orgs(id) on delete restrict,

  -- Nullable: a tag scanned offline that this device has never synced cannot
  -- be resolved locally. The event is still recorded — the tag_code is the
  -- durable fact — and asset_id is derived at read time via asset_tags rather
  -- than back-filled, because back-filling would require UPDATE.
  asset_id      uuid references assets(id) on delete restrict,
  tag_code      text,

  event_type    text not null,
  -- HOW the row got here. Load-bearing, not metadata:
  --   scanned — the camera decoded a tag
  --   manual  — found by search and tapped. The absence of this path is what
  --             the research names as the #1 abandonment trigger.
  --   assumed — bulk-confirmed from a case manifest WITHOUT scanning each
  --             child. Countable, visible, and EXCLUDED FROM DISPUTE EVIDENCE.
  --   implied — a permanent accessory moving with its parent.
  --   counted — a cycle count.
  entry_method  text not null default 'scanned',

  job_id        uuid references jobs(id) on delete restrict,
  session_id    uuid,                       -- groups one pull or return
  from_location_id uuid references locations(id) on delete restrict,
  to_location_id   uuid references locations(id) on delete restrict,
  parent_asset_id  uuid references assets(id) on delete restrict,

  health        text,                       -- observed condition, if any
  note          text,

  actor_user_id uuid not null references users(id) on delete restrict,
  device_id     text not null references devices(id) on delete restrict,
  client_seq    bigint not null,            -- monotonic per device, never resets

  device_time       timestamptz not null,   -- what the phone thought. UNTRUSTED.
  clock_offset_ms   bigint not null default 0,
  effective_time    timestamptz not null,   -- clamped; see the header
  server_time       timestamptz not null default now(),
  server_seq        bigserial not null,

  -- A child moved because its parent did.
  implied_by_event_id uuid references scan_events(id) on delete restrict,

  -- CORRECTIONS POINT FORWARD. The architecture had the correcting event set
  -- `superseded_by_event_id` on the ORIGINAL row — which is an UPDATE, and so
  -- impossible under an INSERT-only grant. Whoever hit that at 2am would have
  -- added an UPDATE grant and quietly destroyed the immutability that makes
  -- this log evidence. Supersession is derived at read time instead.
  corrects_event_id uuid references scan_events(id) on delete restrict,

  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),

  constraint scan_events_type_check check (event_type in (
    'check_out', 'check_in', 'move', 'pack', 'unpack',
    'flag_damage', 'send_to_service', 'return_from_service',
    'quarantine', 'release', 'retire', 'found', 'lost',
    'inventory_count', 'intake'
  )),
  constraint scan_events_entry_method_check
    check (entry_method in ('scanned', 'manual', 'assumed', 'implied', 'counted')),
  constraint scan_events_health_check
    check (health is null or health in ('ok', 'servicing', 'quarantined')),
  -- Every event names the thing it happened to, one way or another.
  constraint scan_events_identifies_something
    check (asset_id is not null or tag_code is not null),

  -- IDEMPOTENCY. A retry after a timeout where the server actually succeeded
  -- is a no-op. Non-negotiable: flaky mobile networks produce that case daily.
  constraint scan_events_device_seq_unique unique (device_id, client_seq)
);

create index scan_events_asset_time_idx  on scan_events (org_id, asset_id, effective_time desc);
create index scan_events_session_idx     on scan_events (org_id, session_id);
create index scan_events_job_idx         on scan_events (org_id, job_id);
create index scan_events_arrival_idx     on scan_events (org_id, server_seq desc);
create index scan_events_tag_idx         on scan_events (org_id, tag_code);
create index scan_events_corrects_idx    on scan_events (corrects_event_id)
  where corrects_event_id is not null;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database rather than by good intentions
--
-- Revoking UPDATE and DELETE from papa_app is the primary control. This
-- trigger is the backstop for anything that runs as a more privileged role,
-- including a careless migration or a SECURITY DEFINER function.
-- ---------------------------------------------------------------------------
create or replace function reject_scan_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'scan_events is append-only; correct a mistake by inserting an event with corrects_event_id set'
    using errcode = 'restrict_violation';
end
$$;

create trigger scan_events_no_update
  before update on scan_events for each row execute function reject_scan_event_mutation();
create trigger scan_events_no_delete
  before delete on scan_events for each row execute function reject_scan_event_mutation();

-- ---------------------------------------------------------------------------
-- Alerts the reducer raises
--
-- Every alert type declares who owns it and how it reaches a human, in the
-- same migration that creates it. An alert with no delivery channel is a log
-- line, and rental desks do not watch dashboards.
-- ---------------------------------------------------------------------------
create table alerts (
  id           uuid primary key default uuid_generate_v7(),
  org_id       uuid not null references orgs(id) on delete restrict,

  kind         text not null,
  severity     text not null default 'warn',
  owner_role   text not null default 'manager',
  channel      text not null default 'in_app',

  asset_id     uuid references assets(id) on delete restrict,
  job_id       uuid references jobs(id) on delete restrict,
  event_id     uuid references scan_events(id) on delete restrict,
  other_event_id uuid references scan_events(id) on delete restrict,

  title        text not null,
  detail       text,
  payload      jsonb not null default '{}'::jsonb,

  resolved_at      timestamptz,
  resolved_by      uuid references users(id) on delete restrict,
  resolution_note  text,

  created_at   timestamptz not null default now(),

  constraint alerts_kind_check check (kind in (
    'double_checkout', 'late_event', 'stale_device_import',
    'checkout_while_out', 'unresolved_tag', 'count_discrepancy'
  )),
  constraint alerts_severity_check check (severity in ('info', 'warn', 'critical')),
  constraint alerts_channel_check check (channel in ('in_app', 'whatsapp', 'sms'))
);

create index alerts_org_open_idx on alerts (org_id, created_at desc) where resolved_at is null;
create index alerts_org_kind_idx on alerts (org_id, kind) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- The projection
--
-- assets.presence/health/current_location_id/current_parent_id are derived
-- state. Replace last_applied_key with the two-part ordering key.
-- ---------------------------------------------------------------------------
alter table assets drop column last_applied_key;
alter table assets add column last_applied_at  timestamptz;
alter table assets add column last_applied_seq bigint;
alter table assets add column current_job_id   uuid references jobs(id) on delete restrict;

create index assets_org_job_idx on assets (org_id, current_job_id) where current_job_id is not null;

/**
 * The reducer: one event applied to one asset row.
 *
 * Pure in the sense that matters — given an asset and an event it always
 * produces the same result, so replaying the whole log rebuilds the same
 * state. That is what makes `rebuild_asset_projection` a real escape hatch
 * rather than a hopeful comment.
 */
create or replace function apply_scan_event(p_event scan_events)
returns void
language plpgsql
as $$
declare
  a assets%rowtype;
  is_newer boolean;
begin
  if p_event.asset_id is null then
    return;   -- unresolved tag: recorded, but there is nothing to project onto
  end if;

  select * into a from assets where id = p_event.asset_id;
  if not found then
    return;
  end if;

  -- Corrections do not project directly; the corrected timeline is replayed.
  if p_event.corrects_event_id is not null then
    perform rebuild_asset_projection(p_event.asset_id);
    return;
  end if;

  is_newer := a.last_applied_at is null
    or (p_event.effective_time, p_event.server_seq) > (a.last_applied_at, a.last_applied_seq);

  if not is_newer then
    -- A late arrival from a device that was offline. It belongs in history,
    -- but it must NOT overwrite newer truth. Silently discarding it is the bug
    -- that loses a camera; surfacing it is the feature.
    insert into alerts (org_id, kind, severity, owner_role, asset_id, event_id, title, detail)
    values (
      p_event.org_id, 'late_event', 'warn', 'manager', p_event.asset_id, p_event.id,
      'A late scan arrived out of order',
      format('%s recorded at %s arrived after newer activity and was not applied to current state.',
             p_event.event_type, p_event.effective_time)
    );
    return;
  end if;

  update assets set
    presence = case p_event.event_type
      when 'check_out'   then 'out'
      when 'check_in'    then 'here'
      when 'move'        then case when p_event.to_location_id is not null
                                     and exists (select 1 from locations l
                                                 where l.id = p_event.to_location_id
                                                   and l.kind = 'vehicle')
                                   then 'in_transit' else 'here' end
      when 'lost'        then 'gone'
      when 'retire'      then 'gone'
      when 'found'       then 'here'
      when 'intake'      then 'here'
      else presence
    end,
    health = case p_event.event_type
      when 'send_to_service'     then 'servicing'
      when 'return_from_service' then 'ok'
      when 'quarantine'          then 'quarantined'
      when 'release'             then 'ok'
      when 'flag_damage'         then coalesce(p_event.health, 'quarantined')
      else coalesce(p_event.health, health)
    end,
    current_location_id = coalesce(p_event.to_location_id, current_location_id),
    current_parent_id = case p_event.event_type
      when 'pack'   then p_event.parent_asset_id
      when 'unpack' then null
      else current_parent_id
    end,
    current_job_id = case p_event.event_type
      when 'check_out' then p_event.job_id
      when 'check_in'  then null
      else current_job_id
    end,
    last_scanned_at  = p_event.effective_time,
    last_applied_at  = p_event.effective_time,
    last_applied_seq = p_event.server_seq,
    updated_at       = now()
  where id = p_event.asset_id;
end
$$;

/**
 * Replay every event for one asset, in order, from a clean slate.
 *
 * The escape hatch that makes event sourcing worth its cost: ship a reducer
 * bug, fix the reducer, replay. With mutable state the only recovery is a
 * point-in-time restore that rolls back everything else too.
 *
 * Superseded events are skipped — an event that a later event corrects never
 * happened, as far as current state is concerned, though it stays visible in
 * history.
 */
create or replace function rebuild_asset_projection(p_asset_id uuid)
returns void
language plpgsql
as $$
declare
  e scan_events%rowtype;
begin
  update assets set
    presence = 'here', health = 'ok',
    current_location_id = null, current_parent_id = null, current_job_id = null,
    last_scanned_at = null, last_applied_at = null, last_applied_seq = null
  where id = p_asset_id;

  for e in
    select * from scan_events
    where asset_id = p_asset_id
      and corrects_event_id is null
      and id not in (
        select corrects_event_id from scan_events
        where corrects_event_id is not null and asset_id = p_asset_id
      )
    order by effective_time, server_seq
  loop
    -- Re-entering apply_scan_event would recurse on corrections; the filter
    -- above already removed them, so inline the ordering guard by clearing it.
    update assets set last_applied_at = null, last_applied_seq = null where id = p_asset_id;
    perform apply_scan_event(e);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The insert trigger
--
-- Clamps effective_time, then projects. Clamping here rather than in the
-- client is the point: the device is not trusted to state when something
-- happened, only to state that it did.
-- ---------------------------------------------------------------------------
create or replace function on_scan_event_insert()
returns trigger
language plpgsql
as $$
declare
  claimed timestamptz;
begin
  claimed := new.device_time + make_interval(secs => new.clock_offset_ms / 1000.0);

  -- An event can never claim to have happened after it arrived.
  new.effective_time := least(claimed, new.server_time);

  return new;
end
$$;

create trigger scan_events_clamp_time
  before insert on scan_events for each row execute function on_scan_event_insert();

create or replace function after_scan_event_insert()
returns trigger
language plpgsql
as $$
begin
  perform apply_scan_event(new);
  return null;
end
$$;

create trigger scan_events_project
  after insert on scan_events for each row execute function after_scan_event_insert();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table devices     enable row level security;
alter table scan_events enable row level security;
alter table alerts      enable row level security;

alter table devices     force row level security;
alter table scan_events force row level security;
alter table alerts      force row level security;

create policy devices_tenant on devices for all
  using (org_id = current_org_id()) with check (org_id = current_org_id());

-- SELECT and INSERT only. No policy grants UPDATE or DELETE, and the grant
-- below withholds them too — belt and braces on the one table that must never
-- be rewritten.
create policy scan_events_select on scan_events for select
  using (org_id = current_org_id());
create policy scan_events_insert on scan_events for insert
  with check (org_id = current_org_id());

create policy alerts_tenant on alerts for all
  using (org_id = current_org_id()) with check (org_id = current_org_id());

grant select, insert, update on devices to papa_app;
grant select, insert on scan_events to papa_app;          -- deliberately no update/delete
grant usage, select on sequence scan_events_server_seq_seq to papa_app;
grant select, insert, update on alerts to papa_app;
grant execute on function apply_scan_event(scan_events), rebuild_asset_projection(uuid) to papa_app;
