-- ============================================================================
-- 0007 — Sessions, audit, rate limiting
--
-- The three security primitives a business needs that a hobby project skips.
-- Everything before this was about correctness; this is about what happens
-- when someone is careless, fired, or hostile.
--
-- What this does NOT do, so nobody mistakes it for finished: it does not
-- authenticate anyone. Issuing a session is the job of an auth provider
-- (Supabase Auth, phone OTP at enrolment). What lives here is everything
-- AFTER that — how long a session lives, how it dies, what gets recorded,
-- and what stops a script hammering the door.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- device_sessions — a session is a DEVICE plus a PERSON, not just a person
--
-- Warehouse phones are shared. Three techs, one scarred Android. If a session
-- were only "who logged in on Tuesday", every event for the rest of the week
-- would be attributed to them, and attribution IS the entire value of the
-- audit trail.
--
-- So the device holds a long-lived org session (it must — an OTP wall at 6am
-- on a dock loses jobs, which is documented history for the incumbents), and
-- a short per-user PIN gate decides whose name goes on a scan.
-- ---------------------------------------------------------------------------
create table device_sessions (
  id            uuid primary key default uuid_generate_v7(),
  org_id        uuid not null references orgs(id) on delete restrict,
  device_id     text not null references devices(id) on delete restrict,
  user_id       uuid not null references users(id) on delete restrict,

  -- Opaque, hashed. Never store a usable token: a database leak must not
  -- hand over live sessions on top of everything else.
  token_hash    text not null,

  issued_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),

  -- THE OFFLINE EXPOSURE WINDOW, made explicit rather than left implied.
  -- A device that cannot reach the server keeps working — that is the whole
  -- point of offline-first — but not forever. This is the outer bound on how
  -- long a fired employee's phone stays useful, and it cannot be reduced to
  -- zero without breaking the product. Owning it beats pretending.
  expires_at    timestamptz not null,

  revoked_at    timestamptz,
  revoked_by    uuid references users(id) on delete restrict,
  revoke_reason text,

  created_at    timestamptz not null default now()
);

create unique index device_sessions_token_idx on device_sessions (token_hash);
create index device_sessions_org_device_idx on device_sessions (org_id, device_id)
  where revoked_at is null;
create index device_sessions_user_idx on device_sessions (org_id, user_id)
  where revoked_at is null;

comment on column device_sessions.expires_at is
  'Maximum offline exposure. A device unreachable past this stops working. Cannot be zero without breaking offline-first; stated rather than hidden.';

-- ---------------------------------------------------------------------------
-- Revocation, and why it needs its own table
--
-- Suspending a membership is instant on the SERVER — RLS stops seeing rows the
-- moment status flips, which 0001 tests. It is NOT instant on a phone that is
-- offline, and no amount of server-side anything changes that.
--
-- This table is what the device checks on its next contact. The honest
-- security property is: "revoked within one connectivity window, and hard
-- limited by expires_at", not "revoked instantly".
-- ---------------------------------------------------------------------------
create table revocations (
  id          uuid primary key default uuid_generate_v7(),
  org_id      uuid not null references orgs(id) on delete restrict,
  scope       text not null,          -- device | user | org
  subject     text not null,          -- device_id, user_id or org_id as text
  reason      text,
  wipe_local  boolean not null default false,
  created_by  uuid references users(id) on delete restrict,
  created_at  timestamptz not null default now(),

  constraint revocations_scope_check check (scope in ('device', 'user', 'org'))
);

create index revocations_lookup_idx on revocations (org_id, scope, subject);

comment on table revocations is
  'Checked by a device on next contact. Revocation is "within one connectivity window", never instant — a phone in a basement cannot be told anything.';

-- ---------------------------------------------------------------------------
-- audit_log — for the things scan_events does not cover
--
-- scan_events is already the immutable record of physical reality. This is for
-- the ADMINISTRATIVE acts that move money or power and would otherwise leave
-- no trace: role changes, price overrides, write-offs, deposit refunds,
-- session revocations.
--
-- Append-only, enforced the same way as scan_events — by trigger AND by
-- withholding the grant, because either alone is one careless migration away
-- from being undone.
-- ---------------------------------------------------------------------------
create table audit_log (
  id           uuid primary key default uuid_generate_v7(),
  org_id       uuid not null,          -- deliberately NO fk: an audit row must
                                       -- survive its referent being deleted
  actor_user_id uuid,
  actor_label  text,                   -- denormalised, so it stays readable forever
  action       text not null,
  subject_type text,
  subject_id   uuid,
  subject_label text,
  detail       jsonb not null default '{}'::jsonb,
  ip           inet,
  device_id    text,
  created_at   timestamptz not null default now()
);

create index audit_log_org_time_idx on audit_log (org_id, created_at desc);
create index audit_log_subject_idx on audit_log (org_id, subject_type, subject_id);

create or replace function reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only'
    using errcode = 'restrict_violation';
end
$$;

create trigger audit_log_no_update
  before update on audit_log for each row execute function reject_audit_mutation();
create trigger audit_log_no_delete
  before delete on audit_log for each row execute function reject_audit_mutation();

/**
 * Record an administrative act.
 *
 * SECURITY DEFINER so the caller cannot choose not to be audited: papa_app has
 * no direct INSERT on audit_log, so the only way a row appears is through
 * here, and the actor is taken from the session rather than from an argument.
 */
create or replace function write_audit(
  p_action       text,
  p_subject_type text default null,
  p_subject_id   uuid default null,
  p_subject_label text default null,
  p_detail       jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_user uuid := current_user_id();
begin
  if v_org is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  insert into audit_log (org_id, actor_user_id, actor_label, action,
                         subject_type, subject_id, subject_label, detail)
  values (
    v_org, v_user,
    -- Denormalised NOW. A deleted or renamed user must not turn a year of
    -- audit history into a column of UUIDs.
    coalesce((select display_name from users where id = v_user), 'unknown'),
    p_action, p_subject_type, p_subject_id, p_subject_label, p_detail
  );
end
$$;

-- ---------------------------------------------------------------------------
-- Rate limiting
--
-- A fixed-window counter. Not the most elegant algorithm, and deliberately
-- chosen over a sliding log because it is ONE upsert per attempt: a rate
-- limiter that is itself expensive is a denial-of-service amplifier.
--
-- Three things need it, for three different reasons:
--   PIN attempts       — a 4-digit PIN is 10,000 guesses without one
--   public tag resolve — otherwise a competitor enumerates a fleet
--   scan submission    — a runaway client must not take the org down
-- ---------------------------------------------------------------------------
create table rate_limits (
  bucket       text not null,          -- 'pin:<device>', 'tag:<ip>', ...
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket, window_start)
);

create index rate_limits_cleanup_idx on rate_limits (window_start);

/**
 * Consume one unit. Returns true if allowed.
 *
 * SECURITY DEFINER: the limiter must work for callers who cannot write the
 * table, and a client able to reset its own counter is not a limiter.
 */
create or replace function rate_limit_check(
  p_bucket   text,
  p_limit    int,
  p_window   interval default '1 minute'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := date_bin(p_window, now(), timestamptz 'epoch');
  v_count  int;
begin
  insert into rate_limits (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set count = rate_limits.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end
$$;

/** Old windows are noise. Called by cron; safe to run any time. */
create or replace function prune_rate_limits(p_older_than interval default '1 day')
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  delete from rate_limits where window_start < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end
$$;

-- ---------------------------------------------------------------------------
-- The public tag resolver, now rate limited
--
-- 0004 argued this must return an identical shape for unknown, unbound and
-- retired codes so a fleet cannot be estimated from photographs. That argument
-- only holds if an attacker cannot make unlimited guesses: 128 bits is not
-- brute-forceable, but the endpoint is still a free oracle and a scraper
-- should not get to run it flat out.
-- ---------------------------------------------------------------------------
-- Drop the 0004 single-argument version first. Leaving both would make
-- `resolve_tag_public('code')` ambiguous, and — worse — a caller could pick
-- the unlimited one by passing one argument.
drop function if exists resolve_tag_public(text);

create or replace function resolve_tag_public(p_tag_code text, p_client_key text default 'anon')
returns table (found boolean, product_name text, owner_name text, owner_phone text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tag    asset_tags%rowtype;
  v_asset  assets%rowtype;
  v_org    orgs%rowtype;
begin
  if not rate_limit_check('tag:' || p_client_key, 60, '1 minute') then
    raise exception 'too many requests' using errcode = 'too_many_connections';
  end if;

  select * into v_tag from asset_tags where tag_code = p_tag_code and status = 'active';
  if not found then
    return query select false, null::text, null::text, null::text;
    return;
  end if;

  select * into v_asset from assets where id = v_tag.asset_id and deleted_at is null;
  if not found then
    return query select false, null::text, null::text, null::text;
    return;
  end if;

  select * into v_org from orgs where id = v_tag.org_id;

  return query
  select
    true,
    (select p.display_name from products p where p.id = v_asset.product_id),
    case when coalesce((v_org.settings ->> 'public_tag_show_owner')::boolean, false)
         then v_org.name end,
    case when coalesce((v_org.settings ->> 'public_tag_show_owner')::boolean, false)
         then v_org.settings ->> 'public_phone' end;
end
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
alter table device_sessions enable row level security;
alter table revocations     enable row level security;
alter table audit_log       enable row level security;
alter table rate_limits     enable row level security;

alter table device_sessions force row level security;
alter table revocations     force row level security;
alter table audit_log       force row level security;
alter table rate_limits     force row level security;

create policy device_sessions_tenant on device_sessions for select
  using (org_id = current_org_id());
create policy revocations_tenant on revocations for select
  using (org_id = current_org_id());

-- Owners and managers only. An audit trail a warehouse tech can read is one
-- they can learn to work around.
create policy audit_log_read on audit_log for select
  using (org_id = current_org_id() and has_role('owner', 'manager'));

-- No policy on rate_limits at all: nothing may read or write it directly, and
-- the SECURITY DEFINER functions are the only door.

grant select on device_sessions, revocations, audit_log to papa_app;
grant execute on function
  write_audit(text, text, uuid, text, jsonb),
  rate_limit_check(text, int, interval),
  resolve_tag_public(text, text)
  to papa_app;

revoke execute on function prune_rate_limits(interval) from papa_app;
