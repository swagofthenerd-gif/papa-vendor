-- ============================================================================
-- The write path
--
-- These functions are SECURITY INVOKER, which means RLS applies to them
-- exactly as it applies to a direct query. That claim is the entire security
-- argument for the design, so it is tested rather than asserted: the suite
-- runs as papa_app throughout, and every isolation check is proven from
-- inside a function call, not around it.
-- ============================================================================
begin;
select plan(30);

set local role postgres;

alter table orgs disable row level security;
alter table users disable row level security;
alter table memberships disable row level security;
alter table locations disable row level security;
alter table products disable row level security;
alter table assets disable row level security;
alter table asset_tags disable row level security;
alter table jobs disable row level security;
alter table devices disable row level security;

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos', '{}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran',
   '{"public_tag_show_owner": true, "public_phone": "+92300..."}'::jsonb);

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Ledger-only Zoya');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('22222222-2222-7222-8222-222222222222', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'readonly');

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack');

insert into products (id, org_id, category, manufacturer, model, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony', 'FX9', 'Sony FX9');

insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', '20000000-0000-7000-8000-000000000001', 'FX9-02');

insert into jobs (id, org_id, label) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Zindagi Films'),
  ('40000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', 'Rafi Peer');

alter table orgs enable row level security;
alter table users enable row level security;
alter table memberships enable row level security;
alter table locations enable row level security;
alter table products enable row level security;
alter table assets enable row level security;
alter table asset_tags enable row level security;
alter table jobs enable row level security;
alter table devices enable row level security;

select is(
  (select count(*)::int from pg_class
    where relname in ('orgs','users','memberships','locations','products','assets',
                      'asset_tags','jobs','devices','scan_events','alerts')
      and relnamespace = 'public'::regnamespace and not relrowsecurity),
  0, 'RLS is back on for every table the fixtures disabled it for'
);

grant execute on all functions in schema public to papa_app;
set local role papa_app;

select ok(not (select rolsuper from pg_roles where rolname = current_user),
          'the whole suite runs as a non-superuser');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

-- ---------------------------------------------------------------------------
-- submit_scan_batch — the happy path
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 1, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', now()::text),
     jsonb_build_object('client_seq', 2, 'event_type', 'move',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'to_location_id', '10000000-0000-7000-8000-000000000001',
       'device_time', (now() + interval '1 minute')::text)
   ))),
  2, 'a batch returns one row per op'
);

select is((select presence from assets where asset_code = 'FX9-02'), 'here',
          'the batch applied, and the later move landed after the check_out');
select is((select count(*)::int from scan_events where device_id = 'WH-01'), 2,
          'both events were recorded');
select isnt((select last_seen_at from devices where id = 'WH-01'), null,
            'the device registered itself — no extra online round-trip on first sync');

-- ---------------------------------------------------------------------------
-- Idempotency — `duplicate` is a SUCCESS
--
-- A retry after a timeout where the server actually succeeded happens daily
-- on a flaky mobile network. Treating it as an error is how a queue wedges.
-- ---------------------------------------------------------------------------
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 1, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'device_time', now()::text)))),
  'duplicate', 'replaying an op reports duplicate rather than raising'
);

select is((select count(*)::int from scan_events where device_id = 'WH-01'), 2,
          'and does not insert a second copy');

-- A partially-overlapping batch — the real shape of a retry after the network
-- dropped mid-flush.
select is(
  (select string_agg(outcome, ',' order by client_seq) from submit_scan_batch('WH-01',
     jsonb_build_array(
       jsonb_build_object('client_seq', 2, 'event_type', 'move',
         'asset_id', '30000000-0000-7000-8000-000000000001',
         'device_time', now()::text),
       jsonb_build_object('client_seq', 3, 'event_type', 'check_in',
         'asset_id', '30000000-0000-7000-8000-000000000001',
         'device_time', (now() + interval '2 minutes')::text)))),
  'duplicate,accepted',
  'a partly-replayed batch accepts only the new ops'
);

-- ---------------------------------------------------------------------------
-- Ordering inside a batch
--
-- Ops are applied by client_seq regardless of array order, or a check_in can
-- land before its check_out and the projection ends up backwards.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 11, 'event_type', 'check_in',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'device_time', (now() + interval '20 minutes')::text),
      jsonb_build_object('client_seq', 10, 'event_type', 'check_out',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'job_id', '40000000-0000-7000-8000-000000000001',
        'device_time', (now() + interval '10 minutes')::text)))$$,
  'a batch submitted out of array order is accepted'
);

select is((select presence from assets where asset_code = 'FX9-02'), 'here',
          'and is applied in client_seq order, not array order');

-- ---------------------------------------------------------------------------
-- Double checkout — the second line of defence
--
-- The device warns locally before the tech walks away; that is the control
-- that matters, because at 06:14 the desk is closed. This catches the case
-- where the device's own copy was stale.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 20, 'event_type', 'check_out',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'job_id', '40000000-0000-7000-8000-000000000001',
        'device_time', (now() + interval '30 minutes')::text)))$$,
  'first check_out'
);

select is(
  (select alert_kind from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 21, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', '40000000-0000-7000-8000-000000000002',
       'device_time', (now() + interval '31 minutes')::text)))),
  'double_checkout',
  'checking the same asset out to a DIFFERENT job is flagged'
);

select is((select count(*)::int from alerts where kind = 'double_checkout'), 1,
          'and an alert row is raised');

select is((select channel from alerts where kind = 'double_checkout'), 'whatsapp',
          'routed to WhatsApp, because rental desks do not watch dashboards');

select is((select severity from alerts where kind = 'double_checkout'), 'critical',
          'at critical severity');

-- The event still records. Physical-reality events never fail; they raise
-- alerts. The truck is already loaded — refusing the scan does not unload it.
select is((select count(*)::int from scan_events where client_seq = 21 and device_id = 'WH-01'), 1,
          'and the scan is STILL recorded — reality outranks the schedule');

-- Re-scanning to the SAME job is not a conflict, it is a tech double-checking.
select ok(
  (select alert_kind is null from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 22, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'job_id', '40000000-0000-7000-8000-000000000002',
       'device_time', (now() + interval '32 minutes')::text)))),
  're-scanning to the SAME job is not flagged'
);

-- ---------------------------------------------------------------------------
-- Role gates
-- ---------------------------------------------------------------------------
set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

select throws_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 99, 'event_type', 'check_in',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'device_time', now()::text)))$$,
  '42501', null,
  'a readonly member cannot submit scans'
);

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

-- ---------------------------------------------------------------------------
-- THE TENANCY CLAIM
--
-- These functions are SECURITY INVOKER precisely so RLS still applies inside
-- them. If any of these pass, the departure from SECURITY DEFINER was wrong
-- and every function would need a hand-written org check.
-- ---------------------------------------------------------------------------
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select throws_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 50, 'event_type', 'check_in',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'device_time', now()::text)))$$,
  '42501', null,
  'LEAK: another org cannot submit scans through a device that is not theirs'
);

select is((select count(*)::int from scan_events), 0,
          'LEAK: and sees none of the first org''s events');

select is((select count(*)::int from alerts), 0,
          'LEAK: nor its alerts');

-- ---------------------------------------------------------------------------
-- intake_asset — ten seconds, offline, on the shelf
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select lives_ok(
  $$select intake_asset('v1-blank-001', 'Aputure 600d', '10000000-0000-7000-8000-000000000001')$$,
  'a blank tag plus a spoken name creates an asset'
);

select is((select count(*)::int from assets a join products p on p.id = a.product_id
           where p.display_name = 'Aputure 600d'), 1,
          'the asset exists');

select is((select status from asset_tags where tag_code = 'v1-blank-001'), 'active',
          'and the tag is bound in the same call');

select ok(
  (select asset_code !~ '[OILU]' from assets a join products p on p.id = a.product_id
   where p.display_name = 'Aputure 600d'),
  'the generated code excludes O, I, L and U — read at arm''s length in bad light'
);

-- A second intake of the same name reuses the provisional product rather than
-- multiplying near-duplicates in the catalogue.
select lives_ok(
  $$select intake_asset('v1-blank-002', 'Aputure 600d')$$,
  'a second unit of the same thing can be taken in'
);

select is((select count(*)::int from products where display_name = 'Aputure 600d'), 1,
          'and reuses the provisional product rather than duplicating it');

-- ---------------------------------------------------------------------------
-- bind_tag — re-issuing a soaked label
-- ---------------------------------------------------------------------------
select lives_ok(
  $$select bind_tag('v1-reissued-001', '30000000-0000-7000-8000-000000000001')$$,
  'a label can be bound to an asset'
);

select lives_ok(
  $$select bind_tag('v1-reissued-002', '30000000-0000-7000-8000-000000000001')$$,
  'and replaced when it is soaked off'
);

select is((select status from asset_tags where tag_code = 'v1-reissued-001'), 'retired',
          'the old label is retired, not deleted — it is the record of what it was on');

select is((select count(*)::int from asset_tags
           where asset_id = '30000000-0000-7000-8000-000000000001' and status = 'active'), 1,
          'and the asset carries exactly one active label');

select throws_ok(
  $$select bind_tag('v1-reissued-002', (select a.id from assets a join products p on p.id = a.product_id
                                        where p.display_name = 'Aputure 600d' limit 1))$$,
  '23505', null,
  'a label already on one asset cannot be bound to another'
);

-- ---------------------------------------------------------------------------
-- resolve_tag_public — what a stranger's camera sees
--
-- The one SECURITY DEFINER function, because it is deliberately reachable
-- without an org context.
-- ---------------------------------------------------------------------------
select ok((select found from resolve_tag_public('v1-reissued-002')),
          'a real tag resolves');

select is((select owner_name from resolve_tag_public('v1-reissued-002')), null,
          'and does NOT name the owner by default — that tells a thief whose label to peel');

select is(
  (select row(found, product_name, owner_name, owner_phone)::text
     from resolve_tag_public('v1-total-nonsense')),
  (select row(found, product_name, owner_name, owner_phone)::text
     from resolve_tag_public('v1-reissued-001')),
  'an unknown code is INDISTINGUISHABLE from a retired one — otherwise a fleet can be estimated from photographs'
);

select * from finish();
rollback;
