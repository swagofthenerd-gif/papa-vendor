-- ============================================================================
-- 0029 — The do-not-rent decision, tested for the property it ACTUALLY has
-- (the 0007 rule).
--
--   * structure: one DEFINER door, search_path pinned, papa_app-only;
--   * the tier: owner and manager yes; desk, warehouse, driver and readonly
--     refused — a standing refusal of business is not desk work;
--   * override 18: switching it ON with no reason is refused, and the
--     reason lands in the audit log, which is the only place a boolean's
--     WHY can live;
--   * both directions audited, and a second tap that changes nothing
--     writes no second audit row;
--   * tenancy by hand: another org's customer is invisible to this one;
--   * and the whole point — 0022 D9's confirm gate now has a switch:
--     confirm_booking refuses the blacklisted client BY NAME and stands
--     down again when the flag is lifted.
-- ============================================================================
begin;
select plan(18);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos',
   '{"new_customer_value_threshold_minor": 100000000000}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran', '{}'::jsonb);

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Chacha the driver'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Auditor'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk'),
  ('99999999-9999-7999-8999-999999999999', 'Nadia the manager'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (Kamran owner)');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver'),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly'),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('11111111-1111-7111-8111-111111111111', '99999999-9999-7999-8999-999999999999', 'manager'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into customers (id, org_id, name, phone) values
  ('50000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'Zindagi Films', '03001234567'),
  ('50000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'Kamran Client', null);

insert into products (id, org_id, category, display_name, tracking_mode) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'camera', 'Sony FX9', 'serialized');

insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-A');

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Structure                                                     [1–3]
-- ---------------------------------------------------------------------------
select has_function('set_customer_blacklisted', array['uuid', 'boolean', 'text']);
select ok(
  (select p.prosecdef and p.proconfig::text like '%search_path=public%'
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'set_customer_blacklisted'),
  'the 0029 door is DEFINER with search_path pinned');
select ok(
  not has_function_privilege('public', 'set_customer_blacklisted(uuid, boolean, text)', 'execute')
  and has_function_privilege('papa_app', 'set_customer_blacklisted(uuid, boolean, text)', 'execute'),
  'the door is papa_app''s and nobody else''s');

-- ---------------------------------------------------------------------------
-- Override 18: no reason, no refusal                            [4–5]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
set local role papa_app;

select throws_ok(
  $$select set_customer_blacklisted('50000000-0000-7000-8000-000000000003', true, null)$$,
  '23514', null,
  'switching it ON with no reason is refused — the audit row is the record');
select throws_ok(
  $$select set_customer_blacklisted('50000000-0000-7000-8000-000000000003', true, '   ')$$,
  '23514', null,
  'and whitespace is not a reason');

-- ---------------------------------------------------------------------------
-- The owner's decision, audited                                 [6–8]
-- ---------------------------------------------------------------------------
select is(
  (select (set_customer_blacklisted('50000000-0000-7000-8000-000000000003', true,
           'Cheque bounced twice, gear returned late')).blacklisted),
  true, 'the owner sets the flag');

set local role postgres;
select is(
  (select a.subject_label from audit_log a
    where a.action = 'customer_blacklisted'
      and a.subject_id = '50000000-0000-7000-8000-000000000003'),
  'Cheque bounced twice, gear returned late',
  'the WHY is in the audit log, where a boolean cannot carry it');

-- A second tap is not a second decision.
set local role papa_app;
select set_customer_blacklisted('50000000-0000-7000-8000-000000000003', true, 'Same again');
set local role postgres;
select is(
  (select count(*)::int from audit_log a
    where a.action = 'customer_blacklisted'
      and a.subject_id = '50000000-0000-7000-8000-000000000003'),
  1, 'setting it to what it already is writes no second audit row');

-- ---------------------------------------------------------------------------
-- 0022 D9's gate finally has a switch                           [9–12]
-- ---------------------------------------------------------------------------
set local papa.org_id    = '11111111-1111-7111-8111-111111111111';
set local papa.user_id   = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
set local papa.device_id = 'WH-01';
set local role papa_app;

create temp table _b on commit drop as
  select (create_booking('50000000-0000-7000-8000-000000000003',
                         tstzrange('2026-10-01', '2026-10-03', '[)'),
                         '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb,
                         'pencil') ->> 'booking_id')::uuid as id;

select throws_ok(
  format($$select confirm_booking(%L)$$, (select id from _b)),
  '23514', null,
  'a blacklisted customer cannot be confirmed — the gate has a switch now');

select is(
  (select (set_customer_blacklisted('50000000-0000-7000-8000-000000000003', false, null)).blacklisted),
  false, 'lifting it needs no reason — nobody is being refused');
select lives_ok(
  format($$select confirm_booking(%L)$$, (select id from _b)),
  'and the client can be confirmed again');

set local role postgres;
select is(
  (select count(*)::int from audit_log a
    where a.action = 'customer_unblacklisted'
      and a.subject_id = '50000000-0000-7000-8000-000000000003'),
  1, 'lifting it is audited too');

-- ---------------------------------------------------------------------------
-- The tier: owner and manager only                             [13–17]
-- ---------------------------------------------------------------------------
set local papa.org_id = '11111111-1111-7111-8111-111111111111';
set local role papa_app;

set local papa.user_id = '99999999-9999-7999-8999-999999999999';   -- manager
select lives_ok(
  $$select set_customer_blacklisted('50000000-0000-7000-8000-000000000003', true, 'Manager''s call')$$,
  'a manager may refuse a client');

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
select throws_ok(
  $$select set_customer_blacklisted('50000000-0000-7000-8000-000000000003', true, 'Desk says so')$$,
  '42501', null,
  'the desk may write money but not refuse a client future business');
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select set_customer_blacklisted('50000000-0000-7000-8000-000000000003', true, 'Tech says so')$$,
  '42501', null,
  'nor can the warehouse phone');
set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- driver
select throws_ok(
  $$select set_customer_blacklisted('50000000-0000-7000-8000-000000000003', false, null)$$,
  '42501', null,
  'nor can a driver LIFT one');
set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select throws_ok(
  $$select set_customer_blacklisted('50000000-0000-7000-8000-000000000003', false, null)$$,
  '42501', null,
  'nor readonly');

-- ---------------------------------------------------------------------------
-- Tenancy by hand                                               [18]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
select throws_ok(
  $$select set_customer_blacklisted('50000000-0000-7000-8000-000000000009', true, 'Not ours')$$,
  '23503', null,
  'another org''s customer does not exist to this one');

select finish();
rollback;
