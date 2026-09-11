-- ============================================================================
-- 0025 — The network: every property the migration claims, tested for the
-- property it ACTUALLY has (the 0007 rule).
--
--   * three new tables, RLS on and forced, papa_app SELECT only; every
--     DEFINER function pins search_path; the disposition CHECK accepts
--     returned_to_owner and nothing made up;
--   * partner CRUD: owner|manager only, unique per (org, lower(name)),
--     city defaults to Lahore, edit keeps what it is not given, remove is
--     refused while a sub-hire is open, non-money roles see no partners;
--   * sub-hire IN: the borrowed unit joins the fleet as sub_rented_in with
--     its intake event on the server device; the expense is created
--     atomically (kind sub_hire, counterparty = partner name) and
--     job_margin / booking_sub_hire_cost see it; unpriced writes no money
--     row; a duplicate serial, a serial on a bulk product, a foreign
--     partner, qty 0 and an empty period are refused;
--   * close IN: refused while the unit is out; then gone +
--     returned_to_owner via a retire event; never twice, never in the
--     future, never before the period;
--   * sub-hire OUT: a job labelled 'Sub-hire → <partner>', the partner
--     found-or-created as a customer (is_partner), the ledger charge on
--     that job, the balance; the desk scans the unit out normally; close
--     refused while gear projects onto the job, then the job closes; a
--     borrowed unit cannot be lent on;
--   * crew: assign/unassign gates, member check, role vocabulary, the
--     names in the pull projection, the job's change_seq bumping;
--   * stolen broadcast: refused unless stolen; the facts; the URL from
--     the org setting; cross-org refusal;
--   * quote flags: full → refuse → standard, unknown refused, stricter
--     under a non-money role;
--   * cross-org invisibility and refusals for every door; both sync guards
--     at zero; the '%phone%' pattern WOULD catch partner_houses.phone.
-- ============================================================================
begin;
select plan(94);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos',
   '{"public_phone": "0300-1234567"}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran', '{}'::jsonb);

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Chacha the driver'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Auditor'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk'),
  ('99999999-9999-7999-8999-999999999999', 'Sana the manager'),
  ('77777777-7777-7777-8777-777777777777', 'A stranger'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (Kamran owner)');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver'),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly'),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('11111111-1111-7111-8111-111111111111', '99999999-9999-7999-8999-999999999999', 'manager'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack');

insert into products (id, org_id, category, display_name, tracking_mode,
                      replacement_value_minor) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'camera', 'Sony FX9', 'serialized', 350000000),
  ('20000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'cable', 'XLR Cable 5m', 'bulk', 800000),
  ('20000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'camera', 'RED Komodo', 'serialized', 250000000);

insert into assets (id, org_id, product_id, asset_code, serial_number) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-A', 'SN-FXA'),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-B', 'SN-FXB'),
  ('30000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   '20000000-0000-7000-8000-000000000009', 'KMD-1', null);

insert into asset_tags (org_id, tag_code, asset_id, status, bound_at) values
  ('11111111-1111-7111-8111-111111111111', 'TAGFXB',
   '30000000-0000-7000-8000-000000000002', 'active', now());

insert into customers (id, org_id, name, phone) values
  ('50000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'Zindagi Films', '03001234567'),
  ('50000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'Kamran Client', null);

-- The job the borrowed body rescues (Rafi shoot) and one that never ran.
insert into jobs (id, org_id, label, status) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'Rafi shoot', 'open'),
  ('40000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   'Never happened', 'cancelled'),
  ('40000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'Kamran job', 'open');

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Schema and privilege shape                                    [assert 1–9]
-- ---------------------------------------------------------------------------
select has_table('partner_houses');
select has_table('sub_hires');
select has_table('job_attendants');

select is(
  (select count(*)::int from pg_class
    where relname in ('partner_houses', 'sub_hires', 'job_attendants')
      and relnamespace = 'public'::regnamespace
      and not (relrowsecurity and relforcerowsecurity)),
  0, 'RLS is enabled AND forced on all three network tables');

select ok(
  not has_table_privilege('papa_app', 'partner_houses', 'insert')
  and not has_table_privilege('papa_app', 'partner_houses', 'update')
  and not has_table_privilege('papa_app', 'sub_hires', 'insert')
  and not has_table_privilege('papa_app', 'sub_hires', 'update')
  and not has_table_privilege('papa_app', 'job_attendants', 'insert')
  and not has_table_privilege('papa_app', 'job_attendants', 'delete'),
  'papa_app cannot write the network tables directly — the RPCs are the only door');

select has_column('customers', 'is_partner');

select ok(
  (select bool_and(p.proconfig::text like '%search_path=public%')
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and p.proname in ('upsert_partner_house', 'remove_partner_house',
                        'record_sub_hire_in', 'record_sub_hire_out',
                        'close_sub_hire', 'assign_attendant',
                        'unassign_attendant', 'sub_hires_check_org',
                        'job_attendants_check_org', 'apply_scan_event')),
  'every 0025 DEFINER function pins search_path');

select throws_ok(
  $$update assets set presence = 'gone', disposition = 'went_home'
     where id = '30000000-0000-7000-8000-000000000001'$$,
  '23514', null, 'the disposition CHECK still refuses a made-up value');
select lives_ok(
  $$update assets set presence = 'gone', disposition = 'returned_to_owner'
     where id = '30000000-0000-7000-8000-000000000001'$$,
  'and accepts returned_to_owner (0025 D5)');
update assets set presence = 'here', disposition = null
 where id = '30000000-0000-7000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Partner CRUD (D1)                                           [assert 10–20]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
set local role papa_app;

select throws_ok(
  $$select upsert_partner_house('Kamran Rentals')$$,
  '42501', null, 'the desk cannot add a partner house — owner|manager only');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select upsert_partner_house('Kamran Rentals')$$,
  '42501', null, 'nor can the warehouse');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
create temp table _p (k text primary key, id uuid) on commit drop;
insert into _p select 'kamran', (upsert_partner_house(
  'Kamran Rentals', null, '03211234567', null, null, 'Hall Road, two FX9 bodies') ->> 'id')::uuid;

select is(
  (select p.city from partner_houses p where p.id = (select id from _p where k = 'kamran')),
  'Lahore', 'the owner adds a partner; city defaults to Lahore');

set local papa.user_id = '99999999-9999-7999-8999-999999999999';   -- manager
insert into _p select 'zindagi', (upsert_partner_house(
  'Zindagi Films', null, '03009998877', null, 'Karachi') ->> 'id')::uuid;

select is(
  (select p.city from partner_houses p where p.id = (select id from _p where k = 'zindagi')),
  'Karachi', 'a manager adds one too, with its own city');

select throws_ok(
  $$select upsert_partner_house('kamran rentals')$$,
  '23505', null, 'the same name in another case is the same partner — refused');

select throws_like(
  $$select upsert_partner_house('   ')$$,
  '%needs a name%', 'a blank name is refused');

select is(
  (upsert_partner_house('Kamran Rentals', (select id from _p where k = 'kamran'),
                        null, 'WA group: Lahore Camera Houses') ->> 'phone'),
  '03211234567', 'an edit with a null phone keeps the phone');
select is(
  (select p.whatsapp_group_note from partner_houses p
    where p.id = (select id from _p where k = 'kamran')),
  'WA group: Lahore Camera Houses', 'and sets what it was given');

insert into _p select 'temp', (upsert_partner_house('Temp House') ->> 'id')::uuid;
select is(
  (remove_partner_house((select id from _p where k = 'temp')) ->> 'deleted_at') is not null,
  true, 'remove soft-deletes');
select is(
  (select count(*)::int from partner_houses p
    where p.id = (select id from _p where k = 'temp') and p.deleted_at is null),
  0, 'and the partner is off the live list');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select is((select count(*)::int from partner_houses), 0,
  'the warehouse sees no partner houses — a partner''s phone is PII (D1)');

-- ---------------------------------------------------------------------------
-- Sub-hire IN (D2, D5, D6)                                    [assert 21–37]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

select throws_like(
  $$select record_sub_hire_in('00000000-0000-7000-8000-000000000000',
      '20000000-0000-7000-8000-000000000001',
      tstzrange(now() - interval '1 hour', now() + interval '2 days', '[)'))$$,
  '%does not belong to this org%', 'an unknown partner is refused');

select throws_like(
  $$select record_sub_hire_in((select id from _p where k = 'kamran'),
      '20000000-0000-7000-8000-000000000001',
      tstzrange(now() - interval '1 hour', now() + interval '2 days', '[)'), 0)$$,
  '%at least one unit%', 'qty 0 is refused');

select throws_like(
  $$select record_sub_hire_in((select id from _p where k = 'kamran'),
      '20000000-0000-7000-8000-000000000001', 'empty'::tstzrange)$$,
  '%needs a period%', 'an empty period is refused');

select throws_like(
  $$select record_sub_hire_in((select id from _p where k = 'kamran'),
      '20000000-0000-7000-8000-000000000003',
      tstzrange(now() - interval '1 hour', now() + interval '2 days', '[)'),
      1, null, 'SN-XLR')$$,
  '%serialized%', 'a serial on a bulk product is refused');

create temp table _s (k text primary key, r jsonb) on commit drop;
insert into _s select 'in', record_sub_hire_in(
  (select id from _p where k = 'kamran'),
  '20000000-0000-7000-8000-000000000001',
  tstzrange(now() - interval '1 hour', now() + interval '2 days', '[)'),
  1, 1500000, 'SN-KMR-001', null,
  '40000000-0000-7000-8000-000000000001', 'second body for Rafi');

select ok(
  (select r ->> 'asset_id' from _s where k = 'in') is not null,
  'a serial creates the borrowed unit');
select results_eq(
  $$select ownership, serial_number, presence, disposition from assets
     where id = (select (r ->> 'asset_id')::uuid from _s where k = 'in')$$,
  $$values ('sub_rented_in', 'SN-KMR-001', 'here', null::text)$$,
  'ownership = sub_rented_in, serial kept, on the shelf, in fleet (D5)');
select is(
  (select count(*)::int from scan_events e
    where e.asset_id = (select (r ->> 'asset_id')::uuid from _s where k = 'in')
      and e.event_type = 'intake'
      and e.device_id = 'server:11111111-1111-7111-8111-111111111111'
      and (e.payload ->> 'sub_hire_id')::uuid = (select (r ->> 'sub_hire_id')::uuid from _s where k = 'in')),
  1, 'its intake event is on the org''s server device and names the sub-hire');

select results_eq(
  $$select e.kind, e.counterparty, e.job_id, e.amount_minor from org_expenses e
     where e.id = (select (r ->> 'expense_id')::uuid from _s where k = 'in')$$,
  $$values ('sub_hire', 'Kamran Rentals', '40000000-0000-7000-8000-000000000001'::uuid, 1500000::bigint)$$,
  'the expense is kind sub_hire, counterparty = the partner name, on the job (D2)');
select is(
  (select m.expense_minor from job_margin m
    where m.job_id = '40000000-0000-7000-8000-000000000001'),
  1500000::bigint, 'job_margin (0019) sees it with no new code');
select results_eq(
  $$select s.direction, s.qty, s.agreed_cost_minor, s.returned_at from sub_hires s
     where s.id = (select (r ->> 'sub_hire_id')::uuid from _s where k = 'in')$$,
  $$values ('in', 1, 1500000::bigint, null::timestamptz)$$,
  'and the sub_hires row ties them, open');

select throws_ok(
  $$select record_sub_hire_in((select id from _p where k = 'kamran'),
      '20000000-0000-7000-8000-000000000001',
      tstzrange(now(), now() + interval '1 day', '[)'), 1, null, 'sn-kmr-001')$$,
  '23505', null, 'the same serial again (any case) is refused');

insert into _s select 'in_bulk', record_sub_hire_in(
  (select id from _p where k = 'kamran'),
  '20000000-0000-7000-8000-000000000003',
  tstzrange(now() - interval '1 hour', now() + interval '2 days', '[)'), 10);

select is((select r -> 'expense_id' from _s where k = 'in_bulk'), 'null'::jsonb,
  'no agreed cost: no expense row — unpriced is counted, never zeroed (D6)');
select is(
  (select s.agreed_cost_minor from sub_hires s
    where s.id = (select (r ->> 'sub_hire_id')::uuid from _s where k = 'in_bulk')),
  null, 'and the row records no number rather than 0');

-- A booking-tagged in-hire feeds margin-before-quote (0024 D9).
create temp table _b (k text primary key, id uuid) on commit drop;
insert into _b select 'zb', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-04-01 10:00+05', '2030-04-04 10:00+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
) ->> 'booking_id')::uuid;
insert into _s select 'in_booking', record_sub_hire_in(
  (select id from _p where k = 'kamran'),
  '20000000-0000-7000-8000-000000000001',
  tstzrange('2030-04-01 08:00+05', '2030-04-04 12:00+05', '[)'),
  1, 200000, null, (select id from _b where k = 'zb'));
select is(booking_sub_hire_cost((select id from _b where k = 'zb')), 200000::bigint,
  'booking_sub_hire_cost (0024) sees an in-hire tagged to the booking');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select record_sub_hire_in((select id from _p where k = 'kamran'),
      '20000000-0000-7000-8000-000000000001',
      tstzrange(now(), now() + interval '1 day', '[)'))$$,
  '42501', null, 'the warehouse cannot record a sub-hire');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select is((select count(*)::int from sub_hires), 0,
  'readonly sees no sub-hire rows — the agreed amounts are commercial');

-- ---------------------------------------------------------------------------
-- Close IN (D5)                                               [assert 38–46]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 1, 'event_type', 'check_out',
       'asset_id', (select r ->> 'asset_id' from _s where k = 'in'),
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', now()::text)))),
  'accepted', 'the borrowed body scans out on the Rafi job like any unit');

select throws_like(
  $$select close_sub_hire((select (r ->> 'sub_hire_id')::uuid from _s where k = 'in'))$$,
  '%still out on a job%', 'it cannot go home while it is out on a job');

select submit_scan_batch('WH-01', jsonb_build_array(
  jsonb_build_object('client_seq', 2, 'event_type', 'check_in',
    'asset_id', (select r ->> 'asset_id' from _s where k = 'in'),
    'job_id', '40000000-0000-7000-8000-000000000001',
    'device_time', (now() + interval '1 second')::text)));

insert into _s select 'in_closed', close_sub_hire(
  (select (r ->> 'sub_hire_id')::uuid from _s where k = 'in'));

select ok((select r ->> 'returned_at' from _s where k = 'in_closed') is not null,
  'close stamps returned_at');
select results_eq(
  $$select presence, disposition from assets
     where id = (select (r ->> 'asset_id')::uuid from _s where k = 'in')$$,
  $$values ('gone', 'returned_to_owner')$$,
  'gone + returned_to_owner — never "retired" (D5)');
select is(
  (select e.event_type from scan_events e
    where e.id = (select (r ->> 'retire_event_id')::uuid from _s where k = 'in_closed')),
  'retire', 'via a retire event on the log — the evidence chain holds');
select is(
  (select m.expense_minor from job_margin m
    where m.job_id = '40000000-0000-7000-8000-000000000001'),
  1500000::bigint, 'the expense stays on the job after the unit goes home');

select throws_like(
  $$select close_sub_hire((select (r ->> 'sub_hire_id')::uuid from _s where k = 'in'))$$,
  '%already closed%', 'closing twice is refused');
select throws_like(
  $$select close_sub_hire((select (r ->> 'sub_hire_id')::uuid from _s where k = 'in_bulk'),
                          now() + interval '1 day')$$,
  '%in the future%', 'a return in the future is refused');
select throws_like(
  $$select close_sub_hire((select (r ->> 'sub_hire_id')::uuid from _s where k = 'in_bulk'),
                          now() - interval '2 days')$$,
  '%before the sub-hire began%', 'a return before the period began is refused');

-- ---------------------------------------------------------------------------
-- Sub-hire OUT (D3, D4, D6)                                   [assert 47–61]
-- ---------------------------------------------------------------------------
insert into _s select 'out', record_sub_hire_out(
  (select id from _p where k = 'zindagi'),
  tstzrange(now() - interval '1 hour', now() + interval '3 days', '[)'),
  null, '30000000-0000-7000-8000-000000000001', 1, 800000, 'FX-A for their Karachi shoot');

select results_eq(
  $$select j.label, j.status, j.expected_back, j.customer_id from jobs j
     where j.id = (select (r ->> 'job_id')::uuid from _s where k = 'out')$$,
  $$values ('Sub-hire → Zindagi Films', 'open', (now() + interval '3 days')::date,
            '50000000-0000-7000-8000-000000000003'::uuid)$$,
  'a job is created through the ordinary machinery, on the partner customer (D4)');
select is(
  (select r ->> 'customer_id' from _s where k = 'out'),
  '50000000-0000-7000-8000-000000000003',
  'the existing same-name customer is reused, not duplicated (D3)');
select is(
  (select c.is_partner from customers c where c.id = '50000000-0000-7000-8000-000000000003'),
  true, 'and flagged is_partner');
select results_eq(
  $$select l.entry_kind, l.amount_minor, l.job_id, l.asset_id from customer_ledger_entries l
     where l.id = (select (r ->> 'ledger_entry_id')::uuid from _s where k = 'out')$$,
  $$values ('charge', 800000::bigint,
            (select (r ->> 'job_id')::uuid from _s where k = 'out'),
            '30000000-0000-7000-8000-000000000001'::uuid)$$,
  'the ledger charge sits on that job and names the unit (D2)');
select is(
  (select b.balance_minor from customer_balances b
    where b.customer_id = '50000000-0000-7000-8000-000000000003'),
  800000::bigint, 'the partner now owes it on the khata');

select throws_like(
  $$select record_sub_hire_out((select id from _p where k = 'kamran'),
      tstzrange(now(), now() + interval '1 day', '[)'))$$,
  '%does not belong to this org%', 'no product and no asset: nothing to lend');

insert into _s select 'out_bulk', record_sub_hire_out(
  (select id from _p where k = 'kamran'),
  tstzrange(now() - interval '1 hour', now() + interval '1 day', '[)'),
  '20000000-0000-7000-8000-000000000003', null, 4);

select results_eq(
  $$select c.name, c.is_partner from customers c
     where c.id = (select (r ->> 'customer_id')::uuid from _s where k = 'out_bulk')$$,
  $$values ('Kamran Rentals', true)$$,
  'a partner with no customer row gets one, flagged (D3)');
select is((select r -> 'ledger_entry_id' from _s where k = 'out_bulk'), 'null'::jsonb,
  'no agreed charge: no ledger line — counted, never zeroed (D6)');

-- A borrowed unit cannot be lent on.
insert into _s select 'in2', record_sub_hire_in(
  (select id from _p where k = 'kamran'),
  '20000000-0000-7000-8000-000000000001',
  tstzrange(now() - interval '1 hour', now() + interval '2 days', '[)'),
  1, null, 'SN-KMR-002');
select throws_like(
  $$select record_sub_hire_out((select id from _p where k = 'zindagi'),
      tstzrange(now(), now() + interval '1 day', '[)'),
      null, (select (r ->> 'asset_id')::uuid from _s where k = 'in2'))$$,
  '%cannot be lent on%', 'a sub_rented_in unit cannot be sub-hired out');

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 3, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', (select r ->> 'job_id' from _s where k = 'out'),
       'device_time', (now() + interval '2 seconds')::text)))),
  'accepted', 'the desk scans FX-A out onto the sub-hire job normally');
select is(
  (select a.current_job_id from assets a where a.id = '30000000-0000-7000-8000-000000000001'),
  (select (r ->> 'job_id')::uuid from _s where k = 'out'),
  'presence + current_job_id IS "lent to Zindagi" — no parallel flag (D4)');

select throws_like(
  $$select close_sub_hire((select (r ->> 'sub_hire_id')::uuid from _s where k = 'out'))$$,
  '%still out on it%', 'close is refused while the unit projects onto the job');

select submit_scan_batch('WH-01', jsonb_build_array(
  jsonb_build_object('client_seq', 4, 'event_type', 'check_in',
    'asset_id', '30000000-0000-7000-8000-000000000001',
    'job_id', (select r ->> 'job_id' from _s where k = 'out'),
    'device_time', (now() + interval '3 seconds')::text)));

insert into _s select 'out_closed', close_sub_hire(
  (select (r ->> 'sub_hire_id')::uuid from _s where k = 'out'));
select is((select (r ->> 'job_closed')::boolean from _s where k = 'out_closed'), true,
  'once the unit is back, close closes the job');
select is(
  (select j.status from jobs j where j.id = (select (r ->> 'job_id')::uuid from _s where k = 'out')),
  'closed', 'and the job reads closed on every board');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
select throws_like(
  $$select remove_partner_house((select id from _p where k = 'kamran'))$$,
  '%open sub-hire%', 'a partner with open sub-hires cannot be removed');

-- ---------------------------------------------------------------------------
-- Crew (D7, D8)                                               [assert 62–74]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
create temp table _seq on commit drop as
  select change_seq from jobs where id = '40000000-0000-7000-8000-000000000001';

select is(
  assign_attendant('40000000-0000-7000-8000-000000000001',
                   'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa') -> 'attendant_names',
  '["Bilal the tech"]'::jsonb, 'the desk puts Bilal on the Rafi job');
select is(
  assign_attendant('40000000-0000-7000-8000-000000000001',
                   'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver') -> 'attendant_names',
  '["Bilal the tech", "Chacha the driver"]'::jsonb, 'and Chacha as the driver, in order');
select is(
  (select ja.role from job_attendants ja
    where ja.job_id = '40000000-0000-7000-8000-000000000001'
      and ja.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc'),
  'driver', 'the role is recorded');

select throws_like(
  $$select assign_attendant('40000000-0000-7000-8000-000000000001',
                            '77777777-7777-7777-8777-777777777777')$$,
  '%not an active member%', 'a stranger cannot be crew');
select throws_like(
  $$select assign_attendant('40000000-0000-7000-8000-000000000001',
                            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'cook')$$,
  '%attendant or driver%', 'the role vocabulary is two words');
select throws_like(
  $$select assign_attendant('40000000-0000-7000-8000-000000000002',
                            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa')$$,
  '%cancelled%', 'nobody goes out with a cancelled job');

select ok(
  (select change_seq from jobs where id = '40000000-0000-7000-8000-000000000001')
    > (select change_seq from _seq),
  'assigning crew bumps the job''s change_seq — the phone will re-read it (D8)');
select is(
  (select x -> 'attendant_names'
     from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'jobs') x
    where (x ->> 'id')::uuid = '40000000-0000-7000-8000-000000000001'),
  '["Bilal the tech", "Chacha the driver"]'::jsonb,
  'pull_changes carries attendant_names on the jobs row (eighth edition)');
select is(
  (select x -> 'attendant_names'
     from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'jobs') x
    where (x ->> 'id')::uuid = '40000000-0000-7000-8000-000000000002'),
  '[]'::jsonb, 'a job with no crew carries [] — never null, never missing');

select is(
  (unassign_attendant('40000000-0000-7000-8000-000000000001',
                      'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa') ->> 'removed')::boolean,
  true, 'unassign removes Bilal');
select is(
  (unassign_attendant('40000000-0000-7000-8000-000000000001',
                      'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa') ->> 'removed')::boolean,
  false, 'and says so honestly the second time');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select throws_ok(
  $$select assign_attendant('40000000-0000-7000-8000-000000000001',
                            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa')$$,
  '42501', null, 'readonly cannot assign crew');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select is(
  (select count(*)::int from job_attendants
    where job_id = '40000000-0000-7000-8000-000000000001'),
  1, 'but every member can read who is on a job — the board shows the crew');

-- ---------------------------------------------------------------------------
-- The stolen broadcast (D9)                                   [assert 75–81]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
select throws_like(
  $$select stolen_broadcast_text('30000000-0000-7000-8000-000000000002')$$,
  '%not marked stolen%', 'no broadcast for a unit that is not stolen — it would be a lie');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
select submit_scan_batch('WH-01', jsonb_build_array(
  jsonb_build_object('client_seq', 5, 'event_type', 'mark_stolen',
    'asset_id', '30000000-0000-7000-8000-000000000002',
    'device_time', (now() + interval '4 seconds')::text)));

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
select is(
  stolen_broadcast_text('30000000-0000-7000-8000-000000000002') - 'text' - 'marked_stolen_at',
  jsonb_build_object(
    'asset_id', '30000000-0000-7000-8000-000000000002',
    'asset_code', 'FX-B',
    'serial_number', 'SN-FXB',
    'product_name', 'Sony FX9',
    'tag_code', 'TAGFXB',
    'public_url', null,
    'org_name', 'Lumos',
    'org_phone', '0300-1234567'),
  'the facts: code, serial, product, tag, org name and phone; no URL while the base is unset');
select ok(
  (stolen_broadcast_text('30000000-0000-7000-8000-000000000002') ->> 'text')
    like 'CHORI / STOLEN — Sony FX9, serial SN-FXB, tag TAGFXB.%0300-1234567%',
  'the paste-ready line leads Roman Urdu and carries the phone');
select ok(
  (stolen_broadcast_text('30000000-0000-7000-8000-000000000002') ->> 'marked_stolen_at') is not null,
  'and says when it was declared stolen');

set local role postgres;
update orgs set settings = settings || '{"public_tag_url_base": "https://tags.papa.pk/t/"}'::jsonb
 where id = '11111111-1111-7111-8111-111111111111';
set local role papa_app;

select is(
  stolen_broadcast_text('30000000-0000-7000-8000-000000000002') ->> 'public_url',
  'https://tags.papa.pk/t/TAGFXB', 'with the org setting, the public page URL is built (ASSUMPTION #public-tag-url)');
select ok(
  (stolen_broadcast_text('30000000-0000-7000-8000-000000000002') ->> 'text')
    like '% https://tags.papa.pk/t/TAGFXB',
  'and rides the end of the line');

-- ---------------------------------------------------------------------------
-- The quote flags (D10)                                       [assert 82–87]
-- ---------------------------------------------------------------------------
select is(
  customer_quote_flags('50000000-0000-7000-8000-000000000003')
    - 'customer_id' - 'name' - 'clean_completed_jobs',
  '{"verified": false, "clean_history": false, "blacklisted": false,
    "fast_lane": false, "deposit_hint": "full"}'::jsonb,
  'a client with no credentials: full deposit');

update customers set blacklisted = true where id = '50000000-0000-7000-8000-000000000003';
select is(customer_quote_flags('50000000-0000-7000-8000-000000000003') ->> 'deposit_hint',
  'refuse', 'blacklisted: refuse, not paperwork');
update customers set blacklisted = false where id = '50000000-0000-7000-8000-000000000003';

insert into customer_credentials (org_id, customer_id, kind, guarantor_name,
                                  guarantor_phone, verified_by, verified_at)
values ('11111111-1111-7111-8111-111111111111',
        '50000000-0000-7000-8000-000000000003',
        'guarantor', 'Haji Saab', '03211112222',
        'ffffffff-ffff-7fff-8fff-ffffffffffff', now());
select is(customer_quote_flags('50000000-0000-7000-8000-000000000003') ->> 'deposit_hint',
  'standard', 'a verified credential: standard deposit');
select is((customer_quote_flags('50000000-0000-7000-8000-000000000003') ->> 'verified')::boolean,
  true, 'verified reads from verified_customers (0017) — never a hand-set flag');

select throws_like(
  $$select customer_quote_flags('50000000-0000-7000-8000-000000000009')$$,
  '%does not belong to this org%', 'a foreign customer is refused');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select is(customer_quote_flags('50000000-0000-7000-8000-000000000003') ->> 'deposit_hint',
  'full', 'under a non-money role the credentials are invisible: the stricter answer');

-- ---------------------------------------------------------------------------
-- Cross-org (Kamran's owner)                                  [assert 88–93]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';   -- Rana

select is((select count(*)::int from partner_houses), 0, 'Kamran sees none of Lumos''s partners');
select is((select count(*)::int from sub_hires), 0, 'nor its sub-hires');
select is((select count(*)::int from job_attendants), 0, 'nor its crew');
select throws_like(
  $$select record_sub_hire_in((select id from _p where k = 'kamran'),
      '20000000-0000-7000-8000-000000000009',
      tstzrange(now(), now() + interval '1 day', '[)'))$$,
  '%does not belong to this org%', 'a Lumos partner cannot be used from Kamran');
select throws_like(
  $$select assign_attendant('40000000-0000-7000-8000-000000000001',
                            'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee')$$,
  '%does not belong to this org%', 'a Lumos job cannot take Kamran crew');
select throws_like(
  $$select close_sub_hire((select (r ->> 'sub_hire_id')::uuid from _s where k = 'in_bulk'))$$,
  '%does not belong to this org%', 'a Lumos sub-hire cannot be closed from Kamran');

-- ---------------------------------------------------------------------------
-- The sync guards                                             [assert 94–95]
-- ---------------------------------------------------------------------------
set local role postgres;

select is((select count(*)::int from sync_pii_violations()), 0,
  'no PII column has become syncable — partner_houses.phone stays home');
select is((select count(*)::int from sync_exclusion_violations()), 0,
  'every registered column exclusion still holds in the eighth edition');

-- The registry WOULD catch it: making partner_houses syncable must fail the
-- build on its phone column. Proven, not assumed.
alter table partner_houses add column change_seq bigint;
select is(
  (select string_agg(table_name || '.' || column_name, ', ') from sync_pii_violations()),
  'partner_houses.phone', 'the %phone% pattern catches partner_houses.phone the day it syncs');
alter table partner_houses drop column change_seq;

select * from finish();
rollback;
