-- ============================================================================
-- 0001 — Tenancy, identity, roles
--
-- Multi-tenant from day one. Every tenant row carries org_id NOT NULL, every
-- tenant table has an RLS policy scoped to it, and org_id is the FIRST column
-- of every composite index.
--
-- This migration is deliberately small and deliberately first. Multi-tenancy
-- cannot be retrofitted, and the RLS test harness is much harder to add once
-- thirty-five tables exist.
--
-- Conventions (see CONTRIBUTING.md):
--   TEXT not VARCHAR · UUID PKs (v7, time-ordered) · TIMESTAMPTZ, always UTC
--   soft delete via deleted_at · snake_case · money as BIGINT minor units
--   FKs ON in the core graph, ON DELETE RESTRICT, never CASCADE
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- uuid_generate_v7()
--
-- Time-ordered UUIDs. Two reasons this matters here and a v4 would not do:
--   1. Index locality. Random v4 PKs scatter B-tree inserts across the whole
--      index; assets and scan_events are insert-heavy and append-shaped.
--   2. Client-generated IDs sort meaningfully. Devices mint their own IDs
--      offline (that is what removes the ID-remapping problem from the sync
--      design), and a time-ordered ID makes the event log naturally ordered
--      even before server_time is assigned.
--
-- Layout per RFC 9562: 48-bit big-endian ms timestamp, 4-bit version, 74 bits
-- of randomness, 2-bit variant.
-- ---------------------------------------------------------------------------
create or replace function uuid_generate_v7()
returns uuid
language plpgsql
volatile
as $$
declare
  unix_ts_ms bytea;
  uuid_bytes bytea;
begin
  -- int8send gives 8 bytes big-endian; drop the top 2 to get a 48-bit stamp.
  unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);

  -- 10 random bytes fill the rest; version and variant are then overwritten.
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);

  -- Plain integer arithmetic rather than bit-string concatenation: `b'0111' ||
  -- x::bit(8)` yields bit(12), not bit(8), which silently produces version 0
  -- UUIDs. The first draft of this function did exactly that.
  --
  -- byte 6: high nibble := 0111 (version 7), low nibble kept
  uuid_bytes := set_byte(uuid_bytes, 6, 112 + (get_byte(uuid_bytes, 6) & 15));
  -- byte 8: high two bits := 10 (RFC 4122 variant), low six bits kept
  uuid_bytes := set_byte(uuid_bytes, 8, 128 + (get_byte(uuid_bytes, 8) & 63));

  return encode(uuid_bytes, 'hex')::uuid;
end
$$;

comment on function uuid_generate_v7() is
  'RFC 9562 UUIDv7. Time-ordered for index locality and for meaningful sort of client-generated offline IDs.';

-- ---------------------------------------------------------------------------
-- orgs — a rental house
-- ---------------------------------------------------------------------------
create table orgs (
  id          uuid primary key default uuid_generate_v7(),
  name        text not null,
  slug        text not null,
  country     text not null default 'PK',
  currency    text not null default 'PKR',
  timezone    text not null default 'Asia/Karachi',

  -- Org-level policy that the rest of the system reads rather than hardcoding:
  -- week_equals_days (3 by default — a week bills as three day-rates, not
  -- seven), weekend day-mask, prep/turnaround buffer hours, the value
  -- threshold above which a new customer needs credentials. Kept as jsonb
  -- because these are settings, not a schema.
  settings    jsonb not null default '{}'::jsonb,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Unique among live orgs only, so a deleted org's slug can be reused.
create unique index orgs_slug_live_idx on orgs (slug) where deleted_at is null;

comment on column orgs.settings is
  'Org policy: week_equals_days, weekend_mask, prep_buffer_hours, turnaround_buffer_hours, new_customer_value_threshold_minor. See docs/assumptions.md — several defaults are unvalidated guesses.';

-- ---------------------------------------------------------------------------
-- users — profile, mirroring the auth provider's user
--
-- NOT org-scoped: one person can work at two rental houses. Authorization
-- lives entirely in memberships.
-- ---------------------------------------------------------------------------
create table users (
  id            uuid primary key,   -- equals auth.users.id in Supabase
  display_name  text not null,
  phone         text,
  avatar_path   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create unique index users_phone_live_idx on users (phone)
  where phone is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- memberships — the join, and the whole authorization model
--
-- Roles are a fixed enum with a capability matrix in code, not an arbitrary
-- RBAC table. A rental house has five role shapes, not a permission system;
-- a table would be over-engineering. permissions jsonb is the escape hatch
-- for "let Bilal void invoices but nothing else".
-- ---------------------------------------------------------------------------
create table memberships (
  id           uuid primary key default uuid_generate_v7(),
  org_id       uuid not null references orgs(id) on delete restrict,
  user_id      uuid not null references users(id) on delete restrict,

  role         text not null,
  permissions  jsonb not null default '{}'::jsonb,
  status       text not null default 'active',

  -- PIN is primary auth on shared warehouse devices; OTP is enrollment-only.
  -- This is not a preference: incumbent RMS users lost jobs to OTP lockouts,
  -- and an auth wall at 6am on a loading dock is an existential failure.
  -- Stored as a bcrypt/argon hash, never the PIN.
  pin_hash     text,
  pin_set_at   timestamptz,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  constraint memberships_role_check
    check (role in ('owner', 'manager', 'desk', 'warehouse', 'driver', 'readonly')),
  constraint memberships_status_check
    check (status in ('active', 'suspended'))
);

-- One live membership per person per org.
create unique index memberships_org_user_live_idx
  on memberships (org_id, user_id) where deleted_at is null;

-- org_id first, always — this is the access path for every policy check.
create index memberships_org_role_idx
  on memberships (org_id, role) where deleted_at is null;
create index memberships_user_idx
  on memberships (user_id) where deleted_at is null;

comment on table memberships is
  'The authorization model. Role is a fixed enum with a capability matrix in code; permissions jsonb is a per-user escape hatch, not a general RBAC system.';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- One trigger function reused by every table, rather than one per table.
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger orgs_updated_at        before update on orgs        for each row execute function set_updated_at();
create trigger users_updated_at       before update on users       for each row execute function set_updated_at();
create trigger memberships_updated_at before update on memberships for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- current_org_id() / current_user_id()
--
-- Read from JWT claims set at login. Multi-org users switch orgs by
-- re-minting the token, which forces a full local re-sync — so it is a
-- deliberate, rare action rather than a dropdown you flick.
--
-- STABLE, not VOLATILE: the planner can then hoist it out of the RLS
-- predicate instead of re-evaluating per row, which is the difference
-- between an index scan and a seq scan on a large table.
--
-- The current_setting fallbacks let tests set the context directly without
-- minting a JWT.
-- ---------------------------------------------------------------------------
create or replace function current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.org_id', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id'),
      current_setting('papa.org_id', true)
    ), ''
  )::uuid
$$;

create or replace function current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'),
      current_setting('papa.user_id', true)
    ), ''
  )::uuid
$$;

-- Does the caller hold one of these roles in the current org?
create or replace function has_role(variadic roles text[])
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from memberships m
    where m.org_id  = current_org_id()
      and m.user_id = current_user_id()
      and m.status  = 'active'
      and m.deleted_at is null
      and m.role = any(roles)
  )
$$;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The phone never decides what it may see. Authorization is enforced three
-- times on purpose — RLS (can you see the row), the RPC body (may you perform
-- this operation), and the UI (should we render the button) — but only the
-- first two are security.
-- ---------------------------------------------------------------------------
alter table orgs        enable row level security;
alter table users       enable row level security;
alter table memberships enable row level security;

-- Force RLS for table owners too. Without this, the migration role and any
-- SECURITY DEFINER function owned by it silently bypass every policy, which
-- is exactly the hole that makes a leak test pass while the app leaks.
alter table orgs        force row level security;
alter table users       force row level security;
alter table memberships force row level security;

-- You see your own org, and only while you hold a live active membership.
create policy orgs_select on orgs
  for select using (
    id = current_org_id()
    and exists (
      select 1 from memberships m
      where m.org_id = orgs.id
        and m.user_id = current_user_id()
        and m.status = 'active'
        and m.deleted_at is null
    )
  );

-- Only an owner may change the org record itself.
create policy orgs_update on orgs
  for update using (id = current_org_id() and has_role('owner'))
  with check (id = current_org_id());

-- You see yourself, plus anyone you share a live org with. Scoped this way
-- rather than "all users" because the scanner shows actor names on every
-- event and needs them offline.
create policy users_select on users
  for select using (
    id = current_user_id()
    or exists (
      select 1
      from memberships mine
      join memberships theirs on theirs.org_id = mine.org_id
      where mine.user_id  = current_user_id()
        and mine.org_id   = current_org_id()
        and mine.status   = 'active'
        and mine.deleted_at is null
        and theirs.user_id = users.id
        and theirs.deleted_at is null
    )
  );

create policy users_update_self on users
  for update using (id = current_user_id())
  with check (id = current_user_id());

-- Memberships are visible within your own org only.
create policy memberships_select on memberships
  for select using (org_id = current_org_id());


-- Staff changes are an owner/manager act. Writes still go through RPCs;
-- this is the backstop, not the gate.
create policy memberships_write on memberships
  for all using (org_id = current_org_id() and has_role('owner', 'manager'))
  with check (org_id = current_org_id() and has_role('owner', 'manager'));

-- ---------------------------------------------------------------------------
-- The application role
--
-- CRITICAL: superusers bypass RLS entirely, and FORCE ROW LEVEL SECURITY does
-- not change that — FORCE only removes the *table owner's* exemption. So an
-- RLS test run as postgres proves nothing at all: every policy is skipped and
-- every assertion about isolation passes vacuously.
--
-- This is not hypothetical. The first run of 0001_tenancy_test.sql executed as
-- postgres and the leak assertions failed loudly (one org saw two orgs), which
-- is the good version of this mistake. The bad version is a test suite that is
-- green while the application leaks.
--
-- Therefore: the app connects as papa_app, a NOSUPERUSER role, and every test
-- that asserts isolation must `set local role papa_app` first.
--
-- On Supabase this role maps to `authenticated`; the grants below are the same
-- shape. Kept as its own role so the schema is portable and testable against a
-- plain Postgres container.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'papa_app') then
    create role papa_app nologin nosuperuser nobypassrls;
  end if;
end
$$;

grant usage on schema public to papa_app;

-- No DELETE anywhere, by design: soft delete only, via deleted_at. Revoking it
-- at the grant level means a hard delete is not merely discouraged, it is
-- impossible for the application role.
grant select, insert, update on orgs, users, memberships to papa_app;

grant execute on function
  uuid_generate_v7(), current_org_id(), current_user_id(), has_role(text[])
  to papa_app;

comment on role papa_app is
  'Application role. NOSUPERUSER/NOBYPASSRLS so RLS actually applies. Maps to `authenticated` on Supabase. Has no DELETE: soft delete only.';
