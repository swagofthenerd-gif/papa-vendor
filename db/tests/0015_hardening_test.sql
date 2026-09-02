-- ============================================================================
-- 0015 — security and correctness hardening
--
-- Every fix in 0015 gets an assertion that FAILED before it: forged
-- projections, readable PIN hashes, cross-org references, the limiter as a
-- public API, the guard that missed jobs.contact, the evidence ladder that
-- graded belief as strong, and the sync cursor that could skip a late commit.
--
-- NOTE this file deliberately does NOT `grant execute on all functions` to
-- papa_app the way older files do — half of what it proves is which functions
-- papa_app can no longer reach.
-- ============================================================================
begin;
select plan(67);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif the driver'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Zoya read-only'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (Kamran owner)');

insert into memberships (org_id, user_id, role, pin_hash, pin_set_at) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse',
   crypt('4321', gen_salt('bf')), now()),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner', null, null),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver', null, null),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly', null, null),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner', null, null);

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack'),
  ('10000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222', 'Kamran Rack', 'rack');

insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9'),
  ('20000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222', 'camera', 'RED Komodo');

insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-02'),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'CASE-01'),
  ('30000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   '20000000-0000-7000-8000-000000000009', 'KOM-01');

insert into jobs (id, org_id, label, contact) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'Zindagi Films', '+92 300 1234567'),
  ('40000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'Kamran internal', null);

insert into devices (id, org_id, label) values
  ('WH-01', '11111111-1111-7111-8111-111111111111', 'Warehouse phone 1'),
  ('KH-01', '22222222-2222-7222-8222-222222222222', 'Kamran phone');

-- A FORGED tag row: org 1's tag pointing at org 2's asset. The FK allowed
-- this before 0015; the resolver must refuse to follow it.
insert into asset_tags (org_id, tag_code, asset_id, status, bound_at) values
  ('11111111-1111-7111-8111-111111111111', 'v1-forged-cross',
   '30000000-0000-7000-8000-000000000009', 'active', now());

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Definition pins (C2, H1) — regressions that only show under concurrency are
-- pinned structurally, the way 0008 pins its policy text.
-- ---------------------------------------------------------------------------
select ok(
  pg_get_functiondef('apply_scan_event(scan_events)'::regprocedure) ~* 'for update',
  'apply_scan_event locks the asset row FOR UPDATE — an old event cannot race a new one past the ordering guard');

select ok(
  pg_get_functiondef('rebuild_asset_projection(uuid)'::regprocedure) ~* 'for update',
  'rebuild_asset_projection locks the asset row FOR UPDATE');

select is(
  (select count(*)::int from pg_proc
    where pronamespace = 'public'::regnamespace and prosecdef
      and proname in ('apply_scan_event', 'rebuild_asset_projection',
                      'on_scan_event_insert', 'after_scan_event_insert')),
  4,
  'the whole scan pipeline is SECURITY DEFINER — the trigger path works for every caller while the direct grants are gone');

-- ---------------------------------------------------------------------------
-- M5/M6 — the PII guard pattern-matches, and the exclusion is enforced
-- ---------------------------------------------------------------------------
select is((select count(*)::int from sync_pii_violations()), 0,
  'no unreviewed sensitive-pattern column lives on a syncable table');

select is((select count(*)::int from sync_exclusion_violations()), 0,
  'and every reviewed exclusion is actually projected out of pull_changes');

select has_column('jobs', 'contact');   -- stays server-side; it just never syncs

create table guard_probe_p (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  contact_phone text,
  change_seq bigint
);

select is((select count(*)::int from sync_pii_violations()), 1,
  'a contact_phone column on a syncable table is caught by PATTERN, not exact name — this is what jobs.contact slipped through');

drop table guard_probe_p;

select is((select count(*)::int from sync_pii_violations()), 0,
  'and the probe leaves no residue');

create table guard_probe_c (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  credit_limit_minor bigint,
  change_seq bigint
);

select is((select count(*)::int from sync_pii_violations()), 1,
  'credit_limit% on a syncable table is caught too');

drop table guard_probe_c;

-- ---------------------------------------------------------------------------
-- M5a — a correction in one org cannot point at another org's event
-- ---------------------------------------------------------------------------
insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                         client_seq, device_time)
values ('50000000-0000-7000-8000-000000000099', '22222222-2222-7222-8222-222222222222',
        '30000000-0000-7000-8000-000000000009', 'check_out',
        'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'KH-01', 1, now());

select throws_ok(
  $$insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                             client_seq, device_time, corrects_event_id)
    values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000001', 'check_in',
            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'WH-01', 80, now(),
            '50000000-0000-7000-8000-000000000099')$$,
  '23503', null,
  'a correction cannot reference an event in another org');

-- ---------------------------------------------------------------------------
-- The application role. No blanket function grant — the revocations below
-- are the product.
-- ---------------------------------------------------------------------------
set local role papa_app;
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- the tech

-- H1: the projection can no longer be forged without a log row.
select throws_ok(
  $$select rebuild_asset_projection('30000000-0000-7000-8000-000000000001')$$,
  '42501', null,
  'papa_app cannot call rebuild_asset_projection — a projection write without an event is forgery');

select throws_ok(
  $$select apply_scan_event(null::scan_events)$$,
  '42501', null,
  'papa_app cannot call apply_scan_event either');

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 1, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', now()::text)))),
  'accepted', 'but the legitimate path still projects');

select is((select presence from assets where asset_code = 'FX9-02'), 'out',
  'the trigger applied the event even though the caller holds no grant on the reducer');

-- H2: the driver still scans (a handoff is a physical fact), but writes
-- nothing else.
set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- the driver

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 2, 'event_type', 'check_in',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'device_time', (now() + interval '1 minute')::text)))),
  'accepted', 'a DRIVER can still submit scans — the truck handoff is a physical fact');

select is((select presence from assets where asset_code = 'FX9-02'), 'here',
  'and the driver''s scan projects');

select throws_ok(
  $$insert into jobs (org_id, label) values (current_org_id(), 'forged job')$$,
  '42501', null,
  'but a driver cannot INSERT tenant state directly');

select throws_ok(
  $$update assets set notes = 'forged' where asset_code = 'FX9-02'$$,
  '42501', null,
  'nor UPDATE it');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- read-only

select throws_ok(
  $$insert into jobs (org_id, label) values (current_org_id(), 'forged job')$$,
  '42501', null,
  'a readonly member cannot INSERT');

select throws_ok(
  $$update jobs set label = 'forged' where label = 'Zindagi Films'$$,
  '42501', null,
  'or UPDATE');

select throws_ok(
  $$insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                             client_seq, device_time)
    values (uuid_generate_v7(), current_org_id(),
            '30000000-0000-7000-8000-000000000001', 'check_out',
            current_user_id(), 'WH-01', 50, now())$$,
  '42501', null,
  'or forge scan history — readonly writes NOTHING');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select lives_ok(
  $$update assets set notes = 'mount is loose' where asset_code = 'FX9-02'$$,
  'a warehouse tech still writes what a warehouse tech writes');

-- ---------------------------------------------------------------------------
-- H2(b) — dispatch state moves only through the RPCs
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into dispatches (org_id, session_id, direction, state, scanned_count,
                            confirmed_by, confirmed_at, confirmed_by_role, destination)
    values (current_org_id(), uuid_generate_v7(), 'out', 'confirmed', 40,
            current_user_id(), now(), 'owner', 'nowhere')$$,
  '42501', null,
  'a member cannot INSERT a pre-confirmed dispatch — the grant is gone');

select is(
  (select state from open_dispatch('60000000-0000-7000-8000-000000000001',
     '40000000-0000-7000-8000-000000000001', 'out', 5)),
  'open', 'open_dispatch still works as DEFINER');

select throws_ok(
  $$update dispatches set state = 'confirmed', scanned_count = 999,
       confirmed_by_role = 'owner'
     where session_id = '60000000-0000-7000-8000-000000000001'$$,
  '42501', null,
  'and confirm-state cannot be forged by direct UPDATE');

select is(
  (select state from confirm_dispatch('60000000-0000-7000-8000-000000000001',
     5, 0, 0, 'Rafi Peer studio, Gulberg')),
  'confirmed', 'confirm_dispatch still works');

select throws_ok(
  $$select confirm_dispatch('60000000-0000-7000-8000-000000000001', 40, 0, 0)$$,
  '23514', null,
  'and still refuses a second confirmation');

-- H4: belief is not observation, whoever pressed the button.
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- the owner

select open_dispatch('60000000-0000-7000-8000-000000000002',
  '40000000-0000-7000-8000-000000000001', 'out', 10);

select is(
  (select state from confirm_dispatch('60000000-0000-7000-8000-000000000002',
     0, 10, 0, 'Model Town rooftop')),
  'confirmed', 'an owner bulk-confirms a sealed case');

select is(
  dispatch_evidence_strength('60000000-0000-7000-8000-000000000002'),
  'weak',
  'an OWNER-confirmed, all-assumed dispatch is WEAK — the owner asserted a belief, not an observation');

select is((select count(*)::int from whats_out), 2,
  'both confirmed outs are on the board');

-- The informal departure stays visible until a person deals with it.
select open_dispatch('60000000-0000-7000-8000-000000000004',
  null, 'out', 1, 'Personal shoot, Johar Town', 'Owner''s nephew');

select is(
  (select state from confirm_dispatch('60000000-0000-7000-8000-000000000004', 1, 0, 0)),
  'confirmed', 'the nephew''s light is recorded');

select is((select count(*)::int from whats_out), 3,
  'and appears on the board');

-- M6b: gear comes back, and a return needs no destination.
select open_dispatch('60000000-0000-7000-8000-000000000003',
  '40000000-0000-7000-8000-000000000001', 'back', 5);

select is(
  (select state from confirm_dispatch('60000000-0000-7000-8000-000000000003', 5, 0, 0)),
  'confirmed',
  'a BACK dispatch confirms with no destination — the destination is the warehouse');

select is((select count(*)::int from whats_out), 1,
  'a confirmed return settles the job''s out-dispatches off the board');

select is((select informal from whats_out), true,
  'and the survivor is the jobless one, which nothing can auto-settle');

select throws_ok(
  $$select open_dispatch('60000000-0000-7000-8000-000000000005',
      '40000000-0000-7000-8000-000000000009', 'out', 1)$$,
  '23503', null,
  'a dispatch cannot be opened against another org''s job');

-- ---------------------------------------------------------------------------
-- M4 — cross-org references are refused everywhere
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select throws_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 60, 'event_type', 'check_out',
        'asset_id', '30000000-0000-7000-8000-000000000009',
        'device_time', now()::text)))$$,
  '23503', null,
  'LEAK: a scan cannot reference another org''s asset — the FK checked existence, not tenancy');

select throws_ok(
  $$insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                             client_seq, device_time, to_location_id)
    values (uuid_generate_v7(), current_org_id(),
            '30000000-0000-7000-8000-000000000001', 'move',
            current_user_id(), 'WH-01', 61, now(),
            '10000000-0000-7000-8000-000000000009')$$,
  '23503', null,
  'LEAK: nor another org''s location');

select throws_ok(
  $$select bind_tag('v1-fresh-tag', '30000000-0000-7000-8000-000000000009')$$,
  '23503', null,
  'LEAK: a tag cannot be bound to another org''s asset');

select throws_ok(
  $$select intake_asset('v1-intake-x', 'Aputure 600d',
                        '10000000-0000-7000-8000-000000000009')$$,
  '23503', null,
  'LEAK: intake cannot land gear on another org''s shelf');

-- M5a: a correction must target the same asset.
select throws_ok(
  $$insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                             client_seq, device_time, corrects_event_id)
    values (uuid_generate_v7(), current_org_id(),
            '30000000-0000-7000-8000-000000000002', 'check_in',
            current_user_id(), 'WH-01', 62, now(),
            (select id from scan_events where device_id = 'WH-01' and client_seq = 1))$$,
  '23514', null,
  'a correction that names a DIFFERENT asset than its target is refused');

-- ---------------------------------------------------------------------------
-- H1-corr — the unbound-tag scan is not lost
-- ---------------------------------------------------------------------------
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 5, 'event_type', 'check_out',
       'tag_code', 'v1-unbound-x',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', (now() + interval '2 minutes')::text)))),
  'accepted', 'a scan of a tag nobody has bound yet is recorded');

select is((select count(*)::int from alerts where kind = 'unresolved_tag'), 1,
  'and raises the unresolved_tag alert instead of silently projecting nothing');

select is((select presence from assets where asset_code = 'CASE-01'), 'here',
  'no asset moves yet — there is nothing to project onto');

select lives_ok(
  $$select bind_tag('v1-unbound-x', '30000000-0000-7000-8000-000000000002')$$,
  'the desk binds the tag later');

select is((select presence from assets where asset_code = 'CASE-01'), 'out',
  'and the EARLIER scan now shows in the projection — the event was never lost');

select is(
  (select current_job_id from assets where asset_code = 'CASE-01'),
  '40000000-0000-7000-8000-000000000001'::uuid,
  'with the job the original scan named');

select ok(
  (select resolved_at is not null from alerts where kind = 'unresolved_tag'),
  'and the alert closes itself — the question it asked has been answered');

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 6, 'event_type', 'check_in',
       'tag_code', 'v1-unbound-x',
       'device_time', (now() + interval '3 minutes')::text)))),
  'accepted', 'a later scan by tag_code alone is accepted');

select is((select presence from assets where asset_code = 'CASE-01'), 'here',
  'and projects immediately');

select is(
  (select asset_id from scan_events where device_id = 'WH-01' and client_seq = 6),
  '30000000-0000-7000-8000-000000000002'::uuid,
  'because the insert trigger resolved the live binding at write time');

-- ---------------------------------------------------------------------------
-- H3 — the PIN hash is out of reach
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select pin_hash from memberships$$,
  '42501', null,
  'papa_app cannot select pin_hash at all — no offline cracking material');

select is(
  (select count(*)::int from (select id, org_id, user_id, role, status from memberships) m),
  4,
  'every other memberships column still reads normally');

select ok(verify_pin('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', '4321'),
  'the right PIN verifies');

select ok(not verify_pin('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', '9999'),
  'the wrong PIN does not');

do $$
begin
  for i in 1..10 loop
    perform verify_pin('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', '0000');
  end loop;
  raise exception 'expected the PIN gate to rate limit';
exception
  when too_many_connections then null;   -- what we want
end
$$;
select pass('and guessing is rate limited from INSIDE the definer — the caller cannot skip the limiter');

-- ---------------------------------------------------------------------------
-- M1 — the limiter is not an API
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select rate_limit_check('pin:victim', 1, '1 minute')$$,
  '42501', null,
  'papa_app cannot call rate_limit_check — burning a victim''s bucket was a denial of service');

select throws_ok(
  $$select prune_rate_limits('0 seconds')$$,
  '42501', null,
  'and cannot reset every limiter window via prune_rate_limits (the PUBLIC grant is gone too)');

-- ---------------------------------------------------------------------------
-- M2 / M4 — the public resolver
-- ---------------------------------------------------------------------------
select is(
  (select found from resolve_tag_public('v1-forged-cross')),
  false,
  'LEAK: a forged tag row pointing at another org''s asset resolves to NOT FOUND, not to their product');

do $$
begin
  for i in 1..650 loop
    perform resolve_tag_public('v1-nonsense', 'rotating-' || i);
  end loop;
  raise exception 'expected the global bucket to refuse';
exception
  when too_many_connections then null;   -- what we want
end
$$;
select pass('rotating the client key no longer bypasses limiting — the global bucket caps total anonymous resolutions');

-- ---------------------------------------------------------------------------
-- M6 — what actually leaves the server
-- ---------------------------------------------------------------------------
select ok(
  not ((pull_changes(0) -> 'tables' -> 'jobs' -> 0) ? 'contact'),
  'jobs sync WITHOUT the phone-number column — the desk keeps it, the warehouse floor never gets it');

select ok(
  not ((pull_changes(0) -> 'tables' -> 'assets' -> 0) ? 'changed_xid8'),
  'the cursor-safety bookkeeping never leaves the server');

-- ---------------------------------------------------------------------------
-- C1 — the cursor does not advance past an unsettled row
--
-- Simulated deterministically: a row is restamped as if written moments ago
-- by a FOREIGN transaction (the stamping trigger is paused so the update does
-- not overwrite the simulation). The dblink companion file exercises the real
-- two-connection interleaving.
-- ---------------------------------------------------------------------------
set local role postgres;
alter table assets disable trigger assets_change_seq;
update assets
   set changed_xid8 = '1'::xid8,          -- some other transaction, long gone
       changed_at   = clock_timestamp()   -- ...that stamped this row just now
 where asset_code = 'FX9-02';
set local role papa_app;

select ok(
  (pull_changes(0) ->> 'cursor')::bigint
    < (select change_seq from assets where asset_code = 'FX9-02'),
  'the cursor is HELD BELOW a freshly-stamped row from another transaction — a lower seq may still be uncommitted');

select ok(
  exists (select 1
            from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'assets') a
           where a ->> 'asset_code' = 'FX9-02'),
  'the row itself is still delivered; only the cursor waits');

select is(
  (pull_changes(0) ->> 'has_more')::boolean, false,
  'a settle-only holdback does not report has_more — a pull-until-done client must not spin for the window');

set local role postgres;
update assets
   set changed_at = clock_timestamp() - interval '10 seconds'
 where asset_code = 'FX9-02';
set local role papa_app;

select ok(
  (pull_changes(0) ->> 'cursor')::bigint
    >= (select change_seq from assets where asset_code = 'FX9-02'),
  'once the row is settled the cursor advances past it');

set local role postgres;
alter table assets enable trigger assets_change_seq;

-- ---------------------------------------------------------------------------
-- The exclusion guard detects, rather than passing vacuously (the 0009 rule:
-- a green check that cannot go red is worse than no check). Done LAST — it
-- clobbers pull_changes inside this transaction; rollback restores it.
-- ---------------------------------------------------------------------------
create or replace function pull_changes(p_since bigint default 0, p_limit int default 2000)
returns jsonb language sql stable as
'select to_jsonb(''probe: select * from jobs, and the word contact''::text)';

select is((select count(*)::int from sync_exclusion_violations()), 2,
  'a pull_changes that mentions an excluded column or selects * from its table is DETECTED');

select * from finish();
rollback;
