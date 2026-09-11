-- ============================================================================
-- 0024 — Rate cards, the org calendar, and the pricing pipeline in SQL
--
-- Phase 3 commercial (PLAN.md phase 3; overrides 17 and 18 govern here;
-- vendor-dream-plan C3–C4; assumptions #week-rate / #weekend). Until now
-- the schema knows what is promised (0022) and what money moved
-- (0017/0019). It cannot say what a promise is WORTH. This migration adds
-- the rate card, the calendar the card is read against, the logged manual
-- override, and price_booking(): one documented, ordered pipeline that
-- answers "why was this Rs 8,000" with a trace rather than a number.
--
-- WHAT THIS MIGRATION DECIDES, and why:
--
--   D1  ONE PIPELINE, SIX NAMED STEPS, FIXED ORDER. PLAN.md: "five knobs
--       with no stated precedence is where every rental-system pricing
--       bug lives". So price_booking() is a sequence, each step named in
--       its output, and the golden fixtures in the test pin the numbers:
--         1 billable_days        calendar days from customer_period, the
--                                weekend mask dropped, min_billable_days
--                                floored → counted_days
--         2 week_rule            every full 7 counted days bills
--                                week_equals_days; the remainder bills
--                                per day, capped at a week → billable_days
--         3 card_rates           per-line day rate from the card; a
--                                missing entry makes the line UNPRICED
--         4 calendar_multiplier  the MAX rate_multiplier of any calendar
--                                day inside the period, booking-wide
--         5 overrides            a logged manual rate replaces the card
--                                rate and reports the original
--         6 totals               subtotal, unpriced_count, sub-hire cost,
--                                margin, indicative
--       Nothing prices outside this function. The client renders the
--       trace; it never recomputes it (principle 4: one home).
--
--   D2  A DAY IS 24 HOURS FROM PICKUP, DATED IN THE ORG'S TIMEZONE.
--       calendar_days = ceil(duration / 24h), never below 1. Out Tuesday
--       10:00, back Friday 10:00 is three days; back Friday 10:01 is
--       four. The concrete dates those days fall on (pickup date + i, in
--       orgs.timezone) are what the weekend mask and the calendar read.
--       This is the convention a return-by-the-same-time house already
--       runs; "every calendar date touched" would bill the return
--       morning, which no desk would defend.
--
--   D3  THE WEEKEND MASK IS ON THE CARD, AND IT DROPS DAYS. weekend_mask
--       lists the ISO weekdays (1 = Monday … 7 = Sunday) that do NOT
--       count as billable days; default {6,7} — Saturday and Sunday, with
--       Friday a full day (ASSUMPTION #weekend). Whether a Lahore house
--       actually gives the weekend away is the open half of that
--       assumption (#weekend-free); the trace names every dropped date so
--       the owner sees exactly what was given. A weekend-only job still
--       bills min_billable_days. It lives on the card, not in
--       orgs.settings, because a house may run one card that gives the
--       weekend and one that does not (the 0001 comment predates the
--       card; the card is the one home now).
--
--   D4  THE 3-DAY WEEK (ASSUMPTION #week-rate). week_equals_days is
--       numeric, default 3, per card. billable = weeks × W + least(
--       remainder, W): a 10-day job is 1 week (3) + 3 remainder days = 6;
--       14 days = 6; 8 days = 3 + 1 = 4; a 6-day remainder is capped at
--       3 — a remainder never costs more than the week it almost is.
--
--   D5  UNPRICED IS COUNTED, NEVER ZERO (the money-honesty rule). A line
--       whose product has no entry on the card is reported priced=false
--       with line_total_minor null, counted in unpriced_count, and the
--       whole quote is flagged indicative. A stored rate of 0 IS a price
--       (an included cable) — the difference between "free" and "nobody
--       typed a number" is the whole rule, so entries refuse only
--       negatives and a missing entry is never coalesced to 0.
--
--   D6  THE CALENDAR IS DATA, NOT CODE. org_calendar_days holds holidays
--       and seasons as dated rows with a rate_multiplier — Eid moves on
--       the lunar calendar and no function can know where it lands next
--       year. ensure_default_calendar() seeds the Dec–Feb wedding season
--       lazily per org at multiplier 1.0 — shading only — because seasonal
--       pricing practice is unverified (ASSUMPTION #seasonal-pricing);
--       the vendor raises it by editing rows, never by a code change.
--       A deleted row stays deleted across re-seeds: the seed never
--       resurrects what the desk removed.
--
--   D7  THE MULTIPLIER IS THE MAX, BOOKING-WIDE. One factor for the whole
--       booking: the highest rate_multiplier of any calendar day inside
--       the billed span. Not a per-day blend — a 3-day job crossing Eid
--       is an Eid job to the house that has to staff it, and a blend is
--       a number nobody can check on a challan. The trace names the
--       driving day so the desk can point at it.
--
--   D8  THE OVERRIDE IS THE OWNER'S LAST WORD (override 18; the research:
--       "never fight the owner's judgement; record it"). booking_lines
--       gains rate_minor / original_rate_minor / override_reason /
--       overridden_by / overridden_at. An overridden line bills rate_minor
--       as its FINAL day rate — the calendar multiplier does not apply
--       on top (multiplier_applied=false in the trace): when the owner
--       says "Rs 20,000 for Rafi", that is the number, not 20,000 × 1.25.
--       original_rate_minor is the card rate at override time so the
--       discount is always legible. Reason required; owner|manager only;
--       audited (override 17: money-touching actions gated in the RPC
--       body, not the UI).
--
--   D9  MARGIN BEFORE QUOTE (vendor-dream-plan C4). org_expenses gains a
--       nullable booking_id; record_expense takes it as a trailing
--       parameter so every existing caller keeps working. booking_sub_
--       hire_cost() sums every LIVE expense (0019 D3 void-pair rule)
--       tagged to the booking directly OR to the job the booking became
--       (jobs.booking_id, 0022 D8) — whatever its kind: transport to the
--       set is as much a cost of this quote as the sub-hired lens.
--       price_booking's totals carry sub_hire_cost_minor and margin_minor
--       so the desk sees the margin on the quote screen, not in a
--       phase-5 report.
--
--   D10 ONE DEFAULT CARD PER ORG, ALWAYS. A partial unique index on
--       (org_id) where is_default holds it to one; upsert_rate_card
--       clears the previous default when a new one is set, and the first
--       live card an org creates becomes default by itself so
--       price_booking(p_rate_card_id => null) always has somewhere to
--       look. No card at all → every line unpriced, trace says so.
--
--   D11 WRITES GO THROUGH THE RPCs ONLY (0017/0022 door pattern). papa_app
--       holds SELECT and nothing else on the three new tables; every
--       RPC is SECURITY DEFINER with pinned search_path, explicit org
--       predicates, the booking rate bucket, and a write_audit row.
--       rate_cards and rate_card_entries are role-gated in RLS to
--       owner/manager/desk like the money book (0019 D4) — the warehouse
--       floor has no business reading the price list; org_calendar_days
--       is visible to every member because season shading is useful on
--       every screen. None of the three sync (no change_seq).
--
--   D12 price_booking IS A READ WITH A ROLE. It writes nothing, is
--       STABLE, and requires owner|manager|desk — the roles that may see
--       the ledger — because a quote is commercial and the org_expenses
--       it reads for margin are gated the same way.
--
-- Everything here is idempotent: IF NOT EXISTS / OR REPLACE / drop-and-
-- recreate pairs, the 0015–0022 discipline. 0001–0023 stay untouched;
-- nothing here depends on 0023's objects.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- rate_cards (D3, D4, D10)
-- ---------------------------------------------------------------------------
create table if not exists rate_cards (
  id                 uuid primary key default uuid_generate_v7(),
  org_id             uuid not null references orgs(id) on delete restrict,
  name               text not null,
  is_default         boolean not null default false,

  -- ASSUMPTION: a week bills as 3 day-rates. See docs/assumptions.md#week-rate.
  week_equals_days   numeric(4,2) not null default 3,
  min_billable_days  integer not null default 1,

  -- ASSUMPTION: Sat/Sun are the weekend and are not billed; Friday is a
  -- full day. See docs/assumptions.md#weekend and #weekend-free.
  weekend_mask       integer[] not null default '{6,7}',

  created_by   uuid references users(id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  constraint rate_cards_name_nonempty check (length(trim(name)) > 0),
  constraint rate_cards_week_check
    check (week_equals_days > 0 and week_equals_days <= 7),
  constraint rate_cards_min_days_check check (min_billable_days >= 1),
  constraint rate_cards_weekend_mask_check
    check (weekend_mask <@ array[1,2,3,4,5,6,7])
);

create index if not exists rate_cards_org_live_idx
  on rate_cards (org_id) where deleted_at is null;
-- D10: at most one default per org.
create unique index if not exists rate_cards_one_default_idx
  on rate_cards (org_id) where is_default and deleted_at is null;

comment on table rate_cards is
  'A price list (0024): the 3-day week, the minimum bill, the weekend mask — per card, one default per org (D10). Entries in rate_card_entries. Writes only through upsert_rate_card.';
comment on column rate_cards.weekend_mask is
  'ISO weekdays (1=Mon..7=Sun) that do NOT count as billable days (D3). Default {6,7}. ASSUMPTION #weekend / #weekend-free.';
comment on column rate_cards.week_equals_days is
  'How many day-rates a full 7-day block bills (D4). ASSUMPTION #week-rate: 3.';

drop trigger if exists rate_cards_updated_at on rate_cards;
create trigger rate_cards_updated_at
  before update on rate_cards for each row execute function set_updated_at();

alter table rate_cards enable row level security;
alter table rate_cards force row level security;

drop policy if exists rate_cards_select on rate_cards;
create policy rate_cards_select on rate_cards
  for select using (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );

grant select on rate_cards to papa_app;   -- writes through the RPCs only (D11)

-- ---------------------------------------------------------------------------
-- rate_card_entries (D5)
-- ---------------------------------------------------------------------------
create table if not exists rate_card_entries (
  id              uuid primary key default uuid_generate_v7(),
  org_id          uuid not null references orgs(id) on delete restrict,
  rate_card_id    uuid not null references rate_cards(id) on delete restrict,
  product_id      uuid not null references products(id) on delete restrict,
  day_rate_minor  bigint not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  -- D5: 0 is a price (an included item); a missing entry is not.
  constraint rate_card_entries_rate_check check (day_rate_minor >= 0),
  constraint rate_card_entries_unique unique (rate_card_id, product_id)
);

create index if not exists rate_card_entries_org_card_idx
  on rate_card_entries (org_id, rate_card_id) where deleted_at is null;
create index if not exists rate_card_entries_org_product_idx
  on rate_card_entries (org_id, product_id) where deleted_at is null;

comment on table rate_card_entries is
  'One product''s day rate on one card (0024). Replacement value stays on products (0002) — it is not a rate. A missing entry means UNPRICED, never zero (D5). Writes only through upsert_rate_entry.';

drop trigger if exists rate_card_entries_updated_at on rate_card_entries;
create trigger rate_card_entries_updated_at
  before update on rate_card_entries for each row execute function set_updated_at();

create or replace function rate_card_entries_check_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from rate_cards c
     where c.id = new.rate_card_id and c.org_id = new.org_id
  ) then
    raise exception 'rate card % does not belong to this org', new.rate_card_id
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1 from products p
     where p.id = new.product_id and p.org_id = new.org_id
  ) then
    raise exception 'product % does not belong to this org', new.product_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

drop trigger if exists rate_card_entries_org on rate_card_entries;
create trigger rate_card_entries_org
  before insert or update of rate_card_id, product_id, org_id on rate_card_entries
  for each row execute function rate_card_entries_check_org();

alter table rate_card_entries enable row level security;
alter table rate_card_entries force row level security;

drop policy if exists rate_card_entries_select on rate_card_entries;
create policy rate_card_entries_select on rate_card_entries
  for select using (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );

grant select on rate_card_entries to papa_app;

-- ---------------------------------------------------------------------------
-- org_calendar_days (D6, D7)
-- ---------------------------------------------------------------------------
create table if not exists org_calendar_days (
  id               uuid primary key default uuid_generate_v7(),
  org_id           uuid not null references orgs(id) on delete restrict,
  day              date not null,
  kind             text not null,
  name             text not null,
  -- ASSUMPTION: 1.0 by default — shading, not pricing.
  -- See docs/assumptions.md#seasonal-pricing.
  rate_multiplier  numeric(6,3) not null default 1.0,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  constraint org_calendar_days_kind_check check (kind in ('holiday', 'season')),
  constraint org_calendar_days_name_nonempty check (length(trim(name)) > 0),
  constraint org_calendar_days_multiplier_check
    check (rate_multiplier > 0 and rate_multiplier <= 10),
  -- One row per (day, kind): a day can be both Eid and in-season, and the
  -- pipeline takes the max (D7). Full uniqueness (not partial) so a
  -- soft-deleted row is revived by set_calendar_day rather than doubled.
  constraint org_calendar_days_unique unique (org_id, day, kind)
);

create index if not exists org_calendar_days_org_day_idx
  on org_calendar_days (org_id, day) where deleted_at is null;

comment on table org_calendar_days is
  'Holidays and seasons as dated rows (0024 D6): Eid moves, so the calendar is data. rate_multiplier feeds price_booking step 4 as the booking-wide MAX (D7). Seeded lazily by ensure_default_calendar at 1.0 (ASSUMPTION #seasonal-pricing). Writes only through set_calendar_day / clear_calendar_day.';

drop trigger if exists org_calendar_days_updated_at on org_calendar_days;
create trigger org_calendar_days_updated_at
  before update on org_calendar_days for each row execute function set_updated_at();

alter table org_calendar_days enable row level security;
alter table org_calendar_days force row level security;

drop policy if exists org_calendar_days_select on org_calendar_days;
create policy org_calendar_days_select on org_calendar_days
  for select using (org_id = (select current_org_id()));

grant select on org_calendar_days to papa_app;

-- ---------------------------------------------------------------------------
-- Override 18 on booking_lines (D8)
-- ---------------------------------------------------------------------------
alter table booking_lines add column if not exists rate_minor bigint;
alter table booking_lines add column if not exists original_rate_minor bigint;
alter table booking_lines add column if not exists override_reason text;
alter table booking_lines add column if not exists overridden_by uuid
  references users(id) on delete restrict;
alter table booking_lines add column if not exists overridden_at timestamptz;

alter table booking_lines drop constraint if exists booking_lines_override_shape;
alter table booking_lines add constraint booking_lines_override_shape check (
  (rate_minor is null and override_reason is null
     and overridden_by is null and overridden_at is null)
  or (rate_minor >= 0 and length(trim(override_reason)) > 0
     and overridden_by is not null and overridden_at is not null)
);

comment on column booking_lines.rate_minor is
  'The logged manual override (override 18, 0024 D8): the FINAL day rate for this line, in minor units; null = price from the card. Always paired with reason/by/at.';
comment on column booking_lines.original_rate_minor is
  'The default card''s day rate at the moment of override (null if the line was unpriced then) — so "why was this Rs 8,000" always shows what it replaced.';

-- ---------------------------------------------------------------------------
-- Override 17 hook: expenses may name the booking they cost (D9)
-- ---------------------------------------------------------------------------
alter table org_expenses add column if not exists booking_id uuid
  references bookings(id) on delete restrict;

create index if not exists expenses_org_booking_idx
  on org_expenses (org_id, booking_id) where booking_id is not null;

comment on column org_expenses.booking_id is
  'The booking this cost belongs to (0024 D9) — the sub-hired lens, the transport to set. Summed by booking_sub_hire_cost for margin-before-quote. Nullable; set only at insert (the book is append-only).';

-- validate_expense grows the booking tenancy check (same signature: OR REPLACE).
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

  if new.booking_id is not null and not exists (
    select 1 from bookings b where b.id = new.booking_id and b.org_id = new.org_id
  ) then
    raise exception 'booking % does not belong to this org', new.booking_id
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

-- record_expense gains a trailing p_booking_id. A new parameter is a new
-- signature, so the 0019 one is dropped first (the 0019 test counts exactly
-- one DEFINER record_expense). Every 7-argument caller resolves to this one
-- through the default.
drop function if exists record_expense(text, bigint, uuid, uuid, text, text, timestamptz);

create or replace function record_expense(
  p_kind         text,
  p_amount_minor bigint,
  p_asset_id     uuid default null,
  p_job_id       uuid default null,
  p_counterparty text default null,
  p_note         text default null,
  p_spent_at     timestamptz default null,
  p_booking_id   uuid default null
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

  if p_booking_id is not null and not exists (
    select 1 from bookings b
     where b.id = p_booking_id and b.org_id = v_org and b.deleted_at is null
  ) then
    raise exception 'booking % does not belong to this org', p_booking_id
      using errcode = 'foreign_key_violation';
  end if;

  insert into org_expenses
    (org_id, kind, amount_minor, currency, asset_id, job_id, booking_id,
     counterparty, note, spent_at,
     created_by, device_id, session_id)
  values
    (v_org, p_kind, p_amount_minor,
     coalesce((select o.currency from orgs o where o.id = v_org), 'PKR'),
     p_asset_id, p_job_id, p_booking_id,
     nullif(trim(coalesce(p_counterparty, '')), ''),
     nullif(trim(coalesce(p_note, '')), ''),
     coalesce(p_spent_at, now()),
     v_user, current_device_id(), current_session_id())
  returning * into v_row;

  return v_row;
end
$$;

comment on function record_expense(text, bigint, uuid, uuid, text, text, timestamptz, uuid) is
  'The expense write (0019, +booking_id in 0024 D9): owner/manager/desk through the shared money budget, positive amount, tenancy checked by hand, attribution from papa.* GUCs, spent_at backdatable. Reversal is reverse_expense — this door never writes reversal_of.';

-- reverse_expense copies the new link like every other link (same signature).
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
    (org_id, kind, amount_minor, currency, asset_id, job_id, booking_id,
     counterparty, note, reversal_of, spent_at,
     created_by, device_id, session_id)
  values
    (v_org, v_t.kind, v_t.amount_minor, v_t.currency, v_t.asset_id, v_t.job_id,
     v_t.booking_id,
     v_t.counterparty, nullif(trim(coalesce(p_note, '')), ''), v_t.id, now(),
     v_user, current_device_id(), current_session_id())
  returning * into v_row;

  perform write_audit(
    'expense_reversal', 'org_expense', v_t.id, v_t.kind,
    jsonb_build_object('reversing_expense_id', v_row.id,
                       'amount_minor', v_t.amount_minor));

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- booking_sub_hire_cost — every live cost this quote carries (D9)
-- ---------------------------------------------------------------------------
create or replace function booking_sub_hire_cost(p_booking_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := current_org_id();
  v_sum bigint;
begin
  if v_org is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;
  perform require_role('owner', 'manager', 'desk');

  -- ASSUMPTION: every kind of expense counts, not only sub_hire.
  -- See docs/assumptions.md#sub-hire-cost.
  select coalesce(sum(e.amount_minor), 0) into v_sum
    from org_expenses e
   where e.org_id = v_org
     and e.reversal_of is null
     and not exists (select 1 from org_expenses r where r.reversal_of = e.id)
     and (e.booking_id = p_booking_id
          or e.job_id in (select j.id from jobs j
                           where j.org_id = v_org
                             and j.booking_id = p_booking_id));
  return v_sum;
end
$$;

comment on function booking_sub_hire_cost(uuid) is
  'Sum of every LIVE expense (0019 void-pair rule) tagged to the booking, or to the job the booking became — any kind (0024 D9). The cost side of margin-before-quote. owner/manager/desk.';

grant execute on function booking_sub_hire_cost(uuid) to papa_app;

-- ---------------------------------------------------------------------------
-- Rate card RPCs (D10, D11)
-- ---------------------------------------------------------------------------

/**
 * upsert_rate_card — create (p_id null) or edit (p_id given) a card.
 *
 * Null knobs mean "keep" on edit and "the default" on create. Setting
 * is_default clears the org's previous default; the first live card an
 * org creates is default whether or not the caller said so (D10).
 */
create or replace function upsert_rate_card(
  p_name              text,
  p_id                uuid default null,
  p_is_default        boolean default null,
  p_week_equals_days  numeric default null,
  p_min_billable_days integer default null,
  p_weekend_mask      integer[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_row  rate_cards%rowtype;
  v_make_default boolean;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager']);

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'a rate card needs a name'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_id is null then
    v_make_default := coalesce(p_is_default, false)
      or not exists (select 1 from rate_cards c
                      where c.org_id = v_org and c.is_default
                        and c.deleted_at is null);
    if v_make_default then
      update rate_cards c set is_default = false
       where c.org_id = v_org and c.is_default and c.deleted_at is null;
    end if;

    insert into rate_cards (org_id, name, is_default, week_equals_days,
                            min_billable_days, weekend_mask, created_by)
    values (v_org, trim(p_name), v_make_default,
            coalesce(p_week_equals_days, 3),
            coalesce(p_min_billable_days, 1),
            coalesce(p_weekend_mask, '{6,7}'),
            v_user)
    returning * into v_row;

    perform write_audit('rate_card_created', 'rate_card', v_row.id, v_row.name,
      jsonb_build_object('week_equals_days', v_row.week_equals_days,
                         'min_billable_days', v_row.min_billable_days,
                         'weekend_mask', v_row.weekend_mask,
                         'is_default', v_row.is_default));
  else
    select * into v_row from rate_cards c
     where c.id = p_id and c.org_id = v_org and c.deleted_at is null;
    if not found then
      raise exception 'rate card % does not belong to this org', p_id
        using errcode = 'foreign_key_violation';
    end if;

    if coalesce(p_is_default, false) and not v_row.is_default then
      update rate_cards c set is_default = false
       where c.org_id = v_org and c.is_default and c.deleted_at is null;
    end if;

    update rate_cards c
       set name              = trim(p_name),
           is_default        = coalesce(p_is_default, c.is_default),
           week_equals_days  = coalesce(p_week_equals_days, c.week_equals_days),
           min_billable_days = coalesce(p_min_billable_days, c.min_billable_days),
           weekend_mask      = coalesce(p_weekend_mask, c.weekend_mask)
     where c.id = p_id and c.org_id = v_org
    returning * into v_row;

    perform write_audit('rate_card_updated', 'rate_card', v_row.id, v_row.name,
      jsonb_build_object('week_equals_days', v_row.week_equals_days,
                         'min_billable_days', v_row.min_billable_days,
                         'weekend_mask', v_row.weekend_mask,
                         'is_default', v_row.is_default));
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'is_default', v_row.is_default,
    'week_equals_days', v_row.week_equals_days,
    'min_billable_days', v_row.min_billable_days,
    'weekend_mask', to_jsonb(v_row.weekend_mask));
end
$$;

comment on function upsert_rate_card(text, uuid, boolean, numeric, integer, integer[]) is
  'Create or edit a rate card (0024 D10/D11). owner|manager. Null knobs keep (edit) or default (create). One default per org, the first card is default automatically. Audited.';

grant execute on function upsert_rate_card(text, uuid, boolean, numeric, integer, integer[])
  to papa_app;

/**
 * upsert_rate_entry — set one product's day rate on one card.
 *
 * p_day_rate_minor null REMOVES the entry (the line goes back to
 * unpriced, never to zero — D5); 0 is a deliberate "included".
 */
create or replace function upsert_rate_entry(
  p_rate_card_id   uuid,
  p_product_id     uuid,
  p_day_rate_minor bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_card rate_cards%rowtype;
  v_row  rate_card_entries%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager']);

  select * into v_card from rate_cards c
   where c.id = p_rate_card_id and c.org_id = v_org and c.deleted_at is null;
  if not found then
    raise exception 'rate card % does not belong to this org', p_rate_card_id
      using errcode = 'foreign_key_violation';
  end if;

  if not exists (
    select 1 from products p
     where p.id = p_product_id and p.org_id = v_org and p.deleted_at is null
  ) then
    raise exception 'product % does not belong to this org', p_product_id
      using errcode = 'foreign_key_violation';
  end if;

  if p_day_rate_minor is null then
    update rate_card_entries e
       set deleted_at = now()
     where e.org_id = v_org and e.rate_card_id = p_rate_card_id
       and e.product_id = p_product_id and e.deleted_at is null
    returning * into v_row;

    perform write_audit('rate_entry_removed', 'rate_card', v_card.id, v_card.name,
      jsonb_build_object('product_id', p_product_id));

    return jsonb_build_object(
      'rate_card_id', p_rate_card_id,
      'product_id', p_product_id,
      'day_rate_minor', null,
      'removed', v_row.id is not null);
  end if;

  if p_day_rate_minor < 0 then
    raise exception 'a day rate cannot be negative'
      using errcode = 'check_violation';
  end if;

  insert into rate_card_entries (org_id, rate_card_id, product_id, day_rate_minor)
  values (v_org, p_rate_card_id, p_product_id, p_day_rate_minor)
  on conflict (rate_card_id, product_id) do update
    set day_rate_minor = excluded.day_rate_minor,
        deleted_at     = null
  returning * into v_row;

  perform write_audit('rate_entry_set', 'rate_card', v_card.id, v_card.name,
    jsonb_build_object('product_id', p_product_id,
                       'day_rate_minor', p_day_rate_minor));

  return jsonb_build_object(
    'rate_card_id', v_row.rate_card_id,
    'product_id', v_row.product_id,
    'day_rate_minor', v_row.day_rate_minor,
    'removed', false);
end
$$;

comment on function upsert_rate_entry(uuid, uuid, bigint) is
  'Set (or, with a null rate, remove) one product''s day rate on a card (0024 D5/D11). owner|manager. 0 is a price; absence is unpriced. Audited.';

grant execute on function upsert_rate_entry(uuid, uuid, bigint) to papa_app;

-- ---------------------------------------------------------------------------
-- Calendar RPCs (D6)
-- ---------------------------------------------------------------------------
create or replace function set_calendar_day(
  p_day             date,
  p_kind            text,
  p_name            text,
  p_rate_multiplier numeric default 1.0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_row  org_calendar_days%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager']);

  if p_day is null then
    raise exception 'a calendar day needs a date'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_kind is null or p_kind not in ('holiday', 'season') then
    raise exception 'calendar kind must be holiday or season, got %',
      coalesce(p_kind, '(null)')
      using errcode = 'invalid_parameter_value';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'a calendar day needs a name (Eid ul-Fitr, Wedding season)'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_rate_multiplier is null or p_rate_multiplier <= 0 or p_rate_multiplier > 10 then
    raise exception 'rate multiplier must be above 0 and at most 10, got %',
      coalesce(p_rate_multiplier::text, '(null)')
      using errcode = 'check_violation';
  end if;

  insert into org_calendar_days (org_id, day, kind, name, rate_multiplier)
  values (v_org, p_day, p_kind, trim(p_name), p_rate_multiplier)
  on conflict (org_id, day, kind) do update
    set name            = excluded.name,
        rate_multiplier = excluded.rate_multiplier,
        deleted_at      = null
  returning * into v_row;

  perform write_audit('calendar_day_set', 'org_calendar_day', v_row.id,
    v_row.name,
    jsonb_build_object('day', v_row.day, 'kind', v_row.kind,
                       'rate_multiplier', v_row.rate_multiplier));

  return jsonb_build_object(
    'id', v_row.id, 'day', v_row.day, 'kind', v_row.kind,
    'name', v_row.name, 'rate_multiplier', v_row.rate_multiplier);
end
$$;

comment on function set_calendar_day(date, text, text, numeric) is
  'Upsert one holiday/season day with its multiplier (0024 D6). owner|manager. Revives a cleared row. Audited.';

grant execute on function set_calendar_day(date, text, text, numeric) to papa_app;

create or replace function clear_calendar_day(
  p_day  date,
  p_kind text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_row  org_calendar_days%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager']);

  update org_calendar_days d
     set deleted_at = now()
   where d.org_id = v_org and d.day = p_day and d.kind = p_kind
     and d.deleted_at is null
  returning * into v_row;

  if v_row.id is null then
    return false;
  end if;

  perform write_audit('calendar_day_cleared', 'org_calendar_day', v_row.id,
    v_row.name, jsonb_build_object('day', v_row.day, 'kind', v_row.kind));
  return true;
end
$$;

comment on function clear_calendar_day(date, text) is
  'Soft-delete one calendar day (0024 D6). owner|manager. ensure_default_calendar never resurrects it. Returns whether a live row was cleared.';

grant execute on function clear_calendar_day(date, text) to papa_app;

/**
 * ensure_default_calendar — seed the Dec–Feb wedding season for one org,
 * lazily and idempotently.
 *
 * p_season_year names the December the season starts in; default is the
 * season around today (Jan/Feb belong to the season that started last
 * December). Multiplier 1.0 — shading only (ASSUMPTION #seasonal-pricing).
 * Returns the number of rows inserted (0 on every call after the first).
 */
create or replace function ensure_default_calendar(
  p_season_year integer default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_year integer;
  v_n    integer;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager', 'desk']);

  v_year := coalesce(
    p_season_year,
    case when extract(month from now()) <= 2
         then extract(year from now())::int - 1
         else extract(year from now())::int end);

  -- ASSUMPTION: Dec–Feb is the wedding season, seeded at 1.0 — shading,
  -- not a price change. See docs/assumptions.md#seasonal-pricing.
  insert into org_calendar_days (org_id, day, kind, name, rate_multiplier)
  select v_org, d::date, 'season', 'Wedding season', 1.0
    from generate_series(make_date(v_year, 12, 1),
                         make_date(v_year + 1, 3, 1) - 1,
                         interval '1 day') as d
  on conflict (org_id, day, kind) do nothing;
  get diagnostics v_n = row_count;

  if v_n > 0 then
    perform write_audit('calendar_seeded', 'org', v_org, null,
      jsonb_build_object('season_year', v_year, 'rows', v_n));
  end if;
  return v_n;
end
$$;

comment on function ensure_default_calendar(integer) is
  'Lazily seed Dec–Feb wedding-season rows at multiplier 1.0 for the calling org (0024 D6). Idempotent; never resurrects a cleared day. owner|manager|desk.';

grant execute on function ensure_default_calendar(integer) to papa_app;

-- ---------------------------------------------------------------------------
-- set_line_rate_override — the owner's last word (D8, overrides 17/18)
-- ---------------------------------------------------------------------------
create or replace function set_line_rate_override(
  p_line_id    uuid,
  p_rate_minor bigint,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_line booking_lines%rowtype;
  v_booking bookings%rowtype;
  v_product_id uuid;
  v_card_rate bigint;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager']);

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a rate override needs a reason'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_rate_minor is not null and p_rate_minor < 0 then
    raise exception 'an override rate cannot be negative'
      using errcode = 'check_violation';
  end if;

  select * into v_line from booking_lines l
   where l.id = p_line_id and l.org_id = v_org and l.deleted_at is null;
  if not found then
    raise exception 'booking line % does not belong to this org', p_line_id
      using errcode = 'foreign_key_violation';
  end if;

  select * into v_booking from bookings b
   where b.id = v_line.booking_id and b.org_id = v_org and b.deleted_at is null;
  if v_booking.status = 'cancelled' then
    raise exception 'booking #% is cancelled; nothing to price', v_booking.booking_no
      using errcode = 'check_violation';
  end if;

  -- original_rate_minor: what the default card said at this moment.
  v_product_id := coalesce(v_line.product_id,
                           (select a.product_id from assets a where a.id = v_line.asset_id));
  select e.day_rate_minor into v_card_rate
    from rate_card_entries e
    join rate_cards c on c.id = e.rate_card_id
   where c.org_id = v_org and c.is_default and c.deleted_at is null
     and e.product_id = v_product_id and e.deleted_at is null;

  if p_rate_minor is null then
    update booking_lines l
       set rate_minor = null, original_rate_minor = null,
           override_reason = null, overridden_by = null, overridden_at = null
     where l.id = v_line.id and l.org_id = v_org
    returning * into v_line;

    perform write_audit('line_rate_override_cleared', 'booking_line', v_line.id,
      '#' || v_booking.booking_no::text,
      jsonb_build_object('booking_id', v_booking.id, 'reason', trim(p_reason)));
  else
    update booking_lines l
       set rate_minor = p_rate_minor,
           original_rate_minor = v_card_rate,
           override_reason = trim(p_reason),
           overridden_by = v_user,
           overridden_at = now()
     where l.id = v_line.id and l.org_id = v_org
    returning * into v_line;

    perform write_audit('line_rate_override', 'booking_line', v_line.id,
      '#' || v_booking.booking_no::text,
      jsonb_build_object('booking_id', v_booking.id,
                         'rate_minor', p_rate_minor,
                         'original_rate_minor', v_card_rate,
                         'reason', trim(p_reason)));
  end if;

  return jsonb_build_object(
    'line_id', v_line.id,
    'booking_id', v_line.booking_id,
    'rate_minor', v_line.rate_minor,
    'original_rate_minor', v_line.original_rate_minor,
    'override_reason', v_line.override_reason,
    'overridden_by', v_line.overridden_by,
    'overridden_at', v_line.overridden_at);
end
$$;

comment on function set_line_rate_override(uuid, bigint, text) is
  'The logged manual price override (override 18, 0024 D8): owner|manager, reason required, original card rate recorded, audited. A null rate clears the override (reason still required). The override is the FINAL day rate — no multiplier on top.';

grant execute on function set_line_rate_override(uuid, bigint, text) to papa_app;

-- ---------------------------------------------------------------------------
-- price_booking — THE PIPELINE (D1–D9, D12)
-- ---------------------------------------------------------------------------
create or replace function price_booking(
  p_booking_id   uuid,
  p_rate_card_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_tz   text;
  v_currency text;
  v_booking bookings%rowtype;
  v_card    rate_cards%rowtype;
  v_has_card boolean := false;

  -- step 1
  v_start_date   date;
  v_calendar_days integer;
  v_dropped      jsonb;
  v_dropped_n    integer;
  v_counted      integer;
  v_min_days     integer;
  v_min_applied  boolean := false;
  -- step 2
  v_week_days    numeric;
  v_weeks        integer;
  v_remainder    integer;
  v_remainder_billed numeric;
  v_billable     numeric;
  -- step 4
  v_multiplier   numeric := 1.0;
  v_driver       jsonb := null;
  -- lines
  v_line         record;
  v_product_id   uuid;
  v_product_name text;
  v_asset_code   text;
  v_card_rate    bigint;
  v_effective    bigint;
  v_applied      boolean;
  v_total        bigint;
  v_lines        jsonb := '[]'::jsonb;
  v_priced_n     integer := 0;
  v_unpriced_n   integer := 0;
  v_card_priced_n   integer := 0;
  v_card_unpriced_n integer := 0;
  v_override_n   integer := 0;
  v_subtotal     bigint := 0;
  -- totals
  v_cost         bigint;
  v_reasons      text[] := '{}';
  v_totals       jsonb;
  v_steps        jsonb;
begin
  if v_org is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;
  perform require_role('owner', 'manager', 'desk');   -- D12

  select o.timezone, o.currency into v_tz, v_currency
    from orgs o where o.id = v_org;

  select * into v_booking from bookings b
   where b.id = p_booking_id and b.org_id = v_org and b.deleted_at is null;
  if not found then
    raise exception 'booking % does not belong to this org', p_booking_id
      using errcode = 'foreign_key_violation';
  end if;

  -- The card: the one asked for, else the org's default (D10).
  if p_rate_card_id is not null then
    select * into v_card from rate_cards c
     where c.id = p_rate_card_id and c.org_id = v_org and c.deleted_at is null;
    if not found then
      raise exception 'rate card % does not belong to this org', p_rate_card_id
        using errcode = 'foreign_key_violation';
    end if;
    v_has_card := true;
  else
    select * into v_card from rate_cards c
     where c.org_id = v_org and c.is_default and c.deleted_at is null;
    v_has_card := found;
  end if;

  -- Without a card the knobs fall back to their documented defaults so the
  -- day math still renders; every line is unpriced regardless.
  v_week_days := coalesce(v_card.week_equals_days, 3);
  v_min_days  := coalesce(v_card.min_billable_days, 1);

  -- ---- step 1: billable_days (D2, D3) ------------------------------------
  -- ASSUMPTION: a rental day is 24h from pickup, dated in the org timezone.
  -- See docs/assumptions.md#rental-day.
  v_start_date := (lower(v_booking.customer_period) at time zone v_tz)::date;
  v_calendar_days := greatest(1, ceil(
    extract(epoch from (upper(v_booking.customer_period)
                        - lower(v_booking.customer_period))) / 86400.0)::int);

  select coalesce(jsonb_agg(to_jsonb(d.day::text) order by d.day), '[]'::jsonb),
         count(*)::int
    into v_dropped, v_dropped_n
    from (select v_start_date + i as day
            from generate_series(0, v_calendar_days - 1) as i) d
   where v_has_card
     and extract(isodow from d.day)::int = any (v_card.weekend_mask);

  v_counted := v_calendar_days - v_dropped_n;
  if v_counted < v_min_days then
    v_counted := v_min_days;
    v_min_applied := true;
  end if;

  -- ---- step 2: week_rule (D4) --------------------------------------------
  v_weeks     := v_counted / 7;
  v_remainder := v_counted % 7;
  v_remainder_billed := least(v_remainder::numeric, v_week_days);
  v_billable  := v_weeks * v_week_days + v_remainder_billed;

  -- ---- step 4: calendar_multiplier (D7) — computed before the line loop
  -- because every line reads it; reported in step order below.
  select d.rate_multiplier,
         jsonb_build_object('day', d.day::text, 'kind', d.kind, 'name', d.name,
                            'rate_multiplier', d.rate_multiplier)
    into v_multiplier, v_driver
    from org_calendar_days d
   where d.org_id = v_org and d.deleted_at is null
     and d.day >= v_start_date
     and d.day <  v_start_date + v_calendar_days
   order by d.rate_multiplier desc, d.day, d.kind
   limit 1;
  v_multiplier := coalesce(v_multiplier, 1.0);

  -- ---- steps 3 and 5 per line: card_rates, overrides (D5, D8) ------------
  for v_line in
    select l.* from booking_lines l
     where l.org_id = v_org and l.booking_id = v_booking.id
       and l.deleted_at is null
     order by l.created_at, l.id
  loop
    if v_line.asset_id is not null then
      select a.product_id, a.asset_code into v_product_id, v_asset_code
        from assets a where a.id = v_line.asset_id;
    else
      v_product_id := v_line.product_id;
      v_asset_code := null;
    end if;
    select p.display_name into v_product_name
      from products p where p.id = v_product_id;

    v_card_rate := null;
    if v_has_card then
      select e.day_rate_minor into v_card_rate
        from rate_card_entries e
       where e.rate_card_id = v_card.id and e.product_id = v_product_id
         and e.deleted_at is null;
    end if;

    if v_card_rate is null then
      v_card_unpriced_n := v_card_unpriced_n + 1;
    else
      v_card_priced_n := v_card_priced_n + 1;
    end if;

    if v_line.rate_minor is not null then
      -- D8: the override is the final day rate; no multiplier on top.
      -- ASSUMPTION: see docs/assumptions.md#override-final.
      v_effective := v_line.rate_minor;
      v_applied   := false;
      v_override_n := v_override_n + 1;
    else
      v_effective := v_card_rate;
      v_applied   := v_card_rate is not null;
    end if;

    if v_effective is null then
      v_total := null;
      v_unpriced_n := v_unpriced_n + 1;
    else
      v_total := round(v_line.qty * v_billable * v_effective
                       * (case when v_applied then v_multiplier else 1 end))::bigint;
      v_priced_n := v_priced_n + 1;
      v_subtotal := v_subtotal + v_total;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'line_id', v_line.id,
      'product_id', v_product_id,
      'product_name', v_product_name,
      'asset_id', v_line.asset_id,
      'asset_code', v_asset_code,
      'qty', v_line.qty,
      'billable_days', v_billable,
      'card_rate_minor', v_card_rate,
      'override', case when v_line.rate_minor is null then null
                       else jsonb_build_object(
                         'rate_minor', v_line.rate_minor,
                         'original_rate_minor', v_line.original_rate_minor,
                         'reason', v_line.override_reason,
                         'by', v_line.overridden_by,
                         'at', v_line.overridden_at) end,
      'effective_rate_minor', v_effective,
      'multiplier', case when v_applied then v_multiplier else 1.0 end,
      'multiplier_applied', v_applied,
      'priced', v_effective is not null,
      'line_total_minor', v_total);
  end loop;

  -- ---- step 6: totals (D5, D9) -------------------------------------------
  v_cost := booking_sub_hire_cost(v_booking.id);

  if v_unpriced_n > 0 then v_reasons := array_append(v_reasons, 'unpriced_lines'); end if;
  if v_booking.status <> 'confirmed' then v_reasons := array_append(v_reasons, 'not_confirmed'); end if;
  if not v_has_card then v_reasons := array_append(v_reasons, 'no_rate_card'); end if;

  v_totals := jsonb_build_object(
    'subtotal_minor', v_subtotal,
    'priced_count', v_priced_n,
    'unpriced_count', v_unpriced_n,
    'overridden_count', v_override_n,
    'sub_hire_cost_minor', v_cost,
    'margin_minor', v_subtotal - v_cost,
    'indicative', (v_unpriced_n > 0 or v_booking.status <> 'confirmed'),
    'indicative_reasons', to_jsonb(v_reasons));

  v_steps := jsonb_build_array(
    jsonb_build_object(
      'step', 1, 'name', 'billable_days',
      'period_from', lower(v_booking.customer_period),
      'period_until', upper(v_booking.customer_period),
      'timezone', v_tz,
      'first_day', v_start_date::text,
      'calendar_days', v_calendar_days,
      'weekend_mask', case when v_has_card then to_jsonb(v_card.weekend_mask)
                           else '[]'::jsonb end,
      'weekend_days_dropped', v_dropped_n,
      'dropped_dates', v_dropped,
      'min_billable_days', v_min_days,
      'min_applied', v_min_applied,
      'counted_days', v_counted),
    jsonb_build_object(
      'step', 2, 'name', 'week_rule',
      'week_equals_days', v_week_days,
      'weeks', v_weeks,
      'remainder_days', v_remainder,
      'remainder_billed', v_remainder_billed,
      'billable_days', v_billable),
    jsonb_build_object(
      'step', 3, 'name', 'card_rates',
      'rate_card_id', v_card.id,
      'priced_lines', v_card_priced_n,
      'unpriced_lines', v_card_unpriced_n),
    jsonb_build_object(
      'step', 4, 'name', 'calendar_multiplier',
      'multiplier', v_multiplier,
      'driven_by', v_driver),
    jsonb_build_object(
      'step', 5, 'name', 'overrides',
      'overridden_lines', v_override_n),
    jsonb_build_object('step', 6, 'name', 'totals') || v_totals);

  return jsonb_build_object(
    'booking_id', v_booking.id,
    'booking_no', v_booking.booking_no,
    'status', v_booking.status,
    'currency', coalesce(v_currency, 'PKR'),
    'customer_period', jsonb_build_object(
      'from', lower(v_booking.customer_period),
      'until', upper(v_booking.customer_period)),
    'rate_card', case when v_has_card then jsonb_build_object(
      'id', v_card.id, 'name', v_card.name, 'is_default', v_card.is_default,
      'week_equals_days', v_card.week_equals_days,
      'min_billable_days', v_card.min_billable_days,
      'weekend_mask', to_jsonb(v_card.weekend_mask)) else null end,
    'steps', v_steps,
    'lines', v_lines,
    'totals', v_totals);
end
$$;

comment on function price_booking(uuid, uuid) is
  'THE pricing pipeline (0024 D1): six named steps in fixed order — billable_days, week_rule, card_rates, calendar_multiplier, overrides, totals — returned as a jsonb trace plus per-line breakdown. Unpriced lines are counted, never zero (D5); an override is the final day rate (D8); margin = subtotal − booking_sub_hire_cost (D9). STABLE read; owner|manager|desk (D12).';

grant execute on function price_booking(uuid, uuid) to papa_app;

-- ---------------------------------------------------------------------------
-- Grants — every function is born with PUBLIC execute (the 0015 M1 lesson):
-- revoke first, then the explicit door list above stands.
-- ---------------------------------------------------------------------------
revoke all on function rate_card_entries_check_org()                                  from public;
revoke all on function validate_expense()                                             from public;
revoke all on function record_expense(text, bigint, uuid, uuid, text, text, timestamptz, uuid) from public;
revoke all on function reverse_expense(uuid, text)                                    from public;
revoke all on function booking_sub_hire_cost(uuid)                                    from public;
revoke all on function upsert_rate_card(text, uuid, boolean, numeric, integer, integer[]) from public;
revoke all on function upsert_rate_entry(uuid, uuid, bigint)                          from public;
revoke all on function set_calendar_day(date, text, text, numeric)                    from public;
revoke all on function clear_calendar_day(date, text)                                 from public;
revoke all on function ensure_default_calendar(integer)                               from public;
revoke all on function set_line_rate_override(uuid, bigint, text)                     from public;
revoke all on function price_booking(uuid, uuid)                                      from public;

grant execute on function
  record_expense(text, bigint, uuid, uuid, text, text, timestamptz, uuid),
  reverse_expense(uuid, text),
  booking_sub_hire_cost(uuid),
  upsert_rate_card(text, uuid, boolean, numeric, integer, integer[]),
  upsert_rate_entry(uuid, uuid, bigint),
  set_calendar_day(date, text, text, numeric),
  clear_calendar_day(date, text),
  ensure_default_calendar(integer),
  set_line_rate_override(uuid, bigint, text),
  price_booking(uuid, uuid)
  to papa_app;
