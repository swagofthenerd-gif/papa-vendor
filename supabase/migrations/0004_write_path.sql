-- ============================================================================
-- 0004 — The write path
--
-- Every client write goes through a function here. The device never composes
-- its own multi-row transaction and never decides what it is allowed to do.
--
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER, NOT SECURITY DEFINER — and this is a deliberate departure
-- from the architecture document.
--
-- SECURITY DEFINER runs as the function owner. The owner here is the
-- migration role, which is a superuser, and SUPERUSERS BYPASS RLS ENTIRELY.
-- So every DEFINER function silently becomes a hole in multi-tenancy unless it
-- re-implements the org check by hand, correctly, every time, forever. That is
-- the same class of trap that made the first RLS suite pass vacuously, and it
-- fails silently and in the customer's favour-of-nobody.
--
-- These functions are INVOKER, so RLS applies to them exactly as it applies to
-- a direct query. Tenancy is enforced in ONE place — the policies — and cannot
-- drift out of sync with a function body.
--
-- The rule "all writes go through RPCs" still holds, and is what these buy:
-- batching in one transaction, idempotency, role gates, and conflict detection
-- that a raw INSERT would skip. It is a business-logic boundary, not the
-- security boundary. The security boundary is RLS.
--
-- WHERE DEFINER *WILL* BE NEEDED: phase 2's booking confirmation, which must
-- be server-authoritative and atomic against the availability constraint. At
-- that point the direct grants get revoked and the function does its own
-- explicit org check. Do not reach for DEFINER before then.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- require_role — one place for the capability check
-- ---------------------------------------------------------------------------
create or replace function require_role(variadic roles text[])
returns void
language plpgsql
stable
as $$
begin
  if not has_role(variadic roles) then
    raise exception 'permission denied: requires one of %', array_to_string(roles, ', ')
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- submit_scan_batch — the only way scans reach the server
--
-- Takes the device outbox as a jsonb array and applies it in ONE transaction,
-- in order. All-or-nothing: a partial network failure must never half-apply a
-- pull session, leaving a truck loaded with gear the system thinks is on the
-- shelf.
--
-- Returns one row per submitted op so the device can retire exactly the right
-- outbox entries — `duplicate` is a SUCCESS, not an error. A retry after a
-- timeout where the server actually succeeded happens daily on a flaky mobile
-- network, and treating it as a failure is how a queue wedges forever.
-- ---------------------------------------------------------------------------
create type scan_submit_result as (
  client_seq  bigint,
  event_id    uuid,
  outcome     text,     -- accepted | duplicate
  alert_kind  text      -- null unless the server noticed something
);

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
  'The only path scans take to the server. One transaction, ordered by client_seq, idempotent per (device, seq). `duplicate` is a success.';

-- ---------------------------------------------------------------------------
-- bind_tag — attach a QR label to an asset
--
-- Online-only in the architecture. Softened, because the highest-volume task
-- of the entire onboarding — tagging 800 items on shelves — happens in the
-- warehouse where the gear is, which is exactly where the signal is worst.
-- Uniqueness resolves on sync and a collision is an enumerated conflict case
-- with a clean resolution, so an offline bind is safe to accept optimistically.
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

-- ---------------------------------------------------------------------------
-- intake_asset — create an asset by scanning a blank tag
--
-- Ten seconds, offline: scan a blank tag, take one photo, say a name. No
-- product record, no serial, no category — the desk enriches it later from a
-- chair with a keyboard.
--
-- This exists because the honest cost of onboarding 800 items is 10-20 person
-- hours, not "a structured afternoon", and because a flow that requires the
-- catalogue to exist first cannot be done on the shelf where the gear is.
-- Photo-first also means a tech with limited literacy can do it.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- generate_asset_code — the human-facing label printed on the tag
--
-- Crockford base32 with I, L, O and U removed. Not decoration: "FX9-02" vs
-- "FX9-O2" and "BAT-1I5" vs "BAT-115" are read at arm's length, in bad light,
-- by someone holding a case. Excluding the ambiguous glyphs at the SOURCE is
-- more reliable than choosing a typeface that distinguishes them, and we do
-- both.
--
-- NOT derived from the asset's UUID. UUIDv7's leading bits are a TIMESTAMP, so
-- slicing the front of one gives near-identical codes for anything created in
-- the same moment — two intakes in the same second collided immediately. The
-- entropy has to come from a random source, with a uniqueness retry, because
-- 32^6 is roomy but not a guarantee.
-- ---------------------------------------------------------------------------
create or replace function generate_asset_code(p_org uuid)
returns text
language plpgsql
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  -- no I L O U
  code text;
  bytes bytea;
begin
  for _attempt in 1..25 loop
    bytes := gen_random_bytes(6);
    code := '';
    for i in 0..5 loop
      code := code || substr(alphabet, 1 + (get_byte(bytes, i) % 32), 1);
    end loop;

    if not exists (
      select 1 from assets
       where org_id = p_org and asset_code = code and deleted_at is null
    ) then
      return code;
    end if;
  end loop;

  raise exception 'could not generate a unique asset code after 25 attempts';
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
-- resolve_tag_public — what a stranger's phone camera sees
--
-- SECURITY DEFINER here is correct and is the one place it is: this is
-- deliberately reachable WITHOUT an org context, so RLS must be bypassed. It
-- is kept to four fields and one lookup precisely because of that.
--
-- It returns the SAME shape for unbound, retired and unknown codes. Anything
-- else lets a competitor distinguish "real tag" from "nonsense" and estimate a
-- fleet from a handful of photographs.
--
-- The owner's name and number are OPT-IN per org. Defaulting them on tells a
-- thief exactly whose label to peel, and makes every case in a hotel lobby an
-- advertisement for which house is worth burgling.
-- ---------------------------------------------------------------------------
create or replace function resolve_tag_public(p_tag_code text)
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
  select * into v_tag from asset_tags where tag_code = p_tag_code and status = 'active';

  if not found then
    return query select false, null::text, null::text, null::text;
    return;
  end if;

  select * into v_asset from assets where id = v_tag.asset_id and deleted_at is null;
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

revoke all on function resolve_tag_public(text) from public;
grant execute on function resolve_tag_public(text) to papa_app;

grant execute on function
  require_role(text[]),
  generate_asset_code(uuid),
  submit_scan_batch(text, jsonb),
  bind_tag(text, uuid),
  intake_asset(text, text, uuid, uuid, text)
  to papa_app;
