-- ============================================================================
-- 0023 — Reservations sync: the promise calendar reaches the phone
--
-- 0022 D13 deferred the sync projection until a client read it. That
-- client exists now (packages/core/src/bookings.ts and the demo store's
-- booking read model ship in the same wave), so schema and consumer land
-- together — the 0018 D5 discipline. This migration makes the four
-- booking tables and stock_lots syncable, and ships the SEVENTH edition of
-- pull_changes: 0021's sixth verbatim, plus one column on jobs and five
-- new blocks.
--
-- WHAT THIS MIGRATION DECIDES, and why:
--
--   D1  THE CLIENT'S NAME RIDES THE BOOKING. A booking on a phone must say
--       who it is for; the customers table never syncs (0009/0015 keep
--       phone numbers and CNICs off a stolen scanner), and a customers_lite
--       mirror would be a second syncable table carrying a name column
--       that the PII guard would have to be taught about. So the bookings
--       block projects `customer_name` by subselect from customers. `name`
--       is not in sync_sensitive_columns (verified: cnic%, ntn%, %phone%,
--       contact%, credit_limit%, and the 0009 literals) and the guard test
--       below proves the projection stays clean. Cost: a renamed customer
--       reaches the phone with the booking's next write, not the rename —
--       the desk owns the name, the phone only displays it.
--
--   D2  RANGES ARE PROJECTED AS BOUNDS. SQLite has no tstzrange; the phone
--       wants epoch ms. lower()/upper() of both periods go out as ISO
--       timestamps, '[)' as they were stored (0022 D3). Nothing is widened
--       or narrowed in transit.
--
--   D3  ONLY WHAT THE PHONE READS. The credential override note, its
--       author and time stay server-side (a manager's remark about a
--       stranger's paperwork has no business on a warehouse phone);
--       cancelled_by, created_by and buffer_policy_version have no reader.
--       stock_lots ships without reorder_threshold. Every block is an
--       explicit projection, so sync_exclusion_violations() can keep
--       checking that nothing excluded is named.
--
--   D4  TOMBSTONES ARE THE RESERVATION ROWS' deleted_at. prune_expired_
--       pencils and cancel_booking already stamp it (0022 D7); making the
--       tables syncable turns that stamp into a change_seq bump the phone
--       sees, and the mirror deletes the row. The booking row itself stays
--       (status = cancelled, cancel_reason = pencil_expired) so the desk's
--       history reads the same on every device.
--
--   D5  jobs.booking_id JOINS THE PROJECTION. 0022 D8 kept it out until a
--       phone read it; the phone's convert-to-job rule now does — one live
--       job per booking, cancel refused while it is open.
--
-- Idempotent: make_syncable / attach_watermark_trigger are IF NOT EXISTS
-- inside; pull_changes is OR REPLACE. 0001–0022 stay untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Syncable: change_seq, its index, the trigger, and the watermark bump.
-- No new grants — papa_app already holds SELECT on every one of these
-- (0022 D11; stock_lots since 0002), and pull_changes runs as the caller.
-- ---------------------------------------------------------------------------
select make_syncable(t) from unnest(array[
  'bookings', 'booking_lines', 'asset_reservations', 'stock_reservations',
  'stock_lots'
]) as t;

select attach_watermark_trigger(t) from unnest(array[
  'bookings', 'booking_lines', 'asset_reservations', 'stock_reservations',
  'stock_lots'
]) as t;

comment on column jobs.booking_id is
  'Set by convert_booking_to_job (0022 D8). One live job per booking. In the pull projection as of 0023 (D5): the phone reads it.';

-- ---------------------------------------------------------------------------
-- pull_changes, seventh edition (D1–D5)
--
-- 0021's sixth edition verbatim — static SQL, the watermark early-out, THE
-- CURSOR IS THE MINIMUM SAFE ADVANCE, the C1 settle holdback, explicit
-- projections everywhere — plus booking_id on jobs and five new blocks:
-- bookings (name denormalised, ranges split), booking_lines,
-- asset_reservations, stock_reservations, stock_lots. The excluded jobs
-- column stays projected out (the M6 rule; the guard greps this function's
-- source, so it is not named here).
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
        'stock_lots', '[]'::jsonb));
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
    from (select id, org_id, label, expected_back, status, customer_id, closed_at,
                 booking_id, created_by, created_at, updated_at, deleted_at,
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
    
    from (select id, org_id, booking_id, product_id, asset_id, qty,
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
  'Cursor-pull sync, seventh edition (0023): the 0021 sixth edition plus jobs.booking_id and the promise calendar — bookings (customer name denormalised, periods split into bounds), booking_lines, asset_reservations, stock_reservations, stock_lots. The cursor is the minimum safe advance; explicit projections everywhere; the excluded jobs column stays out.';

grant execute on function pull_changes(bigint, int) to papa_app;
