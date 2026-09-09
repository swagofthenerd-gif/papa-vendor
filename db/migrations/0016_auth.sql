-- ============================================================================
-- 0016 — Authentication: OTP enrolment, device sessions, the PIN gate,
--        device binding, revocation
--
-- Everything before this decided what an authenticated caller may do; nothing
-- decided who is calling. 0007 built the session FURNITURE (device_sessions,
-- revocations, rate_limits) and said so plainly: "it does not authenticate
-- anyone". This migration is the enforcement that was absent.
--
-- The design is recorded in docs/auth-design.md. The shape:
--
--   ENROLMENT — phone OTP, once per person per device, at the desk on WiFi.
--     SMS to Pakistan is ~$0.47/segment, so OTP is an enrolment act, never a
--     login act (HANDOFF §5/§9). request_otp() is executable ONLY by
--     papa_auth — the transport role (edge function, cron, whatever the host
--     provides). It returns the code exactly once; the database keeps a
--     bcrypt hash with a 10-minute expiry and a 5-attempt burn. A transport
--     that verifies identity itself (e.g. Supabase Auth) calls
--     enrol_verified_device() instead and both paths converge — the users
--     row stays OURS, external_auth_id is a nullable pointer out, and no
--     vendor identity function is read anywhere (CONTRIBUTING: the one-way
--     door stays shut).
--
--   SESSION — complete_enrolment() issues a 32-byte random token, returned
--     once, stored as a SHA-256 digest. authenticate_device(token) validates
--     hash → unexpired → unrevoked → membership still active → no matching
--     revocations row, then sets papa.org_id / papa.user_id /
--     papa.device_id / papa.session_id as TRANSACTION-LOCAL GUCs. Every
--     existing policy and RPC reads current_org_id()/current_user_id() and
--     works unchanged. The PostgREST seam is db-pre-request =
--     "public.auth_pre_request", which reads the x-papa-session header; on
--     failure it raises, the transaction dies, and no identity is half-set.
--     All failures share one message and SQLSTATE (28000) — expired, revoked
--     and garbage tokens are indistinguishable to a probe.
--
--   EXPIRY — 60 days, sliding on contact (org-tunable via
--     orgs.settings.device_session_days; ASSUMPTION, unvalidated). Generous
--     because a warehouse phone offline for days must keep capturing scans
--     and authenticate when it surfaces; the PIN is the local gate. This is
--     the fired-employee exposure window 0007 documents — owned, not hidden.
--     The sliding write is throttled to once per 5 minutes per session so
--     the per-request hot path stays read-only.
--
--   PIN — switch_session_user() repoints the session's user after
--     verify_pin() (0015: DEFINER, hash never leaves, internally
--     rate-limited 5/min — the wrong-PIN lockout, riding rate_limits).
--     set_member_pin() lets owner/manager reset a MEMBER's PIN, and refuses
--     owner targets — a manager who can reset the owner's PIN can become the
--     owner on money actions. The owner's own PIN resets only by proving
--     phone possession again: reset_pin_with_otp(). Driver gets nothing —
--     the vendor's rule: no enrolment, no PIN, no session.
--
--   DEVICE BINDING — closes the 2026-09-02 review's open item: p_device_id
--     on submit_scan_batch was a bare string, so an in-org member could burn
--     another device's idempotency slots. submit_scan_batch is recreated
--     with one guard: when the transaction carries a device session,
--     p_device_id must equal the session's device. current_device_id() reads
--     ONLY papa.device_id — device identity has no JWT channel.
--
--   REVOCATION — revoke_device() writes the durable revocations row, kills
--     the device's live sessions, and audits. authenticate_device honours
--     any revocation created at-or-after the session's issue, so a session
--     minted BEFORE the revocation dies at next contact while a re-enrolment
--     AFTER it (the found phone) comes back through the front door. These
--     paths stamp clock_timestamp(), not now(), so ordering is real even
--     inside one transaction. The honest property is unchanged from 0007:
--     revoked within one connectivity window, hard-limited by expires_at.
--
--   RATE LIMITS (all on 0007's rate_limits, all from inside DEFINER):
--     otp:<phone> 3/15min (each code costs real money) · otp:__global__
--     100/min (a rotating-phone flood degrades to a shared budget — the
--     0015 M2 lesson) · otpv:<phone> 10/min on verification · pin:… 5/min
--     unchanged from 0015.
--
--   FAILURE IS A VALUE wherever failure must be COUNTED. A raised exception
--     aborts the request transaction at the gateway, rolling back the very
--     counters that are supposed to limit the attacker — which is why
--     verify_pin (0015) returns false instead of raising. The same rule
--     holds here: wrong OTP codes (complete_enrolment, reset_pin_with_otp)
--     and wrong PINs (switch_session_user) return false/null-token so the
--     attempt commits. Raising is reserved for failures that need no
--     memory: bad arguments, missing sessions, and the limiter refusal
--     itself (prior committed counts keep refusing).
--
--   HYGIENE — token_hash is column-revoked from papa_app exactly as 0015
--     hid pin_hash; otp_challenges has RLS forced and NO policies (the
--     rate_limits treatment: DEFINER functions are the only door);
--     prune_otp_challenges joins run_maintenance as a fourth registered
--     task, because a cron that silently stops looks exactly like one that
--     works (0012).
--
-- TRUST MODEL for the papa.* channel — who can set it: (1) these DEFINER
-- functions, after validating a token; (2) test SQL under the pgTAP harness,
-- which is the documented vendor-free seam, not a production path; (3) anyone
-- who can execute arbitrary SQL — which no client can: PostgREST exposes
-- whitelisted public-schema functions and maps request data only into
-- request.* GUCs it sets itself. Defence in depth: authenticate_device
-- OVERWRITES all four GUCs on success and RAISES on failure, both pinned by
-- tests. The residual assumption, stated: the SQL role a client reaches the
-- database with must never run arbitrary SQL. Re-check it if the gateway
-- ever changes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- papa_auth — the transport role
--
-- Whatever delivers the SMS (or verifies identity with a vendor) connects as
-- this, and ONLY this role may mint or bypass OTP codes. It is not papa_app:
-- a client that can read request_otp()'s return value has turned the OTP into
-- a suggestion.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'papa_auth') then
    create role papa_auth nologin nosuperuser nobypassrls;
  end if;
end
$$;

grant usage on schema public to papa_auth;

comment on role papa_auth is
  'Transport role: the server-side thing that sends OTP SMS or verifies identity with a vendor. The only role that may call request_otp()/enrol_verified_device(). Never handed to a client.';

-- ---------------------------------------------------------------------------
-- users.external_auth_id — the nullable pointer OUT to a vendor
--
-- CONTRIBUTING's rule verbatim: own the users row; keep a nullable
-- external_auth_id if you need the link. Never a foreign key into a vendor's
-- table, never read by any policy or function.
-- ---------------------------------------------------------------------------
alter table users add column if not exists external_auth_id text;

create unique index if not exists users_external_auth_live_idx
  on users (external_auth_id)
  where external_auth_id is not null and deleted_at is null;

comment on column users.external_auth_id is
  'Optional link to an external auth provider''s user id. Informational only: no FK, no policy or function ever reads it. The identity model lives HERE.';

-- ---------------------------------------------------------------------------
-- otp_challenges — a code is a short-lived, single-use, hashed secret
--
-- No org_id: a challenge exists BEFORE the caller has proven membership of
-- anything. RLS is enabled and forced with NO policies and NO grants — the
-- rate_limits treatment — so the DEFINER functions below are the only door.
-- ---------------------------------------------------------------------------
create table if not exists otp_challenges (
  id          uuid primary key default uuid_generate_v7(),
  phone       text not null,
  purpose     text not null,
  -- bcrypt, same as pin_hash. The plaintext code exists only in the
  -- transport's hands, once.
  code_hash   text not null,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now(),

  constraint otp_challenges_purpose_check
    check (purpose in ('enrol', 'pin_reset'))
);

create index if not exists otp_challenges_live_idx
  on otp_challenges (phone, purpose) where consumed_at is null;

alter table otp_challenges enable row level security;
alter table otp_challenges force row level security;

comment on table otp_challenges is
  'Hashed one-time codes, 10-minute expiry, 5-attempt burn. No policies, no grants: the DEFINER functions are the only door.';

-- ---------------------------------------------------------------------------
-- H3, applied to tokens: token_hash leaves the read surface
--
-- 0015 hid pin_hash from papa_app; the session token hash gets the same
-- treatment for the same reason — a client has no business reading
-- credential material, hashed or not.
-- ---------------------------------------------------------------------------
revoke select on device_sessions from papa_app;
grant select (id, org_id, device_id, user_id, issued_at, last_seen_at,
              expires_at, revoked_at, revoked_by, revoke_reason, created_at)
  on device_sessions to papa_app;

-- ---------------------------------------------------------------------------
-- The session result shape, and the small readers
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_type t
     where t.typname = 'auth_session_result'
       and t.typnamespace = 'public'::regnamespace
  ) then
    create type auth_session_result as (
      token        text,          -- the raw token: present ONCE, at issue
      session_id   uuid,
      org_id       uuid,
      user_id      uuid,
      device_id    text,
      role         text,
      display_name text,
      expires_at   timestamptz
    );
  end if;
end
$$;

/**
 * The device this transaction authenticated as, or null.
 *
 * Reads ONLY papa.device_id — set by authenticate_device / enrolment, or by
 * test SQL under the harness. There is deliberately no request.jwt fallback:
 * device identity never travels in a JWT.
 */
create or replace function current_device_id()
returns text
language sql
stable
as $$
  select nullif(current_setting('papa.device_id', true), '')
$$;

create or replace function current_session_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('papa.session_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Internal helpers. INVOKER (they only ever run inside the DEFINER entry
-- points below, as the function owner) and revoked from everyone at the
-- bottom of this file.
-- ---------------------------------------------------------------------------
create or replace function auth_token_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(digest(p_token, 'sha256'), 'hex')
$$;

comment on function auth_token_hash(text) is
  'SHA-256 hex of a session token. 256 bits of entropy needs no salt or work factor; what it needs is to be unusable when the table leaks.';

create or replace function auth_normalise_phone(p_phone text)
returns text
language sql
immutable
as $$
  select regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g')
$$;

/**
 * Session lifetime for an org. Org policy, read from settings the way 0001
 * intends, with a 60-day default.
 *
 * ASSUMPTION: 60 days. Unvalidated — long enough that a phone in a bad-signal
 * fortnight never hits an auth wall, short enough that a fired employee's
 * phone is not useful forever. See docs/auth-design.md.
 */
create or replace function auth_session_lifetime(p_org uuid)
returns interval
language sql
stable
as $$
  select make_interval(days => coalesce(
    (select nullif(o.settings ->> 'device_session_days', '')::int
       from orgs o where o.id = p_org),
    60))
$$;

/**
 * Resolve a phone to (user, org, role) for the anonymous auth paths.
 *
 * Deliberately ONE failure shape (28000, same message as a bad code) for
 * unknown phone / no live membership / driver-only phone, so the anonymous
 * enrolment endpoint is not a phone-number oracle. The multi-org case is the
 * one distinguishable answer (22023) and is raised BEFORE the OTP is
 * consumed, so the code survives the retry with an org slug.
 *
 * role <> 'driver' everywhere: driver gets nothing — no enrolment, no PIN,
 * no session. The vendor's rule (HANDOFF §1).
 */
create or replace function auth_resolve_member(
  p_phone    text,
  p_org_slug text,
  out o_user uuid,
  out o_org  uuid,
  out o_role text
)
language plpgsql
as $$
declare
  v_matches int;
begin
  select u.id into o_user
    from users u
   where u.phone = p_phone and u.deleted_at is null;

  if o_user is null then
    raise exception 'invalid or expired code' using errcode = '28000';
  end if;

  select count(*), min(m.org_id::text)::uuid, min(m.role)
    into v_matches, o_org, o_role
    from memberships m
    join orgs o on o.id = m.org_id and o.deleted_at is null
   where m.user_id = o_user
     and m.status = 'active'
     and m.deleted_at is null
     and m.role <> 'driver'
     and (p_org_slug is null or o.slug = p_org_slug);

  if v_matches = 0 then
    raise exception 'invalid or expired code' using errcode = '28000';
  end if;

  if v_matches > 1 then
    raise exception 'this phone belongs to more than one organisation; specify the org'
      using errcode = '22023';
  end if;
end
$$;

/**
 * Verify-and-consume one OTP code. Returns true and consumes on a match;
 * returns FALSE — it does not raise — on a wrong, expired, missing or burned
 * code.
 *
 * FAILURE IS A VALUE HERE, deliberately, and this is the same reason
 * verify_pin (0015) returns boolean: a raised exception aborts the request
 * transaction at the gateway, which would ROLL BACK the attempts counter and
 * the rate-limit increment — a guessing loop would then never be counted at
 * all. Returning false lets the failed attempt COMMIT, which is the entire
 * point of counting. Only the limiter refusal raises, because a refusal
 * needs no persistence of its own — the committed prior counts keep
 * refusing.
 *
 * The per-challenge attempts counter (burn past 5) and the per-phone bucket
 * are BOTH here because they answer different attacks: the counter stops
 * guessing against one live code, the bucket stops a stream of fresh
 * challenges being farmed for guesses.
 */
create or replace function consume_otp(
  p_phone   text,
  p_code    text,
  p_purpose text
)
returns boolean
language plpgsql
as $$
declare
  c          otp_challenges%rowtype;
  v_attempts int;
begin
  if not rate_limit_check('otpv:' || p_phone, 10, '1 minute') then
    raise exception 'too many attempts' using errcode = 'too_many_connections';
  end if;

  select * into c
    from otp_challenges
   where phone = p_phone
     and purpose = p_purpose
     and consumed_at is null
     and expires_at > now()
   order by created_at desc
   limit 1
   for update;

  if not found then
    return false;
  end if;

  update otp_challenges set attempts = attempts + 1
   where id = c.id
  returning attempts into v_attempts;

  if v_attempts > 5 then
    -- Burned. Consuming it means the NEXT correct guess fails too: five
    -- wrong answers are evidence the code has leaked into a guessing loop.
    update otp_challenges set consumed_at = clock_timestamp() where id = c.id;
    return false;
  end if;

  if c.code_hash <> crypt(p_code, c.code_hash) then
    return false;
  end if;

  update otp_challenges set consumed_at = clock_timestamp() where id = c.id;
  return true;
end
$$;

/**
 * Mint a session for (org, user, device) and set the papa.* context.
 *
 * clock_timestamp(), not now(): revocation honouring compares issue time to
 * revocation time, and inside one transaction now() would make every event
 * simultaneous — a re-enrolment would then look older than the revocation
 * that preceded it.
 *
 * One active session per device: issuing supersedes (revokes) whatever the
 * device held before. The device is the unit of custody; the PIN decides the
 * person.
 */
create or replace function issue_device_session(
  p_org       uuid,
  p_user      uuid,
  p_device_id text,
  p_label     text
)
returns auth_session_result
language plpgsql
as $$
declare
  v_token text := encode(gen_random_bytes(32), 'hex');
  res     auth_session_result;
begin
  -- The 0004 device upsert, org-checked the 0004 way: the conditional update
  -- refuses to adopt another org's device, and the existence check turns
  -- that refusal into an error instead of a silent no-op.
  insert into devices (id, org_id, label, last_user_id, last_seen_at)
  values (p_device_id, p_org, coalesce(p_label, ''), p_user, clock_timestamp())
  on conflict (id) do update
    set last_seen_at = clock_timestamp(),
        last_user_id = excluded.last_user_id,
        label = coalesce(nullif(excluded.label, ''), devices.label)
  where devices.org_id = p_org;

  if not exists (
    select 1 from devices d where d.id = p_device_id and d.org_id = p_org
  ) then
    raise exception 'device % is enrolled with another organisation', p_device_id
      using errcode = 'insufficient_privilege';
  end if;

  update device_sessions
     set revoked_at = clock_timestamp(),
         revoked_by = p_user,
         revoke_reason = 'superseded by re-enrolment'
   where org_id = p_org
     and device_id = p_device_id
     and revoked_at is null;

  insert into device_sessions (org_id, device_id, user_id, token_hash,
                               issued_at, last_seen_at, expires_at)
  values (p_org, p_device_id, p_user, auth_token_hash(v_token),
          clock_timestamp(), clock_timestamp(),
          now() + auth_session_lifetime(p_org))
  returning id, expires_at into res.session_id, res.expires_at;

  perform set_config('papa.org_id',     p_org::text,           true);
  perform set_config('papa.user_id',    p_user::text,          true);
  perform set_config('papa.device_id',  p_device_id,           true);
  perform set_config('papa.session_id', res.session_id::text,  true);

  res.token     := v_token;
  res.org_id    := p_org;
  res.user_id   := p_user;
  res.device_id := p_device_id;
  select m.role into res.role
    from memberships m
   where m.org_id = p_org and m.user_id = p_user and m.deleted_at is null;
  select u.display_name into res.display_name from users u where u.id = p_user;

  return res;
end
$$;

-- ---------------------------------------------------------------------------
-- request_otp — papa_auth ONLY
--
-- Returns the plaintext code, once, to the transport that will SMS it. An
-- unknown phone gets no code: every segment costs ~$0.47 and papa_auth is a
-- trusted server-side caller, so refusing loudly here is not an oracle.
-- ---------------------------------------------------------------------------
create or replace function request_otp(
  p_phone   text,
  p_purpose text default 'enrol'
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := auth_normalise_phone(p_phone);
  v_code  text;
begin
  if p_purpose not in ('enrol', 'pin_reset') then
    raise exception 'unknown OTP purpose %', p_purpose using errcode = '22023';
  end if;

  if v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'phone must be E.164, e.g. +9230…' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from users u
      join memberships m on m.user_id = u.id
                        and m.status = 'active'
                        and m.deleted_at is null
                        and m.role <> 'driver'
      join orgs o on o.id = m.org_id and o.deleted_at is null
     where u.phone = v_phone and u.deleted_at is null
  ) then
    raise exception 'no enrolable member with this phone' using errcode = 'P0002';
  end if;

  if not rate_limit_check('otp:' || v_phone, 3, '15 minutes')
     or not rate_limit_check('otp:__global__', 100, '1 minute')
  then
    raise exception 'too many OTP requests' using errcode = 'too_many_connections';
  end if;

  -- One live challenge per (phone, purpose): a new request retires the old
  -- code so an attacker cannot multiply their guessing budget by requesting.
  update otp_challenges set consumed_at = clock_timestamp()
   where phone = v_phone and purpose = p_purpose and consumed_at is null;

  v_code := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::int
                   & 2147483647) % 1000000)::text, 6, '0');

  insert into otp_challenges (phone, purpose, code_hash, expires_at)
  values (v_phone, p_purpose, crypt(v_code, gen_salt('bf')),
          now() + interval '10 minutes');

  return v_code;
end
$$;

comment on function request_otp(text, text) is
  'papa_auth only. Mints a 6-digit code, stores its bcrypt hash (10-min expiry, 5-attempt burn), returns the plaintext ONCE for the transport to SMS. Rate limited per phone (3/15min — codes cost money) and globally (100/min).';

-- ---------------------------------------------------------------------------
-- complete_enrolment — the anonymous entry point
--
-- A wrong or expired code, or an unknown phone, RETURNS A ROW OF NULLS
-- (token null) rather than raising: the failed attempt must COMMIT so the
-- attempts counter and the rate bucket actually count — a raise would abort
-- the request transaction and roll both back (the verify_pin lesson, 0015).
-- Null-token also gives unknown-phone and wrong-code one indistinguishable
-- face, so this endpoint is not a phone-number oracle. Structural errors
-- (bad arguments, multi-org ambiguity, limiter refusal, a device enrolled
-- elsewhere) still raise — none of them needs a committed counter.
-- ---------------------------------------------------------------------------
create or replace function complete_enrolment(
  p_phone        text,
  p_code         text,
  p_device_id    text,
  p_device_label text default '',
  p_pin          text default null,
  p_org_slug     text default null
)
returns auth_session_result
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := auth_normalise_phone(p_phone);
  v_user  uuid;
  v_org   uuid;
  v_role  text;
  res     auth_session_result;
begin
  if p_device_id is null or p_device_id = '' then
    raise exception 'a device id is required' using errcode = '22023';
  end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4,6}$' then
    -- Checked BEFORE the code is consumed: a bad PIN must not burn the SMS.
    raise exception 'PIN must be 4-6 digits' using errcode = '22023';
  end if;

  begin
    select r.o_user, r.o_org, r.o_role into v_user, v_org, v_role
      from auth_resolve_member(v_phone, p_org_slug) r;
  exception when sqlstate '28000' then
    -- Unknown phone: same face as a wrong code, and it still spends a
    -- verification attempt so phone-scanning is bucketed like guessing.
    if not rate_limit_check('otpv:' || v_phone, 10, '1 minute') then
      raise exception 'too many attempts' using errcode = 'too_many_connections';
    end if;
    return res;
  end;

  if not consume_otp(v_phone, p_code, 'enrol') then
    return res;   -- wrong/expired/burned code; the attempt is committed
  end if;

  res := issue_device_session(v_org, v_user, p_device_id, p_device_label);

  -- Initial PIN only. Enrolment never overwrites a PIN that exists — resets
  -- are explicit acts with their own authority (set_member_pin /
  -- reset_pin_with_otp).
  if p_pin is not null then
    update memberships
       set pin_hash = crypt(p_pin, gen_salt('bf')), pin_set_at = now()
     where org_id = v_org and user_id = v_user
       and deleted_at is null and pin_hash is null;
  end if;

  -- The GUCs are set by now, so write_audit attributes this correctly.
  perform write_audit('device.enrolled', 'device', null, p_device_id,
                      jsonb_build_object('role', v_role));

  return res;
end
$$;

comment on function complete_enrolment(text, text, text, text, text, text) is
  'OTP-verified enrolment: binds the users row (found by phone — the membership must already exist via invite_member), upserts the device, issues a device session and returns the raw token ONCE. Sets papa.* for this transaction. Idempotent per device: re-enrolment supersedes the previous session. A wrong code or unknown phone returns token = null (the attempt must commit); it does not raise.';

-- ---------------------------------------------------------------------------
-- enrol_verified_device — the vendor-verified path, papa_auth ONLY
--
-- For a transport that verified phone possession itself (Supabase Auth OTP,
-- or a future one). Converges on the same session issuance; the only vendor
-- residue is the nullable external_auth_id pointer, stamped once.
-- ---------------------------------------------------------------------------
create or replace function enrol_verified_device(
  p_phone            text,
  p_device_id        text,
  p_device_label     text default '',
  p_external_auth_id text default null,
  p_org_slug         text default null
)
returns auth_session_result
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := auth_normalise_phone(p_phone);
  v_user  uuid;
  v_org   uuid;
  v_role  text;
  res     auth_session_result;
begin
  if p_device_id is null or p_device_id = '' then
    raise exception 'a device id is required' using errcode = '22023';
  end if;

  select r.o_user, r.o_org, r.o_role into v_user, v_org, v_role
    from auth_resolve_member(v_phone, p_org_slug) r;

  if p_external_auth_id is not null then
    update users set external_auth_id = p_external_auth_id
     where id = v_user and external_auth_id is null;
  end if;

  res := issue_device_session(v_org, v_user, p_device_id, p_device_label);

  perform write_audit('device.enrolled', 'device', null, p_device_id,
                      jsonb_build_object('role', v_role, 'verified_by', 'transport'));

  return res;
end
$$;

comment on function enrol_verified_device(text, text, text, text, text) is
  'papa_auth only: enrolment for a transport that verified the phone itself. Stamps users.external_auth_id (once, informationally) and converges on the same session issuance as complete_enrolment.';

-- ---------------------------------------------------------------------------
-- authenticate_device — how every scanner request proves itself
-- ---------------------------------------------------------------------------
create or replace function authenticate_device(p_token text)
returns auth_session_result
language plpgsql
security definer
set search_path = public
as $$
declare
  s   device_sessions%rowtype;
  res auth_session_result;
begin
  select * into s
    from device_sessions
   where token_hash = auth_token_hash(coalesce(p_token, ''));

  -- ONE message, ONE code, for every failure mode below: an attacker probing
  -- tokens must not learn whether they found a real-but-revoked one.
  if not found
     or s.revoked_at is not null
     or s.expires_at <= now()
  then
    raise exception 'invalid or expired device session' using errcode = '28000';
  end if;

  -- The person must still be a live, active member of a live org. This is
  -- what makes suspending a membership de-authenticate the phone at next
  -- contact.
  select m.role into res.role
    from memberships m
    join users u on u.id = m.user_id and u.deleted_at is null
    join orgs  o on o.id = m.org_id  and o.deleted_at is null
   where m.org_id = s.org_id
     and m.user_id = s.user_id
     and m.status = 'active'
     and m.deleted_at is null;

  if res.role is null then
    raise exception 'invalid or expired device session' using errcode = '28000';
  end if;

  -- The revocations table, honoured. created_at >= issued_at: a session
  -- minted BEFORE the revocation dies here; one minted after (re-enrolment
  -- of a found phone) is legitimate and passes.
  if exists (
    select 1 from revocations r
     where r.org_id = s.org_id
       and r.created_at >= s.issued_at
       and ((r.scope = 'device' and r.subject = s.device_id)
         or (r.scope = 'user'   and r.subject = s.user_id::text)
         or (r.scope = 'org'    and r.subject = s.org_id::text))
  ) then
    raise exception 'invalid or expired device session' using errcode = '28000';
  end if;

  -- Sliding expiry, throttled: this runs on EVERY request via the
  -- pre-request hook, and a write per request would make auth the hottest
  -- write path in the system. Once per 5 minutes is plenty to keep a live
  -- phone alive forever.
  if s.last_seen_at < clock_timestamp() - interval '5 minutes' then
    update device_sessions
       set last_seen_at = clock_timestamp(),
           expires_at = greatest(expires_at, now() + auth_session_lifetime(s.org_id))
     where id = s.id
    returning expires_at into s.expires_at;
  end if;

  -- Overwrite, never merge: whatever papa.* held before this call — a pooled
  -- connection's leftovers, a poisoned value — is replaced by session truth.
  perform set_config('papa.org_id',     s.org_id::text,    true);
  perform set_config('papa.user_id',    s.user_id::text,   true);
  perform set_config('papa.device_id',  s.device_id,       true);
  perform set_config('papa.session_id', s.id::text,        true);

  res.token      := null;   -- never echoed back
  res.session_id := s.id;
  res.org_id     := s.org_id;
  res.user_id    := s.user_id;
  res.device_id  := s.device_id;
  res.expires_at := s.expires_at;
  select u.display_name into res.display_name from users u where u.id = s.user_id;

  return res;
end
$$;

comment on function authenticate_device(text) is
  'Validates a device-session token (hash, expiry, revocation, live membership) and sets papa.org_id/user_id/device_id/session_id as TRANSACTION-LOCAL GUCs, so every existing RLS policy and RPC works unchanged. Failure raises 28000 with one message for every mode. Sliding expiry, write-throttled.';

-- ---------------------------------------------------------------------------
-- auth_pre_request — the PostgREST seam
--
-- postgrest.conf:  db-pre-request = "public.auth_pre_request"
--
-- Runs inside the request's transaction, before the main statement. No
-- header → no-op, so public endpoints (resolve_tag_public) keep working. A
-- bad token raises, PostgREST aborts the transaction, and no identity is
-- half-set. Any other gateway can provide the same seam: one function call
-- at the top of the transaction.
-- ---------------------------------------------------------------------------
create or replace function auth_pre_request()
returns void
language plpgsql
as $$
declare
  v_token text;
begin
  v_token := nullif(current_setting('request.headers', true), '')::jsonb
               ->> 'x-papa-session';
  if v_token is not null and v_token <> '' then
    perform authenticate_device(v_token);
  end if;
end
$$;

comment on function auth_pre_request() is
  'PostgREST db-pre-request hook. Reads the x-papa-session header and authenticates it; absent header is a no-op so public endpoints still answer.';

-- ---------------------------------------------------------------------------
-- switch_session_user — the PIN gate on the shared phone
--
-- Returns FALSE for a wrong PIN rather than raising, for the same reason
-- verify_pin does (0015) and consume_otp does above: the wrong attempt must
-- COMMIT so verify_pin's internal 5/min limiter actually counts it. A raise
-- here would abort the request transaction and roll the count back — the
-- lockout would never engage. Structural refusals (no session, a stranger,
-- a driver) still raise; they need no counting.
-- ---------------------------------------------------------------------------
create or replace function switch_session_user(
  p_user_id uuid,
  p_pin     text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  s      device_sessions%rowtype;
  v_role text;
begin
  if current_session_id() is null then
    raise exception 'no device session' using errcode = 'insufficient_privilege';
  end if;

  select * into s
    from device_sessions
   where id = current_session_id()
     and revoked_at is null
     and expires_at > now()
   for update;

  if not found or s.org_id is distinct from current_org_id() then
    raise exception 'no device session' using errcode = 'insufficient_privilege';
  end if;

  select m.role into v_role
    from memberships m
   where m.org_id = s.org_id
     and m.user_id = p_user_id
     and m.status = 'active'
     and m.deleted_at is null;

  -- Driver gets nothing, and a stranger gets the same answer as a driver.
  if v_role is null or v_role = 'driver' then
    raise exception 'that person cannot use this device'
      using errcode = 'insufficient_privilege';
  end if;

  -- verify_pin (0015) is the ONLY pin check: DEFINER, hash never leaves,
  -- internally rate limited 5/min — which IS the wrong-PIN lockout.
  if not verify_pin(p_user_id, p_pin) then
    return false;
  end if;

  update device_sessions
     set user_id = p_user_id, last_seen_at = clock_timestamp()
   where id = s.id;

  update devices set last_user_id = p_user_id
   where id = s.device_id and org_id = s.org_id;

  perform set_config('papa.user_id', p_user_id::text, true);
  return true;
end
$$;

comment on function switch_session_user(uuid, text) is
  'Repoints the device session at another member after their PIN verifies; false = wrong PIN (returned, not raised, so the lockout counter commits). The phone is handed over, not shared concurrently — subsequent requests on this token speak as the new user until the next switch.';

-- ---------------------------------------------------------------------------
-- set_member_pin — owner/manager resets a MEMBER's PIN
-- ---------------------------------------------------------------------------
create or replace function set_member_pin(
  p_user_id uuid,
  p_pin     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_role text;
begin
  if v_org is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  perform require_role('owner', 'manager');

  if p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4-6 digits' using errcode = '22023';
  end if;

  select m.role into v_role
    from memberships m
   where m.org_id = v_org
     and m.user_id = p_user_id
     and m.status = 'active'
     and m.deleted_at is null;

  if v_role is null then
    raise exception 'user % is not an active member of this org', p_user_id
      using errcode = 'foreign_key_violation';
  end if;

  -- The escalation that matters: a manager who can reset the owner's PIN can
  -- BECOME the owner on money actions. Owner PINs move only through OTP
  -- re-enrolment — proof of the owner's own phone.
  if v_role = 'owner' then
    raise exception 'an owner''s PIN can only be reset by OTP re-enrolment'
      using errcode = 'insufficient_privilege';
  end if;

  if v_role = 'driver' then
    raise exception 'driver role has no PIN' using errcode = 'insufficient_privilege';
  end if;

  update memberships
     set pin_hash = crypt(p_pin, gen_salt('bf')), pin_set_at = now()
   where org_id = v_org and user_id = p_user_id and deleted_at is null;

  perform write_audit('pin.set', 'user', p_user_id,
                      (select display_name from users where id = p_user_id));
end
$$;

comment on function set_member_pin(uuid, text) is
  'Owner/manager sets a member''s PIN. Refused for owner targets (OTP re-enrolment only — a manager must not be able to become the owner) and for driver (gets nothing).';

-- ---------------------------------------------------------------------------
-- reset_pin_with_otp — the owner's own path (and any member's, honestly:
-- proof of phone possession outranks knowledge of the old PIN)
-- ---------------------------------------------------------------------------
create or replace function reset_pin_with_otp(
  p_phone    text,
  p_code     text,
  p_new_pin  text,
  p_org_slug text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := auth_normalise_phone(p_phone);
  v_user  uuid;
  v_org   uuid;
  v_role  text;
begin
  if p_new_pin !~ '^[0-9]{4,6}$' then
    -- Before the code is consumed: a bad PIN must not burn the SMS.
    raise exception 'PIN must be 4-6 digits' using errcode = '22023';
  end if;

  -- Failure is a value, exactly as in complete_enrolment: false for an
  -- unknown phone or a wrong code, so the counted attempt commits and the
  -- two cases share one face.
  begin
    select r.o_user, r.o_org, r.o_role into v_user, v_org, v_role
      from auth_resolve_member(v_phone, p_org_slug) r;
  exception when sqlstate '28000' then
    if not rate_limit_check('otpv:' || v_phone, 10, '1 minute') then
      raise exception 'too many attempts' using errcode = 'too_many_connections';
    end if;
    return false;
  end;

  if not consume_otp(v_phone, p_code, 'pin_reset') then
    return false;
  end if;

  update memberships
     set pin_hash = crypt(p_new_pin, gen_salt('bf')), pin_set_at = now()
   where org_id = v_org and user_id = v_user and deleted_at is null;

  -- Direct audit insert: this path is anonymous (no papa.* context), so
  -- write_audit's current_org_id() gate would refuse. The actor is the
  -- person who proved phone possession.
  insert into audit_log (org_id, actor_user_id, actor_label, action,
                         subject_type, subject_id, subject_label)
  values (v_org, v_user,
          coalesce((select display_name from users where id = v_user), 'unknown'),
          'pin.reset_by_otp', 'user', v_user,
          (select display_name from users where id = v_user));

  return true;
end
$$;

comment on function reset_pin_with_otp(text, text, text, text) is
  'PIN reset by proving phone possession (fresh OTP, purpose pin_reset). The only path that may reset an OWNER''s PIN. false = wrong code or unknown phone (returned, not raised, so the counted attempt commits).';

-- ---------------------------------------------------------------------------
-- invite_member — the membership must exist before a phone can enrol
-- ---------------------------------------------------------------------------
create or replace function invite_member(
  p_phone        text,
  p_display_name text,
  p_role         text,
  p_pin          text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org   uuid := current_org_id();
  v_phone text := auth_normalise_phone(p_phone);
  v_user  uuid;
begin
  if v_org is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  perform require_role('owner', 'manager');

  if p_role not in ('owner', 'manager', 'desk', 'warehouse', 'driver', 'readonly') then
    raise exception 'unknown role %', p_role using errcode = '22023';
  end if;

  -- Only an owner mints another owner: a manager creating an owner and
  -- setting their PIN is the same escalation set_member_pin refuses.
  if p_role = 'owner' then
    perform require_role('owner');
  end if;

  if v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'phone must be E.164, e.g. +9230…' using errcode = '22023';
  end if;

  if p_pin is not null and (p_role in ('owner', 'driver')) then
    raise exception 'this role''s PIN cannot be set at invite'
      using errcode = 'insufficient_privilege';
  end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4-6 digits' using errcode = '22023';
  end if;

  -- One users row per phone, shared across orgs — a person who works at two
  -- rental houses is one person (0001).
  select u.id into v_user
    from users u where u.phone = v_phone and u.deleted_at is null;

  if v_user is null then
    insert into users (id, display_name, phone)
    values (uuid_generate_v7(), p_display_name, v_phone)
    returning id into v_user;
  end if;

  -- Idempotent: an existing live membership is left EXACTLY as it is. Role
  -- changes are a different administrative act with its own audit shape, not
  -- a side effect of a repeated invite.
  if not exists (
    select 1 from memberships m
     where m.org_id = v_org and m.user_id = v_user and m.deleted_at is null
  ) then
    insert into memberships (org_id, user_id, role, status)
    values (v_org, v_user, p_role, 'active');

    perform write_audit('member.invited', 'user', v_user, p_display_name,
                        jsonb_build_object('role', p_role));
  end if;

  if p_pin is not null then
    update memberships
       set pin_hash = crypt(p_pin, gen_salt('bf')), pin_set_at = now()
     where org_id = v_org and user_id = v_user
       and deleted_at is null and pin_hash is null;
  end if;

  return v_user;
end
$$;

comment on function invite_member(text, text, text, text) is
  'Owner/manager creates (or reuses) the users row for a phone and adds an active membership, idempotently. Enrolment later BINDS this; it never creates authority. Only an owner may invite an owner.';

-- ---------------------------------------------------------------------------
-- revoke_device — the lost phone
-- ---------------------------------------------------------------------------
create or replace function revoke_device(
  p_device_id text,
  p_reason    text default null,
  p_wipe      boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_user uuid := current_user_id();
  n      integer;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  perform require_role('owner', 'manager');

  if not exists (
    select 1 from devices d where d.id = p_device_id and d.org_id = v_org
  ) then
    raise exception 'device % does not belong to this org', p_device_id
      using errcode = 'foreign_key_violation';
  end if;

  -- The durable record first (it must outlive the sessions it kills — 0012's
  -- pruning rule depends on that), stamped with clock_timestamp so a session
  -- issued later in this same transaction is provably LATER.
  insert into revocations (org_id, scope, subject, reason, wipe_local,
                           created_by, created_at)
  values (v_org, 'device', p_device_id, p_reason, p_wipe, v_user,
          clock_timestamp());

  update device_sessions
     set revoked_at = clock_timestamp(),
         revoked_by = v_user,
         revoke_reason = coalesce(p_reason, 'device revoked')
   where org_id = v_org
     and device_id = p_device_id
     and revoked_at is null;
  get diagnostics n = row_count;

  perform write_audit('device.revoked', 'device', null, p_device_id,
                      jsonb_build_object('reason', p_reason, 'wipe_local', p_wipe,
                                         'sessions_revoked', n));

  return n;
end
$$;

comment on function revoke_device(text, text, boolean) is
  'Owner/manager revokes a device: durable revocations row + all live sessions killed + audited. Honest property unchanged from 0007: takes effect within one connectivity window, hard-limited by expires_at. Re-enrolment afterwards is allowed — the found phone comes back through the front door.';

-- ---------------------------------------------------------------------------
-- sign_out_device — a device retires its own session
-- ---------------------------------------------------------------------------
create or replace function sign_out_device()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_session_id() is null then
    raise exception 'no device session' using errcode = 'insufficient_privilege';
  end if;

  update device_sessions
     set revoked_at = clock_timestamp(),
         revoked_by = current_user_id(),
         revoke_reason = 'signed out'
   where id = current_session_id()
     and revoked_at is null;

  -- The rest of this transaction is nobody.
  perform set_config('papa.org_id',     '', true);
  perform set_config('papa.user_id',    '', true);
  perform set_config('papa.device_id',  '', true);
  perform set_config('papa.session_id', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- submit_scan_batch, second edition — device binding
--
-- Identical to 0004 except the guard marked 0016 below. When the transaction
-- carries a device session, p_device_id must be THAT device: this closes the
-- 2026-09-02 open item (burning another device's idempotency slots, and
-- writing history under another device's name).
--
-- Residual, stated honestly: a request with NO device session (console JWT,
-- pre-auth tests) still passes a bare device string. Production scanner
-- traffic always authenticates through the session path, and the console has
-- no scan surface; if that ever changes, harden this to REQUIRE
-- current_device_id() rather than match it — a one-line change.
-- ---------------------------------------------------------------------------
create or replace function submit_scan_batch(
  p_device_id text,
  p_ops       jsonb
)
returns setof scan_submit_result
language plpgsql
as $$
declare
  op        jsonb;
  v_org     uuid := current_org_id();
  v_user    uuid := current_user_id();
  v_event   scan_events%rowtype;
  v_id      uuid;
  v_seq     bigint;
  v_asset   assets%rowtype;
  v_alert   text;
  v_existing uuid;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- Drivers scan too: a handoff at the truck is a physical fact like any other.
  perform require_role('owner', 'manager', 'desk', 'warehouse', 'driver');

  -- 0016: the device the batch claims must be the device the session proved.
  if current_device_id() is not null and p_device_id <> current_device_id() then
    raise exception 'device % is not the device bound to this session', p_device_id
      using errcode = 'insufficient_privilege';
  end if;

  -- The device must belong to this org. Registering it here rather than in a
  -- separate call means a fresh phone can start scanning without an extra
  -- online round-trip on its first sync.
  insert into devices (id, org_id, last_user_id, last_seen_at)
  values (p_device_id, v_org, v_user, now())
  on conflict (id) do update
    set last_seen_at = now(), last_user_id = v_user
  where devices.org_id = v_org;

  if not exists (select 1 from devices d where d.id = p_device_id and d.org_id = v_org) then
    raise exception 'device % does not belong to this org', p_device_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Ordered by client_seq: the outbox flushes in order and replay must keep
  -- that order, or a check_in can land before its check_out.
  for op in
    select value from jsonb_array_elements(p_ops)
    order by (value ->> 'client_seq')::bigint
  loop
    v_seq := (op ->> 'client_seq')::bigint;
    v_alert := null;

    -- Idempotency. The unique constraint is the real guard; this lookup is
    -- what lets us report `duplicate` instead of raising.
    select id into v_existing from scan_events
     where device_id = p_device_id and client_seq = v_seq;

    if v_existing is not null then
      return query select v_seq, v_existing, 'duplicate'::text, null::text;
      continue;
    end if;

    v_id := coalesce((op ->> 'id')::uuid, uuid_generate_v7());

    -- ---- server-side conflict detection ----------------------------------
    -- The device already warns locally from its own SQLite before the tech
    -- walks away — that is the control that matters, because at 06:14 the
    -- desk is closed. This is the second line of defence, for the case where
    -- the device's copy was stale.
    if (op ->> 'event_type') = 'check_out' and (op ->> 'asset_id') is not null then
      select * into v_asset from assets where id = (op ->> 'asset_id')::uuid;

      if found and v_asset.presence = 'out'
         and v_asset.current_job_id is distinct from nullif(op ->> 'job_id', '')::uuid
      then
        v_alert := 'double_checkout';

        insert into alerts (org_id, kind, severity, owner_role, channel,
                            asset_id, job_id, title, detail)
        values (
          v_org, 'double_checkout', 'critical', 'manager', 'whatsapp',
          v_asset.id, nullif(op ->> 'job_id', '')::uuid,
          format('%s was checked out twice', v_asset.asset_code),
          format('Already out on another job. Physically it is on one truck — which?')
        );
      end if;
    end if;

    -- ---- the insert -------------------------------------------------------
    -- effective_time is clamped by the trigger, and the projection runs from
    -- the AFTER trigger. Nothing about ordering or state is decided here.
    insert into scan_events (
      id, org_id, asset_id, tag_code, event_type, entry_method,
      job_id, session_id, from_location_id, to_location_id, parent_asset_id,
      health, note, actor_user_id, device_id, client_seq,
      device_time, clock_offset_ms, effective_time,
      corrects_event_id, payload
    ) values (
      v_id, v_org,
      nullif(op ->> 'asset_id', '')::uuid,
      nullif(op ->> 'tag_code', ''),
      op ->> 'event_type',
      coalesce(nullif(op ->> 'entry_method', ''), 'scanned'),
      nullif(op ->> 'job_id', '')::uuid,
      nullif(op ->> 'session_id', '')::uuid,
      nullif(op ->> 'from_location_id', '')::uuid,
      nullif(op ->> 'to_location_id', '')::uuid,
      nullif(op ->> 'parent_asset_id', '')::uuid,
      nullif(op ->> 'health', ''),
      nullif(op ->> 'note', ''),
      v_user, p_device_id, v_seq,
      (op ->> 'device_time')::timestamptz,
      coalesce((op ->> 'clock_offset_ms')::bigint, 0),
      (op ->> 'device_time')::timestamptz,   -- placeholder; the trigger clamps it
      nullif(op ->> 'corrects_event_id', '')::uuid,
      coalesce(op -> 'payload', '{}'::jsonb)
    );

    return query select v_seq, v_id, 'accepted'::text, v_alert;
  end loop;

  update devices set last_synced_at = now(), queued_writes = 0
   where id = p_device_id and org_id = v_org;
end
$$;

comment on function submit_scan_batch(text, jsonb) is
  'The only path scans take to the server. One transaction, ordered by client_seq, idempotent per (device, seq). `duplicate` is a success. 0016: p_device_id must match the authenticated device session when one is present.';

-- ---------------------------------------------------------------------------
-- OTP challenge pruning, registered with the 0012 machinery — an unregistered
-- cron is a silent one, and silence looks exactly like health.
-- ---------------------------------------------------------------------------
create or replace function prune_otp_challenges(p_older_than interval default '1 day')
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  delete from otp_challenges
   where coalesce(consumed_at, expires_at) < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end
$$;

comment on function prune_otp_challenges(interval) is
  'Removes consumed and long-expired OTP challenges. A challenge is worthless minutes after issue; the rows are only storage.';

insert into maintenance_schedule (task, expected_every, grace) values
  ('prune_otp_challenges', '1 day', '6 hours')
on conflict (task) do nothing;

/**
 * run_maintenance, second edition: the 0012 function plus the OTP pruning
 * task. Each task stays isolated so one failure does not abandon the others.
 */
create or replace function run_maintenance()
returns table (task text, ok boolean, result jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_res   jsonb;
begin
  -- prune_rate_limits -------------------------------------------------------
  v_start := clock_timestamp();
  begin
    v_res := jsonb_build_object('deleted', prune_rate_limits());
    insert into maintenance_runs (task, duration_ms, result, ok)
    values ('prune_rate_limits',
            extract(milliseconds from clock_timestamp() - v_start)::int, v_res, true);
    return query select 'prune_rate_limits'::text, true, v_res;
  exception when others then
    insert into maintenance_runs (task, duration_ms, ok, error)
    values ('prune_rate_limits',
            extract(milliseconds from clock_timestamp() - v_start)::int, false, sqlerrm);
    return query select 'prune_rate_limits'::text, false, jsonb_build_object('error', sqlerrm);
  end;

  -- prune_device_sessions ---------------------------------------------------
  v_start := clock_timestamp();
  begin
    v_res := jsonb_build_object('deleted', prune_device_sessions());
    insert into maintenance_runs (task, duration_ms, result, ok)
    values ('prune_device_sessions',
            extract(milliseconds from clock_timestamp() - v_start)::int, v_res, true);
    return query select 'prune_device_sessions'::text, true, v_res;
  exception when others then
    insert into maintenance_runs (task, duration_ms, ok, error)
    values ('prune_device_sessions',
            extract(milliseconds from clock_timestamp() - v_start)::int, false, sqlerrm);
    return query select 'prune_device_sessions'::text, false, jsonb_build_object('error', sqlerrm);
  end;

  -- prune_otp_challenges (0016) --------------------------------------------
  v_start := clock_timestamp();
  begin
    v_res := jsonb_build_object('deleted', prune_otp_challenges());
    insert into maintenance_runs (task, duration_ms, result, ok)
    values ('prune_otp_challenges',
            extract(milliseconds from clock_timestamp() - v_start)::int, v_res, true);
    return query select 'prune_otp_challenges'::text, true, v_res;
  exception when others then
    insert into maintenance_runs (task, duration_ms, ok, error)
    values ('prune_otp_challenges',
            extract(milliseconds from clock_timestamp() - v_start)::int, false, sqlerrm);
    return query select 'prune_otp_challenges'::text, false, jsonb_build_object('error', sqlerrm);
  end;

  -- stale device alerts -----------------------------------------------------
  v_start := clock_timestamp();
  begin
    v_res := jsonb_build_object(
      'raised',   raise_stale_device_alerts(),
      'resolved', resolve_stale_device_alerts());
    insert into maintenance_runs (task, duration_ms, result, ok)
    values ('stale_device_alerts',
            extract(milliseconds from clock_timestamp() - v_start)::int, v_res, true);
    return query select 'stale_device_alerts'::text, true, v_res;
  exception when others then
    insert into maintenance_runs (task, duration_ms, ok, error)
    values ('stale_device_alerts',
            extract(milliseconds from clock_timestamp() - v_start)::int, false, sqlerrm);
    return query select 'stale_device_alerts'::text, false, jsonb_build_object('error', sqlerrm);
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants — every function is born with PUBLIC execute (the 0015 M1 lesson),
-- so everything is revoked first and the door list is explicit.
-- ---------------------------------------------------------------------------

-- Internal machinery: no direct callers at all. These execute only from
-- inside the DEFINER entry points, as the function owner.
revoke all on function auth_token_hash(text)                        from public;
revoke all on function auth_normalise_phone(text)                   from public;
revoke all on function auth_session_lifetime(uuid)                  from public;
revoke all on function auth_resolve_member(text, text)              from public;
revoke all on function consume_otp(text, text, text)                from public;
revoke all on function issue_device_session(uuid, uuid, text, text) from public;
revoke all on function prune_otp_challenges(interval)               from public;

-- The transport seam: papa_auth ONLY. A client that can call request_otp can
-- read the code, and an OTP the client can read is not an OTP.
revoke all on function request_otp(text, text)                              from public;
revoke all on function enrol_verified_device(text, text, text, text, text)  from public;
grant execute on function
  request_otp(text, text),
  enrol_verified_device(text, text, text, text, text)
  to papa_auth;

-- The client surface.
revoke all on function complete_enrolment(text, text, text, text, text, text) from public;
revoke all on function authenticate_device(text)                              from public;
revoke all on function auth_pre_request()                                     from public;
revoke all on function switch_session_user(uuid, text)                        from public;
revoke all on function set_member_pin(uuid, text)                             from public;
revoke all on function reset_pin_with_otp(text, text, text, text)             from public;
revoke all on function invite_member(text, text, text, text)                  from public;
revoke all on function revoke_device(text, text, boolean)                     from public;
revoke all on function sign_out_device()                                      from public;
revoke all on function current_device_id()                                    from public;
revoke all on function current_session_id()                                   from public;

grant execute on function
  complete_enrolment(text, text, text, text, text, text),
  authenticate_device(text),
  auth_pre_request(),
  switch_session_user(uuid, text),
  set_member_pin(uuid, text),
  reset_pin_with_otp(text, text, text, text),
  invite_member(text, text, text, text),
  revoke_device(text, text, boolean),
  sign_out_device(),
  current_device_id(),
  current_session_id()
  to papa_app;

-- run_maintenance was already revoked from public in 0012; CREATE OR REPLACE
-- preserves the ACL, but saying it again costs nothing and protects against
-- a future edit that recreates rather than replaces.
revoke all on function run_maintenance() from public;
