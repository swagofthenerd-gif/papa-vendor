-- ============================================================================
-- 0021 — The living fleet: service by usage, battery cycles, dead stock
--
-- Every property the migration claims, tested for the property it ACTUALLY
-- has (the 0007 rule). The load-bearing ones:
--
--   * the service meter is a PROJECTION: a check_in adds its rental's
--     calendar days — (in::date − out::date) + 1, partial day = full day,
--     same-day = 1 — derived from the job's own out/in pair; a rescan echo
--     and a loose check_in add NOTHING; `serviced` resets it to zero and
--     touches neither health nor presence;
--   * `serviced` is desk-gated at the RPC (warehouse and driver refused),
--     the log is a read over the events, and its cost link is validated —
--     a non-repair expense or another unit's repair is refused;
--   * cycles count only on flagged products, and crossing the ceiling
--     raises ONE open alert and changes NO state — presence, health and
--     disposition all hold (auto-quarantine was refused by design);
--   * dead_stock: old-idle in, new out, recently-rented out, terminal out,
--     unrentable out; the org's settings move the window; the value rides;
--   * a projection rebuild re-derives both counters from the log alone and
--     does not stack a duplicate alert;
--   * both views are org-scoped; the counters and config ride pull_changes;
--     both sync guards stay at zero.
-- ============================================================================
begin;
select plan(50);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos', '{}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran', '{}'::jsonb);

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif the driver'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (Kamran owner)');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver'),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack');

-- FX9: the service story (due after 100 rental days). V-Mount: the cycle
-- story (flagged, ceiling 2 so the test crosses it quickly). XLR: plain —
-- no thresholds, priced, the dead-stock cast. Komodo: org 2's mirror.
insert into products (id, org_id, category, display_name,
                      replacement_value_minor,
                      service_due_after_rental_days, count_cycles, retire_after_cycles) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'camera', 'Sony FX9', 350000000, 100, false, null),
  ('20000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   'power', 'V-Mount Battery 190Wh', 6000000, null, true, 2),
  ('20000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'cable', 'XLR Cable 5m', 800000, null, false, null),
  ('20000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'camera', 'RED Komodo', 250000000, 10, false, null);

-- The dead-stock cast: an old idler (in), a new arrival (out — its own
-- created_at protects it), an old unit rented recently (out), a terminal
-- one (out), an unrentable accessory (out). Org 2 gets one over-threshold,
-- long-idle unit so the cross-org checks have something real to not see.
insert into assets (id, org_id, product_id, asset_code, health, created_at) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-01', 'ok', now()),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000002', 'VM-01', 'ok', now()),
  ('30000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000003', 'XLR-OLD', 'ok', now() - interval '200 days'),
  ('30000000-0000-7000-8000-000000000004', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000003', 'XLR-NEW', 'ok', now()),
  ('30000000-0000-7000-8000-000000000005', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000003', 'XLR-RET', 'ok', now() - interval '200 days'),
  ('30000000-0000-7000-8000-000000000006', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000003', 'XLR-GONE', 'ok', now() - interval '200 days'),
  ('30000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   '20000000-0000-7000-8000-000000000009', 'KOM-01', 'ok', now() - interval '200 days');

insert into assets (id, org_id, product_id, asset_code, health, rentable, created_at) values
  ('30000000-0000-7000-8000-000000000007', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000003', 'XLR-ACC', 'ok', false, now() - interval '200 days');

update assets set presence = 'gone', disposition = 'lost'
 where id = '30000000-0000-7000-8000-000000000006';
-- Org 2's unit is over ITS threshold from the start — if org 1 ever sees a
-- service_due or dead_stock row for it, the isolation checks below fail.
update assets set rental_days_since_service = 999
 where id = '30000000-0000-7000-8000-000000000009';

insert into jobs (id, org_id, label) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'TVC — Ferozepur Road'),
  ('40000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', 'Wedding — DHA');

insert into devices (id, org_id, label) values
  ('WH-01', '11111111-1111-7111-8111-111111111111', 'Warehouse phone 1');

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Shape pins
-- ---------------------------------------------------------------------------
select has_column('products', 'service_due_after_rental_days');
select has_column('products', 'count_cycles');
select has_column('products', 'retire_after_cycles');
select has_column('assets', 'rental_days_since_service');
select has_column('assets', 'cycle_count');

select throws_ok(
  $$update assets set cycle_count = -1 where asset_code = 'XLR-NEW'$$,
  '23514', null,
  'the counters cannot go negative for any writer, superuser included');

-- ---------------------------------------------------------------------------
-- The service meter (D1): calendar days from the job's own out/in pair
-- ---------------------------------------------------------------------------
set local role papa_app;
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse

-- Out Monday-evening, in Wednesday-morning: three calendar days touched.
-- date_trunc anchors, so the arithmetic is deterministic whatever hour the
-- suite runs at.
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 1, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', (date_trunc('day', now() - interval '10 days') + interval '18 hours')::text)))),
  'accepted', 'the FX9 goes out, backdated ten days');

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 2, 'event_type', 'check_in',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', (date_trunc('day', now() - interval '8 days') + interval '9 hours')::text)))),
  'accepted', 'and comes home two mornings later');

select is(
  (select rental_days_since_service from assets where asset_code = 'FX9-01'),
  3, 'evening-out to third-morning-in is 3 calendar days — partial days count in full');

-- Out-and-back inside one day still wears the gear: 1 day, never 0.
select is(
  (select count(*)::int from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 3, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', '40000000-0000-7000-8000-000000000002',
       'device_time', (date_trunc('day', now() - interval '5 days') + interval '8 hours')::text),
     jsonb_build_object('client_seq', 4, 'event_type', 'check_in',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', '40000000-0000-7000-8000-000000000002',
       'device_time', (date_trunc('day', now() - interval '5 days') + interval '20 hours')::text)
   ) ) where outcome = 'accepted'),
  2, 'a same-day out-and-back rides one batch');

select is(
  (select rental_days_since_service from assets where asset_code = 'FX9-01'),
  4, 'the same-day rental adds exactly 1 — partial day = 1, never 0');

-- A rescan echo (the per-session dedupe dies with a process restart): the
-- second check_in finds no unconsumed check_out and adds NOTHING.
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 5, 'event_type', 'check_in',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', '40000000-0000-7000-8000-000000000002',
       'device_time', (date_trunc('day', now() - interval '5 days') + interval '21 hours')::text)))),
  'accepted', 'the echo check_in is recorded (append-only truth)');

select is(
  (select rental_days_since_service from assets where asset_code = 'FX9-01'),
  4, 'but it moves no meter — no unconsumed check_out, no days');

-- A loose check_in with no job has no pair to price.
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 6, 'event_type', 'check_in',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'device_time', (date_trunc('day', now() - interval '4 days') + interval '9 hours')::text)))),
  'accepted', 'a loose check_in is an ordinary event');

select is(
  (select rental_days_since_service from assets where asset_code = 'FX9-01'),
  4, 'and adds nothing — no job, no pair, no days');

-- ---------------------------------------------------------------------------
-- service_due (D1): threshold reached → in the view; null threshold → never
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from service_due),
  0, 'at 4 of 100 days nothing is due — and org 2''s over-threshold unit is invisible');

set local role postgres;
select fixture_rls_off();
update assets set rental_days_since_service = 120
 where asset_code = 'FX9-01';
update assets set rental_days_since_service = 999
 where asset_code = 'VM-01';
select fixture_rls_on();
set local role papa_app;

select results_eq(
  $$select asset_code, rental_days_since_service, due_after, over_by from service_due$$,
  $$values ('FX9-01', 120, 100, 20)$$,
  'over the threshold the FX9 appears, over_by said in days — and the V-Mount, 999 days into a NULL threshold, never does: no threshold, no nudge');

-- ---------------------------------------------------------------------------
-- `serviced` (D2): desk-gated, resets the meter, logs, touches nothing else
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 7, 'event_type', 'serviced',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'device_time', now()::text)))$$,
  '42501', null,
  'a warehouse phone cannot record a service — it is a desk decision, like money');

set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- driver
select throws_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 8, 'event_type', 'serviced',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'device_time', now()::text)))$$,
  '42501', null,
  'nor can a driver');

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 9, 'event_type', 'serviced',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'note', 'Annual service — Sharif Camera Works',
       'device_time', now()::text)))),
  'accepted', 'the desk records the service');

select results_eq(
  $$select rental_days_since_service, health, presence from assets where asset_code = 'FX9-01'$$,
  $$values (0, 'ok', 'here')$$,
  'the meter resets to zero and NOTHING else moves — serviced does not moonlight in the health vocabulary');

select is(
  (select count(*)::int from service_due),
  0, 'and the nudge stands down');

select results_eq(
  $$select asset_id, note, expense_id, actor_user_id from asset_service_log$$,
  $$values ('30000000-0000-7000-8000-000000000001'::uuid,
            'Annual service — Sharif Camera Works',
            null::uuid,
            'ffffffff-ffff-7fff-8fff-ffffffffffff'::uuid)$$,
  'the log is the event: asset, note, who — a read, not a second table');

-- The cost link. A real repair on this org's book links; a purchase or
-- another unit's repair is refused at the door.
set local papa.device_id = 'WH-01';
create temp table _exp (k text, id uuid);
grant select, insert on _exp to papa_app;

insert into _exp select 'rep', id from record_expense(
  'repair', 4500000, '30000000-0000-7000-8000-000000000001', null,
  'Sharif Camera Works', 'FX9 sensor clean + mount');
insert into _exp select 'pur', id from record_expense(
  'purchase', 1600000, null, null, 'Hall Road', 'XLR restock');
insert into _exp select 'vm', id from record_expense(
  'repair', 800000, '30000000-0000-7000-8000-000000000002', null,
  'Battery-wala', 'VM-01 cell swap');

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 10, 'event_type', 'serviced',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'note', 'Sensor clean',
       'payload', jsonb_build_object('expense_id',
         (select id from _exp where k = 'rep')),
       'device_time', now()::text)))),
  'accepted', 'a serviced event names the repair that paid for it');

select is(
  (select expense_id from asset_service_log where note = 'Sensor clean'),
  (select id from _exp where k = 'rep'),
  'and the log carries the link');

select throws_ok(
  format($f$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 11, 'event_type', 'serviced',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'payload', jsonb_build_object('expense_id', '%s'),
        'device_time', now()::text)))$f$,
    (select id from _exp where k = 'pur')),
  '23503', null,
  'a purchase cannot dress up as a service — the link must be kind=repair');

select throws_ok(
  format($f$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 12, 'event_type', 'serviced',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'payload', jsonb_build_object('expense_id', '%s'),
        'device_time', now()::text)))$f$,
    (select id from _exp where k = 'vm')),
  '23503', null,
  'nor can another unit''s repair — when the expense names an asset, it must be this one');

-- ---------------------------------------------------------------------------
-- Cycles (D3): flagged products count; the ceiling raises an ALERT, only
-- one while open, and changes NO state
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 13, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000002',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', (date_trunc('day', now() - interval '3 days') + interval '8 hours')::text)))),
  'accepted', 'the flagged battery goes out');

select is(
  (select cycle_count from assets where asset_code = 'VM-01'),
  1, 'one checkout, one cycle');

select is(
  (select count(*)::int from alerts where kind = 'cycle_threshold'),
  0, 'below the ceiling, no alert');

select is(
  (select count(*)::int from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 14, 'event_type', 'check_in',
       'asset_id', '30000000-0000-7000-8000-000000000002',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', (date_trunc('day', now() - interval '3 days') + interval '18 hours')::text),
     jsonb_build_object('client_seq', 15, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000002',
       'job_id', '40000000-0000-7000-8000-000000000002',
       'device_time', (date_trunc('day', now() - interval '2 days') + interval '8 hours')::text)
   ) ) where outcome = 'accepted'),
  2, 'home and out again — the second cycle');

select is(
  (select cycle_count from assets where asset_code = 'VM-01'),
  2, 'two cycles at the ceiling');

select results_eq(
  $$select count(*)::int, min(severity), min(owner_role)
      from alerts where kind = 'cycle_threshold' and resolved_at is null$$,
  $$values (1, 'warn', 'manager')$$,
  'crossing the ceiling raises exactly one open alert, for the manager');

select results_eq(
  $$select presence, health, disposition from assets where asset_code = 'VM-01'$$,
  $$values ('out', 'ok', null::text)$$,
  'and changes NO state — auto-quarantine was refused by design; the owner decides');

select is(
  (select count(*)::int from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 16, 'event_type', 'check_in',
       'asset_id', '30000000-0000-7000-8000-000000000002',
       'job_id', '40000000-0000-7000-8000-000000000002',
       'device_time', (date_trunc('day', now() - interval '2 days') + interval '18 hours')::text),
     jsonb_build_object('client_seq', 17, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000002',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', (date_trunc('day', now() - interval '1 days') + interval '8 hours')::text)
   ) ) where outcome = 'accepted'),
  2, 'a third loop runs');

select results_eq(
  $$select (select cycle_count from assets where asset_code = 'VM-01'),
           (select count(*)::int from alerts where kind = 'cycle_threshold' and resolved_at is null)$$,
  $$values (3, 1)$$,
  'the count keeps counting past the ceiling; the open alert does not stack');

-- The XLR's product is unflagged: its rental below moves no cycle count.
select is(
  (select count(*)::int from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 18, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000005',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', (date_trunc('day', now() - interval '10 days') + interval '10 hours')::text),
     jsonb_build_object('client_seq', 19, 'event_type', 'check_in',
       'asset_id', '30000000-0000-7000-8000-000000000005',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', (date_trunc('day', now() - interval '5 days') + interval '10 hours')::text)
   ) ) where outcome = 'accepted'),
  2, 'the old cable does one recent rental (the dead-stock alibi below)');

select is(
  (select cycle_count from assets where asset_code = 'XLR-RET'),
  0, 'an unflagged product counts no cycles — the flag is per-product opt-in');

-- ---------------------------------------------------------------------------
-- dead_stock (D4): membership edges, the value, the org's own window
-- ---------------------------------------------------------------------------
select results_eq(
  $$select asset_code, replacement_value_minor, last_rented_at is null, idle_days >= 200
      from dead_stock$$,
  $$values ('XLR-OLD', 800000::bigint, true, true)$$,
  'exactly the old idler is dead stock: never rented, owned 200 days, its value on the row — new, recently-rented, terminal, unrentable and org-2 units all excluded');

set local role postgres;
select fixture_rls_off();
update orgs set settings = '{"dead_stock_days": 3}'::jsonb
 where id = '11111111-1111-7111-8111-111111111111';
select fixture_rls_on();
set local role papa_app;

select results_eq(
  $$select asset_code from dead_stock order by asset_code$$,
  $$values ('FX9-01'), ('XLR-OLD'), ('XLR-RET')$$,
  'the window is the org''s own: at 3 days, the cable rented 10 days ago and the FX9 home since its same-day loop are idle too');

set local role postgres;
select fixture_rls_off();
update orgs set settings = '{}'::jsonb
 where id = '11111111-1111-7111-8111-111111111111';
select fixture_rls_on();
set local role papa_app;

-- ---------------------------------------------------------------------------
-- Rebuild: the log is the truth for both counters, and no duplicate alert
-- ---------------------------------------------------------------------------
set local role postgres;
select fixture_rls_off();
select rebuild_asset_projection('30000000-0000-7000-8000-000000000001');
select rebuild_asset_projection('30000000-0000-7000-8000-000000000002');
select is(
  (select rental_days_since_service from assets where asset_code = 'FX9-01'),
  0, 'a rebuild replays the pairs AND the serviced reset — the meter re-derives to zero');
select is(
  (select cycle_count from assets where asset_code = 'VM-01'),
  3, 'and the cycle count re-derives from the checkouts alone');
select is(
  (select count(*)::int from alerts
    where kind = 'cycle_threshold' and resolved_at is null),
  1, 'the rebuild does not stack a second open alert');
select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Cross-org: each org sees only its own fleet's health
-- ---------------------------------------------------------------------------
set local role papa_app;
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';

select results_eq(
  $$select asset_code from service_due$$,
  $$values ('KOM-01')$$,
  'org 2 sees its own overdue Komodo and none of Lumos''s fleet');

select results_eq(
  $$select asset_code from dead_stock$$,
  $$values ('KOM-01')$$,
  'and its own dead stock only');

select is(
  (select count(*)::int from asset_service_log),
  0, 'and none of Lumos''s service history');

-- ---------------------------------------------------------------------------
-- Sync: the config and the counters ride the pull; both guards stay at zero
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select ok(
  (select bool_and((r ? 'service_due_after_rental_days')
               and (r ? 'count_cycles')
               and (r ? 'retire_after_cycles'))
     from jsonb_array_elements((pull_changes(0) -> 'tables') -> 'products') r),
  'every synced product row carries the service and cycle config');

select ok(
  (select bool_and((r ? 'rental_days_since_service') and (r ? 'cycle_count'))
     from jsonb_array_elements((pull_changes(0) -> 'tables') -> 'assets') r),
  'and every synced asset row carries both counters — the phone draws the lines offline');

set local role postgres;
select is((select count(*)::int from sync_pii_violations()), 0,
  'the PII guard still finds nothing');
select is((select count(*)::int from sync_exclusion_violations()), 0,
  'and every reviewed exclusion is still projected out');

select * from finish();
rollback;
