-- ============================================================================
-- 0022 / gapless booking_no under REAL concurrency
--
-- Two live connections (dblink, the 0015_hardening_settle technique): the
-- second creator blocks on the counter row, and when the first ABORTS, its
-- number is reused — a sequence would leave a hole. Committed groundwork in
-- its own org, cleaned up remotely at the end.
--
-- Its own file, deliberately: the main 0022 file wraps its fixtures in
-- fixture_rls_off()/on(), whose ALTER TABLEs hold ACCESS EXCLUSIVE locks on
-- every tenant table until the rollback — a dblink connection inserting its
-- groundwork org would deadlock against them forever. No fixture helpers
-- here, so no locks to collide with (the settle file made the same call).
-- ============================================================================
begin;
select plan(2);

set local role postgres;

create extension if not exists dblink;

select dblink_connect('bk_a', 'dbname=papa');
select dblink_connect('bk_b', 'dbname=papa');

select dblink_exec('bk_a', $sql$
  insert into orgs (id, name, slug) values
    ('99999999-9999-7999-8999-999999999998', 'Gapless House', 'gapless-bk');
  insert into users (id, display_name) values
    ('a9999999-0000-7000-8000-000000000001', 'Gapless Owner');
  insert into memberships (org_id, user_id, role) values
    ('99999999-9999-7999-8999-999999999998',
     'a9999999-0000-7000-8000-000000000001', 'owner');
  insert into customers (id, org_id, name) values
    ('c9999999-0000-7000-8000-000000000001',
     '99999999-9999-7999-8999-999999999998', 'Gapless Client');
  insert into products (id, org_id, category, display_name) values
    ('b9999999-0000-7000-8000-000000000001',
     '99999999-9999-7999-8999-999999999998', 'camera', 'Gapless Cam');
$sql$);

select dblink_exec('bk_a', 'set papa.org_id  = ''99999999-9999-7999-8999-999999999998''');
select dblink_exec('bk_a', 'set papa.user_id = ''a9999999-0000-7000-8000-000000000001''');
select dblink_exec('bk_b', 'set papa.org_id  = ''99999999-9999-7999-8999-999999999998''');
select dblink_exec('bk_b', 'set papa.user_id = ''a9999999-0000-7000-8000-000000000001''');
select dblink_exec('bk_a', 'set role papa_app');
select dblink_exec('bk_b', 'set role papa_app');

-- A opens a transaction and takes number 1 — uncommitted.
select dblink_exec('bk_a', 'begin');
create temp table _bk_a1 on commit drop as
  select (r::jsonb ->> 'booking_no') as no
    from dblink('bk_a', $sql$
      select create_booking('c9999999-0000-7000-8000-000000000001',
        tstzrange('2030-05-01', '2030-05-02', '[)'),
        '[{"product_id": "b9999999-0000-7000-8000-000000000001", "qty": 1}]'::jsonb,
        'draft')::text
    $sql$) as t(r text);

-- B tries to create and blocks behind A's counter row lock.
select dblink_send_query('bk_b', $sql$
  select create_booking('c9999999-0000-7000-8000-000000000001',
    tstzrange('2030-05-03', '2030-05-04', '[)'),
    '[{"product_id": "b9999999-0000-7000-8000-000000000001", "qty": 1}]'::jsonb,
    'draft')::text
$sql$);
select pg_sleep(0.5);

select is(
  (select dblink_is_busy('bk_b')), 1,
  'the second creator BLOCKS on the counter — numbering is serialized, not optimistic');

-- A aborts. Its number must be reused, not burned.
select dblink_exec('bk_a', 'rollback');

create temp table _bk_b1 on commit drop as
  select (r::jsonb ->> 'booking_no') as no
    from dblink_get_result('bk_b') as t(r text);
-- drain the async call (dblink requires reading until the empty set)
create temp table _bk_drain on commit drop as
  select * from dblink_get_result('bk_b') as t(r text);

select is(
  (select no from _bk_b1)
    || '/' ||
  (select r::jsonb ->> 'booking_no'
     from dblink('bk_b', $sql$
       select create_booking('c9999999-0000-7000-8000-000000000001',
         tstzrange('2030-05-05', '2030-05-06', '[)'),
         '[{"product_id": "b9999999-0000-7000-8000-000000000001", "qty": 1}]'::jsonb,
         'draft')::text
     $sql$) as t(r text)),
  (select no from _bk_a1) || '/2',
  'the aborted number is REUSED and the next follows — gapless under concurrency');

-- Remote cleanup: remote commits survive this file's rollback.
select dblink_exec('bk_a', 'reset role');
select dblink_exec('bk_a', $sql$
  delete from booking_lines
   where org_id = '99999999-9999-7999-8999-999999999998';
  delete from bookings
   where org_id = '99999999-9999-7999-8999-999999999998';
  delete from booking_counters
   where org_id = '99999999-9999-7999-8999-999999999998';
  delete from rate_limits where bucket like 'booking:99999999-9999-7999-8999-999999999998%';
  delete from customers
   where org_id = '99999999-9999-7999-8999-999999999998';
  delete from products
   where org_id = '99999999-9999-7999-8999-999999999998';
  delete from memberships
   where org_id = '99999999-9999-7999-8999-999999999998';
  -- The watermark triggers stamped this org on the groundwork inserts;
  -- its FK would abort the whole cleanup batch at the orgs delete.
  delete from org_sync_watermark
   where org_id = '99999999-9999-7999-8999-999999999998';
  delete from users where id = 'a9999999-0000-7000-8000-000000000001';
  delete from orgs where id = '99999999-9999-7999-8999-999999999998';
$sql$);

select dblink_disconnect('bk_a');
select dblink_disconnect('bk_b');

select * from finish();
rollback;
