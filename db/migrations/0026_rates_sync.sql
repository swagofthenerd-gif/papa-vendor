-- ============================================================================
-- 0026 — Rates sync: the rate card, its entries and the org calendar reach
--        the phone, and the override rides the booking line
--
-- 0024 built the rate card, the calendar and price_booking() on the server
-- and — deliberately, D11 — synced none of it: "None of the three sync
-- (no change_seq)". The client wave (W6b) needs them on the phone: the
-- desk prices a pasted kit list OFFLINE through the same six steps
-- (packages/core/src/pricing.ts mirrors price_booking step for step), and
-- a quote computed on the phone must carry the server's numbers. That is
-- only true if the phone holds the same card, the same entries and the
-- same calendar rows the server reads. This migration makes the three
-- tables syncable and projects them, plus the 0024 D8 override columns on
-- booking_lines, in a NINTH edition of pull_changes.
--
-- WHAT THIS MIGRATION DECIDES, and why:
--
--   D1  THE THREE RATE TABLES SYNC, ROLE-GATED BY RLS, NOT BY PROJECTION.
--       make_syncable() gives rate_cards, rate_card_entries and
--       org_calendar_days a change_seq, the settle columns and the
--       watermark bump — the 0023 treatment. pull_changes is INVOKER, so
--       the 0024 D11 SELECT policies do the gating for free: an
--       owner/manager/desk phone receives the card and its entries; a
--       warehouse phone's page carries empty arrays for both, because
--       the price list is not the floor's business. The calendar reaches
--       every member (0024: "season shading is useful on every screen").
--       No projection-side role branch — a second copy of the gate would
--       drift from the policy.
--
--   D2  SLIM PROJECTIONS. rate_cards: id, name, is_default and the three
--       knobs (week_equals_days, min_billable_days, weekend_mask) —
--       created_by stays home. rate_card_entries: the card, the product,
--       the rate. org_calendar_days: day (as text), kind, name,
--       rate_multiplier. Every row carries deleted_at so a removed entry
--       tombstones on the phone and the line goes back to UNPRICED —
--       never to zero (0024 D5): the mirror deletes the row, it does not
--       coalesce it.
--
--   D3  THE OVERRIDE RIDES booking_lines: rate_minor, original_rate_minor,
--       override_reason join the 0023 projection. The phone renders the
--       owner's number, the struck-through card rate and the reason;
--       overridden_by and overridden_at stay home — the audit row (0024
--       D8, override 17) keeps the who and when, and a user id on a
--       warehouse phone buys nothing. None of the three is in
--       sync_sensitive_columns (verified: cnic%, ntn%, %phone%, contact%,
--       credit_limit%, guarantor% and the 0009 literals) and the guard
--       test proves the ninth edition stays clean.
--
--   D4  pull_changes, NINTH EDITION: 0025's eighth verbatim — static SQL,
--       the watermark early-out, THE CURSOR IS THE MINIMUM SAFE ADVANCE,
--       the C1 settle holdback, explicit projections everywhere — plus
--       the three columns on booking_lines (D3) and three new blocks in
--       the same shape, and the early-out key set grown to sixteen so the
--       two lists stay in step (0006's rule, asserted). The excluded jobs
--       column stays projected out (the M6 rule; not named here, the
--       guard greps this function's source).
--
--   D5  NO NEW TABLES, NO NEW RPCs, NO NEW GRANTS. papa_app already holds
--       SELECT on all three (0024 D11); the writes stay behind the 0024
--       doors, which the phone queues as ops (upsert_rate_card,
--       upsert_rate_entry, set_calendar_day, clear_calendar_day,
--       set_line_rate_override). db/test-migrate.sh's table count is
--       unchanged.
--
-- Idempotent: make_syncable / attach_watermark_trigger are IF NOT EXISTS
-- inside; pull_changes is OR REPLACE. 0001–0025 stay untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Syncable: change_seq, its index, the settle columns, the trigger, and the
-- watermark bump (D1). No new grants — papa_app already holds SELECT on
-- every one of these (0024 D11), and pull_changes runs as the caller.
-- ---------------------------------------------------------------------------
select make_syncable(t) from unnest(array[
  'rate_cards', 'rate_card_entries', 'org_calendar_days'
]) as t;

select attach_watermark_trigger(t) from unnest(array[
  'rate_cards', 'rate_card_entries', 'org_calendar_days'
]) as t;

comment on column booking_lines.override_reason is
  'Why the owner overrode this line''s rate (0024 D8). In the pull projection as of 0026 (D3): the phone renders it beside the struck-through card rate.';

-- ---------------------------------------------------------------------------
-- pull_changes, ninth edition (D3, D4)
--
-- 0025's eighth edition verbatim — static SQL, the watermark early-out, THE
-- CURSOR IS THE MINIMUM SAFE ADVANCE, the C1 settle holdback, explicit
-- projections everywhere — plus rate_minor / original_rate_minor /
-- override_reason on booking_lines and three new blocks for the rate
-- tables. The excluded jobs column stays projected out (the M6 rule; the
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
        'kit_template_items', '[]'::jsonb, 'asset_containment', '[]'::jsonb,
        'bookings', '[]'::jsonb, 'booking_lines', '[]'::jsonb,
        'asset_reservations', '[]'::jsonb, 'stock_reservations', '[]'::jsonb,
        'stock_lots', '[]'::jsonb,
        'rate_cards', '[]'::jsonb, 'rate_card_entries', '[]'::jsonb,
        'org_calendar_days', '[]'::jsonb));
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
  'Cursor-pull sync, ninth edition (0026): the 0025 eighth edition plus the three rate tables (rate_cards, rate_card_entries, org_calendar_days) as slim projections and the 0024 override columns on booking_lines. The cursor is the minimum safe advance; explicit projections everywhere; the excluded jobs column stays out.';

grant execute on function pull_changes(bigint, int) to papa_app;
