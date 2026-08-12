-- ============================================================================
-- The sync read path
--
-- The property that matters most here is the one that is invisible when it
-- breaks: a pull must never SKIP a row. A device silently missing an asset
-- looks exactly like a device that is up to date.
-- ============================================================================
begin;
select plan(27);

set local role postgres;

alter table orgs disable row level security;
alter table users disable row level security;
alter table memberships disable row level security;
alter table locations disable row level security;
alter table products disable row level security;
alter table assets disable row level security;
alter table asset_tags disable row level security;
alter table jobs disable row level security;

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('22222222-2222-7222-8222-222222222222', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner');

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack');

insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9'),
  ('20000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222', 'camera', 'RED Komodo');

insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', '20000000-0000-7000-8000-000000000001', 'FX9-02'),
  ('30000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222', '20000000-0000-7000-8000-000000000009', 'KOM-01');

insert into jobs (id, org_id, label) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Zindagi Films');

alter table orgs enable row level security;
alter table users enable row level security;
alter table memberships enable row level security;
alter table locations enable row level security;
alter table products enable row level security;
alter table assets enable row level security;
alter table asset_tags enable row level security;
alter table jobs enable row level security;

select is(
  (select count(*)::int from pg_class
    where relname in ('orgs','users','memberships','locations','products','assets','asset_tags','jobs')
      and relnamespace = 'public'::regnamespace and not relrowsecurity),
  0, 'RLS is back on for every table the fixtures disabled it for'
);

-- ---------------------------------------------------------------------------
-- The cursor column
-- ---------------------------------------------------------------------------
select has_column('assets', 'change_seq');
select has_column('asset_tags', 'change_seq');
select has_column('jobs', 'change_seq');

select ok(
  exists (select 1 from pg_indexes
           where tablename = 'assets' and indexdef like '%org_id%change_seq%'),
  'the cursor index leads with org_id — without it every pull is a seq scan'
);

select is(
  (select count(*)::int from assets where change_seq is null), 0,
  'rows that existed before the column was added were backfilled, not skipped'
);

grant execute on all functions in schema public to papa_app;
set local role papa_app;

select ok(not (select rolsuper from pg_roles where rolname = current_user),
          'the suite runs as a non-superuser, so RLS actually applies');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

-- ---------------------------------------------------------------------------
-- A first pull
-- ---------------------------------------------------------------------------
select is(
  jsonb_array_length(pull_changes(0) -> 'tables' -> 'assets'), 1,
  'a full pull from cursor 0 returns this org''s assets'
);

select is(
  (pull_changes(0) -> 'tables' -> 'assets' -> 0 ->> 'asset_code'), 'FX9-02',
  'and they are the right ones'
);

select ok((pull_changes(0) ->> 'cursor')::bigint > 0, 'the pull returns a cursor');
select isnt(pull_changes(0) ->> 'server_time', null,
            'and the server time, which is how the device measures its own clock skew');

-- ---------------------------------------------------------------------------
-- THE LEAK TEST
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
     from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'assets') a
    where a ->> 'org_id' = '22222222-2222-7222-8222-222222222222'),
  0, 'LEAK: a pull never returns another org''s assets'
);

select is(
  (select count(*)::int
     from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'products') p
    where p ->> 'org_id' = '22222222-2222-7222-8222-222222222222'),
  0, 'LEAK: nor another org''s products'
);

-- There is no org filter in pull_changes and there must not be one. RLS does
-- it, so tenancy lives in exactly one place and cannot drift.
-- The DATA queries must carry no org filter: RLS is the only gate on synced
-- rows, so tenancy lives in one place and cannot drift. The single permitted
-- mention is the watermark lookup, which is a keyed read of one bookkeeping
-- row (and is itself RLS-protected) rather than a filter standing in for RLS.
select is(
  (select count(*)::int
     from regexp_matches(
       (select prosrc from pg_proc where proname = 'pull_changes'),
       'org_id = current_org_id\(\)', 'g')),
  1,
  'the ONLY org_id reference in pull_changes is the watermark lookup — data queries rely on RLS'
);

select ok(
  (select prosrc like '%org_sync_watermark where org_id = current_org_id()%'
     from pg_proc where proname = 'pull_changes'),
  'and that one reference is exactly the watermark lookup'
);

-- ---------------------------------------------------------------------------
-- Incremental pulls
-- ---------------------------------------------------------------------------
select is(
  jsonb_array_length(pull_changes((pull_changes(0) ->> 'cursor')::bigint) -> 'tables' -> 'assets'),
  0, 'pulling again from the returned cursor yields nothing new'
);

-- A change bumps the sequence and reappears.
update assets set notes = 'scratched mount' where asset_code = 'FX9-02';

select is(
  jsonb_array_length(
    pull_changes((select max(change_seq) - 1 from assets)) -> 'tables' -> 'assets'),
  1, 'an updated row reappears in the next pull'
);

select is(
  (pull_changes((select max(change_seq) - 1 from assets)) -> 'tables' -> 'assets' -> 0 ->> 'notes'),
  'scratched mount', 'carrying the new value'
);

-- ---------------------------------------------------------------------------
-- Soft deletes ARE the tombstones
--
-- The row keeps syncing with deleted_at set, and the client removes it from
-- its mirror. No separate tombstone table, and no way for a delete to be
-- missed by a device that happened to be offline when it happened.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$update jobs set deleted_at = now() where label = 'Zindagi Films'$$,
  'a job is soft-deleted'
);

select is(
  (select count(*)::int
     from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'jobs') j
    where j ->> 'deleted_at' is not null),
  1, 'the deleted row still syncs, carrying deleted_at as its tombstone'
);

-- ---------------------------------------------------------------------------
-- Monotonicity — the property that stops a pull SKIPPING a row
--
-- A timestamp cursor loses writes: two transactions can take their timestamp
-- at start and commit in the other order, so a row becomes visible with an
-- updated_at earlier than a cursor the client already passed. It is then
-- never sent again, the device is missing an asset, and neither side knows.
-- ---------------------------------------------------------------------------
select is(
  (select count(distinct change_seq)::int from assets), (select count(*)::int from assets),
  'change_seq is unique across rows'
);

select ok(
  (select max(change_seq) from assets) > (select min(change_seq) from assets)
  or (select count(*) from assets) = 1,
  'and strictly increases with each write'
);

-- Walking the cursor in small pages must visit every row exactly once. This is
-- the assertion that a pull cannot skip.
do $$
declare
  cur bigint := 0;
  seen int := 0;
  page jsonb;
  total int;
begin
  select count(*) into total from assets;
  for _i in 1..20 loop
    page := pull_changes(cur, 1);
    seen := seen + jsonb_array_length(page -> 'tables' -> 'assets');
    exit when (page ->> 'cursor')::bigint = cur;
    cur := (page ->> 'cursor')::bigint;
  end loop;
  if seen < total then
    raise exception 'paging skipped rows: saw % of %', seen, total;
  end if;
end
$$;
select pass('paging through the cursor in small pages visits every row');

-- ---------------------------------------------------------------------------
-- THE SKIP REGRESSION
--
-- Tables page independently against one shared sequence, so they truncate at
-- different points. The first version of pull_changes returned max(seq) across
-- all of them, which SKIPPED ROWS permanently:
--
--   assets   at 103..107, limit 2 returns 103,104
--   products at 108,      returned in full
--   cursor advances to 108; assets 105,106,107 are below it and were never
--   sent, and never will be. The device is missing three assets and nothing
--   anywhere reports a problem.
--
-- Reproduced here so it cannot come back.
-- ---------------------------------------------------------------------------
set local role postgres;
alter table assets disable row level security;
alter table products disable row level security;

insert into assets (org_id, product_id, asset_code)
  select '11111111-1111-7111-8111-111111111111',
         '20000000-0000-7000-8000-000000000001', 'SKIP-' || g
    from generate_series(1, 5) g;

-- Written LAST, so it carries the highest change_seq of any table.
insert into products (org_id, category, display_name)
  values ('11111111-1111-7111-8111-111111111111', 'audio', 'Late product');

alter table assets enable row level security;
alter table products enable row level security;
set local role papa_app;
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select ok(
  (select (pull_changes(0, 2) ->> 'cursor')::bigint) < (select max(change_seq) from products),
  'the cursor is HELD BACK below a later table''s row when any table truncated'
);

select is(
  (with page as (select pull_changes(0, 2) p),
        cur  as (select (p ->> 'cursor')::bigint c from page),
        got  as (select a ->> 'asset_code' code
                   from page, jsonb_array_elements(p -> 'tables' -> 'assets') a)
   select count(*)::int from assets
    where change_seq <= (select c from cur)
      and asset_code not in (select code from got)),
  0,
  'NO row below the returned cursor is left unsent — the skip is gone'
);

-- Walking the whole cursor in tiny pages must eventually deliver every asset.
do $$
declare
  cur bigint := 0;
  page jsonb;
  delivered text[] := array[]::text[];
  total int;
begin
  select count(*) into total from assets;
  for _i in 1..200 loop
    page := pull_changes(cur, 2);
    select delivered || coalesce(array_agg(a ->> 'asset_code'), array[]::text[])
      into delivered
      from jsonb_array_elements(page -> 'tables' -> 'assets') a;
    exit when not (page ->> 'has_more')::boolean;
    exit when (page ->> 'cursor')::bigint = cur;   -- no forward progress
    cur := (page ->> 'cursor')::bigint;
  end loop;

  if (select count(distinct x) from unnest(delivered) x) < total then
    raise exception 'paging delivered % of % assets', 
      (select count(distinct x) from unnest(delivered) x), total;
  end if;
end
$$;
select pass('paging in pages of 2 delivers EVERY asset, across interleaved tables');

select is(
  (pull_changes((pull_changes(0) ->> 'cursor')::bigint) ->> 'has_more')::boolean, false,
  'and a caught-up device is told to stop'
);

-- ---------------------------------------------------------------------------
-- No context
-- ---------------------------------------------------------------------------
set local papa.org_id = '';
select throws_ok(
  $$select pull_changes(0)$$, '42501', null,
  'a pull with no org context is refused rather than returning everything'
);

select * from finish();
rollback;
