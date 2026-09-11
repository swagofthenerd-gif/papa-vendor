-- ============================================================================
-- 0020 — The fleet lifecycle
--
-- Every property the migration claims, tested for the property it ACTUALLY
-- has (the 0007 rule). The load-bearing ones:
--
--   * the three declarations move through the SCAN PIPELINE — clamped,
--     projected, append-only — and are owner/manager-gated at the RPC
--     (warehouse, driver and desk are refused mid-batch);
--   * a terminal asset is gone + disposed + OFF ITS JOB, which is what
--     finally lets October's ghost job close; `found` is the recovery door
--     and a projection rebuild reproduces the disposition from the log;
--   * the constraints hold for every writer: no disposition outside the
--     enum, none on an asset that is not gone;
--   * the resolver: STOLEN is loud (notice + contact, public_tag_show_owner
--     or not); lost / sold answer byte-for-byte like nonsense
--     (anti-enumeration), and a healthy tag still resolves;
--   * the swap is atomic and refused for every reason it advertises —
--     cross-org, closed job, wrong job, terminal / off-shelf / unfit
--     substitutes — and the happy path leaves three linked events, one
--     session, the substitute on the job and the broken item quarantined;
--   * a cycle count moves last_scanned_at and the counted shelf WITHOUT
--     touching presence — here or out — and count_sessions groups a walk;
--   * mark_sold carries its sale money as payload, never as a ledger or
--     expense row (D3);
--   * both sync guards stay at zero and pull_changes ships disposition.
-- ============================================================================
begin;
select plan(55);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos',
   '{"public_phone": "+92 300 1112233"}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran', '{}'::jsonb);

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif the driver'),
  ('99999999-9999-7999-8999-999999999999', 'Nadia the manager'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (Kamran owner)');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver'),
  ('11111111-1111-7111-8111-111111111111', '99999999-9999-7999-8999-999999999999', 'manager'),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Grip Bay', 'rack'),
  ('10000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222', 'Kamran Rack', 'rack');

insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9'),
  ('20000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', 'cable', 'XLR Cable 5m'),
  ('20000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222', 'camera', 'RED Komodo');

-- org 1: two FX9 bodies (stolen story + the broken one), a third for the
-- sold story, one cable for the ghost-job story and one as the swap
-- substitute, plus a quarantined spare to refuse. org 2: one Komodo.
insert into assets (id, org_id, product_id, asset_code, health) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-01', 'ok'),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-02', 'ok'),
  ('30000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-03', 'ok'),
  ('30000000-0000-7000-8000-000000000004', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000002', 'XLR-01', 'ok'),
  ('30000000-0000-7000-8000-000000000005', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000002', 'XLR-02', 'ok'),
  ('30000000-0000-7000-8000-000000000006', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-Q', 'quarantined'),
  ('30000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   '20000000-0000-7000-8000-000000000009', 'KOM-01', 'ok');

insert into jobs (id, org_id, label) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'TVC — Ferozepur Road'),
  ('40000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', 'Corporate — Gulberg'),
  ('40000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222', 'Kamran internal');

insert into devices (id, org_id, label) values
  ('WH-01', '11111111-1111-7111-8111-111111111111', 'Warehouse phone 1');

insert into asset_tags (org_id, tag_code, asset_id, status, bound_at) values
  ('11111111-1111-7111-8111-111111111111', 'v1-stolen-fx9',
   '30000000-0000-7000-8000-000000000001', 'active', now()),
  ('11111111-1111-7111-8111-111111111111', 'v1-sold-fx9',
   '30000000-0000-7000-8000-000000000003', 'active', now()),
  ('11111111-1111-7111-8111-111111111111', 'v1-lost-xlr',
   '30000000-0000-7000-8000-000000000004', 'active', now()),
  ('11111111-1111-7111-8111-111111111111', 'v1-healthy-xlr',
   '30000000-0000-7000-8000-000000000005', 'active', now());

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Shape pins
-- ---------------------------------------------------------------------------
select has_column('assets', 'disposition');

select throws_ok(
  $$update assets set presence = 'gone', disposition = 'eaten'
     where asset_code = 'XLR-02'$$,
  '23514', null,
  'the disposition enum holds for every writer, superuser included');

select throws_ok(
  $$update assets set disposition = 'lost' where asset_code = 'XLR-02'$$,
  '23514', null,
  'a disposition cannot exist on an asset that is not gone — the axes cannot disagree');

-- ---------------------------------------------------------------------------
-- The gate (D2b): declarations are owner/manager only, through the pipeline
-- ---------------------------------------------------------------------------
set local role papa_app;
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse

-- The cable goes out on the Corporate job first (the OCT ghost-cable story).
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 1, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000004',
       'job_id', '40000000-0000-7000-8000-000000000002',
       'device_time', now()::text)))),
  'accepted', 'the cable leaves on the Corporate job');

select throws_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 2, 'event_type', 'mark_lost',
        'asset_id', '30000000-0000-7000-8000-000000000004',
        'device_time', now()::text)))$$,
  '42501', null,
  'a warehouse tech cannot declare gear lost — the fleet is not theirs to rewrite');

set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- driver
select throws_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 3, 'event_type', 'mark_sold',
        'asset_id', '30000000-0000-7000-8000-000000000003',
        'device_time', now()::text)))$$,
  '42501', null,
  'nor can a driver declare a sale');

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
select throws_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 4, 'event_type', 'mark_stolen',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'device_time', now()::text)))$$,
  '42501', null,
  'desk too: stolen/lost/sold are owner/manager declarations');

-- ---------------------------------------------------------------------------
-- The OCT case: the paid-for lost cable finally has somewhere to go
-- ---------------------------------------------------------------------------
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner

select throws_ok(
  $$select close_job('40000000-0000-7000-8000-000000000002')$$,
  '23514', null,
  'before the declaration the close rule refuses — the cable still projects onto the job');

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 5, 'event_type', 'mark_lost',
       'asset_id', '30000000-0000-7000-8000-000000000004',
       'note', 'Client paid the damage charge; cable never came back',
       'device_time', now()::text)))),
  'accepted', 'the owner declares the cable lost');

select results_eq(
  $$select presence, disposition, current_job_id from assets where asset_code = 'XLR-01'$$,
  $$values ('gone', 'lost', null::uuid)$$,
  'gone + lost + OFF THE JOB — the projection moved all three axes at once');

select lives_ok(
  $$select close_job('40000000-0000-7000-8000-000000000002')$$,
  'and October''s ghost job closes at last — the close rule itself never changed');

select cmp_ok(
  (select count(*)::int from scan_events
    where asset_id = '30000000-0000-7000-8000-000000000004'), '>=', 2::int,
  'the history is kept: the checkout and the declaration are both on the log');

-- found is the recovery door, and it is NOT gated: the tech who finds the
-- cable in a case lining scans it back into the fleet.
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 6, 'event_type', 'found',
       'asset_id', '30000000-0000-7000-8000-000000000004',
       'device_time', (now() + interval '1 second')::text)))),
  'accepted', 'a tech scans the cable FOUND — recovery is not gated');

select results_eq(
  $$select presence, disposition from assets where asset_code = 'XLR-01'$$,
  $$values ('here', null::text)$$,
  'found clears the disposition and brings it home in one update');

-- A manager can declare too (the gate is owner OR manager).
set local papa.user_id = '99999999-9999-7999-8999-999999999999';
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 7, 'event_type', 'mark_lost',
       'asset_id', '30000000-0000-7000-8000-000000000004',
       'device_time', (now() + interval '2 seconds')::text)))),
  'accepted', 'a manager can declare as well');

-- ---------------------------------------------------------------------------
-- FEB (stolen) and the sale (D3)
-- ---------------------------------------------------------------------------
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 8, 'event_type', 'mark_stolen',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'note', 'Client absconded — FIR filed',
       'device_time', now()::text)))),
  'accepted', 'the owner declares the FX9 stolen');

select is(
  (select disposition from assets where asset_code = 'FX9-01'),
  'stolen', 'and the mirror says so');

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 9, 'event_type', 'mark_sold',
       'asset_id', '30000000-0000-7000-8000-000000000003',
       'note', 'Sold to Roshan Light House',
       'payload', jsonb_build_object('sale_amount_minor', 120000000),
       'device_time', now()::text)))),
  'accepted', 'the owner records a sale');

select is(
  (select (payload ->> 'sale_amount_minor')::bigint from scan_events
    where asset_id = '30000000-0000-7000-8000-000000000003'
      and event_type = 'mark_sold'),
  120000000::bigint,
  'the sale money rides the evidence chain as payload');

select is(
  (select count(*)::int from customer_ledger_entries
    where org_id = '11111111-1111-7111-8111-111111111111'),
  0, 'D3: no ledger row was invented for the sale');

select is(
  (select count(*)::int from org_expenses
    where org_id = '11111111-1111-7111-8111-111111111111'),
  0, 'and no expense row either — sale income is explicit follow-up, not a costume');

-- The projection rebuild rederives the disposition from the log alone.
set local role postgres;
select fixture_rls_off();
select rebuild_asset_projection('30000000-0000-7000-8000-000000000001');
select results_eq(
  $$select presence, disposition from assets where asset_code = 'FX9-01'$$,
  $$values ('gone', 'stolen')$$,
  'a rebuild replays mark_stolen and lands on the same disposition — the log is the truth');
select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- The resolver (D4): stolen is loud, everything else is nonsense-shaped
-- ---------------------------------------------------------------------------
set local role papa_app;
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select results_eq(
  $$select found, stolen, owner_name, owner_phone from resolve_tag_public('v1-stolen-fx9', 'k1')$$,
  $$values (true, true, 'Lumos', '+92 300 1112233')$$,
  'a stolen item answers LOUD: found, flagged, with the org''s contact — public_tag_show_owner or not');

select ok(
  (select stolen_notice like '%STOLEN%' and stolen_notice like '%Lumos%'
     from resolve_tag_public('v1-stolen-fx9', 'k2')),
  'and the notice text names the theft and the house');

select results_eq(
  $$select found, product_name, owner_name, owner_phone, stolen, stolen_notice
      from resolve_tag_public('v1-sold-fx9', 'k3')$$,
  $$select found, product_name, owner_name, owner_phone, stolen, stolen_notice
      from resolve_tag_public('v1-no-such-tag', 'k3')$$,
  'a SOLD item''s tag answers byte-for-byte like a tag that never existed — anti-enumeration holds');

-- Make the manager's lost declaration visible to the resolver comparison.
select results_eq(
  $$select found, product_name, owner_name, owner_phone, stolen, stolen_notice
      from resolve_tag_public('v1-lost-xlr', 'k4')$$,
  $$select found, product_name, owner_name, owner_phone, stolen, stolen_notice
      from resolve_tag_public('v1-no-such-tag', 'k4')$$,
  'a LOST item too — a lost tag must not advertise that nobody knows where it is');

select results_eq(
  $$select found, product_name, stolen from resolve_tag_public('v1-healthy-xlr', 'k5')$$,
  $$values (true, 'XLR Cable 5m', false)$$,
  'an ordinary fleet tag still resolves exactly as before');

-- ---------------------------------------------------------------------------
-- The swap (D5)
-- ---------------------------------------------------------------------------
-- FX9-02 goes out on the TVC as the working camera.
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 10, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000002',
       'job_id', '40000000-0000-7000-8000-000000000001',
       'device_time', now()::text)))),
  'accepted', 'FX9-02 goes out on the TVC');

create temp table _swap (checked_in_event uuid, flag_event uuid, checked_out_event uuid);
grant select, insert on _swap to papa_app;

-- Refusals first, so the counts below prove atomicity from a clean slate.
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk swaps

select throws_ok(
  $$select * from swap_asset('40000000-0000-7000-8000-000000000009',
     '30000000-0000-7000-8000-000000000002', '30000000-0000-7000-8000-000000000005')$$,
  '23503', null,
  'another org''s job is indistinguishable from a nonexistent one');

select throws_ok(
  $$select * from swap_asset('40000000-0000-7000-8000-000000000001',
     '30000000-0000-7000-8000-000000000002', '30000000-0000-7000-8000-000000000009')$$,
  '23503', null,
  'and another org''s substitute is too — cross-org swaps cannot exist');

select throws_ok(
  $$select * from swap_asset('40000000-0000-7000-8000-000000000002',
     '30000000-0000-7000-8000-000000000002', '30000000-0000-7000-8000-000000000005')$$,
  '23514', null,
  'a closed job takes no swap — the flow is for a live crisis');

select throws_ok(
  $$select * from swap_asset('40000000-0000-7000-8000-000000000001',
     '30000000-0000-7000-8000-000000000005', '30000000-0000-7000-8000-000000000006')$$,
  '23514', null,
  'the broken item must actually be out on the named job');

select throws_ok(
  $$select * from swap_asset('40000000-0000-7000-8000-000000000001',
     '30000000-0000-7000-8000-000000000002', '30000000-0000-7000-8000-000000000003')$$,
  '23514', null,
  'a terminal (sold) unit is refused as substitute');

select throws_ok(
  $$select * from swap_asset('40000000-0000-7000-8000-000000000001',
     '30000000-0000-7000-8000-000000000002', '30000000-0000-7000-8000-000000000002')$$,
  '23514', null,
  'an item cannot substitute for itself');

select throws_ok(
  $$select * from swap_asset('40000000-0000-7000-8000-000000000001',
     '30000000-0000-7000-8000-000000000002', '30000000-0000-7000-8000-000000000006')$$,
  '23514', null,
  'a quarantined spare is refused — an unfit substitute is the double-booking lie in a new hat');

set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
select throws_ok(
  $$select * from swap_asset('40000000-0000-7000-8000-000000000001',
     '30000000-0000-7000-8000-000000000002', '30000000-0000-7000-8000-000000000005')$$,
  '42501', null,
  'a driver does not swap — it is a desk decision about a job');

-- Atomicity: every refusal above wrote NOTHING.
select is(
  (select count(*)::int from scan_events
    where session_id is not null and device_id like 'server:%'),
  0, 'the refused swaps left zero server-minted events — one transaction, all or nothing');

-- The happy path. The substitute is the shelf's healthy cable — same-product
-- is the CLIENT's preference, never a server rule: a desk may send a C500
-- out for a broken FX9, and that judgement is theirs to make.
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
insert into _swap
select * from swap_asset(
  '40000000-0000-7000-8000-000000000001',
  '30000000-0000-7000-8000-000000000002',
  '30000000-0000-7000-8000-000000000005',
  'flag_damage',
  'Dropped on set — top handle cracked');

select results_eq(
  $$select presence, health, current_job_id from assets where asset_code = 'FX9-02'$$,
  $$values ('here', 'quarantined', null::uuid)$$,
  'the broken camera is home, off the job, and flagged in one atomic write');

select results_eq(
  $$select presence, current_job_id from assets where asset_code = 'XLR-02'$$,
  $$values ('out', '40000000-0000-7000-8000-000000000001'::uuid)$$,
  'and the substitute is out on the SAME job — the rental story never split');

select is(
  (select count(distinct e.session_id)::int from scan_events e
    join _swap s on e.id in (s.checked_in_event, s.flag_event, s.checked_out_event)),
  1, 'all three events share one session — the swap reads as one act');

select results_eq(
  $$select e.implied_by_event_id from scan_events e
     join _swap s on e.id = s.flag_event$$,
  $$select checked_in_event from _swap$$,
  'the flag says WHY it exists: implied by the broken item''s check_in');

select results_eq(
  $$select e.implied_by_event_id, e.payload ->> 'replaces_asset_id' from scan_events e
     join _swap s on e.id = s.checked_out_event$$,
  $$select checked_in_event, '30000000-0000-7000-8000-000000000002' from _swap$$,
  'and the substitute''s checkout names both the event and the unit it replaces');

select is(
  (select entry_method from scan_events e join _swap s on e.id = s.checked_out_event),
  'manual', 'server-minted movements are entry_method=manual — a decision, not a decode');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
select is(
  (select count(*)::int from audit_log
    where org_id = '11111111-1111-7111-8111-111111111111' and action = 'asset_swap'),
  1, 'the swap is audited');

-- ---------------------------------------------------------------------------
-- The cycle count (D6)
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

-- Seen on the shelf: XLR-01 (home since `found`... then marked lost by the
-- manager — bring it home again first so the count has something honest).
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 11, 'event_type', 'found',
       'asset_id', '30000000-0000-7000-8000-000000000004',
       'device_time', (now() + interval '3 seconds')::text)))),
  'accepted', 'the cable turns up again for the stocktake');

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 12, 'event_type', 'inventory_count',
       'entry_method', 'counted',
       'asset_id', '30000000-0000-7000-8000-000000000004',
       'session_id', '77777777-7777-7777-8777-777777777777',
       'to_location_id', '10000000-0000-7000-8000-000000000001',
       'device_time', (now() + interval '4 seconds')::text)))),
  'accepted', 'a counted sighting is an ordinary pipeline event');

select results_eq(
  $$select presence, current_location_id, last_scanned_at is not null
      from assets where asset_code = 'XLR-01'$$,
  $$values ('here', '10000000-0000-7000-8000-000000000001'::uuid, true)$$,
  'the count moved last_scanned_at and the shelf — presence untouched');

-- Counting something that is OUT must not teleport it home: a count asserts
-- "seen", and the reducer's else-branch keeps presence exactly as it was.
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 13, 'event_type', 'inventory_count',
       'entry_method', 'counted',
       'asset_id', '30000000-0000-7000-8000-000000000005',
       'session_id', '77777777-7777-7777-8777-777777777777',
       'to_location_id', '10000000-0000-7000-8000-000000000001',
       'device_time', (now() + interval '5 seconds')::text)))),
  'accepted', 'the out substitute gets counted too (a mis-scan on a walk)');

select is(
  (select presence from assets where asset_code = 'XLR-02'),
  'out', 'and stays OUT — a count never fabricates a return');

select results_eq(
  $$select assets_counted, location_id from count_sessions
     where session_id = '77777777-7777-7777-8777-777777777777'$$,
  $$values (2, '10000000-0000-7000-8000-000000000001'::uuid)$$,
  'count_sessions groups the walk: two distinct items, one shelf');

-- Another org sees no trace of the walk.
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
select is(
  (select count(*)::int from count_sessions),
  0, 'count_sessions is org-scoped through scan_events RLS');

-- ---------------------------------------------------------------------------
-- Sync: disposition rides the pull; both guards stay at zero
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select ok(
  (select bool_and(r ? 'disposition')
     from jsonb_array_elements((pull_changes(0) -> 'tables') -> 'assets') r),
  'every synced asset row carries disposition — the Gone filter''s data source');

select ok(
  (select bool_or(r ->> 'disposition' = 'stolen')
     from jsonb_array_elements((pull_changes(0) -> 'tables') -> 'assets') r),
  'and the stolen FX9 arrives saying so');

set local role postgres;
select is((select count(*)::int from sync_pii_violations()), 0,
  'the PII guard still finds nothing');
select is((select count(*)::int from sync_exclusion_violations()), 0,
  'and every reviewed exclusion is still projected out');

select * from finish();
rollback;
