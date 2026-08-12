-- ============================================================================
-- The cold export
--
-- The assertions worth having here are about the CURSOR, not the JSON. Getting
-- a row into NDJSON is easy and obvious; the ways this goes wrong are all
-- cursor arithmetic — re-exporting, skipping, or advancing past rows that were
-- never actually written anywhere.
-- ============================================================================
begin;
select plan(14);

set local role postgres;

alter table orgs        disable row level security;
alter table users       disable row level security;
alter table memberships disable row level security;
alter table locations   disable row level security;
alter table products    disable row level security;
alter table assets      disable row level security;
alter table devices     disable row level security;
alter table scan_events disable row level security;

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos');
insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal');
insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse');
insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9');
insert into assets (id, org_id, product_id, asset_code) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'A-1');
insert into devices (id, org_id) values ('dev-1', '11111111-1111-7111-8111-111111111111');

-- Three events, backdated past the settle lag so they are exportable.
insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                         client_seq, device_time, effective_time, server_time)
select uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
       '40000000-0000-7000-8000-000000000001', 'check_out',
       'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'dev-1',
       g, now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours'
  from generate_series(1, 3) g;

-- ---------------------------------------------------------------------------
-- The cursor starts at zero and everything settled is pending
-- ---------------------------------------------------------------------------
select is((select cursor_seq from scan_export_state), 0::bigint,
          'the cursor starts at zero');

select is((select count(*)::int from export_scan_events()), 3,
          'all three settled events are pending export');

select ok((select line from export_scan_events() limit 1) like '{%}',
          'each row is emitted as a JSON object');

select is(
  (select (line::jsonb ->> 'event_type') from export_scan_events() limit 1),
  'check_out',
  'and the JSON carries the event content');

-- The whole reason for NDJSON: one line per row, no wrapping array.
select is((select count(*)::int from export_scan_events()),
          (select count(*)::int from scan_events),
          'one line per event, not a single aggregated document');

-- ---------------------------------------------------------------------------
-- The settle lag excludes rows too recent to be certainly committed
-- ---------------------------------------------------------------------------
-- One second old, not zero. `now()` is fixed at transaction start, so a row
-- written with server_time = now() is never strictly less than now() and
-- would be held back even at a zero lag — which would make the next
-- assertion pass for the wrong reason.
insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                         client_seq, device_time, effective_time, server_time)
values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
        '40000000-0000-7000-8000-000000000001', 'check_in',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'dev-1',
        99, now(), now(), now() - interval '1 second');

select is((select count(*)::int from export_scan_events()), 3,
          'a just-inserted event is held back by the settle lag');

select is((select count(*)::int from export_scan_events('0 seconds')), 4,
          'and is exported once the lag is lowered');

-- ---------------------------------------------------------------------------
-- Committing the export
-- ---------------------------------------------------------------------------
select commit_scan_export(
  (select max(server_seq) from export_scan_events()),
  (select count(*) from export_scan_events())
);

select is((select count(*)::int from export_scan_events()), 0,
          'nothing is pending after the cursor advances');

select is((select count(*)::int from scan_export_batches), 1,
          'the batch is recorded in the ledger');

select is((select row_count from scan_export_batches), 3::bigint,
          'with the row count it claims to have written');

-- ---------------------------------------------------------------------------
-- The detector
-- ---------------------------------------------------------------------------
select is((select missing from export_gap_check()), 0::bigint,
          'the gap check reports a complete export');

-- Simulating the exact hazard: a row that commits late and lands BELOW the
-- cursor. This is what the settle lag exists to prevent and what the ledger
-- exists to catch when prevention fails.
insert into scan_events (id, org_id, asset_id, event_type, actor_user_id, device_id,
                         client_seq, device_time, effective_time, server_time, server_seq)
values (uuid_generate_v7(), '11111111-1111-7111-8111-111111111111',
        '40000000-0000-7000-8000-000000000001', 'move',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'dev-1',
        100, now(), now(), now(),
        (select cursor_seq from scan_export_state) - 1);

select is((select missing from export_gap_check()), 1::bigint,
          'a row that lands below the cursor is DETECTED as missing');

-- ---------------------------------------------------------------------------
-- The cursor cannot rewind
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select commit_scan_export(1::bigint, 1::bigint) $$,
  '23514',
  null,
  'the export cursor refuses to move backwards');

-- ---------------------------------------------------------------------------
-- Not reachable from the application role
-- ---------------------------------------------------------------------------
set local role papa_app;

select throws_ok(
  $$ select * from export_scan_events() $$,
  '42501',
  null,
  'papa_app cannot run the cross-org export');

select * from finish();
rollback;
