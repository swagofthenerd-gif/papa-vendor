-- ============================================================================
-- Sync health and the silent-device alert
--
-- The assertions that earn their keep are the idempotency one and the tenancy
-- one. An alert that re-raises hourly trains people to mute the channel, and a
-- monitoring view is exactly the kind of place a cross-org leak hides, because
-- nobody thinks of a dashboard as a data surface.
-- ============================================================================
begin;
select plan(13);

set local role postgres;

alter table orgs        disable row level security;
alter table users       disable row level security;
alter table memberships disable row level security;
alter table devices     disable row level security;

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos',  'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal');
insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'manager');

insert into devices (id, org_id, label, last_user_id, last_synced_at, queued_writes) values
  ('wh-01', '11111111-1111-7111-8111-111111111111', 'WH-01',
   'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', now(), 0),
  ('wh-02', '11111111-1111-7111-8111-111111111111', 'WH-02',
   'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', now() - interval '30 hours', 12),
  ('wh-03', '11111111-1111-7111-8111-111111111111', 'WH-03',
   'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', now() - interval '5 days', 400),
  ('wh-04', '11111111-1111-7111-8111-111111111111', 'WH-04', null, null, 0),
  ('kam-01', '22222222-2222-7222-8222-222222222222', 'KAM-01', null, now() - interval '9 days', 3);

alter table devices enable row level security;

-- ---------------------------------------------------------------------------
-- The view classifies silence by age
-- ---------------------------------------------------------------------------
select is((select status from sync_health where device_id = 'wh-01'), 'ok',
          'a device that just synced is ok');
select is((select status from sync_health where device_id = 'wh-02'), 'stale',
          '30 hours of silence is stale');
select is((select status from sync_health where device_id = 'wh-03'), 'critical',
          'five days of silence is critical');
select is((select status from sync_health where device_id = 'wh-04'), 'never_synced',
          'a device that never synced is called out separately');

select ok((select hours_since_sync from sync_health where device_id = 'wh-02') between 29 and 31,
          'hours_since_sync is reported');

-- Context, not trigger. wh-03 reported 400 the last time it COULD reach the
-- server; the number is real but it is not what raised the alarm.
select is((select last_reported_queue from sync_health where device_id = 'wh-03'), 400,
          'the last reported queue depth is carried through as context');

-- ---------------------------------------------------------------------------
-- Raising alerts
-- ---------------------------------------------------------------------------
select is(raise_stale_device_alerts(), 3,
          'the three silent devices across both orgs are alerted');

select is(
  (select count(*)::int from alerts
    where kind = 'device_not_syncing' and severity = 'critical'),
  2,
  'devices past 72 hours are critical');

select alike(
  (select title from alerts where payload ->> 'device_id' = 'wh-03'),
  'WH-03 has not synced since%'::text,
  'the alert names the device by its label'::text);

-- The ledger's requirement: actionable, with a name attached.
select alike(
  (select detail from alerts where payload ->> 'device_id' = 'wh-03'),
  '%Bilal%'::text,
  'and names who last used it'::text);

-- ---------------------------------------------------------------------------
-- Idempotency — the assertion that keeps the channel usable
-- ---------------------------------------------------------------------------
select is(raise_stale_device_alerts(), 0,
          'running again raises nothing while the alerts are open');

-- ---------------------------------------------------------------------------
-- Tenancy. A monitoring view is still a data surface.
-- ---------------------------------------------------------------------------
set local role papa_app;
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select is(
  (select count(*)::int from sync_health where org_id <> '11111111-1111-7111-8111-111111111111'),
  0,
  'sync_health leaks no other org''s devices');

-- ---------------------------------------------------------------------------
-- The standing guard, because this one nearly shipped
--
-- sync_health was written without security_invoker and leaked every org's
-- devices. The assertion above caught it — but only because someone thought
-- to write it, and the next view might not get that luck. A view READS like a
-- query, so the DEFINER trap everyone now watches for in functions is close
-- to invisible here.
--
-- This asserts the property for EVERY view in the schema, so a future one
-- fails the build instead of depending on a reviewer noticing.
-- ---------------------------------------------------------------------------
set local role postgres;

select is(
  (select string_agg(c.relname, ', ' order by c.relname)
     from pg_class c
    where c.relkind = 'v'
      and c.relnamespace = 'public'::regnamespace
      -- pgTAP installs its own views into public and they are not ours to
      -- govern. Scoping by extension membership rather than by name means a
      -- future extension is excluded too, without editing a denylist.
      and not exists (
        select 1 from pg_depend d
         where d.objid = c.oid and d.deptype = 'e')
      and not coalesce(
            (select o.option_value = 'true'
               from pg_options_to_table(c.reloptions) o
              where o.option_name = 'security_invoker'),
            false)),
  null,
  'every view runs as invoker, so none of them bypasses RLS');

select * from finish();
rollback;
