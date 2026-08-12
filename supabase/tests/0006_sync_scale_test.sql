-- ============================================================================
-- Sync at scale
--
-- The caught-up poll is the request this system serves most: every device,
-- every few seconds, almost always with nothing to report. If that path ever
-- goes back to touching the data tables, the cost is multiplied by every
-- device in every rental house, and it will show up as a bill rather than as
-- a bug.
--
-- Timing assertions are flaky in CI, so these test the STRUCTURE that makes it
-- fast — the watermark short-circuit and the index — rather than a stopwatch.
-- ============================================================================
begin;
select plan(19);

set local role postgres;

alter table orgs disable row level security;
alter table users disable row level security;
alter table memberships disable row level security;
alter table locations disable row level security;
alter table products disable row level security;
alter table assets disable row level security;
alter table jobs disable row level security;

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal');
insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse');

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack');
insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9');

-- A few hundred assets: enough that a seq scan would be visibly wrong.
insert into assets (org_id, product_id, asset_code)
  select '11111111-1111-7111-8111-111111111111',
         '20000000-0000-7000-8000-000000000001', 'A' || g
    from generate_series(1, 300) g;

insert into assets (org_id, product_id, asset_code) values
  ('22222222-2222-7222-8222-222222222222', '20000000-0000-7000-8000-000000000001', 'OTHER-1');

alter table orgs enable row level security;
alter table users enable row level security;
alter table memberships enable row level security;
alter table locations enable row level security;
alter table products enable row level security;
alter table assets enable row level security;
alter table jobs enable row level security;

select is(
  (select count(*)::int from pg_class
    where relname in ('orgs','users','memberships','locations','products','assets','jobs')
      and relnamespace = 'public'::regnamespace and not relrowsecurity),
  0, 'RLS is back on for every table the fixtures disabled it for'
);

-- ---------------------------------------------------------------------------
-- The watermark
-- ---------------------------------------------------------------------------
select has_table('org_sync_watermark');

select ok(
  (select relforcerowsecurity from pg_class where oid = 'org_sync_watermark'::regclass),
  'the watermark forces RLS like every other tenant table'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_name = 'org_sync_watermark' and grantee = 'papa_app'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
  0,
  'clients can READ the watermark but never write it — a client that could set its own too high would silently stop receiving updates'
);

select ok(
  (select prosecdef from pg_proc where proname = 'bump_org_watermark'),
  'the watermark trigger is SECURITY DEFINER, which is how clients can write rows without writing the watermark directly'
);

select is(
  (select max_change_seq > 0 from org_sync_watermark
    where org_id = '11111111-1111-7111-8111-111111111111'),
  true, 'inserting assets advanced the org watermark'
);

-- Per-STATEMENT, not per-row: a bulk import of ten thousand assets must cost
-- one upsert, not ten thousand.
select ok(
  (select count(*) = 0 from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
    where c.relname = 'assets'
      and t.tgname like '%watermark%'
      and t.tgtype & 1 = 1),          -- bit 0 set means FOR EACH ROW
  'watermark triggers fire per STATEMENT, so a bulk import costs one upsert'
);

-- ---------------------------------------------------------------------------
-- The early out
-- ---------------------------------------------------------------------------
grant execute on all functions in schema public to papa_app;
set local role papa_app;

select ok(not (select rolsuper from pg_roles where rolname = current_user),
          'measured as a non-superuser, so RLS is in force');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select is(
  (pull_changes(999999999) ->> 'has_more')::boolean, false,
  'a caught-up device is told there is nothing'
);

select is(
  (pull_changes(999999999) ->> 'cursor')::bigint, 999999999::bigint,
  'and its cursor is handed straight back, not recomputed'
);

select is(
  jsonb_array_length(pull_changes(999999999) -> 'tables' -> 'assets'), 0,
  'with an empty payload'
);

-- Every table key is still present on the short-circuit path. A client that
-- iterates the response must not have to special-case it.
select is(
  (select count(*)::int from jsonb_object_keys(pull_changes(999999999) -> 'tables')),
  (select count(*)::int from jsonb_object_keys(pull_changes(0) -> 'tables')),
  'the short-circuit response has the same shape as a full one'
);

-- ---------------------------------------------------------------------------
-- Still correct with data
-- ---------------------------------------------------------------------------
select is(
  jsonb_array_length(pull_changes(0, 5000) -> 'tables' -> 'assets'), 300,
  'a full pull still returns everything in the org'
);

select is(
  (select count(*)::int
     from jsonb_array_elements(pull_changes(0, 5000) -> 'tables' -> 'assets') a
    where a ->> 'org_id' = '22222222-2222-7222-8222-222222222222'),
  0, 'LEAK: and nothing from another org'
);

select ok(
  (pull_changes(0, 10) -> 'tables' -> 'assets' -> 0) ? 'notes',
  'the projection keeps notes — "mount is loose" is what a tech needs at the shelf'
);

select ok(
  not ((pull_changes(0, 10) -> 'tables' -> 'assets' -> 0) ? 'purchase_price_minor'),
  'but drops columns the device never mirrors, which is bandwidth on every first sync'
);

-- ---------------------------------------------------------------------------
-- The index that keeps it fast
-- ---------------------------------------------------------------------------
select ok(
  exists (select 1 from pg_indexes
           where tablename = 'assets' and indexdef like '%org_id%change_seq%'),
  'the cursor index leads with org_id'
);

select ok(
  exists (select 1 from pg_indexes
           where tablename = 'org_sync_watermark' and indexdef like '%org_id%'),
  'and the watermark is keyed for a single-row lookup'
);

-- ---------------------------------------------------------------------------
-- Static SQL
--
-- The dynamic version re-parsed and re-planned eight RLS-wrapped queries on
-- every call. Cached plans are why the with-data path stays predictable.
-- ---------------------------------------------------------------------------
select ok(
  (select prosrc not like '%execute format%' from pg_proc where proname = 'pull_changes'),
  'pull_changes uses static SQL, so its plans are cached'
);

select * from finish();
rollback;
