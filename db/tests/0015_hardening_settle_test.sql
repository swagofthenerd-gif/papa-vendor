-- ============================================================================
-- 0015 / C1 — the real two-connection interleaving
--
-- The main 0015 file simulates an unsettled row by restamping. This file
-- produces the ACTUAL hazard with dblink: one connection holds an open
-- transaction with a LOWER change_seq while another commits a HIGHER one.
-- Before 0015 the cursor advanced to the higher seq and the in-flight row
-- landed below it on commit — never sent, never noticed. The pull itself runs
-- on a third connection, as papa_app, exactly like a device.
--
-- dblink is stock postgres contrib (no vendor anything) and is created only
-- inside this rolled-back transaction — it is test scaffolding, not schema.
--
-- The assets watermark trigger is paused for the window because concurrent
-- same-org writes serialise on the watermark row (HANDOFF §10) — the second
-- insert would simply block, which is the reason this interleaving is rare in
-- production and needs a harness to reproduce at all.
-- ============================================================================
begin;
select plan(7);

set local role postgres;

create extension if not exists dblink;

select dblink_connect('c1_writer', 'dbname=papa');
select dblink_connect('c1_holder', 'dbname=papa');
select dblink_connect('c1_device', 'dbname=papa');

-- Committed groundwork in its own org, cleaned up remotely at the end —
-- remote commits survive this file's rollback, so nothing here may leak.
select dblink_exec('c1_writer', $sql$
  insert into orgs (id, name, slug) values
    ('99999999-9999-7999-8999-999999999999', 'Settle Test House', 'settle-test');
  insert into products (id, org_id, category, display_name) values
    ('98888888-8888-7888-8888-888888888888',
     '99999999-9999-7999-8999-999999999999', 'camera', 'Settle Cam');
$sql$);

select dblink_exec('c1_writer',
  'alter table assets disable trigger assets_watermark_ins');

-- The in-flight transaction takes the LOWER change_seq and holds it open…
select dblink_exec('c1_holder', 'begin');
select dblink_exec('c1_holder', $sql$
  insert into assets (id, org_id, product_id, asset_code) values
    ('97777777-7777-7777-8777-777777777771',
     '99999999-9999-7999-8999-999999999999',
     '98888888-8888-7888-8888-888888888888', 'C1SETTLE-A1');
$sql$);

-- …while a second transaction takes the HIGHER one and commits immediately.
select dblink_exec('c1_writer', $sql$
  insert into assets (id, org_id, product_id, asset_code) values
    ('97777777-7777-7777-8777-777777777772',
     '99999999-9999-7999-8999-999999999999',
     '98888888-8888-7888-8888-888888888888', 'C1SETTLE-A2');
$sql$);

select is(
  (select count(*)::int from assets where asset_code like 'C1SETTLE-%'),
  1,
  'only the committed row is visible; the in-flight one holds a LOWER change_seq');

-- A device pulls on its own connection, as papa_app, mid-interleaving.
select dblink_exec('c1_device',
  'set papa.org_id  = ''99999999-9999-7999-8999-999999999999''');
select dblink_exec('c1_device',
  'set papa.user_id = ''99999999-9999-7999-8999-999999999999''');
select dblink_exec('c1_device', 'set role papa_app');

create temp table c1_pull1 on commit drop as
  select (j::jsonb) as p
    from dblink('c1_device', 'select pull_changes(0)::text') as t(j text);

select ok(
  (select (p ->> 'cursor')::bigint from c1_pull1)
    < (select change_seq from assets where asset_code = 'C1SETTLE-A2'),
  'the cursor is HELD BELOW the committed row while a concurrent transaction is still open');

select ok(
  exists (select 1 from c1_pull1,
                        jsonb_array_elements(p -> 'tables' -> 'assets') a
           where a ->> 'asset_code' = 'C1SETTLE-A2'),
  'the committed row is still delivered — only the cursor waits');

select ok(
  not exists (select 1 from c1_pull1,
                            jsonb_array_elements(p -> 'tables' -> 'assets') a
               where a ->> 'asset_code' = 'C1SETTLE-A1'),
  'the in-flight row is, of course, not delivered yet');

select is(
  (select (p ->> 'has_more')::boolean from c1_pull1),
  false,
  'and the holdback does not report has_more — nothing more is fetchable right now');

-- The straggler commits, landing BELOW the cursor the old code returned.
select dblink_exec('c1_holder', 'commit');

select is(
  (select count(*)::int from assets where asset_code like 'C1SETTLE-%'),
  2,
  'the straggler lands, with the lower change_seq');

create temp table c1_pull2 on commit drop as
  select (j::jsonb) as p
    from dblink('c1_device',
                format('select pull_changes(%s)::text',
                       (select (p ->> 'cursor')::bigint from c1_pull1))) as t(j text);

select ok(
  exists (select 1 from c1_pull2,
                        jsonb_array_elements(p -> 'tables' -> 'assets') a
           where a ->> 'asset_code' = 'C1SETTLE-A1'),
  'pulling from the held-back cursor DELIVERS the straggler — before 0015 it sat below the cursor, unsent forever');

-- ---------------------------------------------------------------------------
-- Remote cleanup: everything the remote connections committed goes away, and
-- the paused trigger comes back. (Superuser deletes; RESTRICT order matters.)
-- ---------------------------------------------------------------------------
select dblink_exec('c1_writer',
  'alter table assets enable trigger assets_watermark_ins');
select dblink_exec('c1_writer', $sql$
  delete from assets where asset_code like 'C1SETTLE-%';
  delete from org_sync_watermark
   where org_id = '99999999-9999-7999-8999-999999999999';
  delete from products where id = '98888888-8888-7888-8888-888888888888';
  delete from orgs where id = '99999999-9999-7999-8999-999999999999';
$sql$);

select dblink_disconnect('c1_device');
select dblink_disconnect('c1_holder');
select dblink_disconnect('c1_writer');

select * from finish();
rollback;
