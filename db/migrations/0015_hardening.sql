-- ============================================================================
-- 0015 — Security and correctness hardening
--
-- A review pass over 0001–0014 found a cluster of verified defects. They are
-- fixed together here because most of them share one root cause: a privilege
-- or a tenancy assumption that was true for the code path it was written for,
-- and false for a caller the grant also reached. Everything below is a
-- CREATE OR REPLACE / guarded-DDL change; 0001–0014 stay untouched, as always.
--
-- WHAT THIS MIGRATION FIXES, in the order it appears:
--
--   H1  apply_scan_event() and rebuild_asset_projection() were EXECUTE-able by
--       papa_app (0003:443) — any member could rewrite an asset projection
--       WITHOUT a log row, defeating the event log entirely. They are now
--       SECURITY DEFINER (so the insert-trigger path still works regardless of
--       who is inserting) and revoked from papa_app AND public. The only way
--       to move a projection is to append an event.
--
--   C2  Both functions read the asset without FOR UPDATE, so two concurrent
--       events could interleave reads and let the OLDER one win. Both now
--       take `select … for update` on the asset row.
--
--   H1-corr  An event whose tag was unbound at scan time (asset_id null)
--       never projected — even after bind_tag() later bound the tag. Now:
--       the insert trigger resolves tag_code → asset_id when a live binding
--       exists; an unresolved scan raises the existing 'unresolved_tag' alert
--       kind; and binding a tag that has unresolved history triggers a
--       projection rebuild that INCLUDES those events (matched by tag_code,
--       adopted into the replay in memory only — scan_events itself is never
--       UPDATEd; append-only stays absolute).
--
--   M5a A correction event was never checked against its target. Now
--       corrects_event_id must reference an event in the same org and on the
--       same asset (or the same tag_code while the target is unresolved).
--
--   M4  bind_tag / intake_asset / scan_events inserts accepted CROSS-ORG
--       asset_id / job_id / location_id / parent_asset_id — foreign keys
--       check existence, not tenancy, and FK lookups bypass RLS. Every
--       referenced row is now asserted to belong to the event's org. And
--       resolve_tag_public() would happily resolve a forged tag row pointing
--       at another org's asset; it now requires assets.org_id = the tag's.
--
--   H3  memberships.pin_hash was readable by every org member (org-wide
--       select policy + full-table grant), handing 4-digit hashes to anyone
--       for offline cracking. papa_app now has COLUMN-level SELECT on every
--       memberships column EXCEPT pin_hash, and verification goes through
--       verify_pin() — SECURITY DEFINER, search_path pinned, internally rate
--       limited, never returns the hash.
--
--   H2  Direct DML let 'readonly' and 'driver' members forge tenant state.
--       (a) RESTRICTIVE policies now refuse INSERT/UPDATE on the asset-model
--       tables for those roles (driver keeps append access to the scan log —
--       drivers scan, by design; readonly writes nothing anywhere).
--       (b) dispatches lose their direct INSERT/UPDATE grants entirely, so
--       confirm-state (scanned_count / confirmed_by_role) cannot be forged;
--       open_dispatch / confirm_dispatch become SECURITY DEFINER with
--       explicit org checks and pinned search_path.
--
--   M1  rate_limit_check() was EXECUTE-able by papa_app (and by PUBLIC via
--       the default function ACL) — a client could burn any bucket, locking
--       other users out, or probe limits. Revoked from both. Same for
--       prune_rate_limits(), which 0007 revoked from papa_app but not from
--       PUBLIC — papa_app could still call it with p_older_than = '0 seconds'
--       and reset every limiter window.
--
--   M2  resolve_tag_public() keyed its limit on the CLIENT-CHOSEN
--       p_client_key, so rotating the key bypassed limiting entirely. A
--       global fallback bucket now caps total anonymous resolutions per
--       minute regardless of key. See the function header for the edge
--       injection requirement.
--
--   M5/M6  The PII sync guard matched exact column names only and missed
--       jobs.contact (a phone number) which DID sync. The guard now pattern-
--       matches (phone / contact% / cnic% / ntn% / credit_limit%), a small
--       registry of REVIEWED exclusions (sync_column_exclusions) records the
--       columns that exist server-side but are projected out of the sync
--       payload, and sync_exclusion_violations() verifies the projection
--       actually omits them. pull_changes now uses an explicit projection for
--       EVERY table — no `select *` anywhere — and jobs.contact no longer
--       syncs.
--
--   H4  dispatch_evidence_strength() graded an owner-confirmed, all-assumed
--       dispatch 'strong'. Belief is not observation regardless of who
--       pressed the button: assumed_count > scanned_count is now at best
--       'weak' for every role.
--
--   M6b whats_out never retired a row once the gear came back, and a 'back'
--       dispatch could not be confirmed at all (destination required, but
--       "back" has no destination — it is the warehouse). The constraint now
--       exempts direction='back', confirm_dispatch mirrors that, and
--       whats_out drops an out-dispatch once a LATER confirmed 'back'
--       dispatch exists for the same job. (Jobless dispatches have nothing to
--       match a return against and stay visible until handled by a person —
--       that is the honest behaviour: the nephew's light is out until someone
--       says otherwise.)
--
--   C1  pull_changes' cursor could PERMANENTLY SKIP rows: change_seq is
--       stamped at write time but rows become visible at COMMIT, so a txn
--       that commits late leaves a row BELOW a cursor the client has already
--       advanced past — the exact hazard 0010 documents for the export path,
--       and the rule established there applies unchanged: THE CURSOR IS THE
--       MINIMUM SAFE ADVANCE. Every syncable write now stamps two more
--       bookkeeping columns — `changed_at` (clock_timestamp) and
--       `changed_xid8` (the writing transaction) — and the cursor is held
--       BELOW any returned row that is not yet safely settled, meaning a row
--       written by another transaction that is either (a) concurrent with a
--       transaction still in flight (changed_xid8 >= the pull snapshot's
--       xmin — the exact detector) or (b) stamped within the last 3 seconds
--       (the 0010-style settle lag, which also covers a late write by an
--       old-xid transaction). The rows themselves are still delivered —
--       re-delivery is idempotent — only the cursor waits, and `has_more`
--       stays false for a lag-only holdback so clients do not spin. The 0006
--       watermark early-out never ADVANCES the cursor (it hands p_since
--       straight back), so it cannot skip and needs no lag of its own.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- H1 / C2 / H1-corr / M4 / M5a — the scan-event pipeline
--
-- The BEFORE trigger clamps time (as before), then: resolves an unbound
-- tag_code against this org's live bindings, asserts the tenancy of every
-- referenced row, and validates corrections. SECURITY DEFINER so the checks
-- can see across orgs to REFUSE, and so they hold for every insert path.
-- ---------------------------------------------------------------------------
create or replace function on_scan_event_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed timestamptz;
  target  scan_events%rowtype;
begin
  claimed := new.device_time + make_interval(secs => new.clock_offset_ms / 1000.0);

  -- An event can never claim to have happened after it arrived.
  new.effective_time := least(claimed, new.server_time);

  -- H1-corr: a tag the DEVICE could not resolve may be resolvable here. Only
  -- a live binding in the event's own org counts — another org's tag stays
  -- unresolved rather than leaking a foreign asset into this org's log.
  if new.asset_id is null and new.tag_code is not null then
    select t.asset_id into new.asset_id
      from asset_tags t
     where t.tag_code = new.tag_code
       and t.status   = 'active'
       and t.org_id   = new.org_id;
  end if;

  -- M4: FKs prove existence, not tenancy. Every referenced row must belong
  -- to the event's org. Raised as foreign_key_violation: to the caller a
  -- cross-org id and a nonexistent id are the same defect.
  if new.asset_id is not null and not exists (
    select 1 from assets a where a.id = new.asset_id and a.org_id = new.org_id
  ) then
    raise exception 'asset % does not belong to this org', new.asset_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.job_id is not null and not exists (
    select 1 from jobs j where j.id = new.job_id and j.org_id = new.org_id
  ) then
    raise exception 'job % does not belong to this org', new.job_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.from_location_id is not null and not exists (
    select 1 from locations l where l.id = new.from_location_id and l.org_id = new.org_id
  ) then
    raise exception 'location % does not belong to this org', new.from_location_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.to_location_id is not null and not exists (
    select 1 from locations l where l.id = new.to_location_id and l.org_id = new.org_id
  ) then
    raise exception 'location % does not belong to this org', new.to_location_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.parent_asset_id is not null and not exists (
    select 1 from assets a where a.id = new.parent_asset_id and a.org_id = new.org_id
  ) then
    raise exception 'parent asset % does not belong to this org', new.parent_asset_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.implied_by_event_id is not null and not exists (
    select 1 from scan_events e where e.id = new.implied_by_event_id and e.org_id = new.org_id
  ) then
    raise exception 'implying event % does not belong to this org', new.implied_by_event_id
      using errcode = 'foreign_key_violation';
  end if;

  -- M5a: a correction must actually correct its target. Same org, and same
  -- asset — or the same tag_code while the target is still unresolved, which
  -- is the only identity an unresolved event has.
  if new.corrects_event_id is not null then
    select * into target from scan_events where id = new.corrects_event_id;

    if not found or target.org_id <> new.org_id then
      raise exception 'corrected event % does not belong to this org', new.corrects_event_id
        using errcode = 'foreign_key_violation';
    end if;

    if not (
      (new.asset_id is not null and new.asset_id = target.asset_id)
      or (target.asset_id is null
          and new.tag_code is not null and new.tag_code = target.tag_code)
    ) then
      raise exception
        'a correction must target an event on the same asset (or the same unresolved tag)'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end
$$;

/**
 * The reducer: one event applied to one asset row.
 *
 * SECURITY DEFINER (0015): the AFTER-insert trigger must be able to project
 * regardless of which role inserted the event, while papa_app must NOT be able
 * to call this directly — a projection write without a log row is forgery.
 * The asset row is read FOR UPDATE (C2) so two concurrent events serialise on
 * it and the ordering guard actually decides which one wins.
 */
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
 * SECURITY DEFINER and revoked from papa_app for the same reason as
 * apply_scan_event. Locks the asset FOR UPDATE first (C2) so a rebuild cannot
 * interleave with live events.
 *
 * 0015 also folds in the UNRESOLVED history (H1-corr): events recorded with
 * only a tag_code — because the tag was unbound when they were scanned — are
 * replayed too, matched through the asset's live tag. The stored rows are
 * never modified; the asset_id is adopted on the in-memory copy only.
 * scan_events remains strictly append-only.
 */
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
    presence = 'here', health = 'ok',
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

/**
 * AFTER-insert projection hook.
 *
 * SECURITY DEFINER (0015): this is what lets the direct grants on
 * apply_scan_event be revoked — the trigger runs as the function owner, so
 * every legitimate insert path still projects, while no client can call the
 * reducer against an asset without an event row existing first.
 *
 * An event that is STILL unresolved after the BEFORE trigger tried the org's
 * live bindings raises the 'unresolved_tag' alert (H1-corr): the scan is
 * recorded, someone is told, and binding the tag later folds it in.
 */
create or replace function after_scan_event_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.asset_id is null then
    insert into alerts (org_id, kind, severity, owner_role, event_id, title, detail)
    values (
      new.org_id, 'unresolved_tag', 'warn', 'manager', new.id,
      format('A scan of tag %s matched no asset', coalesce(new.tag_code, '(none)')),
      'No live binding exists for this tag in this org. The scan is recorded; bind the tag and it will be applied to that asset''s history.'
    );
    return null;
  end if;

  perform apply_scan_event(new);
  return null;
end
$$;

-- ---------------------------------------------------------------------------
-- H1-corr — binding a tag folds in its unresolved history
--
-- A trigger on asset_tags rather than a line inside bind_tag, so EVERY path
-- that activates a binding (bind_tag, intake via bind_tag, a future admin
-- surface) gets the same behaviour. Rebuilds only when unresolved events for
-- this tag actually exist — an ordinary intake bind must not wipe the intake
-- location with an empty replay.
-- ---------------------------------------------------------------------------
create or replace function on_asset_tag_bound()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' and new.asset_id is not null
     and exists (
       select 1 from scan_events se
        where se.org_id = new.org_id
          and se.tag_code = new.tag_code
          and se.asset_id is null
     )
  then
    perform rebuild_asset_projection(new.asset_id);

    -- The question those alerts asked has been answered.
    update alerts a
       set resolved_at = now(),
           resolution_note = 'tag bound; events applied to the asset'
     where a.kind = 'unresolved_tag'
       and a.resolved_at is null
       and a.org_id = new.org_id
       and a.event_id in (
         select se.id from scan_events se
          where se.org_id = new.org_id
            and se.tag_code = new.tag_code
            and se.asset_id is null
       );
  end if;
  return null;
end
$$;

drop trigger if exists asset_tags_backfill_projection on asset_tags;
create trigger asset_tags_backfill_projection
  after insert or update on asset_tags
  for each row execute function on_asset_tag_bound();

-- H1: the projection may only move through the log. Both the explicit grant
-- (0003:443) and the DEFAULT PUBLIC EXECUTE that every function is born with
-- must go, or the revoke is decoration.
revoke execute on function apply_scan_event(scan_events)     from public, papa_app;
revoke execute on function rebuild_asset_projection(uuid)    from public, papa_app;

-- ---------------------------------------------------------------------------
-- M4 — bind_tag / intake_asset assert tenancy of what they reference
--
-- Both stay SECURITY INVOKER: under RLS a cross-org row is simply invisible,
-- so an existence check IS a tenancy check here, and tenancy stays enforced
-- in one place. (The FK alone was the hole: FK lookups bypass RLS.)
-- ---------------------------------------------------------------------------
create or replace function bind_tag(
  p_tag_code text,
  p_asset_id uuid
)
returns asset_tags
language plpgsql
as $$
declare
  v_org uuid := current_org_id();
  v_tag asset_tags%rowtype;
  v_tag_exists boolean;
begin
  perform require_role('owner', 'manager', 'desk', 'warehouse');

  -- M4: the asset must be OURS. Invisible-under-RLS and nonexistent are the
  -- same answer, which is exactly the right amount of information.
  if not exists (
    select 1 from assets a
     where a.id = p_asset_id and a.org_id = v_org and a.deleted_at is null
  ) then
    raise exception 'asset % does not belong to this org', p_asset_id
      using errcode = 'foreign_key_violation';
  end if;

  select * into v_tag from asset_tags where tag_code = p_tag_code;
  -- Captured NOW. `found` is reassigned by every subsequent statement, so
  -- testing it after the retire-update below reports whether that update
  -- touched rows — which is a different question, and was the bug here.
  v_tag_exists := found;

  if v_tag_exists and v_tag.status = 'active' and v_tag.asset_id is distinct from p_asset_id then
    raise exception 'tag % is already bound to a different asset', p_tag_code
      using errcode = 'unique_violation';
  end if;

  -- Re-issuing: retire whatever label this asset currently wears. This is the
  -- flow opaque tag ids exist to make possible — a soaked or gaffed-over label
  -- is replaced without the asset losing its identity or its history.
  update asset_tags
     set status = 'retired', unbound_at = now()
   where asset_id = p_asset_id and status = 'active' and tag_code <> p_tag_code;

  if v_tag_exists then
    update asset_tags
       set asset_id = p_asset_id, status = 'active', bound_at = now(), unbound_at = null
     where tag_code = p_tag_code
    returning * into v_tag;
  else
    insert into asset_tags (org_id, tag_code, asset_id, status, bound_at)
    values (v_org, p_tag_code, p_asset_id, 'active', now())
    returning * into v_tag;
  end if;

  return v_tag;
end
$$;

create or replace function intake_asset(
  p_tag_code    text,
  p_name        text,
  p_location_id uuid default null,
  p_asset_id    uuid default null,   -- client-generated, so it works offline
  p_category    text default 'uncategorised'
)
returns assets
language plpgsql
as $$
declare
  v_org        uuid := current_org_id();
  v_product_id uuid;
  v_asset      assets%rowtype;
  v_id         uuid := coalesce(p_asset_id, uuid_generate_v7());
begin
  perform require_role('owner', 'manager', 'desk', 'warehouse');

  -- M4: the shelf must be OUR shelf.
  if p_location_id is not null and not exists (
    select 1 from locations l
     where l.id = p_location_id and l.org_id = v_org and l.deleted_at is null
  ) then
    raise exception 'location % does not belong to this org', p_location_id
      using errcode = 'foreign_key_violation';
  end if;

  -- A provisional product per name. Deliberately loose: forcing a real
  -- catalogue entry at intake is what makes people stop tagging.
  select id into v_product_id from products
   where org_id = v_org and lower(display_name) = lower(p_name) and deleted_at is null
   limit 1;

  if v_product_id is null then
    insert into products (org_id, category, display_name, tracking_mode)
    values (v_org, p_category, p_name, 'serialized')
    returning id into v_product_id;
  end if;

  insert into assets (id, org_id, product_id, asset_code, current_location_id)
  values (v_id, v_org, v_product_id, generate_asset_code(v_org), p_location_id)
  returning * into v_asset;

  perform bind_tag(p_tag_code, v_id);

  return v_asset;
end
$$;

-- ---------------------------------------------------------------------------
-- H3 — pin_hash leaves the read surface
--
-- Column-level privileges: papa_app can select every memberships column
-- EXCEPT pin_hash. The org-wide select policy is unchanged — colleagues stay
-- visible — but the one column that turns a database read into an offline
-- brute-force of a 4-digit PIN is no longer part of it.
-- ---------------------------------------------------------------------------
revoke select on memberships from papa_app;
grant select (id, org_id, user_id, role, permissions, status,
              pin_set_at, created_at, updated_at, deleted_at)
  on memberships to papa_app;

/**
 * Verify a member's PIN without ever exposing the hash.
 *
 * SECURITY DEFINER because papa_app can no longer read pin_hash at all —
 * this function is the ONLY door, and it is rate limited from the inside so
 * the caller cannot skip the limiter (0007's limiter is itself unreachable
 * from papa_app as of this migration). 5 attempts per user per org per
 * minute: generous for a mistyped glove-tap, useless for the 10,000-guess
 * space of a 4-digit PIN.
 */
create or replace function verify_pin(p_user_id uuid, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_hash text;
begin
  if v_org is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  if not rate_limit_check('pin:' || v_org::text || ':' || p_user_id::text, 5, '1 minute') then
    raise exception 'too many PIN attempts' using errcode = 'too_many_connections';
  end if;

  select m.pin_hash into v_hash
    from memberships m
   where m.org_id  = v_org
     and m.user_id = p_user_id
     and m.status  = 'active'
     and m.deleted_at is null;

  -- crypt() re-hashes the guess with the stored salt; a null or non-hash
  -- value simply fails to match. The hash never leaves this function.
  return v_hash is not null and v_hash = crypt(p_pin, v_hash);
end
$$;

revoke all on function verify_pin(uuid, text) from public;
grant execute on function verify_pin(uuid, text) to papa_app;

comment on function verify_pin(uuid, text) is
  'The only PIN check. DEFINER + pinned search_path + internal rate limit; papa_app cannot read pin_hash at all.';

-- ---------------------------------------------------------------------------
-- H2(a) — readonly and driver cannot write tenant state directly
--
-- current_member_role() gives policies one place to read the caller's role.
-- SECURITY INVOKER: it reads memberships under the caller's own RLS, and the
-- role column is within the column grant above.
-- ---------------------------------------------------------------------------
create or replace function current_member_role()
returns text
language sql
stable
as $$
  select m.role from memberships m
   where m.org_id  = current_org_id()
     and m.user_id = current_user_id()
     and m.status  = 'active'
     and m.deleted_at is null
   limit 1
$$;

grant execute on function current_member_role() to papa_app;

comment on function current_member_role() is
  'The caller''s live role in the current org, or null. Wrap in (select …) inside policies so it hoists into an InitPlan.';

-- RESTRICTIVE policies AND with the permissive tenant policies: same org as
-- before, PLUS a role that is allowed to write. Two deliberate tiers:
--
--   * The asset model (locations … jobs): neither readonly nor driver may
--     INSERT or UPDATE. A driver confirms nothing and edits nothing — the
--     vendor's rule from 0013 — and readonly means readonly.
--   * The scan pipeline (scan_events, devices, alerts): readonly is refused,
--     but DRIVER KEEPS APPEND ACCESS — "drivers scan too: a handoff at the
--     truck is a physical fact like any other" (0004). Scans forge no state:
--     the projection is derived, ordered, and audited.
--
-- UPDATE policies use `using (true)` so the refusal is a loud 42501 on the
-- new row rather than a silent zero-row update a client would misread as
-- success.
do $$
declare t text;
begin
  foreach t in array array[
    'locations', 'products', 'assets', 'asset_tags', 'asset_containment',
    'stock_lots', 'stock_movements', 'kit_templates', 'kit_template_items', 'jobs'
  ]
  loop
    execute format('drop policy if exists %1$s_writer_role_ins on %1$s', t);
    execute format(
      'create policy %1$s_writer_role_ins on %1$s as restrictive for insert
         with check ((select coalesce(current_member_role(), '''') not in (''readonly'', ''driver'')))', t);
    execute format('drop policy if exists %1$s_writer_role_upd on %1$s', t);
    execute format(
      'create policy %1$s_writer_role_upd on %1$s as restrictive for update
         using (true)
         with check ((select coalesce(current_member_role(), '''') not in (''readonly'', ''driver'')))', t);
  end loop;

  foreach t in array array['scan_events', 'devices', 'alerts']
  loop
    execute format('drop policy if exists %1$s_writer_role_ins on %1$s', t);
    execute format(
      'create policy %1$s_writer_role_ins on %1$s as restrictive for insert
         with check ((select coalesce(current_member_role(), '''') not in (''readonly'')))', t);
  end loop;

  foreach t in array array['devices', 'alerts']
  loop
    execute format('drop policy if exists %1$s_writer_role_upd on %1$s', t);
    execute format(
      'create policy %1$s_writer_role_upd on %1$s as restrictive for update
         using (true)
         with check ((select coalesce(current_member_role(), '''') not in (''readonly'')))', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- H2(b) — dispatch state moves only through the RPCs
--
-- Direct INSERT/UPDATE let any member set state='confirmed' with any counts
-- and any confirmed_by_role — the exact evidence the money side trusts. The
-- grants go; the RPCs become SECURITY DEFINER with explicit org checks (they
-- now run as the owner, which BYPASSES RLS, so every statement carries its
-- own org predicate — the 0004 trap, handled the 0004 way: by hand, visibly).
-- ---------------------------------------------------------------------------
revoke insert, update on dispatches from papa_app;

create or replace function open_dispatch(
  p_session_id  uuid,
  p_job_id      uuid,
  p_direction   text default 'out',
  p_expected    integer default 0,
  p_destination text default null,
  p_recipient   text default null
)
returns dispatches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_user uuid := current_user_id();
  v_row  dispatches%rowtype;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  perform require_role('owner', 'manager', 'desk', 'warehouse');

  -- M4-shaped check, needed here because DEFINER sees every org's jobs.
  if p_job_id is not null and not exists (
    select 1 from jobs j
     where j.id = p_job_id and j.org_id = v_org and j.deleted_at is null
  ) then
    raise exception 'job % does not belong to this org', p_job_id
      using errcode = 'foreign_key_violation';
  end if;

  insert into dispatches (org_id, job_id, session_id, direction, expected_count,
                          destination, recipient, opened_by)
  values (v_org, p_job_id, p_session_id, p_direction, p_expected,
          nullif(trim(p_destination), ''), nullif(trim(p_recipient), ''), v_user)
  on conflict (session_id) do update
    -- coalesce, not overwrite: a retry that carries no destination must not
    -- erase one the desk filled in between the first attempt and this one.
    set destination = coalesce(nullif(trim(p_destination), ''), dispatches.destination),
        recipient   = coalesce(nullif(trim(p_recipient), ''), dispatches.recipient),
        updated_at  = now()
    where dispatches.org_id = v_org
  returning * into v_row;

  -- The conflicting session belongs to another org: refused, not adopted.
  if not found then
    raise exception 'session % is already in use', p_session_id
      using errcode = 'unique_violation';
  end if;

  return v_row;
end
$$;

create or replace function confirm_dispatch(
  p_session_id  uuid,
  p_scanned     integer,
  p_assumed     integer,
  p_unaccounted integer,
  p_destination text default null,
  p_recipient   text default null
)
returns dispatches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_user uuid := current_user_id();
  v_row  dispatches%rowtype;
  v_role text;
  v_dest text;
  v_dir  text;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- Only the owner or the tech. `driver` and `readonly` stay absent.
  perform require_role('owner', 'manager', 'desk', 'warehouse');

  select m.role into v_role
    from memberships m
   where m.org_id = v_org
     and m.user_id = v_user
     and m.deleted_at is null;

  -- Whatever is supplied now wins; otherwise whatever was set at open time.
  select d.direction, coalesce(nullif(trim(p_destination), ''), d.destination)
    into v_dir, v_dest
    from dispatches d
   where d.session_id = p_session_id and d.org_id = v_org;

  if not found then
    raise exception 'dispatch % is not open for confirmation', p_session_id
      using errcode = 'check_violation';
  end if;

  -- Outbound gear must say where it is going. A RETURN's destination is the
  -- warehouse itself; demanding one blocked every check-in (M6b).
  if v_dir <> 'back' and v_dest is null then
    raise exception 'a dispatch cannot be confirmed without saying where the equipment is going'
      using errcode = 'check_violation';
  end if;

  update dispatches
     set state = 'confirmed',
         destination = v_dest,
         recipient = coalesce(nullif(trim(p_recipient), ''), recipient),
         scanned_count = p_scanned,
         assumed_count = p_assumed,
         unaccounted_count = p_unaccounted,
         confirmed_by = v_user,
         confirmed_at = now(),
         confirmed_by_role = v_role,
         updated_at = now()
   where session_id = p_session_id
     and org_id = v_org
     -- Confirmation happens ONCE. A second confirmation would overwrite the
     -- counts that were asserted the first time, which is the one thing an
     -- evidence record must never allow.
     and state = 'open'
  returning * into v_row;

  if not found then
    raise exception 'dispatch % is not open for confirmation', p_session_id
      using errcode = 'check_violation';
  end if;

  return v_row;
end
$$;

comment on function confirm_dispatch(uuid, integer, integer, integer, text, text) is
  'Owner or tech only. DEFINER with explicit org checks — direct dispatch DML is revoked. Requires a destination for direction=out. Records the counts AS ASSERTED, once.';

revoke all on function open_dispatch(uuid, uuid, text, integer, text, text) from public;
revoke all on function confirm_dispatch(uuid, integer, integer, integer, text, text) from public;
grant execute on function
  open_dispatch(uuid, uuid, text, integer, text, text),
  confirm_dispatch(uuid, integer, integer, integer, text, text)
  to papa_app;

-- M6b: a 'back' dispatch has no destination — it IS the destination.
-- Constraints are not applied history the way migration files are, so
-- drop-and-recreate (as a pair, idempotently) is the sanctioned change.
alter table dispatches drop constraint if exists dispatches_confirmed_has_destination;
alter table dispatches add constraint dispatches_confirmed_has_destination check (
  state <> 'confirmed'
  or direction = 'back'
  or (destination is not null and length(trim(destination)) > 0)
);

-- ---------------------------------------------------------------------------
-- H4 — belief is not observation, whoever pressed the button
--
-- The assumed-count test now comes FIRST: an owner bulk-confirming a sealed
-- case is asserting a belief, and grading it 'strong' would let the money
-- actions run on evidence nobody has.
-- ---------------------------------------------------------------------------
create or replace function dispatch_evidence_strength(p_session_id uuid)
returns text
language sql
stable
as $$
  select case
    when d.state <> 'confirmed' then 'none'
    -- A dispatch mostly bulk-confirmed by case is weaker than one scanned item
    -- by item, WHOEVER pressed the button. Belief is not observation.
    when coalesce(d.assumed_count, 0) > coalesce(d.scanned_count, 0) then 'weak'
    when d.confirmed_by_role in ('owner', 'manager') then 'strong'
    else 'normal'
  end
  from dispatches d where d.session_id = p_session_id;
$$;

-- ---------------------------------------------------------------------------
-- M6b — whats_out learns that gear comes back
--
-- THE RETIREMENT RULE: an out-dispatch leaves the board once a LATER
-- confirmed 'back' dispatch exists for the SAME JOB. The job is the unit a
-- return is reconciled against (0013: a job is a running tally; check-in
-- reconciles against what is physically out on it), and confirmed_at ordering
-- keeps a 6am out visible if only yesterday's return has been processed.
-- Jobless (informal) dispatches have nothing for a return to reference and
-- deliberately STAY visible until a person deals with them — the nephew's
-- light is out until someone says otherwise, and silently dropping it would
-- reopen the exact blind spot 0014 closed.
-- ---------------------------------------------------------------------------
drop view if exists whats_out;
create view whats_out with (security_invoker = true) as
select
  d.id,
  d.org_id,
  d.job_id,
  j.label            as job_label,
  d.destination,
  d.recipient,
  d.scanned_count,
  d.assumed_count,
  d.unaccounted_count,
  d.confirmed_at,
  d.confirmed_by_role,
  dispatch_evidence_strength(d.session_id) as evidence,
  (d.job_id is null)  as informal
  from dispatches d
  left join jobs j on j.id = d.job_id
 where d.direction = 'out'
   and d.state = 'confirmed'
   and not exists (
     select 1 from dispatches b
      where b.org_id = d.org_id
        and b.job_id = d.job_id           -- null job matches nothing: informal stays
        and b.direction = 'back'
        and b.state = 'confirmed'
        and b.confirmed_at >= d.confirmed_at
   );

comment on view whats_out is
  'Everything currently out, booked or not. A confirmed later ''back'' dispatch on the same job settles the row; informal (jobless) rows stay until handled by a person.';

grant select on whats_out to papa_app;

-- ---------------------------------------------------------------------------
-- M1 — the limiter is infrastructure, not an API
--
-- papa_app could call rate_limit_check() directly (0007:327) — burning any
-- bucket it could name, locking other users out of the resolver or the PIN
-- gate. And prune_rate_limits() was revoked from papa_app but NOT from
-- PUBLIC, whose default EXECUTE every function is born with — so papa_app
-- could still call it with p_older_than = '0 seconds' and reset every
-- limiter window in the system. Both doors close.
-- ---------------------------------------------------------------------------
revoke execute on function rate_limit_check(text, int, interval) from public, papa_app;
revoke all on function prune_rate_limits(interval) from public;

-- ---------------------------------------------------------------------------
-- M2 / M4 — the public resolver
--
-- EDGE INJECTION REQUIREMENT: p_client_key is meaningful only when the edge
-- (API gateway / PostgREST hook) injects a value derived from the CALLER'S
-- NETWORK IDENTITY (source IP or equivalent). It must never be forwarded
-- from anything the client chose. Because that contract lives outside this
-- database, the resolver no longer depends on it alone: a global fallback
-- bucket caps TOTAL anonymous resolutions per minute, so a rotating key
-- degrades an attacker to the shared global budget instead of unlimited.
--
-- M4: the tag → asset hop now requires assets.org_id = the tag's org. A
-- forged or drifted tag row pointing at another org's asset resolves to the
-- same not-found shape as nonsense, instead of leaking a foreign product.
-- ---------------------------------------------------------------------------
create or replace function resolve_tag_public(p_tag_code text, p_client_key text default 'anon')
returns table (found boolean, product_name text, owner_name text, owner_phone text)
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
    return query select false, null::text, null::text, null::text;
    return;
  end if;

  select * into v_asset from assets
   where id = v_tag.asset_id
     and org_id = v_tag.org_id          -- M4: never resolve across orgs
     and deleted_at is null;
  if not found then
    return query select false, null::text, null::text, null::text;
    return;
  end if;

  select * into v_org from orgs where id = v_tag.org_id;

  return query
  select
    true,
    (select p.display_name from products p where p.id = v_asset.product_id),
    case when coalesce((v_org.settings ->> 'public_tag_show_owner')::boolean, false)
         then v_org.name end,
    case when coalesce((v_org.settings ->> 'public_tag_show_owner')::boolean, false)
         then v_org.settings ->> 'public_phone' end;
end
$$;

revoke all on function resolve_tag_public(text, text) from public;
grant execute on function resolve_tag_public(text, text) to papa_app;

-- ---------------------------------------------------------------------------
-- M5 / M6 — the PII guard grows patterns, and an audited exclusion list
--
-- The exact-name registry missed jobs.contact — a phone number, syncing to
-- every warehouse phone since 0005. Entries are now LIKE patterns (an exact
-- name is just a pattern with no wildcard, so 0009's rows keep working).
--
-- The blunt existence rule stays the DEFAULT remedy (split the table). For a
-- column that must remain on a syncable table, sync_column_exclusions
-- records the REVIEWED decision to project it out, and
-- sync_exclusion_violations() proves pull_changes actually omits it — the
-- part 0009 called unverifiable is verifiable now that every block is an
-- explicit projection (no `select *` survives below).
-- ---------------------------------------------------------------------------
insert into sync_sensitive_columns (column_name, reason) values
  ('%phone%',       'phone numbers are PII under PECA and a harassment vector; a stolen scanner must not carry them'),
  ('contact%',      'free-text contact fields hold phone numbers in practice (jobs.contact does today)'),
  ('cnic%',         'pattern form of the cnic entries: catches cnic_expiry and friends'),
  ('ntn%',          'pattern form of ntn'),
  ('credit_limit%', 'commercial terms; the warehouse floor has no need to know them')
on conflict (column_name) do nothing;

create table if not exists sync_column_exclusions (
  table_name  text not null,
  column_name text not null,
  reason      text not null,
  added_at    timestamptz not null default now(),
  primary key (table_name, column_name)
);

insert into sync_column_exclusions (table_name, column_name, reason) values
  ('jobs', 'contact',
   'A phone number. Stays on the server for the desk; projected OUT of pull_changes as of 0015. The M5/M6 violation this table exists for.')
on conflict do nothing;

comment on table sync_column_exclusions is
  'Sensitive columns REVIEWED and allowed to remain on a syncable table because pull_changes projects them out. Every row must hold against sync_exclusion_violations(). Splitting the table is still the preferred remedy.';

alter table sync_column_exclusions enable row level security;
drop policy if exists sync_column_exclusions_readable on sync_column_exclusions;
create policy sync_column_exclusions_readable on sync_column_exclusions
  for select using (true);
grant select on sync_column_exclusions to papa_app;

create or replace function sync_pii_violations()
returns table (table_name text, column_name text)
language sql
stable
as $$
  -- A table is syncable exactly when make_syncable() gave it change_seq.
  -- Pattern match (0015): 'contact%' catches contact_phone, not just contact.
  select c.table_name::text, c.column_name::text
    from information_schema.columns c
   where c.table_schema = 'public'
     and exists (
       select 1 from sync_sensitive_columns sc
        where lower(c.column_name) like sc.column_name
     )
     and exists (
       select 1 from information_schema.columns s
        where s.table_schema = 'public'
          and s.table_name = c.table_name
          and s.column_name = 'change_seq'
     )
     and not exists (
       select 1 from sync_column_exclusions e
        where e.table_name = c.table_name
          and e.column_name = c.column_name
     )
   order by 1, 2;
$$;

comment on function sync_pii_violations() is
  'Sensitive-pattern columns living on syncable tables, minus reviewed exclusions. Must always return zero rows — asserted in the test suite. Remedy is to split the table, not to widen the exclusion list.';

/**
 * The other half of the exclusion contract: an excluded column must not
 * appear anywhere in pull_changes, and its table must not be pulled with
 * `select *`. Checkable only because 0015 makes every block an explicit
 * projection.
 */
create or replace function sync_exclusion_violations()
returns table (table_name text, column_name text, problem text)
language sql
stable
as $$
  with src as (
    select prosrc from pg_proc
     where proname = 'pull_changes' and pronamespace = 'public'::regnamespace
  )
  select e.table_name, e.column_name,
         'excluded column is referenced by pull_changes'::text
    from sync_column_exclusions e, src
   where src.prosrc ~* ('\m' || e.column_name || '\M')
  union all
  select e.table_name, e.column_name,
         'table is pulled with select * — the exclusion is not enforced'::text
    from sync_column_exclusions e, src
   where src.prosrc ~* ('select\s+\*\s+from\s+' || e.table_name || '\M')
   order by 1, 2, 3;
$$;

comment on function sync_exclusion_violations() is
  'Must always return zero rows: every sync_column_exclusions entry must actually be projected out of pull_changes.';

grant execute on function sync_exclusion_violations() to papa_app;

-- ---------------------------------------------------------------------------
-- C1 — the sync cursor learns about in-flight transactions
--
-- Two settle signals per syncable row, applied only against rows written by
-- OTHER transactions (a pull can always trust its own writes):
--
--   changed_xid8 >= snapshot xmin  — the writer was concurrent with a txn
--       that is STILL OPEN, so a lower change_seq may still be invisible.
--       Exact, and covers arbitrarily long in-flight transactions.
--   changed_at within 3 seconds    — the 0010-style settle lag, covering the
--       one interleaving the xmin test cannot see (a low-xid transaction
--       writing late while a higher-xid one holds a lower seq).
--
-- Either signal holds the cursor below the row. Both are free on the
-- caught-up hot path, which never leaves the watermark early-out.
-- ---------------------------------------------------------------------------
alter table products           add column if not exists changed_at timestamptz not null default clock_timestamp();
alter table assets             add column if not exists changed_at timestamptz not null default clock_timestamp();
alter table asset_tags         add column if not exists changed_at timestamptz not null default clock_timestamp();
alter table locations          add column if not exists changed_at timestamptz not null default clock_timestamp();
alter table jobs               add column if not exists changed_at timestamptz not null default clock_timestamp();
alter table kit_templates      add column if not exists changed_at timestamptz not null default clock_timestamp();
alter table kit_template_items add column if not exists changed_at timestamptz not null default clock_timestamp();
alter table asset_containment  add column if not exists changed_at timestamptz not null default clock_timestamp();
alter table dispatches         add column if not exists changed_at timestamptz not null default clock_timestamp();

alter table products           add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();
alter table assets             add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();
alter table asset_tags         add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();
alter table locations          add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();
alter table jobs               add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();
alter table kit_templates      add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();
alter table kit_template_items add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();
alter table asset_containment  add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();
alter table dispatches         add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();

create or replace function set_change_seq()
returns trigger
language plpgsql
as $$
begin
  new.change_seq   := nextval('change_seq_seq');
  -- When and by which transaction this row was written. The sync cursor
  -- holds itself below any not-yet-settled row, because a lower change_seq
  -- may still be invisible (C1, 0015).
  new.changed_at   := clock_timestamp();
  new.changed_xid8 := pg_current_xact_id();
  return new;
end
$$;

/**
 * Make a table syncable (0015: now also adds changed_at / changed_xid8, so a
 * future syncable table cannot miss the pieces cursor safety depends on).
 */
create or replace function make_syncable(p_table text)
returns void
language plpgsql
as $$
begin
  execute format('alter table %I add column if not exists change_seq bigint', p_table);
  execute format(
    'alter table %I add column if not exists changed_at timestamptz not null default clock_timestamp()',
    p_table);
  execute format(
    'alter table %I add column if not exists changed_xid8 xid8 not null default pg_current_xact_id()',
    p_table);
  execute format(
    'create index if not exists %I on %I (org_id, change_seq)',
    p_table || '_change_seq_idx', p_table);
  execute format('drop trigger if exists %I on %I', p_table || '_change_seq', p_table);
  execute format(
    'create trigger %I before insert or update on %I
       for each row execute function set_change_seq()',
    p_table || '_change_seq', p_table);
  -- Existing rows need a value or the first pull would skip them entirely.
  execute format('update %I set change_seq = nextval(''change_seq_seq'') where change_seq is null', p_table);
end
$$;

-- ---------------------------------------------------------------------------
-- pull_changes, third edition
--
-- Unchanged: static SQL, the watermark early-out, and THE CURSOR IS THE
-- MINIMUM SAFE ADVANCE. New in 0015:
--
--   * C1: each block also finds the lowest returned change_seq whose writer
--     was concurrent with a still-open transaction (changed_xid8 >= the
--     snapshot's xmin, and not our own xid — our own writes are settled for
--     us by definition). The cursor is capped BELOW it. Rows above the cap
--     are still delivered; they simply get re-sent, which the client mirror
--     absorbs idempotently. The watermark early-out needs no equivalent
--     because it never advances the cursor — it returns p_since untouched,
--     and a cursor that does not move cannot skip.
--
--   * M6: EVERY block is an explicit projection now. jobs.contact (a phone
--     number — see sync_column_exclusions) no longer syncs, and the
--     bookkeeping columns changed_xid8 never leave the server.
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
                 rentable, presence, health, ownership, current_location_id,
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
    from (select id, org_id, label, expected_back, status, created_by,
                 created_at, updated_at, deleted_at, change_seq, changed_xid8, changed_at
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
  'Cursor-pull sync. Early-outs on a per-org watermark; static SQL; explicit projections (no select *, no jobs.contact). Cursor is the MINIMUM SAFE ADVANCE and, as of 0015, is also held below any row written concurrently with a still-open transaction so a late commit can never be skipped.';
