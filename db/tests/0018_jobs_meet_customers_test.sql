-- ============================================================================
-- 0018 — Jobs meet customers
--
-- Every property the close/reopen door and the reversal verb claim, tested
-- for the property it ACTUALLY has (the 0007 rule). The load-bearing ones:
--
--   * a job closes only when NO asset still projects onto it — refused with
--     the count, on the RPC path AND on bare DML (the trigger backstop);
--   * status and closed_at can never disagree: stamped on close, cleared on
--     reopen, on every write path including a direct insert of a closed row;
--   * closing is owner/manager/desk; reopening is owner/manager only, and
--     both leave an audit row;
--   * 'reversal' cancels its target EXACTLY (amount negated, same org, same
--     customer, never a deposit line, never a reversal), at most once, and
--     the two correction verbs exclude each other per target — an entry
--     voided by both would double-cancel in every balance;
--   * customer_balances counts a reversal beside its target so the pair sums
--     to zero; asset_earnings is rental money only (charge + late_fee, minus
--     anything corrected or reversed) — the client's exact semantics;
--   * pull_changes now carries jobs.customer_id and jobs.closed_at, still
--     omits the excluded phone-number column, and both guards stay at zero.
-- ============================================================================
begin;
select plan(54);

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
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9');
insert into assets (id, org_id, product_id, asset_code, purchase_price_minor) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-02', 350000000),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-03', 350000000);

insert into customers (id, org_id, name, phone) values
  ('55111111-1111-7111-8111-111111111111', '11111111-1111-7111-8111-111111111111',
   'Reversal Films', '+923214440011'),
  ('55222222-2222-7222-8222-222222222222', '11111111-1111-7111-8111-111111111111',
   'Other Party Productions', '+923214440012');

-- J1: open and clean, wired to Reversal Films. J2: open with gear still
-- projecting onto it. JX: the other org's job, for the cross-org refusal.
insert into jobs (id, org_id, label, customer_id) values
  ('61111111-0018-7111-8111-111111111111', '11111111-1111-7111-8111-111111111111',
   'Reversal Films / clean TVC', '55111111-1111-7111-8111-111111111111'),
  ('62222222-0018-7222-8222-222222222222', '11111111-1111-7111-8111-111111111111',
   'Other Party / gear still out', null),
  ('68888888-0018-7888-8888-888888888888', '22222222-2222-7222-8222-222222222222',
   'Kamran / not yours', null);

-- gear_still_out on J2: the projection says the FX9-03 never came home.
update assets set current_job_id = '62222222-0018-7222-8222-222222222222'
 where id = '30000000-0000-7000-8000-000000000002';

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Structure and hygiene
-- ---------------------------------------------------------------------------
select has_column('jobs', 'closed_at');
select has_column('customer_ledger_entries', 'reversal_of');

select ok(
  (select i.indisunique from pg_index i
     join pg_class c on c.oid = i.indexrelid
    where c.relname = 'ledger_reversal_once_idx'),
  'the reversal_of index is UNIQUE — an entry can be reversed at most once');

select ok(
  exists (select 1 from pg_constraint
           where conname = 'jobs_closed_at_pairs_status'),
  'status and closed_at are constrained as a pair — they cannot disagree');

select is(
  (select count(*)::int from pg_proc
    where pronamespace = 'public'::regnamespace and prosecdef
      and proname in ('close_job', 'reopen_job')),
  2,
  'close_job and reopen_job are SECURITY DEFINER — uniform errors, audit the caller cannot skip');

select ok(
  (select bool_and(proconfig::text like '%search_path=public%')
     from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('close_job', 'reopen_job')),
  'and both pin search_path — the 0015 hygiene rule');

select is(
  (select count(*)::int from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = 'record_ledger_entry'),
  1,
  'record_ledger_entry has exactly ONE signature — the 0017 door was dropped, not overloaded');

select is((select count(*)::int from sync_pii_violations()), 0,
  'customer_id and closed_at trip no sensitive pattern — the PII guard stays at zero');

select is((select count(*)::int from sync_exclusion_violations()), 0,
  'the fourth-edition pull_changes still projects the excluded jobs column out');

-- ---------------------------------------------------------------------------
-- Closing: desk work, refused while gear is out, stamped and audited
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
set local role papa_app;

select lives_ok(
  $$select close_job('61111111-0018-7111-8111-111111111111', 'wrapped on time')$$,
  'the desk closes a job with nothing out');

select is(
  (select status from jobs where id = '61111111-0018-7111-8111-111111111111'),
  'closed',
  'and it is closed');

select isnt(
  (select closed_at from jobs where id = '61111111-0018-7111-8111-111111111111'),
  null,
  'with the moment recorded');

set local role postgres;
select ok(
  exists (select 1 from audit_log
           where action = 'job_closed'
             and subject_id = '61111111-0018-7111-8111-111111111111'),
  'closing is audited');
set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

select throws_matching(
  $$select close_job('62222222-0018-7222-8222-222222222222')$$,
  'still out',
  'a job with an asset still projecting onto it REFUSES to close, naming the count');

select throws_ok(
  $$select close_job('61111111-0018-7111-8111-111111111111')$$,
  '23514', null,
  'an already-closed job cannot close again');

select throws_ok(
  $$select close_job('68888888-0018-7888-8888-888888888888')$$,
  '23503', null,
  'another org''s job does not close from here — the DEFINER carries its own org predicate');

set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- warehouse
select throws_ok(
  $$select close_job('61111111-0018-7111-8111-111111111111')$$,
  '42501', null,
  'warehouse does not close jobs — ending a job is desk work, like writing money');

set local papa.user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';   -- readonly
select throws_ok(
  $$select close_job('61111111-0018-7111-8111-111111111111')$$,
  '42501', null,
  'readonly means readonly');

set local papa.user_id = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';   -- driver
select throws_ok(
  $$select close_job('61111111-0018-7111-8111-111111111111')$$,
  '42501', null,
  'a driver closes nothing — the 0013 rule');

-- ---------------------------------------------------------------------------
-- Reopening: owner/manager only, audited, closed_at cleared
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk
select throws_ok(
  $$select reopen_job('61111111-0018-7111-8111-111111111111')$$,
  '42501', null,
  'the desk cannot reopen — resurrection rewrites every board and is a management judgement');

set local papa.user_id = '99999999-9999-7999-8999-999999999999';   -- manager
select lives_ok(
  $$select reopen_job('61111111-0018-7111-8111-111111111111', 'client extended the shoot')$$,
  'a manager reopens it');

select is(
  (select status from jobs where id = '61111111-0018-7111-8111-111111111111'),
  'open',
  'open again');

select is(
  (select closed_at from jobs where id = '61111111-0018-7111-8111-111111111111'),
  null,
  'and closed_at is cleared — the pair stays consistent');

set local role postgres;
select ok(
  exists (select 1 from audit_log
           where action = 'job_reopened'
             and subject_id = '61111111-0018-7111-8111-111111111111'
             and detail ->> 'note' = 'client extended the shoot'),
  'reopening is audited, reason and all');
set local role papa_app;
set local papa.user_id = '99999999-9999-7999-8999-999999999999';

select throws_ok(
  $$select reopen_job('61111111-0018-7111-8111-111111111111')$$,
  '23514', null,
  'only a closed job can reopen');

-- ---------------------------------------------------------------------------
-- The trigger backstop: bare DML obeys the same physics
-- ---------------------------------------------------------------------------
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- desk

select throws_matching(
  $$update jobs set status = 'closed'
     where id = '62222222-0018-7222-8222-222222222222'$$,
  'still out',
  'bare DML cannot close past the gear-out rule — the trigger holds where the RPC is skipped');

select lives_ok(
  $$update jobs set status = 'closed'
     where id = '61111111-0018-7111-8111-111111111111'$$,
  'bare DML may close a CLEAN job (the direct tier stays open, 0002/0015)');

select isnt(
  (select closed_at from jobs where id = '61111111-0018-7111-8111-111111111111'),
  null,
  'and the trigger stamps closed_at so the pair constraint cannot bite an honest writer');

select lives_ok(
  $$update jobs set status = 'open'
     where id = '61111111-0018-7111-8111-111111111111'$$,
  'flipping it back open by DML');

select is(
  (select closed_at from jobs where id = '61111111-0018-7111-8111-111111111111'),
  null,
  'clears closed_at the same way');

set local role postgres;
insert into jobs (id, org_id, label, status) values
  ('63333333-0018-7333-8333-333333333333', '11111111-1111-7111-8111-111111111111',
   'born closed (a fixture''s convenience)', 'closed');
select isnt(
  (select closed_at from jobs where id = '63333333-0018-7333-8333-333333333333'),
  null,
  'even a row INSERTED as closed gets its closed_at stamped');
set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

-- ---------------------------------------------------------------------------
-- The reversal verb: exact cancellation, once, same customer, audited
-- ---------------------------------------------------------------------------
set local papa.device_id  = 'DESK-01';
set local papa.session_id = '0aaaaaaa-0018-7000-8000-000000000001';

insert into _ids select 'echg', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'charge', 1000000,
  null, '30000000-0000-7000-8000-000000000001', 'FX9 two-day hire');
insert into _ids select 'efee', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'late_fee', 200000,
  null, '30000000-0000-7000-8000-000000000001', 'two days late');
insert into _ids select 'edmg', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'damage_charge', 300000,
  null, '30000000-0000-7000-8000-000000000001', 'cracked top handle');
insert into _ids select 'epay', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'payment', -600000,
  null, null, 'cheque 114202');

select is(
  (select balance_minor from customer_balances
    where customer_id = '55111111-1111-7111-8111-111111111111'),
  900000::bigint,
  'the book before the bounce: charge + fee + damage - payment');

-- The client's rental-money-only rule (D7), asserted while the damage
-- charge is LIVE: it stays on the khata and out of the earnings.
select is(
  (select earned_minor from asset_earnings
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  1200000::bigint,
  'asset_earnings counts charge + late_fee only — a repair bill is not a celebration');

select is(
  (select earning_entry_count from asset_earnings
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  2,
  'two earning lines, not three');

insert into _ids select 'erev', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'reversal', 600000,
  null, null, 'cheque 114202 bounced', null,
  (select id from _ids where k = 'epay'));

select is(
  (select balance_minor from customer_balances
    where customer_id = '55111111-1111-7111-8111-111111111111'),
  1500000::bigint,
  'the reversal sums beside its target: the bounced payment and its void cancel to zero');

set local role postgres;
select ok(
  exists (select 1 from audit_log
           where action = 'ledger_reversal'
             and subject_id = (select id from _ids where k = 'epay')),
  'a reversal rewrites the story a customer may be told — audited');
set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

select throws_ok(
  $$select record_ledger_entry('55111111-1111-7111-8111-111111111111',
      'reversal', 600000, null, null, 'twice', null,
      (select id from _ids where k = 'epay'))$$,
  '23505', null,
  'a SECOND reversal of the same entry is refused — it would double-credit the book');

select throws_matching(
  $$select record_ledger_entry('55111111-1111-7111-8111-111111111111',
      'reversal', -999, null, null, 'partial', null,
      (select id from _ids where k = 'echg'))$$,
  'negate its target exactly',
  'a partial void is refused — that is an adjustment wearing a costume');

select throws_matching(
  $$select record_ledger_entry('55222222-2222-7222-8222-222222222222',
      'reversal', -1000000, null, null, 'wrong khata', null,
      (select id from _ids where k = 'echg'))$$,
  'must stay on the same customer',
  'a reversal cannot move money between customers');

select throws_matching(
  $$select record_ledger_entry('55111111-1111-7111-8111-111111111111',
      'reversal', -600000, null, null, 'double negative', null,
      (select id from _ids where k = 'erev'))$$,
  'cannot reverse a reversal',
  'un-bouncing a bounce is a fresh entry, not a chain');

select throws_ok(
  $$select record_ledger_entry('55111111-1111-7111-8111-111111111111',
      'reversal', 100)$$,
  '22023', null,
  'a reversal without a target is refused before it touches the table');

select throws_ok(
  $$select record_ledger_entry('55111111-1111-7111-8111-111111111111',
      'charge', 100, null, null, 'link on the wrong kind', null,
      (select id from _ids where k = 'echg'))$$,
  '22023', null,
  'and only a reversal may carry the link');

-- Deposit lines move only through the state machine — for reversals too.
insert into _ids select 'dep', d.id
  from hold_deposit('55111111-1111-7111-8111-111111111111', 100000,
                    null, 'security cheque') d;

select throws_matching(
  $$select record_ledger_entry('55111111-1111-7111-8111-111111111111',
      'reversal', -100000, null, null, 'no', null,
      (select e.id from customer_ledger_entries e
        where e.deposit_id = (select id from _ids where k = 'dep')
          and e.entry_kind = 'deposit_hold'))$$,
  'cannot be reversed',
  'a deposit line cannot be reversed — hold/apply/refund are its only history');

-- The two correction verbs exclude each other per target (D6).
insert into _ids select 'ec2', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'charge', 100000,
  null, null, 'typo: quoted 80k');
insert into _ids select 'ec2fix', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'charge', 80000,
  null, null, 'corrected to the quote',
  (select id from _ids where k = 'ec2'));

select throws_matching(
  $$select record_ledger_entry('55111111-1111-7111-8111-111111111111',
      'reversal', -100000, null, null, 'and void it too', null,
      (select id from _ids where k = 'ec2'))$$,
  'already corrected',
  'a superseded entry cannot ALSO be reversed — it already left the sums');

insert into _ids select 'ec3', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'charge', 50000,
  null, null, 'charged, then it turned up');
insert into _ids select 'ec3rev', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'reversal', -50000,
  null, null, 'came back on the other truck', null,
  (select id from _ids where k = 'ec3'));

select throws_matching(
  $$select record_ledger_entry('55111111-1111-7111-8111-111111111111',
      'charge', 40000, null, null, 'and supersede it too',
      (select id from _ids where k = 'ec3'))$$,
  'already reversed',
  'and a reversed entry cannot ALSO be corrected — it is already cancelled');

-- The kind ⟺ link pairing holds at the column layer too, past every RPC.
set local role postgres;
select throws_ok(
  $$insert into customer_ledger_entries
      (org_id, customer_id, entry_kind, amount_minor, created_by)
    values ('11111111-1111-7111-8111-111111111111',
            '55111111-1111-7111-8111-111111111111', 'reversal', 100,
            'ffffffff-ffff-7fff-8fff-ffffffffffff')$$,
  '23514', null,
  'a bare reversal row with no target violates the constraint even for a superuser');
set local role papa_app;
set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

-- Reversing the rental charge takes it out of the earnings (D7).
insert into _ids select 'echgrev', id from record_ledger_entry(
  '55111111-1111-7111-8111-111111111111', 'reversal', -1000000,
  null, '30000000-0000-7000-8000-000000000001', 'charged then returned', null,
  (select id from _ids where k = 'echg'));

select is(
  (select earned_minor from asset_earnings
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  200000::bigint,
  'a reversed charge keeps no phantom earnings — only the live late fee remains');

select is(
  (select earning_entry_count from asset_earnings
    where asset_id = '30000000-0000-7000-8000-000000000001'),
  1,
  'one live earning line');

-- The whole book still sums coherently after every verb was used once.
select is(
  (select balance_minor from customer_balances
    where customer_id = '55111111-1111-7111-8111-111111111111'),
  580000::bigint,
  'the final balance: every charge, payment, correction and reversal in one honest sum');

select is(
  (select deposit_held_minor from customer_balances
    where customer_id = '55111111-1111-7111-8111-111111111111'),
  100000::bigint,
  'and the deposit pot is untouched by all of it');

-- ---------------------------------------------------------------------------
-- What actually leaves the server (D5)
-- ---------------------------------------------------------------------------
select lives_ok(
  $$select close_job('61111111-0018-7111-8111-111111111111', 'wrapped, again')$$,
  'closed once more, so the sync test sees a real closed_at');

select is(
  (select j ->> 'customer_id'
     from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'jobs') j
    where j ->> 'id' = '61111111-0018-7111-8111-111111111111'),
  '55111111-1111-7111-8111-111111111111',
  'jobs sync WITH customer_id — the customer chip and the khata link work on a device');

select isnt(
  (select j ->> 'closed_at'
     from jsonb_array_elements(pull_changes(0) -> 'tables' -> 'jobs') j
    where j ->> 'id' = '61111111-0018-7111-8111-111111111111'),
  null,
  'and WITH closed_at — a finished job can finally leave a device''s boards');

select ok(
  not ((pull_changes(0) -> 'tables' -> 'jobs' -> 0) ? 'contact'),
  'while the phone-number column stays projected out — the 0015 M6 rule survives the fourth edition');

select * from finish();
rollback;
