-- ============================================================================
-- 0020 — The fleet lifecycle: terminal dispositions, the crisis-day swap,
--        and the cycle-count treatment
--
-- Ordered by the year simulation (docs/year-in-the-life.md (b)4, (b)8 and
-- the JUL stocktake; findings `no-terminal-asset-state`, `no-swap-flow`,
-- `no-cycle-count`): three ways gear left the fleet this year and none was
-- expressible — the paid-for lost cable kept its job open forever, the
-- absconded client's FX6 stayed a red board row with no theft story, and
-- the stocktake could not record a disagreement with the mirror. Plus the
-- January camera-drop, faked as a second one-line job that split the money
-- and orphaned the evidence.
--
-- WHAT THIS MIGRATION DECIDES, and why:
--
--   D1  DISPOSITION IS A FOURTH AXIS, NOT A FIFTH PRESENCE. assets gains
--       `disposition` (null | lost | stolen | sold | retired): WHY the item
--       left the fleet, beside presence's WHERE it is. presence='gone'
--       stays what it always was; disposition is only ever non-null when
--       presence='gone' (constraint below). A projection like the other
--       three axes: rebuilt from scan_events, never client-written.
--
--   D2  TERMINAL OUTCOMES ARE SCAN EVENTS, so the evidence chain holds:
--       three new event types — mark_lost, mark_stolen, mark_sold — ride
--       the same append-only log, BEFORE-trigger tenancy checks, clamped
--       ordering and projection as every other movement. The reducer maps
--       them to presence='gone' + the disposition, AND CLEARS
--       current_job_id — that is what finally lets October's ghost job
--       close: the close rule (0018 D3) was always right; the cable just
--       had nowhere to go. `retire` (0003 vocabulary) now stamps
--       disposition='retired' on the same reasoning. `found` is the one
--       recovery door: it clears the disposition and brings the item home
--       — a lost cable that turns up, a stolen camera the police return,
--       even a sale that fell through; the log tells the story either way.
--       The pre-existing `lost` event stays what it was — the device-side
--       observation ("can't find it"), presence='gone', NO disposition:
--       a tech's shrug is not an owner's declaration.
--
--       THE GATE (D2b): declaring gear lost/stolen/sold rewrites what the
--       fleet IS, not where something stands, so submit_scan_batch (fifth
--       edition below) refuses mark_* events from anyone below manager.
--       The RPC layer is the right place: the event vocabulary stays one
--       table, and a driver's phone can still scan `found` when the cable
--       turns up in a case lining.
--
--   D3  SALE MONEY IS A NOTE, NOT A LEDGER KIND. mark_sold may carry the
--       sale amount in the event payload (`sale_amount_minor`) and note —
--       the record survives on the evidence chain — but NO ledger or
--       expense row is written: the customer ledger is udhaar between the
--       house and its clients, and the kharcha book is money OUT. A
--       sale-income book is real, separate follow-up (vendor-dream-plan
--       Phase D polish), not a kind to invent here in disguise.
--
--   D4  THE PUBLIC RESOLVER: STOLEN IS DELIBERATELY LOUD; EVERY OTHER
--       TERMINAL STATE IS SILENT. Anti-enumeration (0002) says unknown,
--       retired, lost and sold tags must be indistinguishable from
--       nonsense — a scraper probing tag codes learns nothing, a buyer of
--       sold gear does not inherit the old owner's identity, and a lost
--       item does not advertise that nobody knows where it is. STOLEN is
--       the designed exception (Lenstag's proof; Phase E2 groundwork):
--       the whole point of marking gear stolen is that the next person to
--       scan it — a pawn shop, a rival house's intake desk — sees a
--       STOLEN notice with the org's contact line, public_tag_show_owner
--       or not. Marking stolen is an owner/manager act (D2b), so going
--       loud is the org's own decision, made when it flips the state.
--
--   D5  THE SWAP IS ONE ATOMIC RPC, THREE EVENTS, ONE SESSION. Given a
--       live job, the broken asset on it and a fit substitute, swap_asset
--       records: the broken item's check_in (it left the job), a
--       flag_damage (or quarantine) on it, and the substitute's check_out
--       onto the same job — all sharing a fresh session_id, the flag and
--       the substitute's checkout carrying implied_by_event_id → the
--       check_in, payloads cross-referencing. The rental story stays on
--       ONE job, the damage evidence names the broken unit, and nothing
--       is fabricated. Refused: cross-org anything, a closed job, a
--       broken asset that is not actually on the job, and a substitute
--       that is terminal, off the shelf, unfit or unrentable.
--
--       Server-minted events need a device identity (scan_events.device_id
--       + client_seq is the idempotency spine), and they must NEVER borrow
--       a real phone's — a server-minted client_seq would collide with the
--       phone's own outbox numbering later. Each org gets a synthetic
--       device row (`server:<org>`), its seqs drawn from a global
--       sequence. Attribution stays honest in actor_user_id and the audit
--       row.
--
--   D6  THE CYCLE COUNT NEEDED NO NEW WRITE — the 0003 vocabulary already
--       had inventory_count and entry_method='counted', and the reducer
--       already does the right thing: last_scanned_at moves, presence
--       does NOT (a count asserts "seen on the shelf", not a movement),
--       and a count at a location updates current_location_id (the shelf
--       is where it was seen). What was missing is pinned by tests below,
--       plus one read: count_sessions, the per-session grouping
--       (session_id has been on scan_events since 0003) a stocktake
--       screen sums — when, where, how many.
--
-- Everything here is idempotent: IF NOT EXISTS / OR REPLACE / drop-and-
-- recreate pairs, the 0015–0019 discipline. 0001–0019 stay untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- assets.disposition — why it left the fleet (D1)
-- ---------------------------------------------------------------------------
alter table assets add column if not exists disposition text;

alter table assets drop constraint if exists assets_disposition_check;
alter table assets add constraint assets_disposition_check
  check (disposition is null
         or disposition in ('lost', 'stolen', 'sold', 'retired'));

-- The axes cannot disagree: a disposition is a way of being gone.
alter table assets drop constraint if exists assets_disposition_gone_check;
alter table assets add constraint assets_disposition_gone_check
  check (disposition is null or presence = 'gone');

create index if not exists assets_org_disposition_idx
  on assets (org_id, disposition) where disposition is not null;

comment on column assets.disposition is
  'Why the item left the fleet (0020 D1): lost | stolen | sold | retired, null while it is fleet. A projection driven by mark_lost / mark_stolen / mark_sold / retire scan events; found clears it. Non-null implies presence=''gone''.';

-- ---------------------------------------------------------------------------
-- The three declarations join the event vocabulary (D2)
-- ---------------------------------------------------------------------------
alter table scan_events drop constraint if exists scan_events_type_check;
alter table scan_events add constraint scan_events_type_check check (event_type in (
  'check_out', 'check_in', 'move', 'pack', 'unpack',
  'flag_damage', 'send_to_service', 'return_from_service',
  'quarantine', 'release', 'retire', 'found', 'lost',
  'inventory_count', 'intake',
  'mark_lost', 'mark_stolen', 'mark_sold'
));

-- ---------------------------------------------------------------------------
-- The reducer, third edition (D2): 0015's text verbatim plus the
-- disposition column. mark_* → gone + disposition + OFF THE JOB;
-- retire → gone + 'retired'; found → here + disposition cleared.
-- ---------------------------------------------------------------------------
create or replace function apply_scan_event(p_event scan_events)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a assets%rowtype;
  is_newer boolean;
begin
  if p_event.asset_id is null then
    return;   -- unresolved tag: recorded, but there is nothing to project onto
  end if;

  select * into a from assets where id = p_event.asset_id for update;
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
      when 'mark_lost'   then 'gone'
      when 'mark_stolen' then 'gone'
      when 'mark_sold'   then 'gone'
      when 'found'       then 'here'
      when 'intake'      then 'here'
      else presence
    end,
    -- D1: the WHY beside the WHERE. Ordered so the disposition can never
    -- outlive being gone: the same event that sets it sets presence, and
    -- `found` clears both in one update.
    disposition = case p_event.event_type
      when 'mark_lost'   then 'lost'
      when 'mark_stolen' then 'stolen'
      when 'mark_sold'   then 'sold'
      when 'retire'      then 'retired'
      when 'found'       then null
      else disposition
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
      -- D2: terminal gear projects onto no job. This is the line that lets
      -- October's ghost job finally close — the close rule stays untouched.
      when 'mark_lost'   then null
      when 'mark_stolen' then null
      when 'mark_sold'   then null
      else current_job_id
    end,
    last_scanned_at  = p_event.effective_time,
    last_applied_at  = p_event.effective_time,
    last_applied_seq = p_event.server_seq,
    updated_at       = now()
  where id = p_event.asset_id;
end
$$;

-- The clean slate must clear the fourth axis too, or a replay of a
-- mark-then-found history would resurrect the stale disposition.
create or replace function rebuild_asset_projection(p_asset_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e scan_events%rowtype;
  v_org uuid;
  v_tag text;
begin
  select org_id into v_org from assets where id = p_asset_id for update;
  if not found then
    return;
  end if;

  select tag_code into v_tag
    from asset_tags where asset_id = p_asset_id and status = 'active';

  update assets set
    presence = 'here', health = 'ok', disposition = null,
    current_location_id = null, current_parent_id = null, current_job_id = null,
    last_scanned_at = null, last_applied_at = null, last_applied_seq = null
  where id = p_asset_id;

  for e in
    select * from scan_events s
    where s.org_id = v_org
      and (s.asset_id = p_asset_id
           or (s.asset_id is null and v_tag is not null and s.tag_code = v_tag))
      and s.corrects_event_id is null
      and s.id not in (
        select c.corrects_event_id from scan_events c
        where c.corrects_event_id is not null and c.org_id = v_org
      )
    order by s.effective_time, s.server_seq
  loop
    -- Re-entering apply_scan_event would recurse on corrections; the filter
    -- above already removed them, so inline the ordering guard by clearing it.
    update assets set last_applied_at = null, last_applied_seq = null where id = p_asset_id;
    -- In-memory adoption only: the stored row keeps asset_id null forever.
    e.asset_id := p_asset_id;
    perform apply_scan_event(e);
  end loop;
end
$$;

-- 0015's revokes, restated for the recreated pair (OR REPLACE keeps an
-- existing ACL, but belt-and-braces is the house style on these two).
revoke execute on function apply_scan_event(scan_events)  from public, papa_app;
revoke execute on function rebuild_asset_projection(uuid) from public, papa_app;

-- ---------------------------------------------------------------------------
-- submit_scan_batch, fifth edition (D2b): 0016's fourth edition verbatim
-- plus the owner/manager gate on the three terminal declarations. Everything
-- else — device binding, idempotency, ordering, conflict alerts — unchanged.
-- ---------------------------------------------------------------------------
create or replace function submit_scan_batch(
  p_device_id text,
  p_ops       jsonb
)
returns setof scan_submit_result
language plpgsql
as $$
declare
  op        jsonb;
  v_org     uuid := current_org_id();
  v_user    uuid := current_user_id();
  v_event   scan_events%rowtype;
  v_id      uuid;
  v_seq     bigint;
  v_asset   assets%rowtype;
  v_alert   text;
  v_existing uuid;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- Drivers scan too: a handoff at the truck is a physical fact like any other.
  perform require_role('owner', 'manager', 'desk', 'warehouse', 'driver');

  -- 0016: the device the batch claims must be the device the session proved.
  if current_device_id() is not null and p_device_id <> current_device_id() then
    raise exception 'device % is not the device bound to this session', p_device_id
      using errcode = 'insufficient_privilege';
  end if;

  -- The device must belong to this org. Registering it here rather than in a
  -- separate call means a fresh phone can start scanning without an extra
  -- online round-trip on its first sync.
  insert into devices (id, org_id, last_user_id, last_seen_at)
  values (p_device_id, v_org, v_user, now())
  on conflict (id) do update
    set last_seen_at = now(), last_user_id = v_user
  where devices.org_id = v_org;

  if not exists (select 1 from devices d where d.id = p_device_id and d.org_id = v_org) then
    raise exception 'device % does not belong to this org', p_device_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Ordered by client_seq: the outbox flushes in order and replay must keep
  -- that order, or a check_in can land before its check_out.
  for op in
    select value from jsonb_array_elements(p_ops)
    order by (value ->> 'client_seq')::bigint
  loop
    v_seq := (op ->> 'client_seq')::bigint;
    v_alert := null;

    -- 0020 D2b: declaring gear lost/stolen/sold rewrites what the fleet IS,
    -- not where something stands. Owner/manager only, checked per op so a
    -- mixed batch fails on exactly the op that overreached.
    if (op ->> 'event_type') in ('mark_lost', 'mark_stolen', 'mark_sold') then
      perform require_role('owner', 'manager');
    end if;

    -- Idempotency. The unique constraint is the real guard; this lookup is
    -- what lets us report `duplicate` instead of raising.
    select id into v_existing from scan_events
     where device_id = p_device_id and client_seq = v_seq;

    if v_existing is not null then
      return query select v_seq, v_existing, 'duplicate'::text, null::text;
      continue;
    end if;

    v_id := coalesce((op ->> 'id')::uuid, uuid_generate_v7());

    -- ---- server-side conflict detection ----------------------------------
    -- The device already warns locally from its own SQLite before the tech
    -- walks away — that is the control that matters, because at 06:14 the
    -- desk is closed. This is the second line of defence, for the case where
    -- the device's copy was stale.
    if (op ->> 'event_type') = 'check_out' and (op ->> 'asset_id') is not null then
      select * into v_asset from assets where id = (op ->> 'asset_id')::uuid;

      if found and v_asset.presence = 'out'
         and v_asset.current_job_id is distinct from nullif(op ->> 'job_id', '')::uuid
      then
        v_alert := 'double_checkout';

        insert into alerts (org_id, kind, severity, owner_role, channel,
                            asset_id, job_id, title, detail)
        values (
          v_org, 'double_checkout', 'critical', 'manager', 'whatsapp',
          v_asset.id, nullif(op ->> 'job_id', '')::uuid,
          format('%s was checked out twice', v_asset.asset_code),
          format('Already out on another job. Physically it is on one truck — which?')
        );
      end if;
    end if;

    -- ---- the insert -------------------------------------------------------
    -- effective_time is clamped by the trigger, and the projection runs from
    -- the AFTER trigger. Nothing about ordering or state is decided here.
    insert into scan_events (
      id, org_id, asset_id, tag_code, event_type, entry_method,
      job_id, session_id, from_location_id, to_location_id, parent_asset_id,
      health, note, actor_user_id, device_id, client_seq,
      device_time, clock_offset_ms, effective_time,
      corrects_event_id, payload
    ) values (
      v_id, v_org,
      nullif(op ->> 'asset_id', '')::uuid,
      nullif(op ->> 'tag_code', ''),
      op ->> 'event_type',
      coalesce(nullif(op ->> 'entry_method', ''), 'scanned'),
      nullif(op ->> 'job_id', '')::uuid,
      nullif(op ->> 'session_id', '')::uuid,
      nullif(op ->> 'from_location_id', '')::uuid,
      nullif(op ->> 'to_location_id', '')::uuid,
      nullif(op ->> 'parent_asset_id', '')::uuid,
      nullif(op ->> 'health', ''),
      nullif(op ->> 'note', ''),
      v_user, p_device_id, v_seq,
      (op ->> 'device_time')::timestamptz,
      coalesce((op ->> 'clock_offset_ms')::bigint, 0),
      (op ->> 'device_time')::timestamptz,   -- placeholder; the trigger clamps it
      nullif(op ->> 'corrects_event_id', '')::uuid,
      coalesce(op -> 'payload', '{}'::jsonb)
    );

    return query select v_seq, v_id, 'accepted'::text, v_alert;
  end loop;

  update devices set last_synced_at = now(), queued_writes = 0
   where id = p_device_id and org_id = v_org;
end
$$;

comment on function submit_scan_batch(text, jsonb) is
  'The scan write path, fifth edition (0020): 0016''s device-bound batch plus the D2b gate — mark_lost / mark_stolen / mark_sold are owner/manager only; every other event type keeps its 0016 rules.';

-- ---------------------------------------------------------------------------
-- The crisis-day swap (D5)
--
-- SECURITY INVOKER, the 0004 posture: RLS applies exactly as it applies to a
-- direct query, so under it a cross-org row is simply invisible and every
-- existence check below IS a tenancy check. The function buys what RPCs buy —
-- one transaction, a role gate, linked events, an audit row — while the
-- security boundary stays the policies.
-- ---------------------------------------------------------------------------

-- Server-minted client_seq values, drawn globally so they are unique per
-- synthetic device by construction (D5). Never used for a real phone.
create sequence if not exists server_scan_client_seq;
grant usage on sequence server_scan_client_seq to papa_app;

create or replace function swap_asset(
  p_job_id              uuid,
  p_broken_asset_id     uuid,
  p_substitute_asset_id uuid,
  p_flag                text default 'flag_damage',
  p_note                text default null
)
returns table (checked_in_event uuid, flag_event uuid, checked_out_event uuid)
language plpgsql
as $$
declare
  v_org     uuid := current_org_id();
  v_user    uuid := current_user_id();
  v_job     jobs%rowtype;
  v_broken  assets%rowtype;
  v_sub     assets%rowtype;
  v_device  text;
  v_session uuid := uuid_generate_v7();
  e_in      uuid := uuid_generate_v7();
  e_flag    uuid := uuid_generate_v7();
  e_out     uuid := uuid_generate_v7();
  v_now     timestamptz := now();
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- The swap is a desk decision about a job, like closing one (0018).
  perform require_role('owner', 'manager', 'desk');

  if p_flag not in ('flag_damage', 'quarantine') then
    raise exception 'the broken item is flagged with flag_damage or quarantine, not %',
      coalesce(p_flag, '(null)')
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_job from jobs j
   where j.id = p_job_id and j.deleted_at is null
   for update;
  if not found then
    raise exception 'job % does not belong to this org', p_job_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_job.status <> 'open' then
    raise exception 'job % is % — a swap needs a live job', p_job_id, v_job.status
      using errcode = 'check_violation';
  end if;

  select * into v_broken from assets a
   where a.id = p_broken_asset_id and a.deleted_at is null
   for update;
  if not found then
    raise exception 'asset % does not belong to this org', p_broken_asset_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_broken.current_job_id is distinct from p_job_id then
    raise exception 'asset % is not out on job % — nothing to swap it off',
      p_broken_asset_id, p_job_id
      using errcode = 'check_violation';
  end if;

  if p_substitute_asset_id = p_broken_asset_id then
    raise exception 'an item cannot substitute for itself'
      using errcode = 'check_violation';
  end if;

  select * into v_sub from assets a
   where a.id = p_substitute_asset_id and a.deleted_at is null
   for update;
  if not found then
    raise exception 'asset % does not belong to this org', p_substitute_asset_id
      using errcode = 'foreign_key_violation';
  end if;
  -- The refusals, each nameable at the desk:
  if v_sub.disposition is not null then
    raise exception 'substitute % has left the fleet (%)',
      p_substitute_asset_id, v_sub.disposition
      using errcode = 'check_violation';
  end if;
  if v_sub.presence <> 'here' then
    raise exception 'substitute % is not on the shelf (presence %)',
      p_substitute_asset_id, v_sub.presence
      using errcode = 'check_violation';
  end if;
  if v_sub.health <> 'ok' then
    raise exception 'substitute % is not fit to rent (health %)',
      p_substitute_asset_id, v_sub.health
      using errcode = 'check_violation';
  end if;
  if not v_sub.rentable then
    raise exception 'substitute % is not rentable', p_substitute_asset_id
      using errcode = 'check_violation';
  end if;

  -- The synthetic device (D5): server-minted events never borrow a phone's
  -- identity, or a server client_seq would collide with that phone's own
  -- outbox numbering later.
  v_device := 'server:' || v_org::text;
  insert into devices (id, org_id, label, last_user_id, last_seen_at)
  values (v_device, v_org, 'server (RPC-minted events)', v_user, v_now)
  on conflict (id) do update
    set last_seen_at = excluded.last_seen_at, last_user_id = excluded.last_user_id
  where devices.org_id = v_org;

  -- 1. The broken item leaves the job. entry_method='manual': a desk
  --    decision, not a camera decode — visible and countable as such.
  insert into scan_events (
    id, org_id, asset_id, event_type, entry_method, job_id, session_id,
    note, actor_user_id, device_id, client_seq,
    device_time, clock_offset_ms, effective_time, payload
  ) values (
    e_in, v_org, p_broken_asset_id, 'check_in', 'manual', p_job_id, v_session,
    v_note, v_user, v_device, nextval('server_scan_client_seq'),
    v_now, 0, v_now,   -- placeholder; the trigger clamps it
    jsonb_build_object('swap', true,
                       'substitute_asset_id', p_substitute_asset_id,
                       'substitute_event_id', e_out)
  );

  -- 2. The flag, per the existing vocabulary. implied_by: this event exists
  --    because the check_in above happened.
  insert into scan_events (
    id, org_id, asset_id, event_type, entry_method, job_id, session_id,
    note, actor_user_id, device_id, client_seq,
    device_time, clock_offset_ms, effective_time,
    implied_by_event_id, payload
  ) values (
    e_flag, v_org, p_broken_asset_id, p_flag, 'manual', p_job_id, v_session,
    v_note, v_user, v_device, nextval('server_scan_client_seq'),
    v_now, 0, v_now,
    e_in,
    jsonb_build_object('swap', true,
                       'substitute_asset_id', p_substitute_asset_id,
                       'substitute_event_id', e_out)
  );

  -- 3. The substitute goes out on the SAME job — the rental story stays on
  --    one khata line's worth of job, which is the whole point.
  insert into scan_events (
    id, org_id, asset_id, event_type, entry_method, job_id, session_id,
    note, actor_user_id, device_id, client_seq,
    device_time, clock_offset_ms, effective_time,
    implied_by_event_id, payload
  ) values (
    e_out, v_org, p_substitute_asset_id, 'check_out', 'manual', p_job_id, v_session,
    v_note, v_user, v_device, nextval('server_scan_client_seq'),
    v_now, 0, v_now,
    e_in,
    jsonb_build_object('swap', true,
                       'replaces_asset_id', p_broken_asset_id,
                       'replaces_event_id', e_in)
  );

  -- A swap rewrites which physical unit a live job holds — audited.
  perform write_audit(
    'asset_swap', 'job', p_job_id, v_job.label,
    jsonb_build_object('broken_asset_id', p_broken_asset_id,
                       'substitute_asset_id', p_substitute_asset_id,
                       'flag', p_flag,
                       'session_id', v_session));

  return query select e_in, e_flag, e_out;
end
$$;

comment on function swap_asset(uuid, uuid, uuid, text, text) is
  'The crisis-day swap (0020 D5): one transaction, three linked scan events — broken check_in, flag_damage/quarantine, substitute check_out onto the same live job — sharing a session_id, minted on the org''s synthetic server device. Owner/manager/desk. Refuses cross-org, closed jobs, a broken item not on the job, and terminal / off-shelf / unfit / unrentable substitutes.';

-- ---------------------------------------------------------------------------
-- count_sessions — the stocktake read (D6)
--
-- One row per counting session: when, where, how many. The write side has
-- existed since 0003 (inventory_count + entry_method='counted' +
-- session_id); this is the grouping a ginti screen and Phase D4 sum.
-- security_invoker: scan_events RLS gates who sees it.
-- ---------------------------------------------------------------------------
drop view if exists count_sessions;
create view count_sessions with (security_invoker = true) as
select
  e.org_id,
  e.session_id,
  min(e.effective_time)                       as started_at,
  max(e.effective_time)                       as ended_at,
  count(*)::int                               as events,
  count(distinct e.asset_id)::int             as assets_counted,
  -- The shelf being walked: counts carry it as to_location_id. One value
  -- picked deterministically (uuid has no max() on PG16, hence the text
  -- hop); a single-shelf walk shows its shelf, a multi-shelf session shows
  -- one of them and the events themselves keep the detail.
  min(e.to_location_id::text)::uuid           as location_id,
  count(*) filter (where e.asset_id is null)::int as unresolved_tags
  from scan_events e
 where e.event_type = 'inventory_count'
   and e.session_id is not null
 group by e.org_id, e.session_id;

comment on view count_sessions is
  'Cycle counts grouped by session (0020 D6): when the ginti ran, which shelf, how many distinct items were seen. The diff (expected vs seen) is computed where it is rendered; this view is the ledger of walks.';

grant select on count_sessions to papa_app;

-- ---------------------------------------------------------------------------
-- The public resolver, fourth edition (D4): stolen is loud, every other
-- terminal state is exactly as silent as nonsense.
--
-- The return shape grows two columns, so the two-arg function is dropped and
-- recreated (a return-type change cannot OR REPLACE). Callers that read only
-- the original four columns keep working by position.
-- ---------------------------------------------------------------------------
drop function if exists resolve_tag_public(text, text);

create function resolve_tag_public(p_tag_code text, p_client_key text default 'anon')
returns table (
  found boolean, product_name text, owner_name text, owner_phone text,
  stolen boolean, stolen_notice text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tag    asset_tags%rowtype;
  v_asset  assets%rowtype;
  v_org    orgs%rowtype;
begin
  if not rate_limit_check('tag:' || p_client_key, 60, '1 minute')
     or not rate_limit_check('tag:__global__', 600, '1 minute')
  then
    raise exception 'too many requests' using errcode = 'too_many_connections';
  end if;

  select * into v_tag from asset_tags where tag_code = p_tag_code and status = 'active';
  if not found then
    return query select false, null::text, null::text, null::text, false, null::text;
    return;
  end if;

  select * into v_asset from assets
   where id = v_tag.asset_id
     and org_id = v_tag.org_id          -- M4: never resolve across orgs
     and deleted_at is null;
  if not found then
    return query select false, null::text, null::text, null::text, false, null::text;
    return;
  end if;

  select * into v_org from orgs where id = v_tag.org_id;

  -- D4, the loud branch: a STOLEN item answers with a notice and the org's
  -- contact line, public_tag_show_owner or not — going loud was the org's
  -- own decision, made when an owner/manager marked it stolen. This is the
  -- Phase E2 stolen-gear page's data source.
  if v_asset.disposition = 'stolen' then
    return query
    select
      true,
      (select p.display_name from products p where p.id = v_asset.product_id),
      v_org.name,
      v_org.settings ->> 'public_phone',
      true,
      format('This item is reported STOLEN. If you are being offered it, contact %s%s.',
             v_org.name,
             coalesce(' — ' || (v_org.settings ->> 'public_phone'), ''));
    return;
  end if;

  -- D4, the silent branch: lost, sold and retired resolve exactly like an
  -- unknown tag. Anti-enumeration holds (a probe learns nothing), a buyer
  -- of sold gear does not inherit the old owner's identity, and a lost item
  -- does not advertise that nobody knows where it is.
  if v_asset.disposition is not null then
    return query select false, null::text, null::text, null::text, false, null::text;
    return;
  end if;

  return query
  select
    true,
    (select p.display_name from products p where p.id = v_asset.product_id),
    case when coalesce((v_org.settings ->> 'public_tag_show_owner')::boolean, false)
         then v_org.name end,
    case when coalesce((v_org.settings ->> 'public_tag_show_owner')::boolean, false)
         then v_org.settings ->> 'public_phone' end,
    false,
    null::text;
end
$$;

comment on function resolve_tag_public(text, text) is
  'The anonymous tag lookup, fourth edition (0020 D4): rate-limited as before; unknown, retired-tag, lost, sold and retired-disposition all return the same not-found shape (anti-enumeration); STOLEN is deliberately loud — notice text plus the org''s contact line, the Phase E2 groundwork.';

-- ---------------------------------------------------------------------------
-- pull_changes, fifth edition (D1)
--
-- 0018's fourth edition verbatim — static SQL, the watermark early-out, THE
-- CURSOR IS THE MINIMUM SAFE ADVANCE, the C1 settle holdback, explicit
-- projections everywhere — with exactly one change: the assets block now
-- carries `disposition`, the column the Gone filter and the terminal stamp
-- read. An opaque enum of four words; no sync guard pattern is near it, and
-- the excluded jobs column stays projected out (the M6 rule; the guard greps
-- this function's source, so it is not named here).
-- ---------------------------------------------------------------------------
create or replace function pull_changes(
  p_since bigint default 0,
  p_limit int default 2000
)
returns jsonb
language plpgsql
stable
as $$
#variable_conflict use_variable
declare
  result    jsonb := '{}'::jsonb;
  rows      jsonb;
  tbl_max   bigint;
  tbl_count int;
  tbl_wait   bigint;   -- lowest returned seq that is not yet safely settled
  safe_max   bigint := null;   -- holdback from a table that filled its page
  settle_min bigint := null;   -- holdback from unsettled rows (C1)
  seen_max   bigint := p_since;
  truncated  boolean := false;
  watermark  bigint;
  v_xmin     xid8 := pg_snapshot_xmin(pg_current_snapshot());
  v_own      xid8 := pg_current_xact_id_if_assigned();
  -- clock_timestamp, not now(): now() is frozen at transaction start, and a
  -- pull inside a longer transaction would otherwise never see rows settle.
  v_fresh    timestamptz := clock_timestamp() - interval '3 seconds';
begin
  if current_org_id() is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- THE EARLY OUT. One indexed lookup answers the question a polling device
  -- actually asks, which is "is there anything for me?" — and the answer is
  -- almost always no. Safe without settle logic: it hands p_since straight
  -- back, and a cursor that never advances cannot skip a row.
  select max_change_seq into watermark
    from org_sync_watermark where org_id = current_org_id();

  if watermark is null or watermark <= p_since then
    return jsonb_build_object(
      'cursor', p_since,
      'has_more', false,
      'server_time', now(),
      'tables', jsonb_build_object(
        'products', '[]'::jsonb, 'assets', '[]'::jsonb, 'asset_tags', '[]'::jsonb,
        'locations', '[]'::jsonb, 'jobs', '[]'::jsonb, 'kit_templates', '[]'::jsonb,
        'kit_template_items', '[]'::jsonb, 'asset_containment', '[]'::jsonb));
  end if;

  -- Each block: page one table, fold it in, hold the cursor back if this
  -- table filled its page, and hold it below any row whose writing
  -- transaction was concurrent with one that is still in flight (C1).
  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, global_product_id, category, manufacturer, model,
                 display_name, tracking_mode, specs, replacement_value_minor,
                 hero_image_path, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from products where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('products', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- Explicit projection, not `select *`. Two reasons, both measured:
    -- it is ~37% faster to serialise (40ms -> 25ms for a 2000-row page), and
    -- it cuts the payload the device has to pull over 3G, where ~28% of
    -- Pakistani mobile users are still on 2G. Columns the client does not
    -- mirror cost bandwidth on every first sync and buy nothing.
    from (select id, org_id, product_id, asset_code, serial_number, is_container,
                 rentable, presence, health, ownership, disposition, current_location_id,
                 current_parent_id, current_job_id, last_scanned_at,
                 notes, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from assets where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('assets', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, tag_code, asset_id, status, updated_at,
                 change_seq, changed_xid8, changed_at
            from asset_tags where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_tags', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, parent_id, name, kind, path, code, last_counted_at,
                 created_at, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from locations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('locations', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- The jobs projection deliberately omits the phone-number column — see
    -- sync_column_exclusions. The desk reads it server-side; the warehouse
    -- floor never needs it and a stolen scanner must not carry it. (Not named
    -- here: sync_exclusion_violations() greps this function's source.)
    -- 0018 D5: customer_id (opaque uuid) and closed_at ride along so the
    -- boards can show the chip and stop accumulating finished jobs.
    from (select id, org_id, label, expected_back, status, customer_id, closed_at,
                 created_by, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from jobs where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('jobs', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, name, notes, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from kit_templates where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('kit_templates', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, kit_template_id, product_id, qty, required,
                 change_seq, changed_xid8, changed_at
            from kit_template_items where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('kit_template_items', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, parent_asset_id, child_asset_id, relation, expected,
                 added_at, removed_at, change_seq, changed_xid8, changed_at
            from asset_containment where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_containment', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  return jsonb_build_object(
    -- The cursor never passes a truncated page NOR an unsettled row (C1).
    'cursor', least(coalesce(safe_max, seen_max),
                    coalesce(settle_min, coalesce(safe_max, seen_max))),
    -- The watermark also answers has_more without a scan: anything above the
    -- cursor is, by definition, still waiting. Deliberately computed WITHOUT
    -- the settle holdback: a lag-held row was already DELIVERED in this
    -- response, so there is nothing more to fetch right now, and reporting
    -- has_more=true would make a pull-until-done client spin for the whole
    -- settle window.
    'has_more', truncated or coalesce(safe_max, seen_max) < watermark,
    'server_time', now(),
    'tables', result
  );
end
$$;

comment on function pull_changes(bigint, int) is
  'Cursor-pull sync, fifth edition (0020): the 0018 fourth edition plus assets.disposition in the assets projection (D1). The cursor is the minimum safe advance; explicit projections everywhere; the excluded jobs column stays out.';

grant execute on function pull_changes(bigint, int) to papa_app;

-- ---------------------------------------------------------------------------
-- Grants — every function is born with PUBLIC execute (the 0015 M1 lesson):
-- revoke first, then the explicit door list. resolve_tag_public was dropped
-- and recreated above, so its ACL is reset and must be restated; the OR
-- REPLACE editions keep theirs, restated here anyway for the audit trail.
-- ---------------------------------------------------------------------------
revoke all on function swap_asset(uuid, uuid, uuid, text, text)   from public;
revoke all on function resolve_tag_public(text, text)             from public;

grant execute on function
  submit_scan_batch(text, jsonb),
  swap_asset(uuid, uuid, uuid, text, text),
  resolve_tag_public(text, text)
  to papa_app;
