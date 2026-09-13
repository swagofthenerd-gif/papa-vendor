-- ============================================================================
-- 0023 — Reservations sync: what the phone receives, and what it must not.
--
--   * the five tables are syncable (change_seq) and a booking write bumps
--     the org watermark, so a polling phone learns something changed;
--   * BOTH sync guards stay at zero with the new blocks in place — the
--     denormalised customer name is not a PII leak and the excluded jobs
--     column is still projected out;
--   * the early-out key set and the full key set agree (0006's rule —
--     thirteen tables as of 0023, sixteen since 0026's ninth edition);
--   * a pencil appears with its name, split periods and pencil claims; a
--     confirm turns the claims into confirmed reservations in the next
--     pull; convert-to-job puts booking_id on the job row; a cancel
--     propagates as reservation tombstones with the booking left
--     cancelled;
--   * org B never sees org A's calendar through pull, in any of the five
--     tables;
--   * what stays home: the credential override note, the counter table.
-- ============================================================================
begin;
select plan(40);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos',
   '{"new_customer_value_threshold_minor": 100000000000}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran', '{}'::jsonb);

insert into users (id, display_name) values
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (Kamran owner)');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack'),
  ('10000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222', 'Godown', 'rack');

insert into products (id, org_id, category, display_name, tracking_mode,
                      replacement_value_minor) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'camera', 'Sony FX9', 'serialized', 350000000),
  ('20000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'cable', 'XLR Cable 5m', 'bulk', 800000),
  ('20000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'cable', 'XLR Cable 3m', 'bulk', 600000);

insert into assets (id, org_id, product_id, asset_code, rental_days_since_service) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-A', 5),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-B', 1);

insert into stock_lots (id, org_id, product_id, location_id, qty_on_hand, reorder_threshold) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000003',
   '10000000-0000-7000-8000-000000000001', 10, 4),
  ('40000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   '20000000-0000-7000-8000-000000000009',
   '10000000-0000-7000-8000-000000000009', 3, null);

insert into customers (id, org_id, name, phone) values
  ('50000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'Rafi Productions', '03009998877'),
  ('50000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'Kamran Client', null);

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Syncable shape and the guards                                 [assert 1–9]
-- ---------------------------------------------------------------------------
select has_column('bookings', 'change_seq', 'bookings is syncable');
select has_column('booking_lines', 'change_seq', 'booking_lines is syncable');
select has_column('asset_reservations', 'change_seq', 'asset_reservations is syncable');
select has_column('stock_reservations', 'change_seq', 'stock_reservations is syncable');
select has_column('stock_lots', 'change_seq', 'stock_lots is syncable');

select is((select count(*)::int from sync_pii_violations()), 0,
  'the PII guard is clean with the five new syncable tables — the denormalised name is not PII');
select is((select count(*)::int from sync_exclusion_violations()), 0,
  'the excluded jobs column is still projected out of the seventh edition');

select ok(
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'booking_counters'
                 and column_name = 'change_seq'),
  'the gapless counter never syncs');

select is(
  (select count(*)::int from pg_trigger
    where tgname in ('bookings_watermark_ins', 'bookings_watermark_upd',
                     'booking_lines_watermark_ins', 'booking_lines_watermark_upd',
                     'asset_reservations_watermark_ins', 'asset_reservations_watermark_upd',
                     'stock_reservations_watermark_ins', 'stock_reservations_watermark_upd',
                     'stock_lots_watermark_ins', 'stock_lots_watermark_upd')),
  10, 'every new syncable table bumps the org watermark on insert and update');

-- ---------------------------------------------------------------------------
-- Key sets and the empty calendar                              [assert 10–13]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
set local role papa_app;

-- Thirteen as of 0023; 0026 (the ninth edition) adds the three rate tables.
select is(
  (select count(*)::int from jsonb_object_keys(pull_changes(0) -> 'tables')),
  18, 'the full pull carries eighteen tables (thirteen as of 0023, the 0026 rate tables, members as of 0027, org as of 0028)');
select is(
  (select count(*)::int from jsonb_object_keys(pull_changes(999999999) -> 'tables')),
  18, 'and the early-out names the same eighteen — the two lists are in step');
select is(
  jsonb_array_length(pull_changes(0) -> 'tables' -> 'bookings'), 0,
  'no bookings yet: an empty array, not a missing key');
select is(
  (pull_changes(0) -> 'tables' -> 'stock_lots' -> 0 ->> 'qty_on_hand'), '10',
  'the shelf count reaches the phone');

-- ---------------------------------------------------------------------------
-- A pencil is born and reaches the phone                       [assert 14–24]
-- ---------------------------------------------------------------------------
create temp table _mark on commit drop as
  select max_change_seq as before_seq from org_sync_watermark
   where org_id = '11111111-1111-7111-8111-111111111111';

create temp table _b1 on commit drop as
  select create_booking(
    '50000000-0000-7000-8000-000000000001',
    tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'),
    '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1},
      {"product_id": "20000000-0000-7000-8000-000000000003", "qty": 4}]'::jsonb
  ) as r;

select ok(
  (select max_change_seq from org_sync_watermark
    where org_id = '11111111-1111-7111-8111-111111111111')
    > (select before_seq from _mark),
  'a booking write bumps the org watermark — a polling phone wakes up');

create temp table _p1 on commit drop as select pull_changes(0) as p;

select is(jsonb_array_length((select p from _p1) -> 'tables' -> 'bookings'), 1,
  'the pencil is in the pull');
select is(((select p from _p1) -> 'tables' -> 'bookings' -> 0 ->> 'status'), 'pencil',
  'as a pencil');
select is(((select p from _p1) -> 'tables' -> 'bookings' -> 0 ->> 'customer_name'),
  'Rafi Productions', 'with the client''s name denormalised in (D1)');
select is(
  (((select p from _p1) -> 'tables' -> 'bookings' -> 0 ->> 'customer_from')::timestamptz),
  '2030-04-01 10:00+00'::timestamptz, 'customer_period lower bound projected as customer_from (D2)');
select is(
  (((select p from _p1) -> 'tables' -> 'bookings' -> 0 ->> 'blocked_until')::timestamptz),
  '2030-04-05 14:00+00'::timestamptz, 'blocked_period upper bound carries the turnaround buffer');
select ok(
  ((select p from _p1) -> 'tables' -> 'bookings' -> 0 ->> 'pencil_expires_at') is not null,
  'the pencil carries its expiry — the phone computes the countdown itself (0022 D7)');
select ok(
  not (((select p from _p1) -> 'tables' -> 'bookings' -> 0) ? 'credential_override_note'),
  'the credential override note stays home (D3)');
select is(jsonb_array_length((select p from _p1) -> 'tables' -> 'booking_lines'), 2,
  'both lines ride along');
select is(jsonb_array_length((select p from _p1) -> 'tables' -> 'stock_reservations'), 1,
  'the bulk pencil claim is in the pull…');
select is(((select p from _p1) -> 'tables' -> 'stock_reservations' -> 0 ->> 'state'), 'pencil',
  '…as a pencil');

-- ---------------------------------------------------------------------------
-- Confirm → the claims turn confirmed in the next pull          [assert 25–29]
-- ---------------------------------------------------------------------------
create temp table _c1 on commit drop as
  select confirm_booking(((select r from _b1) ->> 'booking_id')::uuid) as r;

create temp table _p2 on commit drop as select pull_changes(0) as p;

select is(((select p from _p2) -> 'tables' -> 'bookings' -> 0 ->> 'status'), 'confirmed',
  'the booking reads confirmed');
select ok(((select p from _p2) -> 'tables' -> 'bookings' -> 0 ->> 'pencil_expires_at') is null,
  'and its expiry is cleared');
select is(jsonb_array_length((select p from _p2) -> 'tables' -> 'asset_reservations'), 1,
  'the allocated unit''s reservation appears');
select is(((select p from _p2) -> 'tables' -> 'asset_reservations' -> 0 ->> 'asset_id'),
  '30000000-0000-7000-8000-000000000002',
  'and it is the least-utilised body, FX-B (0022 D4)');
select is(((select p from _p2) -> 'tables' -> 'stock_reservations' -> 0 ->> 'state'), 'confirmed',
  'the bulk claim upgraded in place');

-- ---------------------------------------------------------------------------
-- Convert → booking_id on the job row                          [assert 30–31]
-- ---------------------------------------------------------------------------
create temp table _j1 on commit drop as
  select convert_booking_to_job(((select r from _b1) ->> 'booking_id')::uuid) as job_id;

select is(
  (pull_changes(0) -> 'tables' -> 'jobs' -> 0 ->> 'booking_id'),
  ((select r from _b1) ->> 'booking_id'),
  'the job carries its booking_id to the phone (D5)');
select ok(
  not ((pull_changes(0) -> 'tables' -> 'jobs' -> 0) ? 'contact'),
  'and the excluded column is still not on the job row');

-- ---------------------------------------------------------------------------
-- Cancel → tombstones propagate, the booking stays cancelled  [assert 32–35]
-- ---------------------------------------------------------------------------
create temp table _b2 on commit drop as
  select create_booking(
    '50000000-0000-7000-8000-000000000001',
    tstzrange('2030-05-01 10:00+00', '2030-05-02 10:00+00', '[)'),
    '[{"product_id": "20000000-0000-7000-8000-000000000003", "qty": 2}]'::jsonb
  ) as r;

select cancel_booking(((select r from _b2) ->> 'booking_id')::uuid, 'client went elsewhere');

create temp table _p3 on commit drop as select pull_changes(0) as p;

select is(
  (select count(*)::int
     from jsonb_array_elements((select p from _p3) -> 'tables' -> 'stock_reservations') r
    where r ->> 'booking_id' = ((select r from _b2) ->> 'booking_id')
      and r ->> 'deleted_at' is not null),
  1, 'the cancelled booking''s claim arrives as a tombstone (D4)');
select is(
  (select r ->> 'status'
     from jsonb_array_elements((select p from _p3) -> 'tables' -> 'bookings') r
    where r ->> 'id' = ((select r from _b2) ->> 'booking_id')),
  'cancelled', 'while the booking row itself stays, cancelled');
select is(
  (select r ->> 'cancel_reason'
     from jsonb_array_elements((select p from _p3) -> 'tables' -> 'bookings') r
    where r ->> 'id' = ((select r from _b2) ->> 'booking_id')),
  'client went elsewhere', 'with the desk''s reason');
select ok(
  (select r ->> 'deleted_at' is null
     from jsonb_array_elements((select p from _p3) -> 'tables' -> 'bookings') r
    where r ->> 'id' = ((select r from _b2) ->> 'booking_id')),
  'a cancelled booking is not a deleted one — history reads the same on every phone');

-- ---------------------------------------------------------------------------
-- Tenancy: Kamran pulls, and sees none of Lumos                 [assert 36–40]
-- ---------------------------------------------------------------------------
set local role postgres;
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';   -- Kamran owner
set local role papa_app;

create temp table _pk on commit drop as select pull_changes(0) as p;

select is(jsonb_array_length((select p from _pk) -> 'tables' -> 'bookings'), 0,
  'org B sees no org A bookings through pull');
select is(jsonb_array_length((select p from _pk) -> 'tables' -> 'booking_lines'), 0,
  'nor its lines');
select is(jsonb_array_length((select p from _pk) -> 'tables' -> 'asset_reservations'), 0,
  'nor its unit reservations');
select is(jsonb_array_length((select p from _pk) -> 'tables' -> 'stock_reservations'), 0,
  'nor its bulk reservations');
select is(((select p from _pk) -> 'tables' -> 'stock_lots' -> 0 ->> 'qty_on_hand'), '3',
  'only its own shelf count');

select * from finish();
rollback;
