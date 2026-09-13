-- ============================================================================
-- 0027 — The pipe (W9): the members mirror, and exactly-once for every
--        non-scan op
--
-- The phone has never spoken to this server. Two things it needs from the
-- server before it can, and both are small:
--
--   D1  A MEMBERS MIRROR. The PIN gate on a shared phone needs a list of
--       who may pick it up: user id (what switch_session_user takes),
--       display name, role, and whether a PIN is set. Names and roles are
--       not PII (the 0023 D1 reasoning; phones and CNICs stay home — the
--       sync guards below prove it). memberships becomes syncable and
--       pull_changes gains a TENTH edition: 0026's ninth verbatim plus one
--       block, `members`, projected through member_projection() (DEFINER)
--       so the users row's grants and the hidden hash column are never
--       read from the INVOKER function. A display-name change touches the
--       person's memberships so it reaches every phone; a suspended
--       membership is projected as a tombstone.
--
--   D2  EXACTLY ONCE. submit_scan_batch is idempotent per (device,
--       client_seq); nothing else is. A pencil placed offline goes to
--       create_booking, the reply is lost in a tunnel, the phone retries —
--       and the same camera is booked twice with two numbers. replay_op
--       (p_op_id, p_rpc, p_args) runs the named RPC ONCE per (device, op
--       id) and files the reply in op_receipts; a retry is answered by the
--       receipt, with the ORIGINAL reply (the id the server minted), and
--       flagged duplicate. INVOKER on purpose: the inner RPC runs as the
--       caller, so every role gate and RLS policy holds exactly as if the
--       phone had called it directly; a raised error rolls the receipt
--       back with everything else. Receipts are visible and writable only
--       to the device that made them (RLS on org + device), so no phone
--       can forge another's.
--
--   D3  The argument binding is generic and typed from pg_proc: each key of
--       p_args that names an IN parameter is cast to that parameter's type
--       (jsonb passes through, arrays are unpacked, everything else is
--       `->>` then a cast), so a new RPC needs no wrapper. Only public-
--       schema functions by exact name, never replay_op itself nor the
--       auth entry points (a session cannot be minted through a receipt).
--
-- One new table (op_receipts): db/test-migrate.sh's count goes 47 → 48.
-- Idempotent: make_syncable / attach_watermark_trigger are IF NOT EXISTS
-- inside; everything else is OR REPLACE or IF NOT EXISTS. 0001–0026 stay
-- untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- D1: memberships become syncable
-- ---------------------------------------------------------------------------
select make_syncable('memberships');
select attach_watermark_trigger('memberships');

-- 0015 H3 granted papa_app an explicit COLUMN list on memberships (every
-- column but pin_hash); the three sync columns make_syncable just added are
-- outside it, and the INVOKER pull reads them. Extend the list — pin_hash
-- stays hidden.
grant select (change_seq, changed_xid8, changed_at) on memberships to papa_app;

/**
 * What a phone may know about a member beyond the membership row: the
 * display name and whether a PIN exists. DEFINER so the INVOKER pull can
 * answer without SELECT on users or on the hidden hash column; scoped to
 * the caller's org so it can never describe a stranger.
 */
create or replace function member_projection(p_user_id uuid)
returns table (display_name text, has_pin boolean)
language sql
stable
security definer
set search_path = public
as $$
  select u.display_name,
         exists (select 1 from memberships m
                  where m.org_id = current_org_id()
                    and m.user_id = p_user_id
                    and m.deleted_at is null
                    and m.pin_hash is not null) as has_pin
    from users u
   where u.id = p_user_id
     and exists (select 1 from memberships m2
                  where m2.org_id = current_org_id() and m2.user_id = p_user_id)
$$;

comment on function member_projection(uuid) is
  'The members-mirror projection for one user in the caller''s org: display name and whether a PIN is set. DEFINER so pull_changes never reads users or pin_hash itself.';

/**
 * A renamed person reaches every phone: touching the memberships rows bumps
 * their change_seq (set_change_seq, before update) and the org watermark.
 * DEFINER: the caller is whoever updated users (the person themself, via
 * users_update_self) and need not hold the memberships write policy.
 */
create or replace function touch_memberships_on_user_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.display_name is distinct from old.display_name
     or new.deleted_at is distinct from old.deleted_at then
    update memberships set updated_at = now() where user_id = new.id;
  end if;
  return new;
end
$$;

drop trigger if exists users_touch_memberships on users;
create trigger users_touch_memberships
  after update on users
  for each row execute function touch_memberships_on_user_change();

-- ---------------------------------------------------------------------------
-- D2: op_receipts — one row per (device, op) the server has answered
-- ---------------------------------------------------------------------------
create table if not exists op_receipts (
  org_id     uuid not null references orgs(id) on delete restrict,
  device_id  text not null,
  op_id      uuid not null,
  rpc        text not null,
  reply      jsonb,
  created_at timestamptz not null default now(),
  primary key (org_id, device_id, op_id)
);

comment on table op_receipts is
  'replay_op''s memory (0027 D2): the reply the server gave a device''s op, keyed by the outbox id, so a retried op is answered instead of re-run. Visible and writable only to the device that made it.';

alter table op_receipts enable row level security;
alter table op_receipts force row level security;

drop policy if exists op_receipts_own_device on op_receipts;
create policy op_receipts_own_device on op_receipts
  for all
  using (org_id = (select current_org_id()) and device_id = (select current_device_id()))
  with check (org_id = (select current_org_id()) and device_id = (select current_device_id()));

grant select, insert on op_receipts to papa_app;

/**
 * Run one RPC exactly once per (device, op id). See the header (D2, D3).
 *
 * INVOKER: the inner call runs as the caller with the caller's papa.*
 * context, so RLS, require_role and every DEFINER entry point behave as if
 * called directly. Requires a device session — a receipt needs a device to
 * belong to, and the console has no outbox.
 */
create or replace function replay_op(
  p_op_id uuid,
  p_rpc   text,
  p_args  jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_org    uuid := current_org_id();
  v_dev    text := current_device_id();
  v_prev   jsonb;
  v_proc   pg_proc%rowtype;
  v_count  int;
  v_names  text[];
  v_types  oid[];
  v_arg    text;
  v_type   text;
  v_elem   text;
  v_parts  text[] := '{}';
  v_sql    text;
  v_reply  jsonb;
  v_rettype text;
  i        int;
begin
  if v_org is null or v_dev is null then
    raise exception 'replay_op needs a device session' using errcode = 'insufficient_privilege';
  end if;
  if p_op_id is null then
    raise exception 'an op id is required' using errcode = '22023';
  end if;
  if p_rpc is null or p_rpc !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'not an RPC name: %', coalesce(p_rpc, '<null>') using errcode = '22023';
  end if;
  if p_rpc in ('replay_op', 'submit_scan_batch', 'pull_changes',
               'complete_enrolment', 'authenticate_device', 'auth_pre_request',
               'switch_session_user', 'reset_pin_with_otp', 'sign_out_device',
               'request_otp', 'enrol_verified_device') then
    raise exception '% cannot be replayed through a receipt', p_rpc using errcode = 'insufficient_privilege';
  end if;
  if p_args is null or jsonb_typeof(p_args) <> 'object' then
    raise exception 'p_args must be a JSON object' using errcode = '22023';
  end if;

  -- The receipt answers first. The policy scopes this to our own device.
  select reply into v_prev
    from op_receipts
   where org_id = v_org and device_id = v_dev and op_id = p_op_id;
  if found then
    return jsonb_build_object('reply', v_prev, 'duplicate', true);
  end if;

  -- Resolve the function: public schema, exact name, no overloads.
  select count(*) into v_count
    from pg_proc p
   where p.proname = p_rpc and p.pronamespace = 'public'::regnamespace;
  if v_count = 0 then
    raise exception 'no such RPC: %', p_rpc using errcode = '42883';
  end if;
  if v_count > 1 then
    raise exception 'RPC % is overloaded; replay_op needs one signature', p_rpc using errcode = '42725';
  end if;
  select * into v_proc
    from pg_proc p
   where p.proname = p_rpc and p.pronamespace = 'public'::regnamespace;

  if not has_function_privilege(v_proc.oid, 'execute') then
    raise exception 'permission denied for RPC %', p_rpc using errcode = 'insufficient_privilege';
  end if;

  -- Bind by name, typed from the signature (D3). proargtypes lists IN
  -- parameters only; proargnames lists IN then OUT, so the first
  -- pronargs names are the ones that matter.
  v_names := v_proc.proargnames;
  -- oidvector subscripts start at ZERO; unnest into a 1-based array so the
  -- i-th name meets the i-th type (the bug this comment replaced paired
  -- p_name with the NEXT parameter's type).
  select array_agg(t) into v_types from unnest(v_proc.proargtypes) t;
  for i in 1 .. coalesce(array_length(v_types, 1), 0) loop
    v_arg := v_names[i];
    if v_arg is null or not (p_args ? v_arg) then
      continue;    -- absent → the parameter's own default
    end if;
    v_type := format_type(v_types[i], null);
    if v_type in ('jsonb', 'json') then
      v_parts := v_parts || format('%I => ($1 -> %L)::%s', v_arg, v_arg, v_type);
    elsif v_type like '%[]' then
      v_elem := left(v_type, length(v_type) - 2);
      v_parts := v_parts || format(
        '%I => (case when jsonb_typeof($1 -> %L) = ''array''
                     then (select array_agg(e::%s) from jsonb_array_elements_text($1 -> %L) e)
                     else null end)::%s',
        v_arg, v_arg, v_elem, v_arg, v_type);
    else
      v_parts := v_parts || format('%I => ($1 ->> %L)::%s', v_arg, v_arg, v_type);
    end if;
  end loop;

  v_rettype := format_type(v_proc.prorettype, null);
  if v_rettype = 'void' then
    v_sql := format('select public.%I(%s)', p_rpc, array_to_string(v_parts, ', '));
    execute v_sql using p_args;
    v_reply := null;
  elsif v_proc.proretset then
    v_sql := format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I(%s) x',
                    p_rpc, array_to_string(v_parts, ', '));
    execute v_sql into v_reply using p_args;
  else
    v_sql := format('select to_jsonb(public.%I(%s))', p_rpc, array_to_string(v_parts, ', '));
    execute v_sql into v_reply using p_args;
  end if;

  insert into op_receipts (org_id, device_id, op_id, rpc, reply)
  values (v_org, v_dev, p_op_id, p_rpc, v_reply);

  return jsonb_build_object('reply', v_reply, 'duplicate', false);
end
$$;

comment on function replay_op(uuid, text, jsonb) is
  'Exactly-once for a device''s non-scan op (0027 D2): runs the named public RPC as the caller with p_args bound by name and typed from the signature, files the reply in op_receipts keyed by (device, op id), and answers a retry from the receipt with duplicate = true. Never mints a session and never replays itself.';

revoke all on function replay_op(uuid, text, jsonb) from public;
grant execute on function replay_op(uuid, text, jsonb) to papa_app;

revoke all on function member_projection(uuid) from public;
grant execute on function member_projection(uuid) to papa_app;

revoke all on function touch_memberships_on_user_change() from public;

-- ---------------------------------------------------------------------------
-- pull_changes, tenth edition (D1)
--
-- 0026's ninth edition verbatim — static SQL, the watermark early-out, THE
-- CURSOR IS THE MINIMUM SAFE ADVANCE, the C1 settle holdback, explicit
-- projections everywhere — plus ONE block, `members`, and its key in the
-- early-out set (seventeen tables now; 0026's test counts them). The
-- excluded jobs column stays projected out (the M6 rule; the guard greps
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
        'kit_template_items', '[]'::jsonb, 'asset_containment', '[]'::jsonb,
        'bookings', '[]'::jsonb, 'booking_lines', '[]'::jsonb,
        'asset_reservations', '[]'::jsonb, 'stock_reservations', '[]'::jsonb,
        'stock_lots', '[]'::jsonb,
        'rate_cards', '[]'::jsonb, 'rate_card_entries', '[]'::jsonb,
        'org_calendar_days', '[]'::jsonb,
        'members', '[]'::jsonb));
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
    -- 0023: booking_id (the 0022 D8 bridge) joins them — the phone now
    -- reads it to refuse a second conversion and a cancel under a live job.
    -- 0025 D8: attendant_names — the crew line, display names only, in
    -- assignment order, [] when nobody is on it. Names are not in the
    -- sensitive registry (the 0023 D1 reasoning); assign/unassign touch the
    -- job row so this projection re-syncs when the crew changes.
    from (select j.id, j.org_id, j.label, j.expected_back, j.status, j.customer_id, j.closed_at,
                 j.booking_id, j.created_by, j.created_at, j.updated_at, j.deleted_at,
                 job_attendant_names(j.id) as attendant_names,
                 j.change_seq, j.changed_xid8, j.changed_at
            from jobs j where j.change_seq > p_since order by j.change_seq limit p_limit) x;
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

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- 0023: the promise calendar. The two tstzranges are projected as
    -- their bounds (SQLite has no range type; both are '[)'). The client's
    -- NAME is denormalised in from customers — the customers table itself
    -- never syncs (0009/0015) — so a phone can say who a promise is for
    -- without carrying the khata. A rename reaches the phone with the
    -- booking's next write; the desk owns the name, the phone displays it.
    -- The credential override note stays server-side: a manager's remark
    -- about a stranger's paperwork has no business on a warehouse phone.
    from (select b.id, b.org_id, b.booking_no, b.customer_id,
                 (select c.name from customers c where c.id = b.customer_id) as customer_name,
                 b.status,
                 lower(b.customer_period) as customer_from,
                 upper(b.customer_period) as customer_until,
                 lower(b.blocked_period) as blocked_from,
                 upper(b.blocked_period) as blocked_until,
                 b.pencil_expires_at, b.note, b.cancel_reason,
                 b.created_at, b.updated_at, b.deleted_at,
                 b.change_seq, b.changed_xid8, b.changed_at
            from bookings b where b.change_seq > p_since order by b.change_seq limit p_limit) x;
  result := result || jsonb_build_object('bookings', rows);
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

    -- 0026: the 0024 D8 override — the owner's final day rate, the card
    -- rate it replaced, and why — so the phone's quote shows the owner's
    -- number, not the card's. overridden_by / overridden_at stay home:
    -- the phone renders the reason, the audit row keeps the who and when.
    from (select id, org_id, booking_id, product_id, asset_id, qty,
                 rate_minor, original_rate_minor, override_reason,
                 created_at, deleted_at, change_seq, changed_xid8, changed_at
            from booking_lines where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('booking_lines', rows);
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
    -- The reservation tombstones are what make an expired or cancelled
    -- pencil's claims vanish from every phone: prune_expired_pencils and
    -- cancel_booking set deleted_at, change_seq bumps, the mirror deletes.
    from (select id, org_id, booking_id, booking_line_id, asset_id,
                 lower(blocked_period) as blocked_from,
                 upper(blocked_period) as blocked_until,
                 state, created_at, deleted_at, change_seq, changed_xid8, changed_at
            from asset_reservations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_reservations', rows);
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

    from (select id, org_id, booking_id, booking_line_id, product_id, qty,
                 lower(blocked_period) as blocked_from,
                 upper(blocked_period) as blocked_until,
                 state, created_at, deleted_at, change_seq, changed_xid8, changed_at
            from stock_reservations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('stock_reservations', rows);
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
    -- The bulk shelf count the phone's availability answer starts from
    -- (0022 D6 here-now). Slim on purpose: no reorder threshold, no costs.
    -- stock_lots has no deleted_at — a lot is never tombstoned, only
    -- counted to zero.
    from (select id, org_id, product_id, location_id, qty_on_hand,
                 created_at, updated_at, change_seq, changed_xid8, changed_at
            from stock_lots where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('stock_lots', rows);
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
    -- 0026: the rate card (0024 D3/D4/D10). Slim: the three knobs and the
    -- default flag; created_by stays home. RLS role-gates this table to
    -- owner/manager/desk, and pull_changes is INVOKER — a warehouse phone
    -- receives an empty page here, the price list never reaches the floor.
    from (select id, org_id, name, is_default, week_equals_days, min_billable_days,
                 weekend_mask, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from rate_cards where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('rate_cards', rows);
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
    -- 0026: one product's day rate on one card (0024 D5). Same role gate
    -- as the card. A soft-deleted entry is the tombstone that sends the
    -- line back to unpriced on every phone — never to zero.
    from (select id, org_id, rate_card_id, product_id, day_rate_minor,
                 created_at, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from rate_card_entries where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('rate_card_entries', rows);
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
    -- 0026: the calendar (0024 D6/D7) — every member sees it, season
    -- shading is useful on every screen. day is projected as text.
    from (select id, org_id, day::text as day, kind, name, rate_multiplier,
                 created_at, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from org_calendar_days where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('org_calendar_days', rows);
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
    -- 0027 (W9): who can pick up this phone. The user id is the row's id
    -- (switch_session_user takes it); the display name and whether a PIN
    -- is set come through member_projection() — DEFINER, so the users
    -- row's grants and the hidden hash column are never touched from
    -- here, and the guard that greps this function's source finds no
    -- sensitive name. A suspended membership is projected as a tombstone:
    -- the person leaves every phone's picker at its next sync.
    from (select m.user_id as id, m.org_id, mp.display_name, m.role, mp.has_pin,
                 m.created_at, m.updated_at,
                 case when m.status = 'active' then m.deleted_at
                      else coalesce(m.deleted_at, m.updated_at) end as deleted_at,
                 m.change_seq, m.changed_xid8, m.changed_at
            from memberships m
            cross join lateral member_projection(m.user_id) mp
           where m.change_seq > p_since order by m.change_seq limit p_limit) x;
  result := result || jsonb_build_object('members', rows);
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
  'Cursor-pull sync, tenth edition (0027): the 0026 ninth edition plus the members mirror (user id, display name, role, has_pin — through member_projection). The cursor is the minimum safe advance; explicit projections everywhere; the excluded jobs column stays out.';

grant execute on function pull_changes(bigint, int) to papa_app;
