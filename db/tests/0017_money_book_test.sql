-- ============================================================================
-- 0017 — The money book
--
-- Every property the money layer claims, tested for the property it ACTUALLY
-- has (the 0007 rule). The load-bearing ones:
--
--   * the ledger is append-only BOTH ways it is enforced: the trigger refuses
--     a superuser, the withheld grant refuses papa_app, and every write path
--     is a DEFINER RPC;
--   * signs are a property of the kind, not a caller choice, and overrides
--     (adjustment / write_off) always carry their reason;
--   * corrections point forward, stay on the same org/customer/kind, can
--     happen at most ONCE per target (a double correction would double-count),
--     and never touch deposit lines;
--   * the balance is a SUM over live rows — asserted across every kind, then
--     re-asserted after a correction changes history's story;
--   * deposits move held → partially_applied → refunded only through the
--     RPCs, and refund is REFUSED while the linked job has any shortfall —
--     each job_money_shortfalls reason pinned independently;
--   * roles gate both ways: desk writes money and warehouse/readonly/driver
--     cannot; refunds are owner/manager only; non-money roles read ZERO ROWS
--     (never zero balances) from every money surface;
--   * cross-org reach is refused on every RPC and the credentials UPDATE
--     policy cannot be used to re-home another org's rows;
--   * attribution comes from the papa.* GUCs, never from arguments;
--   * the PII guard stays at zero, and would actually fire if a guarantor
--     column ever landed on a syncable table.
-- ============================================================================
begin;
select plan(124);

set local role postgres;

-- Captured ids that flow between calls (the 0016 _cap pattern, uuid-typed).
create temp table _ids (k text primary key, id uuid);
grant select, insert, update, delete on _ids to papa_app;

select fixture_rls_off();

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');

insert into users (id, display_name, phone) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech',    '+923000000002'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner',   '+923000000001'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif the driver', '+923000000003'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Zoya read-only',    '+923000000004'),
  ('99999999-9999-7999-8999-999999999999', 'Nadia the manager', '+923000000005'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk','+923000000006'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (org2 owner)', '+923000000007');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver'),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly'),
  ('11111111-1111-7111-8111-111111111111', '99999999-9999-7999-8999-999999999999', 'manager'),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into devices (id, org_id, label) values
  ('T-01', '11111111-1111-7111-8111-111111111111', 'Warehouse phone 1');

insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9');
insert into assets (id, org_id, product_id, asset_code, purchase_price_minor) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-02', 350000000),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-03', 350000000),
  ('30000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'LENS-01', 90000000);

-- Customers. C1 carries the balance-math story, C2 the deposit machine and
-- the dirty jobs, C3 the fast lane, CX belongs to the OTHER org.
insert into customers (id, org_id, name, phone) values
  ('51111111-1111-7111-8111-111111111111', '11111111-1111-7111-8111-111111111111',
   'Chaudhry Films', '+923214440001'),
  ('52222222-2222-7222-8222-222222222222', '11111111-1111-7111-8111-111111111111',
   'Rafi Productions', '+923214440002'),
  ('53333333-3333-7333-8333-333333333333', '11111111-1111-7111-8111-111111111111',
   'Mehr Studios', '+923214440003'),
  ('58888888-8888-7888-8888-888888888888', '22222222-2222-7222-8222-222222222222',
   'Kamran Regular', '+923214440009');

-- Jobs, one per QC-shortfall reason plus two clean ones. J_CLEAN belongs to
-- C3 (the fast lane's history); everything else to C2.
insert into jobs (id, org_id, label, customer_id) values
  ('61111111-1111-7111-8111-111111111111', '11111111-1111-7111-8111-111111111111',
   'Mehr / clean wedding shoot',   '53333333-3333-7333-8333-333333333333'),
  ('62222222-2222-7222-8222-222222222222', '11111111-1111-7111-8111-111111111111',
   'Rafi / gear still out',        '52222222-2222-7222-8222-222222222222'),
  ('63333333-3333-7333-8333-333333333333', '11111111-1111-7111-8111-111111111111',
   'Rafi / open dispatch',         '52222222-2222-7222-8222-222222222222'),
  ('64444444-4444-7444-8444-444444444444', '11111111-1111-7111-8111-111111111111',
   'Rafi / no confirmed return',   '52222222-2222-7222-8222-222222222222'),
  ('65555555-5555-7555-8555-555555555555', '11111111-1111-7111-8111-111111111111',
   'Rafi / return counted short',  '52222222-2222-7222-8222-222222222222'),
  ('66666666-6666-7666-8666-666666666666', '11111111-1111-7111-8111-111111111111',
   'Rafi / bulk-assumed return',   '52222222-2222-7222-8222-222222222222'),
  ('67777777-7777-7777-8777-777777777777', '11111111-1111-7111-8111-111111111111',
   'Rafi / damage unresolved',     '52222222-2222-7222-8222-222222222222'),
  ('68888888-8888-7888-8888-888888888888', '11111111-1111-7111-8111-111111111111',
   'Rafi / count discrepancy',     '52222222-2222-7222-8222-222222222222'),
  ('69999999-9999-7999-8999-999999999999', '11111111-1111-7111-8111-111111111111',
   'Rafi / clean and settled',     '52222222-2222-7222-8222-222222222222');

-- Stage each shortfall. gear_still_out is the assets projection:
update assets set current_job_id = '62222222-2222-7222-8222-222222222222'
 where id = '30000000-0000-7000-8000-000000000002';

-- open_dispatch:
insert into dispatches (org_id, job_id, session_id, direction, state,
                        expected_count, opened_by) values
  ('11111111-1111-7111-8111-111111111111', '63333333-3333-7333-8333-333333333333',
   '71111111-0000-7000-8000-000000000001', 'out', 'open', 4,
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb');

-- Confirmed dispatches. Helper-free but explicit: a confirmed row must carry
-- full provenance (dispatches_confirmed_complete).
insert into dispatches (org_id, job_id, session_id, direction, state,
                        expected_count, scanned_count, assumed_count,
                        unaccounted_count, opened_by, confirmed_by,
                        confirmed_at, confirmed_by_role, destination) values
  -- no_confirmed_return: gear went OUT, nothing came back
  ('11111111-1111-7111-8111-111111111111', '64444444-4444-7444-8444-444444444444',
   '71111111-0000-7000-8000-000000000002', 'out', 'confirmed',
   3, 3, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  -- return_counted_short: back confirmed, two items unaccounted
  ('11111111-1111-7111-8111-111111111111', '65555555-5555-7555-8555-555555555555',
   '71111111-0000-7000-8000-000000000003', 'out', 'confirmed',
   3, 3, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  ('11111111-1111-7111-8111-111111111111', '65555555-5555-7555-8555-555555555555',
   '71111111-0000-7000-8000-000000000004', 'back', 'confirmed',
   3, 1, 0, 2, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  -- weak_return_evidence: mostly bulk-assumed (assumed > scanned)
  ('11111111-1111-7111-8111-111111111111', '66666666-6666-7666-8666-666666666666',
   '71111111-0000-7000-8000-000000000005', 'out', 'confirmed',
   6, 6, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  ('11111111-1111-7111-8111-111111111111', '66666666-6666-7666-8666-666666666666',
   '71111111-0000-7000-8000-000000000006', 'back', 'confirmed',
   6, 1, 5, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  -- damage_unresolved: dispatches themselves are clean
  ('11111111-1111-7111-8111-111111111111', '67777777-7777-7777-8777-777777777777',
   '71111111-0000-7000-8000-000000000007', 'out', 'confirmed',
   2, 2, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  ('11111111-1111-7111-8111-111111111111', '67777777-7777-7777-8777-777777777777',
   '71111111-0000-7000-8000-000000000008', 'back', 'confirmed',
   2, 2, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  -- count_discrepancy_open: clean dispatches, unresolved alert
  ('11111111-1111-7111-8111-111111111111', '68888888-8888-7888-8888-888888888888',
   '71111111-0000-7000-8000-000000000009', 'out', 'confirmed',
   2, 2, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  ('11111111-1111-7111-8111-111111111111', '68888888-8888-7888-8888-888888888888',
   '71111111-0000-7000-8000-000000000010', 'back', 'confirmed',
   2, 2, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  -- J_CLEAN (C3): a genuinely finished rental
  ('11111111-1111-7111-8111-111111111111', '61111111-1111-7111-8111-111111111111',
   '71111111-0000-7000-8000-000000000011', 'out', 'confirmed',
   3, 3, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  ('11111111-1111-7111-8111-111111111111', '61111111-1111-7111-8111-111111111111',
   '71111111-0000-7000-8000-000000000012', 'back', 'confirmed',
   3, 3, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  -- J_CLEAN_C2: the deposit that WILL be refundable
  ('11111111-1111-7111-8111-111111111111', '69999999-9999-7999-8999-999999999999',
   '71111111-0000-7000-8000-000000000013', 'out', 'confirmed',
   2, 2, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli'),
  ('11111111-1111-7111-8111-111111111111', '69999999-9999-7999-8999-999999999999',
   '71111111-0000-7000-8000-000000000014', 'back', 'confirmed',
   2, 2, 0, 0, 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now(), 'owner', 'Rafi Peer haveli');

-- damage_unresolved: a flag under the job, asset still not ok
insert into scan_events (id, org_id, asset_id, event_type, entry_method, job_id,
                         actor_user_id, device_id, client_seq, device_time,
                         effective_time, health) values
  ('72222222-0000-7000-8000-000000000001',
   '11111111-1111-7111-8111-111111111111', '30000000-0000-7000-8000-000000000003',
   'flag_damage', 'manual', '67777777-7777-7777-8777-777777777777',
   'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'T-01', 1, now(), now(), 'quarantined');
update assets set health = 'quarantined'
 where id = '30000000-0000-7000-8000-000000000003';

-- count_discrepancy_open:
insert into alerts (org_id, kind, job_id, title) values
  ('11111111-1111-7111-8111-111111111111', 'count_discrepancy',
   '68888888-8888-7888-8888-888888888888', 'return counted short at the dock');

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Structure and hygiene
-- ---------------------------------------------------------------------------
select ok(
  (select bool_and(relforcerowsecurity) from pg_class
    where relnamespace = 'public'::regnamespace
      and relname in ('customers', 'customer_ledger_entries', 'deposits',
                      'customer_credentials')),
  'RLS is FORCED on all four money tables — it binds the table owner too');

select is(
  (select count(*)::int from pg_proc
    where pronamespace = 'public'::regnamespace and prosecdef
      and proname in ('record_ledger_entry', 'record_payment', 'hold_deposit',
                      'apply_deposit', 'refund_deposit')),
  5,
  'every money RPC is SECURITY DEFINER — the only door to a table with no insert grant');

select ok(
  (select bool_and(proconfig::text like '%search_path=public%')
     from pg_proc
    where pronamespace = 'public'::regnamespace and prosecdef
      and proname in ('record_ledger_entry', 'record_payment', 'hold_deposit',
                      'apply_deposit', 'refund_deposit')),
  'and every one pins search_path — the 0015 hygiene rule');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'customers'
      and column_name like 'cnic%'),
  0,
  'customers carries NO cnic column — credentials live in customer_credentials (D9)');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public'
      and table_name in ('customers', 'customer_ledger_entries', 'deposits',
                         'customer_credentials')
      and column_name = 'change_seq'),
  0,
  'none of the money tables is syncable — no change_seq anywhere (D2)');

select ok(
  (select i.indisunique from pg_index i
     join pg_class c on c.oid = i.indexrelid
    where c.relname = 'ledger_corrects_once_idx'),
  'the corrects_entry_id index is UNIQUE — an entry can be corrected at most once');

select ok(
  not has_table_privilege('papa_app', 'customer_ledger_entries', 'insert')
  and not has_table_privilege('papa_app', 'customer_ledger_entries', 'update')
  and not has_table_privilege('papa_app', 'customer_ledger_entries', 'delete'),
  'papa_app holds NO write grant on the ledger — money moves only through the RPCs');

select ok(
  not has_table_privilege('papa_app', 'deposits', 'insert')
  and not has_table_privilege('papa_app', 'deposits', 'update')
  and not has_table_privilege('papa_app', 'deposits', 'delete'),
  'nor on deposits — state cannot be forged around the machine');

select ok(
  not has_function_privilege('papa_app', 'money_write_context(text[])', 'execute'),
  'the internal context helper is not callable by the app role');

select ok(
  exists (select 1 from sync_sensitive_columns where column_name = 'guarantor%'),
  'the guard learned the guarantor shape — a future syncable table cannot carry it');

-- ---------------------------------------------------------------------------
-- customers is the jobs CRUD tier: desk and warehouse write, readonly and
-- driver are refused LOUDLY
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
set local role papa_app;

select lives_ok(
  $$insert into customers (id, org_id, name, phone) values
    ('54444444-4444-7444-8444-444444444444',
     '11111111-1111-7111-8111-111111111111', 'Walk-in Wadood', '+923214440004')$$,
  'the desk creates a customer with direct DML — customer records are not evidence, the ledger is');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select lives_ok(
  $$update customers set notes = 'asks for Bilal by name'
     where id = '54444444-4444-7444-8444-444444444444'$$,
  'warehouse may edit a customer too — same tier as jobs');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select throws_ok(
  $$insert into customers (org_id, name) values
    ('11111111-1111-7111-8111-111111111111', 'Should Not Exist')$$,
  '42501', null,
  'readonly cannot create a customer — refused loudly, not silently');

set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- driver
select throws_ok(
  $$update customers set notes = 'x'
     where id = '54444444-4444-7444-8444-444444444444'$$,
  '42501', null,
  'a driver edits nothing — the 0013 rule, loud');

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk again
select throws_ok(
  $$insert into customers (org_id, name) values
    ('22222222-2222-7222-8222-222222222222', 'Wrong Org Customer')$$,
  '42501', null,
  'and nobody plants a customer in another org');

-- ---------------------------------------------------------------------------
-- The ledger writes only through RPCs, and attribution comes from the GUCs
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111',
            '51111111-1111-7111-8111-111111111111', 'charge', 1000,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '42501', null,
  'papa_app cannot INSERT the ledger directly — the withheld grant, before any trigger');

set local papa.device_id  = 'DESK-01';
set local papa.session_id = '0aaaaaaa-0000-7000-8000-000000000001';

insert into _ids
select 'chg1', id from record_ledger_entry(
  '51111111-1111-7111-8111-111111111111', 'charge', 10000000,
  null, '30000000-0000-7000-8000-000000000001', 'FX9 five-day wedding hire');

select is(
  (select entry_kind from customer_ledger_entries
    where id = (select id from _ids where k = 'chg1')),
  'charge',
  'the desk records a charge through the RPC');

select is(
  (select created_by from customer_ledger_entries
    where id = (select id from _ids where k = 'chg1')),
  'ffffffff-ffff-7fff-8fff-ffffffffffff'::uuid,
  'created_by is the papa.user_id GUC — the RPC signature has no actor argument to lie with');

select is(
  (select device_id from customer_ledger_entries
    where id = (select id from _ids where k = 'chg1')),
  'DESK-01',
  'device attribution from papa.device_id');

select is(
  (select session_id from customer_ledger_entries
    where id = (select id from _ids where k = 'chg1')),
  '0aaaaaaa-0000-7000-8000-000000000001'::uuid,
  'session attribution from papa.session_id');

select is(
  (select currency from customer_ledger_entries
    where id = (select id from _ids where k = 'chg1')),
  'PKR',
  'currency comes from the org, not the caller');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
                               'charge', 1000)$$,
  '42501', null,
  'warehouse cannot write money — the dock flags, the desk charges (D7)');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select throws_ok(
  $$select record_payment('51111111-1111-7111-8111-111111111111', 1000)$$,
  '42501', null,
  'readonly means readonly, for payments too');

set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- driver
select throws_ok(
  $$select hold_deposit('51111111-1111-7111-8111-111111111111', 1000)$$,
  '42501', null,
  'a driver holds no deposits');

-- Append-only, against the strongest attacker the database can host.
set local role postgres;
select throws_ok(
  $$update customer_ledger_entries set amount_minor = 1
     where id = (select id from _ids where k = 'chg1')$$,
  '23001', null,
  'even a superuser cannot UPDATE a ledger row — the trigger holds when grants do not');

select throws_ok(
  $$delete from customer_ledger_entries
     where id = (select id from _ids where k = 'chg1')$$,
  '23001', null,
  'nor DELETE one');

set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
select throws_ok(
  $$update customer_ledger_entries set amount_minor = 1$$,
  '42501', null,
  'papa_app is stopped a layer earlier, at the missing grant');

-- ---------------------------------------------------------------------------
-- Signs are fixed per kind; overrides carry their reason (D4, override 18)
-- ---------------------------------------------------------------------------
set local role postgres;

select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111',
            '51111111-1111-7111-8111-111111111111', 'charge', -1000,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'a negative charge violates the constraint — the sign is the kind''s, not the caller''s');

select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111',
            '51111111-1111-7111-8111-111111111111', 'payment', 1000,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'a positive payment likewise');

select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, note, created_by)
    values ('11111111-1111-7111-8111-111111111111',
            '51111111-1111-7111-8111-111111111111', 'adjustment', 0, 'zero',
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'a zero adjustment is a record of nothing');

select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111',
            '51111111-1111-7111-8111-111111111111', 'adjustment', -500,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'an adjustment without a note is refused — never fight the owner''s judgement, always record it');

select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111',
            '51111111-1111-7111-8111-111111111111', 'write_off', -500,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'a write_off without a note likewise');

-- A real same-org deposit, so the LINK constraint is what refuses — not the
-- trigger's does-this-deposit-even-exist check.
insert into deposits (id, org_id, customer_id, amount_minor, state, held_by)
values ('82222222-0000-7000-8000-000000000001',
        '11111111-1111-7111-8111-111111111111',
        '51111111-1111-7111-8111-111111111111', 1000, 'held',
        'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb');

select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, deposit_id, created_by)
    values ('11111111-1111-7111-8111-111111111111',
            '51111111-1111-7111-8111-111111111111', 'charge', 500,
            '82222222-0000-7000-8000-000000000001',
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'a non-deposit kind cannot name a deposit');

select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111',
            '51111111-1111-7111-8111-111111111111', 'deposit_hold', 500,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'and a deposit kind must name its deposit');

set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

select throws_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
                               'deposit_hold', 1000)$$,
  '22023', null,
  'the general RPC refuses deposit kinds — the state machine is their only door');

select throws_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
                               'charge', 0)$$,
  '23514', null,
  'and a zero amount');

select throws_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
                               'charge', -1000)$$,
  '23514', null,
  'and a wrong-signed charge, loudly, before the constraint would');

select throws_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
                               'payment', 1000)$$,
  '23514', null,
  'and a wrong-signed payment');

select throws_ok(
  $$select record_payment('51111111-1111-7111-8111-111111111111', -1000)$$,
  '23514', null,
  'record_payment takes the POSITIVE amount received, or nothing');

-- ---------------------------------------------------------------------------
-- Balance math across every kind (D4). The desk types; the sum answers.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
      'late_fee', 500000, null, null, 'three days late')$$,
  'a late fee posts');

insert into _ids
select 'pay1', id from record_payment(
  '51111111-1111-7111-8111-111111111111', 3000000, null, 'cash at the counter');

select is(
  (select amount_minor from customer_ledger_entries
    where id = (select id from _ids where k = 'pay1')),
  (-3000000)::bigint,
  'record_payment stores the negative fact the positive rupees are');

select lives_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
      'damage_charge', 200000, null,
      '30000000-0000-7000-8000-000000000001', 'scratched filter thread')$$,
  'a damage charge posts against the asset');

select lives_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
      'write_off', -400000, null, null, 'old dispute, owner let it go')$$,
  'a write_off with its reason posts');

select lives_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
      'adjustment', -100000, null, null, 'rounding from the paper khata')$$,
  'an adjustment with its reason posts');

select is(
  (select balance_minor from customer_balances
    where customer_id = '51111111-1111-7111-8111-111111111111'),
  7200000::bigint,
  'the balance is the sum: 10000000 + 500000 - 3000000 + 200000 - 400000 - 100000');

select is(
  (select entry_count from customer_balances
    where customer_id = '51111111-1111-7111-8111-111111111111'),
  6,
  'six live entries so far');

-- ---------------------------------------------------------------------------
-- The deposit machine (D5): held → partially_applied → refunded
-- ---------------------------------------------------------------------------
insert into _ids
select 'dep1', id from hold_deposit(
  '51111111-1111-7111-8111-111111111111', 5000000, null, 'security for the FX9');

select is(
  (select state from deposits where id = (select id from _ids where k = 'dep1')),
  'held',
  'a held deposit starts held');

select is(
  (select amount_minor from customer_ledger_entries
    where deposit_id = (select id from _ids where k = 'dep1')
      and entry_kind = 'deposit_hold'),
  5000000::bigint,
  'and the hold IS a ledger row — the ledger alone reconstructs the truth');

select is(
  (select balance_minor from customer_balances
    where customer_id = '51111111-1111-7111-8111-111111111111'),
  7200000::bigint,
  'holding a deposit does not change what the customer owes');

select is(
  (select deposit_held_minor from customer_balances
    where customer_id = '51111111-1111-7111-8111-111111111111'),
  5000000::bigint,
  'it changes what we hold of theirs');

select is(
  (select state from apply_deposit(
     (select id from _ids where k = 'dep1'), 2000000, 'applied against the hire')),
  'partially_applied',
  'applying part of it moves the state');

select is(
  (select balance_minor from customer_balances
    where customer_id = '51111111-1111-7111-8111-111111111111'),
  5200000::bigint,
  'ONE deposit_apply row pays the balance down…');

select is(
  (select deposit_held_minor from customer_balances
    where customer_id = '51111111-1111-7111-8111-111111111111'),
  3000000::bigint,
  '…and shrinks the held amount — the same rupee cannot be told twice (D4)');

select throws_ok(
  $$select apply_deposit((select id from _ids where k = 'dep1'), 4000000)$$,
  '23514', null,
  'applying more than remains is refused');

select throws_ok(
  $$select apply_deposit((select id from _ids where k = 'dep1'), 0)$$,
  '23514', null,
  'and a zero application');

select throws_ok(
  $$select refund_deposit((select id from _ids where k = 'dep1'))$$,
  '42501', null,
  'the DESK cannot refund — owner/manager only (override 17)');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner

select is(
  (select state from refund_deposit(
     (select id from _ids where k = 'dep1'), 'clean return, jobless deposit')),
  'refunded',
  'an owner refunds a JOBLESS deposit on recorded judgement — nothing to QC-check');

select is(
  (select refunded_minor from deposits
    where id = (select id from _ids where k = 'dep1')),
  3000000::bigint,
  'exactly the remaining amount moves');

select is(
  (select deposit_held_minor from customer_balances
    where customer_id = '51111111-1111-7111-8111-111111111111'),
  0::bigint,
  'held drops to zero');

select is(
  (select balance_minor from customer_balances
    where customer_id = '51111111-1111-7111-8111-111111111111'),
  5200000::bigint,
  'the balance owed is untouched by giving back their own money');

set local role postgres;
select ok(
  exists (select 1 from audit_log
           where action = 'deposit_refund'
             and subject_id = (select id from _ids where k = 'dep1')),
  'the refund is audited — money-destructive acts leave the 0007 trail');
set local role papa_app;
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select throws_ok(
  $$select refund_deposit((select id from _ids where k = 'dep1'))$$,
  '23514', null,
  'a refunded deposit cannot be refunded again');

select throws_ok(
  $$select apply_deposit((select id from _ids where k = 'dep1'), 1)$$,
  '23514', null,
  'nor applied');

-- A fully-applied deposit has nothing left to move.
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
insert into _ids
select 'dep2', id from hold_deposit(
  '51111111-1111-7111-8111-111111111111', 1000000, null, 'small cash deposit');
select lives_ok(
  $$select apply_deposit((select id from _ids where k = 'dep2'), 1000000)$$,
  'a deposit can be applied in full');
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
select throws_matching(
  $$select refund_deposit((select id from _ids where k = 'dep2'))$$,
  'nothing to refund',
  'refunding a fully-applied deposit is refused — a zero-amount row records nothing (D5)');

-- ---------------------------------------------------------------------------
-- Corrections point forward, once, on the same customer and kind
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

insert into _ids
select 'chg1fix', id from record_ledger_entry(
  '51111111-1111-7111-8111-111111111111', 'charge', 9000000,
  null, '30000000-0000-7000-8000-000000000001',
  'rate was quoted at 90k/day, not 100k', (select id from _ids where k = 'chg1'));

select is(
  (select balance_minor from customer_balances
    where customer_id = '51111111-1111-7111-8111-111111111111'),
  3200000::bigint,
  'the corrected charge leaves the sum; the correction joins it: (5200000 - dep2''s 1000000 apply) - 10000000 + 9000000');

set local role postgres;
select ok(
  exists (select 1 from audit_log
           where action = 'ledger_correction'
             and subject_id = (select id from _ids where k = 'chg1')),
  'a correction rewrites the story a customer may be told — audited');
set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

select throws_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
      'charge', 8000000, null, null, 'second thoughts',
      (select id from _ids where k = 'chg1'))$$,
  '23505', null,
  'a SECOND correction of the same entry is refused — correct the correction instead');

select throws_ok(
  $$select record_ledger_entry('52222222-2222-7222-8222-222222222222',
      'charge', 8000000, null, null, 'wrong customer',
      (select id from _ids where k = 'chg1fix'))$$,
  '23514', null,
  'a correction cannot move money to a different customer');

select throws_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
      'late_fee', 8000000, null, null, 'wrong kind',
      (select id from _ids where k = 'chg1fix'))$$,
  '23514', null,
  'nor change the kind of what it corrects');

set local role postgres;
select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, deposit_id,
       corrects_entry_id, created_by)
    select e.org_id, e.customer_id, 'deposit_hold', 100, e.deposit_id, e.id,
           'ffffffff-ffff-7fff-8fff-ffffffffffff'
      from customer_ledger_entries e
     where e.deposit_id = (select id from _ids where k = 'dep1')
       and e.entry_kind = 'deposit_hold'$$,
  '23514', null,
  'deposit lines cannot be corrected at all — the machine is their only history');
set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

-- ---------------------------------------------------------------------------
-- Per-asset earnings (B6): live charge-side lines only
-- ---------------------------------------------------------------------------
-- 0018 D7 narrowed the view to rental money only: the damage charge stays
-- on the khata but out of the earnings, so a camera that gets broken often
-- can never read as the fleet's best performer.
select is(
  (select earned_minor from asset_earnings
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  9000000::bigint,
  'the FX9 earned the corrected charge; the superseded 10000000 is gone and the damage charge never counts (0018)');

select is(
  (select earning_entry_count from asset_earnings
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  1,
  'one live earning line — the damage charge is khata money, not earnings (0018)');

-- ---------------------------------------------------------------------------
-- The job link: money lands on the right statement
-- ---------------------------------------------------------------------------
set local role postgres;
select throws_ok(
  $$update jobs set customer_id = '58888888-8888-7888-8888-888888888888'
     where id = '61111111-1111-7111-8111-111111111111'$$,
  '23503', null,
  'a job cannot be handed to another org''s customer — tenancy over mere existence (M4)');
set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

select throws_matching(
  $$select record_ledger_entry('52222222-2222-7222-8222-222222222222',
      'charge', 1000, '61111111-1111-7111-8111-111111111111')$$,
  'belongs to a different customer',
  'a charge against someone ELSE''s job is refused — the wrong statement is a bookkeeping lie');

select lives_ok(
  $$select record_ledger_entry('52222222-2222-7222-8222-222222222222',
      'charge', 800000, '63333333-3333-7333-8333-333333333333')$$,
  'a charge on the customer''s own job posts');

select throws_matching(
  $$select hold_deposit('51111111-1111-7111-8111-111111111111', 1000,
      '63333333-3333-7333-8333-333333333333')$$,
  'belongs to a different customer',
  'and a deposit against someone else''s job is refused the same way');

-- ---------------------------------------------------------------------------
-- What "QC clear" means today (D6): each shortfall reason, pinned
-- ---------------------------------------------------------------------------
select is(
  (select reason from job_money_shortfalls('62222222-2222-7222-8222-222222222222')),
  'gear_still_out',
  'an asset still projecting onto the job blocks it');

select is(
  (select reason from job_money_shortfalls('63333333-3333-7333-8333-333333333333')),
  'open_dispatch',
  'a half-done dispatch blocks it');

select is(
  (select reason from job_money_shortfalls('64444444-4444-7444-8444-444444444444')),
  'no_confirmed_return',
  'gear that went out with no confirmed return blocks it');

select is(
  (select reason from job_money_shortfalls('65555555-5555-7555-8555-555555555555')),
  'return_counted_short',
  'a short-counted return blocks it');

select is(
  (select reason from job_money_shortfalls('66666666-6666-7666-8666-666666666666')),
  'weak_return_evidence',
  'a mostly bulk-assumed return blocks it — belief is not observation (H4)');

select is(
  (select reason from job_money_shortfalls('67777777-7777-7777-8777-777777777777')),
  'damage_unresolved',
  'damage flagged under the job with the asset still unwell blocks it');

select is(
  (select reason from job_money_shortfalls('68888888-8888-7888-8888-888888888888')),
  'count_discrepancy_open',
  'an unresolved count-discrepancy alert blocks it');

select is(
  (select count(*)::int from job_money_shortfalls('69999999-9999-7999-8999-999999999999')),
  0,
  'a genuinely settled job is clear');

-- ---------------------------------------------------------------------------
-- The refund gate (override 15): refused while short, allowed when clear
-- ---------------------------------------------------------------------------
insert into _ids
select 'dep_out', id from hold_deposit(
  '52222222-2222-7222-8222-222222222222', 2000000,
  '62222222-2222-7222-8222-222222222222', 'deposit on the still-out job');
insert into _ids
select 'dep_short', id from hold_deposit(
  '52222222-2222-7222-8222-222222222222', 2000000,
  '65555555-5555-7555-8555-555555555555', 'deposit on the short-counted job');
insert into _ids
select 'dep_weak', id from hold_deposit(
  '52222222-2222-7222-8222-222222222222', 2000000,
  '66666666-6666-7666-8666-666666666666', 'deposit on the bulk-assumed job');
insert into _ids
select 'dep_clean', id from hold_deposit(
  '52222222-2222-7222-8222-222222222222', 2000000,
  '69999999-9999-7999-8999-999999999999', 'deposit on the settled job');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner

select throws_matching(
  $$select refund_deposit((select id from _ids where k = 'dep_out'))$$,
  'gear_still_out',
  'no refund while gear is out — and the error SAYS why, so the desk can too');

select throws_matching(
  $$select refund_deposit((select id from _ids where k = 'dep_short'))$$,
  'return_counted_short',
  'no refund over a short count — the cracked matte box is found at the bench, not the counter');

select throws_matching(
  $$select refund_deposit((select id from _ids where k = 'dep_weak'))$$,
  'weak_return_evidence',
  'no refund on a bulk-assumed return');

set local papa.user_id = '99999999-9999-7999-8999-999999999999';   -- manager
select is(
  (select state from refund_deposit(
     (select id from _ids where k = 'dep_clean'), 'clean return, QC clear')),
  'refunded',
  'a MANAGER refunds the clear job''s deposit — the gate opens when the work is done');

-- ---------------------------------------------------------------------------
-- Cross-org reach is refused on every door
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- org1 desk

select throws_ok(
  $$select record_ledger_entry('58888888-8888-7888-8888-888888888888',
                               'charge', 1000)$$,
  '23503', null,
  'org1 cannot charge org2''s customer');

select throws_ok(
  $$select hold_deposit('58888888-8888-7888-8888-888888888888', 1000)$$,
  '23503', null,
  'nor hold their money');

-- An org2 entry to aim a cross-org correction at.
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
insert into _ids
select 'chg_o2', id from record_ledger_entry(
  '58888888-8888-7888-8888-888888888888', 'charge', 5000);

select throws_ok(
  $$select apply_deposit((select id from _ids where k = 'dep_clean'), 1)$$,
  '23503', null,
  'org2 cannot touch org1''s deposit');

select throws_ok(
  $$select refund_deposit((select id from _ids where k = 'dep_out'))$$,
  '23503', null,
  'nor refund it');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
select throws_ok(
  $$select record_ledger_entry('51111111-1111-7111-8111-111111111111',
      'charge', 5000, null, null, 'aimed abroad',
      (select id from _ids where k = 'chg_o2'))$$,
  '23503', null,
  'a correction cannot target another org''s entry');

-- ---------------------------------------------------------------------------
-- Read-side role gates: zero ROWS, never zero balances
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse

select is((select count(*)::int from customer_ledger_entries), 0,
  'a warehouse phone reads zero ledger rows');

select is((select count(*)::int from deposits), 0,
  'and zero deposits');

select is((select count(*)::int from customer_balances), 0,
  'and zero BALANCE rows — not every customer at Rs 0, which would be a lie');

select ok((select count(*) from customers) > 0,
  'while the customer list itself stays visible — the dock needs the name, not the money');

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
select is((select count(*)::int from customer_balances), 4,
  'the desk sees every live customer''s balance');

set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';   -- org2 owner
select is((select count(*)::int from customer_balances), 1,
  'org2 sees exactly its own customer, nobody else''s rupees');

-- ---------------------------------------------------------------------------
-- customer_credentials (override 16, D9)
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

select lives_ok(
  $$insert into customer_credentials
      (id, org_id, customer_id, kind, cnic_photo_path, verified_by, verified_at)
    values ('81111111-1111-7111-8111-111111111111',
            '11111111-1111-7111-8111-111111111111',
            '53333333-3333-7333-8333-333333333333', 'cnic_photo',
            '11111111-1111-7111-8111-111111111111/3f2a9c…',
            'ffffffff-ffff-7fff-8fff-ffffffffffff', now())$$,
  'the desk records a verified CNIC photo — an opaque storage key, never a URL');

select throws_ok(
  $$insert into customer_credentials (org_id, customer_id, kind)
    values ('11111111-1111-7111-8111-111111111111',
            '53333333-3333-7333-8333-333333333333', 'cnic_photo')$$,
  '23514', null,
  'a cnic_photo credential without its photo is substance-free and refused');

select throws_ok(
  $$insert into customer_credentials
      (org_id, customer_id, kind, guarantor_name, verified_at)
    values ('11111111-1111-7111-8111-111111111111',
            '53333333-3333-7333-8333-333333333333', 'guarantor', 'Haji Sahb', now())$$,
  '23514', null,
  'verification without a verifier does not exist');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$insert into customer_credentials (org_id, customer_id, kind, guarantor_name)
    values ('11111111-1111-7111-8111-111111111111',
            '53333333-3333-7333-8333-333333333333', 'guarantor', 'X')$$,
  '42501', null,
  'a warehouse phone cannot write credentials');

select is((select count(*)::int from customer_credentials), 0,
  'nor read them — a guarantor''s phone number never reaches a warehouse Redmi');

-- The re-homing attack the org-scoped UPDATE policy exists to stop: org2
-- runs a WHERE-less UPDATE claiming every credential as its own.
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
select lives_ok(
  $$update customer_credentials
       set org_id = '22222222-2222-7222-8222-222222222222',
           customer_id = '58888888-8888-7888-8888-888888888888'$$,
  'org2''s blanket UPDATE runs…');

set local role postgres;
select is(
  (select org_id from customer_credentials
    where id = '81111111-1111-7111-8111-111111111111'),
  '11111111-1111-7111-8111-111111111111'::uuid,
  '…and re-homes NOTHING — the USING clause is org-scoped, so 0 rows were ever in reach');
set local role papa_app;

-- ---------------------------------------------------------------------------
-- verified_customers: the fast lane is DERIVED, and it derives strictly
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

select ok(
  (select fast_lane from verified_customers
    where customer_id = '53333333-3333-7333-8333-333333333333'),
  'verified credential + one clean completed rental + nothing short = the fast lane');

select ok(
  not (select fast_lane from verified_customers
        where customer_id = '52222222-2222-7222-8222-222222222222'),
  'a customer with open shortfalls does not ride it, whatever documents they hold');

select lives_ok(
  $$update customers set blacklisted = true
     where id = '53333333-3333-7333-8333-333333333333'$$,
  'the desk blacklists the star customer for a moment');

select ok(
  not (select fast_lane from verified_customers
        where customer_id = '53333333-3333-7333-8333-333333333333'),
  'blacklisted beats verified — the gate is not a points programme');

update customers set blacklisted = false
 where id = '53333333-3333-7333-8333-333333333333';

select lives_ok(
  $$update customer_credentials set expires_at = now() - interval '1 day'
     where id = '81111111-1111-7111-8111-111111111111'$$,
  'and lets the CNIC lapse');

select ok(
  not (select verified from verified_customers
        where customer_id = '53333333-3333-7333-8333-333333333333'),
  'an expired credential verifies nothing');

update customer_credentials set expires_at = null
 where id = '81111111-1111-7111-8111-111111111111';

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select ok(
  not (select verified from verified_customers
        where customer_id = '53333333-3333-7333-8333-333333333333'),
  'under a non-money role the credentials are invisible, so verified reads FALSE — the stricter direction, on purpose');

-- The first-checkout gate primitive (override 16).
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

select ok(
  customer_needs_credentials('52222222-2222-7222-8222-222222222222', 10000000),
  'an unproven customer taking Rs 100,000 of gear needs documents (the default threshold)');

select ok(
  not customer_needs_credentials('52222222-2222-7222-8222-222222222222', 9999999),
  'below the threshold nobody is bothered');

select ok(
  not customer_needs_credentials('53333333-3333-7333-8333-333333333333', 99999999),
  'the verified regular walks through at any value — the fast lane is the point');

set local role postgres;
update orgs
   set settings = settings
       || jsonb_build_object('new_customer_value_threshold_minor', 500000)
 where id = '11111111-1111-7111-8111-111111111111';
set local role papa_app;

select ok(
  customer_needs_credentials('52222222-2222-7222-8222-222222222222', 600000),
  'the org threshold overrides the default (0001 settings key)');

select ok(
  not customer_needs_credentials('52222222-2222-7222-8222-222222222222', 400000),
  'and still bounds from below');

-- ---------------------------------------------------------------------------
-- The PII guard stays at zero — and would actually fire
-- ---------------------------------------------------------------------------
select is((select count(*)::int from sync_pii_violations()), 0,
  'no sensitive column lives on any syncable table — the money book adds nothing to sync');

select is((select count(*)::int from sync_exclusion_violations()), 0,
  'and every reviewed exclusion still holds');

set local role postgres;
create table pii_canary (org_id uuid, guarantor_phone text, change_seq bigint);
select is(
  (select count(*)::int from sync_pii_violations() v
    where v.table_name = 'pii_canary'),
  1,
  'a guarantor column on a syncable-shaped table WOULD trip the guard — the pattern is live, not decorative');
drop table pii_canary;

-- ---------------------------------------------------------------------------
-- Rate limits (D8, the 0016 shape). Buckets are primed in both the current
-- and the next window so a minute boundary cannot un-prime them mid-test.
-- ---------------------------------------------------------------------------
insert into rate_limits (bucket, window_start, count)
select 'money:11111111-1111-7111-8111-111111111111:ffffffff-ffff-7fff-8fff-ffffffffffff',
       w, 999
  from unnest(array[
    date_bin('1 minute', now(), timestamptz 'epoch'),
    date_bin('1 minute', now(), timestamptz 'epoch') + interval '1 minute']) w
on conflict (bucket, window_start) do update set count = 999;

insert into rate_limits (bucket, window_start, count)
select 'refund:11111111-1111-7111-8111-111111111111:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
       w, 999
  from unnest(array[
    date_bin('1 minute', now(), timestamptz 'epoch'),
    date_bin('1 minute', now(), timestamptz 'epoch') + interval '1 minute']) w
on conflict (bucket, window_start) do update set count = 999;

set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

select throws_ok(
  $$select record_payment('51111111-1111-7111-8111-111111111111', 1000)$$,
  '53300', null,
  'a runaway desk client hits the shared money budget (60/min)');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
select throws_ok(
  $$select refund_deposit((select id from _ids where k = 'dep_out'))$$,
  '53300', null,
  'refunds have their own, tighter budget (6/min) — checked before anything else is even looked up');

select * from finish();
rollback;
