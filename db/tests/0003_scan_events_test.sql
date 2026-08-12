-- ============================================================================
-- The scan event log and the projection
--
-- The behaviours tested here are the ones that decide whether inventory is
-- trustworthy: append-only enforcement, idempotent replay, clock clamping,
-- and — the subtle one — a device that was offline for days not clobbering
-- newer truth when it finally syncs.
-- ============================================================================
begin;
select plan(37);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Sara');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse');

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack'),
  ('10000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', 'Van 1', 'vehicle');

insert into products (id, org_id, category, manufacturer, model, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony', 'FX9', 'Sony FX9');

insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', '20000000-0000-7000-8000-000000000001', 'FX9-02'),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', '20000000-0000-7000-8000-000000000001', 'CASE-01');

insert into jobs (id, org_id, label) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Zindagi Films'),
  ('40000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', 'Rafi Peer shoot');

insert into devices (id, org_id, label) values
  ('WH-01', '11111111-1111-7111-8111-111111111111', 'Warehouse phone 1'),
  ('WH-02', '11111111-1111-7111-8111-111111111111', 'Warehouse phone 2');

reset role;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------
insert into scan_events (id, org_id, asset_id, event_type, job_id, actor_user_id,
                         device_id, client_seq, device_time)
values ('50000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
        '30000000-0000-7000-8000-000000000001', 'check_out',
        '40000000-0000-7000-8000-000000000001',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 1, now());

select throws_ok(
  $$update scan_events set note = 'tampered' where client_seq = 1$$,
  '23001', null, 'scan_events cannot be UPDATEd, ever'
);

select throws_ok(
  $$delete from scan_events where client_seq = 1$$,
  '23001', null, 'scan_events cannot be DELETEd, ever'
);

-- ---------------------------------------------------------------------------
-- Idempotency — the flaky-network case, which happens daily
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into scan_events (id, org_id, asset_id, event_type, actor_user_id,
                             device_id, client_seq, device_time)
    values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000001', 'check_out',
            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 1, now())$$,
  '23505', null,
  'replaying (device_id, client_seq) is rejected, so a retry is a no-op'
);

-- ---------------------------------------------------------------------------
-- The projection
-- ---------------------------------------------------------------------------
select is((select presence from assets where asset_code = 'FX9-02'), 'out',
          'a check_out puts the asset out');
select is((select current_job_id from assets where asset_code = 'FX9-02'),
          '40000000-0000-7000-8000-000000000001'::uuid,
          'and records WHICH job has it — the whole point of phase 1');
select isnt((select last_applied_at from assets where asset_code = 'FX9-02'), null,
            'the ordering key advances');

insert into scan_events (id, org_id, asset_id, event_type, actor_user_id,
                         device_id, client_seq, device_time)
values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
        '30000000-0000-7000-8000-000000000001', 'check_in',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 2, now() + interval '1 hour');

select is((select presence from assets where asset_code = 'FX9-02'), 'here',
          'a check_in brings it back');
select is((select current_job_id from assets where asset_code = 'FX9-02'), null,
          'and clears the job');

-- Moving onto a vehicle is in_transit, not here. Gear on a truck is not
-- missing; it is at a location that happens to be moving.
insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                         client_seq, device_time, to_location_id)
values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
        '30000000-0000-7000-8000-000000000001', 'move',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 3, now() + interval '2 hours',
        '10000000-0000-7000-8000-000000000002');

select is((select presence from assets where asset_code = 'FX9-02'), 'in_transit',
          'moving onto a vehicle reads as in_transit');
select is((select current_location_id from assets where asset_code = 'FX9-02'),
          '10000000-0000-7000-8000-000000000002'::uuid, 'and the location follows');

-- Health is a separate axis from presence.
insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                         client_seq, device_time)
values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
        '30000000-0000-7000-8000-000000000001', 'send_to_service',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 4, now() + interval '3 hours');

select is((select health from assets where asset_code = 'FX9-02'), 'servicing',
          'service changes health');
select is((select presence from assets where asset_code = 'FX9-02'), 'in_transit',
          'and does NOT disturb presence — they are independent axes');

-- ---------------------------------------------------------------------------
-- THE LATE DEVICE
--
-- A phone offline for three weeks finally syncs. Its events are physically
-- old but arrive last. They must land in history WITHOUT overwriting newer
-- truth, and must raise an alert rather than being silently dropped —
-- silently discarding a late event is the bug that loses a camera.
-- ---------------------------------------------------------------------------
insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                         client_seq, device_time, job_id)
values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
        '30000000-0000-7000-8000-000000000001', 'check_out',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-02', 1, now() - interval '21 days',
        '40000000-0000-7000-8000-000000000002');

select is((select health from assets where asset_code = 'FX9-02'), 'servicing',
          'a three-week-old event does NOT clobber newer state');
select is((select current_job_id from assets where asset_code = 'FX9-02'), null,
          'and does not reassign the asset to its stale job');

select is((select count(*)::int from alerts where kind = 'late_event'), 1,
          'the late event raises an alert instead of vanishing');

select is((select count(*)::int from scan_events where device_id = 'WH-02'), 1,
          'and it is still recorded in history — the log keeps everything');

-- ---------------------------------------------------------------------------
-- Clock clamping
--
-- A device claiming the future is pulled back to arrival. A device running
-- slow keeps its earlier time, which makes its events apply as OLD — the safe
-- direction, because old events never clobber.
-- ---------------------------------------------------------------------------
insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                         client_seq, device_time)
values ('50000000-0000-7000-8000-0000000000f1', '11111111-1111-7111-8111-111111111111',
        '30000000-0000-7000-8000-000000000002', 'check_out',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 90, now() + interval '10 years');

select ok(
  (select effective_time <= server_time from scan_events
   where id = '50000000-0000-7000-8000-0000000000f1'),
  'a device claiming the future is clamped to arrival time'
);

select ok(
  (select device_time > effective_time from scan_events
   where id = '50000000-0000-7000-8000-0000000000f1'),
  'but the untrusted device_time is preserved — its divergence is diagnostic'
);

insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                         client_seq, device_time)
values ('50000000-0000-7000-8000-0000000000f2', '11111111-1111-7111-8111-111111111111',
        '30000000-0000-7000-8000-000000000002', 'check_in',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 91, now() - interval '5 days');

select ok(
  (select effective_time < server_time from scan_events
   where id = '50000000-0000-7000-8000-0000000000f2'),
  'a device running slow keeps its earlier time (the safe direction)'
);

-- ---------------------------------------------------------------------------
-- entry_method — how the row got here
-- ---------------------------------------------------------------------------
select is((select entry_method from scan_events where client_seq = 1 and device_id = 'WH-01'),
          'scanned', 'entry_method defaults to scanned');

select lives_ok(
  $$insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                             client_seq, device_time, entry_method)
    values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000001', 'check_in',
            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 10, now() + interval '5 hours',
            'manual')$$,
  'a manual entry is a first-class path, not an error'
);

select lives_ok(
  $$insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                             client_seq, device_time, entry_method)
    values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000002', 'check_out',
            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 11, now() + interval '6 hours',
            'assumed')$$,
  'an assumed entry (bulk-confirmed case manifest) is recordable and countable'
);

select throws_ok(
  $$insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                             client_seq, device_time, entry_method)
    values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000001', 'check_in',
            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 12, now(), 'guessed')$$,
  '23514', null, 'entry_method is constrained to the known paths'
);

-- ---------------------------------------------------------------------------
-- An unresolved tag is recorded, not rejected
--
-- A tag scanned offline that this device has never synced cannot be resolved
-- locally. Rejecting it would mean the tech's scan simply vanished.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$insert into scan_events (id, org_id, tag_code, event_type, actor_user_id, device_id,
                             client_seq, device_time)
    values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
            'v1-never-seen-before', 'check_out',
            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 20, now())$$,
  'a scan of an unknown tag is recorded with the tag_code'
);

select throws_ok(
  $$insert into scan_events (id, org_id, event_type, actor_user_id, device_id,
                             client_seq, device_time)
    values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111', 'check_out',
            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 21, now())$$,
  '23514', null,
  'but an event naming NOTHING at all is rejected'
);

-- ---------------------------------------------------------------------------
-- Rebuild — the escape hatch that makes event sourcing worth its cost
-- ---------------------------------------------------------------------------
select lives_ok(
  $$update assets set presence = 'gone', health = 'quarantined', current_job_id = null
     where asset_code = 'FX9-02'$$,
  'corrupt the projection, as a bad deploy would'
);

select lives_ok(
  $$select rebuild_asset_projection('30000000-0000-7000-8000-000000000001')$$,
  'replaying the log is a single call'
);

select is((select health from assets where asset_code = 'FX9-02'), 'servicing',
          'and it restores the state the events imply');
select isnt((select presence from assets where asset_code = 'FX9-02'), 'gone',
            'discarding the corruption');

-- ---------------------------------------------------------------------------
-- Corrections point forward
-- ---------------------------------------------------------------------------
select lives_ok(
  $$insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                             client_seq, device_time, corrects_event_id, note)
    values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000001', 'check_in',
            'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'WH-01', 30, now() + interval '9 hours',
            '50000000-0000-7000-8000-000000000001',
            'went out Tuesday, not Monday')$$,
  'a mistake is corrected by APPENDING an event that points back at it'
);

select is(
  (select count(*)::int from scan_events where id = '50000000-0000-7000-8000-000000000001'),
  1, 'the original event is still there, unmodified'
);

select ok(
  exists (select 1 from scan_events
          where corrects_event_id = '50000000-0000-7000-8000-000000000001'),
  'and the correction is discoverable from it'
);

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------
select fixture_rls_on();

select is(
  (select count(*)::int from pg_class
    where relname in ('orgs','users','memberships','locations','products','assets',
                      'jobs','devices','scan_events','alerts')
      and relnamespace = 'public'::regnamespace and not relrowsecurity),
  0, 'RLS is back on for every table the fixtures disabled it for'
);

grant execute on all functions in schema public to papa_app;
set local role papa_app;
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select ok(not (select rolsuper from pg_roles where rolname = current_user),
          'isolation assertions run as a non-superuser');
select is((select count(*)::int from scan_events), 0,
          'LEAK: another org sees none of these scan events');
select is((select count(*)::int from alerts), 0,
          'LEAK: another org sees none of these alerts');

-- The app role must not be able to rewrite history even with a valid org.
set local papa.org_id = '11111111-1111-7111-8111-111111111111';
select throws_ok(
  $$update scan_events set note = 'x' where device_id = 'WH-01'$$,
  '42501', null,
  'papa_app holds no UPDATE grant on scan_events at all'
);

select * from finish();
rollback;
