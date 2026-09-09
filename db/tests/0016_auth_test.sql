-- ============================================================================
-- 0016 — Authentication
--
-- Every property the auth layer claims, tested for the property it ACTUALLY
-- has rather than the one it sounds like — the 0007 rule. The load-bearing
-- ones:
--
--   * a token proves a session (valid), and expired / revoked / garbage /
--     cross-org tokens are indistinguishable failures;
--   * the papa.* context cannot be escalated by a client — authenticate
--     OVERWRITES it on success and RAISES on failure, and the trust model for
--     the parts SQL cannot enforce is documented below;
--   * device binding closes the 2026-09-02 open item — a batch cannot claim a
--     device the session did not prove;
--   * the PIN gate switches users and LOCKS OUT via the shared limiter;
--   * failure is a value where it must be counted (wrong OTP / wrong PIN
--     commit their attempt instead of raising it away);
--   * enrolment is idempotent per device.
--
-- ============================================================================
begin;
select plan(70);

set local role postgres;

-- A single capture table for the codes and tokens that flow between calls.
-- Granted to the app roles so the realistic role-switched calls can read it.
create temp table _cap (k text primary key, v text);
grant select, insert, update, delete on _cap to papa_app, papa_auth;

select fixture_rls_off();

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');

insert into users (id, display_name, phone) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal the tech',    '+923000000002'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran the owner',   '+923000000001'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif the driver', '+923000000003'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Zoya read-only',    '+923000000004'),
  ('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'Rana (org2 owner)', '+923000000005'),
  ('ffffffff-ffff-7fff-8fff-ffffffffffff', 'Dual (both orgs)',  '+923000000006');

insert into memberships (org_id, user_id, role, pin_hash, pin_set_at) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse',
   crypt('4321', gen_salt('bf')), now()),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner',
   crypt('1111', gen_salt('bf')), now()),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver', null, null),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'readonly', null, null),
  ('11111111-1111-7111-8111-111111111111', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk',
   crypt('2468', gen_salt('bf')), now()),
  ('22222222-2222-7222-8222-222222222222', 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', 'owner', null, null),
  ('22222222-2222-7222-8222-222222222222', 'ffffffff-ffff-7fff-8fff-ffffffffffff', 'desk',
   crypt('2468', gen_salt('bf')), now());

insert into devices (id, org_id, label) values
  ('WH-01',  '11111111-1111-7111-8111-111111111111', 'Warehouse phone 1'),
  ('REV-01', '11111111-1111-7111-8111-111111111111', 'Craft-test phone'),
  ('KH-01',  '22222222-2222-7222-8222-222222222222', 'Kamran phone');

insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9');
insert into assets (id, org_id, product_id, asset_code) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-02');

select fixture_rls_on();

-- ---------------------------------------------------------------------------
-- Structure and hygiene
-- ---------------------------------------------------------------------------
select ok(
  (select relforcerowsecurity from pg_class
    where relname = 'otp_challenges' and relnamespace = 'public'::regnamespace),
  'otp_challenges has RLS forced — no policies, no grants, the DEFINER functions are the only door');

select ok(
  (select count(*)::int from pg_policies where tablename = 'otp_challenges') = 0,
  'and it has no policies at all, exactly like rate_limits');

select has_column('users', 'external_auth_id');

select ok(
  exists (select 1 from pg_roles where rolname = 'papa_auth'),
  'the transport role papa_auth exists');

select is(
  (select count(*)::int from pg_proc
    where pronamespace = 'public'::regnamespace and prosecdef
      and proname in ('request_otp','complete_enrolment','enrol_verified_device',
                      'authenticate_device','switch_session_user','set_member_pin',
                      'reset_pin_with_otp','invite_member','revoke_device',
                      'sign_out_device')),
  10,
  'every auth entry point is SECURITY DEFINER');

select ok(
  (select prosecdef = false from pg_proc
    where proname = 'auth_pre_request' and pronamespace = 'public'::regnamespace),
  'the pre-request hook is INVOKER — it only delegates to authenticate_device');

select ok(
  (select bool_and(proconfig::text like '%search_path=public%')
     from pg_proc
    where pronamespace = 'public'::regnamespace and prosecdef
      and proname in ('request_otp','complete_enrolment','authenticate_device',
                      'switch_session_user','set_member_pin','reset_pin_with_otp',
                      'invite_member','revoke_device')),
  'every DEFINER auth function pins search_path — the 0015 hygiene rule');

-- ---------------------------------------------------------------------------
-- request_otp is papa_auth only, and it is not a phone oracle
-- ---------------------------------------------------------------------------
set local role papa_app;

select throws_ok(
  $$select request_otp('+923000000002')$$,
  '42501', null,
  'papa_app cannot call request_otp — a client that reads the code has defeated the OTP');

select throws_ok(
  $$select code_hash from otp_challenges$$,
  '42501', null,
  'and cannot read otp_challenges at all');

select throws_ok(
  $$select token_hash from device_sessions$$,
  '42501', null,
  'nor the session token hash — H3 applied to tokens as it was to pin_hash');

set local role postgres;

-- request_otp refuses phones with no enrolable membership. (Called as
-- superuser for convenience — the restriction itself is proven above.)
select throws_ok(
  $$select request_otp('+920000000000')$$,
  'P0002', null,
  'an unknown phone gets no code — each SMS segment costs ~$0.47');

select throws_ok(
  $$select request_otp('+923000000003')$$,
  'P0002', null,
  'a DRIVER-only phone gets no code — driver gets nothing, the vendor''s rule');

-- ---------------------------------------------------------------------------
-- Enrolment issues a session, sets context, and is idempotent per device
-- ---------------------------------------------------------------------------
insert into _cap values ('code', request_otp('+923000000002', 'enrol'))
  on conflict (k) do update set v = excluded.v;

select matches(
  (select v from _cap where k = 'code'),
  '^[0-9]{6}$',
  'a real member''s phone yields a 6-digit code');

set local role papa_app;

insert into _cap
select 'token', token from complete_enrolment(
  '+923000000002', (select v from _cap where k = 'code'),
  'WH-01', 'Warehouse phone 1', '4321')
on conflict (k) do update set v = excluded.v;

select isnt((select v from _cap where k = 'token'), null,
  'complete_enrolment returns a session token');

select is(current_setting('papa.org_id', true),
  '11111111-1111-7111-8111-111111111111',
  'and sets papa.org_id for this transaction — every existing RLS/RPC now works unchanged');

select is(current_setting('papa.user_id', true),
  'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  'and papa.user_id');

select is(current_setting('papa.device_id', true), 'WH-01',
  'and papa.device_id — device identity has no JWT channel');

set local role postgres;

select is((select count(*)::int from device_sessions
            where device_id = 'WH-01' and revoked_at is null), 1,
  'exactly one live session for the device');

-- Re-enrol the SAME device: supersede, do not multiply.
insert into _cap values ('code', request_otp('+923000000002', 'enrol'))
  on conflict (k) do update set v = excluded.v;
set local role papa_app;
insert into _cap
select 'token', token from complete_enrolment(
  '+923000000002', (select v from _cap where k = 'code'), 'WH-01')
on conflict (k) do update set v = excluded.v;
set local role postgres;

select is((select count(*)::int from device_sessions
            where device_id = 'WH-01' and revoked_at is null), 1,
  'idempotent per device: re-enrolment supersedes, it does not accumulate sessions');

select is((select count(*)::int from memberships
            where user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'), 1,
  'and creates no duplicate membership');

select is((select count(*)::int from users where phone = '+923000000002'), 1,
  'nor a duplicate user');

-- ---------------------------------------------------------------------------
-- authenticate_device — valid / garbage / expired / revoked-row
-- ---------------------------------------------------------------------------
set local papa.org_id = ''; set local papa.user_id = ''; set local papa.device_id = '';
set local role papa_app;

select is(
  (select org_id from authenticate_device((select v from _cap where k = 'token'))),
  '11111111-1111-7111-8111-111111111111'::uuid,
  'a valid token authenticates to its org');

select is(current_setting('papa.user_id', true),
  'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  'and sets the session user');

select throws_ok(
  $$select authenticate_device('not-a-real-token')$$,
  '28000', 'invalid or expired device session',
  'garbage fails with one generic message');

set local role postgres;
insert into device_sessions (org_id, device_id, user_id, token_hash, issued_at,
                             last_seen_at, expires_at)
values ('11111111-1111-7111-8111-111111111111', 'REV-01',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
        auth_token_hash('expiredtok'), now(), now(), now() - interval '1 day');
set local role papa_app;

select throws_ok(
  $$select authenticate_device('expiredtok')$$,
  '28000', 'invalid or expired device session',
  'an expired token fails with the SAME message — no distinction from garbage');

set local role postgres;
insert into device_sessions (org_id, device_id, user_id, token_hash, issued_at,
                             last_seen_at, expires_at, revoked_at)
values ('11111111-1111-7111-8111-111111111111', 'REV-01',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
        auth_token_hash('killedtok'), now(), now(), now() + interval '1 day',
        now());
set local role papa_app;

select throws_ok(
  $$select authenticate_device('killedtok')$$,
  '28000', 'invalid or expired device session',
  'a revoked-at session fails identically');

-- The revocations TABLE is honoured even when the session row itself is clean:
-- a revocation created at-or-after the session's issue kills it at next
-- contact. This is the offline "lost phone" story.
set local role postgres;
insert into device_sessions (org_id, device_id, user_id, token_hash, issued_at,
                             last_seen_at, expires_at)
values ('11111111-1111-7111-8111-111111111111', 'REV-01',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
        auth_token_hash('revrowtok'), now() - interval '1 minute',
        now() - interval '1 minute', now() + interval '30 days');
insert into revocations (org_id, scope, subject, reason, created_at)
values ('11111111-1111-7111-8111-111111111111', 'device', 'REV-01',
        'lost', now());
set local role papa_app;

select throws_ok(
  $$select authenticate_device('revrowtok')$$,
  '28000', 'invalid or expired device session',
  'a clean session is still refused when a revocations row postdates its issue — the honoured revocation');

-- Suspending the membership de-authenticates at next contact.
set local role postgres;
insert into device_sessions (org_id, device_id, user_id, token_hash, issued_at,
                             last_seen_at, expires_at)
values ('11111111-1111-7111-8111-111111111111', 'REV-01',
        'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
        auth_token_hash('suspendedtok'), now(), now(), now() + interval '30 days');
update memberships set status = 'suspended'
 where org_id = '11111111-1111-7111-8111-111111111111'
   and user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
set local role papa_app;

select throws_ok(
  $$select authenticate_device('suspendedtok')$$,
  '28000', null,
  'a session whose member was suspended fails to authenticate');

set local role postgres;
update memberships set status = 'active'
 where org_id = '11111111-1111-7111-8111-111111111111'
   and user_id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

-- ---------------------------------------------------------------------------
-- Sliding expiry
-- ---------------------------------------------------------------------------
-- On WH-01, not REV-01: the REV-01 revocation row above would (correctly)
-- kill any REV-01 session issued before it, and this one expects success.
set local role postgres;
insert into device_sessions (org_id, device_id, user_id, token_hash, issued_at,
                             last_seen_at, expires_at)
values ('11111111-1111-7111-8111-111111111111', 'WH-01',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
        auth_token_hash('slidetok'), now() - interval '20 minutes',
        now() - interval '20 minutes', now() + interval '1 day');
set local role papa_app;

select ok(
  (select expires_at from authenticate_device('slidetok'))
    > now() + interval '30 days',
  'a contacted session slides its expiry forward — a phone used weekly never hits the wall');

-- ---------------------------------------------------------------------------
-- GUC injection resistance / the trust model
--
-- SQL cannot itself forbid set_config('papa.org_id', …) — any role may set a
-- custom GUC, and the pgTAP harness relies on exactly that. The security
-- property is therefore NOT "the database blocks the write"; it is:
--   (1) the gateway (PostgREST/Supabase REST) exposes only whitelisted
--       public functions and never runs client SQL, so a client has no way to
--       call set_config at all — documented, not testable here; and
--   (2) whatever papa.* held, authenticate_device OVERWRITES it on success
--       and RAISES on failure, so a forged value cannot survive a real
--       authenticate and a failed one aborts the whole request transaction.
-- (1) is the trust boundary; (2) is what this migration guarantees and what
-- these two assertions pin.
-- ---------------------------------------------------------------------------
set local role papa_app;
set local papa.org_id  = '22222222-2222-7222-8222-222222222222';   -- forged: org2
set local papa.user_id = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';    -- forged: org2 owner

select is(
  (select org_id from authenticate_device((select v from _cap where k = 'token'))),
  '11111111-1111-7111-8111-111111111111'::uuid,
  'authenticate OVERWRITES a forged papa.* context with session truth — a stale/poisoned value cannot survive it');

select is(current_setting('papa.user_id', true),
  'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  'the forged user is replaced too');

-- On failure the function raises, which at the gateway aborts the transaction
-- and discards any GUC a client managed to set before it.
set local papa.org_id = '22222222-2222-7222-8222-222222222222';
select throws_ok(
  $$select authenticate_device('garbage-after-forge')$$,
  '28000', null,
  'a failed authenticate RAISES — the request transaction (and any forged GUC in it) dies');

-- ---------------------------------------------------------------------------
-- Device binding — the 2026-09-02 open item, closed
-- ---------------------------------------------------------------------------
set local papa.org_id = ''; set local papa.user_id = ''; set local papa.device_id = '';
set local role papa_app;
select is(
  (select device_id from authenticate_device((select v from _cap where k = 'token'))),
  'WH-01',
  're-authenticate the warehouse phone before the binding tests');

select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 1, 'event_type', 'check_out',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'device_time', now()::text)))),
  'accepted',
  'the authenticated device may submit as itself');

select throws_ok(
  $$select * from submit_scan_batch('KH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 2, 'event_type', 'check_in',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'device_time', now()::text)))$$,
  '42501', null,
  'but it CANNOT submit under another device id — spoofing another device''s idempotency slots is refused');

-- The documented residual: with NO device session (a console JWT, or legacy
-- tests) a bare device string is still accepted. Pinned so a future decision
-- to harden it is a deliberate, test-breaking change.
set local papa.device_id = '';
select is(
  (select outcome from submit_scan_batch('WH-01', jsonb_build_array(
     jsonb_build_object('client_seq', 3, 'event_type', 'check_in',
       'asset_id', '30000000-0000-7000-8000-000000000001',
       'device_time', (now() + interval '1 min')::text)))),
  'accepted',
  'with no device session the bare device string still works — the documented residual');

-- ---------------------------------------------------------------------------
-- Cross-org token misuse
-- ---------------------------------------------------------------------------
set local role postgres;
insert into _cap values ('code2', request_otp('+923000000005', 'enrol'))
  on conflict (k) do update set v = excluded.v;
set local role papa_app;
insert into _cap
select 'token2', token from complete_enrolment(
  '+923000000005', (select v from _cap where k = 'code2'), 'KH-01')
on conflict (k) do update set v = excluded.v;

select is(
  (select org_id from authenticate_device((select v from _cap where k = 'token2'))),
  '22222222-2222-7222-8222-222222222222'::uuid,
  'an org2 token authenticates strictly as org2 — the token carries the org, the client does not choose it');

select throws_ok(
  $$select * from submit_scan_batch('WH-01', jsonb_build_array(
      jsonb_build_object('client_seq', 9, 'event_type', 'check_out',
        'asset_id', '30000000-0000-7000-8000-000000000001',
        'device_time', now()::text)))$$,
  '42501', null,
  'and cannot reach across to org1''s device — cross-org token misuse is refused at the binding check');

-- ---------------------------------------------------------------------------
-- Multi-org phone: ambiguity is refused BEFORE the code is consumed
-- ---------------------------------------------------------------------------
set local role postgres;
insert into _cap values ('code6', request_otp('+923000000006', 'enrol'))
  on conflict (k) do update set v = excluded.v;
set local role papa_app;

select throws_ok(
  format($$select complete_enrolment('+923000000006', %L, 'DUAL-01')$$,
         (select v from _cap where k = 'code6')),
  '22023', null,
  'a phone in two orgs must name the org — refused before the code is spent, so it survives the retry');

select is(
  (select org_id from complete_enrolment('+923000000006',
     (select v from _cap where k = 'code6'), 'DUAL-01', '', null, 'lumos')),
  '11111111-1111-7111-8111-111111111111'::uuid,
  'and the retry with an org slug resolves and enrols');

-- ---------------------------------------------------------------------------
-- Failure is a value: a wrong / unknown attempt COMMITS instead of raising,
-- so the counter it feeds is real
-- ---------------------------------------------------------------------------
set local role postgres;
insert into _cap values ('code_w', request_otp('+923000000002', 'enrol'))
  on conflict (k) do update set v = excluded.v;
set local role papa_app;

select is(
  (select token from complete_enrolment('+923000000002', '000000', 'WH-01')),
  null,
  'a wrong code returns a null token — it does NOT raise, so the attempt commits and the limiter counts it');

select is(
  (select token from complete_enrolment('+920000000000', '123456', 'ANY-01')),
  null,
  'an unknown phone returns the same null-token face — the endpoint is not a phone-number oracle');

-- ---------------------------------------------------------------------------
-- PIN gate — switch, refusals, and lockout
-- ---------------------------------------------------------------------------
set local papa.org_id = ''; set local papa.user_id = ''; set local papa.device_id = '';
set local role papa_app;
select is(
  (select user_id from authenticate_device((select v from _cap where k = 'token'))),
  'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'authenticate WH-01 before the PIN tests');

select ok(
  switch_session_user('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', '1111'),
  'the owner''s correct PIN switches the session to the owner');

select is(current_setting('papa.user_id', true),
  'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
  'and papa.user_id now speaks as the owner — money actions unlock');

select ok(
  not switch_session_user('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', '9999'),
  'a wrong PIN returns false (not a raise) so the lockout counter commits');

select throws_ok(
  $$select switch_session_user('cccccccc-cccc-7ccc-8ccc-cccccccccccc', '0000')$$,
  '42501', null,
  'a driver cannot be switched to — driver gets nothing');

select throws_ok(
  $$select switch_session_user('eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee', '0000')$$,
  '42501', null,
  'nor a person who is not a member of this session''s org');

-- Lockout: wrong PINs against one user exhaust the shared 5/min bucket.
do $$
declare locked boolean := false;
begin
  for i in 1..8 loop
    begin
      perform switch_session_user('ffffffff-ffff-7fff-8fff-ffffffffffff', '9999');
    exception
      when too_many_connections then locked := true; exit;
    end;
  end loop;
  if not locked then
    raise exception 'expected the PIN gate to lock out after repeated wrong guesses';
  end if;
end
$$;
select pass('repeated wrong PINs lock out via the shared rate_limits bucket (verify_pin, 0015)');

-- ---------------------------------------------------------------------------
-- PIN resets — owner protection
-- ---------------------------------------------------------------------------
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';   -- a warehouse tech
select throws_ok(
  $$select set_member_pin('dddddddd-dddd-7ddd-8ddd-dddddddddddd', '5555')$$,
  '42501', null,
  'a warehouse tech cannot reset anyone''s PIN — owner/manager only');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';    -- the owner
select lives_ok(
  $$select set_member_pin('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', '5555')$$,
  'an owner resets a member''s PIN');

select throws_ok(
  $$select set_member_pin('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', '9999')$$,
  '42501', null,
  'but NOBODY resets an owner''s PIN this way — a manager who could would become the owner on money actions');

select throws_ok(
  $$select set_member_pin('cccccccc-cccc-7ccc-8ccc-cccccccccccc', '9999')$$,
  '42501', null,
  'and a driver has no PIN to set');

-- The owner's own PIN moves only by proving the owner's phone.
set local role postgres;
insert into _cap values ('code_r', request_otp('+923000000001', 'pin_reset'))
  on conflict (k) do update set v = excluded.v;
set local role papa_app;

select ok(
  reset_pin_with_otp('+923000000001', (select v from _cap where k = 'code_r'), '7777'),
  'the owner resets their own PIN by OTP re-enrolment — proof of the owner''s phone');

select ok(
  not reset_pin_with_otp('+923000000001', '000000', '8888'),
  'a wrong reset code returns false (committed attempt), it does not raise');

-- ---------------------------------------------------------------------------
-- invite_member — authority is created here, bound at enrolment
-- ---------------------------------------------------------------------------
set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
set local role papa_app;

select isnt(
  (select invite_member('+923000000007', 'New Hire', 'warehouse')),
  null,
  'an owner invites a new member (creates the users row + membership)');

select is(
  (select count(*)::int from memberships m join users u on u.id = m.user_id
    where u.phone = '+923000000007' and m.org_id = '11111111-1111-7111-8111-111111111111'),
  1,
  'and the membership exists for enrolment to bind later');

select lives_ok(
  $$select invite_member('+923000000007', 'New Hire', 'warehouse')$$,
  'inviting the same phone again is idempotent — it does not raise or duplicate');

select is(
  (select count(*)::int from memberships m join users u on u.id = m.user_id
    where u.phone = '+923000000007'),
  1,
  'still exactly one membership');

set local papa.user_id = 'ffffffff-ffff-7fff-8fff-ffffffffffff';   -- a desk (non-owner)
select throws_ok(
  $$select invite_member('+923000000008', 'Would-be owner', 'owner')$$,
  '42501', null,
  'only an owner may mint another owner — the same escalation set_member_pin guards');

-- ---------------------------------------------------------------------------
-- revoke_device — the lost phone, and the front-door return
-- ---------------------------------------------------------------------------
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';   -- owner
select ok(
  (select revoke_device('WH-01', 'phone lost at a shoot') >= 1),
  'an owner revokes the lost phone and at least one live session dies');

select is(
  (select count(*)::int from revocations
    where scope = 'device' and subject = 'WH-01'
      and org_id = '11111111-1111-7111-8111-111111111111'),
  1,
  'a durable revocation record is written — it must outlive the sessions it kills');

set local papa.org_id = ''; set local papa.user_id = ''; set local papa.device_id = '';
select throws_ok(
  $$select authenticate_device((select v from _cap where k = 'token'))$$,
  '28000', null,
  'the revoked phone''s token no longer authenticates');

-- The found phone comes back through the front door: a fresh enrolment
-- postdates the revocation and is legitimate. The OTP request window has
-- passed by now (the phone was lost and found), so clear the per-phone
-- request bucket to model that elapsed time.
set local role postgres;
delete from rate_limits where bucket like 'otp%923000000002%';
insert into _cap values ('code_re', request_otp('+923000000002', 'enrol'))
  on conflict (k) do update set v = excluded.v;
set local role papa_app;
insert into _cap
select 'token_re', token from complete_enrolment(
  '+923000000002', (select v from _cap where k = 'code_re'), 'WH-01')
on conflict (k) do update set v = excluded.v;

select is(
  (select device_id from authenticate_device((select v from _cap where k = 'token_re'))),
  'WH-01',
  're-enrolment AFTER the revocation works — the found phone returns via the front door, with an SMS');

-- ---------------------------------------------------------------------------
-- sign_out_device clears the context and kills the session
-- ---------------------------------------------------------------------------
select lives_ok($$select sign_out_device()$$,
  'a device signs itself out');

select is(current_setting('papa.org_id', true), '',
  'and the rest of the transaction is nobody');

-- ---------------------------------------------------------------------------
-- The PostgREST seam
-- ---------------------------------------------------------------------------
set local papa.org_id = ''; set local papa.user_id = '';
-- A fresh live session for the header test (token_re was just signed out).
-- issued_at = clock_timestamp() places it AFTER the WH-01 revocation, so it
-- is not swept up by it.
set local role postgres;
insert into device_sessions (org_id, device_id, user_id, token_hash, issued_at,
                             last_seen_at, expires_at)
values ('11111111-1111-7111-8111-111111111111', 'WH-01',
        'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
        auth_token_hash('hdrtok'), clock_timestamp(), clock_timestamp(),
        now() + interval '30 days');
select set_config('request.headers',
  jsonb_build_object('x-papa-session', 'hdrtok')::text, true);
set local role papa_app;

select lives_ok($$select auth_pre_request()$$,
  'the db-pre-request hook authenticates from the x-papa-session header');

select is(current_setting('papa.user_id', true),
  'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  'and the request now carries the session user, with no app code involved');

set local role postgres;
select set_config('request.headers', '{}', true);
set local role papa_app;
select lives_ok($$select auth_pre_request()$$,
  'with no session header the hook is a no-op — public endpoints keep working');

set local role postgres;
select set_config('request.headers', '{"x-papa-session":"bad"}', true);
set local role papa_app;
select throws_ok($$select auth_pre_request()$$,
  '28000', null,
  'a bad token in the header raises — PostgREST aborts the transaction, no identity half-set');

select * from finish();
rollback;
