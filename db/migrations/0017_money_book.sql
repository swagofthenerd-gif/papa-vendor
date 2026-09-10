-- ============================================================================
-- 0017 — The money book: customers, the append-only ledger, deposits,
--        credentials, and the projections the owner's morning glance reads
--
-- Phase B of docs/vendor-dream-plan.md: "where is my money?" — built from
-- PLAN.md overrides 14 (append-only ledger; balance is a projection), 15
-- (deposits as a state machine, refund gated on QC clear), 16
-- (customer_credentials and the first-checkout gate), 17 (role-gate the
-- money actions in RPC bodies) and 18 (logged overrides — every adjustment
-- and write-off carries a reason).
--
-- WHAT THIS MIGRATION DECIDES, and why:
--
--   D1  BALANCE IS A VIEW, NOT A STORED PROJECTION. The assets projection is
--       a stored table because its reducer is ORDER-DEPENDENT: a late event
--       must not clobber newer truth, which needs a persisted ordering key
--       and rebuild machinery. A balance is a SUM — commutative, associative,
--       order-blind. There is no clobber hazard for a projection table to
--       solve, so storing one would buy nothing and reintroduce the exact
--       drift override 14 exists to kill (a stored total beside its source
--       rows WILL disagree with them eventually, invisibly). An org has
--       hundreds of customers and thousands of ledger rows; a sum under the
--       (org_id, customer_id) index is milliseconds. Revisit with field data
--       only — the same posture as the parked receipts-partitioning decision
--       (docs/review-2026-09-02.md, lens 2).
--
--   D2  NONE OF THE MONEY TABLES ARE SYNCABLE. pull_changes delivers every
--       row to every device in the org — there is no per-role sync path —
--       and the warehouse floor has no need to know what a customer owes
--       (the reasoning already recorded for credit_limit% in
--       sync_sensitive_columns). customers.phone would also trip the PII
--       guard (%phone% on a syncable table) — correctly. So the money book
--       is a DESK/OWNER surface read through RPCs and views; a role-gated
--       sync lane is future work and must clear the 0009/0015 guard when it
--       comes. The guard asserts this stays true: none of these tables has
--       change_seq, so sync_pii_violations() stays empty.
--
--   D3  THE LEDGER GETS THE scan_events TREATMENT. INSERT-only via trigger
--       AND withheld grants; corrections point FORWARD (corrects_entry_id on
--       the new row, same-org / same-customer / same-kind, supersession
--       derived at read time); attribution (created_by, device_id,
--       session_id) comes from the papa.* GUCs, never from arguments.
--       papa_app has NO INSERT grant at all — money moves only through the
--       DEFINER RPCs below. device_id/session_id are recorded WITHOUT
--       foreign keys, the audit_log argument: attribution must survive its
--       referent (device_sessions are pruned; a money row is forever).
--
--   D4  SIGNS ARE FIXED PER KIND, customer-owes-positive:
--         charge / late_fee / damage_charge / deposit_hold   > 0
--         payment / write_off / deposit_apply / deposit_refund < 0
--         adjustment <> 0, and adjustment/write_off REQUIRE a note
--         (override 18: never fight the owner's judgement; record it).
--       Two projected buckets read the same rows:
--         balance owed  = charge + late_fee + damage_charge + adjustment
--                         + payment + write_off + deposit_apply
--         deposit held  = deposit_hold + deposit_apply + deposit_refund
--       deposit_apply sits in BOTH on purpose: applying a deposit pays down
--       the balance and shrinks the held amount with one row, so the two
--       numbers can never disagree about the same rupee.
--
--   D5  DEPOSITS ARE A STATE MACHINE OVER LEDGER FACTS. The deposits row
--       carries state (held → partially_applied → refunded, override 15
--       verbatim) and running bookkeeping; every transition ALSO appends a
--       ledger row, so the ledger alone reconstructs the truth. Direct DML
--       is revoked (the 0015 dispatches treatment): hold_deposit /
--       apply_deposit / refund_deposit are the only door. A fully-applied
--       deposit (remaining 0) stays 'partially_applied' with nothing left to
--       move: refund_deposit refuses, because flipping a status with a
--       zero-amount ledger row would be a record of nothing.
--
--   D6  WHAT "QC CLEAR" MEANS TODAY, honestly. There is no inspection-bench
--       state machine in this schema; the confirmed 'back' dispatch IS the
--       bench record. refund_deposit refuses while the linked job has any of
--       (job_money_shortfalls below):
--         gear_still_out         an asset still projects onto the job
--         open_dispatch          a departure/return is half-done
--         no_confirmed_return    gear went out; nobody confirmed a return
--         return_counted_short   the latest confirmed return counted short
--         weak_return_evidence   that return was mostly assumed (0013/0015:
--                                belief is not observation)
--         damage_unresolved      damage flagged under this job and the asset
--                                is still not health='ok'
--         count_discrepancy_open an unresolved count_discrepancy alert
--       A deposit with NO linked job has nothing to check and refunds on the
--       manager's judgement — recorded, role-gated, audited. When a real
--       inspection state arrives, tighten HERE, in one place.
--
--   D7  ROLES. owner/manager/desk write money; refunds are owner/manager
--       ONLY (override 17: deposit refunds are money-destructive).
--       Warehouse "charge drafts" were considered and NOT built: an
--       append-only ledger has no draft state, and inventing one (a mutable
--       staging table) just to let the dock write charges is a second money
--       path to secure. The dock flags; the desk charges. readonly/driver
--       write nothing, as everywhere.
--
--   D8  RATE LIMITS, the 0016 shape (inside DEFINER, on 0007's rate_limits):
--         money:<org>:<user>   60/min — every money write shares one budget
--         refund:<org>:<user>   6/min — refunds are rarer than typing speed
--
--   D9  PII DISCIPLINE. customers carries NO cnic column — credentials live
--       in customer_credentials (cnic_photo_path is an opaque storage key,
--       CONTRIBUTING: never a vendor-signed URL). The table is select-gated
--       to owner/manager/desk — a warehouse phone never reads a guarantor's
--       phone number even through RLS. 'guarantor%' joins the sensitive
--       patterns so a future syncable table cannot carry those columns
--       either ('cnic%' already covers cnic_photo_path).
--
--   ASSUMPTION (docs/assumptions.md wants a row — flagged for the docs
--   owner): the first-checkout credential threshold defaults to
--   Rs 100,000 (10,000,000 minor units) when
--   orgs.settings.new_customer_value_threshold_minor is unset. Unvalidated;
--   the pilot vendor prices it.
--
-- Everything here is idempotent: IF NOT EXISTS / OR REPLACE / drop-and-
-- recreate pairs, the 0015/0016 discipline. 0001–0016 stay untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- customers — who owes, who paid, who gets the WhatsApp balance card
--
-- Absent from 0002 by design (phase 1 had jobs with free-text contact); the
-- ledger needs the entity. Same CRUD tier as jobs: direct DML under RLS with
-- the 0015 restrictive role gates, because customer records are not evidence
-- — the LEDGER is.
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id           uuid primary key default uuid_generate_v7(),
  org_id       uuid not null references orgs(id) on delete restrict,

  name         text not null,
  phone        text,
  -- Relationship tier, hand-set by the desk. The fast lane is DERIVED
  -- (verified_customers below); this is the human's own label.
  tier         text not null default 'new',
  blacklisted  boolean not null default false,
  notes        text,

  created_by   uuid references users(id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  constraint customers_tier_check check (tier in ('new', 'regular', 'trusted')),
  constraint customers_name_nonempty check (length(trim(name)) > 0)
);

create index if not exists customers_org_live_idx
  on customers (org_id, lower(name)) where deleted_at is null;
create index if not exists customers_org_phone_idx
  on customers (org_id, phone) where phone is not null and deleted_at is null;

comment on table customers is
  'The udhaar relationship. NO cnic column here, ever — credentials live in customer_credentials (D9). Balance is a projection of customer_ledger_entries, never a column (override 14).';

drop trigger if exists customers_updated_at on customers;
create trigger customers_updated_at
  before update on customers for each row execute function set_updated_at();

alter table customers enable row level security;
alter table customers force row level security;

drop policy if exists customers_select on customers;
create policy customers_select on customers
  for select using (org_id = (select current_org_id()));
drop policy if exists customers_insert on customers;
create policy customers_insert on customers
  for insert with check (org_id = (select current_org_id()));
drop policy if exists customers_update on customers;
create policy customers_update on customers
  for update using (org_id = (select current_org_id()))
  with check (org_id = (select current_org_id()));

-- The 0015 H2(a) pattern: readonly and driver write nothing. `using (true)`
-- so the refusal is a loud 42501, not a silent zero-row update.
drop policy if exists customers_writer_role_ins on customers;
create policy customers_writer_role_ins on customers
  as restrictive for insert
  with check ((select coalesce(current_member_role(), '')) not in ('readonly', 'driver'));
drop policy if exists customers_writer_role_upd on customers;
create policy customers_writer_role_upd on customers
  as restrictive for update
  using (true)
  with check ((select coalesce(current_member_role(), '')) not in ('readonly', 'driver'));

grant select, insert, update on customers to papa_app;

-- ---------------------------------------------------------------------------
-- jobs.customer_id — the forward link the clean-history derivation stands on
--
-- Phase 1 jobs had free-text contact only. The ledger and the fast lane need
-- to know WHOSE job it was. Nullable: the nephew case (0014) stays legal.
-- Not projected into pull_changes — devices keep seeing the 0015 shape; the
-- sync lane for money is future work (D2).
-- ---------------------------------------------------------------------------
alter table jobs add column if not exists customer_id uuid references customers(id) on delete restrict;

create index if not exists jobs_org_customer_idx
  on jobs (org_id, customer_id) where customer_id is not null;

-- FKs check existence, not tenancy (the 0015 M4 lesson). DEFINER so the
-- check can see the foreign row in order to REFUSE it.
create or replace function jobs_check_customer_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.customer_id is not null and not exists (
    select 1 from customers c
     where c.id = new.customer_id
       and c.org_id = new.org_id
       and c.deleted_at is null
  ) then
    raise exception 'customer % does not belong to this org', new.customer_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

drop trigger if exists jobs_customer_tenancy on jobs;
create trigger jobs_customer_tenancy
  before insert or update of customer_id on jobs
  for each row execute function jobs_check_customer_org();

-- ---------------------------------------------------------------------------
-- deposits — the stateful object (override 15), created BEFORE the ledger so
-- ledger rows can reference it
--
-- held → partially_applied → refunded, and held → refunded directly (a clean
-- return with nothing applied). Every transition appends a ledger row; the
-- deposits row is bookkeeping the RPCs keep consistent, and direct DML is
-- revoked so its state cannot be forged (the 0015 dispatches treatment).
-- ---------------------------------------------------------------------------
create table if not exists deposits (
  id             uuid primary key default uuid_generate_v7(),
  org_id         uuid not null references orgs(id) on delete restrict,
  customer_id    uuid not null references customers(id) on delete restrict,
  job_id         uuid references jobs(id) on delete restrict,

  currency       text not null default 'PKR',
  amount_minor   bigint not null,
  applied_minor  bigint not null default 0,
  refunded_minor bigint,

  state          text not null default 'held',

  held_by        uuid not null references users(id) on delete restrict,
  held_at        timestamptz not null default now(),
  refunded_by    uuid references users(id) on delete restrict,
  refunded_at    timestamptz,

  note           text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint deposits_state_check
    check (state in ('held', 'partially_applied', 'refunded')),
  constraint deposits_amount_positive check (amount_minor > 0),
  constraint deposits_applied_bounds
    check (applied_minor >= 0 and applied_minor <= amount_minor),
  constraint deposits_currency_check check (currency ~ '^[A-Z]{3}$'),
  -- A refunded deposit carries its full provenance (the 0013 rule: half-
  -- filled evidence is worse than none) and the refund is exactly what was
  -- left — the ledger and the state can never tell different stories.
  constraint deposits_refund_complete check (
    state <> 'refunded'
    or (refunded_minor is not null and refunded_at is not null and refunded_by is not null)
  ),
  constraint deposits_refund_matches
    check (refunded_minor is null or refunded_minor = amount_minor - applied_minor)
);

create index if not exists deposits_org_customer_idx on deposits (org_id, customer_id);
create index if not exists deposits_org_open_idx
  on deposits (org_id, held_at desc) where state <> 'refunded';
create index if not exists deposits_org_job_idx
  on deposits (org_id, job_id) where job_id is not null;

comment on table deposits is
  'Override 15: held → partially_applied → refunded. Refund gated on the linked job being QC-clear (job_money_shortfalls). Direct DML revoked; hold_deposit/apply_deposit/refund_deposit are the only door.';

drop trigger if exists deposits_updated_at on deposits;
create trigger deposits_updated_at
  before update on deposits for each row execute function set_updated_at();

alter table deposits enable row level security;
alter table deposits force row level security;

-- Money is a desk/owner surface (D2): warehouse, driver and readonly see no
-- deposit rows at all, not even through a view.
drop policy if exists deposits_select on deposits;
create policy deposits_select on deposits
  for select using (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );
-- Write policies exist for the DEFINER path when the function owner is not a
-- superuser; papa_app has no INSERT/UPDATE grant, so these are unreachable
-- from a client either way.
drop policy if exists deposits_insert on deposits;
create policy deposits_insert on deposits
  for insert with check (org_id = (select current_org_id()));
drop policy if exists deposits_update on deposits;
create policy deposits_update on deposits
  for update using (org_id = (select current_org_id()))
  with check (org_id = (select current_org_id()));

grant select on deposits to papa_app;   -- deliberately no insert/update/delete

-- ---------------------------------------------------------------------------
-- customer_ledger_entries — six hundred years of accountants are right
--
-- Append-only, forever (D3). One row per money fact; the balance is always
-- SUM over the live (un-superseded) rows. Never a mutable total anywhere.
-- ---------------------------------------------------------------------------
create table if not exists customer_ledger_entries (
  id           uuid primary key default uuid_generate_v7(),
  org_id       uuid not null references orgs(id) on delete restrict,
  customer_id  uuid not null references customers(id) on delete restrict,

  entry_kind   text not null,
  amount_minor bigint not null,
  currency     text not null default 'PKR',

  -- What the money was FOR. job_id feeds the statement; asset_id feeds the
  -- per-asset earnings / payback bar (vendor-dream-plan B6).
  job_id       uuid references jobs(id) on delete restrict,
  asset_id     uuid references assets(id) on delete restrict,
  deposit_id   uuid references deposits(id) on delete restrict,

  note         text,

  -- CORRECTIONS POINT FORWARD (override 14 via the 0003 pattern). The new
  -- row carries the corrected amount and names its target; supersession is
  -- derived at read time. Never an UPDATE.
  corrects_entry_id uuid references customer_ledger_entries(id) on delete restrict,

  -- Attribution: from the papa.* GUCs, set by the RPCs, never by arguments.
  -- No FKs on device/session — attribution must survive its referent
  -- (device_sessions are pruned; this row is forever). The audit_log rule.
  created_by   uuid not null references users(id) on delete restrict,
  device_id    text,
  session_id   uuid,

  server_time  timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  constraint ledger_kind_check check (entry_kind in (
    'charge', 'payment', 'deposit_hold', 'deposit_apply', 'deposit_refund',
    'late_fee', 'damage_charge', 'write_off', 'adjustment'
  )),
  -- D4: the sign is a property of the kind, not a caller choice.
  constraint ledger_sign_per_kind check (
    (entry_kind in ('charge', 'late_fee', 'damage_charge', 'deposit_hold')
       and amount_minor > 0)
    or (entry_kind in ('payment', 'write_off', 'deposit_apply', 'deposit_refund')
       and amount_minor < 0)
    or (entry_kind = 'adjustment' and amount_minor <> 0)
  ),
  -- Override 18: the owner's judgement is never fought, always recorded.
  constraint ledger_override_has_reason check (
    entry_kind not in ('adjustment', 'write_off')
    or (note is not null and length(trim(note)) > 0)
  ),
  -- Deposit rows and only deposit rows carry their deposit.
  constraint ledger_deposit_link check (
    (entry_kind in ('deposit_hold', 'deposit_apply', 'deposit_refund'))
      = (deposit_id is not null)
  ),
  constraint ledger_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint ledger_no_self_correction
    check (corrects_entry_id is null or corrects_entry_id <> id)
);

create index if not exists ledger_org_customer_idx
  on customer_ledger_entries (org_id, customer_id, server_time desc);
create index if not exists ledger_org_asset_idx
  on customer_ledger_entries (org_id, asset_id) where asset_id is not null;
create index if not exists ledger_org_job_idx
  on customer_ledger_entries (org_id, job_id) where job_id is not null;
create index if not exists ledger_org_deposit_idx
  on customer_ledger_entries (org_id, deposit_id) where deposit_id is not null;
-- UNIQUE: an entry is corrected at most once. Two live corrections of the
-- same target would BOTH survive the supersession filter and double-count in
-- every balance. To amend a correction, correct the correction — the chain
-- stays single-file and the index enforces it under concurrency, where a
-- trigger check cannot.
drop index if exists ledger_corrects_idx;
create unique index if not exists ledger_corrects_once_idx
  on customer_ledger_entries (corrects_entry_id) where corrects_entry_id is not null;

comment on table customer_ledger_entries is
  'Append-only money facts (override 14). Balance is ALWAYS a sum over live rows — see customer_balances. Corrections point forward via corrects_entry_id. Writes only through the money RPCs.';
comment on column customer_ledger_entries.amount_minor is
  'Signed, customer-owes-positive, minor units (paisa). Sign is fixed per kind (D4) and enforced by ledger_sign_per_kind.';

-- Append-only, enforced by the database rather than by good intentions —
-- the scan_events treatment: trigger AND withheld grants.
create or replace function reject_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'customer_ledger_entries is append-only; correct a mistake by inserting an entry with corrects_entry_id set'
    using errcode = 'restrict_violation';
end
$$;

drop trigger if exists ledger_no_update on customer_ledger_entries;
create trigger ledger_no_update
  before update on customer_ledger_entries
  for each row execute function reject_ledger_mutation();
drop trigger if exists ledger_no_delete on customer_ledger_entries;
create trigger ledger_no_delete
  before delete on customer_ledger_entries
  for each row execute function reject_ledger_mutation();

-- Tenancy and correction validation, the 0015 M4/M5a shape: FKs check
-- existence, this checks OWNERSHIP, and it holds for every insert path
-- including a careless future DEFINER function. DEFINER so it can see the
-- foreign row in order to refuse it.
create or replace function validate_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t customer_ledger_entries%rowtype;
begin
  if not exists (
    select 1 from customers c
     where c.id = new.customer_id and c.org_id = new.org_id and c.deleted_at is null
  ) then
    raise exception 'customer % does not belong to this org', new.customer_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.job_id is not null and not exists (
    select 1 from jobs j where j.id = new.job_id and j.org_id = new.org_id
  ) then
    raise exception 'job % does not belong to this org', new.job_id
      using errcode = 'foreign_key_violation';
  end if;

  -- A money line against someone ELSE's job would put this row on the wrong
  -- statement — the same bookkeeping lie hold_deposit refuses, enforced here
  -- so it holds for EVERY insert path. A job with no customer stays legal
  -- (the nephew case, 0014).
  if new.job_id is not null and exists (
    select 1 from jobs j
     where j.id = new.job_id
       and j.customer_id is not null
       and j.customer_id <> new.customer_id
  ) then
    raise exception 'job % belongs to a different customer', new.job_id
      using errcode = 'check_violation';
  end if;

  if new.asset_id is not null and not exists (
    select 1 from assets a where a.id = new.asset_id and a.org_id = new.org_id
  ) then
    raise exception 'asset % does not belong to this org', new.asset_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.deposit_id is not null and not exists (
    select 1 from deposits d where d.id = new.deposit_id and d.org_id = new.org_id
  ) then
    raise exception 'deposit % does not belong to this org', new.deposit_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.corrects_entry_id is not null then
    select * into t from customer_ledger_entries e where e.id = new.corrects_entry_id;

    if not found or t.org_id <> new.org_id then
      raise exception 'correction target does not exist in this org'
        using errcode = 'foreign_key_violation';
    end if;
    if t.customer_id <> new.customer_id then
      raise exception 'a correction must stay on the same customer'
        using errcode = 'check_violation';
    end if;
    if t.entry_kind <> new.entry_kind then
      raise exception 'a correction must keep the kind of the entry it corrects (% -> %)',
        t.entry_kind, new.entry_kind
        using errcode = 'check_violation';
    end if;
    -- Deposit lines move only through the state machine; correcting one
    -- would let the ledger and the deposits row tell different stories.
    if new.entry_kind in ('deposit_hold', 'deposit_apply', 'deposit_refund') then
      raise exception 'deposit entries cannot be corrected; use the deposit RPCs'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists ledger_validate on customer_ledger_entries;
create trigger ledger_validate
  before insert on customer_ledger_entries
  for each row execute function validate_ledger_entry();

alter table customer_ledger_entries enable row level security;
alter table customer_ledger_entries force row level security;

-- Money is a desk/owner read (D2). NO update/delete policy exists at all.
drop policy if exists ledger_select on customer_ledger_entries;
create policy ledger_select on customer_ledger_entries
  for select using (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );
drop policy if exists ledger_insert on customer_ledger_entries;
create policy ledger_insert on customer_ledger_entries
  for insert with check (org_id = (select current_org_id()));

grant select on customer_ledger_entries to papa_app;   -- no insert: RPCs only

-- ---------------------------------------------------------------------------
-- The projections (D1): views, security_invoker, sums over live rows
-- ---------------------------------------------------------------------------
drop view if exists customer_balances;
create view customer_balances with (security_invoker = true) as
with live as (
  select e.*
    from customer_ledger_entries e
   where not exists (
     select 1 from customer_ledger_entries c
      where c.corrects_entry_id = e.id
   )
)
select
  c.org_id,
  c.id            as customer_id,
  c.name,
  c.blacklisted,
  coalesce(sum(l.amount_minor) filter (where l.entry_kind in
    ('charge', 'late_fee', 'damage_charge', 'adjustment',
     'payment', 'write_off', 'deposit_apply')), 0) as balance_minor,
  coalesce(sum(l.amount_minor) filter (where l.entry_kind in
    ('deposit_hold', 'deposit_apply', 'deposit_refund')), 0) as deposit_held_minor,
  count(l.id)::int     as entry_count,
  max(l.server_time)   as last_entry_at
  from customers c
  left join live l on l.customer_id = c.id and l.org_id = c.org_id
 where c.deleted_at is null
   -- The ledger's RLS already hides the ROWS from non-money roles, but the
   -- customers rows are org-visible to everyone — without this predicate a
   -- warehouse phone would see every customer with balance 0, which is a lie
   -- rather than a refusal. Zero rows is honest; zero rupees is not.
   and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
 group by c.org_id, c.id, c.name, c.blacklisted;

comment on view customer_balances is
  'THE balance (override 14): a sum over live (un-superseded) ledger rows, never a stored total. balance_minor is what the customer owes; deposit_held_minor is their money we hold. security_invoker + an explicit role predicate: non-money roles get zero rows, never zero balances.';

grant select on customer_balances to papa_app;

drop view if exists asset_earnings;
create view asset_earnings with (security_invoker = true) as
select
  e.org_id,
  e.asset_id,
  coalesce(sum(e.amount_minor) filter (where e.entry_kind in
    ('charge', 'late_fee', 'damage_charge')), 0) as earned_minor,
  count(*) filter (where e.entry_kind in
    ('charge', 'late_fee', 'damage_charge'))::int as earning_entry_count,
  max(e.server_time) as last_earned_at
  from customer_ledger_entries e
 where e.asset_id is not null
   and not exists (
     select 1 from customer_ledger_entries c
      where c.corrects_entry_id = e.id
   )
 group by e.org_id, e.asset_id;

comment on view asset_earnings is
  'Per-asset revenue (vendor-dream-plan B6): the sum of live charge-side ledger lines that name the asset. The payback bar divides this by assets.purchase_price_minor.';

grant select on asset_earnings to papa_app;

-- ---------------------------------------------------------------------------
-- job_money_shortfalls — what "QC clear" means with the current schema (D6)
--
-- Returns one row per blocking fact, empty when the job is clear. Returned
-- as values rather than a boolean so the desk can SHOW the refusal (the
-- dispatch_evidence_strength precedent), and so the test suite pins each
-- reason independently.
-- ---------------------------------------------------------------------------
create or replace function job_money_shortfalls(p_job_id uuid)
returns table (reason text, detail text)
language sql
stable
as $$
  select 'gear_still_out'::text,
         (count(*) || ' asset(s) still out on this job')::text
    from assets a
   where a.current_job_id = p_job_id
  having count(*) > 0
  union all
  select 'open_dispatch', count(*) || ' dispatch(es) still open on this job'
    from dispatches d
   where d.job_id = p_job_id and d.state = 'open'
  having count(*) > 0
  union all
  select 'no_confirmed_return',
         'gear went out on this job and no return has been confirmed'
   where exists (
           select 1 from dispatches d
            where d.job_id = p_job_id
              and d.direction = 'out' and d.state = 'confirmed')
     and not exists (
           select 1 from dispatches d
            where d.job_id = p_job_id
              and d.direction = 'back' and d.state = 'confirmed')
  union all
  select 'return_counted_short',
         'the latest confirmed return counted ' || b.unaccounted_count || ' item(s) unaccounted'
    from (select d.unaccounted_count
            from dispatches d
           where d.job_id = p_job_id
             and d.direction = 'back' and d.state = 'confirmed'
           order by d.confirmed_at desc
           limit 1) b
   where coalesce(b.unaccounted_count, 0) > 0
  union all
  select 'weak_return_evidence',
         'the latest confirmed return was mostly bulk-assumed; belief is not observation'
    from (select d.session_id
            from dispatches d
           where d.job_id = p_job_id
             and d.direction = 'back' and d.state = 'confirmed'
           order by d.confirmed_at desc
           limit 1) b
   where dispatch_evidence_strength(b.session_id) = 'weak'
  union all
  select 'damage_unresolved',
         count(distinct a.id) || ' asset(s) flagged under this job still not health=ok'
    from scan_events e
    join assets a on a.id = e.asset_id
   where e.job_id = p_job_id
     and e.event_type in ('flag_damage', 'quarantine', 'send_to_service')
     and a.health <> 'ok'
  having count(distinct a.id) > 0
  union all
  select 'count_discrepancy_open',
         count(*) || ' unresolved count discrepancy alert(s) on this job'
    from alerts al
   where al.job_id = p_job_id
     and al.kind = 'count_discrepancy'
     and al.resolved_at is null
  having count(*) > 0
$$;

comment on function job_money_shortfalls(uuid) is
  'The refund gate (override 15) and the honest definition of "QC clear" today: empty means clear. SECURITY INVOKER — reads under the caller''s RLS. One place to tighten when a real inspection bench state exists.';

grant execute on function job_money_shortfalls(uuid) to papa_app;

-- ---------------------------------------------------------------------------
-- customer_credentials — override 16, PII kept off phones structurally (D9)
-- ---------------------------------------------------------------------------
create table if not exists customer_credentials (
  id              uuid primary key default uuid_generate_v7(),
  org_id          uuid not null references orgs(id) on delete restrict,
  customer_id     uuid not null references customers(id) on delete restrict,

  kind            text not null,
  -- Opaque storage key ({org}/{sha256}-shaped, like condition photos), never
  -- a vendor-signed URL (CONTRIBUTING) and NEVER synced (D2 + the guard).
  cnic_photo_path text,
  guarantor_name  text,
  guarantor_phone text,
  details         jsonb not null default '{}'::jsonb,

  expires_at      timestamptz,
  verified_by     uuid references users(id) on delete restrict,
  verified_at     timestamptz,

  created_by      uuid references users(id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint customer_credentials_kind_check
    check (kind in ('cnic_photo', 'guarantor', 'cheque', 'coi')),
  -- A credential of a kind must actually carry that kind's substance.
  constraint customer_credentials_substance check (
    (kind <> 'cnic_photo' or cnic_photo_path is not null)
    and (kind <> 'guarantor' or guarantor_name is not null)
  ),
  -- Verification carries its provenance or does not exist.
  constraint customer_credentials_verified_complete check (
    (verified_at is null) = (verified_by is null)
  )
);

create index if not exists customer_credentials_org_customer_idx
  on customer_credentials (org_id, customer_id) where deleted_at is null;

comment on table customer_credentials is
  'Override 16: what a stranger pledges before Rs 4,000,000 walks out. Select-gated to owner/manager/desk; never syncable (asserted by the 0009/0015 guard — this table must never gain change_seq).';

drop trigger if exists customer_credentials_updated_at on customer_credentials;
create trigger customer_credentials_updated_at
  before update on customer_credentials for each row execute function set_updated_at();

-- Tenancy backstop, same shape as the ledger's.
create or replace function credentials_check_customer_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from customers c
     where c.id = new.customer_id and c.org_id = new.org_id and c.deleted_at is null
  ) then
    raise exception 'customer % does not belong to this org', new.customer_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

drop trigger if exists customer_credentials_tenancy on customer_credentials;
create trigger customer_credentials_tenancy
  before insert or update of customer_id, org_id on customer_credentials
  for each row execute function credentials_check_customer_org();

alter table customer_credentials enable row level security;
alter table customer_credentials force row level security;

-- Reads AND writes are desk-and-up: a guarantor's phone number on a
-- warehouse Redmi is the exact exposure 0009 exists to prevent, and RLS is
-- the only layer that holds when a future view forgets to think about it.
drop policy if exists customer_credentials_select on customer_credentials;
create policy customer_credentials_select on customer_credentials
  for select using (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );
drop policy if exists customer_credentials_insert on customer_credentials;
create policy customer_credentials_insert on customer_credentials
  for insert with check (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );
-- USING is org-scoped, not `using (true)`: that idiom is safe only on a
-- RESTRICTIVE policy layered over a permissive org policy (0015 H2a). On the
-- sole PERMISSIVE update policy it would make EVERY org's rows updatable, and
-- a WHERE-less `update customer_credentials set org_id = mine, customer_id =
-- mine` would re-home every credential in the database. The role refusal is
-- still a loud 42501: own-org rows pass USING and then fail WITH CHECK.
drop policy if exists customer_credentials_update on customer_credentials;
create policy customer_credentials_update on customer_credentials
  for update using (org_id = (select current_org_id()))
  with check (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );

grant select, insert, update on customer_credentials to papa_app;

-- The guard learns the guarantor shape. 'cnic%' (0015) already covers
-- cnic_photo_path; '%phone%' already covers guarantor_phone; this catches
-- guarantor_name / guarantor_cnic / anything else the shape grows.
insert into sync_sensitive_columns (column_name, reason) values
  ('guarantor%', 'a guarantor''s identity pledged against gear; PII with a harassment vector, never for a warehouse phone')
on conflict (column_name) do nothing;

-- ---------------------------------------------------------------------------
-- verified_customers — the fast lane, derived not asserted
--
-- verified: a live, verified credential exists. clean history: at least one
-- completed rental (a confirmed return) whose job is QC-clear, and no job
-- currently blocked. fast_lane is the gate-skipping status
-- (vendor-dream-plan B7: the gate blocks strangers; the fast lane makes
-- clients WANT registration).
--
-- security_invoker: under a non-money role the credentials rows are
-- invisible, so `verified` reads false — the STRICTER direction, on purpose.
-- ---------------------------------------------------------------------------
drop view if exists verified_customers;
create view verified_customers with (security_invoker = true) as
select
  c.org_id,
  c.id  as customer_id,
  c.name,
  c.blacklisted,
  v.verified,
  v.clean_completed_jobs,
  v.no_open_shortfall,
  (v.verified and not c.blacklisted
     and v.clean_completed_jobs >= 1 and v.no_open_shortfall) as fast_lane
  from customers c
  cross join lateral (
    select
      exists (
        select 1 from customer_credentials cc
         where cc.customer_id = c.id
           and cc.org_id = c.org_id
           and cc.deleted_at is null
           and cc.verified_at is not null
           and (cc.expires_at is null or cc.expires_at > now())
      ) as verified,
      (select count(*)::int from jobs j
        where j.customer_id = c.id
          and j.org_id = c.org_id
          and j.deleted_at is null
          and exists (
            select 1 from dispatches d
             where d.job_id = j.id
               and d.direction = 'back' and d.state = 'confirmed')
          and not exists (select 1 from job_money_shortfalls(j.id))
      ) as clean_completed_jobs,
      not exists (
        select 1 from jobs j
         where j.customer_id = c.id
           and j.org_id = c.org_id
           and j.deleted_at is null
           and exists (select 1 from job_money_shortfalls(j.id))
      ) as no_open_shortfall
  ) v
 where c.deleted_at is null;

comment on view verified_customers is
  'The fast lane (override 16), DERIVED: verified credential + at least one clean completed rental + nothing currently short. Never a hand-set flag.';

grant select on verified_customers to papa_app;

/**
 * The first-checkout gate primitive (override 16): does this customer need
 * credentials before gear of this value leaves?
 *
 * True when the value crosses the org threshold AND the customer is neither
 * verified nor carrying a clean completed history. The CHECKOUT wiring
 * (refusing in the check-out RPC, manager override with a logged reason)
 * lands with the client wave — jobs gained customer_id only in this
 * migration, so today's scan path has nothing to gate on yet. This function
 * is the one place that answers the question when it does.
 *
 * ASSUMPTION: default threshold Rs 100,000 (10,000,000 minor). Unvalidated —
 * orgs.settings.new_customer_value_threshold_minor overrides per org (the
 * 0001 settings key), and the pilot vendor prices the default.
 */
create or replace function customer_needs_credentials(
  p_customer_id uuid,
  p_value_minor bigint
)
returns boolean
language sql
stable
as $$
  select coalesce(p_value_minor, 0) >= coalesce(
           (select nullif(o.settings ->> 'new_customer_value_threshold_minor', '')::bigint
              from orgs o where o.id = (select current_org_id())),
           10000000)
     and not coalesce(
           (select v.verified
                or (v.clean_completed_jobs >= 1 and v.no_open_shortfall)
              from verified_customers v
             where v.customer_id = p_customer_id
               and v.org_id = (select current_org_id())),
           false)
$$;

comment on function customer_needs_credentials(uuid, bigint) is
  'Override 16 gate primitive. INVOKER: reads verified_customers under the caller''s RLS. Blacklist refusal is separate — a blacklisted customer is refused, not asked for documents.';

grant execute on function customer_needs_credentials(uuid, bigint) to papa_app;

-- ---------------------------------------------------------------------------
-- The money RPCs — the only door (D3, D7, D8)
--
-- All SECURITY DEFINER with pinned search_path (they insert into a table the
-- caller cannot), which means every statement carries its own org predicate
-- — the 0004 trap, handled the 0004 way: by hand, visibly.
-- ---------------------------------------------------------------------------

/**
 * Internal: shared context/role/rate checks for every money write.
 * Raises or returns (org, user). Not granted to anyone.
 */
create or replace function money_write_context(
  p_roles text[],
  out o_org  uuid,
  out o_user uuid
)
language plpgsql
as $$
begin
  o_org  := current_org_id();
  o_user := current_user_id();
  if o_org is null or o_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  perform require_role(variadic p_roles);

  -- D8: one shared budget for all money writes. Fast fingers at a busy desk
  -- are ~1 entry per few seconds; 60/min only stops a runaway loop.
  if not rate_limit_check('money:' || o_org::text || ':' || o_user::text, 60, '1 minute') then
    raise exception 'too many money entries; wait a moment'
      using errcode = 'too_many_connections';
  end if;
end
$$;

/**
 * record_ledger_entry — the general money fact.
 *
 * Kind is restricted to the NON-deposit kinds: deposit lines move only
 * through the state machine below, or the ledger and the deposits row could
 * tell different stories. The caller passes the SIGNED amount and the sign
 * must match the kind (D4) — a desk app that gets a sign wrong should hear
 * about it loudly, not have it silently flipped.
 */
create or replace function record_ledger_entry(
  p_customer_id       uuid,
  p_entry_kind        text,
  p_amount_minor      bigint,
  p_job_id            uuid default null,
  p_asset_id          uuid default null,
  p_note              text default null,
  p_corrects_entry_id uuid default null
)
returns customer_ledger_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_row  customer_ledger_entries%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from money_write_context(array['owner', 'manager', 'desk']);

  if p_entry_kind is null or p_entry_kind not in
     ('charge', 'payment', 'late_fee', 'damage_charge', 'write_off', 'adjustment') then
    raise exception 'unknown or deposit-reserved entry kind %; deposits move through hold/apply/refund_deposit',
      coalesce(p_entry_kind, '(null)')
      using errcode = 'invalid_parameter_value';
  end if;

  if p_amount_minor is null or p_amount_minor = 0 then
    raise exception 'a money entry must carry a non-zero amount'
      using errcode = 'check_violation';
  end if;
  if p_entry_kind in ('charge', 'late_fee', 'damage_charge') and p_amount_minor < 0 then
    raise exception '% is money the customer owes; the amount must be positive', p_entry_kind
      using errcode = 'check_violation';
  end if;
  if p_entry_kind in ('payment', 'write_off') and p_amount_minor > 0 then
    raise exception '% reduces what the customer owes; the amount must be negative', p_entry_kind
      using errcode = 'check_violation';
  end if;

  -- DEFINER sees every org's customers; the org predicate is by hand (0004).
  if not exists (
    select 1 from customers c
     where c.id = p_customer_id and c.org_id = v_org and c.deleted_at is null
  ) then
    raise exception 'customer % does not belong to this org', p_customer_id
      using errcode = 'foreign_key_violation';
  end if;

  insert into customer_ledger_entries
    (org_id, customer_id, entry_kind, amount_minor, currency,
     job_id, asset_id, note, corrects_entry_id,
     created_by, device_id, session_id)
  values
    (v_org, p_customer_id, p_entry_kind, p_amount_minor,
     coalesce((select o.currency from orgs o where o.id = v_org), 'PKR'),
     p_job_id, p_asset_id, nullif(trim(coalesce(p_note, '')), ''), p_corrects_entry_id,
     -- Attribution from the GUCs, never from arguments (D3).
     v_user, current_device_id(), current_session_id())
  returning * into v_row;

  -- A correction rewrites the story a customer may be told; that is an
  -- administrative act, audited like role changes and tag binding (0007).
  if p_corrects_entry_id is not null then
    perform write_audit(
      'ledger_correction', 'customer_ledger_entry', p_corrects_entry_id,
      p_entry_kind,
      jsonb_build_object('correcting_entry_id', v_row.id,
                         'amount_minor', p_amount_minor));
  end if;

  return v_row;
end
$$;

comment on function record_ledger_entry(uuid, text, bigint, uuid, uuid, text, uuid) is
  'The general money write: owner/manager/desk, signed amount validated per kind, tenancy checked by hand, attribution from papa.* GUCs. Deposit kinds refused — the state machine is their only door.';

/**
 * record_payment — the khata loop's most-tapped button, as a thin wrapper:
 * the desk types the positive amount received; the ledger stores it as the
 * negative fact it is.
 */
create or replace function record_payment(
  p_customer_id  uuid,
  p_amount_minor bigint,
  p_job_id       uuid default null,
  p_note         text default null
)
returns customer_ledger_entries
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'a payment is recorded as the positive amount received'
      using errcode = 'check_violation';
  end if;
  return record_ledger_entry(
    p_customer_id, 'payment', -p_amount_minor, p_job_id, null, p_note, null);
end
$$;

/**
 * hold_deposit — money taken as security enters the held state.
 */
create or replace function hold_deposit(
  p_customer_id  uuid,
  p_amount_minor bigint,
  p_job_id       uuid default null,
  p_note         text default null
)
returns deposits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_dep  deposits%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from money_write_context(array['owner', 'manager', 'desk']);

  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'a deposit is held as a positive amount'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from customers c
     where c.id = p_customer_id and c.org_id = v_org and c.deleted_at is null
  ) then
    raise exception 'customer % does not belong to this org', p_customer_id
      using errcode = 'foreign_key_violation';
  end if;

  if p_job_id is not null then
    if not exists (
      select 1 from jobs j
       where j.id = p_job_id and j.org_id = v_org and j.deleted_at is null
    ) then
      raise exception 'job % does not belong to this org', p_job_id
        using errcode = 'foreign_key_violation';
    end if;
    -- A deposit against someone else's job is a bookkeeping lie waiting to
    -- gate the wrong refund.
    if exists (
      select 1 from jobs j
       where j.id = p_job_id and j.customer_id is not null
         and j.customer_id <> p_customer_id
    ) then
      raise exception 'job % belongs to a different customer', p_job_id
        using errcode = 'check_violation';
    end if;
  end if;

  insert into deposits (org_id, customer_id, job_id, currency, amount_minor,
                        state, held_by, note)
  values (v_org, p_customer_id, p_job_id,
          coalesce((select o.currency from orgs o where o.id = v_org), 'PKR'),
          p_amount_minor, 'held', v_user,
          nullif(trim(coalesce(p_note, '')), ''))
  returning * into v_dep;

  insert into customer_ledger_entries
    (org_id, customer_id, entry_kind, amount_minor, currency,
     job_id, deposit_id, note, created_by, device_id, session_id)
  values
    (v_org, p_customer_id, 'deposit_hold', p_amount_minor, v_dep.currency,
     p_job_id, v_dep.id, nullif(trim(coalesce(p_note, '')), ''),
     v_user, current_device_id(), current_session_id());

  return v_dep;
end
$$;

/**
 * apply_deposit — part (or all) of the held money settles a charge.
 * held/partially_applied → partially_applied. One ledger row does both
 * halves (D4): the balance drops and the held amount drops, same rupee.
 */
create or replace function apply_deposit(
  p_deposit_id   uuid,
  p_amount_minor bigint,
  p_note         text default null
)
returns deposits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_dep  deposits%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from money_write_context(array['owner', 'manager', 'desk']);

  -- FOR UPDATE: two desks applying the same deposit must serialise, or both
  -- could pass the remaining-amount check (the 0015 C2 lesson, on money).
  select * into v_dep from deposits d
   where d.id = p_deposit_id and d.org_id = v_org
   for update;
  if not found then
    raise exception 'deposit % does not belong to this org', p_deposit_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_dep.state not in ('held', 'partially_applied') then
    raise exception 'deposit % is % and cannot be applied', p_deposit_id, v_dep.state
      using errcode = 'check_violation';
  end if;

  if p_amount_minor is null or p_amount_minor <= 0
     or p_amount_minor > v_dep.amount_minor - v_dep.applied_minor then
    raise exception 'apply amount must be positive and within the % remaining',
      v_dep.amount_minor - v_dep.applied_minor
      using errcode = 'check_violation';
  end if;

  insert into customer_ledger_entries
    (org_id, customer_id, entry_kind, amount_minor, currency,
     job_id, deposit_id, note, created_by, device_id, session_id)
  values
    (v_org, v_dep.customer_id, 'deposit_apply', -p_amount_minor, v_dep.currency,
     v_dep.job_id, v_dep.id, nullif(trim(coalesce(p_note, '')), ''),
     v_user, current_device_id(), current_session_id());

  update deposits
     set applied_minor = applied_minor + p_amount_minor,
         state = 'partially_applied',
         updated_at = now()
   where id = v_dep.id
  returning * into v_dep;

  return v_dep;
end
$$;

/**
 * refund_deposit — the terminal transition, and the one override 15 calls
 * "the most direct money-loss path in the plan".
 *
 * owner/manager ONLY (override 17). Refunds exactly the remaining amount;
 * REFUSED while the linked job has any unresolved shortfall (D6 — the list
 * comes back in the error so the desk can say WHY the client waits). A
 * fully-applied deposit has nothing to move and is refused too (D5).
 */
create or replace function refund_deposit(
  p_deposit_id uuid,
  p_note       text default null
)
returns deposits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org       uuid := current_org_id();
  v_user      uuid := current_user_id();
  v_dep       deposits%rowtype;
  v_remaining bigint;
  v_blockers  text;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  perform require_role('owner', 'manager');

  -- D8: refunds get their own, tighter budget.
  if not rate_limit_check('refund:' || v_org::text || ':' || v_user::text, 6, '1 minute') then
    raise exception 'too many refunds; wait a moment'
      using errcode = 'too_many_connections';
  end if;

  select * into v_dep from deposits d
   where d.id = p_deposit_id and d.org_id = v_org
   for update;
  if not found then
    raise exception 'deposit % does not belong to this org', p_deposit_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_dep.state not in ('held', 'partially_applied') then
    raise exception 'deposit % is already %', p_deposit_id, v_dep.state
      using errcode = 'check_violation';
  end if;

  v_remaining := v_dep.amount_minor - v_dep.applied_minor;
  if v_remaining <= 0 then
    raise exception 'deposit % is fully applied; there is nothing to refund', p_deposit_id
      using errcode = 'check_violation';
  end if;

  -- THE GATE (override 15 / D6): no refund while the linked job is not
  -- QC-clear. The cracked matte box is found at the bench, not the counter.
  if v_dep.job_id is not null then
    select string_agg(s.reason || ' (' || s.detail || ')', '; ')
      into v_blockers
      from job_money_shortfalls(v_dep.job_id) s;
    if v_blockers is not null then
      raise exception 'refund refused — the job is not QC-clear: %', v_blockers
        using errcode = 'check_violation';
    end if;
  end if;

  insert into customer_ledger_entries
    (org_id, customer_id, entry_kind, amount_minor, currency,
     job_id, deposit_id, note, created_by, device_id, session_id)
  values
    (v_org, v_dep.customer_id, 'deposit_refund', -v_remaining, v_dep.currency,
     v_dep.job_id, v_dep.id, nullif(trim(coalesce(p_note, '')), ''),
     v_user, current_device_id(), current_session_id());

  update deposits
     set refunded_minor = v_remaining,
         refunded_by = v_user,
         refunded_at = now(),
         state = 'refunded',
         updated_at = now()
   where id = v_dep.id
  returning * into v_dep;

  -- Money-destructive: audited like role changes and tag binding (0007).
  perform write_audit(
    'deposit_refund', 'deposit', v_dep.id, null,
    jsonb_build_object('customer_id', v_dep.customer_id,
                       'job_id', v_dep.job_id,
                       'refunded_minor', v_remaining));

  return v_dep;
end
$$;

comment on function refund_deposit(uuid, text) is
  'Terminal deposit transition, owner/manager only (override 17). Refunds the remaining amount; refused while job_money_shortfalls(linked job) is non-empty (override 15) or when nothing remains. Audited.';

-- ---------------------------------------------------------------------------
-- Grants — every function is born with PUBLIC execute (the 0015 M1 lesson):
-- revoke first, then the explicit door list.
-- ---------------------------------------------------------------------------
revoke all on function money_write_context(text[])                                   from public;
revoke all on function validate_ledger_entry()                                       from public;
revoke all on function reject_ledger_mutation()                                      from public;
revoke all on function jobs_check_customer_org()                                     from public;
revoke all on function credentials_check_customer_org()                              from public;

revoke all on function record_ledger_entry(uuid, text, bigint, uuid, uuid, text, uuid) from public;
revoke all on function record_payment(uuid, bigint, uuid, text)                        from public;
revoke all on function hold_deposit(uuid, bigint, uuid, text)                          from public;
revoke all on function apply_deposit(uuid, bigint, text)                               from public;
revoke all on function refund_deposit(uuid, text)                                      from public;
revoke all on function job_money_shortfalls(uuid)                                      from public;
revoke all on function customer_needs_credentials(uuid, bigint)                        from public;

grant execute on function
  record_ledger_entry(uuid, text, bigint, uuid, uuid, text, uuid),
  record_payment(uuid, bigint, uuid, text),
  hold_deposit(uuid, bigint, uuid, text),
  apply_deposit(uuid, bigint, text),
  refund_deposit(uuid, text),
  job_money_shortfalls(uuid),
  customer_needs_credentials(uuid, bigint)
  to papa_app;
