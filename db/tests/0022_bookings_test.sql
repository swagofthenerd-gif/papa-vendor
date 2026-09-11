-- ============================================================================
-- 0022 — Bookings: every property the migration claims, tested for the
-- property it ACTUALLY has (the 0007 rule). The load-bearing ones:
--
--   * THE EXCLUSION CONSTRAINT: an overlapping confirmed claim on one
--     asset is refused — through the RPC (named "already promised to
--     booking #N") and at the raw constraint; ADJACENT windows ('[)')
--     touch legally, pinning the boundary semantics;
--   * pencils NEVER block — not each other, not a confirm — and an
--     expired pencil stops counting via the predicate alone, then gets
--     pruned to cancelled/pencil_expired by the next write RPC (no cron);
--   * confirm ALLOCATES: least-utilised units, demanded units are spoken
--     for before the auto-pick, pencil claims upgrade in place;
--     reallocation is an UPDATE the constraint re-checks;
--   * the credential gate refuses over-threshold strangers, a desk note
--     is not enough, a manager's note is logged on the booking;
--   * bulk availability is a PEAK, not a sum — two disjoint claims inside
--     the window count at their max simultaneous, not added; a shortage
--     at confirm refuses out loud, naming the count and the winner;
--   * extension returns the collision list as data: none extends,
--     partial names exactly the broken bookings (asset and bulk),
--     and a refused extension changes nothing;
--   * booking_no is gapless per org UNDER CONCURRENCY — proven with two
--     real connections in 0022_bookings_gapless_test.sql, its own file
--     because dblink deadlocks against fixture_rls_off()'s table locks;
--   * the job bridge: one live job per confirmed booking, label/contact/
--     expected_back carried over, cancel refused while the job is open;
--   * role gates both ways, cross-org invisibility both ways, and both
--     sync guards stay at zero.
-- ============================================================================
begin;
select plan(101);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos',
   '{"new_customer_value_threshold_minor": 100000000}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran', '{}'::jsonb);

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif the driver'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Auditor'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (Kamran owner)');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver'),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly'),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack');

insert into products (id, org_id, category, display_name, tracking_mode,
                      replacement_value_minor) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'camera', 'Sony FX9', 'serialized', 350000000),
  ('20000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'cable', 'XLR Cable 5m', 'bulk', 800000),
  ('20000000-0000-7000-8000-000000000004', '11111111-1111-7111-8111-111111111111',
   'case', 'Peli 1650', 'serialized', 500000),
  ('20000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'camera', 'RED Komodo', 'serialized', 250000000);

-- Five FX9 bodies with distinct meters, so the least-utilised pick is
-- deterministic: FX-B(1) < FX-A(5) < FX-D(7) < FX-C(10) < FX-E(20).
insert into assets (id, org_id, product_id, asset_code,
                    rental_days_since_service) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-A', 5),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-B', 1),
  ('30000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-C', 10),
  ('30000000-0000-7000-8000-000000000004', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-D', 7),
  ('30000000-0000-7000-8000-000000000005', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-E', 20),
  ('30000000-0000-7000-8000-000000000006', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000004', 'CASE-1', 0),
  ('30000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   '20000000-0000-7000-8000-000000000009', 'KMD-1', 0);

insert into stock_lots (id, org_id, product_id, location_id, qty_on_hand) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000003',
   '10000000-0000-7000-8000-000000000001', 10);

insert into customers (id, org_id, name, phone, blacklisted) values
  ('50000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'Rafi Productions', '03009998877', false),
  ('50000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   'Shady Trader', null, true),
  ('50000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'Zindagi Films', '03001234567', false),
  ('50000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'Kamran Client', null, false);

-- Zindagi Films is verified (guarantor on file): the gate leaves them alone.
insert into customer_credentials (org_id, customer_id, kind, guarantor_name,
                                  guarantor_phone, verified_by, verified_at)
values ('11111111-1111-7111-8111-111111111111',
        '50000000-0000-7000-8000-000000000003',
        'guarantor', 'Haji Saab', '03211112222',
        'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now());

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Schema and privilege shape                                    [assert 1–9]
-- ---------------------------------------------------------------------------
select has_table('bookings');
select has_table('booking_lines');
select has_table('asset_reservations');
select has_table('stock_reservations');
select has_table('booking_counters');

select is(
  (select count(*)::int from pg_class
    where relname in ('bookings', 'booking_lines', 'asset_reservations',
                      'stock_reservations', 'booking_counters')
      and relnamespace = 'public'::regnamespace
      and not (relrowsecurity and relforcerowsecurity)),
  0, 'RLS is enabled AND forced on all five booking tables');

select ok(
  (select bool_and(p.proconfig::text like '%search_path=public%')
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and p.proname in ('create_booking', 'confirm_booking', 'cancel_booking',
                        'extend_booking', 'convert_booking_to_job',
                        'reallocate_reservation')),
  'every booking DEFINER function pins search_path');

select ok(
  not has_table_privilege('papa_app', 'bookings', 'insert')
  and not has_table_privilege('papa_app', 'asset_reservations', 'insert')
  and not has_table_privilege('papa_app', 'stock_reservations', 'insert'),
  'papa_app cannot write the booking tables directly — the RPCs are the only door');

select ok(
  not has_table_privilege('papa_app', 'booking_counters', 'select'),
  'the counter is not even readable by the app role');

-- ---------------------------------------------------------------------------
-- create_booking                                              [assert 10–29]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
set local role papa_app;

-- B1: the kitchen-sink pencil — an auto-allocate ask, a demanded unit,
-- and a bulk line, over the first window (Apr 1–5).
select is(
  (create_booking(
     '50000000-0000-7000-8000-000000000003',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'),
     '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 2},
       {"asset_id": "30000000-0000-7000-8000-000000000003"},
       {"product_id": "20000000-0000-7000-8000-000000000003", "qty": 4}]'::jsonb
   ) ->> 'booking_no'),
  '1', 'the first booking takes number 1');

select is(
  (select b.status from bookings b where b.booking_no = 1), 'pencil',
  'and is born a pencil by default');

select ok(
  (select b.pencil_expires_at between now() + interval '23 hours 55 minutes'
                                  and now() + interval '24 hours 5 minutes'
     from bookings b where b.booking_no = 1),
  'the pencil dies in 24h by default (ASSUMPTION #hold-ttl)');

select is(
  (select lower(b.blocked_period) from bookings b where b.booking_no = 1),
  '2030-04-01 08:00+00'::timestamptz,
  'blocked_period opens 2h early — the prep buffer default (#buffer-defaults)');

select is(
  (select upper(b.blocked_period) from bookings b where b.booking_no = 1),
  '2030-04-05 14:00+00'::timestamptz,
  'and closes 4h late — the turnaround buffer default');

select is(
  (select count(*)::int from booking_lines l
    join bookings b on b.id = l.booking_id
   where b.booking_no = 1 and l.deleted_at is null),
  3, 'three lines recorded');

select is(
  (select r.state from asset_reservations r
    join bookings b on b.id = r.booking_id
   where b.booking_no = 1
     and r.asset_id = '30000000-0000-7000-8000-000000000003'
     and r.deleted_at is null),
  'pencil',
  'the demanded FX-C is claimed as a PENCIL — recorded, outside the constraint');

select is(
  (select r.qty from stock_reservations r
    join bookings b on b.id = r.booking_id
   where b.booking_no = 1 and r.deleted_at is null),
  4, 'the bulk ask is pencilled as quantity');

-- B2: a draft demands FX-B; drafts reserve nothing.
select is(
  (create_booking(
     '50000000-0000-7000-8000-000000000001',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'),
     '[{"asset_id": "30000000-0000-7000-8000-000000000002"}]'::jsonb,
     'draft') ->> 'booking_no'),
  '2', 'the second booking takes number 2 — no gaps');

select is(
  (select count(*)::int from asset_reservations r
    join bookings b on b.id = r.booking_id
   where b.booking_no = 2 and r.deleted_at is null),
  0, 'a draft holds nothing — not even a pencil claim');

-- B3: a pencil with a custom 2h TTL. Materialized first: BETWEEN expands
-- by duplicating its operand, which would run the volatile RPC twice and
-- silently mint a phantom booking.
create temp table _b3 on commit drop as
  select create_booking(
      '50000000-0000-7000-8000-000000000001',
      tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'),
      '[{"product_id": "20000000-0000-7000-8000-000000000003", "qty": 2}]'::jsonb,
      'pencil', null, interval '2 hours') as r;

select ok(
  ((select r ->> 'pencil_expires_at' from _b3)::timestamptz
      between now() + interval '115 minutes' and now() + interval '125 minutes'),
  'a caller-supplied TTL is respected (booking 3)');

-- B4: the blacklisted customer CAN pencil (a conversation is not a promise).
select is(
  (create_booking(
     '50000000-0000-7000-8000-000000000002',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'),
     '[{"product_id": "20000000-0000-7000-8000-000000000003", "qty": 1}]'::jsonb
   ) ->> 'booking_no'),
  '4', 'a blacklisted customer can still be pencilled — refusal lands at confirm');

-- B5: a stranger asks for one FX9 (over the credential threshold).
select is(
  (create_booking(
     '50000000-0000-7000-8000-000000000001',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'),
     '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
   ) ->> 'booking_no'),
  '5', 'booking 5 created');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select create_booking('50000000-0000-7000-8000-000000000001',
      tstzrange('2030-06-01', '2030-06-02', '[)'),
      '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb)$$,
  '42501', null, 'the warehouse cannot create bookings');

set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- driver
select throws_ok(
  $$select create_booking('50000000-0000-7000-8000-000000000001',
      tstzrange('2030-06-01', '2030-06-02', '[)'),
      '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb)$$,
  '42501', null, 'nor can a driver');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select throws_ok(
  $$select create_booking('50000000-0000-7000-8000-000000000001',
      tstzrange('2030-06-01', '2030-06-02', '[)'),
      '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb)$$,
  '42501', null, 'nor can readonly');

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk again

select throws_like(
  $$select create_booking('50000000-0000-7000-8000-000000000009',
      tstzrange('2030-06-01', '2030-06-02', '[)'),
      '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb)$$,
  '%does not belong to this org%',
  'another org''s customer is refused');

select throws_like(
  $$select create_booking('50000000-0000-7000-8000-000000000001',
      tstzrange('2030-06-01', '2030-06-02', '[)'),
      '[]'::jsonb)$$,
  '%at least one line%',
  'an empty booking is refused');

select throws_like(
  $$select create_booking('50000000-0000-7000-8000-000000000001',
      tstzrange('2030-06-01', '2030-06-02', '[)'),
      '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb,
      'confirmed')$$,
  '%confirm_booking%',
  'a booking cannot be born confirmed — allocation lives in confirm_booking');

select throws_like(
  $$select create_booking('50000000-0000-7000-8000-000000000001',
      tstzrange('2030-06-01', '2030-06-02', '[)'),
      '[{"qty": 3}]'::jsonb)$$,
  '%must name a product_id or an asset_id%',
  'a line naming neither shape is refused');

-- ---------------------------------------------------------------------------
-- Three-layer availability, before anything is confirmed     [assert 30–34]
-- ---------------------------------------------------------------------------
select is(
  (select here_now from booking_availability(
     '20000000-0000-7000-8000-000000000001',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'))),
  5, 'five FX9 bodies are here now');

select is(
  (select pencilled_overlap from booking_availability(
     '20000000-0000-7000-8000-000000000001',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'))),
  4, 'the pencil layer counts B1''s 2+1 and B5''s 1 — informational only');

select is(
  (select available from booking_availability(
     '20000000-0000-7000-8000-000000000001',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'))),
  5, 'pencils subtract NOTHING: all five still available');

select is(
  (select here_now from booking_availability(
     '20000000-0000-7000-8000-000000000003',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'))),
  10, 'ten XLR on the shelf');

select is(
  (select pencilled_overlap from booking_availability(
     '20000000-0000-7000-8000-000000000003',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'))),
  7, 'bulk pencil layer: B1''s 4 + B3''s 2 + B4''s 1 overlap simultaneously');

-- ---------------------------------------------------------------------------
-- confirm_booking: blacklist, the credential gate, allocation [assert 35–46]
-- ---------------------------------------------------------------------------
select throws_like(
  $$select confirm_booking((select id from bookings where booking_no = 4))$$,
  '%blacklisted%',
  'confirming for a blacklisted customer is refused outright');

select throws_like(
  $$select confirm_booking((select id from bookings where booking_no = 5))$$,
  '%needs credentials%',
  'a stranger over the threshold is refused without paperwork (override 16)');

select throws_ok(
  $$select confirm_booking((select id from bookings where booking_no = 5),
                           null, 'seemed nice enough')$$,
  '42501', null,
  'a desk note is NOT enough — the override is a manager''s act');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner

select is(
  (confirm_booking((select id from bookings where booking_no = 5),
                   null, 'Rafi vouched for by Haji Saab; cheque held')
     ->> 'status'),
  'confirmed', 'the owner''s logged override confirms booking 5');

select is(
  (select b.credential_override_by from bookings b where b.booking_no = 5),
  'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb'::uuid,
  'the override records WHO — the paper trail override 16 demands');

select is(
  (select a.asset_code from asset_reservations r
    join assets a on a.id = r.asset_id
    join bookings b on b.id = r.booking_id
   where b.booking_no = 5 and r.deleted_at is null),
  'FX-B',
  'allocation picked the least-utilised body (override 3)');

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

-- B1 (Zindagi, verified): the gate stays out of the way; allocation must
-- respect both the demanded FX-C and the already-promised FX-B.
select is(
  (confirm_booking((select id from bookings where booking_no = 1)) ->> 'status'),
  'confirmed', 'a verified customer confirms without ceremony');

select is(
  (select array_agg(a.asset_code order by a.asset_code)
     from asset_reservations r
     join assets a on a.id = r.asset_id
     join bookings b on b.id = r.booking_id
    where b.booking_no = 1 and r.deleted_at is null and r.state = 'confirmed'),
  array['FX-A', 'FX-C', 'FX-D'],
  'auto-pick took FX-A and FX-D (next least-utilised; FX-B promised, FX-C demanded here)');

select is(
  (select count(*)::int from asset_reservations r
    join bookings b on b.id = r.booking_id
   where b.booking_no = 1
     and r.asset_id = '30000000-0000-7000-8000-000000000003'
     and r.deleted_at is null),
  1, 'the FX-C pencil upgraded IN PLACE — no duplicate row');

select is(
  (select r.state from stock_reservations r
    join bookings b on b.id = r.booking_id
   where b.booking_no = 1 and r.deleted_at is null),
  'confirmed', 'the bulk pencil upgraded to a confirmed quantity');

select is(
  (select b.pencil_expires_at from bookings b where b.booking_no = 1),
  null, 'a confirmed booking no longer carries a pencil expiry');

select throws_like(
  $$select confirm_booking((select id from bookings where booking_no = 1))$$,
  '%already confirmed%',
  'confirming twice is refused');

-- ---------------------------------------------------------------------------
-- THE EXCLUSION PROOF                                         [assert 47–52]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner

select throws_like(
  $$select confirm_booking((select id from bookings where booking_no = 2),
                           null, 'override for the exclusion test')$$,
  '%already promised to booking #5%',
  'THE constraint, named: FX-B overlapping is refused with the winning booking number');

-- Adjacent is legal: B6 wants FX-B starting the very instant B5's blocked
-- window closes (Apr 5 14:00). '[)' semantics — touching, not overlapping.
select lives_ok(
  $$select confirm_booking(
      (select (create_booking('50000000-0000-7000-8000-000000000003',
         tstzrange('2030-04-05 16:00+00', '2030-04-06 16:00+00', '[)'),
         '[{"asset_id": "30000000-0000-7000-8000-000000000002"}]'::jsonb)
        ->> 'booking_id'))::uuid)$$,
  'back-to-back on the boundary instant is allowed — [) semantics pinned (booking 6)');

-- A pencil is never blocked BY a confirmed claim either: FX-A is promised
-- to booking 1, and pencilling it anyway is fine…
select is(
  (create_booking(
     '50000000-0000-7000-8000-000000000003',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'),
     '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb
   ) ->> 'booking_no'),
  '7', 'a pencil freely claims an already-promised unit (booking 7)');

-- …but first-to-confirm won: promoting that pencil names the winner.
select throws_like(
  $$select confirm_booking((select id from bookings where booking_no = 7))$$,
  '%already promised to booking #1%',
  'promoting the losing pencil is refused, naming booking 1');

set local role postgres;
select throws_ok(
  $$insert into asset_reservations
      (org_id, booking_id, booking_line_id, asset_id, blocked_period, state)
    select '11111111-1111-7111-8111-111111111111', b.id, l.id,
           '30000000-0000-7000-8000-000000000002',
           tstzrange('2030-04-02 00:00+00', '2030-04-03 00:00+00', '[)'),
           'confirmed'
      from bookings b join booking_lines l on l.booking_id = b.id
     where b.booking_no = 2$$,
  '23P01', null,
  'the raw constraint refuses an overlapping confirmed claim even from a superuser');
set local role papa_app;

select throws_ok(
  $$insert into asset_reservations
      (org_id, booking_id, booking_line_id, asset_id, blocked_period, state)
    select '11111111-1111-7111-8111-111111111111', b.id, l.id,
           '30000000-0000-7000-8000-000000000005',
           tstzrange('2031-01-01', '2031-01-02', '[)'), 'confirmed'
      from bookings b join booking_lines l on l.booking_id = b.id
     where b.booking_no = 2$$,
  '42501', null,
  'papa_app cannot insert reservations at all — the RPC door holds');

-- ---------------------------------------------------------------------------
-- Pencil expiry: predicate first, prune second                [assert 53–58]
-- ---------------------------------------------------------------------------
set local role postgres;
update bookings set pencil_expires_at = now() - interval '1 hour'
 where booking_no = 3;
set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

select is(
  (select pencilled_overlap from booking_availability(
     '20000000-0000-7000-8000-000000000003',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'))),
  1, 'the expired pencil vanished from the pencil layer BY PREDICATE — only B4''s 1 remains');

select is(
  (select b.status from bookings b where b.booking_no = 3), 'pencil',
  '…while the row itself still says pencil: no cron ran, none is needed');

-- The prune must ride a write RPC that SUCCEEDS: throws_* runs in a
-- savepoint, so a refused confirm takes its own prune down with it.
-- Extending the draft is a convenient no-op door.
select is(
  (extend_booking((select id from bookings where booking_no = 2),
                  '2030-04-05 12:00+00'::timestamptz) ->> 'extended'),
  'true', 'any passing write RPC walks past and prunes the stale pencil');

select throws_like(
  $$select confirm_booking((select id from bookings where booking_no = 3))$$,
  '%cancelled (pencil_expired)%',
  'and the tombstone answers the next confirm with the reason');

select is(
  (select b.status || '/' || b.cancel_reason from bookings b
    where b.booking_no = 3),
  'cancelled/pencil_expired',
  'the prune left an honest tombstone');

select is(
  (select count(*)::int from stock_reservations r
    join bookings b on b.id = r.booking_id
   where b.booking_no = 3 and r.deleted_at is null),
  0, 'and released the expired pencil''s bulk claim');

-- ---------------------------------------------------------------------------
-- Reallocation is an UPDATE the constraint re-checks          [assert 59–62]
-- ---------------------------------------------------------------------------
select lives_ok(
  $$select reallocate_reservation(
      (select r.id from asset_reservations r
        join bookings b on b.id = r.booking_id
       where b.booking_no = 5 and r.deleted_at is null),
      '30000000-0000-7000-8000-000000000005')$$,
  'the desk swaps booking 5 from FX-B to the free FX-E');

select is(
  (select a.asset_code from asset_reservations r
    join assets a on a.id = r.asset_id
    join bookings b on b.id = r.booking_id
   where b.booking_no = 5 and r.deleted_at is null),
  'FX-E', 'the reservation row was UPDATED, not replaced');

select throws_like(
  $$select reallocate_reservation(
      (select r.id from asset_reservations r
        join bookings b on b.id = r.booking_id
       where b.booking_no = 5 and r.deleted_at is null),
      '30000000-0000-7000-8000-000000000001')$$,
  '%already promised to booking #1%',
  'swapping onto a promised unit is refused by the same constraint, named');

select throws_like(
  $$select reallocate_reservation(
      (select r.id from asset_reservations r
        join bookings b on b.id = r.booking_id
       where b.booking_no = 5 and r.deleted_at is null),
      '30000000-0000-7000-8000-000000000006')$$,
  '%same product%',
  'a case is not a camera: cross-product substitution is refused');

-- ---------------------------------------------------------------------------
-- Extension: the collision list is the product               [assert 63–75]
-- ---------------------------------------------------------------------------
-- Downstream traffic: B8 takes FX-A Apr 7–9, B9 takes FX-C Apr 8–10,
-- B10 takes 8 XLR Apr 7–9. All Zindagi (verified — no gate ceremony).
select lives_ok(
  $$select confirm_booking(
      (select (create_booking('50000000-0000-7000-8000-000000000003',
         tstzrange('2030-04-07 10:00+00', '2030-04-09 10:00+00', '[)'),
         '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb)
        ->> 'booking_id'))::uuid)$$,
  'booking 8: FX-A promised downstream, Apr 7–9');

select lives_ok(
  $$select confirm_booking(
      (select (create_booking('50000000-0000-7000-8000-000000000003',
         tstzrange('2030-04-08 10:00+00', '2030-04-10 10:00+00', '[)'),
         '[{"asset_id": "30000000-0000-7000-8000-000000000003"}]'::jsonb)
        ->> 'booking_id'))::uuid)$$,
  'booking 9: FX-C promised downstream, Apr 8–10');

select lives_ok(
  $$select confirm_booking(
      (select (create_booking('50000000-0000-7000-8000-000000000003',
         tstzrange('2030-04-07 10:00+00', '2030-04-09 10:00+00', '[)'),
         '[{"product_id": "20000000-0000-7000-8000-000000000003", "qty": 8}]'::jsonb)
        ->> 'booking_id'))::uuid)$$,
  'booking 10: 8 of 10 XLR promised downstream, Apr 7–9');

-- No collision: booking 5 (FX-E) has no downstream rival.
create temp table _ext1 on commit drop as
  select extend_booking(
    (select id from bookings where booking_no = 5),
    '2030-04-06 10:00+00'::timestamptz) as r;

select is((select r ->> 'extended' from _ext1), 'true',
  'no downstream rival: booking 5 extends cleanly');

select is(
  (select upper(b.customer_period) from bookings b where b.booking_no = 5),
  '2030-04-06 10:00+00'::timestamptz,
  'the customer period moved');

select is(
  (select upper(r.blocked_period) from asset_reservations r
    join bookings b on b.id = r.booking_id
   where b.booking_no = 5 and r.deleted_at is null),
  '2030-04-06 14:00+00'::timestamptz,
  'and the reservation moved with it, buffer tail preserved');

-- Partial collision: extending booking 1 to Apr 7 noon crosses B8 (FX-A
-- from Apr 7 08:00 blocked) and starves B10 (8 XLR vs our 4 of 10) — but
-- NOT B9, whose FX-C window only opens Apr 8 08:00.
create temp table _ext2 on commit drop as
  select extend_booking(
    (select id from bookings where booking_no = 1),
    '2030-04-07 12:00+00'::timestamptz) as r;

select is((select r ->> 'extended' from _ext2), 'false',
  'the collision case REFUSES and reports instead');

select is(
  (select count(*)::int from _ext2,
          jsonb_array_elements(r -> 'collisions')),
  2, 'exactly two broken promises reported — the partial case');

select ok(
  (select exists (
     select 1 from _ext2, jsonb_array_elements(r -> 'collisions') c
      where c ->> 'kind' = 'asset'
        and (c ->> 'booking_no')::bigint = 8
        and c ->> 'asset_code' = 'FX-A'
        and c ->> 'customer_name' = 'Zindagi Films')),
  'the asset collision names the booking, the unit and the customer to call');

select ok(
  (select exists (
     select 1 from _ext2, jsonb_array_elements(r -> 'collisions') c
      where c ->> 'kind' = 'bulk'
        and (c ->> 'booking_no')::bigint = 10
        and c ->> 'product_name' = 'XLR Cable 5m')),
  'the bulk shortfall names the starved rival');

select is(
  (select upper(b.customer_period) from bookings b where b.booking_no = 1),
  '2030-04-05 10:00+00'::timestamptz,
  'a refused extension changes NOTHING');

-- All three break when pushed past Apr 8: the multiple case.
select is(
  (select count(*)::int from
     jsonb_array_elements(
       extend_booking((select id from bookings where booking_no = 1),
                      '2030-04-09 12:00+00'::timestamptz) -> 'collisions')),
  3, 'pushed further, all three downstream bookings appear');

-- And a modest extension to Apr 6 clears everything.
select is(
  (extend_booking((select id from bookings where booking_no = 1),
                  '2030-04-06 10:00+00'::timestamptz) ->> 'extended'),
  'true', 'a modest extension that breaks nobody just works');

-- ---------------------------------------------------------------------------
-- Availability again: peaks, not sums                         [assert 76–81]
-- ---------------------------------------------------------------------------
select is(
  (select confirmed_overlap from booking_availability(
     '20000000-0000-7000-8000-000000000001',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'))),
  4, 'four bodies promised over the original window (B1: A,C,D + B5: E)');

select is(
  (select available from booking_availability(
     '20000000-0000-7000-8000-000000000001',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'))),
  1, 'one FX9 left to promise for that window');

select is(
  (select confirmed_overlap from booking_availability(
     '20000000-0000-7000-8000-000000000003',
     tstzrange('2030-04-01 10:00+00', '2030-04-09 10:00+00', '[)'))),
  8, 'bulk overlap is the PEAK: 4 (Apr 1–6) and 8 (Apr 7–9) never coincide, so 8 — not 12');

select is(
  (select available from booking_availability(
     '20000000-0000-7000-8000-000000000003',
     tstzrange('2030-04-01 10:00+00', '2030-04-09 10:00+00', '[)'))),
  2, 'so two cables stay promisable across the whole stretch');

-- ---------------------------------------------------------------------------
-- Shortage refusals at confirm — the math is spoken out loud
--
-- throws_* runs inside a savepoint, so the create_booking nested in each
-- statement rolls back with the refused confirm: the numbering stream and
-- the booking count downstream see nothing (the gapless property, used).
-- ---------------------------------------------------------------------------
-- Apr 1–5 has exactly one free FX9 left (FX-B; A/C/D ride booking 1, E
-- rides booking 5). Asking for two states the honest count.
select throws_like(
  $$select confirm_booking(
      (select (create_booking('50000000-0000-7000-8000-000000000003',
         tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'),
         '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 2}]'::jsonb)
        ->> 'booking_id'))::uuid)$$,
  '%only 1 of 2 × Sony FX9 available for this window%',
  'a serialized shortage refuses with the honest count');

-- Apr 7–9 has 8 of 10 XLR promised to booking 10; asking for three names
-- the count AND the booking sitting on the stock.
select throws_like(
  $$select confirm_booking(
      (select (create_booking('50000000-0000-7000-8000-000000000003',
         tstzrange('2030-04-07 10:00+00', '2030-04-09 10:00+00', '[)'),
         '[{"product_id": "20000000-0000-7000-8000-000000000003", "qty": 3}]'::jsonb)
        ->> 'booking_id'))::uuid)$$,
  '%only 2 of 3 × XLR Cable 5m available for this window; 8 already promised (booking #10)%',
  'a bulk shortage names the count and the winning booking');

-- ---------------------------------------------------------------------------
-- The job bridge                                              [assert 82–90]
-- ---------------------------------------------------------------------------
create temp table _job1 on commit drop as
  select convert_booking_to_job(
    (select id from bookings where booking_no = 1)) as job_id;

select is(
  (select j.label from jobs j where j.id = (select job_id from _job1)),
  'B#1 — Zindagi Films',
  'the job says which promise it fulfils');

select is(
  (select j.expected_back from jobs j where j.id = (select job_id from _job1)),
  '2030-04-06'::date,
  'expected_back carries the (extended) customer end date');

select is(
  (select j.customer_id from jobs j where j.id = (select job_id from _job1)),
  '50000000-0000-7000-8000-000000000003'::uuid,
  'and the customer rides along for the boards');

select throws_like(
  $$select convert_booking_to_job(
      (select id from bookings where booking_no = 1))$$,
  '%already has its job%',
  'one live job per booking');

select throws_like(
  $$select convert_booking_to_job(
      (select id from bookings where booking_no = 4))$$,
  '%only a confirmed booking%',
  'a pencil does not become a job');

select throws_like(
  $$select cancel_booking((select id from bookings where booking_no = 1))$$,
  '%out on job%',
  'cancel is refused while the job is live — the scan world owns the story now');

set local role postgres;
update jobs set status = 'closed', closed_at = now()
 where id = (select job_id from _job1);
set local role papa_app;

select lives_ok(
  $$select cancel_booking((select id from bookings where booking_no = 1),
                          'wrapped early')$$,
  'once the job closes, the booking can be cancelled');

select is(
  (select count(*)::int
     from (select 1 from asset_reservations r
            join bookings b on b.id = r.booking_id
           where b.booking_no = 1 and r.deleted_at is null
           union all
           select 1 from stock_reservations r
            join bookings b on b.id = r.booking_id
           where b.booking_no = 1 and r.deleted_at is null) live),
  0, 'cancellation released every live reservation');

select throws_like(
  $$select cancel_booking((select id from bookings where booking_no = 1))$$,
  '%already cancelled%',
  'cancelling twice is refused');

-- ---------------------------------------------------------------------------
-- Role gates on the rest of the doors                         [assert 91–94]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse

select throws_ok(
  $$select confirm_booking((select id from bookings where booking_no = 4))$$,
  '42501', null, 'warehouse cannot confirm');
select throws_ok(
  $$select cancel_booking((select id from bookings where booking_no = 4))$$,
  '42501', null, 'warehouse cannot cancel');
select throws_ok(
  $$select extend_booking((select id from bookings where booking_no = 5),
                          '2030-04-08 10:00+00'::timestamptz)$$,
  '42501', null, 'warehouse cannot extend');
select throws_ok(
  $$select convert_booking_to_job(
      (select id from bookings where booking_no = 5))$$,
  '42501', null, 'warehouse cannot convert');

-- ---------------------------------------------------------------------------
-- Cross-org, both directions                                  [assert 95–99]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';   -- Rana

select is(
  (select count(*)::int from bookings), 0,
  'Kamran''s owner sees none of Lumos''s ten bookings');

select is(
  (create_booking(
     '50000000-0000-7000-8000-000000000009',
     tstzrange('2030-04-01 10:00+00', '2030-04-05 10:00+00', '[)'),
     '[{"asset_id": "30000000-0000-7000-8000-000000000009"}]'::jsonb
   ) ->> 'booking_no'),
  '1', 'Kamran''s first booking is THEIR number 1 — counters are per org');

select throws_like(
  $$select confirm_booking(
      (select id from bookings where booking_no = 1
        and org_id = '11111111-1111-7111-8111-111111111111'))$$,
  '%does not belong to this org%',
  'confirming a foreign booking id is refused (null lookup under the org predicate)');

select throws_like(
  $$select create_booking('50000000-0000-7000-8000-000000000009',
      tstzrange('2030-06-01', '2030-06-02', '[)'),
      '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb)$$,
  '%does not belong to this org%',
  'a foreign asset in a line is refused');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

select is(
  (select count(*)::int from bookings b
    where b.org_id = '22222222-2222-7222-8222-222222222222'),
  0, 'and Lumos cannot see Kamran''s booking either');

-- ---------------------------------------------------------------------------
-- The sync guards stay at zero                                [assert 100–101]
-- ---------------------------------------------------------------------------
set local role postgres;

select is((select count(*)::int from sync_pii_violations()), 0,
  'no PII column has become syncable');
select is((select count(*)::int from sync_exclusion_violations()), 0,
  'every registered column exclusion still holds');

select * from finish();
rollback;
