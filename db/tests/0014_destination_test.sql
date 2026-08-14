-- ============================================================================
-- Destination, and the gear that leaves with no booking
--
-- Two rules under test, and the second is the one that was previously
-- impossible: a departure with NO JOB is a first-class record, because the
-- alternative is the item reading as "on the shelf" forever.
-- ============================================================================
begin;
select plan(14);

set local role postgres;
select fixture_rls_off();

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos');
insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech');
insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse');
insert into jobs (id, org_id, label, status) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'Rafi Peer shoot', 'open');

select fixture_rls_on();

set local role papa_app;
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

-- ---------------------------------------------------------------------------
-- The destination is required to CONFIRM, not to open
--
-- The tech opens with his hands full and may not know yet. Blocking at open
-- would put a required field inside the scan loop.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select open_dispatch('50000000-0000-7000-8000-000000000001',
       '30000000-0000-7000-8000-000000000001', 'out', 40) $$,
  'a dispatch opens without a destination — the tech may not know yet');

select throws_ok(
  $$ select confirm_dispatch('50000000-0000-7000-8000-000000000001', 40, 0, 0) $$,
  '23514',
  null,
  'but it CANNOT be confirmed without saying where the gear is going');

select is(
  (select state from dispatches where session_id = '50000000-0000-7000-8000-000000000001'),
  'open',
  'and the refused confirmation leaves it open rather than half-done');

select is(
  (select destination from confirm_dispatch(
     '50000000-0000-7000-8000-000000000001', 40, 0, 0, 'Rafi Peer studio, Gulberg')),
  'Rafi Peer studio, Gulberg',
  'supplying it at confirmation works');

-- ---------------------------------------------------------------------------
-- A destination given at open time carries through
-- ---------------------------------------------------------------------------
select open_dispatch('50000000-0000-7000-8000-000000000002',
  '30000000-0000-7000-8000-000000000001', 'out', 5, 'Model Town rooftop');

select is(
  (select destination from confirm_dispatch('50000000-0000-7000-8000-000000000002', 5, 0, 0)),
  'Model Town rooftop',
  'a destination set at open time is enough to confirm later');

-- A retry that carries nothing must not wipe what the desk filled in.
select open_dispatch('50000000-0000-7000-8000-000000000002',
  '30000000-0000-7000-8000-000000000001', 'out', 5);

select is(
  (select destination from dispatches where session_id = '50000000-0000-7000-8000-000000000002'),
  'Model Town rooftop',
  'and a later retry with no destination does not erase it');

-- Whitespace is not a destination.
select open_dispatch('50000000-0000-7000-8000-000000000003',
  '30000000-0000-7000-8000-000000000001', 'out', 1, '   ');

select throws_ok(
  $$ select confirm_dispatch('50000000-0000-7000-8000-000000000003', 1, 0, 0) $$,
  '23514',
  null,
  'blank space is not a destination');

-- ---------------------------------------------------------------------------
-- THE GEAR THAT LEAVES WITH NO BOOKING
--
-- The owner's nephew takes a light. Previously unrepresentable, so the item
-- read as "on the shelf" forever — which is how the data silently rots.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select open_dispatch('50000000-0000-7000-8000-000000000004',
       null, 'out', 1, 'Personal shoot, Johar Town', 'Owner''s nephew') $$,
  'a departure with NO JOB is allowed');

select is(
  (select recipient from confirm_dispatch(
     '50000000-0000-7000-8000-000000000004', 1, 0, 0)),
  'Owner''s nephew',
  'and it confirms, carrying who took it');

select is(
  (select job_id from dispatches where session_id = '50000000-0000-7000-8000-000000000004'),
  null,
  'with no job, no customer record and no ceremony');

-- ---------------------------------------------------------------------------
-- whats_out — the question the owner actually asks
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from whats_out),
  3,
  'everything confirmed as out appears, booked or not');

select is(
  (select count(*)::int from whats_out where informal),
  1,
  'and the jobless departure is flagged as informal rather than hidden');

select is(
  (select destination from whats_out where informal),
  'Personal shoot, Johar Town',
  'with its destination, which is the whole point');

-- The view must not become a place tenancy leaks. It joins jobs and calls a
-- function, both of which are ways to lose the org scope by accident.
select is(
  (select count(*)::int from whats_out
    where org_id <> '11111111-1111-7111-8111-111111111111'),
  0,
  'whats_out leaks no other org');

select * from finish();
rollback;
