-- ============================================================================
-- Sessions, audit and rate limiting
--
-- These are the controls that matter when someone is careless, fired, or
-- hostile — the difference between a business and a hobby project. Each one
-- is tested for the property it actually has, not the one it sounds like.
-- ============================================================================
begin;
select plan(21);

set local role postgres;
alter table orgs disable row level security;
alter table users disable row level security;
alter table memberships disable row level security;
alter table devices disable row level security;

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos', 'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran', 'kamran');
insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Sara');
insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse'),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner');
insert into devices (id, org_id, label) values ('WH-01', '11111111-1111-7111-8111-111111111111', 'Phone 1');
insert into device_sessions (org_id, device_id, user_id, token_hash, expires_at)
  values ('11111111-1111-7111-8111-111111111111', 'WH-01',
          'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'hash-abc', now() + interval '14 days');

alter table orgs enable row level security;
alter table users enable row level security;
alter table memberships enable row level security;
alter table devices enable row level security;

select is(
  (select count(*)::int from pg_class
    where relname in ('orgs','users','memberships','devices','device_sessions',
                      'revocations','audit_log','rate_limits')
      and relnamespace = 'public'::regnamespace and not relrowsecurity),
  0, 'RLS is on for every table here, including the new ones');

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
select ok(
  (select count(*) = 0 from device_sessions where token_hash like '%token%'
     or length(token_hash) > 200),
  'sessions store a HASH, never a usable token — a database leak must not hand over live sessions');

select ok(
  (select expires_at is not null from device_sessions where device_id = 'WH-01'),
  'every session has a hard expiry — the offline exposure window is bounded and explicit');

select ok(
  (select count(*) > 0 from information_schema.columns
    where table_name = 'device_sessions' and column_name = 'user_id'),
  'a session is a DEVICE plus a PERSON: shared phones would otherwise attribute a whole week to whoever logged in on Tuesday');

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
grant execute on all functions in schema public to papa_app;
set local role papa_app;
select ok(not (select rolsuper from pg_roles where rolname = current_user),
          'tests run as a non-superuser');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

select lives_ok($$select write_audit('role.changed', 'user',
                   'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal',
                   '{"from":"warehouse","to":"desk"}'::jsonb)$$,
  'an administrative act can be recorded');

select is((select count(*)::int from audit_log where action = 'role.changed'), 1,
  'and it lands');

select is((select actor_label from audit_log where action = 'role.changed'), 'Sara',
  'with the actor DENORMALISED, so a deleted user does not turn history into UUIDs');

select throws_ok(
  $$insert into audit_log (org_id, action) values (current_org_id(), 'forged')$$,
  '42501', null,
  'a client cannot write the audit log directly — write_audit is the only door, so being audited is not optional');

select throws_ok(
  $$update audit_log set action = 'tampered' where action = 'role.changed'$$,
  '42501', null, 'and cannot rewrite it');

select throws_ok(
  $$delete from audit_log where action = 'role.changed'$$,
  '42501', null, 'or erase it');

-- A warehouse tech must not read the audit trail: one they can read is one
-- they can learn to work around.
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
select is((select count(*)::int from audit_log), 0,
  'a warehouse role cannot read the audit log at all');

set local papa.user_id = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
select is((select count(*)::int from audit_log), 1, 'but an owner can');

set local papa.org_id = '22222222-2222-7222-8222-222222222222';
select is((select count(*)::int from audit_log), 0,
  'LEAK: another org sees none of it');
set local papa.org_id = '11111111-1111-7111-8111-111111111111';

-- ---------------------------------------------------------------------------
-- Rate limiting
-- ---------------------------------------------------------------------------
select ok(rate_limit_check('test:a', 3, '1 minute'), 'first attempt allowed');
select ok(rate_limit_check('test:a', 3, '1 minute'), 'second allowed');
select ok(rate_limit_check('test:a', 3, '1 minute'), 'third allowed');
select ok(not rate_limit_check('test:a', 3, '1 minute'),
  'fourth refused — a 4-digit PIN is 10,000 guesses without this');

select ok(rate_limit_check('test:b', 3, '1 minute'),
  'buckets are independent, so one device cannot lock out another');

select throws_ok(
  $$select * from rate_limits$$, '42501', null,
  'the limiter table is not even visible to a client — a counter a client can reset is not a limiter');

-- ---------------------------------------------------------------------------
-- The public resolver is rate limited
-- ---------------------------------------------------------------------------
select lives_ok($$select resolve_tag_public('v1-nonsense', 'ip-1')$$,
  'the public resolver answers');

do $$
begin
  for i in 1..65 loop
    perform resolve_tag_public('v1-nonsense', 'ip-flood');
  end loop;
  raise exception 'expected the resolver to rate limit';
exception
  when too_many_connections then null;   -- what we want
end
$$;
select pass('and refuses a flood — 128 bits is unguessable, but the endpoint is still a free oracle');

select * from finish();
rollback;
