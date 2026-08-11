-- ============================================================================
-- Tenancy and RLS
--
-- The cross-org leak test is the single most important test in this codebase.
-- Multi-tenancy cannot be retrofitted, and a leak here is not a bug report —
-- it is a competitor reading a rental house's fleet, purchase prices and
-- customer list.
--
-- Run:  psql -f supabase/tests/0001_tenancy_test.sql
-- ============================================================================
begin;
select plan(41);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select has_table('orgs');
select has_table('users');
select has_table('memberships');

select has_function('uuid_generate_v7');
select has_function('current_org_id');
select has_function('current_user_id');
select has_function('has_role');

-- RLS enabled AND forced. Forcing matters: without it the table owner and any
-- SECURITY DEFINER function owned by it bypass every policy silently, which is
-- how a leak test passes while the application leaks.
select is(relrowsecurity,  true, 'orgs has RLS enabled')
  from pg_class where oid = 'orgs'::regclass;
select is(relforcerowsecurity, true, 'orgs FORCES RLS (owner is not exempt)')
  from pg_class where oid = 'orgs'::regclass;
select is(relforcerowsecurity, true, 'users FORCES RLS')
  from pg_class where oid = 'users'::regclass;
select is(relforcerowsecurity, true, 'memberships FORCES RLS')
  from pg_class where oid = 'memberships'::regclass;

-- ---------------------------------------------------------------------------
-- UUIDv7 — version and variant bits, and time ordering
--
-- Worth testing rather than trusting: the first implementation used bit-string
-- concatenation and silently produced version 0 UUIDs, which look fine.
-- ---------------------------------------------------------------------------
select is(substring(uuid_generate_v7()::text, 15, 1), '7', 'uuid_generate_v7 sets version 7');
select ok(substring(uuid_generate_v7()::text, 20, 1) in ('8','9','a','b'),
          'uuid_generate_v7 sets the RFC 4122 variant');

select is((select count(distinct u)::int from (select uuid_generate_v7() u from generate_series(1,500)) s),
          500, 'uuid_generate_v7 is collision-free over 500 draws');

-- Time ordering is the reason we use v7 at all: index locality, and meaningful
-- sort of IDs minted on an offline device. Checked pairwise across a sequence
-- generated with real elapsed time between draws.
-- Note the shape: uuid_generate_v7() is called directly in the select list, not
-- inside a scalar subquery. An uncorrelated scalar subquery is evaluated ONCE
-- for the whole statement, so the first version of this test compared ten
-- copies of the same UUID and reported every pair out of order.
select is(
  (with s as materialized (
     select i, pg_sleep(0.002), uuid_generate_v7() as u
     from generate_series(1, 10) i
   )
   select count(*)::int from s a join s b on a.i < b.i and a.u >= b.u),
  0,
  'uuid_generate_v7 is time-ordered across draws'
);

-- ---------------------------------------------------------------------------
-- Fixtures — two orgs, three people
--
-- Created before any RLS context is set. The test role is the table owner and
-- FORCE RLS applies to it too, so seeding happens with policies temporarily
-- disabled rather than by accident.
-- ---------------------------------------------------------------------------
alter table orgs        disable row level security;
alter table users       disable row level security;
alter table memberships disable row level security;

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos Rentals',  'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran Cine Hub','kamran');

insert into users (id, display_name, phone) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal (Lumos warehouse)', '+923001111111'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Sara (Lumos owner)',      '+923002222222'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Imran (Kamran owner)',    '+923003333333');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('22222222-2222-7222-8222-222222222222', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'owner');

alter table orgs        enable row level security;
alter table users       enable row level security;
alter table memberships enable row level security;

-- ---------------------------------------------------------------------------
-- Drop to the application role.
--
-- THIS LINE IS THE TEST. Superusers bypass RLS entirely, and FORCE ROW LEVEL
-- SECURITY does not change that — FORCE only removes the table *owner's*
-- exemption. Run these assertions as postgres and every one of them passes
-- vacuously while proving nothing.
--
-- pgTAP's own functions need to be callable by the role too; the grant is
-- inside this transaction and is rolled back with it.
-- ---------------------------------------------------------------------------
grant execute on all functions in schema public to papa_app;
set local role papa_app;

select ok(not (select rolsuper from pg_roles where rolname = current_user),
          'tests run as a NON-SUPERUSER, or RLS proves nothing');
select ok(not (select rolbypassrls from pg_roles where rolname = current_user),
          'and the role cannot bypass RLS');

-- ---------------------------------------------------------------------------
-- THE LEAK TEST
--
-- Act as Bilal at Lumos and assert that Kamran Cine Hub is invisible in every
-- direction. Any new tenant table must gain an equivalent block here; a table
-- without one should fail CI.
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select is(current_org_id(),  '11111111-1111-7111-8111-111111111111'::uuid, 'org context resolves');
select is(current_user_id(), 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'::uuid, 'user context resolves');

select is((select count(*)::int from orgs), 1, 'sees exactly one org');
select is((select slug from orgs), 'lumos', 'and it is their own');
select is((select count(*)::int from orgs where slug = 'kamran'), 0,
          'LEAK: another org must not be selectable even when named directly');

select is((select count(*)::int from memberships), 2,
          'sees only their own org''s memberships');
select is((select count(*)::int from memberships
           where org_id = '22222222-2222-7222-8222-222222222222'), 0,
          'LEAK: another org''s memberships must not be selectable');

-- Colleagues yes, strangers no. The scanner shows actor names on every event
-- and needs them offline, so this is scoped to shared orgs rather than to self.
select is((select count(*)::int from users), 2, 'sees self and colleague');
select is((select count(*)::int from users
           where id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc'), 0,
          'LEAK: a user from another org must not be selectable');

-- ---------------------------------------------------------------------------
-- Role gates
-- ---------------------------------------------------------------------------
select ok(has_role('warehouse'),            'has_role is true for the held role');
select ok(not has_role('owner'),            'has_role is false for a role not held');
select ok(has_role('warehouse', 'driver'),  'has_role accepts several roles');

-- A warehouse tech may not rewrite the org record.
update orgs set name = 'Hacked' where id = current_org_id();
select is((select name from orgs where id = current_org_id()), 'Lumos Rentals',
          'a warehouse role cannot update the org');

-- ...nor invent themselves a promotion.
select throws_ok(
  $$insert into memberships (org_id, user_id, role)
    values (current_org_id(), 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'owner')$$,
  '42501',
  null,
  'a warehouse role cannot create memberships'
);

-- ...and cannot write into another org even with a valid-looking row.
select throws_ok(
  $$insert into memberships (org_id, user_id, role)
    values ('22222222-2222-7222-8222-222222222222',
            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'owner')$$,
  '42501',
  null,
  'LEAK: cannot insert a membership into another org'
);

-- ---------------------------------------------------------------------------
-- Owner of the same org
-- ---------------------------------------------------------------------------
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select ok(has_role('owner'), 'the owner holds the owner role');

update orgs set name = 'Lumos Rentals Pvt Ltd' where id = current_org_id();
select is((select name from orgs where id = current_org_id()), 'Lumos Rentals Pvt Ltd',
          'an owner can update their own org');

-- Even an owner is confined to their own tenant.
update orgs set name = 'Owned' where id = '22222222-2222-7222-8222-222222222222';
select is((select count(*)::int from orgs where name = 'Owned'), 0,
          'LEAK: an owner cannot update another org');

-- ---------------------------------------------------------------------------
-- Suspension takes effect immediately
--
-- Matters because a fired employee's device keeps a full local copy and keeps
-- queueing writes until it next reaches the server.
-- ---------------------------------------------------------------------------
update memberships set status = 'suspended'
  where user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
select is((select count(*)::int from orgs), 0, 'a suspended member sees no org');
select ok(not has_role('warehouse'), 'a suspended member holds no role');

-- ---------------------------------------------------------------------------
-- No context at all — an unauthenticated or mis-minted token
-- ---------------------------------------------------------------------------
set local papa.org_id  = '';
set local papa.user_id = '';

select is(current_org_id(), null, 'a missing org claim resolves to null, not an error');
select is((select count(*)::int from orgs), 0, 'no context sees no orgs');
select is((select count(*)::int from memberships), 0, 'no context sees no memberships');
select is((select count(*)::int from users), 0, 'no context sees no users');

select * from finish();
rollback;
