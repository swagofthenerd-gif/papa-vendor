-- ============================================================================
-- 0028 — Every write crosses the pipe: every property the migration claims,
-- tested for the property it ACTUALLY has (the 0007 rule).
--
--   * four new DEFINER doors, search_path pinned, papa_app-only; both sync
--     guards stay at zero with orgs syncable;
--   * the org mirror: one row in the eleventh pull_changes (id, name,
--     currency, timezone — never settings or slug), eighteen tables in
--     step, a rename re-syncs, org B sees only itself;
--   * create_customer: trimmed, tenancy from the GUCs, the 0017 writer
--     roles (warehouse yes, driver and readonly no), blank refused;
--   * create_job: desk work, audited, the customer's tenancy through the
--     0017 trigger, a blank label refused, warehouse refused — and through
--     replay_op exactly once with the same id;
--   * set_job_expected_back: sets, clears, refuses a foreign job;
--   * set_booking_note: append and set, a foreign booking and the wrong
--     role refused;
--   * job_margin, second edition: a bill tagged to the booking the job
--     came from counts; one tagged to the job counts; a reversal leaves;
--     one tagged to the booking but ANOTHER job does not.
-- ============================================================================
begin;
select plan(39);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos',
   '{"new_customer_value_threshold_minor": 100000000000}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran', '{}'::jsonb);

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Chacha the driver'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Auditor'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (Kamran owner)');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver'),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly'),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into devices (id, org_id, label) values
  ('WH-01', '11111111-1111-7111-8111-111111111111', 'Warehouse phone 1');

insert into customers (id, org_id, name, phone) values
  ('50000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'Zindagi Films', '03001234567'),
  ('50000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'Kamran Client', null);

insert into products (id, org_id, category, display_name, tracking_mode) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'camera', 'Sony FX9', 'serialized');

insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-A');

insert into jobs (id, org_id, label, status) values
  ('40000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'Kamran job', 'open');

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Structure                                                     [1–6]
-- ---------------------------------------------------------------------------
select has_function('create_customer', array['text', 'text', 'text']);
select has_function('create_job', array['text', 'text', 'date', 'uuid', 'text']);
select has_function('set_job_expected_back', array['uuid', 'date']);
select has_function('set_booking_note', array['uuid', 'text', 'boolean']);
select ok(
  (select bool_and(p.prosecdef and p.proconfig::text like '%search_path=public%')
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('create_customer', 'create_job', 'set_job_expected_back',
                        'set_booking_note', 'bump_own_org_watermark')),
  'every 0028 DEFINER function pins search_path');
select ok(
  not has_function_privilege('public', 'create_customer(text, text, text)', 'execute')
  and not has_function_privilege('public', 'create_job(text, text, date, uuid, text)', 'execute')
  and not has_function_privilege('public', 'set_job_expected_back(uuid, date)', 'execute')
  and not has_function_privilege('public', 'set_booking_note(uuid, text, boolean)', 'execute')
  and has_function_privilege('papa_app', 'create_customer(text, text, text)', 'execute')
  and has_function_privilege('papa_app', 'create_job(text, text, date, uuid, text)', 'execute')
  and has_function_privilege('papa_app', 'set_job_expected_back(uuid, date)', 'execute')
  and has_function_privilege('papa_app', 'set_booking_note(uuid, text, boolean)', 'execute'),
  'the four doors are papa_app''s and nobody else''s');

-- ---------------------------------------------------------------------------
-- The guards stay at zero                                       [7–8]
-- ---------------------------------------------------------------------------
select is((select count(*)::int from sync_pii_violations()), 0,
  'the PII guard is clean with orgs syncable');
select is((select count(*)::int from sync_exclusion_violations()), 0,
  'the exclusion guard is clean with the eleventh edition');

-- ---------------------------------------------------------------------------
-- The org mirror                                                [9–14]
-- ---------------------------------------------------------------------------
select has_column('orgs', 'change_seq', 'orgs is syncable');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
set local role papa_app;

select is(
  (select count(*)::int from jsonb_object_keys(pull_changes(999999999) -> 'tables')),
  18, 'the early-out names eighteen tables, org among them');

create temp table _p1 on commit drop as select pull_changes(0) as p;
select is((select jsonb_array_length(p -> 'tables' -> 'org') from _p1), 1,
  'the full pull carries exactly one org row — the caller''s own');
select is(
  (select array_agg(k order by k) from _p1, jsonb_array_elements(p -> 'tables' -> 'org') x, jsonb_object_keys(x) k),
  array['change_seq', 'currency', 'deleted_at', 'id', 'name', 'timezone', 'updated_at'],
  'the org row carries id, name, currency, timezone and the sync columns — never settings or slug');

-- A rename reaches the phone: the row moves above the old cursor.
set local role postgres;
update orgs set name = 'Lumos Rentals' where id = '11111111-1111-7111-8111-111111111111';
set local role papa_app;
select is(
  (select x ->> 'name' from jsonb_array_elements(pull_changes((select (p ->> 'cursor')::bigint from _p1)) -> 'tables' -> 'org') x),
  'Lumos Rentals', 'a rename re-syncs the org row above the old cursor');

set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
select is(
  (select x ->> 'name' from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'org') x),
  'Kamran', 'org B pulls its own row and nothing of A''s');

-- ---------------------------------------------------------------------------
-- create_customer                                               [15–19]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

create temp table _c on commit drop as
  select create_customer('  Ayesha Raza ', ' 0333 1122334 ', null) as c;
select is((select (c).name || '|' || (c).phone || '|' || (c).org_id::text from _c),
  'Ayesha Raza|0333 1122334|11111111-1111-7111-8111-111111111111',
  'a customer is born trimmed, in the caller''s org');
select throws_ok($$select create_customer('   ')$$, '23514', null,
  'a blank name is refused');

set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- driver
select throws_ok($$select create_customer('Stranger')$$, '42501', null,
  'a driver cannot add a customer');
set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select throws_ok($$select create_customer('Stranger')$$, '42501', null,
  'nor can readonly');
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select lives_ok($$select create_customer('Walk-in at the gate')$$,
  'the warehouse phone may name a walk-in (the 0017 direct policy''s writers)');

-- ---------------------------------------------------------------------------
-- create_job                                                    [20–26]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

create temp table _j on commit drop as
  select create_job('Music video — Gulberg', 'Sara 0301 5556677', date '2026-10-04',
                    '50000000-0000-7000-8000-000000000003', null) as j;
select is(
  (select (j).status || '|' || (j).created_by::text || '|' || (j).customer_id::text || '|' || (j).expected_back::text from _j),
  'open|ffffffff-ffff-7fff-8fff-ffffffffffff|50000000-0000-7000-8000-000000000003|2026-10-04',
  'the walk-in is open, stamped with the session''s user, wired to its customer');
set local role postgres;   -- the audit log is not the desk's to read
select is(
  (select count(*)::int from audit_log a where a.action = 'job_created' and a.subject_id = (select (j).id from _j)),
  1, 'and audited as job_created');
set local role papa_app;
select throws_ok(
  $$select create_job('Wrong house', null, null, '50000000-0000-7000-8000-000000000009', null)$$,
  '23503', null, 'a foreign customer is refused (the 0017 tenancy trigger)');
select throws_ok($$select create_job('  ')$$, '23514', null, 'a blank label is refused');
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok($$select create_job('Not mine to open')$$, '42501', null,
  'opening a job is desk work');

-- Through the pipe: exactly once, the same id twice.
set local papa.user_id   = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
set local papa.device_id = 'WH-01';
create temp table _r on commit drop as
  select replay_op('019b0000-0000-7000-8000-000000000001', 'create_job',
                   '{"p_label": "Walk-in via the pipe", "p_expected_back": "2026-10-06"}'::jsonb) as r;
select ok(
  (select (r ->> 'duplicate')::boolean = false and (r -> 'reply' ->> 'id') ~ '^[0-9a-f-]{36}$' from _r),
  'create_job replays through replay_op and the reply names the server''s id');
select is(
  (select replay_op('019b0000-0000-7000-8000-000000000001', 'create_job',
                    '{"p_label": "Walk-in via the pipe", "p_expected_back": "2026-10-06"}'::jsonb) -> 'reply' ->> 'id'),
  (select r -> 'reply' ->> 'id' from _r),
  'a retry is answered with the same id — one job, not two');

-- ---------------------------------------------------------------------------
-- set_job_expected_back                                         [27–29]
-- ---------------------------------------------------------------------------
select is(
  (select (set_job_expected_back((select (j).id from _j), date '2026-10-09')).expected_back),
  date '2026-10-09', 'the due date moves');
select is(
  (select (set_job_expected_back((select (j).id from _j), null)).expected_back),
  null, 'and clears to the honest ''no date''');
select throws_ok(
  $$select set_job_expected_back('40000000-0000-7000-8000-000000000009', date '2026-10-09')$$,
  '23503', null, 'a foreign job is refused');

-- ---------------------------------------------------------------------------
-- set_booking_note                                              [30–34]
-- ---------------------------------------------------------------------------
create temp table _b on commit drop as
  select (create_booking('50000000-0000-7000-8000-000000000003',
                         tstzrange('2026-11-01', '2026-11-03', '[)'),
                         '[{"asset_id": "30000000-0000-7000-8000-000000000001"}]'::jsonb,
                         'pencil', 'Original') ->> 'booking_id')::uuid as id;
select is(
  (select (set_booking_note((select id from _b), 'Sub-rent Sony FX9 ×1 for #5', true)).note),
  E'Original\nSub-rent Sony FX9 ×1 for #5',
  'append adds the intent line under the note the desk already wrote');
select is(
  (select (set_booking_note((select id from _b), 'Replaced', false)).note),
  'Replaced', 'set replaces the note');
select is(
  (select (set_booking_note((select id from _b), 'Only line', true)).note from
    (select set_booking_note((select id from _b), null, false)) z),
  'Only line', 'append onto an empty note is the line alone — no leading newline');
select throws_ok(
  $$select set_booking_note('40000000-0000-7000-8000-000000000009', 'x', false)$$,
  '23503', null, 'a foreign (or unknown) booking is refused');
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select set_booking_note('40000000-0000-7000-8000-000000000009', 'x', false)$$,
  '42501', null, 'the note is desk work, like every booking write');

-- ---------------------------------------------------------------------------
-- job_margin sees the booking's bills                           [35–39]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

-- Borrowed at the enquiry, tagged to the pencil — before any job exists.
create temp table _e on commit drop as
  select (record_expense('sub_hire', 1500000, null, null, 'Roshan Light House',
                         'two lights for Eid', null, (select id from _b))).id as id;
select is((select booking_sub_hire_cost((select id from _b))), 1500000::bigint,
  'the booking''s cost reads the bill (0024 D9, unchanged)');

select confirm_booking((select id from _b));
create temp table _jb on commit drop as
  select convert_booking_to_job((select id from _b)) as id;
select is(
  (select expense_minor from job_margin where job_id = (select id from _jb)),
  1500000::bigint, 'the job the pencil became sees the bill tagged to the booking');

create temp table _e2 on commit drop as
  select (record_expense('transport', 200000, null, (select id from _jb), 'Rickshaw', null, null, null)).id as id;
select is(
  (select expense_minor from job_margin where job_id = (select id from _jb)),
  1700000::bigint, 'a bill tagged to the job itself counts beside it');

select reverse_expense((select id from _e2), 'double entry');
select is(
  (select expense_minor from job_margin where job_id = (select id from _jb)),
  1500000::bigint, 'a reversed bill leaves the margin (the void pair)');

-- A bill tagged to the booking AND a different job belongs to that job.
select record_expense('misc', 100000, null, (select (j).id from _j), 'Elsewhere', null, null, (select id from _b));
select is(
  (select expense_minor from job_margin where job_id = (select id from _jb)),
  1500000::bigint, 'a booking-tagged bill that names another job counts for that job, not this one');

select * from finish();
rollback;
