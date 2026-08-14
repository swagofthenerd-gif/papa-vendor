-- ============================================================================
-- Dispatches
--
-- The assertions that earn their keep are the REFUSALS. A confirmation rule
-- that cannot refuse anyone is decoration, and the vendor's rule — only the
-- owner or the tech — is only real if `driver` is actually turned away.
-- ============================================================================
begin;
select plan(19);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif the driver'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Zoya read-only');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver'),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly');

insert into jobs (id, org_id, label, status) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'Rafi Peer shoot', 'open');

select fixture_rls_on();

set local role papa_app;
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- the tech

-- ---------------------------------------------------------------------------
-- Opening
-- ---------------------------------------------------------------------------
select is(
  (select state from open_dispatch(
     '50000000-0000-7000-8000-000000000001',
     '30000000-0000-7000-8000-000000000001', 'out', 40)),
  'open',
  'a dispatch opens in the open state');

select is(
  (select expected_count from dispatches
    where session_id = '50000000-0000-7000-8000-000000000001'),
  40,
  'and records what this truck was expected to carry');

-- A device that retries after a timeout must not create a second departure.
select lives_ok(
  $$ select open_dispatch('50000000-0000-7000-8000-000000000001',
       '30000000-0000-7000-8000-000000000001', 'out', 40) $$,
  'reopening the same session is idempotent, not an error');

select is((select count(*)::int from dispatches), 1,
          'and does not create a second dispatch');

-- ---------------------------------------------------------------------------
-- THE REFUSALS — the vendor's rule, made real
-- ---------------------------------------------------------------------------
set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- the driver

select throws_ok(
  $$ select confirm_dispatch('50000000-0000-7000-8000-000000000001', 34, 4, 2) $$,
  '42501',
  null,
  'the DRIVER cannot confirm a dispatch — he does nothing, by design');

select throws_ok(
  $$ select open_dispatch('50000000-0000-7000-8000-000000000009',
       '30000000-0000-7000-8000-000000000001', 'out', 5) $$,
  '42501',
  null,
  'and cannot open one either');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- read-only

select throws_ok(
  $$ select confirm_dispatch('50000000-0000-7000-8000-000000000001', 34, 4, 2) $$,
  '42501',
  null,
  'a read-only member cannot confirm');

-- ---------------------------------------------------------------------------
-- The tech confirms — normal strength
--
-- The destination is required by 0014: every dispatch says where the gear is
-- going, booked or not.
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select is(
  (select state from confirm_dispatch('50000000-0000-7000-8000-000000000001', 34, 4, 2,
                                      'Rafi Peer studio, Gulberg')),
  'confirmed',
  'the TECH can confirm');

select is(
  (select confirmed_by_role from dispatches
    where session_id = '50000000-0000-7000-8000-000000000001'),
  'warehouse',
  'and the role is recorded as the evidence tier, not flattened to a boolean');

-- The counts are asserted, not derived. This is what makes the record evidence.
select is(
  (select scanned_count || '/' || assumed_count || '/' || unaccounted_count
     from dispatches where session_id = '50000000-0000-7000-8000-000000000001'),
  '34/4/2',
  'the counts are stored exactly as asserted at that moment');

select is(
  dispatch_evidence_strength('50000000-0000-7000-8000-000000000001'),
  'normal',
  'a tech-confirmed, mostly-scanned dispatch is normal strength');

-- Confirmation happens once. A second one would overwrite the counts that were
-- asserted the first time.
select throws_ok(
  $$ select confirm_dispatch('50000000-0000-7000-8000-000000000001', 40, 0, 0) $$,
  '23514',
  null,
  'a dispatch cannot be confirmed twice');

select is(
  (select scanned_count from dispatches
    where session_id = '50000000-0000-7000-8000-000000000001'),
  34,
  'and the original counts survive the attempt');

-- ---------------------------------------------------------------------------
-- The evidence ladder
-- ---------------------------------------------------------------------------
select open_dispatch('50000000-0000-7000-8000-000000000002',
  '30000000-0000-7000-8000-000000000001', 'out', 10);

-- Mostly bulk-confirmed by case: belief, not observation.
select confirm_dispatch('50000000-0000-7000-8000-000000000002', 2, 8, 0, 'Model Town rooftop');

select is(
  dispatch_evidence_strength('50000000-0000-7000-8000-000000000002'),
  'weak',
  'a mostly-assumed dispatch is WEAK even though a tech confirmed it');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- the owner
select open_dispatch('50000000-0000-7000-8000-000000000003',
  '30000000-0000-7000-8000-000000000001', 'out', 10);
select confirm_dispatch('50000000-0000-7000-8000-000000000003', 10, 0, 0, 'Ferozepur Road set');

select is(
  dispatch_evidence_strength('50000000-0000-7000-8000-000000000003'),
  'strong',
  'an owner-confirmed dispatch is the strongest evidence');

select is(
  dispatch_evidence_strength('50000000-0000-7000-8000-000000000099'),
  null,
  'an unknown dispatch has no strength rather than a misleading default');

-- ---------------------------------------------------------------------------
-- A job accumulates — this is the whole reason dispatches exist
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from dispatches
    where job_id = '30000000-0000-7000-8000-000000000001'),
  3,
  'one job carries several dispatches — the 6am run and the 2pm run');

select is(
  (select sum(scanned_count)::int from dispatches
    where job_id = '30000000-0000-7000-8000-000000000001' and state = 'confirmed'),
  46,
  'and the job total is cumulative across them, not one moment');

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select is(
  (select count(*)::int from dispatches),
  0,
  'another org sees none of these dispatches');

select * from finish();
rollback;
