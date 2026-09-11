-- ============================================================================
-- 0019 — The expense side of the money book: org_expenses, the kharcha RPCs,
--        and the three profit reads (job_margin, asset_cost_history,
--        monthly_profit)
--
-- Ordered by the year simulation (docs/year-in-the-life.md (b)3, findings
-- `no-expense-book` / `no-subrent-intake`): the ledger was customer-only, so
-- a camera repair (Rs 45,000 to the workshop), a partner house's sub-hire
-- bill and replacement cables landed on NO book at all — "what did the year
-- actually make", the vendor's-dream question, was structurally unanswerable.
-- This migration gives the house its own side of the book.
--
-- WHAT THIS MIGRATION DECIDES, and why:
--
--   D1  ONE TABLE, SIX KINDS, EVERY AMOUNT POSITIVE. org_expenses records
--       money the HOUSE paid out: repair | sub_hire | purchase | transport |
--       consumables | misc. There is no sign convention to memorise — an
--       expense is always money that left (amount_minor > 0), and profit is
--       a READ (income minus expenses), never a stored sum. The customer
--       ledger keeps its own signs; the two books never share rows.
--
--   D2  THE LEDGER TREATMENT, exactly (0017 D3): append-only via trigger AND
--       withheld grants; attribution (created_by, device_id, session_id)
--       from the papa.* GUCs, never from arguments; device/session recorded
--       WITHOUT foreign keys — attribution must survive its referent.
--       papa_app has NO INSERT grant; expenses move only through the
--       DEFINER RPCs below.
--
--   D3  REVERSALS POINT FORWARD, mirroring 0018's reversal_of — but with
--       VOID-PAIR semantics, not cancellation. The customer ledger keeps a
--       reversal and its target in every sum (they cancel to zero) because
--       the CLIENT saw both lines happen and the statement must print both.
--       An expense book is the house's own record: nobody outside is owed a
--       printed pair, and every stored amount stays positive (D1). So a
--       reversal row NAMES its target, carries the SAME kind and the SAME
--       amount (the record stays legible: "reversed the Rs 45,000 repair"),
--       and at read time the PAIR leaves every sum — the voidScan treatment,
--       derived at read, never an UPDATE. Once per target (unique partial
--       index, enforced under concurrency where a trigger cannot); a
--       reversal cannot itself be reversed — recording the expense again is
--       a fresh row, not a chain.
--
--   D4  NOT SYNCABLE, and gated like the ledger (0017 D2). The money book
--       is a desk/owner surface; pull_changes delivers every row to every
--       device and the warehouse floor has no business reading what the
--       house pays a workshop. No change_seq, so sync_pii_violations() and
--       the 0015 guard stay at zero; SELECT is role-gated to
--       owner/manager/desk in RLS itself — zero rows is honest, zero
--       rupees is not.
--
--   D5  WHAT THE LINKS MEAN. asset_id ties a repair (or a unit's purchase)
--       to the gear it kept alive — asset_cost_history and the client's
--       payback bar read it. job_id ties a sub-hire to the job it rescued —
--       job_margin reads it. counterparty is the partner house or workshop,
--       free text: the payee is a name on a receipt, not an entity this
--       schema needs to own yet. All nullable — a consumables run has
--       neither an asset nor a job, and forcing a link invents data.
--
--   D6  spent_at IS THE PAST FACT and the caller may BACKDATE it ("paid the
--       workshop last Tuesday, recording it now" is an everyday truth —
--       the same reason the client's money writes take whenMs).
--       server_time is when the server heard, stamped here as everywhere.
--
--   D7  THE VIEWS ARE TIMEZONE-NEUTRAL ON server_time. monthly_profit
--       buckets both sides of the book by date_trunc('month',
--       server_time at time zone 'UTC') — a fixed, session-independent
--       boundary. The month boundary a VENDOR means is the PKT calendar
--       month, and that is computed CLIENT-side where it is rendered (the
--       demo's monthlyProfit read does exactly this from raw rows); this
--       view is the server's coarse answer, documented as such, not a
--       second truth to drift against.
--
--   D8  ROLES AND RATE. owner/manager/desk write expenses — the same desk
--       tier that writes the customer ledger (0017 D7) — through the SHARED
--       money budget (money:<org>:<user>, 60/min, 0017 D8): an expense is a
--       money write and budgets are per-person, not per-table.
--       readonly/driver/warehouse write nothing and READ nothing (D4).
--
--   D9  INCOME, WHERE THE VIEWS SUM IT, is the charge side of the ledger
--       (charge + late_fee + damage_charge), minus anything a correction
--       superseded or a reversal cancelled — a charged-then-returned item
--       is not income, the asset_earnings precedent (0018 D7) applied to
--       the month and the job.
--
-- Everything here is idempotent: IF NOT EXISTS / OR REPLACE / drop-and-
-- recreate pairs, the 0015–0018 discipline. 0001–0018 stay untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- org_expenses — what the house paid out (D1, D2, D3, D5, D6)
-- ---------------------------------------------------------------------------
create table if not exists org_expenses (
  id           uuid primary key default uuid_generate_v7(),
  org_id       uuid not null references orgs(id) on delete restrict,

  kind         text not null,
  amount_minor bigint not null,
  currency     text not null default 'PKR',

  -- What the money was FOR (D5). A repair names the camera it fixed; a
  -- sub-hire names the job it rescued; a purchase MAY name the unit bought.
  asset_id     uuid references assets(id) on delete restrict,
  job_id       uuid references jobs(id) on delete restrict,

  -- Who was paid: the partner house, the workshop, the Hall Road shop.
  counterparty text,
  note         text,

  -- D3: a reversal names the row it voids; the pair leaves every sum at
  -- read time. Same kind, same amount, once, never a reversal of a reversal
  -- — enforced by validate_expense and expenses_reversal_once_idx.
  reversal_of  uuid references org_expenses(id) on delete restrict,

  -- D6: when the money actually left, backdatable. server_time is when the
  -- server heard about it.
  spent_at     timestamptz not null default now(),

  -- Attribution from the papa.* GUCs (0017 D3); no FKs on device/session —
  -- attribution must survive its referent.
  created_by   uuid not null references users(id) on delete restrict,
  device_id    text,
  session_id   uuid,

  server_time  timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  constraint expenses_kind_check check (kind in (
    'repair', 'sub_hire', 'purchase', 'transport', 'consumables', 'misc'
  )),
  -- D1: an expense is money that left, full stop. Correction is a reversal
  -- row, never a negative amount.
  constraint expenses_amount_positive check (amount_minor > 0),
  constraint expenses_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint expenses_no_self_reversal
    check (reversal_of is null or reversal_of <> id)
);

create index if not exists expenses_org_spent_idx
  on org_expenses (org_id, spent_at desc);
create index if not exists expenses_org_asset_idx
  on org_expenses (org_id, asset_id) where asset_id is not null;
create index if not exists expenses_org_job_idx
  on org_expenses (org_id, job_id) where job_id is not null;
-- Once only (D3): two live reversals of one target would both void it and
-- every profit read would over-credit the house.
create unique index if not exists expenses_reversal_once_idx
  on org_expenses (reversal_of) where reversal_of is not null;

comment on table org_expenses is
  'The expense side of the money book (0019): repairs, sub-hire, purchases — append-only, positive amounts, profit is always a read. A reversal names its target and the PAIR leaves every sum at read time (D3 — void-pair, not cancellation). Writes only through record_expense/reverse_expense. Never syncable (D4).';
comment on column org_expenses.reversal_of is
  'For a reversal row: the expense this row voids. Same kind and amount as the target (legibility), once per target (expenses_reversal_once_idx), never a reversal of a reversal. Both rows leave every sum at read time — supersession derived at read, never an UPDATE.';
comment on column org_expenses.spent_at is
  'When the money actually left, backdatable by the caller (D6) — the past fact. server_time is when the server heard.';

-- Append-only, enforced by the database rather than by good intentions —
-- the scan_events/ledger treatment: trigger AND withheld grants.
create or replace function reject_expense_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'org_expenses is append-only; correct a mistake with reverse_expense and record it again'
    using errcode = 'restrict_violation';
end
$$;

drop trigger if exists expenses_no_update on org_expenses;
create trigger expenses_no_update
  before update on org_expenses
  for each row execute function reject_expense_mutation();
drop trigger if exists expenses_no_delete on org_expenses;
create trigger expenses_no_delete
  before delete on org_expenses
  for each row execute function reject_expense_mutation();

-- Tenancy and reversal validation, the 0015 M4/M5a shape: FKs check
-- existence, this checks OWNERSHIP and the reversal rules, and it holds for
-- every insert path including a careless future DEFINER function. DEFINER so
-- it can see the foreign row in order to refuse it.
create or replace function validate_expense()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t org_expenses%rowtype;
begin
  if new.asset_id is not null and not exists (
    select 1 from assets a where a.id = new.asset_id and a.org_id = new.org_id
  ) then
    raise exception 'asset % does not belong to this org', new.asset_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.job_id is not null and not exists (
    select 1 from jobs j where j.id = new.job_id and j.org_id = new.org_id
  ) then
    raise exception 'job % does not belong to this org', new.job_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.reversal_of is not null then
    select * into t from org_expenses e where e.id = new.reversal_of;

    if not found or t.org_id <> new.org_id then
      raise exception 'reversal target does not exist in this org'
        using errcode = 'foreign_key_violation';
    end if;
    if t.reversal_of is not null then
      raise exception 'a reversal cannot reverse a reversal; record the expense again'
        using errcode = 'check_violation';
    end if;
    -- D3: the pair must read as one voided fact — same kind, same amount.
    if t.kind <> new.kind then
      raise exception 'a reversal must keep the kind of the expense it voids (% -> %)',
        t.kind, new.kind
        using errcode = 'check_violation';
    end if;
    if new.amount_minor <> t.amount_minor then
      raise exception 'a reversal must match its target exactly (target %, got %)',
        t.amount_minor, new.amount_minor
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists expenses_validate on org_expenses;
create trigger expenses_validate
  before insert on org_expenses
  for each row execute function validate_expense();

alter table org_expenses enable row level security;
alter table org_expenses force row level security;

-- Money is a desk/owner read (D4). NO update/delete policy exists at all.
drop policy if exists expenses_select on org_expenses;
create policy expenses_select on org_expenses
  for select using (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );
drop policy if exists expenses_insert on org_expenses;
create policy expenses_insert on org_expenses
  for insert with check (org_id = (select current_org_id()));

grant select on org_expenses to papa_app;   -- no insert: RPCs only (D2)

-- ---------------------------------------------------------------------------
-- The kharcha RPCs — the only door (D2, D8)
-- ---------------------------------------------------------------------------

/**
 * record_expense — money the house paid out, as a past fact.
 *
 * owner/manager/desk, through the SHARED money budget (0017 D8). The
 * amount is positive or refused; spent_at may be backdated (D6). Tenancy
 * of asset/job is checked by hand — the DEFINER sees every org's rows,
 * the 0004 trap handled the 0004 way.
 */
create or replace function record_expense(
  p_kind         text,
  p_amount_minor bigint,
  p_asset_id     uuid default null,
  p_job_id       uuid default null,
  p_counterparty text default null,
  p_note         text default null,
  p_spent_at     timestamptz default null
)
returns org_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_row  org_expenses%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from money_write_context(array['owner', 'manager', 'desk']);

  if p_kind is null or p_kind not in
     ('repair', 'sub_hire', 'purchase', 'transport', 'consumables', 'misc') then
    raise exception 'unknown expense kind %', coalesce(p_kind, '(null)')
      using errcode = 'invalid_parameter_value';
  end if;

  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'an expense is money that left the house; the amount must be positive'
      using errcode = 'check_violation';
  end if;

  if p_asset_id is not null and not exists (
    select 1 from assets a where a.id = p_asset_id and a.org_id = v_org
  ) then
    raise exception 'asset % does not belong to this org', p_asset_id
      using errcode = 'foreign_key_violation';
  end if;

  if p_job_id is not null and not exists (
    select 1 from jobs j where j.id = p_job_id and j.org_id = v_org
  ) then
    raise exception 'job % does not belong to this org', p_job_id
      using errcode = 'foreign_key_violation';
  end if;

  insert into org_expenses
    (org_id, kind, amount_minor, currency, asset_id, job_id,
     counterparty, note, spent_at,
     created_by, device_id, session_id)
  values
    (v_org, p_kind, p_amount_minor,
     coalesce((select o.currency from orgs o where o.id = v_org), 'PKR'),
     p_asset_id, p_job_id,
     nullif(trim(coalesce(p_counterparty, '')), ''),
     nullif(trim(coalesce(p_note, '')), ''),
     coalesce(p_spent_at, now()),
     -- Attribution from the GUCs, never from arguments (0017 D3).
     v_user, current_device_id(), current_session_id())
  returning * into v_row;

  return v_row;
end
$$;

comment on function record_expense(text, bigint, uuid, uuid, text, text, timestamptz) is
  'The expense write: owner/manager/desk through the shared money budget, positive amount, tenancy checked by hand, attribution from papa.* GUCs, spent_at backdatable (a past fact). Reversal is reverse_expense — this door never writes reversal_of.';

/**
 * reverse_expense — void one expense, forward-only.
 *
 * Inserts the reversal row ITSELF (kind, amount and links copied from the
 * target) so no caller can mis-copy them; the trigger re-checks. Refused
 * when the target is already reversed (the unique index backs the check
 * under concurrency) or is itself a reversal. Audited: a reversal rewrites
 * the house's own record of where money went.
 */
create or replace function reverse_expense(
  p_expense_id uuid,
  p_note       text default null
)
returns org_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_t    org_expenses%rowtype;
  v_row  org_expenses%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from money_write_context(array['owner', 'manager', 'desk']);

  select * into v_t from org_expenses e
   where e.id = p_expense_id and e.org_id = v_org;
  if not found then
    raise exception 'expense % does not belong to this org', p_expense_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_t.reversal_of is not null then
    raise exception 'a reversal cannot reverse a reversal; record the expense again'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from org_expenses r where r.reversal_of = v_t.id) then
    raise exception 'expense % is already reversed', p_expense_id
      using errcode = 'check_violation';
  end if;

  insert into org_expenses
    (org_id, kind, amount_minor, currency, asset_id, job_id,
     counterparty, note, reversal_of, spent_at,
     created_by, device_id, session_id)
  values
    (v_org, v_t.kind, v_t.amount_minor, v_t.currency, v_t.asset_id, v_t.job_id,
     v_t.counterparty, nullif(trim(coalesce(p_note, '')), ''), v_t.id, now(),
     v_user, current_device_id(), current_session_id())
  returning * into v_row;

  -- A reversal rewrites the house's own money record — audited like ledger
  -- corrections and reversals (0017/0018).
  perform write_audit(
    'expense_reversal', 'org_expense', v_t.id, v_t.kind,
    jsonb_build_object('reversing_expense_id', v_row.id,
                       'amount_minor', v_t.amount_minor));

  return v_row;
end
$$;

comment on function reverse_expense(uuid, text) is
  'Void one expense forward-only (D3): inserts the reversal row itself, copying kind/amount/links from the target so nothing can be mis-copied. Once per target; never a reversal of a reversal. Audited.';

-- ---------------------------------------------------------------------------
-- The profit reads (D7, D9): views, security_invoker, sums over live rows.
--
-- "Live" on the expense side = not a reversal row AND not named by one (the
-- void-pair, D3). "Live" on the income side = not superseded by a correction
-- AND not cancelled by a reversal (the 0018 D7 rule).
-- ---------------------------------------------------------------------------

drop view if exists job_margin;
create view job_margin with (security_invoker = true) as
select
  j.org_id,
  j.id            as job_id,
  j.label,
  j.customer_id,
  j.status,
  coalesce(i.s, 0)::bigint                    as income_minor,
  coalesce(x.s, 0)::bigint                    as expense_minor,
  (coalesce(i.s, 0) - coalesce(x.s, 0))::bigint as margin_minor
  from jobs j
  left join lateral (
    select sum(e.amount_minor) as s
      from customer_ledger_entries e
     where e.job_id = j.id
       and e.entry_kind in ('charge', 'late_fee', 'damage_charge')
       and not exists (select 1 from customer_ledger_entries c
                        where c.corrects_entry_id = e.id)
       and not exists (select 1 from customer_ledger_entries v
                        where v.reversal_of = e.id)
  ) i on true
  left join lateral (
    select sum(e.amount_minor) as s
      from org_expenses e
     where e.job_id = j.id
       and e.reversal_of is null
       and not exists (select 1 from org_expenses r where r.reversal_of = e.id)
  ) x on true
 where j.deleted_at is null
   -- jobs are org-visible to every role, but a warehouse phone reading every
   -- job at margin 0 would be a lie rather than a refusal (the
   -- customer_balances reasoning, 0017). Zero rows is honest.
   and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk');

comment on view job_margin is
  'What one job actually made: live charge-side ledger income naming the job (D9) minus live expenses naming it (the sub-hire that rescued it). security_invoker + an explicit role predicate — non-money roles get zero rows, never zero margins.';

grant select on job_margin to papa_app;

drop view if exists asset_cost_history;
create view asset_cost_history with (security_invoker = true) as
select
  e.org_id,
  e.asset_id,
  a.purchase_price_minor,
  coalesce(sum(e.amount_minor) filter (where e.kind = 'repair'), 0)::bigint
    as repair_minor,
  count(*) filter (where e.kind = 'repair')::int as repair_count,
  coalesce(sum(e.amount_minor) filter (where e.kind = 'purchase'), 0)::bigint
    as purchase_expense_minor,
  -- The KNOWN costs, summed: an unrecorded purchase price contributes
  -- nothing rather than a made-up zero pretending to be a price — the
  -- client renders the honesty (its payback bar refuses a made-up
  -- denominator; this view refuses to invent one).
  (coalesce(a.purchase_price_minor, 0)
     + coalesce(sum(e.amount_minor) filter (where e.kind in ('repair', 'purchase')), 0)
  )::bigint as total_cost_minor,
  max(e.spent_at) filter (where e.kind = 'repair') as last_repair_at
  from org_expenses e
  join assets a on a.id = e.asset_id
 where e.asset_id is not null
   and e.reversal_of is null
   and not exists (select 1 from org_expenses r where r.reversal_of = e.id)
 group by e.org_id, e.asset_id, a.purchase_price_minor;

comment on view asset_cost_history is
  'What one unit has COST: its recorded purchase price plus every live repair/purchase expense naming it. The other half of the payback question — asset_earnings says what it made; this says what it took. Rows exist only for assets with expenses; org_expenses RLS gates who sees them.';

grant select on asset_cost_history to papa_app;

drop view if exists monthly_profit;
create view monthly_profit with (security_invoker = true) as
with income as (
  select e.org_id,
         date_trunc('month', e.server_time at time zone 'UTC') as month,
         sum(e.amount_minor) as s
    from customer_ledger_entries e
   where e.entry_kind in ('charge', 'late_fee', 'damage_charge')
     and not exists (select 1 from customer_ledger_entries c
                      where c.corrects_entry_id = e.id)
     and not exists (select 1 from customer_ledger_entries v
                      where v.reversal_of = e.id)
   group by e.org_id, 2
),
spend as (
  select e.org_id,
         date_trunc('month', e.server_time at time zone 'UTC') as month,
         sum(e.amount_minor) as s
    from org_expenses e
   where e.reversal_of is null
     and not exists (select 1 from org_expenses r where r.reversal_of = e.id)
   group by e.org_id, 2
)
select
  coalesce(i.org_id, x.org_id)  as org_id,
  coalesce(i.month, x.month)    as month,
  coalesce(i.s, 0)::bigint      as earned_minor,
  coalesce(x.s, 0)::bigint      as spent_minor,
  (coalesce(i.s, 0) - coalesce(x.s, 0))::bigint as profit_minor
  from income i
  full outer join spend x on x.org_id = i.org_id and x.month = i.month;

comment on view monthly_profit is
  'Earned minus spent by month (D7, D9): live charge-side income and live expenses, bucketed by date_trunc(month, server_time at time zone UTC) — TIMEZONE-NEUTRAL and deliberately coarse. The month boundary a vendor means is the PKT calendar month, computed CLIENT-side where rendered (the demo''s monthlyProfit read); this view must never grow a competing timezone opinion.';

grant select on monthly_profit to papa_app;

-- ---------------------------------------------------------------------------
-- Grants — every function is born with PUBLIC execute (the 0015 M1 lesson):
-- revoke first, then the explicit door list.
-- ---------------------------------------------------------------------------
revoke all on function reject_expense_mutation()                                       from public;
revoke all on function validate_expense()                                              from public;
revoke all on function record_expense(text, bigint, uuid, uuid, text, text, timestamptz) from public;
revoke all on function reverse_expense(uuid, text)                                     from public;

grant execute on function
  record_expense(text, bigint, uuid, uuid, text, text, timestamptz),
  reverse_expense(uuid, text)
  to papa_app;
