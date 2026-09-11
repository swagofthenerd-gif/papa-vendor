-- ============================================================================
-- 0024 — Rate cards and the pricing pipeline: every property the migration
-- claims, tested for the property it ACTUALLY has (the 0007 rule). The
-- load-bearing ones are the GOLDEN FIXTURES for the pipeline:
--
--   * the 3-day week: 10 days = 1 week (3) + 3 = 6 billable; 14 days = 6;
--     8 days = 3 + 1 = 4; a 6-day remainder is capped at 3;
--   * a day is 24h from pickup: back one minute late bills the next day;
--   * the weekend mask drops named dates, and a weekend-only job still
--     bills min_billable_days; min_billable_days floors a 1-day job to 2;
--   * a 3-day job crossing a 1.25x Eid day is billed x1.25, booking-wide,
--     the trace naming the driving day; the max wins over a 1.0 season;
--   * an unpriced line is COUNTED and null, never zero; a 0 rate IS a
--     price; removing an entry sends the line back to unpriced;
--   * the override replaces the card rate, reports the original, ignores
--     the multiplier (the owner's last word), needs a reason, needs a
--     manager, is audited, and clears back to the card;
--   * margin: sub-hire cost tagged to the booking, or to the job the
--     booking became, nets out of the quote; a reversal takes it back;
--   * indicative flips false only when confirmed AND fully priced;
--   * one default card per org, the first card is default automatically;
--     the calendar seed is idempotent and never resurrects a cleared day;
--   * role gates both ways, cross-org invisibility both ways, and both
--     sync guards stay at zero.
-- ============================================================================
begin;
select plan(100);

set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos', '{}'::jsonb),
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

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack');

insert into products (id, org_id, category, display_name, tracking_mode,
                      replacement_value_minor) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'camera', 'Sony FX9', 'serialized', 350000000),
  ('20000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'cable', 'XLR Cable 5m', 'bulk', 800000),
  ('20000000-0000-7000-8000-000000000004', '11111111-1111-7111-8111-111111111111',
   'case', 'Peli 1650', 'serialized', 500000),
  ('20000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'camera', 'RED Komodo', 'serialized', 250000000);

insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-A'),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX-B'),
  ('30000000-0000-7000-8000-000000000006', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000004', 'CASE-1'),
  ('30000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   '20000000-0000-7000-8000-000000000009', 'KMD-1');

insert into stock_lots (id, org_id, product_id, location_id, qty_on_hand) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000003',
   '10000000-0000-7000-8000-000000000001', 10);

insert into customers (id, org_id, name, phone, blacklisted) values
  ('50000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   'Zindagi Films', '03001234567', false),
  ('50000000-0000-7000-8000-000000000009', '22222222-2222-7222-8222-222222222222',
   'Kamran Client', null, false);

-- Zindagi Films is verified so confirm_booking stays out of the way.
insert into customer_credentials (org_id, customer_id, kind, guarantor_name,
                                  guarantor_phone, verified_by, verified_at)
values ('11111111-1111-7111-8111-111111111111',
        '50000000-0000-7000-8000-000000000003',
        'guarantor', 'Haji Saab', '03211112222',
        'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', now());

select fixture_rls_on();

-- Every priced trace this file reads comes through these two (created as
-- postgres, run as the caller: INVOKER SQL, rolled back with the file).
create or replace function _step(p_booking uuid, p_step int, p_card uuid default null)
returns jsonb language sql as $$
  select x from price_booking(p_booking, p_card) r,
         jsonb_array_elements(r -> 'steps') x
   where (x ->> 'step')::int = p_step
$$;
create or replace function _line(p_booking uuid, p_product uuid, p_card uuid default null)
returns jsonb language sql as $$
  select x from price_booking(p_booking, p_card) r,
         jsonb_array_elements(r -> 'lines') x
   where (x ->> 'product_id')::uuid = p_product
$$;

-- ---------------------------------------------------------------------------
-- Schema and privilege shape                                    [assert 1–9]
-- ---------------------------------------------------------------------------
select has_table('rate_cards');
select has_table('rate_card_entries');
select has_table('org_calendar_days');

select is(
  (select count(*)::int from pg_class
    where relname in ('rate_cards', 'rate_card_entries', 'org_calendar_days')
      and relnamespace = 'public'::regnamespace
      and not (relrowsecurity and relforcerowsecurity)),
  0, 'RLS is enabled AND forced on all three pricing tables');

select ok(
  (select bool_and(p.proconfig::text like '%search_path=public%')
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and p.proname in ('price_booking', 'set_line_rate_override',
                        'upsert_rate_card', 'upsert_rate_entry',
                        'set_calendar_day', 'clear_calendar_day',
                        'ensure_default_calendar', 'booking_sub_hire_cost',
                        'record_expense')),
  'every 0024 DEFINER function pins search_path');

select ok(
  not has_table_privilege('papa_app', 'rate_cards', 'insert')
  and not has_table_privilege('papa_app', 'rate_card_entries', 'insert')
  and not has_table_privilege('papa_app', 'org_calendar_days', 'insert')
  and not has_table_privilege('papa_app', 'rate_cards', 'update'),
  'papa_app cannot write the pricing tables directly — the RPCs are the only door');

select has_column('booking_lines', 'rate_minor');
select has_column('booking_lines', 'original_rate_minor');
select has_column('org_expenses', 'booking_id');

-- ---------------------------------------------------------------------------
-- Rate cards: the default rule and role gates                 [assert 10–21]
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
set local role papa_app;

select throws_ok(
  $$select upsert_rate_card('Desk card')$$,
  '42501', null, 'the desk cannot create a rate card — owner|manager only');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select upsert_rate_card('Warehouse card')$$,
  '42501', null, 'nor can the warehouse');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner

-- Card A: the golden card. weekend_mask emptied on purpose so the
-- brief's day counts hold on any calendar date; the mask gets its own
-- card (B) below.
create temp table _cards (k text primary key, id uuid) on commit drop;
insert into _cards select 'A', (upsert_rate_card(
  'Standard', null, null, null, null, '{}'::int[]) ->> 'id')::uuid;

select is(
  (select c.is_default from rate_cards c where c.id = (select id from _cards where k = 'A')),
  true, 'the first card an org creates becomes the default by itself (D10)');

select is(
  (select c.week_equals_days from rate_cards c
    where c.id = (select id from _cards where k = 'A')),
  3::numeric, 'week_equals_days defaults to 3 (ASSUMPTION #week-rate)');

-- Card B: weekend-free (the default mask).
insert into _cards select 'B', (upsert_rate_card('Weekend free') ->> 'id')::uuid;

select is(
  (select c.weekend_mask from rate_cards c where c.id = (select id from _cards where k = 'B')),
  '{6,7}'::int[], 'weekend_mask defaults to Sat/Sun (ASSUMPTION #weekend)');

select is(
  (select c.is_default from rate_cards c where c.id = (select id from _cards where k = 'B')),
  false, 'a second card does not steal the default');

-- Card C: a 2-day minimum, made default then handed back.
insert into _cards select 'C', (upsert_rate_card(
  'Two-day minimum', null, true, null, 2) ->> 'id')::uuid;

select is(
  (select array_agg(c.name order by c.name) from rate_cards c
    where c.org_id = '11111111-1111-7111-8111-111111111111'
      and c.is_default and c.deleted_at is null),
  array['Two-day minimum'],
  'setting is_default on a new card clears the previous default — exactly one');

select is(
  (upsert_rate_card('Standard', (select id from _cards where k = 'A'), true)
     ->> 'is_default')::boolean,
  true, 'and the default can be handed back by editing the old card');

select is(
  (select c.min_billable_days from rate_cards c
    where c.id = (select id from _cards where k = 'C')),
  2, 'edit-with-nulls kept the knobs it was not given');

select throws_like(
  $$select upsert_rate_card('   ')$$,
  '%needs a name%', 'a blank card name is refused');

select throws_ok(
  $$select upsert_rate_card('Bad week', null, null, 0)$$,
  '23514', null, 'week_equals_days must be positive (check constraint)');

select throws_ok(
  $$select upsert_rate_card('Bad mask', null, null, null, null, '{8}'::int[])$$,
  '23514', null, 'a weekend mask outside 1..7 is refused');

-- ---------------------------------------------------------------------------
-- Entries                                                     [assert 22–27]
-- ---------------------------------------------------------------------------
select is(
  (upsert_rate_entry((select id from _cards where k = 'A'),
                     '20000000-0000-7000-8000-000000000001', 2500000)
     ->> 'day_rate_minor')::bigint,
  2500000::bigint, 'FX9 priced at Rs 25,000/day on the Standard card');

select lives_ok(
  $$select upsert_rate_entry((select id from _cards where k = 'A'),
                             '20000000-0000-7000-8000-000000000003', 30000)$$,
  'XLR priced at Rs 300/day');

select is(
  (upsert_rate_entry((select id from _cards where k = 'A'),
                     '20000000-0000-7000-8000-000000000001', 2600000)
     ->> 'day_rate_minor')::bigint,
  2600000::bigint, 'setting the same product again UPDATES the entry (unique per card+product)');

select lives_ok(
  $$select upsert_rate_entry((select id from _cards where k = 'A'),
                             '20000000-0000-7000-8000-000000000001', 2500000)$$,
  'and back to Rs 25,000');

select throws_like(
  $$select upsert_rate_entry((select id from _cards where k = 'A'),
                             '20000000-0000-7000-8000-000000000001', -1)$$,
  '%cannot be negative%', 'a negative rate is refused');

select throws_like(
  $$select upsert_rate_entry((select id from _cards where k = 'A'),
                             '20000000-0000-7000-8000-000000000009', 100)$$,
  '%does not belong to this org%', 'another org''s product cannot be priced here');

-- Cards B and C get the same two rates so the day math is comparable.
select upsert_rate_entry((select id from _cards where k = 'B'),
                         '20000000-0000-7000-8000-000000000001', 2500000);
select upsert_rate_entry((select id from _cards where k = 'C'),
                         '20000000-0000-7000-8000-000000000001', 2500000);

-- ---------------------------------------------------------------------------
-- Bookings for the golden fixtures (desk creates; Zindagi is verified)
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

create temp table _b (k text primary key, id uuid) on commit drop;

-- B10: ten days, Mon Apr 1 -> Thu Apr 11 (10:00 PKT both ends).
-- FX9 x2 (priced), XLR x4 (priced), CASE-1 (unpriced).
insert into _b select '10', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-04-01 10:00+05', '2030-04-11 10:00+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 2},
    {"product_id": "20000000-0000-7000-8000-000000000003", "qty": 4},
    {"asset_id": "30000000-0000-7000-8000-000000000006"}]'::jsonb
) ->> 'booking_id')::uuid;

-- B14: fourteen days, one FX9.
insert into _b select '14', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-04-01 10:00+05', '2030-04-15 10:00+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
) ->> 'booking_id')::uuid;

-- B8: eight days, one FX9.
insert into _b select '8', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-04-01 10:00+05', '2030-04-09 10:00+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
) ->> 'booking_id')::uuid;

-- B6: six days — the remainder cap.
insert into _b select '6', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-04-01 10:00+05', '2030-04-07 10:00+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
) ->> 'booking_id')::uuid;

-- B1: one day, and B1L: one day plus one minute.
insert into _b select '1', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-04-01 10:00+05', '2030-04-02 10:00+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
) ->> 'booking_id')::uuid;
insert into _b select '1L', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-04-01 10:00+05', '2030-04-02 10:01+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
) ->> 'booking_id')::uuid;

-- BW: a weekend-only job, Sat Apr 6 -> Mon Apr 8.
insert into _b select 'W', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-04-06 10:00+05', '2030-04-08 10:00+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
) ->> 'booking_id')::uuid;

-- BE: three days crossing Eid (Mon May 6 -> Thu May 9).
insert into _b select 'E', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-05-06 10:00+05', '2030-05-09 10:00+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
) ->> 'booking_id')::uuid;

-- BS: two days inside the wedding season (Dec 10-12 2030).
insert into _b select 'S', (create_booking(
  '50000000-0000-7000-8000-000000000003',
  tstzrange('2030-12-10 10:00+05', '2030-12-12 10:00+05', '[)'),
  '[{"product_id": "20000000-0000-7000-8000-000000000001", "qty": 1}]'::jsonb
) ->> 'booking_id')::uuid;

-- ---------------------------------------------------------------------------
-- Golden fixtures: steps 1 and 2 (D2, D4)                     [assert 28–39]
-- ---------------------------------------------------------------------------
select is((_step((select id from _b where k = '10'), 1) ->> 'calendar_days')::int,
  10, 'Apr 1 10:00 -> Apr 11 10:00 is ten calendar days');
select is((_step((select id from _b where k = '10'), 2) ->> 'weeks')::int,
  1, 'ten days hold one full week');
select is((_step((select id from _b where k = '10'), 2) ->> 'remainder_days')::int,
  3, 'with three days over');
select is((_step((select id from _b where k = '10'), 2) ->> 'billable_days')::numeric,
  6::numeric, 'GOLDEN: 10 days on a 3-day week = 3 + 3 = 6 billable days');

select is((_step((select id from _b where k = '14'), 2) ->> 'billable_days')::numeric,
  6::numeric, 'GOLDEN: 14 days = two weeks = 6');

select is((_step((select id from _b where k = '8'), 2) ->> 'billable_days')::numeric,
  4::numeric, 'GOLDEN: 8 days = 3 + 1 = 4');

select is((_step((select id from _b where k = '6'), 2) ->> 'remainder_billed')::numeric,
  3::numeric, 'a 6-day remainder is capped at the week rate (3)');
select is((_step((select id from _b where k = '6'), 2) ->> 'billable_days')::numeric,
  3::numeric, 'so 6 days bill the same as a week — never more');

select is((_step((select id from _b where k = '1'), 1) ->> 'calendar_days')::int,
  1, 'out at 10:00, back at 10:00 the next day is ONE day (D2)');
select is((_step((select id from _b where k = '1L'), 1) ->> 'calendar_days')::int,
  2, 'back one minute late bills the next day');

select is((_step((select id from _b where k = '1'), 1) ->> 'first_day'),
  '2030-04-01', 'the first day is dated in the org timezone (Asia/Karachi)');

select is((_step((select id from _b where k = '1'), 2, (select id from _cards where k = 'C'))
             ->> 'billable_days')::numeric,
  2::numeric, 'min_billable_days=2 floors a one-day job to two');

-- ---------------------------------------------------------------------------
-- The weekend mask (D3)                                       [assert 40–45]
-- ---------------------------------------------------------------------------
select is((_step((select id from _b where k = '10'), 1) ->> 'weekend_days_dropped')::int,
  0, 'the golden card (empty mask) drops nothing');

select is((_step((select id from _b where k = '10'), 1, (select id from _cards where k = 'B'))
             ->> 'weekend_days_dropped')::int,
  2, 'the weekend-free card drops Sat 6 and Sun 7 from the ten-day job');
select is(_step((select id from _b where k = '10'), 1, (select id from _cards where k = 'B'))
             -> 'dropped_dates',
  '["2030-04-06", "2030-04-07"]'::jsonb, 'and names the dropped dates in the trace');
select is((_step((select id from _b where k = '10'), 2, (select id from _cards where k = 'B'))
             ->> 'billable_days')::numeric,
  4::numeric, '8 counted days -> 1 week + 1 = 4 billable');

select is((_step((select id from _b where k = 'W'), 1, (select id from _cards where k = 'B'))
             ->> 'min_applied')::boolean,
  true, 'a Sat->Mon job on the weekend-free card hits the minimum');
select is((_step((select id from _b where k = 'W'), 2, (select id from _cards where k = 'B'))
             ->> 'billable_days')::numeric,
  1::numeric, 'and still bills one day — never zero');

-- ---------------------------------------------------------------------------
-- Steps 3 and 6: card rates, unpriced counted not zeroed (D5) [assert 46–57]
-- ---------------------------------------------------------------------------
select is((_line((select id from _b where k = '10'), '20000000-0000-7000-8000-000000000001')
             ->> 'line_total_minor')::bigint,
  30000000::bigint, 'FX9 x2 x 6 days x Rs 25,000 = Rs 300,000');
select is((_line((select id from _b where k = '10'), '20000000-0000-7000-8000-000000000003')
             ->> 'line_total_minor')::bigint,
  720000::bigint, 'XLR x4 x 6 days x Rs 300 = Rs 7,200');

select is((_line((select id from _b where k = '10'), '20000000-0000-7000-8000-000000000004')
             ->> 'priced')::boolean,
  false, 'the Peli case has no entry: priced=false');
select is(_line((select id from _b where k = '10'), '20000000-0000-7000-8000-000000000004')
             -> 'line_total_minor',
  'null'::jsonb, 'its total is NULL — counted, never zero (money honesty)');
select is(_line((select id from _b where k = '10'), '20000000-0000-7000-8000-000000000004')
             ->> 'asset_code',
  'CASE-1', 'an asset line reports its unit code');

select is((price_booking((select id from _b where k = '10')) -> 'totals' ->> 'subtotal_minor')::bigint,
  30720000::bigint, 'subtotal sums only the priced lines');
select is((price_booking((select id from _b where k = '10')) -> 'totals' ->> 'unpriced_count')::int,
  1, 'and reports one unpriced line');
select is(price_booking((select id from _b where k = '10')) -> 'totals' -> 'indicative_reasons',
  '["unpriced_lines", "not_confirmed"]'::jsonb,
  'the quote is indicative for two named reasons');
select is((_step((select id from _b where k = '10'), 3) ->> 'unpriced_lines')::int,
  1, 'step 3 names the unpriced line count');

-- A zero rate IS a price; a removed entry is not.
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
select upsert_rate_entry((select id from _cards where k = 'A'),
                         '20000000-0000-7000-8000-000000000004', 0);
select is((_line((select id from _b where k = '10'), '20000000-0000-7000-8000-000000000004')
             ->> 'line_total_minor')::bigint,
  0::bigint, 'an explicit Rs 0 entry prices the case at zero (an included item)');
select is((upsert_rate_entry((select id from _cards where k = 'A'),
                             '20000000-0000-7000-8000-000000000004', null) ->> 'removed')::boolean,
  true, 'a null rate removes the entry');
select is((price_booking((select id from _b where k = '10')) -> 'totals' ->> 'unpriced_count')::int,
  1, 'and the case is unpriced again, not zero');

-- ---------------------------------------------------------------------------
-- Step 4: the calendar multiplier (D6, D7)                    [assert 58–70]
-- ---------------------------------------------------------------------------
select is((set_calendar_day('2030-05-07', 'holiday', 'Eid ul-Fitr', 1.25) ->> 'rate_multiplier')::numeric,
  1.25::numeric, 'Eid is a data row with a multiplier');

select is((_step((select id from _b where k = 'E'), 4) ->> 'multiplier')::numeric,
  1.25::numeric, 'GOLDEN: a 3-day job crossing Eid carries x1.25');
select is(_step((select id from _b where k = 'E'), 4) -> 'driven_by' ->> 'name',
  'Eid ul-Fitr', 'and the trace names the day that drove it');
select is((_line((select id from _b where k = 'E'), '20000000-0000-7000-8000-000000000001')
             ->> 'line_total_minor')::bigint,
  9375000::bigint, '3 days x Rs 25,000 x 1.25 = Rs 93,750');

select is((_step((select id from _b where k = '10'), 4) ->> 'multiplier')::numeric,
  1.0::numeric, 'a booking with no calendar day inside it is x1.0');
select is(_step((select id from _b where k = '10'), 4) -> 'driven_by',
  'null'::jsonb, 'with nothing driving it');

-- A second, smaller holiday on the same booking: the MAX wins.
select set_calendar_day('2030-05-08', 'holiday', 'Eid holiday 2', 1.10);
select is((_step((select id from _b where k = 'E'), 4) ->> 'multiplier')::numeric,
  1.25::numeric, 'two calendar days inside the period: the higher multiplier wins (D7)');

select is(ensure_default_calendar(2030), 90,
  'the wedding season seeds Dec 1 2030 -> Feb 28 2031: 90 rows');
select is(ensure_default_calendar(2030), 0,
  'seeding again inserts nothing (idempotent)');
select is((_step((select id from _b where k = 'S'), 4) ->> 'multiplier')::numeric,
  1.0::numeric, 'a December job is shaded, not surcharged (ASSUMPTION #seasonal-pricing)');
select is(_step((select id from _b where k = 'S'), 4) -> 'driven_by' ->> 'kind',
  'season', 'but the trace still says it is in season');

select is(clear_calendar_day('2030-12-25', 'season'), true, 'a season day can be cleared');
select is(ensure_default_calendar(2030), 0,
  'and the seed never resurrects it');
select is((set_calendar_day('2030-12-25', 'season', 'Wedding season', 1.0) ->> 'day'),
  '2030-12-25', 'set_calendar_day revives it explicitly');

-- ---------------------------------------------------------------------------
-- Step 5: the override (D8, overrides 17/18)                  [assert 71–83]
-- ---------------------------------------------------------------------------
create temp table _l (k text primary key, id uuid) on commit drop;
insert into _l select '14fx', l.id from booking_lines l
  where l.booking_id = (select id from _b where k = '14') and l.deleted_at is null;
insert into _l select 'Efx', l.id from booking_lines l
  where l.booking_id = (select id from _b where k = 'E') and l.deleted_at is null;

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
select throws_ok(
  $$select set_line_rate_override((select id from _l where k = '14fx'), 2000000, 'old client')$$,
  '42501', null, 'the desk cannot override a rate — the override is a manager''s act');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
select throws_like(
  $$select set_line_rate_override((select id from _l where k = '14fx'), 2000000, '  ')$$,
  '%needs a reason%', 'an override without a reason is refused');
select throws_like(
  $$select set_line_rate_override((select id from _l where k = '14fx'), -5, 'typo')$$,
  '%cannot be negative%', 'a negative override is refused');

select is(
  (set_line_rate_override((select id from _l where k = '14fx'), 2000000,
                          'Zindagi: long-standing client, Rs 20,000 agreed')
     ->> 'original_rate_minor')::bigint,
  2500000::bigint, 'the override records the card rate it replaced');

select is((_line((select id from _b where k = '14'), '20000000-0000-7000-8000-000000000001')
             ->> 'line_total_minor')::bigint,
  12000000::bigint, '6 days x Rs 20,000 = Rs 120,000 — the override replaces the card rate');
select is(_line((select id from _b where k = '14'), '20000000-0000-7000-8000-000000000001')
             -> 'override' ->> 'reason',
  'Zindagi: long-standing client, Rs 20,000 agreed', 'and the line carries the reason');
select is((_line((select id from _b where k = '14'), '20000000-0000-7000-8000-000000000001')
             -> 'override' ->> 'by')::uuid,
  'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb'::uuid, 'and WHO overrode it');
select is((_step((select id from _b where k = '14'), 5) ->> 'overridden_lines')::int,
  1, 'step 5 counts the overridden line');

-- The override on the Eid booking: the owner's number is final, no x1.25.
select set_line_rate_override((select id from _l where k = 'Efx'), 2000000, 'Eid goodwill');
select is((_line((select id from _b where k = 'E'), '20000000-0000-7000-8000-000000000001')
             ->> 'multiplier_applied')::boolean,
  false, 'the calendar multiplier does not apply on top of an override (D8)');
select is((_line((select id from _b where k = 'E'), '20000000-0000-7000-8000-000000000001')
             ->> 'line_total_minor')::bigint,
  6000000::bigint, '3 days x Rs 20,000 = Rs 60,000, not x1.25');

select is(
  (select count(*)::int from audit_log a
    where a.action = 'line_rate_override'
      and a.subject_id = (select id from _l where k = '14fx')),
  1, 'the override is audited (override 17)');

select lives_ok(
  $$select set_line_rate_override((select id from _l where k = 'Efx'), null, 'client withdrew the ask')$$,
  'a null rate clears the override');
select is((_line((select id from _b where k = 'E'), '20000000-0000-7000-8000-000000000001')
             ->> 'line_total_minor')::bigint,
  9375000::bigint, 'and the line prices from the card and the calendar again');

-- ---------------------------------------------------------------------------
-- Margin before quote (D9) and the indicative flag            [assert 84–91]
-- ---------------------------------------------------------------------------
select is((price_booking((select id from _b where k = '14')) -> 'totals' ->> 'sub_hire_cost_minor')::bigint,
  0::bigint, 'no expenses yet: sub-hire cost is zero');

create temp table _x (k text primary key, id uuid) on commit drop;
insert into _x select 'sub', id from record_expense(
  'sub_hire', 500000, null, null, 'Kamran Rentals', 'second FX9 body', null,
  (select id from _b where k = '14'));

select is((price_booking((select id from _b where k = '14')) -> 'totals' ->> 'sub_hire_cost_minor')::bigint,
  500000::bigint, 'an expense tagged to the booking is its cost');
select is((price_booking((select id from _b where k = '14')) -> 'totals' ->> 'margin_minor')::bigint,
  11500000::bigint, 'margin = subtotal (Rs 120,000) - cost (Rs 5,000)');

select reverse_expense((select id from _x where k = 'sub'), 'they never sent it');
select is((price_booking((select id from _b where k = '14')) -> 'totals' ->> 'sub_hire_cost_minor')::bigint,
  0::bigint, 'a reversed expense leaves the cost (0019 void-pair rule)');

-- Confirm, convert, and the cost that lands on the JOB still counts.
select is((confirm_booking((select id from _b where k = '14')) ->> 'status'),
  'confirmed', 'booking 14 confirms (verified customer)');
select is((price_booking((select id from _b where k = '14')) -> 'totals' ->> 'indicative')::boolean,
  false, 'confirmed AND fully priced: the quote is no longer indicative');

select record_expense('transport', 20000,
  p_job_id => convert_booking_to_job((select id from _b where k = '14')),
  p_note => 'Suzuki to set');
select is((price_booking((select id from _b where k = '14')) -> 'totals' ->> 'sub_hire_cost_minor')::bigint,
  20000::bigint, 'an expense on the job the booking became counts against the booking');

-- ---------------------------------------------------------------------------
-- No card at all, and the desk/readonly views                  [assert 92–98]
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select price_booking((select id from _b where k = '10'))$$,
  '42501', null, 'the warehouse cannot price a booking (D12)');
select is((select count(*)::int from rate_cards), 0,
  'and sees no rate cards at all (RLS role gate, D11)');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select is((select count(*)::int from org_calendar_days where deleted_at is null), 92,
  'readonly still sees the calendar (90 season + 2 holidays): shading is for everyone');

-- Kamran: no card, foreign booking, cross-org invisibility.
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';   -- Rana

select is((select count(*)::int from rate_cards), 0,
  'Kamran''s owner sees none of Lumos''s three cards');

select throws_like(
  $$select price_booking((select id from _b where k = '10'))$$,
  '%does not belong to this org%', 'pricing a foreign booking is refused');

-- Two statements on purpose: price_booking is STABLE and would not see a
-- booking created inside the same statement.
insert into _b select 'K', (create_booking(
  '50000000-0000-7000-8000-000000000009',
  tstzrange('2030-04-01 10:00+05', '2030-04-04 10:00+05', '[)'),
  '[{"asset_id": "30000000-0000-7000-8000-000000000009"}]'::jsonb
) ->> 'booking_id')::uuid;

select throws_like(
  $$select record_expense('transport', 100, null, null, null, null, null,
      (select id from _b where k = '10'))$$,
  '%does not belong to this org%',
  'an expense cannot be tagged to a foreign booking (null lookup under the predicate)');

select is(price_booking((select id from _b where k = 'K')) -> 'totals' -> 'indicative_reasons',
  '["unpriced_lines", "not_confirmed", "no_rate_card"]'::jsonb,
  'an org with no rate card gets an all-unpriced trace that says why');

-- ---------------------------------------------------------------------------
-- The sync guards stay at zero                                [assert 99–100]
-- ---------------------------------------------------------------------------
set local role postgres;

select is((select count(*)::int from sync_pii_violations()), 0,
  'no PII column has become syncable');
select is((select count(*)::int from sync_exclusion_violations()), 0,
  'every registered column exclusion still holds');

select * from finish();
rollback;
