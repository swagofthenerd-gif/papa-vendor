-- ============================================================================
-- The PII sync guard
--
-- The assertion that matters is the first one, and it is the kind that earns
-- its keep years later: it fails on the day someone makes a table with a cnic
-- column syncable, which is a one-line change that will look routine.
--
-- The rest prove the guard actually detects a violation rather than passing
-- vacuously. A green check that cannot go red is worse than no check — it
-- reads as coverage while providing none, which is the failure mode the RLS
-- suite already hit once in this project.
-- ============================================================================
begin;
select plan(9);

set local role postgres;

-- ---------------------------------------------------------------------------
-- The standing assertion
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from sync_pii_violations()),
  0,
  'no sensitive column lives on a syncable table'
);

-- If this fails, DO NOT delete the offending row from sync_sensitive_columns.
-- Split the table: the syncable half without the column, a private half with
-- it that is never passed to make_syncable().
select is(
  (select string_agg(table_name || '.' || column_name, ', ' order by table_name)
     from sync_pii_violations()),
  null,
  'and the violation list is empty rather than merely counted as zero'
);

-- ---------------------------------------------------------------------------
-- The guard detects a real violation
--
-- Built by hand rather than by calling make_syncable(), which would attach
-- triggers and a sequence default this test has no need for. What makes a
-- table syncable to the guard is the presence of change_seq, so that is what
-- is reproduced.
-- ---------------------------------------------------------------------------
create table guard_probe (
  id         uuid primary key default uuid_generate_v7(),
  org_id     uuid not null,
  cnic       text,
  change_seq bigint
);

select is(
  (select count(*)::int from sync_pii_violations()),
  1,
  'a cnic column on a syncable table is detected'
);

select is(
  (select table_name from sync_pii_violations()),
  'guard_probe',
  'and the offending table is named'
);

select is(
  (select column_name from sync_pii_violations()),
  'cnic',
  'and the offending column is named'
);

-- The same column on a NON-syncable table is fine. This is the whole point:
-- the data may exist server-side, it just may not travel to a phone.
alter table guard_probe drop column change_seq;

select is(
  (select count(*)::int from sync_pii_violations()),
  0,
  'the same column is fine on a table that does not sync'
);

drop table guard_probe;

-- ---------------------------------------------------------------------------
-- Case-insensitivity, because a future migration will not match our casing
-- ---------------------------------------------------------------------------
create table guard_probe_case (
  id         uuid primary key default uuid_generate_v7(),
  "CNIC"     text,
  change_seq bigint
);

select is(
  (select count(*)::int from sync_pii_violations()),
  1,
  'detection is case-insensitive'
);

drop table guard_probe_case;

-- ---------------------------------------------------------------------------
-- The registry is readable but not writable by the app role
--
-- A guard the application can edit is not a guard. papa_app has no DELETE
-- grant anywhere by design; this confirms the registry inherits that.
-- ---------------------------------------------------------------------------
set local role papa_app;

select ok(
  (select count(*) from sync_sensitive_columns) > 0,
  'papa_app can read the registry'
);

select throws_ok(
  $$ delete from sync_sensitive_columns where column_name = 'cnic' $$,
  '42501',
  null,
  'papa_app cannot delete from the registry'
);

select * from finish();
rollback;
