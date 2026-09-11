-- ============================================================================
-- 0022 — Bookings: the promise calendar, and the constraint that keeps it
--
-- Phase 2 core (PLAN.md phase 2; overrides 3, 4, 7 and 16 govern here).
-- Until now the schema knows where gear IS (the scan world, 0003–0021) and
-- what money moved (0017/0019). It does not know what has been PROMISED.
-- This migration adds the promise: bookings, their lines, and the two
-- reservation tables that make a double-promise a database impossibility
-- rather than a desk memory.
--
-- WHAT THIS MIGRATION DECIDES, and why:
--
--   D1  FOUR STATUSES, NOT EIGHT. bookings.status is
--       draft | pencil | confirmed | cancelled — deliberately smaller than
--       architecture.md §2.5's draft → quoted → hold → confirmed → prepped
--       → out → returned → closed machine. The missing states are not
--       missing; they live where the truth for them already lives:
--         * prepped / out / returned — the JOB & SCAN world. A booking
--           converts to a job (D8) and from then on the gear's own scan
--           events say what physically happened. Copying that into a
--           booking status would be a second copy of reality that drifts
--           (the 0018 lesson: presence is a projection, never a claim).
--         * quoted — phase 3 commercial, with the rate pipeline. A status
--           with no machinery behind it is a lie waiting to be rendered.
--         * hold — that is what `pencil` IS; one name, the trade's name.
--         * closed / lost — the job closes (0018 D3); the asset carries
--           its disposition (0020 D1). The booking does not die twice.
--
--   D2  TWO PERIODS PER BOOKING (override 7). customer_period is what the
--       client agreed to; blocked_period is the superset the fleet is
--       actually held for — prep buffer in front, turnaround behind, org
--       settings with ASSUMPTION defaults (see #buffer-defaults). The
--       exclusion constraint sits on blocked_period. blocked_period is
--       SHORTENABLE at confirm time, per booking, down to customer_period
--       — the same-day-turnaround desk override that would otherwise be
--       bypassed daily. buffer_policy_version records which generation of
--       the org's buffer policy computed it.
--
--   D3  THE EXCLUSION CONSTRAINT (the whole point). asset_reservations
--       carries `exclude using gist (asset_id with =, blocked_period
--       with &&) where (deleted_at is null and state = 'confirmed')`.
--       Two CONFIRMED claims on one physical unit over overlapping time
--       cannot coexist — not "we check first", the WRITE FAILS. Pencils
--       never participate: two desks holding the same camera for two
--       competing quotes is what a rental desk does all day; first to
--       confirm wins, the other hears exactly who won (D5). Ranges are
--       '[)' so back-to-back bookings (one ends 10:00, next begins 10:00)
--       touch without colliding — boundary semantics are pinned by test.
--
--   D4  CONFIRM ALLOCATES (override 3). Confirming a booking binds every
--       serialized line to specific units, least-utilised first
--       (rental_days_since_service, then cycle_count — the 0021 meters),
--       inside the one confirm transaction, under a per-product advisory
--       lock so concurrent confirms pick different units instead of
--       colliding. Reallocation is an UPDATE ... SET asset_id through
--       reallocate_reservation(), re-checked by the constraint. There is
--       no "confirmed but unallocated" state — that is the ambiguity
--       override 3 exists to kill.
--
--   D5  A COLLISION IS NAMEABLE. An exclusion violation never surfaces as
--       raw 23P01 noise: the RPCs catch it, look up the winning claim and
--       raise 'already promised to booking #N' — the message the desk can
--       act on (call the client, substitute a unit, sub-rent).
--
--   D6  BULK GETS stock_reservations (override 4). Serialized exclusion
--       cannot express "20 of 60 XLR cables, Tuesday–Thursday", so bulk
--       lines reserve (product, qty, period) rows and confirm_booking
--       enforces capacity under the same per-product advisory lock:
--       max simultaneous confirmed qty over the window must fit within
--       on-hand. THREE-LAYER AVAILABILITY SEMANTICS (booking_availability):
--         here-now   — what is physically on the shelf and fit, today
--                      (stock_lots.qty_on_hand for bulk — the movements
--                      ledger already subtracts what is out; live fleet
--                      count for serialized, minus units physically out
--                      when the asked-for window starts now);
--         pencilled  — the max simultaneous UNEXPIRED pencil claim over
--                      the window: informational, never subtracted —
--                      a pencil is a conversation, not a promise;
--         confirmed  — the max simultaneous confirmed claim over the
--                      window: subtracted, because a promise holds.
--       available = here-now − confirmed overlap. The desk sees all three
--       numbers and applies judgement; the constraint applies law.
--
--   D7  PENCILS EXPIRE WITHOUT A CRON (ASSUMPTION #hold-ttl: 24h TTL,
--       extendable, org-tunable via settings.pencil_ttl_hours). The
--       CONTRIBUTING hard rule: time-derived state must be derivable
--       locally from stored timestamps. So expiry is a PREDICATE —
--       status = 'pencil' and pencil_expires_at > now() is the definition
--       of a live pencil, everywhere — and the write RPCs prune stale
--       pencils opportunistically as they pass (cancel_reason =
--       'pencil_expired'). No scheduled job; an offline device computes
--       the same expiry from the same timestamp at render.
--
--   D8  THE JOB BRIDGE. jobs gains booking_id (one live job per booking,
--       partial unique). convert_booking_to_job() carries the promise
--       into the scan world the desk already runs: label, contact,
--       expected_back from the booking's own facts. The phase-1 pitch
--       ("a job row is upgraded to a booking") lands in reverse and the
--       boards keep working unchanged.
--
--   D9  THE CREDENTIAL GATE RIDES CONFIRM (override 16). confirm_booking
--       refuses when customer_needs_credentials(customer, exposure) says
--       so — exposure is the summed replacement value of what the booking
--       promises — unless a manager+ supplies a logged override note
--       (credential_override_note/_by/_at on the booking). Blacklist is
--       refusal, not paperwork, same as 0017.
--
--   D10 EXTENSION RETURNS THE COLLISION LIST — the highest-value single
--       screen in the research. extend_booking() computes exactly which
--       downstream confirmed bookings the new end time breaks — per
--       asset, per bulk shortfall, with booking numbers and customer
--       names — and returns it as DATA with extended=false. No collision,
--       it extends. Extending a future promise is schedule intent, so it
--       may fail; the truck-already-gone case is the scan world's overdue
--       machinery, not this RPC.
--
--   D11 WRITES GO THROUGH THE RPCs ONLY (the 0017 door pattern). papa_app
--       holds SELECT on the booking tables and nothing else; the RPCs are
--       SECURITY DEFINER with pinned search_path and explicit org
--       predicates on every statement. Direct INSERT would bypass gapless
--       numbering, allocation, the credential gate and the prune — so it
--       is not grantable, not just discouraged.
--
--   D12 GAPLESS booking_no PER ORG. booking_counters(org_id, next_no)
--       with the counter row locked by the upsert inside the same
--       transaction as the booking insert: concurrent creators serialize
--       on the row, an aborted create rolls its number back with it. No
--       sequence (sequences gap by design). Proven under two real
--       connections in the test (dblink, the 0015 technique).
--
--   D13 PHONES DO NOT SYNC BOOKINGS — YET, and deliberately. A slim
--       reservation projection ("promised to booking #7 from tomorrow")
--       is real value for the scanner, but it costs a seventh edition of
--       pull_changes, watermark wiring, mirror schema and replay logic in
--       packages/core — consumed by nothing until the client wave builds
--       the warning UI. Schema and consumer ship together in this repo
--       (0018 D5 added jobs columns only when the boards read them), so
--       the projection ships with the client wave. Nothing here blocks
--       it: bookings are ordinary org-scoped rows a make_syncable() call
--       away. jobs.booking_id likewise stays out of the pull projection
--       until a phone reads it.
--
-- Everything here is idempotent: IF NOT EXISTS / OR REPLACE / drop-and-
-- recreate pairs, the 0015–0021 discipline. 0001–0021 stay untouched.
-- ============================================================================

-- uuid = inside a GiST exclusion needs the btree operator classes.
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- booking_counters — the gapless spine (D12)
--
-- No papa_app grants at all: only create_booking (DEFINER) touches it.
-- ---------------------------------------------------------------------------
create table if not exists booking_counters (
  org_id   uuid primary key references orgs(id) on delete restrict,
  next_no  bigint not null default 1,

  constraint booking_counters_positive check (next_no >= 1)
);

alter table booking_counters enable row level security;
alter table booking_counters force row level security;

comment on table booking_counters is
  'Gapless per-org booking numbering (0022 D12). The upsert row lock serializes creators; an aborted create rolls its number back. Touched only by create_booking; no client grants.';

-- ---------------------------------------------------------------------------
-- bookings (D1, D2, D7, D9)
-- ---------------------------------------------------------------------------
create table if not exists bookings (
  id           uuid primary key default uuid_generate_v7(),
  org_id       uuid not null references orgs(id) on delete restrict,
  booking_no   bigint not null,

  customer_id  uuid not null references customers(id) on delete restrict,

  status       text not null default 'draft',

  -- Override 7: what the client agreed vs what the fleet is held for.
  customer_period  tstzrange not null,
  blocked_period   tstzrange not null,
  buffer_policy_version integer not null default 1,

  -- ASSUMPTION: 24h default TTL. See docs/assumptions.md#hold-ttl.
  pencil_expires_at timestamptz,

  note         text,

  -- D9: the logged credential override, when a manager used one.
  credential_override_note text,
  credential_override_by   uuid references users(id) on delete restrict,
  credential_override_at   timestamptz,

  cancelled_at  timestamptz,
  cancelled_by  uuid references users(id) on delete restrict,
  cancel_reason text,

  created_by   uuid references users(id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  constraint bookings_no_unique unique (org_id, booking_no),
  constraint bookings_status_check
    check (status in ('draft', 'pencil', 'confirmed', 'cancelled')),
  -- Both periods bounded on both ends: an open-ended promise is not a
  -- promise, and the exclusion math needs real endpoints.
  constraint bookings_customer_period_bounded check (
    not isempty(customer_period)
    and lower(customer_period) is not null
    and upper(customer_period) is not null
  ),
  constraint bookings_blocked_period_bounded check (
    not isempty(blocked_period)
    and lower(blocked_period) is not null
    and upper(blocked_period) is not null
  ),
  -- The hold-for window always covers the promised-to-client window.
  constraint bookings_blocked_covers_customer
    check (blocked_period @> customer_period),
  -- A pencil always knows when it dies (D7 — local derivability).
  constraint bookings_pencil_has_expiry
    check (status <> 'pencil' or pencil_expires_at is not null),
  constraint bookings_cancelled_is_stamped
    check ((status = 'cancelled') = (cancelled_at is not null))
);

create index if not exists bookings_org_status_idx
  on bookings (org_id, status) where deleted_at is null;
create index if not exists bookings_org_customer_idx
  on bookings (org_id, customer_id) where deleted_at is null;
create index if not exists bookings_org_blocked_idx
  on bookings using gist (org_id, blocked_period) where deleted_at is null;

comment on table bookings is
  'The promise calendar (0022). Four statuses only — prepped/out/returned derive from the job & scan world, quoted is phase 3, hold is pencil (D1). Writes only through the booking RPCs (D11).';
comment on column bookings.pencil_expires_at is
  'ASSUMPTION: defaults to now()+24h at pencil creation; org-tunable via settings.pencil_ttl_hours. A live pencil is status=pencil AND pencil_expires_at > now() — expiry is a predicate, never a cron. See docs/assumptions.md#hold-ttl.';
comment on column bookings.blocked_period is
  'customer_period widened by prep/turnaround buffers (override 7); the exclusion constraint and all availability math run on THIS window. Shortenable per booking at confirm.';

drop trigger if exists bookings_updated_at on bookings;
create trigger bookings_updated_at
  before update on bookings for each row execute function set_updated_at();

-- The customer must be this org's (FK checks existence, not tenancy).
create or replace function bookings_check_customer_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
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

drop trigger if exists bookings_customer_org on bookings;
create trigger bookings_customer_org
  before insert or update of customer_id, org_id on bookings
  for each row execute function bookings_check_customer_org();

alter table bookings enable row level security;
alter table bookings force row level security;

drop policy if exists bookings_select on bookings;
create policy bookings_select on bookings
  for select using (org_id = (select current_org_id()));

grant select on bookings to papa_app;   -- writes through the RPCs only (D11)

-- ---------------------------------------------------------------------------
-- booking_lines — a product+qty ask, or a demand for one specific unit
-- ---------------------------------------------------------------------------
create table if not exists booking_lines (
  id          uuid primary key default uuid_generate_v7(),
  org_id      uuid not null references orgs(id) on delete restrict,
  booking_id  uuid not null references bookings(id) on delete restrict,

  product_id  uuid references products(id) on delete restrict,
  asset_id    uuid references assets(id) on delete restrict,
  qty         integer not null default 1,

  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  -- Exactly one of the two shapes: "N of this product" (serialized products
  -- allocate specific units at confirm; bulk products reserve quantity), or
  -- "THIS unit" when the client demands a particular serial.
  constraint booking_lines_shape check (
    (product_id is not null and asset_id is null)
    or (asset_id is not null and product_id is null and qty = 1)
  ),
  constraint booking_lines_qty_positive check (qty >= 1)
);

create index if not exists booking_lines_org_booking_idx
  on booking_lines (org_id, booking_id) where deleted_at is null;
create index if not exists booking_lines_org_product_idx
  on booking_lines (org_id, product_id)
  where product_id is not null and deleted_at is null;

comment on table booking_lines is
  'What a booking asks for (0022): product+qty (allocation at confirm, override 3) OR one specific asset. Rate columns (override 18) arrive with phase-3 pricing, where the rates they record exist.';

create or replace function booking_lines_check_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from bookings b
     where b.id = new.booking_id and b.org_id = new.org_id
  ) then
    raise exception 'booking % does not belong to this org', new.booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.product_id is not null and not exists (
    select 1 from products p
     where p.id = new.product_id and p.org_id = new.org_id
       and p.deleted_at is null
  ) then
    raise exception 'product % does not belong to this org', new.product_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.asset_id is not null and not exists (
    select 1 from assets a
     where a.id = new.asset_id and a.org_id = new.org_id
       and a.deleted_at is null
  ) then
    raise exception 'asset % does not belong to this org', new.asset_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

drop trigger if exists booking_lines_org on booking_lines;
create trigger booking_lines_org
  before insert or update of booking_id, product_id, asset_id, org_id
  on booking_lines
  for each row execute function booking_lines_check_org();

alter table booking_lines enable row level security;
alter table booking_lines force row level security;

drop policy if exists booking_lines_select on booking_lines;
create policy booking_lines_select on booking_lines
  for select using (org_id = (select current_org_id()));

grant select on booking_lines to papa_app;

-- ---------------------------------------------------------------------------
-- asset_reservations — THE EXCLUSION CONSTRAINT (D3)
-- ---------------------------------------------------------------------------
create table if not exists asset_reservations (
  id               uuid primary key default uuid_generate_v7(),
  org_id           uuid not null references orgs(id) on delete restrict,
  booking_id       uuid not null references bookings(id) on delete restrict,
  booking_line_id  uuid not null references booking_lines(id) on delete restrict,
  asset_id         uuid not null references assets(id) on delete restrict,

  blocked_period   tstzrange not null,
  state            text not null,

  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  constraint asset_reservations_state_check
    check (state in ('pencil', 'confirmed')),
  constraint asset_reservations_period_bounded check (
    not isempty(blocked_period)
    and lower(blocked_period) is not null
    and upper(blocked_period) is not null
  ),

  -- The safety guarantee this whole phase exists for. CONFIRMED only:
  -- pencils are conversations and never block anyone (D3). '[)' ranges
  -- mean adjacent bookings touch legally.
  constraint asset_reservations_no_double_booking
    exclude using gist (asset_id with =, blocked_period with &&)
    where (deleted_at is null and state = 'confirmed')
);

create index if not exists asset_reservations_org_booking_idx
  on asset_reservations (org_id, booking_id) where deleted_at is null;
create index if not exists asset_reservations_asset_period_idx
  on asset_reservations using gist (asset_id, blocked_period)
  where deleted_at is null;

comment on table asset_reservations is
  'A specific unit promised for a window (0022 D3/D4). The exclusion constraint makes overlapping CONFIRMED claims on one asset a database impossibility; pencil rows never participate. Allocation and reallocation happen inside the RPCs only.';

create or replace function asset_reservations_check_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from bookings b
     where b.id = new.booking_id and b.org_id = new.org_id
  ) then
    raise exception 'booking % does not belong to this org', new.booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1 from booking_lines l
     where l.id = new.booking_line_id and l.org_id = new.org_id
       and l.booking_id = new.booking_id
  ) then
    raise exception 'booking line % does not belong to booking %',
      new.booking_line_id, new.booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1 from assets a
     where a.id = new.asset_id and a.org_id = new.org_id
       and a.deleted_at is null
  ) then
    raise exception 'asset % does not belong to this org', new.asset_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

drop trigger if exists asset_reservations_org on asset_reservations;
create trigger asset_reservations_org
  before insert or update of booking_id, booking_line_id, asset_id, org_id
  on asset_reservations
  for each row execute function asset_reservations_check_org();

alter table asset_reservations enable row level security;
alter table asset_reservations force row level security;

drop policy if exists asset_reservations_select on asset_reservations;
create policy asset_reservations_select on asset_reservations
  for select using (org_id = (select current_org_id()));

grant select on asset_reservations to papa_app;

-- ---------------------------------------------------------------------------
-- stock_reservations — bulk gets a time dimension (override 4, D6)
-- ---------------------------------------------------------------------------
create table if not exists stock_reservations (
  id               uuid primary key default uuid_generate_v7(),
  org_id           uuid not null references orgs(id) on delete restrict,
  booking_id       uuid not null references bookings(id) on delete restrict,
  booking_line_id  uuid not null references booking_lines(id) on delete restrict,
  product_id       uuid not null references products(id) on delete restrict,
  location_id      uuid references locations(id) on delete restrict,

  qty              integer not null,
  blocked_period   tstzrange not null,
  state            text not null,

  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  constraint stock_reservations_state_check
    check (state in ('pencil', 'confirmed')),
  constraint stock_reservations_qty_positive check (qty >= 1),
  constraint stock_reservations_period_bounded check (
    not isempty(blocked_period)
    and lower(blocked_period) is not null
    and upper(blocked_period) is not null
  )
);

create index if not exists stock_reservations_org_booking_idx
  on stock_reservations (org_id, booking_id) where deleted_at is null;
create index if not exists stock_reservations_product_period_idx
  on stock_reservations using gist (product_id, blocked_period)
  where deleted_at is null;

comment on table stock_reservations is
  'Quantity of a bulk product promised for a window (0022 D6). No exclusion constraint can count, so capacity is enforced by confirm_booking under a per-product advisory lock: max simultaneous confirmed qty over the window fits within on-hand.';

create or replace function stock_reservations_check_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from bookings b
     where b.id = new.booking_id and b.org_id = new.org_id
  ) then
    raise exception 'booking % does not belong to this org', new.booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1 from booking_lines l
     where l.id = new.booking_line_id and l.org_id = new.org_id
       and l.booking_id = new.booking_id
  ) then
    raise exception 'booking line % does not belong to booking %',
      new.booking_line_id, new.booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1 from products p
     where p.id = new.product_id and p.org_id = new.org_id
       and p.deleted_at is null
  ) then
    raise exception 'product % does not belong to this org', new.product_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end
$$;

drop trigger if exists stock_reservations_org on stock_reservations;
create trigger stock_reservations_org
  before insert or update of booking_id, booking_line_id, product_id, org_id
  on stock_reservations
  for each row execute function stock_reservations_check_org();

alter table stock_reservations enable row level security;
alter table stock_reservations force row level security;

drop policy if exists stock_reservations_select on stock_reservations;
create policy stock_reservations_select on stock_reservations
  for select using (org_id = (select current_org_id()));

grant select on stock_reservations to papa_app;

-- ---------------------------------------------------------------------------
-- jobs.booking_id — the bridge to the scan world (D8)
-- ---------------------------------------------------------------------------
alter table jobs add column if not exists booking_id uuid
  references bookings(id) on delete restrict;

-- One live job per booking: the promise lands in the scan world once.
drop index if exists jobs_booking_id_live_idx;
create unique index jobs_booking_id_live_idx
  on jobs (booking_id) where booking_id is not null and deleted_at is null;

comment on column jobs.booking_id is
  'Set by convert_booking_to_job (0022 D8). One live job per booking. NOT in the pull projection yet — it syncs when the client wave builds the phone surface that reads it (D13).';

-- ---------------------------------------------------------------------------
-- Internal helpers (not granted)
-- ---------------------------------------------------------------------------

/**
 * Shared context/role/rate checks for every booking write — the 0017
 * money_write_context pattern, its own bucket.
 */
create or replace function booking_write_context(
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

  if not rate_limit_check('booking:' || o_org::text || ':' || o_user::text,
                          60, '1 minute') then
    raise exception 'too many booking writes; wait a moment'
      using errcode = 'too_many_connections';
  end if;
end
$$;

/**
 * Opportunistic pruning of expired pencils (D7). Called at the top of every
 * booking write RPC; reads never need it because expiry is a predicate.
 * DEFINER context of the caller; explicit org predicate.
 */
create or replace function prune_expired_pencils(p_org uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_expired uuid[];
begin
  select coalesce(array_agg(b.id), '{}') into v_expired
    from bookings b
   where b.org_id = p_org and b.status = 'pencil'
     and b.pencil_expires_at <= now() and b.deleted_at is null;

  update asset_reservations r
     set deleted_at = now()
   where r.org_id = p_org and r.deleted_at is null
     and r.booking_id = any (v_expired);

  update stock_reservations r
     set deleted_at = now()
   where r.org_id = p_org and r.deleted_at is null
     and r.booking_id = any (v_expired);

  update bookings b
     set status = 'cancelled',
         cancelled_at = now(),
         cancel_reason = 'pencil_expired'
   where b.org_id = p_org and b.id = any (v_expired);
end
$$;

/**
 * The per-product advisory lock every capacity decision runs under (D4,
 * D6): concurrent confirms and extensions of the same product serialize
 * here, so the peak each one reads is still true when it writes.
 * Transaction-scoped; released with the caller's commit or rollback.
 */
create or replace function booking_product_lock(p_org uuid, p_product uuid)
returns void
language sql
set search_path = public
as $$
  select pg_advisory_xact_lock(
    hashtextextended(p_org::text || ':' || p_product::text, 42))
$$;

/**
 * Shelf count of a bulk product: the movements ledger already subtracted
 * what is out. INVOKER on purpose — booking_availability runs as the caller
 * and RLS on stock_lots scopes it.
 */
create or replace function stock_on_hand(p_org uuid, p_product uuid)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce(sum(s.qty_on_hand), 0)::integer
    from stock_lots s
   where s.org_id = p_org and s.product_id = p_product
$$;

/**
 * Max simultaneous reserved qty of a bulk product over a window, in the
 * given state, optionally ignoring one booking (extension math re-checks
 * a window the booking itself already occupies).
 *
 * The maximum of a sum of intervals occurs at an interval start, so it is
 * enough to probe each overlapping reservation's start (clamped into the
 * window) plus the window start itself.
 */
create or replace function stock_reserved_peak(
  p_org uuid,
  p_product uuid,
  p_period tstzrange,
  p_state text,
  p_exclude_booking uuid default null
)
returns integer
language sql
stable
set search_path = public
as $$
  with live as (
    select r.qty, r.blocked_period
      from stock_reservations r
      join bookings b on b.id = r.booking_id
     where r.org_id = p_org and r.product_id = p_product
       and r.deleted_at is null and r.state = p_state
       and r.blocked_period && p_period
       and b.deleted_at is null
       and (p_exclude_booking is null or r.booking_id <> p_exclude_booking)
       -- a pencil claim only counts while it is alive (D7)
       and (p_state <> 'pencil'
            or (b.status = 'pencil' and b.pencil_expires_at > now()))
       and (p_state <> 'confirmed' or b.status = 'confirmed')
  ),
  probes as (
    select greatest(lower(blocked_period), lower(p_period)) as probe_at
      from live
    union select lower(p_period)
  )
  select coalesce(max(cover.total), 0)::integer
    from probes p
    cross join lateral (
      select sum(l.qty)::integer as total
        from live l where l.blocked_period @> p.probe_at
    ) cover
$$;

-- ---------------------------------------------------------------------------
-- booking_availability — the three-layer answer (D6)
--
-- INVOKER on purpose: pure read, RLS scopes it, and the desk client calls
-- it directly. See D6 in the header for what each layer means.
-- ---------------------------------------------------------------------------
create or replace function booking_availability(
  p_product_id uuid,
  p_period tstzrange
)
returns table (
  tracking_mode      text,
  here_now           integer,
  pencilled_overlap  integer,
  confirmed_overlap  integer,
  available          integer
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_mode text;
  v_here integer;
  v_pencil integer;
  v_conf integer;
begin
  if v_org is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;
  if p_period is null or isempty(p_period)
     or lower(p_period) is null or upper(p_period) is null then
    raise exception 'availability needs a bounded, non-empty period'
      using errcode = 'invalid_parameter_value';
  end if;

  select p.tracking_mode into v_mode
    from products p
   where p.id = p_product_id and p.org_id = v_org and p.deleted_at is null;
  if v_mode is null then
    raise exception 'product % does not belong to this org', p_product_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_mode = 'bulk' then
    v_here   := stock_on_hand(v_org, p_product_id);
    v_pencil := stock_reserved_peak(v_org, p_product_id, p_period, 'pencil');
    v_conf   := stock_reserved_peak(v_org, p_product_id, p_period, 'confirmed');
  else
    -- Serialized: the live, rentable fleet…
    select count(*)::integer into v_here
      from assets a
     where a.org_id = v_org and a.product_id = p_product_id
       and a.deleted_at is null and a.disposition is null
       and a.rentable and a.presence <> 'gone'
       -- …minus units physically out RIGHT NOW when the window starts
       -- now: gear on a truck cannot make a pickup that starts before it
       -- returns. A future window trusts the schedule instead — that is
       -- what the confirmed layer is for.
       and not (a.presence in ('out', 'in_transit')
                and lower(p_period) <= now());

    select count(distinct r.asset_id)::integer into v_conf
      from asset_reservations r
      join bookings b on b.id = r.booking_id
     where r.org_id = v_org and r.deleted_at is null
       and r.state = 'confirmed' and b.status = 'confirmed'
       and b.deleted_at is null
       and r.blocked_period && p_period
       and r.asset_id in (
         select a.id from assets a
          where a.org_id = v_org and a.product_id = p_product_id);

    -- Pencils on serialized products live at the LINE level (allocation
    -- has not happened yet), so the pencil layer counts asked-for qty.
    select coalesce(sum(l.qty), 0)::integer into v_pencil
      from booking_lines l
      join bookings b on b.id = l.booking_id
     where l.org_id = v_org and l.deleted_at is null
       and b.status = 'pencil' and b.pencil_expires_at > now()
       and b.deleted_at is null
       and b.blocked_period && p_period
       and (l.product_id = p_product_id
            or l.asset_id in (
              select a.id from assets a
               where a.org_id = v_org and a.product_id = p_product_id));
  end if;

  return query select v_mode, v_here, v_pencil, v_conf,
                      greatest(v_here - v_conf, 0);
end
$$;

comment on function booking_availability(uuid, tstzrange) is
  'Three-layer availability (0022 D6): here-now / pencilled (informational, never subtracted) / confirmed (subtracted). available = here_now − confirmed_overlap, floored at zero. INVOKER; RLS scopes it.';

grant execute on function booking_availability(uuid, tstzrange) to papa_app;

-- ---------------------------------------------------------------------------
-- create_booking (D2, D7, D12)
-- ---------------------------------------------------------------------------
create or replace function create_booking(
  p_customer_id      uuid,
  p_customer_period  tstzrange,
  p_lines            jsonb,
  p_status           text default 'pencil',
  p_note             text default null,
  p_pencil_ttl       interval default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_no   bigint;
  v_booking_id uuid := uuid_generate_v7();
  v_blocked tstzrange;
  v_prep_h numeric;
  v_turn_h numeric;
  v_ttl interval;
  v_expires timestamptz;
  v_line jsonb;
  v_line_id uuid;
  v_product products%rowtype;
  v_asset assets%rowtype;
  v_qty integer;
  v_line_count integer := 0;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager', 'desk']);

  perform prune_expired_pencils(v_org);

  if p_status not in ('draft', 'pencil') then
    raise exception 'a booking is created as draft or pencil; confirmed goes through confirm_booking'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_customer_period is null or isempty(p_customer_period)
     or lower(p_customer_period) is null or upper(p_customer_period) is null then
    raise exception 'a booking needs a bounded, non-empty customer period'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from customers c
     where c.id = p_customer_id and c.org_id = v_org and c.deleted_at is null
  ) then
    raise exception 'customer % does not belong to this org', p_customer_id
      using errcode = 'foreign_key_violation';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'a booking needs at least one line'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ASSUMPTION: prep 2h before, turnaround 4h after — the architecture's
  -- illustrative numbers promoted to defaults, org-tunable. See
  -- docs/assumptions.md#buffer-defaults. Override 7: buffers are stored
  -- into blocked_period here, shortenable per booking at confirm.
  select coalesce(nullif(o.settings ->> 'prep_buffer_hours', '')::numeric, 2),
         coalesce(nullif(o.settings ->> 'turnaround_buffer_hours', '')::numeric, 4)
    into v_prep_h, v_turn_h
    from orgs o where o.id = v_org;

  v_blocked := tstzrange(
    lower(p_customer_period) - make_interval(mins => (v_prep_h * 60)::int),
    upper(p_customer_period) + make_interval(mins => (v_turn_h * 60)::int),
    '[)');

  if p_status = 'pencil' then
    -- ASSUMPTION: 24h TTL. See docs/assumptions.md#hold-ttl.
    select coalesce(
             p_pencil_ttl,
             (nullif(o.settings ->> 'pencil_ttl_hours', '')::numeric
                * interval '1 hour'),
             interval '24 hours')
      into v_ttl
      from orgs o where o.id = v_org;
    if v_ttl <= interval '0' then
      raise exception 'a pencil TTL must be positive'
        using errcode = 'invalid_parameter_value';
    end if;
    v_expires := now() + v_ttl;
  end if;

  -- D12: the gapless number. The counter row lock serializes concurrent
  -- creators; a rolled-back create takes its number down with it. Two
  -- statements on purpose: the no-op insert settles first-ever races on
  -- the unique index, the update takes the row lock and hands out the
  -- number in the same transaction as the booking insert below.
  insert into booking_counters (org_id) values (v_org)
  on conflict (org_id) do nothing;
  update booking_counters bc
     set next_no = bc.next_no + 1
   where bc.org_id = v_org
  returning bc.next_no - 1 into v_no;

  insert into bookings (id, org_id, booking_no, customer_id, status,
                        customer_period, blocked_period, pencil_expires_at,
                        note, created_by)
  values (v_booking_id, v_org, v_no, p_customer_id, p_status,
          p_customer_period, v_blocked, v_expires, p_note, v_user);

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_line_id := uuid_generate_v7();
    v_line_count := v_line_count + 1;

    if nullif(v_line ->> 'asset_id', '') is not null then
      select a.* into v_asset
        from assets a
       where a.id = (v_line ->> 'asset_id')::uuid
         and a.org_id = v_org and a.deleted_at is null;
      if v_asset.id is null then
        raise exception 'asset % does not belong to this org', v_line ->> 'asset_id'
          using errcode = 'foreign_key_violation';
      end if;
      if v_asset.disposition is not null or not v_asset.rentable then
        raise exception 'asset % is not rentable (disposition %, rentable %)',
          v_asset.asset_code, coalesce(v_asset.disposition, 'none'), v_asset.rentable
          using errcode = 'check_violation';
      end if;

      insert into booking_lines (id, org_id, booking_id, asset_id, qty)
      values (v_line_id, v_org, v_booking_id, v_asset.id, 1);

      -- A pencil's claim on a demanded unit is recorded but NEVER blocks:
      -- state='pencil' rows sit outside the exclusion constraint (D3).
      if p_status = 'pencil' then
        insert into asset_reservations
          (org_id, booking_id, booking_line_id, asset_id, blocked_period, state)
        values (v_org, v_booking_id, v_line_id, v_asset.id, v_blocked, 'pencil');
      end if;

    elsif nullif(v_line ->> 'product_id', '') is not null then
      v_qty := coalesce(nullif(v_line ->> 'qty', '')::int, 1);
      if v_qty < 1 then
        raise exception 'line qty must be at least 1'
          using errcode = 'invalid_parameter_value';
      end if;
      select p.* into v_product
        from products p
       where p.id = (v_line ->> 'product_id')::uuid
         and p.org_id = v_org and p.deleted_at is null;
      if v_product.id is null then
        raise exception 'product % does not belong to this org', v_line ->> 'product_id'
          using errcode = 'foreign_key_violation';
      end if;
      if v_product.tracking_mode = 'consumable' then
        raise exception 'consumables are sold, not booked: %', v_product.display_name
          using errcode = 'check_violation';
      end if;

      insert into booking_lines (id, org_id, booking_id, product_id, qty)
      values (v_line_id, v_org, v_booking_id, v_product.id, v_qty);

      if p_status = 'pencil' and v_product.tracking_mode = 'bulk' then
        insert into stock_reservations
          (org_id, booking_id, booking_line_id, product_id, qty,
           blocked_period, state)
        values (v_org, v_booking_id, v_line_id, v_product.id, v_qty,
                v_blocked, 'pencil');
      end if;
    else
      raise exception 'line % must name a product_id or an asset_id', v_line_count
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  return jsonb_build_object(
    'booking_id', v_booking_id,
    'booking_no', v_no,
    'status', p_status,
    'customer_period', jsonb_build_object(
      'from', lower(p_customer_period), 'until', upper(p_customer_period)),
    'blocked_period', jsonb_build_object(
      'from', lower(v_blocked), 'until', upper(v_blocked)),
    'pencil_expires_at', v_expires);
end
$$;

comment on function create_booking(uuid, tstzrange, jsonb, text, text, interval) is
  'The only way a booking is born (0022 D11/D12): gapless number, buffers computed into blocked_period (override 7), pencil TTL stamped (ASSUMPTION #hold-ttl). Lines: {product_id, qty} or {asset_id}. Desk and up.';

grant execute on function create_booking(uuid, tstzrange, jsonb, text, text, interval)
  to papa_app;

-- ---------------------------------------------------------------------------
-- confirm_booking — allocation, the credential gate, the constraint (D4, D9)
-- ---------------------------------------------------------------------------
create or replace function confirm_booking(
  p_booking_id               uuid,
  p_blocked_period           tstzrange default null,
  p_credential_override_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_b bookings%rowtype;
  v_blocked tstzrange;
  v_exposure bigint;
  v_line record;
  v_picked uuid[] := '{}';
  v_asset_id uuid;
  v_needed integer;
  v_on_hand integer;
  v_peak integer;
  v_allocations jsonb := '[]'::jsonb;
  v_blk_no bigint;
  v_blk_code text;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager', 'desk']);

  perform prune_expired_pencils(v_org);

  select b.* into v_b
    from bookings b
   where b.id = p_booking_id and b.org_id = v_org and b.deleted_at is null
   for update;
  if v_b.id is null then
    raise exception 'booking % does not belong to this org', p_booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_b.status = 'cancelled' then
    raise exception 'booking #% is cancelled (%)', v_b.booking_no,
      coalesce(v_b.cancel_reason, 'no reason recorded')
      using errcode = 'check_violation';
  end if;
  if v_b.status = 'confirmed' then
    raise exception 'booking #% is already confirmed', v_b.booking_no
      using errcode = 'check_violation';
  end if;

  -- Blacklist is refusal, not paperwork (0017 rule).
  if exists (
    select 1 from customers c
     where c.id = v_b.customer_id and c.org_id = v_org and c.blacklisted
  ) then
    raise exception 'customer is blacklisted; a booking cannot be confirmed'
      using errcode = 'check_violation';
  end if;

  -- D9: the credential gate. Exposure = replacement value promised.
  select coalesce(sum(
           case when l.asset_id is not null
                then coalesce(p_a.replacement_value_minor, 0)
                else l.qty * coalesce(p_p.replacement_value_minor, 0) end), 0)
    into v_exposure
    from booking_lines l
    left join products p_p on p_p.id = l.product_id
    left join assets a on a.id = l.asset_id
    left join products p_a on p_a.id = a.product_id
   where l.booking_id = v_b.id and l.org_id = v_org and l.deleted_at is null;

  if customer_needs_credentials(v_b.customer_id, v_exposure) then
    if p_credential_override_note is null
       or length(trim(p_credential_override_note)) = 0 then
      raise exception 'customer needs credentials on file before a promise this size (exposure % minor); a manager can override with a logged note',
        v_exposure
        using errcode = 'insufficient_privilege';
    end if;
    -- Override 16: "overridable by a manager with a logged reason."
    perform require_role('owner', 'manager');
    update bookings
       set credential_override_note = trim(p_credential_override_note),
           credential_override_by = v_user,
           credential_override_at = now()
     where id = v_b.id and org_id = v_org;
  end if;

  -- Override 7: shortenable at confirm — but never below what the client
  -- was promised.
  v_blocked := coalesce(p_blocked_period, v_b.blocked_period);
  if isempty(v_blocked)
     or lower(v_blocked) is null or upper(v_blocked) is null then
    raise exception 'blocked period must be bounded and non-empty'
      using errcode = 'check_violation';
  end if;
  if not v_blocked @> v_b.customer_period then
    raise exception 'blocked period must still cover the customer period'
      using errcode = 'check_violation';
  end if;

  -- Units this booking demands BY NAME are spoken for before the auto-pick
  -- runs, whatever order the lines arrive in — otherwise the allocator
  -- could hand line 1 the exact unit line 2 demands and collide with
  -- itself inside its own transaction.
  select coalesce(array_agg(l.asset_id), '{}') into v_picked
    from booking_lines l
   where l.booking_id = v_b.id and l.org_id = v_org
     and l.asset_id is not null and l.deleted_at is null;

  begin
    for v_line in
      select l.id, l.product_id, l.asset_id, l.qty,
             p.tracking_mode, p.display_name
        from booking_lines l
        left join products p on p.id = l.product_id
       where l.booking_id = v_b.id and l.org_id = v_org and l.deleted_at is null
       order by l.created_at, l.id
    loop
      if v_line.asset_id is not null then
        -- The demanded unit. Upgrade its pencil claim if one exists, else
        -- claim it now — either way the constraint has the final word.
        update asset_reservations r
           set state = 'confirmed', blocked_period = v_blocked
         where r.org_id = v_org and r.booking_id = v_b.id
           and r.booking_line_id = v_line.id and r.deleted_at is null;
        if not found then
          insert into asset_reservations
            (org_id, booking_id, booking_line_id, asset_id,
             blocked_period, state)
          values (v_org, v_b.id, v_line.id, v_line.asset_id,
                  v_blocked, 'confirmed');
        end if;
        v_picked := v_picked || v_line.asset_id;
        v_allocations := v_allocations || jsonb_build_object(
          'booking_line_id', v_line.id, 'asset_id', v_line.asset_id);

      elsif v_line.tracking_mode = 'bulk' then
        -- D6: capacity under the per-product advisory lock.
        perform booking_product_lock(v_org, v_line.product_id);

        v_on_hand := stock_on_hand(v_org, v_line.product_id);
        v_peak := stock_reserved_peak(
          v_org, v_line.product_id, v_blocked, 'confirmed', v_b.id);

        if v_on_hand - v_peak < v_line.qty then
          select b2.booking_no into v_blk_no
            from stock_reservations r2
            join bookings b2 on b2.id = r2.booking_id
           where r2.org_id = v_org and r2.product_id = v_line.product_id
             and r2.deleted_at is null and r2.state = 'confirmed'
             and b2.status = 'confirmed' and b2.deleted_at is null
             and r2.blocked_period && v_blocked
           order by b2.booking_no limit 1;
          raise exception 'only % of % × % available for this window; % already promised (booking #%)',
            greatest(v_on_hand - v_peak, 0), v_line.qty, v_line.display_name,
            v_peak, coalesce(v_blk_no, 0)
            using errcode = 'check_violation';
        end if;

        -- Upgrade the pencil claim, else write the confirmed one.
        update stock_reservations r
           set state = 'confirmed', blocked_period = v_blocked
         where r.org_id = v_org and r.booking_id = v_b.id
           and r.booking_line_id = v_line.id and r.deleted_at is null;
        if not found then
          insert into stock_reservations
            (org_id, booking_id, booking_line_id, product_id, qty,
             blocked_period, state)
          values (v_org, v_b.id, v_line.id, v_line.product_id, v_line.qty,
                  v_blocked, 'confirmed');
        end if;

      else
        -- D4: serialized allocation, least-utilised first, under the same
        -- advisory lock so concurrent confirms pick different units.
        perform booking_product_lock(v_org, v_line.product_id);

        v_needed := v_line.qty;
        for v_asset_id in
          select a.id
            from assets a
           where a.org_id = v_org and a.product_id = v_line.product_id
             and a.deleted_at is null and a.disposition is null
             and a.rentable and a.presence <> 'gone'
             and a.id <> all (v_picked)
             and not exists (
               select 1 from asset_reservations r
                where r.asset_id = a.id and r.deleted_at is null
                  and r.state = 'confirmed'
                  and r.blocked_period && v_blocked)
           order by coalesce(a.rental_days_since_service, 0),
                    coalesce(a.cycle_count, 0),
                    a.asset_code, a.id
           limit v_line.qty
        loop
          insert into asset_reservations
            (org_id, booking_id, booking_line_id, asset_id,
             blocked_period, state)
          values (v_org, v_b.id, v_line.id, v_asset_id, v_blocked, 'confirmed');
          v_picked := v_picked || v_asset_id;
          v_needed := v_needed - 1;
          v_allocations := v_allocations || jsonb_build_object(
            'booking_line_id', v_line.id, 'asset_id', v_asset_id);
        end loop;

        if v_needed > 0 then
          raise exception 'only % of % × % available for this window',
            v_line.qty - v_needed, v_line.qty, v_line.display_name
            using errcode = 'check_violation';
        end if;
      end if;
    end loop;
  exception when exclusion_violation then
    -- D5: name the winner instead of leaking 23P01 noise. The blocked
    -- asset is whichever of ours now overlaps a foreign confirmed claim.
    -- v_picked was seeded with every demanded unit before the loop and
    -- plpgsql variables survive the rollback, so it is the full list.
    select a.asset_code, b2.booking_no
      into v_blk_code, v_blk_no
      from asset_reservations r2
      join bookings b2 on b2.id = r2.booking_id
      join assets a on a.id = r2.asset_id
     where r2.org_id = v_org and r2.deleted_at is null
       and r2.state = 'confirmed' and r2.booking_id <> v_b.id
       and r2.blocked_period && v_blocked
       and r2.asset_id = any (v_picked)
     order by b2.booking_no limit 1;
    raise exception 'asset % is already promised to booking #%',
      coalesce(v_blk_code, 'unit'), coalesce(v_blk_no, 0)
      using errcode = 'exclusion_violation';
  end;

  update bookings
     set status = 'confirmed',
         blocked_period = v_blocked,
         pencil_expires_at = null
   where id = v_b.id and org_id = v_org;

  return jsonb_build_object(
    'booking_id', v_b.id,
    'booking_no', v_b.booking_no,
    'status', 'confirmed',
    'blocked_period', jsonb_build_object(
      'from', lower(v_blocked), 'until', upper(v_blocked)),
    'exposure_minor', v_exposure,
    'allocations', v_allocations);
end
$$;

comment on function confirm_booking(uuid, tstzrange, text) is
  'Confirm = allocate (0022 D4, override 3): specific least-utilised units bound in this one transaction, bulk capacity enforced under a per-product advisory lock, the credential gate (D9, override 16), the shortenable buffer (override 7). An exclusion violation surfaces as "already promised to booking #N" (D5).';

grant execute on function confirm_booking(uuid, tstzrange, text) to papa_app;

-- ---------------------------------------------------------------------------
-- reallocate_reservation — the UPDATE the constraint re-checks (D4)
-- ---------------------------------------------------------------------------
create or replace function reallocate_reservation(
  p_reservation_id uuid,
  p_new_asset_id   uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_r asset_reservations%rowtype;
  v_old_product uuid;
  v_new assets%rowtype;
  v_blk_no bigint;
begin
  select o_org into v_org
    from booking_write_context(array['owner', 'manager', 'desk']);

  select r.* into v_r
    from asset_reservations r
   where r.id = p_reservation_id and r.org_id = v_org and r.deleted_at is null
   for update;
  if v_r.id is null then
    raise exception 'reservation % does not belong to this org', p_reservation_id
      using errcode = 'foreign_key_violation';
  end if;

  select a.product_id into v_old_product
    from assets a where a.id = v_r.asset_id;

  select a.* into v_new
    from assets a
   where a.id = p_new_asset_id and a.org_id = v_org and a.deleted_at is null;
  if v_new.id is null then
    raise exception 'asset % does not belong to this org', p_new_asset_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_new.product_id is distinct from v_old_product then
    raise exception 'substitute must be the same product'
      using errcode = 'check_violation';
  end if;
  if v_new.disposition is not null or not v_new.rentable then
    raise exception 'asset % is not rentable', v_new.asset_code
      using errcode = 'check_violation';
  end if;

  begin
    update asset_reservations
       set asset_id = p_new_asset_id
     where id = v_r.id and org_id = v_org;
  exception when exclusion_violation then
    select b2.booking_no into v_blk_no
      from asset_reservations r2
      join bookings b2 on b2.id = r2.booking_id
     where r2.org_id = v_org and r2.asset_id = p_new_asset_id
       and r2.deleted_at is null and r2.state = 'confirmed'
       and r2.blocked_period && v_r.blocked_period
       and r2.id <> v_r.id
     order by b2.booking_no limit 1;
    raise exception 'asset % is already promised to booking #%',
      v_new.asset_code, coalesce(v_blk_no, 0)
      using errcode = 'exclusion_violation';
  end;
end
$$;

comment on function reallocate_reservation(uuid, uuid) is
  'Override 3: reallocation is an UPDATE ... SET asset_id, re-checked by the exclusion constraint. Same product, fit units only; a collision names the winning booking.';

grant execute on function reallocate_reservation(uuid, uuid) to papa_app;

-- ---------------------------------------------------------------------------
-- cancel_booking
-- ---------------------------------------------------------------------------
create or replace function cancel_booking(
  p_booking_id uuid,
  p_reason     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_b bookings%rowtype;
  v_job record;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager', 'desk']);

  perform prune_expired_pencils(v_org);

  select b.* into v_b
    from bookings b
   where b.id = p_booking_id and b.org_id = v_org and b.deleted_at is null
   for update;
  if v_b.id is null then
    raise exception 'booking % does not belong to this org', p_booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_b.status = 'cancelled' then
    raise exception 'booking #% is already cancelled', v_b.booking_no
      using errcode = 'check_violation';
  end if;

  -- Once the promise became a live job, the job world owns the story.
  select j.id, j.label into v_job
    from jobs j
   where j.booking_id = v_b.id and j.org_id = v_org
     and j.deleted_at is null and j.status = 'open'
   limit 1;
  if v_job.id is not null then
    raise exception 'booking #% is out on job "%" — close or cancel the job first',
      v_b.booking_no, v_job.label
      using errcode = 'check_violation';
  end if;

  update asset_reservations r set deleted_at = now()
   where r.org_id = v_org and r.booking_id = v_b.id and r.deleted_at is null;
  update stock_reservations r set deleted_at = now()
   where r.org_id = v_org and r.booking_id = v_b.id and r.deleted_at is null;

  update bookings
     set status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = v_user,
         cancel_reason = nullif(trim(coalesce(p_reason, '')), ''),
         pencil_expires_at = null
   where id = v_b.id and org_id = v_org;
end
$$;

comment on function cancel_booking(uuid, text) is
  'Cancels a booking and releases every live reservation. Refused while a live job carries the gear — the scan world owns that story. Desk and up.';

grant execute on function cancel_booking(uuid, text) to papa_app;

-- ---------------------------------------------------------------------------
-- extend_booking — THE extension-collision data (D10)
-- ---------------------------------------------------------------------------
create or replace function extend_booking(
  p_booking_id       uuid,
  p_new_customer_end timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_b bookings%rowtype;
  v_new_customer tstzrange;
  v_new_blocked tstzrange;
  v_tail interval;
  v_collisions jsonb := '[]'::jsonb;
  v_c record;
  v_line record;
  v_on_hand integer;
  v_peak integer;
begin
  select o_org into v_org
    from booking_write_context(array['owner', 'manager', 'desk']);

  perform prune_expired_pencils(v_org);

  select b.* into v_b
    from bookings b
   where b.id = p_booking_id and b.org_id = v_org and b.deleted_at is null
   for update;
  if v_b.id is null then
    raise exception 'booking % does not belong to this org', p_booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_b.status = 'cancelled' then
    raise exception 'booking #% is cancelled', v_b.booking_no
      using errcode = 'check_violation';
  end if;
  if p_new_customer_end <= lower(v_b.customer_period) then
    raise exception 'the new end must fall after the booking starts'
      using errcode = 'check_violation';
  end if;

  -- Preserve whatever buffer tail this booking actually has — a confirm-
  -- time shortening (override 7) must survive the extension.
  v_tail := upper(v_b.blocked_period) - upper(v_b.customer_period);
  v_new_customer := tstzrange(lower(v_b.customer_period),
                              p_new_customer_end, '[)');
  v_new_blocked  := tstzrange(lower(v_b.blocked_period),
                              p_new_customer_end + v_tail, '[)');

  if v_b.status = 'confirmed' then
    -- Which downstream confirmed promises does the new window break?
    for v_c in
      select distinct b2.id as booking_id, b2.booking_no,
             c2.name as customer_name,
             r2.asset_id, a2.asset_code,
             p2.id as product_id, p2.display_name as product_name,
             lower(r2.blocked_period) as their_from,
             upper(r2.blocked_period) as their_until
        from asset_reservations r
        join asset_reservations r2
          on r2.asset_id = r.asset_id and r2.deleted_at is null
         and r2.state = 'confirmed' and r2.booking_id <> v_b.id
         and r2.blocked_period && v_new_blocked
        join bookings b2 on b2.id = r2.booking_id
         and b2.status = 'confirmed' and b2.deleted_at is null
        join customers c2 on c2.id = b2.customer_id
        join assets a2 on a2.id = r2.asset_id
        join products p2 on p2.id = a2.product_id
       where r.org_id = v_org and r.booking_id = v_b.id
         and r.deleted_at is null and r.state = 'confirmed'
       order by b2.booking_no, a2.asset_code
    loop
      v_collisions := v_collisions || jsonb_build_object(
        'kind', 'asset',
        'booking_id', v_c.booking_id,
        'booking_no', v_c.booking_no,
        'customer_name', v_c.customer_name,
        'asset_id', v_c.asset_id,
        'asset_code', v_c.asset_code,
        'product_id', v_c.product_id,
        'product_name', v_c.product_name,
        'their_from', v_c.their_from,
        'their_until', v_c.their_until);
    end loop;

    -- Bulk: does the extended window still fit within capacity?
    for v_line in
      select r.product_id, r.qty, p.display_name
        from stock_reservations r
        join products p on p.id = r.product_id
       where r.org_id = v_org and r.booking_id = v_b.id
         and r.deleted_at is null and r.state = 'confirmed'
    loop
      perform booking_product_lock(v_org, v_line.product_id);

      v_on_hand := stock_on_hand(v_org, v_line.product_id);
      v_peak := stock_reserved_peak(
        v_org, v_line.product_id, v_new_blocked, 'confirmed', v_b.id);

      if v_on_hand - v_peak < v_line.qty then
        for v_c in
          select distinct b2.id as booking_id, b2.booking_no,
                 c2.name as customer_name,
                 r2.qty, p2.id as product_id,
                 p2.display_name as product_name,
                 lower(r2.blocked_period) as their_from,
                 upper(r2.blocked_period) as their_until
            from stock_reservations r2
            join bookings b2 on b2.id = r2.booking_id
             and b2.status = 'confirmed' and b2.deleted_at is null
            join customers c2 on c2.id = b2.customer_id
            join products p2 on p2.id = r2.product_id
           where r2.org_id = v_org and r2.product_id = v_line.product_id
             and r2.deleted_at is null and r2.state = 'confirmed'
             and r2.booking_id <> v_b.id
             and r2.blocked_period && v_new_blocked
           order by b2.booking_no
        loop
          v_collisions := v_collisions || jsonb_build_object(
            'kind', 'bulk',
            'booking_id', v_c.booking_id,
            'booking_no', v_c.booking_no,
            'customer_name', v_c.customer_name,
            'qty', v_c.qty,
            'product_id', v_c.product_id,
            'product_name', v_c.product_name,
            'their_from', v_c.their_from,
            'their_until', v_c.their_until);
        end loop;
      end if;
    end loop;

    if jsonb_array_length(v_collisions) > 0 then
      -- D10: the decision screen's data, not an exception. Extending a
      -- future promise is schedule intent — it may be refused; the desk
      -- now knows exactly whom to call, substitute or sub-rent for.
      return jsonb_build_object(
        'extended', false,
        'booking_id', v_b.id,
        'booking_no', v_b.booking_no,
        'collisions', v_collisions);
    end if;
  end if;

  begin
    update asset_reservations r
       set blocked_period = v_new_blocked
     where r.org_id = v_org and r.booking_id = v_b.id
       and r.deleted_at is null;
    update stock_reservations r
       set blocked_period = v_new_blocked
     where r.org_id = v_org and r.booking_id = v_b.id
       and r.deleted_at is null;
  exception when exclusion_violation then
    -- A rival confirm slid in between our read and our write. Same
    -- nameable surface as D5.
    raise exception 'a booking was just confirmed over the extended window; re-run the extension to see it'
      using errcode = 'exclusion_violation';
  end;

  update bookings
     set customer_period = v_new_customer,
         blocked_period = v_new_blocked
   where id = v_b.id and org_id = v_org;

  return jsonb_build_object(
    'extended', true,
    'booking_id', v_b.id,
    'booking_no', v_b.booking_no,
    'customer_period', jsonb_build_object(
      'from', lower(v_new_customer), 'until', upper(v_new_customer)),
    'blocked_period', jsonb_build_object(
      'from', lower(v_new_blocked), 'until', upper(v_new_blocked)),
    'collisions', '[]'::jsonb);
end
$$;

comment on function extend_booking(uuid, timestamptz) is
  'The extension-collision preview (0022 D10, PLAN phase 2): returns {extended, collisions[]} — every downstream confirmed booking the new end breaks, per asset and per bulk shortfall, with booking numbers and customer names. No collisions → it extends, preserving any confirm-time buffer shortening.';

grant execute on function extend_booking(uuid, timestamptz) to papa_app;

-- ---------------------------------------------------------------------------
-- convert_booking_to_job — the bridge (D8)
-- ---------------------------------------------------------------------------
create or replace function convert_booking_to_job(
  p_booking_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_b bookings%rowtype;
  v_customer customers%rowtype;
  v_job_id uuid := uuid_generate_v7();
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager', 'desk']);

  perform prune_expired_pencils(v_org);

  select b.* into v_b
    from bookings b
   where b.id = p_booking_id and b.org_id = v_org and b.deleted_at is null
   for update;
  if v_b.id is null then
    raise exception 'booking % does not belong to this org', p_booking_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_b.status <> 'confirmed' then
    raise exception 'only a confirmed booking becomes a job (booking #% is %)',
      v_b.booking_no, v_b.status
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from jobs j
     where j.booking_id = v_b.id and j.org_id = v_org and j.deleted_at is null
  ) then
    raise exception 'booking #% already has its job', v_b.booking_no
      using errcode = 'check_violation';
  end if;

  select c.* into v_customer
    from customers c where c.id = v_b.customer_id and c.org_id = v_org;

  insert into jobs (id, org_id, label, contact, expected_back, status,
                    created_by, booking_id, customer_id)
  values (v_job_id, v_org,
          'B#' || v_b.booking_no || ' — ' || v_customer.name,
          v_customer.phone,
          upper(v_b.customer_period)::date,
          'open', v_user, v_b.id, v_b.customer_id);

  return v_job_id;
end
$$;

comment on function convert_booking_to_job(uuid) is
  'The bridge (0022 D8): a confirmed booking becomes the job the scan world runs. One live job per booking (partial unique on jobs.booking_id). From here, prepped/out/returned are the gear''s own scan events — never a booking status.';

grant execute on function convert_booking_to_job(uuid) to papa_app;

-- ---------------------------------------------------------------------------
-- Grants — every function is born with PUBLIC execute (the 0015 M1 lesson):
-- revoke the internals; the doors were granted beside their definitions.
-- ---------------------------------------------------------------------------
revoke all on function booking_write_context(text[])          from public;
revoke all on function prune_expired_pencils(uuid)            from public;
revoke all on function booking_product_lock(uuid, uuid)       from public;
revoke all on function bookings_check_customer_org()          from public;
revoke all on function booking_lines_check_org()              from public;
revoke all on function asset_reservations_check_org()         from public;
revoke all on function stock_reservations_check_org()         from public;

-- stock_on_hand and stock_reserved_peak are called by booking_availability,
-- which runs as the caller (INVOKER): papa_app needs execute, and RLS on
-- stock_lots / stock_reservations keeps a foreign p_org argument returning
-- zero rather than truth.
revoke all on function stock_on_hand(uuid, uuid) from public;
grant execute on function stock_on_hand(uuid, uuid) to papa_app;
revoke all on function stock_reserved_peak(uuid, uuid, tstzrange, text, uuid)
  from public;
grant execute on function stock_reserved_peak(uuid, uuid, tstzrange, text, uuid)
  to papa_app;
