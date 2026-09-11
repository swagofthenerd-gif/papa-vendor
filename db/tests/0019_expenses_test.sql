-- ============================================================================
-- 0019 — The expense side of the money book
--
-- Every property the kharcha book claims, tested for the property it
-- ACTUALLY has (the 0007 rule). The load-bearing ones:
--
--   * append-only BOTH ways it is enforced: papa_app is stopped at the
--     withheld grant, a superuser at the trigger;
--   * every amount is positive and every kind is one of the six — at the
--     RPC (nameable errors) AND at the column layer (constraints);
--   * a reversal names its target, copies its kind and amount exactly, at
--     most once, never a reversal of a reversal — and the PAIR leaves every
--     sum (void-pair semantics, deliberately NOT the ledger's cancellation:
--     see 0019 D3);
--   * the three views do their arithmetic across kinds and exclusions:
--     job_margin = live charge-side income minus live expenses, per job;
--     asset_cost_history = purchase price + live repairs, per unit;
--     monthly_profit = earned − spent, timezone-neutral on server_time;
--   * roles gate both ways: owner/manager/desk write and read; warehouse,
--     readonly and driver write nothing and read ZERO ROWS (zero rows is
--     honest; zero rupees is not); org2 sees nothing of org1;
--   * expenses share the money rate budget (0017 D8);
--   * org_expenses never gains change_seq, and both sync guards stay at 0.
-- ============================================================================
begin;
select plan(58);

set local role postgres;

-- Captured ids that flow between calls (the 0016 _cap pattern, uuid-typed).
create temp table _ids (k text primary key, id uuid);
grant select, insert, update, delete on _ids to papa_app;

select fixture_rls_off();

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');

insert into users (id, display_name, phone) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech',    '+923000000002'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner',   '+923000000001'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif the driver', '+923000000003'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Zoya read-only',    '+923000000004'),
  ('99999999-9999-7999-8999-999999999999', 'Nadia the manager', '+923000000005'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Meesha at the desk','+923000000006'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (org2 owner)', '+923000000007');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner'),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver'),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly'),
  ('11111111-1111-7111-8111-111111111111', '99999999-9999-7999-8999-999999999999', 'manager'),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk'),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner');

insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9'),
  ('20000000-0000-7000-8000-000000000002', '22222222-2222-7222-8222-222222222222', 'camera', 'Kamran FX6');
insert into assets (id, org_id, product_id, asset_code, purchase_price_minor) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-02', 350000000),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-03', null),
  ('38888888-0000-7000-8000-000000000008', '22222222-2222-7222-8222-222222222222',
   '20000000-0000-7000-8000-000000000002', 'KAM-01', null);

insert into customers (id, org_id, name, phone) values
  ('55111111-1111-7111-8111-111111111111', '11111111-1111-7111-8111-111111111111',
   'Margin Films', '+923214440011');

-- J1: the job whose margin the views answer. JX: the other org's job.
insert into jobs (id, org_id, label, customer_id) values
  ('61111111-0019-7111-8111-111111111111', '11111111-1111-7111-8111-111111111111',
   'Margin Films / Eid rush', '55111111-1111-7111-8111-111111111111'),
  ('68888888-0019-7888-8888-888888888888', '22222222-2222-7222-8222-222222222222',
   'Kamran / not yours', null);

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Structure and hygiene
-- ---------------------------------------------------------------------------
select has_table('org_expenses');
select has_column('org_expenses', 'reversal_of');

select ok(
  (select i.indisunique from pg_index i
     join pg_class c on c.oid = i.indexrelid
    where c.relname = 'expenses_reversal_once_idx'),
  'the reversal_of index is UNIQUE — an expense can be voided at most once');

select is(
  (select count(*)::int from pg_proc
    where pronamespace = 'public'::regnamespace and prosecdef
      and proname in ('record_expense', 'reverse_expense')),
  2,
  'record_expense and reverse_expense are SECURITY DEFINER — the only door past the withheld grant');

select ok(
  (select bool_and(proconfig::text like '%search_path=public%')
     from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('record_expense', 'reverse_expense')),
  'and both pin search_path — the 0015 hygiene rule');

select hasnt_column('org_expenses', 'change_seq',
  'org_expenses is not syncable (D4) — the money book stays off the warehouse floor');

select is((select count(*)::int from sync_pii_violations()), 0,
  'the PII guard stays at zero — a counterparty name never rides a sync lane');

select is((select count(*)::int from sync_exclusion_violations()), 0,
  'and the exclusion guard stays at zero');

-- ---------------------------------------------------------------------------
-- The desk records expenses through the RPC; attribution from the GUCs
-- ---------------------------------------------------------------------------
set local papa.org_id     = '11111111-1111-7111-8111-111111111111';
set local papa.user_id    = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
set local papa.device_id  = 'DESK-01';
set local papa.session_id = '0aaaaaaa-0019-7000-8000-000000000001';
set local role papa_app;

-- The year's Rs 45,000 repair (JAN/JUN finding), backdated: paid the
-- workshop last week, recorded today — spent_at is the past fact (D6).
insert into _ids select 'rep', id from record_expense(
  'repair', 4500000,
  '30000000-0000-7000-8000-000000000001', null,
  '  Sharif Camera Works  ', 'FX9 top handle + mount',
  timestamptz '2026-01-10 07:00+00');

select is(
  (select created_by from org_expenses where id = (select id from _ids where k = 'rep')),
  'ffffffff-ffff-7fff-8fff-ffffffffffff'::uuid,
  'created_by is the papa.user_id GUC — the RPC signature has no actor argument to lie with');

select is(
  (select device_id from org_expenses where id = (select id from _ids where k = 'rep')),
  'DESK-01',
  'device attribution from papa.device_id');

select is(
  (select currency from org_expenses where id = (select id from _ids where k = 'rep')),
  'PKR',
  'currency comes from the org, not the caller');

select is(
  (select spent_at from org_expenses where id = (select id from _ids where k = 'rep')),
  timestamptz '2026-01-10 07:00+00',
  'spent_at is the backdated instant the caller stated — the past fact, not the recording moment');

select is(
  (select counterparty from org_expenses where id = (select id from _ids where k = 'rep')),
  'Sharif Camera Works',
  'the counterparty is stored trimmed — a receipt name, not whitespace');

-- The APR sub-hire, tied to the job it rescued (D5).
insert into _ids select 'sub', id from record_expense(
  'sub_hire', 240000,
  null, '61111111-0019-7111-8111-111111111111',
  'Noor Light & Grip', '2x 600D for the Eid job');

select is(
  (select job_id from org_expenses where id = (select id from _ids where k = 'sub')),
  '61111111-0019-7111-8111-111111111111'::uuid,
  'a sub-hire names the job it rescued');

-- A purchase with no links — a consumables-run shape, legal (D5).
insert into _ids select 'pur', id from record_expense(
  'purchase', 1600000, null, null, 'Hall Road', 'XLR cables x10');

select is(
  (select count(*)::int from org_expenses
    where id = (select id from _ids where k = 'pur')
      and asset_id is null and job_id is null),
  1,
  'an unlinked purchase is legal — forcing a link would invent data');

-- ---------------------------------------------------------------------------
-- Refusals at the door: kind, amount, tenancy, role
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select record_expense('bribe', 1000)$$,
  '22023', null,
  'an unknown kind is refused by name');

select throws_ok(
  $$select record_expense('repair', 0)$$,
  '23514', null,
  'a zero amount is refused — an expense is money that left');

select throws_ok(
  $$select record_expense('repair', -500)$$,
  '23514', null,
  'and a negative one — correction is a reversal row, never a negative amount');

select throws_ok(
  $$select record_expense('repair', 1000,
      '38888888-0000-7000-8000-000000000008')$$,
  '23503', null,
  'another org''s asset cannot carry this org''s repair — the DEFINER checks tenancy by hand');

select throws_ok(
  $$select record_expense('sub_hire', 1000, null,
      '68888888-0019-7888-8888-888888888888')$$,
  '23503', null,
  'nor can another org''s job');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select record_expense('repair', 1000)$$,
  '42501', null,
  'warehouse cannot write expenses — money is desk work (D8)');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select throws_ok(
  $$select record_expense('misc', 1000)$$,
  '42501', null,
  'readonly means readonly');

set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- driver
select throws_ok(
  $$select record_expense('transport', 1000)$$,
  '42501', null,
  'a driver records nothing — not even the fuel run');

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk again
select throws_ok(
  $$insert into org_expenses (org_id, kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111', 'misc', 1000,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '42501', null,
  'papa_app cannot INSERT directly — the withheld grant, before any trigger');

-- ---------------------------------------------------------------------------
-- Append-only, against the strongest attacker the database can host
-- ---------------------------------------------------------------------------
set local role postgres;
select throws_ok(
  $$update org_expenses set amount_minor = 1
     where id = (select id from _ids where k = 'rep')$$,
  '23001', null,
  'even a superuser cannot UPDATE an expense row — the trigger holds when grants do not');

select throws_ok(
  $$delete from org_expenses
     where id = (select id from _ids where k = 'rep')$$,
  '23001', null,
  'nor DELETE one');

set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
select throws_ok(
  $$update org_expenses set amount_minor = 1$$,
  '42501', null,
  'papa_app is stopped a layer earlier, at the missing grant');

-- ---------------------------------------------------------------------------
-- The column layer holds past every RPC
-- ---------------------------------------------------------------------------
set local role postgres;

select throws_ok(
  $$insert into org_expenses (org_id, kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111', 'repair', -4500000,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'a negative amount violates the constraint even for a superuser');

select throws_ok(
  $$insert into org_expenses (org_id, kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111', 'entertainment', 1000,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'and so does a kind outside the six');

-- The trigger's reversal rules hold on bare inserts too (D3).
select throws_matching(
  $$insert into org_expenses (org_id, kind, amount_minor, reversal_of, created_by)
    values ('11111111-1111-7111-8111-111111111111', 'misc', 4500000,
            (select id from _ids where k = 'rep'),
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  'must keep the kind',
  'a reversal that changes kind is refused — the pair must read as one voided fact');

select throws_matching(
  $$insert into org_expenses (org_id, kind, amount_minor, reversal_of, created_by)
    values ('11111111-1111-7111-8111-111111111111', 'repair', 999,
            (select id from _ids where k = 'rep'),
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  'match its target exactly',
  'and so is a partial void — half an expense never happened is not a fact');

set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

-- ---------------------------------------------------------------------------
-- reverse_expense: copies its target, once, audited
-- ---------------------------------------------------------------------------
insert into _ids select 'purrev', id
  from reverse_expense((select id from _ids where k = 'pur'),
                       'wrong shop — entered twice');

select is(
  (select kind from org_expenses where id = (select id from _ids where k = 'purrev')),
  'purchase',
  'the reversal row copies its target''s kind — the RPC copies, the caller cannot mis-copy');

select is(
  (select amount_minor from org_expenses where id = (select id from _ids where k = 'purrev')),
  1600000::bigint,
  'and its amount, exactly');

set local role postgres;
select ok(
  exists (select 1 from audit_log
           where action = 'expense_reversal'
             and subject_id = (select id from _ids where k = 'pur')),
  'a reversal rewrites the house''s own money record — audited');
set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

select throws_matching(
  $$select reverse_expense((select id from _ids where k = 'pur'))$$,
  'already reversed',
  'a SECOND reversal of the same expense is refused — it would over-credit the house');

select throws_matching(
  $$select reverse_expense((select id from _ids where k = 'purrev'))$$,
  'cannot reverse a reversal',
  'un-voiding a void is a fresh record_expense, not a chain');

-- Cross-org: org2's owner cannot reverse (or even see) org1's expense.
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
select throws_ok(
  $$select reverse_expense((select id from _ids where k = 'rep'))$$,
  '23503', null,
  'another org''s expense does not reverse from here — the DEFINER carries its own org predicate');

select is((select count(*)::int from org_expenses), 0,
  'and org2 reads ZERO org1 expense rows');

select is((select count(*)::int from monthly_profit), 0,
  'monthly_profit shows org2 nothing of org1''s year');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

-- ---------------------------------------------------------------------------
-- The view math, across kinds and every exclusion (D9)
-- ---------------------------------------------------------------------------
-- Income on J1: a charge, a late fee, a damage charge — plus one corrected
-- charge and one reversed charge, which must NOT count.
insert into _ids select 'chg', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'charge', 1000000,
  '61111111-0019-7111-8111-111111111111',
  '30000000-0000-7000-8000-000000000001', 'FX9, Eid week');
insert into _ids select 'fee', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'late_fee', 200000,
  '61111111-0019-7111-8111-111111111111', null, 'two days late');
insert into _ids select 'dmg', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'damage_charge', 300000,
  '61111111-0019-7111-8111-111111111111', null, 'cracked filter');
insert into _ids select 'typo', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'charge', 500000,
  '61111111-0019-7111-8111-111111111111', null, 'typo: quoted 4k');
insert into _ids select 'typofix', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'charge', 400000,
  '61111111-0019-7111-8111-111111111111', null, 'corrected to the quote',
  (select id from _ids where k = 'typo'));
insert into _ids select 'ghost', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'charge', 250000,
  '61111111-0019-7111-8111-111111111111', null, 'charged, then it turned up');
insert into _ids select 'ghostrev', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'reversal', -250000,
  '61111111-0019-7111-8111-111111111111', null, 'came back on the other truck', null,
  (select id from _ids where k = 'ghost'));

-- Expenses on J1: the live sub-hire, plus a transport run that gets voided.
insert into _ids select 'fuel', id from record_expense(
  'transport', 60000, null, '61111111-0019-7111-8111-111111111111',
  null, 'double-entered fuel run');
insert into _ids select 'fuelrev', id
  from reverse_expense((select id from _ids where k = 'fuel'), 'entered twice');

select is(
  (select income_minor from job_margin
    where job_id = '61111111-0019-7111-8111-111111111111'),
  1900000::bigint,
  'job income = live charge-side lines only: the corrected charge counts at its corrected figure, the reversed one not at all');

select is(
  (select expense_minor from job_margin
    where job_id = '61111111-0019-7111-8111-111111111111'),
  240000::bigint,
  'job expenses = the live sub-hire; the voided fuel run and its reversal both left the sum');

select is(
  (select margin_minor from job_margin
    where job_id = '61111111-0019-7111-8111-111111111111'),
  1660000::bigint,
  'margin = income minus expenses — what the Eid job actually made');

-- Asset cost history: purchase price + repairs, exclusions live (D3).
insert into _ids select 'rep2', id from record_expense(
  'repair', 500000, '30000000-0000-7000-8000-000000000001', null,
  'Sharif Camera Works', 'viewfinder cable');

select is(
  (select repair_minor from asset_cost_history
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  5000000::bigint,
  'asset_cost_history sums the unit''s repairs');

select is(
  (select repair_count from asset_cost_history
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  2,
  'and counts them');

select is(
  (select total_cost_minor from asset_cost_history
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  355000000::bigint,
  'total cost = the recorded purchase price plus every live repair — the other half of the payback question');

insert into _ids select 'rep2rev', id
  from reverse_expense((select id from _ids where k = 'rep2'), 'was warranty work');

select is(
  (select repair_minor from asset_cost_history
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  4500000::bigint,
  'a voided repair leaves the cost history the moment its reversal lands');

select is(
  (select repair_count from asset_cost_history
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  1,
  'in count as well as in money');

-- Monthly profit: one UTC month holds everything this test wrote via the
-- RPCs (server_time = now() for all of it; spent_at does NOT move the
-- bucket — D7's coarse, documented boundary).
select is(
  (select earned_minor from monthly_profit
    where month = date_trunc('month', now() at time zone 'UTC')),
  1900000::bigint,
  'the month earned what its live charge-side lines say');

select is(
  (select spent_minor from monthly_profit
    where month = date_trunc('month', now() at time zone 'UTC')),
  4740000::bigint,
  'and spent the live repair + sub-hire; every voided pair is out');

select is(
  (select profit_minor from monthly_profit
    where month = date_trunc('month', now() at time zone 'UTC')),
  -2840000::bigint,
  'profit = earned − spent, and a loss month reads as the honest negative it is');

-- ---------------------------------------------------------------------------
-- Reads gate by role: zero rows, never zero rupees (D4)
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select is((select count(*)::int from org_expenses), 0,
  'a warehouse phone reads no expense rows — what the house pays a workshop is not floor business');
select is((select count(*)::int from job_margin), 0,
  'job_margin shows it zero ROWS, not every job at margin zero');
select is((select count(*)::int from asset_cost_history), 0,
  'asset_cost_history likewise');
select is((select count(*)::int from monthly_profit), 0,
  'and the profit line is not for the floor either');

set local papa.user_id = '99999999-9999-7999-8999-999999999999';   -- manager
select ok(
  (select count(*) from org_expenses) > 0,
  'a manager reads the book');
select ok(
  exists (select 1 from monthly_profit
           where month = date_trunc('month', now() at time zone 'UTC')),
  'profit included');

-- ---------------------------------------------------------------------------
-- The shared money budget (0017 D8): an expense is a money write
-- ---------------------------------------------------------------------------
set local role postgres;
insert into rate_limits (bucket, window_start, count)
select 'money:11111111-1111-7111-8111-111111111111:ffffffff-ffff-7fff-8fff-ffffffffffff',
       w, 999
  from unnest(array[
    date_bin('1 minute', now(), timestamptz 'epoch'),
    date_bin('1 minute', now(), timestamptz 'epoch') + interval '1 minute']) w
on conflict (bucket, window_start) do update set count = 999;

set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

select throws_ok(
  $$select record_expense('misc', 1000)$$,
  '53300', null,
  'a runaway client hits the SHARED money budget — expenses and ledger writes drain one bucket');

select throws_ok(
  $$select reverse_expense((select id from _ids where k = 'rep'))$$,
  '53300', null,
  'reversals drain it too — checked before the target is even looked up');

select * from finish();
rollback;
