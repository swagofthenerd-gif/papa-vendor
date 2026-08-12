-- ============================================================================
-- Scheduled maintenance
--
-- The assertions that matter are the two about ABSENCE: a task that has never
-- run must read as overdue, and one task failing must not stop the others.
-- Both are the difference between monitoring and the appearance of it.
-- ============================================================================
begin;
select plan(11);

set local role postgres;

alter table orgs        disable row level security;
alter table users       disable row level security;
alter table devices     disable row level security;

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos');
insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal');
insert into devices (id, org_id, label, last_user_id, last_synced_at) values
  ('wh-01', '11111111-1111-7111-8111-111111111111', 'WH-01',
   'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', now() - interval '4 days');

alter table devices enable row level security;

-- ---------------------------------------------------------------------------
-- Absence reads as overdue, not as blank
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from maintenance_health where overdue),
  3,
  'before anything runs, every task reports overdue');

select is(
  (select last_run_at from maintenance_health where task = 'prune_rate_limits'),
  null,
  'and a task that never ran has no last run');

-- ---------------------------------------------------------------------------
-- A run clears it
-- ---------------------------------------------------------------------------
select is((select count(*)::int from run_maintenance()), 3,
          'run_maintenance reports on all three tasks');

select is(
  (select count(*)::int from maintenance_health where overdue),
  0,
  'nothing is overdue immediately after a run');

select is(
  (select count(*)::int from maintenance_runs where ok),
  3,
  'each task recorded a successful run');

select ok(
  (select bool_and(duration_ms >= 0) from maintenance_runs),
  'and recorded how long it took');

-- The stale device from the fixture should have been alerted, proving
-- run_maintenance actually invokes the work rather than only logging.
select is(
  (select (result ->> 'raised')::int from maintenance_runs
    where task = 'stale_device_alerts'),
  1,
  'the stale device was alerted through the maintenance entry point');

-- ---------------------------------------------------------------------------
-- Isolation — one failing task must not abandon the others
--
-- Breaking prune_rate_limits by dropping the table out from under it is
-- crude, and it reproduces the real case exactly: a dependency that is not
-- there at the moment the scheduler fires.
-- ---------------------------------------------------------------------------
alter table rate_limits rename to rate_limits_hidden;

select is(
  (select count(*)::int from run_maintenance() where not ok),
  1,
  'the broken task reports failure');

select is(
  (select count(*)::int from run_maintenance() where ok),
  2,
  'and the other two still run');

select isnt(
  (select error from maintenance_runs
    where task = 'prune_rate_limits' and not ok order by ran_at desc limit 1),
  null,
  'the failure is recorded with its error, not swallowed');

alter table rate_limits_hidden rename to rate_limits;

-- ---------------------------------------------------------------------------
-- Expired sessions go; revocations stay
--
-- These are different statements. A revoked device that merely looks expired
-- is a weaker claim than one recorded as revoked, and losing that distinction
-- would be a silent downgrade of the security story.
-- ---------------------------------------------------------------------------
insert into device_sessions (org_id, device_id, user_id, token_hash, expires_at)
values ('11111111-1111-7111-8111-111111111111', 'wh-01',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'hash-1', now() - interval '90 days');
insert into revocations (org_id, scope, subject, reason)
values ('11111111-1111-7111-8111-111111111111', 'device', 'wh-01', 'phone lost');

select prune_device_sessions();

select is(
  (select count(*)::int from revocations),
  1,
  'pruning expired sessions leaves the revocation record intact');

select * from finish();
rollback;
