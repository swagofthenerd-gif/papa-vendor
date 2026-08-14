-- ============================================================================
-- RLS policies evaluate their function calls once per query, not once per row
--
-- Two things must be true and they pull against each other: the policies must
-- be FASTER, and they must still ISOLATE. A performance change to a security
-- boundary is exactly where a leak gets introduced, so both are asserted here.
-- ============================================================================
begin;
select plan(13);

set local role postgres;
select fixture_rls_off();

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');
insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal');
insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse');
insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9');

-- One large org: the case where per-row evaluation actually hurts. At 200 orgs
-- of 2,000 assets each the overhead hides inside a millisecond; it emerges when
-- a SINGLE org gets big, which is the successful-customer case.
insert into assets (org_id, product_id, asset_code)
  select '11111111-1111-7111-8111-111111111111',
         '20000000-0000-7000-8000-000000000001', 'BIG-' || g
    from generate_series(1, 5000) g;
insert into assets (org_id, product_id, asset_code) values
  ('22222222-2222-7222-8222-222222222222', '20000000-0000-7000-8000-000000000001', 'OTHER-1');

select fixture_rls_on();
analyze assets;

select is(
  (select count(*)::int from pg_class
    where relname in ('orgs','users','memberships','products','assets')
      and relnamespace = 'public'::regnamespace and not relrowsecurity),
  0, 'RLS is back on for every table the fixtures disabled it for');

-- ---------------------------------------------------------------------------
-- The optimisation is actually present
--
-- Checking the policy TEXT rather than timing: a stopwatch assertion is flaky
-- in CI, and the structural property is what we actually care about.
-- ---------------------------------------------------------------------------
-- Postgres stores the wrapped form as `( SELECT current_org_id() AS current_org_id)`,
-- so the INLINE form to forbid is a bare `= current_org_id()`.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and (coalesce(qual,'') ~ '= current_org_id\(\)'
        or coalesce(with_check,'') ~ '= current_org_id\(\)')),
  0,
  'NO policy calls current_org_id() inline — every call is wrapped so it hoists into an InitPlan');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and (coalesce(qual,'') ~ 'AND has_role\('
        or coalesce(with_check,'') ~ 'AND has_role\(')),
  0, 'and the same for has_role()');

select ok(
  (select count(*) > 10 from pg_policies
    where schemaname = 'public' and qual ~ 'SELECT current_org_id\(\)'),
  'the wrapped form is actually present across the policy set, not merely absent');

select ok(
  (select count(*) > 15 from pg_policies where schemaname = 'public'),
  'the policies still exist — this did not quietly drop them');

-- ---------------------------------------------------------------------------
-- The plan actually hoists it
-- ---------------------------------------------------------------------------
grant execute on all functions in schema public to papa_app;
set local role papa_app;
select ok(not (select rolsuper from pg_roles where rolname = current_user),
          'measured as a non-superuser, so RLS is genuinely in force');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select ok(
  (select count(*) > 0 from pg_policies
    where schemaname='public' and tablename='assets'
      and qual like '%SELECT current_org_id()%'),
  'the assets policy predicate contains a hoistable scalar subquery');

-- ---------------------------------------------------------------------------
-- ISOLATION STILL HOLDS — the part that must never regress
-- ---------------------------------------------------------------------------
select is((select count(*)::int from assets), 5000,
  'sees exactly its own org''s assets');

select is((select count(*)::int from assets where asset_code = 'OTHER-1'), 0,
  'LEAK: another org''s asset is invisible even by exact code');

select is((select count(*)::int from orgs), 1, 'sees exactly one org');
select is((select slug from orgs), 'lumos', 'and it is their own');
select is((select count(*)::int from memberships), 1, 'sees only its own memberships');

-- A warehouse role still cannot write the org record: the has_role() wrap must
-- not have changed the ANSWER, only when it is computed.
update orgs set name = 'Hacked' where id = (select current_org_id());
select is((select name from orgs where id = (select current_org_id())), 'Lumos',
  'role gates still deny — wrapping has_role() changed WHEN it evaluates, not WHAT it returns');

-- No context at all still sees nothing.
set local papa.org_id = '';
select is((select count(*)::int from assets), 0, 'no org context sees no rows');

select * from finish();
rollback;
