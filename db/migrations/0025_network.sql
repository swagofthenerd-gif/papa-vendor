-- ============================================================================
-- 0025 — The network: partner houses, sub-hire in and out, crew on the job,
--        and the two small reads the quote and theft screens lacked
--
-- Phase E of docs/vendor-dream-plan.md (E1 partner network, E2 stolen
-- broadcast, E5 verified-client fast lane). Until now the schema knows the
-- house's own fleet, its own clients and its own money. It does not know
-- the OTHER houses — the ones it borrows a second FX9 from on a shaadi
-- weekend, or lends a Komodo to on a quiet Tuesday — and it cannot say who
-- went out with the truck. This migration gives the house its network.
--
-- WHAT THIS MIGRATION DECIDES, and why:
--
--   D1  A PARTNER HOUSE IS A TABLE, NOT A FREE-TEXT COUNTERPARTY. 0019 D5
--       deliberately kept `counterparty` as text ("a name on a receipt, not
--       an entity this schema needs to own yet"). Sub-hire makes it an
--       entity: the same partner appears on the expense book, the customer
--       ledger, the job board and the stolen-gear broadcast list, and four
--       spellings of "Kamran Rentals" is four partners. partner_houses is
--       org-scoped, unique per (org, lower(name)), and its `phone` is PII:
--       the table has NO change_seq, so it never syncs, and the 0009/0015
--       '%phone%' pattern is what would fail the build if it ever did
--       (proven in the test by probing). SELECT is role-gated to
--       owner/manager/desk like the money book — a partner's number is not
--       a warehouse phone's business.
--
--   D2  ONE sub_hires TABLE, TWO DIRECTIONS, THE MONEY ON THE BOOK IT
--       BELONGS TO. direction='in' is gear BORROWED (the house pays: an
--       org_expenses row of kind 'sub_hire', counterparty = the partner's
--       name, created in the same transaction through record_expense — the
--       one door, so job_margin (0019) and booking_sub_hire_cost (0024)
--       see it with no new code). direction='out' is gear LENT (the house
--       is paid: a customer_ledger_entries 'charge' on a customer row that
--       IS the partner — D3). The two money links are mutually exclusive
--       by CHECK: an in-hire never carries a ledger entry, an out-hire
--       never carries an expense. Every write goes through the RPCs; the
--       table is papa_app SELECT-only, gated to owner/manager/desk (the
--       agreed amounts are commercial).
--
--   D3  A PARTNER THAT BORROWS IS A CUSTOMER. The customer ledger is the
--       only udhaar book (0017 D1); inventing a partner ledger would be a
--       second money path to secure and a second balance to drift.
--       ensure_partner_customer() finds the org's live customer with the
--       same name (case-insensitive) or creates one, and flags it
--       customers.is_partner = true either way. The partner's balance is
--       then customer_balances like anyone's. ASSUMPTION #partner-is-
--       customer: same-name matching is the honest default; a house that
--       already keeps "Kamran Rentals" as a client gets one row, not two.
--
--   D4  LENDING OUT RIDES THE SCAN WORLD — NO PARALLEL PRESENCE.
--       record_sub_hire_out creates a JOB row through the ordinary jobs
--       machinery, labelled 'Sub-hire → <partner>', customer = the partner
--       customer (D3), expected_back from the period; the desk then scans
--       the unit out onto that job exactly as it would for a client. The
--       sub_hire row links the job and the ledger line and nothing else.
--       presence='out' + current_job_id = the sub-hire job IS "lent to
--       Kamran"; there is no second flag to disagree with it. close_sub_
--       hire(out) refuses while any asset still projects onto the job
--       (the 0018 D3 close rule, the same predicate) and closes the job
--       otherwise.
--
--   D5  BORROWING IN IS AN assets ROW WITH ownership='sub_rented_in' — the
--       0002 vocabulary, finally written by something. When a serial is
--       given, record_sub_hire_in creates the unit (asset_code generated,
--       serial recorded, ownership sub_rented_in) and mints an `intake`
--       scan event on the org's synthetic server device (the 0020 D5
--       treatment) so the log says it arrived. From then on it tags, scans
--       and counts like any unit, and booking_availability sees it in the
--       live fleet — that is the shortage math the brief asks for. When
--       it goes home, close_sub_hire(in) mints a `retire` event and the
--       reducer (fifth edition below) stamps disposition
--       'returned_to_owner' — a new value in the 0020 CHECK, chosen over
--       'retired' because "we scrapped it" and "we gave it back" must
--       never read the same on the Gone filter. No new event verb: the
--       rule is "retiring a borrowed unit means it went home", derived
--       from ownership, which the reducer already has in hand. A phone
--       that submits `retire` for a borrowed unit gets the same truth.
--       (The client mirror's dispositionFor must learn this one case —
--       flagged for the client wave.)
--
--   D6  MONEY HONESTY ON THE AGREED AMOUNTS. agreed_cost_minor (in) and
--       agreed_charge_minor (out) are NULLABLE: a partner who says "settle
--       it at month end" has lent you a lens with no number on it, and a
--       zero-rupee expense would be a lie 0019 refuses anyway. A null
--       amount writes NO money row (expense_id / ledger_entry_id stay
--       null) and the sub_hire row is the counted, unpriced fact — the
--       same rule as an unpriced quote line (0024 D5). ASSUMPTION
--       #sub-hire-unpriced.
--
--   D7  CREW ON THE JOB. job_attendants (job, user, role attendant|driver)
--       records who went out with the gear. ASSUMPTION #attendant-custom:
--       crew-out with the kit is a high-end custom nobody has verified for
--       a Lahore house; the table is cheap and the RPCs are two. The user
--       must be an ACTIVE MEMBER of the org (trigger-checked). Not
--       syncable itself — the attendant NAMES ride the jobs projection
--       (D8), and assign/unassign touch the job row so its change_seq
--       bumps and the phone learns the change.
--
--   D8  pull_changes, EIGHTH EDITION: 0023's seventh verbatim plus ONE
--       column on jobs — attendant_names text[] (display names, in
--       assignment order, [] when none). A display name is not in
--       sync_sensitive_columns (verified: cnic%, ntn%, %phone%, contact%,
--       credit_limit%, guarantor%, and the 0009 literals — the 0023 D1
--       reasoning for customer_name applies verbatim) and the guard test
--       proves the projection stays clean. The client wave reads it for
--       the job card's crew line — schema and consumer land together,
--       the 0018 D5 discipline.
--
--   D9  THE STOLEN BROADCAST IS A READ, NOT A TABLE. The theft report is
--       built on the client (Phase E2); what the client LACKS is the
--       public tag URL base and the org's contact line, both org
--       settings. stolen_broadcast_text(asset) is INVOKER, refuses unless
--       the unit is actually marked stolen (0020 D2b made that an
--       owner/manager act), and returns the facts plus a short
--       Roman-Urdu + English line the desk can paste into the partner
--       WhatsApp group. ASSUMPTION #public-tag-url: orgs.settings
--       .public_tag_url_base is the page base; unset means no link.
--
--   D10 THE FAST-LANE FLAGS ARE ONE jsonb, DERIVED FROM 0017's VIEW.
--       customer_quote_flags(customer) reads verified_customers — never a
--       hand-set flag — and adds deposit_hint: refuse (blacklisted) |
--       lighter (fast lane) | standard (verified) | full (stranger).
--       ASSUMPTION #deposit-hint: the ladder is a guess at what a lighter
--       deposit means; the vendor prices it. security_invoker all the way
--       down: a non-money role reads verified=false, the stricter side.
--
-- Everything here is idempotent: IF NOT EXISTS / OR REPLACE / drop-and-
-- recreate pairs, the 0015–0024 discipline. 0001–0024 stay untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- customers.is_partner — the partner-as-customer flag (D3)
-- ---------------------------------------------------------------------------
alter table customers add column if not exists is_partner boolean not null default false;

comment on column customers.is_partner is
  'True when this customer row IS a partner house that borrows from us (0025 D3): set by ensure_partner_customer, never a reason to keep a second ledger.';

create index if not exists customers_org_partner_idx
  on customers (org_id, is_partner) where is_partner and deleted_at is null;

-- ---------------------------------------------------------------------------
-- partner_houses — the network (D1)
-- ---------------------------------------------------------------------------
create table if not exists partner_houses (
  id                  uuid primary key default uuid_generate_v7(),
  org_id              uuid not null references orgs(id) on delete restrict,

  name                text not null,
  -- PII. This table never syncs (no change_seq); the '%phone%' guard
  -- pattern would fail the build the day it did.
  phone               text,
  whatsapp_group_note text,
  city                text not null default 'Lahore',
  notes               text,

  created_by          uuid references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,

  constraint partner_houses_name_nonempty check (length(trim(name)) > 0)
);

create unique index if not exists partner_houses_org_name_live_idx
  on partner_houses (org_id, lower(name)) where deleted_at is null;
create index if not exists partner_houses_org_live_idx
  on partner_houses (org_id, name) where deleted_at is null;

comment on table partner_houses is
  'The other rental houses this org borrows from and lends to (0025 D1). phone is PII: never syncable, SELECT gated to owner/manager/desk. Writes only through upsert_partner_house / remove_partner_house.';

drop trigger if exists partner_houses_updated_at on partner_houses;
create trigger partner_houses_updated_at
  before update on partner_houses for each row execute function set_updated_at();

alter table partner_houses enable row level security;
alter table partner_houses force row level security;

drop policy if exists partner_houses_select on partner_houses;
create policy partner_houses_select on partner_houses
  for select using (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );
-- Write policies exist for the DEFINER path when the function owner is not a
-- superuser; papa_app has no INSERT/UPDATE grant, so these are unreachable
-- from a client either way (the 0017 deposits shape).
drop policy if exists partner_houses_insert on partner_houses;
create policy partner_houses_insert on partner_houses
  for insert with check (org_id = (select current_org_id()));
drop policy if exists partner_houses_update on partner_houses;
create policy partner_houses_update on partner_houses
  for update using (org_id = (select current_org_id()))
  with check (org_id = (select current_org_id()));

grant select on partner_houses to papa_app;   -- deliberately no insert/update/delete

-- ---------------------------------------------------------------------------
-- sub_hires — gear borrowed in, gear lent out (D2, D6)
-- ---------------------------------------------------------------------------
create table if not exists sub_hires (
  id                  uuid primary key default uuid_generate_v7(),
  org_id              uuid not null references orgs(id) on delete restrict,

  direction           text not null,
  partner_house_id    uuid not null references partner_houses(id) on delete restrict,

  -- What it was for. An in-hire rescues a booking or a job; an out-hire
  -- IS a job (D4) — job_id is the sub-hire job record_sub_hire_out made.
  booking_id          uuid references bookings(id) on delete restrict,
  job_id              uuid references jobs(id) on delete restrict,

  product_id          uuid not null references products(id) on delete restrict,
  qty                 int  not null default 1,
  -- in: the unit created with ownership='sub_rented_in' (D5), when a
  -- serial was given. out: the specific unit lent, when one was named.
  asset_id            uuid references assets(id) on delete restrict,

  period              tstzrange not null,

  -- D6: nullable on purpose — unpriced is counted, never zeroed.
  agreed_cost_minor   bigint,     -- direction = 'in'  (what the house pays)
  agreed_charge_minor bigint,     -- direction = 'out' (what the house is paid)

  -- D2: the money row on the book it belongs to, created atomically.
  expense_id          uuid references org_expenses(id) on delete restrict,
  ledger_entry_id     uuid references customer_ledger_entries(id) on delete restrict,

  returned_at         timestamptz,
  note                text,

  created_by          uuid not null references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint sub_hires_direction_check check (direction in ('in', 'out')),
  constraint sub_hires_qty_positive check (qty > 0),
  constraint sub_hires_period_nonempty check (not isempty(period)),
  -- A named unit is one unit.
  constraint sub_hires_asset_is_one check (asset_id is null or qty = 1),
  -- D6: an agreed amount is positive or absent — never zero.
  constraint sub_hires_amounts_positive check (
    (agreed_cost_minor is null or agreed_cost_minor > 0)
    and (agreed_charge_minor is null or agreed_charge_minor > 0)
  ),
  -- D2: the money side matches the direction, exactly.
  constraint sub_hires_money_side check (
    (direction = 'in'  and agreed_charge_minor is null and ledger_entry_id is null)
    or
    (direction = 'out' and agreed_cost_minor is null and expense_id is null)
  ),
  constraint sub_hires_returned_after_start
    check (returned_at is null or returned_at >= lower(period))
);

create index if not exists sub_hires_org_partner_idx
  on sub_hires (org_id, partner_house_id);
create index if not exists sub_hires_org_open_idx
  on sub_hires (org_id, lower(period)) where returned_at is null;
create index if not exists sub_hires_org_job_idx
  on sub_hires (org_id, job_id) where job_id is not null;
create index if not exists sub_hires_org_booking_idx
  on sub_hires (org_id, booking_id) where booking_id is not null;
create index if not exists sub_hires_org_asset_idx
  on sub_hires (org_id, asset_id) where asset_id is not null;

comment on table sub_hires is
  'Gear borrowed from (in) or lent to (out) a partner house (0025 D2). in → an org_expenses row through record_expense; out → a sub-hire JOB the desk scans against (D4) and a ledger charge on the partner-customer (D3). Amounts nullable: unpriced is counted, never zeroed (D6). Writes only through record_sub_hire_in / record_sub_hire_out / close_sub_hire.';
comment on column sub_hires.returned_at is
  'When the borrowed unit went home (in) or the lent gear came back (out). Set by close_sub_hire; null = open.';

drop trigger if exists sub_hires_updated_at on sub_hires;
create trigger sub_hires_updated_at
  before update on sub_hires for each row execute function set_updated_at();

-- Tenancy backstop, the 0015 M4 shape: FKs prove existence, this proves
-- ownership, for every insert path. DEFINER so it can see the foreign row
-- in order to refuse it.
create or replace function sub_hires_check_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from partner_houses p
     where p.id = new.partner_house_id and p.org_id = new.org_id and p.deleted_at is null
  ) then
    raise exception 'partner house % does not belong to this org', new.partner_house_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.booking_id is not null and not exists (
    select 1 from bookings b where b.id = new.booking_id and b.org_id = new.org_id
  ) then
    raise exception 'booking % does not belong to this org', new.booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.job_id is not null and not exists (
    select 1 from jobs j where j.id = new.job_id and j.org_id = new.org_id
  ) then
    raise exception 'job % does not belong to this org', new.job_id
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1 from products p where p.id = new.product_id and p.org_id = new.org_id
  ) then
    raise exception 'product % does not belong to this org', new.product_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.asset_id is not null and not exists (
    select 1 from assets a where a.id = new.asset_id and a.org_id = new.org_id
  ) then
    raise exception 'asset % does not belong to this org', new.asset_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.expense_id is not null and not exists (
    select 1 from org_expenses e where e.id = new.expense_id and e.org_id = new.org_id
  ) then
    raise exception 'expense % does not belong to this org', new.expense_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.ledger_entry_id is not null and not exists (
    select 1 from customer_ledger_entries l
     where l.id = new.ledger_entry_id and l.org_id = new.org_id
  ) then
    raise exception 'ledger entry % does not belong to this org', new.ledger_entry_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

drop trigger if exists sub_hires_tenancy on sub_hires;
create trigger sub_hires_tenancy
  before insert or update on sub_hires
  for each row execute function sub_hires_check_org();

alter table sub_hires enable row level security;
alter table sub_hires force row level security;

drop policy if exists sub_hires_select on sub_hires;
create policy sub_hires_select on sub_hires
  for select using (
    org_id = (select current_org_id())
    and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
  );
drop policy if exists sub_hires_insert on sub_hires;
create policy sub_hires_insert on sub_hires
  for insert with check (org_id = (select current_org_id()));
drop policy if exists sub_hires_update on sub_hires;
create policy sub_hires_update on sub_hires
  for update using (org_id = (select current_org_id()))
  with check (org_id = (select current_org_id()));

grant select on sub_hires to papa_app;   -- no insert/update/delete: RPCs only

-- ---------------------------------------------------------------------------
-- job_attendants — who went out with the gear (D7)
-- ---------------------------------------------------------------------------
create table if not exists job_attendants (
  id          uuid primary key default uuid_generate_v7(),
  org_id      uuid not null references orgs(id) on delete restrict,
  job_id      uuid not null references jobs(id) on delete restrict,
  user_id     uuid not null references users(id) on delete restrict,

  -- ASSUMPTION: two roles cover crew-out. See docs/assumptions.md#attendant-custom
  role        text not null default 'attendant',

  created_by  uuid references users(id) on delete restrict,
  created_at  timestamptz not null default now(),

  constraint job_attendants_role_check check (role in ('attendant', 'driver'))
);

create unique index if not exists job_attendants_org_job_user_idx
  on job_attendants (org_id, job_id, user_id);
create index if not exists job_attendants_org_user_idx
  on job_attendants (org_id, user_id);

comment on table job_attendants is
  'Crew assigned to a job (0025 D7): attendant | driver. The user must be an active member of the org. Not syncable — the names ride the jobs projection (attendant_names, D8). Writes only through assign_attendant / unassign_attendant.';

-- The job must be ours and the person must be one of us — the member check
-- is what keeps a stale user id from another org off a job card.
create or replace function job_attendants_check_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from jobs j where j.id = new.job_id and j.org_id = new.org_id
  ) then
    raise exception 'job % does not belong to this org', new.job_id
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1 from memberships m
     where m.org_id = new.org_id and m.user_id = new.user_id
       and m.status = 'active' and m.deleted_at is null
  ) then
    raise exception 'user % is not an active member of this org', new.user_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

drop trigger if exists job_attendants_tenancy on job_attendants;
create trigger job_attendants_tenancy
  before insert or update on job_attendants
  for each row execute function job_attendants_check_org();

alter table job_attendants enable row level security;
alter table job_attendants force row level security;

-- Every member may read who is on a job — the board shows the crew line.
drop policy if exists job_attendants_select on job_attendants;
create policy job_attendants_select on job_attendants
  for select using (org_id = (select current_org_id()));
drop policy if exists job_attendants_insert on job_attendants;
create policy job_attendants_insert on job_attendants
  for insert with check (org_id = (select current_org_id()));
drop policy if exists job_attendants_update on job_attendants;
create policy job_attendants_update on job_attendants
  for update using (org_id = (select current_org_id()))
  with check (org_id = (select current_org_id()));
drop policy if exists job_attendants_delete on job_attendants;
create policy job_attendants_delete on job_attendants
  for delete using (org_id = (select current_org_id()));

grant select on job_attendants to papa_app;   -- no insert/update/delete: RPCs only

-- ---------------------------------------------------------------------------
-- assets.disposition learns 'returned_to_owner' (D5)
-- ---------------------------------------------------------------------------
alter table assets drop constraint if exists assets_disposition_check;
alter table assets add constraint assets_disposition_check
  check (disposition is null
         or disposition in ('lost', 'stolen', 'sold', 'retired', 'returned_to_owner'));

comment on column assets.disposition is
  'Why the item left the fleet (0020 D1, +returned_to_owner in 0025 D5): lost | stolen | sold | retired | returned_to_owner, null while it is fleet. A projection driven by mark_lost / mark_stolen / mark_sold / retire scan events; retire on a sub_rented_in unit stamps returned_to_owner; found clears it. Non-null implies presence=''gone''.';

-- ---------------------------------------------------------------------------
-- The reducer, fifth edition (D5): 0021's fourth verbatim plus one case —
-- `retire` on a borrowed unit (ownership = 'sub_rented_in') stamps
-- 'returned_to_owner' instead of 'retired'. Nothing else moves.
-- ---------------------------------------------------------------------------
create or replace function apply_scan_event(p_event scan_events)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a assets%rowtype;
  is_newer boolean;
  v_out          timestamptz;   -- the pair's check_out (D1)
  v_days         int := 0;      -- rental days this check_in adds
  v_count_cycles boolean := false;
  v_retire_after int;
begin
  if p_event.asset_id is null then
    return;   -- unresolved tag: recorded, but there is nothing to project onto
  end if;

  select * into a from assets where id = p_event.asset_id for update;
  if not found then
    return;
  end if;

  -- Corrections do not project directly; the corrected timeline is replayed.
  if p_event.corrects_event_id is not null then
    perform rebuild_asset_projection(p_event.asset_id);
    return;
  end if;

  is_newer := a.last_applied_at is null
    or (p_event.effective_time, p_event.server_seq) > (a.last_applied_at, a.last_applied_seq);

  if not is_newer then
    -- A late arrival from a device that was offline. It belongs in history,
    -- but it must NOT overwrite newer truth. Silently discarding it is the bug
    -- that loses a camera; surfacing it is the feature.
    insert into alerts (org_id, kind, severity, owner_role, asset_id, event_id, title, detail)
    values (
      p_event.org_id, 'late_event', 'warn', 'manager', p_event.asset_id, p_event.id,
      'A late scan arrived out of order',
      format('%s recorded at %s arrived after newer activity and was not applied to current state.',
             p_event.event_type, p_event.effective_time)
    );
    return;
  end if;

  -- 0021 D1: the service meter. The pair is this asset's latest check_out
  -- on the SAME job with no check_in between it and this one — a rescan
  -- echo finds no unconsumed check_out and adds nothing; a loose check_in
  -- (no job, or nothing ever went out on it) adds nothing.
  if p_event.event_type = 'check_in' and p_event.job_id is not null then
    select max(e.effective_time) into v_out
      from scan_events e
     where e.org_id = p_event.org_id
       and e.asset_id = p_event.asset_id
       and e.event_type = 'check_out'
       and e.job_id = p_event.job_id
       and (e.effective_time, e.server_seq) < (p_event.effective_time, p_event.server_seq)
       and not exists (
         select 1 from scan_events i
          where i.org_id = e.org_id
            and i.asset_id = e.asset_id
            and i.event_type = 'check_in'
            and i.job_id = e.job_id
            and (i.effective_time, i.server_seq) > (e.effective_time, e.server_seq)
            and (i.effective_time, i.server_seq) < (p_event.effective_time, p_event.server_seq)
       );
    if v_out is not null then
      -- Calendar days touched, partial day = full day, same-day = 1 (D1).
      v_days := (p_event.effective_time::date - v_out::date) + 1;
    end if;
  end if;

  -- 0021 D3: cycles are per-product opt-in — the battery flag.
  if p_event.event_type = 'check_out' then
    select coalesce(p.count_cycles, false), p.retire_after_cycles
      into v_count_cycles, v_retire_after
      from products p where p.id = a.product_id;
  end if;

  update assets set
    presence = case p_event.event_type
      when 'check_out'   then 'out'
      when 'check_in'    then 'here'
      when 'move'        then case when p_event.to_location_id is not null
                                     and exists (select 1 from locations l
                                                 where l.id = p_event.to_location_id
                                                   and l.kind = 'vehicle')
                                   then 'in_transit' else 'here' end
      when 'lost'        then 'gone'
      when 'retire'      then 'gone'
      when 'mark_lost'   then 'gone'
      when 'mark_stolen' then 'gone'
      when 'mark_sold'   then 'gone'
      when 'found'       then 'here'
      when 'intake'      then 'here'
      else presence
    end,
    -- D1 (0020): the WHY beside the WHERE. Ordered so the disposition can
    -- never outlive being gone: the same event that sets it sets presence,
    -- and `found` clears both in one update.
    -- 0025 D5: retiring a BORROWED unit means it went home to its owner —
    -- derived from ownership, which `a` (the pre-update row) already holds.
    disposition = case p_event.event_type
      when 'mark_lost'   then 'lost'
      when 'mark_stolen' then 'stolen'
      when 'mark_sold'   then 'sold'
      when 'retire'      then case when a.ownership = 'sub_rented_in'
                                   then 'returned_to_owner' else 'retired' end
      when 'found'       then null
      else disposition
    end,
    health = case p_event.event_type
      when 'send_to_service'     then 'servicing'
      when 'return_from_service' then 'ok'
      when 'quarantine'          then 'quarantined'
      when 'release'             then 'ok'
      when 'flag_damage'         then coalesce(p_event.health, 'quarantined')
      else coalesce(p_event.health, health)
    end,
    -- 0021 D1/D2: the service meter — a rental's days in, a serviced
    -- event back to zero. D3: the cycle count, flagged products only, and
    -- deliberately NOT reset by serviced: cycles are the unit's life.
    rental_days_since_service = case p_event.event_type
      when 'serviced' then 0
      else rental_days_since_service + v_days
    end,
    cycle_count = cycle_count + case when v_count_cycles then 1 else 0 end,
    current_location_id = coalesce(p_event.to_location_id, current_location_id),
    current_parent_id = case p_event.event_type
      when 'pack'   then p_event.parent_asset_id
      when 'unpack' then null
      else current_parent_id
    end,
    current_job_id = case p_event.event_type
      when 'check_out' then p_event.job_id
      when 'check_in'  then null
      -- D2 (0020): terminal gear projects onto no job.
      when 'mark_lost'   then null
      when 'mark_stolen' then null
      when 'mark_sold'   then null
      else current_job_id
    end,
    last_scanned_at  = p_event.effective_time,
    last_applied_at  = p_event.effective_time,
    last_applied_seq = p_event.server_seq,
    updated_at       = now()
  where id = p_event.asset_id;

  -- 0021 D3: crossing the ceiling raises an ALERT — never a state change.
  -- Deduped while one is open, which also keeps a projection rebuild from
  -- stacking duplicates. `a` still holds the pre-update row, so the
  -- crossing test is old-below/new-at-or-above, and a unit already over
  -- the ceiling does not re-alert on every later checkout.
  if v_count_cycles and v_retire_after is not null
     and a.cycle_count < v_retire_after
     and a.cycle_count + 1 >= v_retire_after
     and not exists (
       select 1 from alerts al
        where al.org_id = p_event.org_id
          and al.asset_id = p_event.asset_id
          and al.kind = 'cycle_threshold'
          and al.resolved_at is null
     )
  then
    insert into alerts (org_id, kind, severity, owner_role, asset_id, event_id, title, detail)
    values (
      p_event.org_id, 'cycle_threshold', 'warn', 'manager',
      p_event.asset_id, p_event.id,
      format('%s crossed its cycle ceiling', coalesce(a.asset_code, 'A flagged unit')),
      format('%s cycles recorded; the product''s ceiling is %s. Nothing was changed — inspect it and decide.',
             a.cycle_count + 1, v_retire_after)
    );
  end if;
end
$$;

-- 0015's revoke, restated for the recreated reducer (house style).
revoke execute on function apply_scan_event(scan_events) from public, papa_app;

-- ---------------------------------------------------------------------------
-- Internals (never granted)
-- ---------------------------------------------------------------------------

/**
 * network_write_context — the 0017 money_write_context shape with the
 * network's own bucket: partner edits, sub-hire records and crew changes
 * share one 60/min budget per person. The MONEY rows a sub-hire writes go
 * through record_expense / record_ledger_entry, which charge the money
 * bucket themselves.
 */
create or replace function network_write_context(
  p_roles text[],
  out o_org  uuid,
  out o_user uuid
)
language plpgsql
set search_path = public
as $$
begin
  o_org  := current_org_id();
  o_user := current_user_id();
  if o_org is null or o_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  perform require_role(variadic p_roles);

  if not rate_limit_check('network:' || o_org::text || ':' || o_user::text,
                          60, '1 minute') then
    raise exception 'too many network writes; wait a moment'
      using errcode = 'too_many_connections';
  end if;
end
$$;

/**
 * ensure_server_device — the org's synthetic device for server-minted scan
 * events (0020 D5: never borrow a real phone's identity, or a server
 * client_seq collides with that phone's own outbox numbering later).
 * Returns the device id. swap_asset inlines the same upsert; this is the
 * shared home for every new server-side minter.
 */
create or replace function ensure_server_device(p_org uuid, p_user uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_device text := 'server:' || p_org::text;
begin
  insert into devices (id, org_id, label, last_user_id, last_seen_at)
  values (v_device, p_org, 'server (RPC-minted events)', p_user, now())
  on conflict (id) do update
    set last_seen_at = excluded.last_seen_at, last_user_id = excluded.last_user_id
  where devices.org_id = p_org;
  return v_device;
end
$$;

/**
 * ensure_partner_customer — the partner's row on the udhaar book (D3).
 *
 * Finds the org's live customer whose name matches the partner's
 * (case-insensitive) or creates one; flags is_partner = true either way.
 * ASSUMPTION: same-name matching. See docs/assumptions.md#partner-is-customer
 */
create or replace function ensure_partner_customer(p_org uuid, p_user uuid, p_partner partner_houses)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  select c.id into v_id
    from customers c
   where c.org_id = p_org
     and lower(c.name) = lower(p_partner.name)
     and c.deleted_at is null
   order by c.is_partner desc, c.created_at
   limit 1;

  if v_id is null then
    insert into customers (org_id, name, phone, is_partner, tier, notes, created_by)
    values (p_org, p_partner.name, p_partner.phone, true, 'regular',
            'Partner house (sub-hire)', p_user)
    returning id into v_id;
  else
    update customers set is_partner = true
     where id = v_id and org_id = p_org and not is_partner;
  end if;

  return v_id;
end
$$;

/**
 * mint_server_event — one server-minted scan event on the org's synthetic
 * device, entry_method='manual' (a desk decision, not a camera decode).
 * Returns the event id. The BEFORE trigger clamps time and checks tenancy;
 * the AFTER trigger projects.
 */
create or replace function mint_server_event(
  p_org        uuid,
  p_user       uuid,
  p_asset_id   uuid,
  p_event_type text,
  p_job_id     uuid,
  p_note       text,
  p_payload    jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id     uuid := uuid_generate_v7();
  v_device text := ensure_server_device(p_org, p_user);
  v_now    timestamptz := now();
begin
  insert into scan_events (
    id, org_id, asset_id, event_type, entry_method, job_id,
    note, actor_user_id, device_id, client_seq,
    device_time, clock_offset_ms, effective_time, payload
  ) values (
    v_id, p_org, p_asset_id, p_event_type, 'manual', p_job_id,
    p_note, p_user, v_device, nextval('server_scan_client_seq'),
    v_now, 0, v_now,   -- placeholder; the trigger clamps it
    coalesce(p_payload, '{}'::jsonb)
  );
  return v_id;
end
$$;

/**
 * partner_for — the live partner row, ours, or a nameable refusal.
 */
create or replace function partner_for(p_org uuid, p_partner_house_id uuid)
returns partner_houses
language plpgsql
stable
set search_path = public
as $$
declare
  v_row partner_houses%rowtype;
begin
  select * into v_row from partner_houses p
   where p.id = p_partner_house_id and p.org_id = p_org and p.deleted_at is null;
  if not found then
    raise exception 'partner house % does not belong to this org', p_partner_house_id
      using errcode = 'foreign_key_violation';
  end if;
  return v_row;
end
$$;

/**
 * job_attendant_names — the crew line, in assignment order. The one home
 * for the projection rule: pull_changes and the attendant RPCs both call it.
 */
create or replace function job_attendant_names(p_job_id uuid)
returns text[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(u.display_name order by ja.created_at, ja.id), '{}'::text[])
    from job_attendants ja
    join users u on u.id = ja.user_id
   where ja.job_id = p_job_id
$$;

-- ---------------------------------------------------------------------------
-- Partner CRUD (D1): owner | manager
-- ---------------------------------------------------------------------------

/**
 * upsert_partner_house — create (p_id null) or edit (p_id given).
 * Null fields mean "keep" on edit. Same name (case-insensitive) twice in
 * one org is refused by the index — one partner, one spelling.
 */
create or replace function upsert_partner_house(
  p_name                text,
  p_id                  uuid default null,
  p_phone               text default null,
  p_whatsapp_group_note text default null,
  p_city                text default null,
  p_notes               text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_row  partner_houses%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from network_write_context(array['owner', 'manager']);

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'a partner house needs a name'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_id is null then
    insert into partner_houses (org_id, name, phone, whatsapp_group_note, city, notes, created_by)
    values (v_org, trim(p_name),
            nullif(trim(coalesce(p_phone, '')), ''),
            nullif(trim(coalesce(p_whatsapp_group_note, '')), ''),
            coalesce(nullif(trim(coalesce(p_city, '')), ''), 'Lahore'),
            nullif(trim(coalesce(p_notes, '')), ''),
            v_user)
    returning * into v_row;

    perform write_audit('partner_house_created', 'partner_house', v_row.id, v_row.name,
      jsonb_build_object('city', v_row.city));
  else
    select * into v_row from partner_houses p
     where p.id = p_id and p.org_id = v_org and p.deleted_at is null;
    if not found then
      raise exception 'partner house % does not belong to this org', p_id
        using errcode = 'foreign_key_violation';
    end if;

    update partner_houses p
       set name                = trim(p_name),
           phone               = coalesce(nullif(trim(coalesce(p_phone, '')), ''), p.phone),
           whatsapp_group_note = coalesce(nullif(trim(coalesce(p_whatsapp_group_note, '')), ''),
                                          p.whatsapp_group_note),
           city                = coalesce(nullif(trim(coalesce(p_city, '')), ''), p.city),
           notes               = coalesce(nullif(trim(coalesce(p_notes, '')), ''), p.notes)
     where p.id = p_id and p.org_id = v_org
    returning * into v_row;

    perform write_audit('partner_house_updated', 'partner_house', v_row.id, v_row.name,
      jsonb_build_object('city', v_row.city));
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'phone', v_row.phone,
    'whatsapp_group_note', v_row.whatsapp_group_note,
    'city', v_row.city,
    'notes', v_row.notes,
    'created_at', v_row.created_at,
    'updated_at', v_row.updated_at);
end
$$;

comment on function upsert_partner_house(text, uuid, text, text, text, text) is
  'Create or edit a partner house (0025 D1). owner|manager. Null fields keep on edit; city defaults to Lahore. Unique per (org, lower(name)). Audited.';

/**
 * remove_partner_house — soft delete. Refused while a sub-hire with this
 * partner is still open: the gear (or the money) has not come home.
 */
create or replace function remove_partner_house(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_row  partner_houses%rowtype;
  v_open int;
begin
  select o_org, o_user into v_org, v_user
    from network_write_context(array['owner', 'manager']);

  select * into v_row from partner_houses p
   where p.id = p_id and p.org_id = v_org and p.deleted_at is null
   for update;
  if not found then
    raise exception 'partner house % does not belong to this org', p_id
      using errcode = 'foreign_key_violation';
  end if;

  select count(*) into v_open from sub_hires s
   where s.org_id = v_org and s.partner_house_id = p_id and s.returned_at is null;
  if v_open > 0 then
    raise exception 'partner % still has % open sub-hire(s); close them first',
      v_row.name, v_open
      using errcode = 'check_violation';
  end if;

  update partner_houses p set deleted_at = now()
   where p.id = p_id and p.org_id = v_org
  returning * into v_row;

  perform write_audit('partner_house_removed', 'partner_house', v_row.id, v_row.name, '{}'::jsonb);

  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'deleted_at', v_row.deleted_at);
end
$$;

comment on function remove_partner_house(uuid) is
  'Soft-delete a partner house (0025 D1). owner|manager. Refused while any sub-hire with it is still open. Audited.';

-- ---------------------------------------------------------------------------
-- Sub-hire (D2–D6): owner | manager | desk — the money-writing tier
-- ---------------------------------------------------------------------------

/**
 * record_sub_hire_in — gear borrowed from a partner.
 *
 * Writes, in one transaction: the assets row (when a serial is given —
 * ownership='sub_rented_in', its `intake` event on the server device),
 * the expense (when a cost is given — record_expense, kind 'sub_hire',
 * counterparty = partner name, linked to the job/booking/asset), and the
 * sub_hires row that ties them. Returns
 *   { sub_hire_id, expense_id, asset_id, asset_code, partner_name }
 * with expense_id / asset_id / asset_code null when not created.
 */
create or replace function record_sub_hire_in(
  p_partner_house_id  uuid,
  p_product_id        uuid,
  p_period            tstzrange,
  p_qty               int         default 1,
  p_agreed_cost_minor bigint      default null,
  p_serial_number     text        default null,
  p_booking_id        uuid        default null,
  p_job_id            uuid        default null,
  p_note              text        default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid;
  v_user     uuid;
  v_partner  partner_houses%rowtype;
  v_product  products%rowtype;
  v_id       uuid := uuid_generate_v7();
  v_asset    assets%rowtype;
  v_expense  org_expenses%rowtype;
  v_serial   text := nullif(trim(coalesce(p_serial_number, '')), '');
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_row      sub_hires%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from network_write_context(array['owner', 'manager', 'desk']);

  v_partner := partner_for(v_org, p_partner_house_id);

  select * into v_product from products p
   where p.id = p_product_id and p.org_id = v_org and p.deleted_at is null;
  if not found then
    raise exception 'product % does not belong to this org', p_product_id
      using errcode = 'foreign_key_violation';
  end if;

  if p_period is null or isempty(p_period) then
    raise exception 'a sub-hire needs a period'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'a sub-hire is at least one unit'
      using errcode = 'check_violation';
  end if;
  if p_agreed_cost_minor is not null and p_agreed_cost_minor <= 0 then
    raise exception 'an agreed cost is positive, or left blank when unpriced'
      using errcode = 'check_violation';
  end if;

  if v_serial is not null then
    if p_qty <> 1 then
      raise exception 'a serial names one unit; qty must be 1'
        using errcode = 'check_violation';
    end if;
    if v_product.tracking_mode <> 'serialized' then
      raise exception 'product % is % — a serial only fits a serialized product',
        v_product.display_name, v_product.tracking_mode
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from assets a
       where a.org_id = v_org and lower(a.serial_number) = lower(v_serial)
         and a.deleted_at is null
    ) then
      raise exception 'serial % is already in the fleet', v_serial
        using errcode = 'unique_violation';
    end if;
  end if;

  if p_booking_id is not null and not exists (
    select 1 from bookings b
     where b.id = p_booking_id and b.org_id = v_org and b.deleted_at is null
  ) then
    raise exception 'booking % does not belong to this org', p_booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if p_job_id is not null and not exists (
    select 1 from jobs j
     where j.id = p_job_id and j.org_id = v_org and j.deleted_at is null
  ) then
    raise exception 'job % does not belong to this org', p_job_id
      using errcode = 'foreign_key_violation';
  end if;

  -- D5: the borrowed unit joins the fleet, marked as borrowed.
  if v_serial is not null then
    insert into assets (org_id, product_id, asset_code, serial_number, ownership, notes)
    values (v_org, v_product.id, generate_asset_code(v_org), v_serial, 'sub_rented_in',
            'Sub-hired from ' || v_partner.name)
    returning * into v_asset;
  end if;

  -- D2: the expense, through the one door (job_margin / booking_sub_hire_
  -- cost read it with no new code). D6: none when unpriced.
  if p_agreed_cost_minor is not null then
    v_expense := record_expense(
      'sub_hire', p_agreed_cost_minor, v_asset.id, p_job_id,
      v_partner.name, coalesce(v_note, 'Sub-hire in: ' || v_product.display_name),
      null, p_booking_id);
  end if;

  insert into sub_hires (id, org_id, direction, partner_house_id, booking_id, job_id,
                         product_id, qty, asset_id, period, agreed_cost_minor,
                         expense_id, note, created_by)
  values (v_id, v_org, 'in', v_partner.id, p_booking_id, p_job_id,
          v_product.id, p_qty, v_asset.id, p_period, p_agreed_cost_minor,
          v_expense.id, v_note, v_user)
  returning * into v_row;

  -- D5: the log says it arrived.
  if v_asset.id is not null then
    perform mint_server_event(v_org, v_user, v_asset.id, 'intake', null,
      'Sub-hired from ' || v_partner.name,
      jsonb_build_object('sub_hire', true, 'direction', 'in',
                         'sub_hire_id', v_id, 'partner_house_id', v_partner.id));
  end if;

  perform write_audit('sub_hire_in', 'sub_hire', v_id, v_partner.name,
    jsonb_build_object('product_id', v_product.id, 'qty', p_qty,
                       'asset_id', v_asset.id, 'expense_id', v_expense.id,
                       'agreed_cost_minor', p_agreed_cost_minor,
                       'booking_id', p_booking_id, 'job_id', p_job_id));

  return jsonb_build_object(
    'sub_hire_id', v_id,
    'expense_id', v_expense.id,
    'asset_id', v_asset.id,
    'asset_code', v_asset.asset_code,
    'partner_name', v_partner.name);
end
$$;

comment on function record_sub_hire_in(uuid, uuid, tstzrange, int, bigint, text, uuid, uuid, text) is
  'Gear borrowed from a partner (0025 D2/D5/D6): owner|manager|desk. With a serial, creates the unit (ownership=sub_rented_in) and its intake event; with a cost, the sub_hire expense through record_expense (counterparty = partner name); always the sub_hires row. Returns {sub_hire_id, expense_id, asset_id, asset_code, partner_name}.';

/**
 * record_sub_hire_out — gear lent to a partner.
 *
 * Creates the sub-hire JOB (D4) the desk scans against, the partner's
 * customer row if needed (D3), the ledger charge when a charge is given
 * (record_ledger_entry, D6), and the sub_hires row. Returns
 *   { sub_hire_id, job_id, job_label, customer_id, ledger_entry_id, partner_name }
 */
create or replace function record_sub_hire_out(
  p_partner_house_id    uuid,
  p_period              tstzrange,
  p_product_id          uuid        default null,   -- derived from the asset when given
  p_asset_id            uuid        default null,
  p_qty                 int         default 1,
  p_agreed_charge_minor bigint      default null,
  p_note                text        default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid;
  v_user     uuid;
  v_partner  partner_houses%rowtype;
  v_asset    assets%rowtype;
  v_product  products%rowtype;
  v_customer uuid;
  v_id       uuid := uuid_generate_v7();
  v_job_id   uuid := uuid_generate_v7();
  v_label    text;
  v_entry    customer_ledger_entries%rowtype;
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
begin
  select o_org, o_user into v_org, v_user
    from network_write_context(array['owner', 'manager', 'desk']);

  v_partner := partner_for(v_org, p_partner_house_id);

  if p_period is null or isempty(p_period) then
    raise exception 'a sub-hire needs a period'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'a sub-hire is at least one unit'
      using errcode = 'check_violation';
  end if;
  if p_agreed_charge_minor is not null and p_agreed_charge_minor <= 0 then
    raise exception 'an agreed charge is positive, or left blank when unpriced'
      using errcode = 'check_violation';
  end if;

  if p_asset_id is not null then
    select * into v_asset from assets a
     where a.id = p_asset_id and a.org_id = v_org and a.deleted_at is null;
    if not found then
      raise exception 'asset % does not belong to this org', p_asset_id
        using errcode = 'foreign_key_violation';
    end if;
    if v_asset.disposition is not null then
      raise exception 'asset % has left the fleet (%)', v_asset.asset_code, v_asset.disposition
        using errcode = 'check_violation';
    end if;
    if v_asset.ownership <> 'owned' then
      raise exception 'asset % is itself borrowed (%) — it cannot be lent on',
        v_asset.asset_code, v_asset.ownership
        using errcode = 'check_violation';
    end if;
    if p_qty <> 1 then
      raise exception 'a named unit is one unit; qty must be 1'
        using errcode = 'check_violation';
    end if;
    if p_product_id is not null and p_product_id <> v_asset.product_id then
      raise exception 'asset % is not a unit of product %', v_asset.asset_code, p_product_id
        using errcode = 'check_violation';
    end if;
  end if;

  select * into v_product from products p
   where p.id = coalesce(v_asset.product_id, p_product_id)
     and p.org_id = v_org and p.deleted_at is null;
  if not found then
    raise exception 'product % does not belong to this org', coalesce(v_asset.product_id, p_product_id)
      using errcode = 'foreign_key_violation';
  end if;

  -- D3: the partner on the udhaar book.
  v_customer := ensure_partner_customer(v_org, v_user, v_partner);

  -- D4: the job the desk scans against. Ordinary machinery: the same row
  -- shape convert_booking_to_job writes, the same close rule, the same
  -- boards. The partner's phone rides `contact` (server-side; projected
  -- out of sync like every job's).
  v_label := 'Sub-hire → ' || v_partner.name;
  insert into jobs (id, org_id, label, contact, expected_back, status,
                    created_by, customer_id)
  values (v_job_id, v_org, v_label, v_partner.phone,
          upper(p_period)::date, 'open', v_user, v_customer);

  -- D2/D6: the charge, through the one door — none when unpriced.
  if p_agreed_charge_minor is not null then
    v_entry := record_ledger_entry(
      v_customer, 'charge', p_agreed_charge_minor, v_job_id, v_asset.id,
      coalesce(v_note, 'Sub-hire out: ' || v_product.display_name), null, null);
  end if;

  insert into sub_hires (id, org_id, direction, partner_house_id, job_id,
                         product_id, qty, asset_id, period, agreed_charge_minor,
                         ledger_entry_id, note, created_by)
  values (v_id, v_org, 'out', v_partner.id, v_job_id,
          v_product.id, p_qty, v_asset.id, p_period, p_agreed_charge_minor,
          v_entry.id, v_note, v_user);

  perform write_audit('sub_hire_out', 'sub_hire', v_id, v_partner.name,
    jsonb_build_object('product_id', v_product.id, 'qty', p_qty,
                       'asset_id', v_asset.id, 'job_id', v_job_id,
                       'customer_id', v_customer, 'ledger_entry_id', v_entry.id,
                       'agreed_charge_minor', p_agreed_charge_minor));

  return jsonb_build_object(
    'sub_hire_id', v_id,
    'job_id', v_job_id,
    'job_label', v_label,
    'customer_id', v_customer,
    'ledger_entry_id', v_entry.id,
    'partner_name', v_partner.name);
end
$$;

comment on function record_sub_hire_out(uuid, tstzrange, uuid, uuid, int, bigint, text) is
  'Gear lent to a partner (0025 D2/D3/D4/D6): owner|manager|desk. Creates the sub-hire job (label ''Sub-hire → <partner>'', customer = the partner customer, found-or-created and flagged is_partner), the ledger charge when a charge is given, and the sub_hires row. The desk scans the unit out onto the job normally — no parallel presence. Returns {sub_hire_id, job_id, job_label, customer_id, ledger_entry_id, partner_name}.';

/**
 * close_sub_hire — the gear went home (in) or came back (out).
 *
 * in + unit: refused while the unit is still out on a job; otherwise a
 *   `retire` event on the server device → gone + returned_to_owner (D5).
 * out: refused while any asset still projects onto the sub-hire job (the
 *   0018 D3 rule — scan it in first); otherwise the job closes.
 * Returns { sub_hire_id, returned_at, asset_id, retire_event_id, job_id, job_closed }
 */
create or replace function close_sub_hire(
  p_sub_hire_id uuid,
  p_returned_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid;
  v_user     uuid;
  v_row      sub_hires%rowtype;
  v_asset    assets%rowtype;
  v_job      jobs%rowtype;
  v_returned timestamptz := coalesce(p_returned_at, now());
  v_event    uuid;
  v_out      int;
  v_closed   boolean := false;
begin
  select o_org, o_user into v_org, v_user
    from network_write_context(array['owner', 'manager', 'desk']);

  select * into v_row from sub_hires s
   where s.id = p_sub_hire_id and s.org_id = v_org
   for update;
  if not found then
    raise exception 'sub-hire % does not belong to this org', p_sub_hire_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_row.returned_at is not null then
    raise exception 'sub-hire % was already closed at %', p_sub_hire_id, v_row.returned_at
      using errcode = 'check_violation';
  end if;
  if v_returned > now() then
    raise exception 'a return is a past fact; % is in the future', v_returned
      using errcode = 'check_violation';
  end if;
  if v_returned < lower(v_row.period) then
    raise exception 'returned (%) before the sub-hire began (%)', v_returned, lower(v_row.period)
      using errcode = 'check_violation';
  end if;

  if v_row.direction = 'in' and v_row.asset_id is not null then
    select * into v_asset from assets a
     where a.id = v_row.asset_id and a.org_id = v_org
     for update;
    if found and v_asset.presence = 'out' then
      raise exception 'unit % is still out on a job; scan it in before sending it home',
        v_asset.asset_code
        using errcode = 'check_violation';
    end if;
    -- D5: gone + returned_to_owner, via the log. Already-gone stays as it is.
    if found and v_asset.disposition is null then
      v_event := mint_server_event(v_org, v_user, v_asset.id, 'retire', null,
        'Returned to ' || (select p.name from partner_houses p where p.id = v_row.partner_house_id),
        jsonb_build_object('sub_hire', true, 'direction', 'in',
                           'sub_hire_id', v_row.id, 'returned_at', v_returned));
    end if;
  end if;

  if v_row.direction = 'out' and v_row.job_id is not null then
    select * into v_job from jobs j
     where j.id = v_row.job_id and j.org_id = v_org and j.deleted_at is null
     for update;
    if found and v_job.status = 'open' then
      -- D4: the close rule, said here so the desk hears the count.
      select count(*) into v_out from assets a
       where a.org_id = v_org and a.current_job_id = v_job.id;
      if v_out > 0 then
        raise exception 'job cannot close: % asset(s) still out on it — scan them in first', v_out
          using errcode = 'check_violation';
      end if;
      update jobs set status = 'closed', closed_at = v_returned
       where id = v_job.id and org_id = v_org;
      v_closed := true;
    end if;
  end if;

  update sub_hires set returned_at = v_returned
   where id = v_row.id and org_id = v_org
  returning * into v_row;

  perform write_audit('sub_hire_closed', 'sub_hire', v_row.id, v_row.direction,
    jsonb_build_object('returned_at', v_returned, 'asset_id', v_row.asset_id,
                       'retire_event_id', v_event, 'job_id', v_row.job_id,
                       'job_closed', v_closed));

  return jsonb_build_object(
    'sub_hire_id', v_row.id,
    'returned_at', v_row.returned_at,
    'asset_id', v_row.asset_id,
    'retire_event_id', v_event,
    'job_id', v_row.job_id,
    'job_closed', v_closed);
end
$$;

comment on function close_sub_hire(uuid, timestamptz) is
  'Close a sub-hire (0025 D4/D5): owner|manager|desk. in + unit → refused while out on a job, else a retire event stamps returned_to_owner; out → refused while gear still projects onto the sub-hire job, else the job closes. returned_at defaults to now, never future, never before the period. Returns {sub_hire_id, returned_at, asset_id, retire_event_id, job_id, job_closed}.';

-- ---------------------------------------------------------------------------
-- Crew (D7): owner | manager | desk
-- ---------------------------------------------------------------------------

/**
 * assign_attendant — put a member on a job's crew (upsert: a second call
 * with a different role changes the role). The job row is touched so its
 * change_seq bumps and every phone re-reads the crew line (D8).
 * Returns { job_id, user_id, role, display_name, attendant_names }
 */
create or replace function assign_attendant(
  p_job_id  uuid,
  p_user_id uuid,
  p_role    text default 'attendant'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_job  jobs%rowtype;
  v_name text;
  v_row  job_attendants%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from network_write_context(array['owner', 'manager', 'desk']);

  if p_role is null or p_role not in ('attendant', 'driver') then
    raise exception 'crew role is attendant or driver, not %', coalesce(p_role, '(null)')
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_job from jobs j
   where j.id = p_job_id and j.org_id = v_org and j.deleted_at is null
   for update;
  if not found then
    raise exception 'job % does not belong to this org', p_job_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_job.status = 'cancelled' then
    raise exception 'job % is cancelled — nobody goes out with it', p_job_id
      using errcode = 'check_violation';
  end if;

  select u.display_name into v_name
    from memberships m join users u on u.id = m.user_id
   where m.org_id = v_org and m.user_id = p_user_id
     and m.status = 'active' and m.deleted_at is null and u.deleted_at is null;
  if v_name is null then
    raise exception 'user % is not an active member of this org', p_user_id
      using errcode = 'foreign_key_violation';
  end if;

  insert into job_attendants (org_id, job_id, user_id, role, created_by)
  values (v_org, p_job_id, p_user_id, p_role, v_user)
  on conflict (org_id, job_id, user_id) do update set role = excluded.role
  returning * into v_row;

  -- D8: the phone learns through the job row.
  update jobs set updated_at = now() where id = p_job_id and org_id = v_org;

  perform write_audit('attendant_assigned', 'job', p_job_id, v_job.label,
    jsonb_build_object('user_id', p_user_id, 'role', p_role));

  return jsonb_build_object(
    'job_id', p_job_id,
    'user_id', p_user_id,
    'role', v_row.role,
    'display_name', v_name,
    'attendant_names', to_jsonb(job_attendant_names(p_job_id)));
end
$$;

comment on function assign_attendant(uuid, uuid, text) is
  'Put an active member on a job''s crew as attendant|driver (0025 D7): owner|manager|desk, upsert per (job, user), refused on a cancelled job. Touches the job so the crew line syncs (D8). Audited. Returns {job_id, user_id, role, display_name, attendant_names}.';

/**
 * unassign_attendant — take a member off the crew. Returns
 *   { job_id, user_id, removed, attendant_names }
 */
create or replace function unassign_attendant(
  p_job_id  uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org     uuid;
  v_user    uuid;
  v_job     jobs%rowtype;
  v_removed int;
begin
  select o_org, o_user into v_org, v_user
    from network_write_context(array['owner', 'manager', 'desk']);

  select * into v_job from jobs j
   where j.id = p_job_id and j.org_id = v_org and j.deleted_at is null
   for update;
  if not found then
    raise exception 'job % does not belong to this org', p_job_id
      using errcode = 'foreign_key_violation';
  end if;

  delete from job_attendants ja
   where ja.org_id = v_org and ja.job_id = p_job_id and ja.user_id = p_user_id;
  get diagnostics v_removed = row_count;

  if v_removed > 0 then
    update jobs set updated_at = now() where id = p_job_id and org_id = v_org;
    perform write_audit('attendant_unassigned', 'job', p_job_id, v_job.label,
      jsonb_build_object('user_id', p_user_id));
  end if;

  return jsonb_build_object(
    'job_id', p_job_id,
    'user_id', p_user_id,
    'removed', v_removed > 0,
    'attendant_names', to_jsonb(job_attendant_names(p_job_id)));
end
$$;

comment on function unassign_attendant(uuid, uuid) is
  'Take a member off a job''s crew (0025 D7): owner|manager|desk. removed=false when they were not on it. Touches the job so the crew line syncs. Returns {job_id, user_id, removed, attendant_names}.';

-- ---------------------------------------------------------------------------
-- The stolen broadcast (D9) — INVOKER, a read
-- ---------------------------------------------------------------------------

/**
 * stolen_broadcast_text — the facts the client lacks for the partner
 * WhatsApp blast, plus a short paste-ready line.
 *
 * Refused unless the unit is marked stolen (0020 D2b: an owner/manager
 * declaration). Reads under the caller's RLS. Returns
 *   { asset_id, asset_code, serial_number, product_name, tag_code,
 *     public_url, org_name, org_phone, marked_stolen_at, text }
 * public_url is settings.public_tag_url_base + tag_code, null when either
 * is missing (ASSUMPTION #public-tag-url).
 */
create or replace function stolen_broadcast_text(p_asset_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_org     uuid := current_org_id();
  v_asset   assets%rowtype;
  v_product text;
  v_tag     text;
  v_orgrow  orgs%rowtype;
  v_base    text;
  v_url     text;
  v_phone   text;
  v_marked  timestamptz;
  v_text    text;
begin
  if v_org is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  select * into v_asset from assets a
   where a.id = p_asset_id and a.org_id = v_org and a.deleted_at is null;
  if not found then
    raise exception 'asset % does not belong to this org', p_asset_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_asset.disposition is distinct from 'stolen' then
    raise exception 'asset % is not marked stolen (%); the broadcast would be a lie',
      v_asset.asset_code, coalesce(v_asset.disposition, 'in fleet')
      using errcode = 'check_violation';
  end if;

  select p.display_name into v_product from products p where p.id = v_asset.product_id;
  select t.tag_code into v_tag from asset_tags t
   where t.asset_id = v_asset.id and t.org_id = v_org and t.status = 'active'
   limit 1;
  select * into v_orgrow from orgs o where o.id = v_org;

  -- ASSUMPTION: the public page base is an org setting with no default.
  -- See docs/assumptions.md#public-tag-url
  v_base  := nullif(trim(coalesce(v_orgrow.settings ->> 'public_tag_url_base', '')), '');
  v_url   := case when v_base is not null and v_tag is not null
                  then rtrim(v_base, '/') || '/' || v_tag end;
  v_phone := nullif(trim(coalesce(v_orgrow.settings ->> 'public_phone', '')), '');

  select max(e.effective_time) into v_marked
    from scan_events e
   where e.org_id = v_org and e.asset_id = v_asset.id and e.event_type = 'mark_stolen';

  -- Short on purpose: the client builds the full theft report; this is the
  -- line for the partner group. Roman Urdu first — that is the group's
  -- language — then English.
  v_text :=
    'CHORI / STOLEN — ' || coalesce(v_product, 'item')
    || coalesce(', serial ' || v_asset.serial_number, '')
    || coalesce(', tag ' || v_tag, '')
    || '. Yeh ' || v_orgrow.name || ' ka saman hai aur chori ho gaya hai.'
    || ' Agar koi bechne ya rent par dene aaye to please'
    || coalesce(' ' || v_phone, ' humein') || ' par call karein.'
    || ' / This item was stolen from ' || v_orgrow.name
    || '. If you are offered it, please call' || coalesce(' ' || v_phone, ' us') || '.'
    || coalesce(' ' || v_url, '');

  return jsonb_build_object(
    'asset_id', v_asset.id,
    'asset_code', v_asset.asset_code,
    'serial_number', v_asset.serial_number,
    'product_name', v_product,
    'tag_code', v_tag,
    'public_url', v_url,
    'org_name', v_orgrow.name,
    'org_phone', v_phone,
    'marked_stolen_at', v_marked,
    'text', v_text);
end
$$;

comment on function stolen_broadcast_text(uuid) is
  'The partner-group broadcast for a STOLEN unit (0025 D9): INVOKER, refused unless disposition=stolen. Returns {asset_id, asset_code, serial_number, product_name, tag_code, public_url, org_name, org_phone, marked_stolen_at, text} — public_url from settings.public_tag_url_base + tag_code, null when unset.';

-- ---------------------------------------------------------------------------
-- The fast-lane flags (D10) — INVOKER, a read
-- ---------------------------------------------------------------------------

/**
 * customer_quote_flags — what the quote screen stamps beside the client.
 * Returns
 *   { customer_id, name, verified, clean_history, blacklisted, fast_lane,
 *     clean_completed_jobs, deposit_hint }
 * deposit_hint: refuse | lighter | standard | full
 * (ASSUMPTION #deposit-hint). Reads verified_customers (0017) under the
 * caller's RLS: a non-money role sees verified=false — the stricter side.
 */
create or replace function customer_quote_flags(p_customer_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_org uuid := current_org_id();
  v     verified_customers%rowtype;
  v_hint text;
begin
  if v_org is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  select * into v from verified_customers vc
   where vc.customer_id = p_customer_id and vc.org_id = v_org;
  if not found then
    raise exception 'customer % does not belong to this org', p_customer_id
      using errcode = 'foreign_key_violation';
  end if;

  -- ASSUMPTION: the deposit ladder. See docs/assumptions.md#deposit-hint
  v_hint := case
    when v.blacklisted then 'refuse'
    when v.fast_lane   then 'lighter'
    when v.verified    then 'standard'
    else 'full'
  end;

  return jsonb_build_object(
    'customer_id', v.customer_id,
    'name', v.name,
    'verified', v.verified,
    'clean_history', (v.clean_completed_jobs >= 1 and v.no_open_shortfall),
    'blacklisted', v.blacklisted,
    'fast_lane', v.fast_lane,
    'clean_completed_jobs', v.clean_completed_jobs,
    'deposit_hint', v_hint);
end
$$;

comment on function customer_quote_flags(uuid) is
  'The verified-client stamp for the quote screen (0025 D10): INVOKER over verified_customers. Returns {customer_id, name, verified, clean_history, blacklisted, fast_lane, clean_completed_jobs, deposit_hint} with deposit_hint refuse|lighter|standard|full.';

-- ---------------------------------------------------------------------------
-- pull_changes, eighth edition (D8)
--
-- 0023's seventh edition verbatim — static SQL, the watermark early-out, THE
-- CURSOR IS THE MINIMUM SAFE ADVANCE, the C1 settle holdback, explicit
-- projections everywhere — plus exactly one column on jobs:
-- attendant_names (display names in assignment order, [] when none). The
-- excluded jobs column stays projected out (the M6 rule; the guard greps
-- this function's source, so it is not named here).
-- ---------------------------------------------------------------------------
create or replace function pull_changes(
  p_since bigint default 0,
  p_limit int default 2000
)
returns jsonb
language plpgsql
stable
as $$
#variable_conflict use_variable
declare
  result    jsonb := '{}'::jsonb;
  rows      jsonb;
  tbl_max   bigint;
  tbl_count int;
  tbl_wait   bigint;   -- lowest returned seq that is not yet safely settled
  safe_max   bigint := null;   -- holdback from a table that filled its page
  settle_min bigint := null;   -- holdback from unsettled rows (C1)
  seen_max   bigint := p_since;
  truncated  boolean := false;
  watermark  bigint;
  v_xmin     xid8 := pg_snapshot_xmin(pg_current_snapshot());
  v_own      xid8 := pg_current_xact_id_if_assigned();
  -- clock_timestamp, not now(): now() is frozen at transaction start, and a
  -- pull inside a longer transaction would otherwise never see rows settle.
  v_fresh    timestamptz := clock_timestamp() - interval '3 seconds';
begin
  if current_org_id() is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- THE EARLY OUT. One indexed lookup answers the question a polling device
  -- actually asks, which is "is there anything for me?" — and the answer is
  -- almost always no. Safe without settle logic: it hands p_since straight
  -- back, and a cursor that never advances cannot skip a row.
  select max_change_seq into watermark
    from org_sync_watermark where org_id = current_org_id();

  if watermark is null or watermark <= p_since then
    return jsonb_build_object(
      'cursor', p_since,
      'has_more', false,
      'server_time', now(),
      'tables', jsonb_build_object(
        'products', '[]'::jsonb, 'assets', '[]'::jsonb, 'asset_tags', '[]'::jsonb,
        'locations', '[]'::jsonb, 'jobs', '[]'::jsonb, 'kit_templates', '[]'::jsonb,
        'kit_template_items', '[]'::jsonb, 'asset_containment', '[]'::jsonb,
        'bookings', '[]'::jsonb, 'booking_lines', '[]'::jsonb,
        'asset_reservations', '[]'::jsonb, 'stock_reservations', '[]'::jsonb,
        'stock_lots', '[]'::jsonb));
  end if;

  -- Each block: page one table, fold it in, hold the cursor back if this
  -- table filled its page, and hold it below any row whose writing
  -- transaction was concurrent with one that is still in flight (C1).
  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, global_product_id, category, manufacturer, model,
                 display_name, tracking_mode, specs, replacement_value_minor,
                 service_due_after_rental_days, count_cycles, retire_after_cycles,
                 hero_image_path, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from products where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('products', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- Explicit projection, not `select *`. Two reasons, both measured:
    -- it is ~37% faster to serialise (40ms -> 25ms for a 2000-row page), and
    -- it cuts the payload the device has to pull over 3G, where ~28% of
    -- Pakistani mobile users are still on 2G. Columns the client does not
    -- mirror cost bandwidth on every first sync and buy nothing.
    from (select id, org_id, product_id, asset_code, serial_number, is_container,
                 rentable, presence, health, ownership, disposition,
                 rental_days_since_service, cycle_count, current_location_id,
                 current_parent_id, current_job_id, last_scanned_at,
                 notes, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from assets where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('assets', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, tag_code, asset_id, status, updated_at,
                 change_seq, changed_xid8, changed_at
            from asset_tags where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_tags', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, parent_id, name, kind, path, code, last_counted_at,
                 created_at, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from locations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('locations', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- The jobs projection deliberately omits the phone-number column — see
    -- sync_column_exclusions. The desk reads it server-side; the warehouse
    -- floor never needs it and a stolen scanner must not carry it. (Not named
    -- here: sync_exclusion_violations() greps this function's source.)
    -- 0018 D5: customer_id (opaque uuid) and closed_at ride along so the
    -- boards can show the chip and stop accumulating finished jobs.
    -- 0023: booking_id (the 0022 D8 bridge) joins them — the phone now
    -- reads it to refuse a second conversion and a cancel under a live job.
    -- 0025 D8: attendant_names — the crew line, display names only, in
    -- assignment order, [] when nobody is on it. Names are not in the
    -- sensitive registry (the 0023 D1 reasoning); assign/unassign touch the
    -- job row so this projection re-syncs when the crew changes.
    from (select j.id, j.org_id, j.label, j.expected_back, j.status, j.customer_id, j.closed_at,
                 j.booking_id, j.created_by, j.created_at, j.updated_at, j.deleted_at,
                 job_attendant_names(j.id) as attendant_names,
                 j.change_seq, j.changed_xid8, j.changed_at
            from jobs j where j.change_seq > p_since order by j.change_seq limit p_limit) x;
  result := result || jsonb_build_object('jobs', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, name, notes, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from kit_templates where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('kit_templates', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, kit_template_id, product_id, qty, required,
                 change_seq, changed_xid8, changed_at
            from kit_template_items where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('kit_template_items', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, parent_asset_id, child_asset_id, relation, expected,
                 added_at, removed_at, change_seq, changed_xid8, changed_at
            from asset_containment where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_containment', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- 0023: the promise calendar. The two tstzranges are projected as
    -- their bounds (SQLite has no range type; both are '[)'). The client's
    -- NAME is denormalised in from customers — the customers table itself
    -- never syncs (0009/0015) — so a phone can say who a promise is for
    -- without carrying the khata. A rename reaches the phone with the
    -- booking's next write; the desk owns the name, the phone displays it.
    -- The credential override note stays server-side: a manager's remark
    -- about a stranger's paperwork has no business on a warehouse phone.
    from (select b.id, b.org_id, b.booking_no, b.customer_id,
                 (select c.name from customers c where c.id = b.customer_id) as customer_name,
                 b.status,
                 lower(b.customer_period) as customer_from,
                 upper(b.customer_period) as customer_until,
                 lower(b.blocked_period) as blocked_from,
                 upper(b.blocked_period) as blocked_until,
                 b.pencil_expires_at, b.note, b.cancel_reason,
                 b.created_at, b.updated_at, b.deleted_at,
                 b.change_seq, b.changed_xid8, b.changed_at
            from bookings b where b.change_seq > p_since order by b.change_seq limit p_limit) x;
  result := result || jsonb_build_object('bookings', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait

    from (select id, org_id, booking_id, product_id, asset_id, qty,
                 created_at, deleted_at, change_seq, changed_xid8, changed_at
            from booking_lines where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('booking_lines', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- The reservation tombstones are what make an expired or cancelled
    -- pencil's claims vanish from every phone: prune_expired_pencils and
    -- cancel_booking set deleted_at, change_seq bumps, the mirror deletes.
    from (select id, org_id, booking_id, booking_line_id, asset_id,
                 lower(blocked_period) as blocked_from,
                 upper(blocked_period) as blocked_until,
                 state, created_at, deleted_at, change_seq, changed_xid8, changed_at
            from asset_reservations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_reservations', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait

    from (select id, org_id, booking_id, booking_line_id, product_id, qty,
                 lower(blocked_period) as blocked_from,
                 upper(blocked_period) as blocked_until,
                 state, created_at, deleted_at, change_seq, changed_xid8, changed_at
            from stock_reservations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('stock_reservations', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- The bulk shelf count the phone's availability answer starts from
    -- (0022 D6 here-now). Slim on purpose: no reorder threshold, no costs.
    -- stock_lots has no deleted_at — a lot is never tombstoned, only
    -- counted to zero.
    from (select id, org_id, product_id, location_id, qty_on_hand,
                 created_at, updated_at, change_seq, changed_xid8, changed_at
            from stock_lots where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('stock_lots', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  return jsonb_build_object(
    -- The cursor never passes a truncated page NOR an unsettled row (C1).
    'cursor', least(coalesce(safe_max, seen_max),
                    coalesce(settle_min, coalesce(safe_max, seen_max))),
    -- The watermark also answers has_more without a scan: anything above the
    -- cursor is, by definition, still waiting. Deliberately computed WITHOUT
    -- the settle holdback: a lag-held row was already DELIVERED in this
    -- response, so there is nothing more to fetch right now, and reporting
    -- has_more=true would make a pull-until-done client spin for the whole
    -- settle window.
    'has_more', truncated or coalesce(safe_max, seen_max) < watermark,
    'server_time', now(),
    'tables', result
  );
end
$$;

comment on function pull_changes(bigint, int) is
  'Cursor-pull sync, eighth edition (0025): the 0023 seventh edition plus jobs.attendant_names (the crew line, display names in assignment order). The cursor is the minimum safe advance; explicit projections everywhere; the excluded jobs column stays out.';

grant execute on function pull_changes(bigint, int) to papa_app;

-- ---------------------------------------------------------------------------
-- Grants — every function is born with PUBLIC execute (the 0015 M1 lesson):
-- revoke first, then the explicit door list.
-- ---------------------------------------------------------------------------
revoke all on function sub_hires_check_org()                                   from public;
revoke all on function job_attendants_check_org()                              from public;
revoke all on function network_write_context(text[])                           from public;
revoke all on function ensure_server_device(uuid, uuid)                        from public;
revoke all on function ensure_partner_customer(uuid, uuid, partner_houses)     from public;
revoke all on function mint_server_event(uuid, uuid, uuid, text, uuid, text, jsonb) from public;
revoke all on function partner_for(uuid, uuid)                                 from public;

revoke all on function upsert_partner_house(text, uuid, text, text, text, text) from public;
revoke all on function remove_partner_house(uuid)                              from public;
revoke all on function record_sub_hire_in(uuid, uuid, tstzrange, int, bigint, text, uuid, uuid, text) from public;
revoke all on function record_sub_hire_out(uuid, tstzrange, uuid, uuid, int, bigint, text) from public;
revoke all on function close_sub_hire(uuid, timestamptz)                       from public;
revoke all on function assign_attendant(uuid, uuid, text)                      from public;
revoke all on function unassign_attendant(uuid, uuid)                          from public;
revoke all on function stolen_broadcast_text(uuid)                             from public;
revoke all on function customer_quote_flags(uuid)                              from public;
revoke all on function job_attendant_names(uuid)                               from public;

-- job_attendant_names runs inside pull_changes, which is INVOKER: papa_app
-- needs execute, and job_attendants RLS keeps a foreign job_id returning [].
grant execute on function
  upsert_partner_house(text, uuid, text, text, text, text),
  remove_partner_house(uuid),
  record_sub_hire_in(uuid, uuid, tstzrange, int, bigint, text, uuid, uuid, text),
  record_sub_hire_out(uuid, tstzrange, uuid, uuid, int, bigint, text),
  close_sub_hire(uuid, timestamptz),
  assign_attendant(uuid, uuid, text),
  unassign_attendant(uuid, uuid),
  stolen_broadcast_text(uuid),
  customer_quote_flags(uuid),
  job_attendant_names(uuid)
  to papa_app;
