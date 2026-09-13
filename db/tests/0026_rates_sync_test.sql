-- ============================================================================
-- 0026 — Rates sync: what the phone receives, who receives it, and what
-- stays home.
--
--   * the three rate tables are syncable (change_seq) and a rate write
--     bumps the org watermark, so a polling phone learns the price changed;
--   * BOTH sync guards stay at zero with the ninth edition in place — the
--     override columns are not PII and the excluded jobs column is still
--     projected out;
--   * the early-out key set and the full key set agree (0006's rule, now
--     with sixteen tables); an org with no card gets an empty array for
--     rate_cards, not a missing key;
--   * the card arrives with its knobs (the mask as a jsonb array), the
--     entry with its rate, the calendar day with its multiplier and the
--     day as text; a removed entry arrives as a tombstone — the phone goes
--     back to UNPRICED, never to zero;
--   * the role gate is RLS's, not the projection's: the desk sees the card,
--     the warehouse and readonly see empty pages for the card and its
--     entries but still see the calendar;
--   * the override rides the booking line — rate, original, reason — and
--     overridden_by stays home;
--   * org B never sees org A's card or calendar through pull.
-- ============================================================================
begin;
select plan(30);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos',
   '{"new_customer_value_threshold_minor": 100000000000}'::jsonb),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran', '{}'::jsonb);

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Auditor'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (Kamran owner)');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly'),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into products (id, org_id, category, display_name, tracking_mode,
                      replacement_value_minor) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'camera', 'Sony FX9', 'serialized', 350000000),
  ('20000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'camera', 'RED Komodo', 'serialized', 250000000);

insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-A');

insert into customers (id, org_id, name, phone) values
  ('50000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'Rafi Productions', '03009998877');

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Syncable shape and the guards                                 [assert 1–6]
-- ---------------------------------------------------------------------------
select has_column('rate_cards', 'change_seq', 'rate_cards is syncable');
select has_column('rate_card_entries', 'change_seq', 'rate_card_entries is syncable');
select has_column('org_calendar_days', 'change_seq', 'org_calendar_days is syncable');

select is(
  (select count(*)::int from pg_trigger
    where tgname in ('rate_cards_watermark_ins', 'rate_cards_watermark_upd',
                     'rate_card_entries_watermark_ins', 'rate_card_entries_watermark_upd',
                     'org_calendar_days_watermark_ins', 'org_calendar_days_watermark_upd')),
  6, 'every new syncable table bumps the org watermark on insert and update');

select is((select count(*)::int from sync_pii_violations()), 0,
  'the PII guard is clean with the three rate tables syncable — a rate is not PII');
select is((select count(*)::int from sync_exclusion_violations()), 0,
  'the excluded jobs column is still projected out of the ninth edition');

-- ---------------------------------------------------------------------------
-- Key sets, and the empty card                                 [assert 7–10]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
set local role papa_app;

select is(
  (select count(*)::int from jsonb_object_keys(pull_changes(0) -> 'tables')),
  18, 'the full pull carries eighteen tables (sixteen as of 0026; members joined in 0027, org in 0028)');
select is(
  (select count(*)::int from jsonb_object_keys(pull_changes(999999999) -> 'tables')),
  18, 'and the early-out names the same eighteen — the two lists are in step');
select is(
  pull_changes(0) -> 'tables' -> 'rate_cards', '[]'::jsonb,
  'no card yet: an empty array, not a missing key');
select is(
  pull_changes(0) -> 'tables' -> 'org_calendar_days', '[]'::jsonb,
  'and an empty calendar reads the same way');

-- ---------------------------------------------------------------------------
-- The card, an entry and a calendar day reach the phone       [assert 11–17]
-- ---------------------------------------------------------------------------
create temp table _mark on commit drop as
  select coalesce(max_change_seq, 0) as before_seq from org_sync_watermark
   where org_id = '11111111-1111-7111-8111-111111111111';

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
create temp table _cards (k text primary key, id uuid) on commit drop;
insert into _cards select 'A', (upsert_rate_card(
  'Standard', null, null, 3, 1, '{6,7}'::int[]) ->> 'id')::uuid;

select ok(
  (select max_change_seq from org_sync_watermark
    where org_id = '11111111-1111-7111-8111-111111111111')
    > (select before_seq from _mark),
  'a rate-card write bumps the org watermark — a polling phone wakes up');

select upsert_rate_entry((select id from _cards where k = 'A'),
                         '20000000-0000-7000-8000-000000000001', 2500000);
select set_calendar_day('2030-05-07', 'holiday', 'Eid ul-Fitr', 1.25);

-- Two statements on purpose: pull_changes is STABLE and would not see rows
-- written inside the same statement.
create temp table _p1 on commit drop as select pull_changes(0) as p;

select is(
  (select x -> 'weekend_mask' from jsonb_array_elements((select p from _p1) -> 'tables' -> 'rate_cards') x
    where (x ->> 'id')::uuid = (select id from _cards where k = 'A')),
  '[6, 7]'::jsonb, 'the card arrives with its mask as a jsonb array (the phone stores the JSON text)');
select is(
  (select (x ->> 'week_equals_days')::numeric from jsonb_array_elements((select p from _p1) -> 'tables' -> 'rate_cards') x
    where (x ->> 'id')::uuid = (select id from _cards where k = 'A')),
  3::numeric, 'and its week rule');
select ok(
  not ((select p from _p1) -> 'tables' -> 'rate_cards' -> 0 ? 'created_by'),
  'created_by stays home — the projection is slim (D2)');
select is(
  (select (x ->> 'day_rate_minor')::bigint from jsonb_array_elements((select p from _p1) -> 'tables' -> 'rate_card_entries') x
    where (x ->> 'product_id')::uuid = '20000000-0000-7000-8000-000000000001'),
  2500000::bigint, 'the FX9 entry arrives at Rs 25,000/day');
select is(
  (select x ->> 'day' from jsonb_array_elements((select p from _p1) -> 'tables' -> 'org_calendar_days') x
    where x ->> 'kind' = 'holiday'),
  '2030-05-07', 'the calendar day arrives dated as text');
select is(
  (select (x ->> 'rate_multiplier')::numeric from jsonb_array_elements((select p from _p1) -> 'tables' -> 'org_calendar_days') x
    where x ->> 'kind' = 'holiday'),
  1.25::numeric, 'with its multiplier');

-- ---------------------------------------------------------------------------
-- A removed entry is a tombstone                              [assert 18–19]
-- ---------------------------------------------------------------------------
create temp table _c1 on commit drop as
  select ((select p from _p1) ->> 'cursor')::bigint as c;

select upsert_rate_entry((select id from _cards where k = 'A'),
                         '20000000-0000-7000-8000-000000000001', null);

create temp table _p2 on commit drop as
  select pull_changes((select c from _c1)) as p;

select is(
  jsonb_array_length((select p from _p2) -> 'tables' -> 'rate_card_entries'), 1,
  'the removed entry is re-sent after the cursor');
select ok(
  ((select p from _p2) -> 'tables' -> 'rate_card_entries' -> 0 ->> 'deleted_at') is not null,
  'as a tombstone — the phone deletes the row and the line goes back to unpriced, never to zero');

-- ---------------------------------------------------------------------------
-- The role gate is RLS's                                      [assert 20–24]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select is(
  pull_changes(0) -> 'tables' -> 'rate_cards', '[]'::jsonb,
  'the warehouse phone receives no rate card — the price list is not the floor''s business (D1)');
select is(
  pull_changes(0) -> 'tables' -> 'rate_card_entries', '[]'::jsonb,
  'nor any entry');
select is(
  jsonb_array_length(pull_changes(0) -> 'tables' -> 'org_calendar_days'), 1,
  'but it still receives the calendar — season shading is for everyone');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select is(
  pull_changes(0) -> 'tables' -> 'rate_cards', '[]'::jsonb,
  'readonly sees no card either');
select is(
  jsonb_array_length(pull_changes(0) -> 'tables' -> 'org_calendar_days'), 1,
  'and still the calendar');

-- ---------------------------------------------------------------------------
-- The override rides the booking line                          [assert 25–28]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
create temp table _b1 on commit drop as
  select create_booking(
    '50000000-0000-7000-8000-000000000001',
    tstzrange('2030-04-01 10:00+05', '2030-04-15 10:00+05', '[)'),
    '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
  ) as r;

select is(
  (select x -> 'rate_minor' from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'booking_lines') x limit 1),
  'null'::jsonb, 'a fresh line carries rate_minor null — priced from the card');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
select upsert_rate_entry((select id from _cards where k = 'A'),
                         '20000000-0000-7000-8000-000000000001', 2500000);
select set_line_rate_override(
  (select l.id from booking_lines l
    where l.booking_id = ((select r from _b1) ->> 'booking_id')::uuid),
  2000000, 'Rafi: long-standing client, Rs 20,000 agreed');

create temp table _p3 on commit drop as select pull_changes(0) as p;

select is(
  (select (x ->> 'rate_minor')::bigint from jsonb_array_elements((select p from _p3) -> 'tables' -> 'booking_lines') x limit 1),
  2000000::bigint, 'the override reaches the phone as the line''s final rate (D3)');
select is(
  (select (x ->> 'original_rate_minor')::bigint from jsonb_array_elements((select p from _p3) -> 'tables' -> 'booking_lines') x limit 1),
  2500000::bigint, 'with the card rate it replaced');
select ok(
  (select x ->> 'override_reason' = 'Rafi: long-standing client, Rs 20,000 agreed'
     and not (x ? 'overridden_by') and not (x ? 'overridden_at')
     from jsonb_array_elements((select p from _p3) -> 'tables' -> 'booking_lines') x limit 1),
  'and the reason — while who and when stay home with the audit row');

-- ---------------------------------------------------------------------------
-- Cross-org invisibility                                      [assert 29–30]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';   -- Rana
select is(
  pull_changes(0) -> 'tables' -> 'rate_cards', '[]'::jsonb,
  'Kamran''s owner pulls none of Lumos''s cards');
select is(
  pull_changes(0) -> 'tables' -> 'org_calendar_days', '[]'::jsonb,
  'nor its calendar');

select * from finish();
rollback;
