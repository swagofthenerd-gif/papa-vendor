-- ============================================================================
-- 0027 — The pipe: the members mirror and exactly-once for non-scan ops
--
--   * memberships is syncable and the tenth pull_changes carries a
--     `members` page: user id, display name, role, has_pin — and nothing
--     else; both sync guards stay at zero;
--   * tenancy: org B never sees org A's people; a suspended membership
--     arrives as a tombstone; a renamed person re-syncs;
--   * replay_op runs an RPC once per (device, op id) and answers a retry
--     from the receipt with the ORIGINAL reply; an error leaves no receipt;
--     a receipt is invisible to another device; the auth entry points and
--     replay_op itself cannot be replayed; arguments are bound by name and
--     typed from the signature (jsonb, tstzrange, arrays, void).
-- ============================================================================
begin;
select plan(37);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos',
   '{"new_customer_value_threshold_minor": 100000000000}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran', '{}'::jsonb);

insert into users (id, display_name, phone) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech',    '+923000000002'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner',   '+923000000001'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif the driver', '+923000000003'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Zoya suspended',    '+923000000004'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (org2 owner)', '+923000000005');

insert into memberships (org_id, user_id, role, status, pin_hash, pin_set_at) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'desk', 'active',
   crypt('4321', gen_salt('bf')), now()),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner', 'active',
   crypt('1111', gen_salt('bf')), now()),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver', 'active', null, null),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'warehouse', 'suspended', null, null),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner', 'active', null, null);

insert into devices (id, org_id, label) values
  ('WH-01', '11111111-1111-7111-8111-111111111111', 'Warehouse phone 1'),
  ('WH-02', '11111111-1111-7111-8111-111111111111', 'Warehouse phone 2');

insert into customers (id, org_id, name) values
  ('50000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Zindagi Films');

insert into products (id, org_id, category, display_name, tracking_mode) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9', 'serialized');
insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-02');

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Structure                                                     [1–5]
-- ---------------------------------------------------------------------------
select has_column('memberships', 'change_seq', 'memberships is syncable');
select ok(
  (select relforcerowsecurity from pg_class where relname = 'op_receipts' and relnamespace = 'public'::regnamespace),
  'op_receipts has RLS forced');
select ok(
  not has_function_privilege('public', 'replay_op(uuid, text, jsonb)', 'execute'),
  'replay_op is not public');
select ok(
  has_function_privilege('papa_app', 'replay_op(uuid, text, jsonb)', 'execute'),
  'papa_app may call replay_op');
select ok(
  not has_function_privilege('papa_app', 'touch_memberships_on_user_change()', 'execute'),
  'the users trigger function is nobody''s to call');

-- ---------------------------------------------------------------------------
-- The guards stay at zero                                       [6–7]
-- ---------------------------------------------------------------------------
select is((select count(*)::int from sync_pii_violations()), 0,
  'the PII guard is clean with memberships syncable');
select is((select count(*)::int from sync_exclusion_violations()), 0,
  'the exclusion guard is clean with the tenth edition');

-- ---------------------------------------------------------------------------
-- The members page                                              [8–16]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- desk
set local role papa_app;

create temp table _p1 on commit drop as select pull_changes(0) as p;

select is(
  (select count(*)::int from jsonb_object_keys(pull_changes(999999999) -> 'tables')),
  18, 'the early-out names eighteen tables, members among them');
select is(
  (select jsonb_array_length(p -> 'tables' -> 'members') from _p1), 4,
  'org A''s four memberships arrive (the driver too — a crew name, not a session)');
select is(
  (select x ->> 'display_name' from _p1, jsonb_array_elements(p -> 'tables' -> 'members') x
    where x ->> 'id' = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'),
  'Bilal the tech', 'the display name rides the membership row, keyed by user id');
select is(
  (select (x ->> 'has_pin')::boolean from _p1, jsonb_array_elements(p -> 'tables' -> 'members') x
    where x ->> 'id' = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb'),
  true, 'has_pin is true for the owner');
select is(
  (select (x ->> 'has_pin')::boolean from _p1, jsonb_array_elements(p -> 'tables' -> 'members') x
    where x ->> 'id' = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc'),
  false, 'and false for the driver, who gets none');
select is(
  (select x ->> 'role' from _p1, jsonb_array_elements(p -> 'tables' -> 'members') x
    where x ->> 'id' = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc'),
  'driver', 'the role rides along');
select isnt(
  (select x ->> 'deleted_at' from _p1, jsonb_array_elements(p -> 'tables' -> 'members') x
    where x ->> 'id' = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd'),
  null, 'a suspended membership is a tombstone: the person leaves the picker');
select is(
  (select array_agg(k order by k) from _p1, jsonb_array_elements(p -> 'tables' -> 'members') x, jsonb_object_keys(x) k
    where x ->> 'id' = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'),
  array['change_seq', 'created_at', 'deleted_at', 'display_name', 'has_pin', 'id', 'org_id', 'role', 'updated_at'],
  'and NOTHING else: no phone, no hash, no permissions');
select is(
  (select count(*)::int from _p1, jsonb_array_elements(p -> 'tables' -> 'members') x
    where x ->> 'id' = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee'),
  0, 'org B''s owner is not in org A''s page');

-- ---------------------------------------------------------------------------
-- A rename re-syncs the person                                  [17–18]
-- ---------------------------------------------------------------------------
-- The cursor is captured while still papa_app: a temp table made as
-- postgres is not readable once the role switches back.
create temp table _c1 on commit drop as select (p ->> 'cursor')::bigint as c from _p1;
set local role postgres;
update users set display_name = 'Bilal Ahmed' where id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
set local role papa_app;
create temp table _p2 on commit drop as select pull_changes((select c from _c1)) as p;
select is(
  (select jsonb_array_length(p -> 'tables' -> 'members') from _p2), 1,
  'after a rename exactly that membership is above the cursor');
select is(
  (select x ->> 'display_name' from _p2, jsonb_array_elements(p -> 'tables' -> 'members') x), 'Bilal Ahmed',
  'and it carries the new name');

-- ---------------------------------------------------------------------------
-- Tenancy from the other side                                   [19]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
select is(
  (select jsonb_array_length(pull_changes(0) -> 'tables' -> 'members')), 1,
  'org B sees only its own owner');

-- ---------------------------------------------------------------------------
-- replay_op: exactly once                                       [20–30]
-- ---------------------------------------------------------------------------
set local papa.org_id    = '11111111-1111-7111-8111-111111111111';
set local papa.user_id   = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner: partner houses are owner/manager
set local papa.device_id = 'WH-01';

create temp table _r on commit drop as
  select replay_op('019a0000-0000-7000-8000-000000000001', 'upsert_partner_house',
                   '{"p_name": "Kamran Rentals", "p_phone": "+923001234567"}'::jsonb) as r;

select is((select (r ->> 'duplicate')::boolean from _r), false, 'the first call runs the RPC');
select isnt((select r -> 'reply' ->> 'id' from _r), null, 'and returns its reply — the server-minted id');
select is((select count(*)::int from partner_houses), 1, 'one partner house exists');

create temp table _r2 on commit drop as
  select replay_op('019a0000-0000-7000-8000-000000000001', 'upsert_partner_house',
                   '{"p_name": "Kamran Rentals", "p_phone": "+923001234567"}'::jsonb) as r;
select is((select (r ->> 'duplicate')::boolean from _r2), true, 'the SAME op id again is a duplicate');
select is((select r -> 'reply' ->> 'id' from _r2), (select r -> 'reply' ->> 'id' from _r),
  'answered with the ORIGINAL reply, the same id');
select is((select count(*)::int from partner_houses), 1, 'and the RPC did not run twice');
select is((select count(*)::int from op_receipts), 1, 'one receipt, visible to its own device');

-- Another device: the receipt is not theirs to see, so the same op id is a
-- fresh op for it (and the receipt it writes is its own).
set local papa.device_id = 'WH-02';
select is((select count(*)::int from op_receipts), 0, 'another device sees no receipt of WH-01''s');
set local papa.device_id = 'WH-01';

-- An error inside leaves no receipt: the retry will run the RPC for real.
select throws_ok(
  $$select replay_op('019a0000-0000-7000-8000-000000000002', 'create_booking',
      '{"p_customer_id": "50000000-0000-7000-8000-000000000001", "p_customer_period": "[2026-10-01,2026-10-03)", "p_lines": []}'::jsonb)$$,
  '22023', null,
  'the inner RPC''s refusal comes back as itself (a booking needs a line)');
select is((select count(*)::int from op_receipts where op_id = '019a0000-0000-7000-8000-000000000002'), 0,
  'and no receipt was filed for it');

-- Typed binding: tstzrange from text, jsonb through, text defaults.
create temp table _b on commit drop as
  select replay_op('019a0000-0000-7000-8000-000000000003', 'create_booking',
                   '{"p_customer_id": "50000000-0000-7000-8000-000000000001", "p_customer_period": "[2026-10-01,2026-10-03)", "p_lines": [{"asset_id": "30000000-0000-7000-8000-000000000001"}], "p_status": "pencil"}'::jsonb) as r;
select is((select r -> 'reply' ->> 'status' from _b), 'pencil',
  'a booking crossed with a tstzrange from text and jsonb lines bound by name');

-- ---------------------------------------------------------------------------
-- replay_op: the doors that stay shut, and the odd return shapes  [31–36]
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select replay_op('019a0000-0000-7000-8000-000000000004', 'replay_op', '{}'::jsonb)$$,
  '42501', null, 'replay_op cannot replay itself');
select throws_ok(
  $$select replay_op('019a0000-0000-7000-8000-000000000005', 'complete_enrolment', '{}'::jsonb)$$,
  '42501', null, 'nor mint a session');
select throws_ok(
  $$select replay_op('019a0000-0000-7000-8000-000000000006', 'no_such_rpc', '{}'::jsonb)$$,
  '42883', null, 'an unknown RPC is named as such');

-- void: cancel_booking answers null, and the receipt still exists.
create temp table _v on commit drop as
  select replay_op('019a0000-0000-7000-8000-000000000007', 'cancel_booking',
                   jsonb_build_object('p_booking_id', (select r -> 'reply' ->> 'booking_id' from _b), 'p_reason', 'client changed plans')) as r;
select is((select jsonb_typeof(r -> 'reply') from _v), 'null', 'a void RPC answers null');
select is((select count(*)::int from op_receipts where op_id = '019a0000-0000-7000-8000-000000000007'), 1,
  'and is still receipted');

-- arrays: integer[] from a JSON array.
select is(
  (select replay_op('019a0000-0000-7000-8000-000000000008', 'upsert_rate_card',
     '{"p_name": "Standard", "p_is_default": true, "p_weekend_mask": [6, 7]}'::jsonb) -> 'reply' -> 'weekend_mask'),
  '[6, 7]'::jsonb, 'an integer[] parameter is bound from a JSON array');

-- No device session: no receipt can belong to anyone.
set local papa.device_id = '';
select throws_ok(
  $$select replay_op('019a0000-0000-7000-8000-000000000009', 'upsert_partner_house', '{"p_name": "x"}'::jsonb)$$,
  '42501', null, 'replay_op needs a device session');

select * from finish();
rollback;
