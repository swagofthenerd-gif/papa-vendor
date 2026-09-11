-- ============================================================================
-- 0021 — The living fleet: service by usage, battery cycles, dead stock
--
-- Ordered by the year simulation (docs/year-in-the-life.md (b)7, findings
-- `no-service-tracking` and the idle-days half of `no-utilization-read`) and
-- by vendor-dream-plan Phase D items 1–2/6: the outbox held every checkout
-- of the year — the FX9's real usage — and nothing read it for service; a
-- battery's cycles were nobody's count; and Rs 1.4M of gear could sit idle
-- for a year without one screen saying so. Hilti's ON!Track pattern
-- (docs/review-2026-09-02.md, strategy lens): service is due by USE, not by
-- the calendar — a camera that worked forty rental days needs a look before
-- one that sat on the shelf, whatever the date says.
--
-- WHAT THIS MIGRATION DECIDES, and why:
--
--   D1  THE SERVICE METER COUNTS RENTAL DAYS, AND THE REDUCER MOVES IT.
--       products gains `service_due_after_rental_days` (nullable — null
--       means this product gets no nudge, the honest default) and assets
--       gains `rental_days_since_service`, a PROJECTION like presence: the
--       reducer increments it when a check_in lands, by the days of that
--       rental, derived from the job's own out/in scan pair.
--
--       THE DAY-COUNTING RULE, exactly: a rental's days are the CALENDAR
--       DAYS its out/in pair touches — (in::date − out::date) + 1 — so a
--       partial day counts as a full day and an out-and-back on one day
--       counts 1. Out Monday 18:00, in Wednesday 09:00 is 3 days: wear is
--       being estimated, not billed, and a meter that rounds down flatters
--       the gear it is supposed to protect. The pair is the asset's latest
--       check_out ON THE SAME JOB with no check_in between it and this one
--       — so a rescan echo (the per-session dedupe honestly dies with a
--       process restart) finds no unconsumed check_out and adds NOTHING,
--       and a loose check_in with no job or no pair adds nothing either.
--       An out-of-order late check_in is not applied (the 0015 guard), so
--       it moves no meter; a projection rebuild re-derives the true count
--       from the log, exactly as it re-derives presence.
--
--   D2  `serviced` IS A SCAN EVENT, AND THE LOG IS A READ. Service happened
--       is a past fact about gear, so it rides the same append-only
--       pipeline as every other fact: a new event type, desk-gated at the
--       RPC (owner/manager/desk — recording a service is a desk decision
--       like recording money; warehouse and driver phones are refused).
--       The reducer resets `rental_days_since_service` to 0 and touches
--       NOTHING else — health has its own vocabulary (send_to_service /
--       return_from_service / quarantine / release) and this event does
--       not moonlight in it.
--
--       asset_service_log IS A VIEW over the serviced events, not a second
--       table: a table would be written beside the event (dual-write
--       drift) and re-written by every projection rebuild (duplicates).
--       Deriving it makes append-only and rebuild-safety free. The cost
--       link: a serviced event MAY carry `expense_id` in its payload,
--       naming the org_expenses repair that paid for the work; the RPC
--       validates it — same org, kind='repair', and when the expense names
--       an asset it must be THIS asset — so the log can never point at
--       another org's book or dress a sub-hire up as a service.
--
--   D3  CYCLES ARE COUNTED, AND A THRESHOLD RAISES AN ALERT — NEVER A
--       STATE CHANGE. products gains `count_cycles` (the flag for battery-
--       like categories) and `retire_after_cycles` (nullable ceiling);
--       assets gains `cycle_count`, incremented by the reducer on every
--       check_out of a flagged product. Crossing the ceiling inserts an
--       alerts row (kind 'cycle_threshold', deduped while one is open) and
--       DOES NOT touch health, presence or disposition. Auto-quarantine
--       was considered and refused: a state the system changed by itself
--       is a state nobody trusts, the exact wolf-crying the scan loop was
--       built to avoid — and "it still holds charge, run it one more
--       season" is a real answer only the owner can give. The alert
--       invites the decision; the decision moves state through the same
--       gated events as always.
--
--   D4  DEAD STOCK IS A READ, PARAMETERIZED BY THE ORG. The `dead_stock`
--       view: rentable, non-terminal, on-the-shelf assets whose last
--       check_out (or, never rented, their created_at — an asset the
--       house has owned for a year and never sent out is the deadest
--       stock there is) is older than the org's `dead_stock_days`
--       (orgs.settings, default 90). presence='here' on purpose: an item
--       OUT on a long rental is working, not idle, however old its
--       checkout scan — and a brand-new asset is excluded by its own
--       created_at until the window has actually passed. Each row carries
--       the product's replacement value so the digest line can say what
--       the idleness is worth; unpriced gear rides with a null, counted
--       but never priced at zero.
--
--   D5  THE COUNTERS SYNC DOWN, THE CONFIG SYNCS DOWN. pull_changes (sixth
--       edition) ships the three product columns and the two asset
--       counters, so a phone can draw the service line, the cycle line and
--       the Sehat groups with no network. The device projects its own
--       optimistic copy from its queue; the server's projection is the
--       authority and overwrites it on sync, the same contract presence
--       has always had.
--
-- Everything here is idempotent: IF NOT EXISTS / OR REPLACE / drop-and-
-- recreate pairs, the 0015–0020 discipline. 0001–0020 stay untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The columns (D1, D3)
-- ---------------------------------------------------------------------------
alter table products add column if not exists service_due_after_rental_days int;
alter table products add column if not exists count_cycles boolean not null default false;
alter table products add column if not exists retire_after_cycles int;

alter table products drop constraint if exists products_service_days_check;
alter table products add constraint products_service_days_check
  check (service_due_after_rental_days is null or service_due_after_rental_days > 0);
alter table products drop constraint if exists products_retire_cycles_check;
alter table products add constraint products_retire_cycles_check
  check (retire_after_cycles is null or retire_after_cycles > 0);

alter table assets add column if not exists rental_days_since_service int not null default 0;
alter table assets add column if not exists cycle_count int not null default 0;

alter table assets drop constraint if exists assets_service_meter_check;
alter table assets add constraint assets_service_meter_check
  check (rental_days_since_service >= 0);
alter table assets drop constraint if exists assets_cycle_count_check;
alter table assets add constraint assets_cycle_count_check
  check (cycle_count >= 0);

comment on column products.service_due_after_rental_days is
  'Service is due after this many RENTAL DAYS of use (0021 D1, the Hilti pattern). Null = this product gets no service nudge. The per-asset meter is assets.rental_days_since_service.';
comment on column products.count_cycles is
  'Count check_out cycles on this product''s units (0021 D3) — the battery flag. The per-asset count is assets.cycle_count.';
comment on column products.retire_after_cycles is
  'Cycle ceiling (0021 D3): crossing it raises a cycle_threshold ALERT — never a state change. Null = no ceiling.';
comment on column assets.rental_days_since_service is
  'Rental days worked since the last serviced event (0021 D1). A projection: the reducer adds each rental''s calendar days — (in::date − out::date) + 1, partial day = 1 — on check_in, and a serviced event resets it. Never client-written.';
comment on column assets.cycle_count is
  'Check_out cycles recorded on this unit (0021 D3), counted only while its product has count_cycles. A projection; a serviced event does NOT reset it — a battery''s cycles are its life, not its maintenance.';

-- ---------------------------------------------------------------------------
-- `serviced` joins the event vocabulary (D2); the alert vocabulary grows
-- its cycle kind (D3).
-- ---------------------------------------------------------------------------
alter table scan_events drop constraint if exists scan_events_type_check;
alter table scan_events add constraint scan_events_type_check check (event_type in (
  'check_out', 'check_in', 'move', 'pack', 'unpack',
  'flag_damage', 'send_to_service', 'return_from_service',
  'quarantine', 'release', 'retire', 'found', 'lost',
  'inventory_count', 'intake',
  'mark_lost', 'mark_stolen', 'mark_sold',
  'serviced'
));

alter table alerts drop constraint if exists alerts_kind_check;
alter table alerts add constraint alerts_kind_check check (kind in (
  'double_checkout', 'late_event', 'stale_device_import',
  'checkout_while_out', 'unresolved_tag', 'count_discrepancy',
  'device_not_syncing',
  -- 0021 D3: a flagged unit crossed its cycle ceiling. An invitation to
  -- inspect, never an automatic quarantine.
  'cycle_threshold'
));

-- ---------------------------------------------------------------------------
-- The reducer, fourth edition (D1, D2, D3): 0020's text verbatim plus the
-- two counters. check_in adds the rental's calendar days from its out/in
-- pair; check_out on a flagged product counts a cycle (and may raise the
-- ceiling alert); `serviced` resets the service meter and touches nothing
-- else.
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
  v_out          timestamptz;   -- the pair's check_out (D1)
  v_days         int := 0;      -- rental days this check_in adds
  v_count_cycles boolean := false;
  v_retire_after int;
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

  -- 0021 D1: the service meter. The pair is this asset's latest check_out
  -- on the SAME job with no check_in between it and this one — a rescan
  -- echo finds no unconsumed check_out and adds nothing; a loose check_in
  -- (no job, or nothing ever went out on it) adds nothing.
  if p_event.event_type = 'check_in' and p_event.job_id is not null then
    select max(e.effective_time) into v_out
      from scan_events e
     where e.org_id = p_event.org_id
       and e.asset_id = p_event.asset_id
       and e.event_type = 'check_out'
       and e.job_id = p_event.job_id
       and (e.effective_time, e.server_seq) < (p_event.effective_time, p_event.server_seq)
       and not exists (
         select 1 from scan_events i
          where i.org_id = e.org_id
            and i.asset_id = e.asset_id
            and i.event_type = 'check_in'
            and i.job_id = e.job_id
            and (i.effective_time, i.server_seq) > (e.effective_time, e.server_seq)
            and (i.effective_time, i.server_seq) < (p_event.effective_time, p_event.server_seq)
       );
    if v_out is not null then
      -- Calendar days touched, partial day = full day, same-day = 1 (D1).
      v_days := (p_event.effective_time::date - v_out::date) + 1;
    end if;
  end if;

  -- 0021 D3: cycles are per-product opt-in — the battery flag.
  if p_event.event_type = 'check_out' then
    select coalesce(p.count_cycles, false), p.retire_after_cycles
      into v_count_cycles, v_retire_after
      from products p where p.id = a.product_id;
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
    -- D1 (0020): the WHY beside the WHERE. Ordered so the disposition can
    -- never outlive being gone: the same event that sets it sets presence,
    -- and `found` clears both in one update.
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
    -- 0021 D1/D2: the service meter — a rental's days in, a serviced
    -- event back to zero. D3: the cycle count, flagged products only, and
    -- deliberately NOT reset by serviced: cycles are the unit's life.
    rental_days_since_service = case p_event.event_type
      when 'serviced' then 0
      else rental_days_since_service + v_days
    end,
    cycle_count = cycle_count + case when v_count_cycles then 1 else 0 end,
    current_location_id = coalesce(p_event.to_location_id, current_location_id),
    current_parent_id = case p_event.event_type
      when 'pack'   then p_event.parent_asset_id
      when 'unpack' then null
      else current_parent_id
    end,
    current_job_id = case p_event.event_type
      when 'check_out' then p_event.job_id
      when 'check_in'  then null
      -- D2 (0020): terminal gear projects onto no job.
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

  -- 0021 D3: crossing the ceiling raises an ALERT — never a state change.
  -- Deduped while one is open, which also keeps a projection rebuild from
  -- stacking duplicates. `a` still holds the pre-update row, so the
  -- crossing test is old-below/new-at-or-above, and a unit already over
  -- the ceiling does not re-alert on every later checkout.
  if v_count_cycles and v_retire_after is not null
     and a.cycle_count < v_retire_after
     and a.cycle_count + 1 >= v_retire_after
     and not exists (
       select 1 from alerts al
        where al.org_id = p_event.org_id
          and al.asset_id = p_event.asset_id
          and al.kind = 'cycle_threshold'
          and al.resolved_at is null
     )
  then
    insert into alerts (org_id, kind, severity, owner_role, asset_id, event_id, title, detail)
    values (
      p_event.org_id, 'cycle_threshold', 'warn', 'manager',
      p_event.asset_id, p_event.id,
      format('%s crossed its cycle ceiling', coalesce(a.asset_code, 'A flagged unit')),
      format('%s cycles recorded; the product''s ceiling is %s. Nothing was changed — inspect it and decide.',
             a.cycle_count + 1, v_retire_after)
    );
  end if;
end
$$;

-- The clean slate must zero the meters too, or a replay would double-count
-- every rental the log already counted once.
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
    rental_days_since_service = 0, cycle_count = 0,
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
-- submit_scan_batch, sixth edition (D2): 0020's fifth edition verbatim plus
-- the desk gate on `serviced` and the validation of its cost link. Everything
-- else — device binding, idempotency, ordering, conflict alerts, the
-- owner/manager gate on the terminal marks — unchanged.
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
  v_expense uuid;
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

    -- 0021 D2: recording a service is a desk decision, like recording money.
    -- And its cost link, when given, must be a real repair on THIS org's
    -- book, naming this asset when it names one — the log must never point
    -- at another org's money or dress a sub-hire up as a service.
    if (op ->> 'event_type') = 'serviced' then
      perform require_role('owner', 'manager', 'desk');

      v_expense := nullif(op -> 'payload' ->> 'expense_id', '')::uuid;
      if v_expense is not null and not exists (
        select 1 from org_expenses x
         where x.id = v_expense
           and x.org_id = v_org
           and x.kind = 'repair'
           and (x.asset_id is null
                or x.asset_id = nullif(op ->> 'asset_id', '')::uuid)
      ) then
        raise exception 'expense % is not a repair for this item on this org''s book', v_expense
          using errcode = 'foreign_key_violation';
      end if;
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
  'The scan write path, sixth edition (0021): 0020''s gated batch plus the D2 desk gate on `serviced` and validation of its expense_id cost link (same org, kind=repair, same asset when named); every other event type keeps its 0020 rules.';

-- ---------------------------------------------------------------------------
-- asset_service_log — the service history, derived (D2)
--
-- A view, not a table: the serviced events ARE the log, so deriving it
-- makes append-only and rebuild-safety free, the count_sessions treatment.
-- security_invoker: scan_events RLS gates who sees it. The expense link is
-- an opaque uuid — the amount stays behind org_expenses' desk-tier RLS.
-- ---------------------------------------------------------------------------
drop view if exists asset_service_log;
create view asset_service_log with (security_invoker = true) as
select
  e.org_id,
  e.asset_id,
  e.effective_time                    as serviced_at,
  e.note,
  (e.payload ->> 'expense_id')::uuid  as expense_id,
  e.actor_user_id,
  e.id                                as event_id
  from scan_events e
 where e.event_type = 'serviced'
   and e.asset_id is not null;

comment on view asset_service_log is
  'Every serviced event, as the log it is (0021 D2): asset, when, note, and the org_expenses repair that paid for it when one was named (validated at the RPC). A read over scan_events — append-only and rebuild-proof by construction.';

grant select on asset_service_log to papa_app;

-- ---------------------------------------------------------------------------
-- service_due — assets over their product's usage threshold (D1)
-- ---------------------------------------------------------------------------
drop view if exists service_due;
create view service_due with (security_invoker = true) as
select
  a.org_id,
  a.id                              as asset_id,
  a.asset_code,
  p.display_name,
  a.rental_days_since_service,
  p.service_due_after_rental_days   as due_after,
  (a.rental_days_since_service - p.service_due_after_rental_days) as over_by
  from assets a
  join products p on p.id = a.product_id
 where a.deleted_at is null
   and a.disposition is null
   and p.service_due_after_rental_days is not null
   and a.rental_days_since_service >= p.service_due_after_rental_days;

comment on view service_due is
  'The service nudge (0021 D1, Hilti''s pattern): live-fleet units whose rental-day meter reached their product''s threshold. A product with a null threshold never appears — no nudge is the honest default. Org-scoped through assets RLS; the warehouse can see it, because the tech is who services gear.';

grant select on service_due to papa_app;

-- ---------------------------------------------------------------------------
-- dead_stock — idle capital, parameterized per org (D4)
-- ---------------------------------------------------------------------------
drop view if exists dead_stock;
create view dead_stock with (security_invoker = true) as
select
  a.org_id,
  a.id                       as asset_id,
  a.asset_code,
  p.display_name,
  p.replacement_value_minor,
  last_out.at                as last_rented_at,
  (extract(epoch from (now() - coalesce(last_out.at, a.created_at))) / 86400)::int
                             as idle_days
  from assets a
  join products p on p.id = a.product_id
  join orgs o on o.id = a.org_id
  left join lateral (
    select max(e.effective_time) as at
      from scan_events e
     where e.org_id = a.org_id
       and e.asset_id = a.id
       and e.event_type = 'check_out'
  ) last_out on true
 where a.deleted_at is null
   and a.disposition is null
   and a.rentable
   -- On the shelf: gear OUT on a long rental is working, not idle, however
   -- old its checkout scan. Quarantined-but-here still counts — idle capital
   -- is idle whatever its health says.
   and a.presence = 'here'
   and coalesce(last_out.at, a.created_at)
       < now() - make_interval(days =>
           coalesce((o.settings ->> 'dead_stock_days')::int, 90));

comment on view dead_stock is
  'Idle capital (0021 D4): rentable, non-terminal, on-the-shelf units whose last check_out — or, never rented, their created_at — is older than the org''s dead_stock_days (orgs.settings, default 90). Carries the product''s replacement value so the digest line can say what the idleness is worth; unpriced gear rides with a null, never a made-up zero.';

grant select on dead_stock to papa_app;

-- ---------------------------------------------------------------------------
-- pull_changes, sixth edition (D5)
--
-- 0020's fifth edition verbatim — static SQL, the watermark early-out, THE
-- CURSOR IS THE MINIMUM SAFE ADVANCE, the C1 settle holdback, explicit
-- projections everywhere — with exactly one change per side of the config:
-- the products block carries service_due_after_rental_days / count_cycles /
-- retire_after_cycles, and the assets block carries the two counters, so a
-- phone can draw the service line, the cycle line and the Sehat groups with
-- no network. The excluded jobs column stays projected out (the M6 rule; the
-- guard greps this function's source, so it is not named here).
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
                 service_due_after_rental_days, count_cycles, retire_after_cycles,
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
                 rentable, presence, health, ownership, disposition,
                 rental_days_since_service, cycle_count, current_location_id,
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
  'Cursor-pull sync, sixth edition (0021): the 0020 fifth edition plus the service/cycle config on products and the two counters on assets (D5). The cursor is the minimum safe advance; explicit projections everywhere; the excluded jobs column stays out.';

grant execute on function pull_changes(bigint, int) to papa_app;

-- ---------------------------------------------------------------------------
-- Grants — every function is born with PUBLIC execute (the 0015 M1 lesson):
-- the OR REPLACE editions keep their ACLs, restated here for the audit trail.
-- ---------------------------------------------------------------------------
grant execute on function submit_scan_batch(text, jsonb) to papa_app;
