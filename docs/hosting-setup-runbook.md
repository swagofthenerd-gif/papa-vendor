# Hosting setup runbook — putting the pipe live

Everything here is setup on accounts the code cannot reach: the gateway the
phones call, the SMS that carries an enrolment code, and the bucket photos
land in. The app and the database are finished and proven against this exact
configuration locally (`npm run test:pipe`); what follows is how to reproduce
it on the live project, in order, with a test after each step so nothing is
believed without proof.

**Written by Claude (Opus 5), 2026-09-16, from the code — not from a live
Supabase session.** Where a Supabase behaviour is documented-but-unverified
it says so. Every SQL block is safe to run twice.

---

## The shape, in one picture

```
phone (offline first)  ──HTTPS──▶  gateway (PostgREST)  ──▶  Postgres (Supabase)
   outbox, local SQLite            reads x-papa-session        RLS + RPCs
                                   sets papa.org_id/user_id
```

The phone never talks to Postgres directly and never carries a vendor SDK.
One function runs at the top of every request (`auth_pre_request`), turns the
session header into the caller's identity, and the database's own rules do the
rest. That single hook is the whole contract — `docs/hosting-decision.md`,
"The PostgREST contract".

## The decision you have to make first

| | **A — Supabase's own gateway** | **B — our own tiny gateway** |
|---|---|---|
| What it is | Configure the PostgREST that Supabase already runs | One container of PostgREST on a small VPS, pointed at the Supabase pooler |
| Cost | Rs 0 extra | about $5/month |
| Effort | Four SQL statements, if their in-database config works as documented | 20 minutes once, then it is ours |
| Risk | Their gateway also forces a public API key and a JWT on every request (see the trap below); settings can be reset by platform changes | One more box to keep alive and patch |
| Matches the local proof | Almost | **Exactly** |

**Recommendation: try A, keep B in your pocket.** A costs nothing and four
statements; if its test fails, B is the same afternoon and is the configuration
the ten local scenarios actually ran against. Nothing in the app changes
between them; only the address the phone is given.

---

## Step 1 — the gateway's login (both paths)

The gateway needs a database login that can do nothing except become the
application role. Run this in the Supabase SQL editor, replacing the password
with a long random one you keep in your password manager.

```sql
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'papa_authenticator') then
    create role papa_authenticator login noinherit nosuperuser nobypassrls
      password 'PUT-A-LONG-RANDOM-PASSWORD-HERE';
  end if;
end $$;
grant papa_app to papa_authenticator;
```

`papa_app` already exists (it is created by the first migration and is the role
every database test runs as). `noinherit` matters: the login by itself can read
nothing.

**Test it.** In the SQL editor:

```sql
select rolcanlogin, rolinherit, rolsuper, rolbypassrls
  from pg_roles where rolname = 'papa_authenticator';
```

Expect `true, false, false, false`.

---

## Step 2A — wire Supabase's gateway

PostgREST can be configured from inside the database, per role. Supabase
documents a pre-request hook this way. Run:

```sql
-- the hook that turns the session header into identity
alter role authenticator set pgrst.db_pre_request = 'public.auth_pre_request';

-- the role every request arrives as on Supabase is `anon`; let it be the app
grant papa_app to anon;
grant execute on function public.auth_pre_request() to anon, authenticator;

-- tell the gateway to re-read its settings
notify pgrst, 'reload config';
```

Two things to understand about the middle line. Supabase's public API key is
meant to be public, so after this grant anyone holding it can *call* our
functions — and that is safe here only because **every write refuses without a
session**: the money and booking functions raise "no org context", and reads go
through row-level security that returns nothing when no session has been
established. That is how they are built and how the database tests prove them.
If you would rather not rely on that, choose path B, where the gateway is ours
and nobody gets a public key at all.

**Test it.** From any computer, with your project's URL and public key:

```bash
curl -s -X POST "https://YOUR-PROJECT.supabase.co/rest/v1/rpc/pull_changes" \
  -H "apikey: YOUR-PUBLIC-ANON-KEY" \
  -H "content-type: application/json" \
  -d '{"p_cursor":0,"p_limit":1}'
```

Expect an empty result or an error about no org context — **not** a list of
anyone's gear. Then repeat with a junk session header:

```bash
curl -s -X POST "https://YOUR-PROJECT.supabase.co/rest/v1/rpc/pull_changes" \
  -H "apikey: YOUR-PUBLIC-ANON-KEY" -H "x-papa-session: not-a-real-token" \
  -H "content-type: application/json" -d '{"p_cursor":0,"p_limit":1}'
```

Expect a refusal mentioning an invalid or expired device session. If you get
the same answer as before, the hook is **not** running and path A has failed:
go to step 2B.

### ⚠ The trap that would break tenancy silently

Identity is read in this order: the request's JWT claims first, then the
session the hook set. Supabase's public key carries a JWT with no user and no
organisation in it, so the order is harmless today. It stops being harmless the
moment a **signed-in Supabase Auth user** calls the API, because that JWT
carries a `sub` claim which would outrank the real session and make the
database believe a different person is acting.

So, on this project: **never enable Supabase Auth sign-in, and never hand the
phone a user JWT.** The phone's only credential is its session header. If you
ever want Supabase Auth for a web dashboard, that is a code change first (the
claim order in `current_user_id()`), not a dashboard toggle.

---

## Step 2B — our own gateway (the fallback, and the one the proof used)

On any small Linux box (a $5 VPS; Karachi or Singapore for latency):

```bash
docker run -d --name papa-gateway --restart always -p 443:3000 \
  -e PGRST_DB_URI="postgres://papa_authenticator:THE-PASSWORD@YOUR-POOLER-HOST:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=papa_app \
  -e PGRST_DB_PRE_REQUEST=public.auth_pre_request \
  -e PGRST_SERVER_PORT=3000 \
  postgrest/postgrest:v12.2.3
```

Use the **session pooler** host from Supabase's connection settings, not the
direct host (the direct one is IPv6-only and unreachable from most providers —
the deploy workflow learned this already). Put a TLS certificate in front
(Caddy with one line, or Cloudflare) because phones must not send a session
header over plain HTTP. No API key exists in this path, and no JWT is ever
involved, so the trap above cannot arise.

**Test it** with the same two curl calls, minus the `apikey` header, against
your own domain.

---

## Step 3 — the enrolment code (SMS)

Enrolling a phone sends one code, once, per person per device. The database
already mints and hashes the code; what is missing is something that reads it
out and sends it. That something must run as the transport role, which nobody
else can use.

```sql
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'papa_sms') then
    create role papa_sms login noinherit nosuperuser nobypassrls
      password 'ANOTHER-LONG-RANDOM-PASSWORD';
  end if;
end $$;
grant papa_auth to papa_sms;
```

Then one small function on any host that can keep a secret (a Supabase Edge
Function, a cron job on the same VPS, anything). Its whole job:

1. Receive a phone number from the desk (the owner's own screen, not a public
   endpoint).
2. Connect as `papa_sms`, `set role papa_auth`, call `request_otp(phone)`.
   It returns the code exactly once; the database keeps only a hash, for ten
   minutes, with five attempts.
3. Hand the code to an SMS provider and forget it. Never log it, never store
   it, never return it to the caller.

On cost: a message to a Pakistani number is roughly $0.47 through an
international provider. At enrolment only this is a few hundred rupees a year
per house; a local aggregator will be cheaper if you already have one. This is
why the design sends a code **once per device, ever** and uses a PIN for daily
use.

**Test it.** Enrol one phone end to end (step 5). If the code never arrives,
the database will still show the attempt: `select phone, created_at, attempts
from otp_challenges order by created_at desc limit 5;`

---

## Step 4 — where photos and voice notes go

The upload path is built and tested; it needs a bucket and a signer. Create an
R2 (or S3) bucket, private, then one function that takes a file path and
returns a short-lived upload URL. Wire it where the app asks for one
(`packages/core/src/upload.ts` takes it as a parameter — that is the seam).
Two rules from the code, both load-bearing:

- **Store the key, never the signed URL.** A signed URL embeds the vendor in
  our data.
- **Nothing deletes an un-uploaded photo.** If the phone fills up, capture is
  blocked with a message instead. A blocked capture is recoverable; a deleted
  photo is evidence destroyed.

---

## Step 5 — prove the live pipe with one real phone

In order, and stop at the first surprise:

1. On the phone, open the app and go to **Settings → This phone → Enrol**.
   Enter the server address from step 2, the phone number, and a PIN.
2. Ask for the code (step 3's function) and enter it. The screen should name
   the house and the person.
3. Watch the fleet arrive. Settings → This phone shows the last sync and how
   many items came down.
4. Turn on flight mode. Scan three items out on a job. The screen must never
   wait for the network.
5. Turn flight mode off. Within a minute the queue should empty and the
   "Backed up" line should say so. In the Supabase table editor, the new scan
   rows are there with the right job.
6. From a second phone, or the SQL editor, confirm the same booking twice on
   purpose. One wins; the loser's phone shows one card naming the winner.

That sequence is the same one the ten local scenarios run automatically. If a
step behaves differently live, the difference is the hosting, not the app.

---

## Backups, before there is anything to lose

- Supabase Pro includes daily backups for seven days. Point-in-time recovery
  is about $100/month and is worth turning on at **first revenue**, not before.
- The event log is append-only, and a nightly cold export of it already exists
  in the database as a function; it needs a scheduler and a bucket to write to.
- **Do one rehearsed restore before any customer data exists**, and write down
  the steps. "We have backups" is worth nothing until somebody has restored one.

---

## What this costs, monthly

| | Now | At a few houses |
|---|---|---|
| Supabase | free tier, or $25 Pro for backups | $25 |
| Gateway (path B only) | $5 | $5 |
| SMS | a few hundred rupees a year | still small |
| Photo storage | free tier | a few dollars |
| Point-in-time recovery | skip | $100 when revenue exists |

---

## What I could not do from here, and why

I have no access to your Supabase dashboard, your domain, an SMS account or a
storage account, so every step above is written to be run by you (or by me, if
you give this session the project credentials — say so explicitly and I will
run and verify each step myself). Two specifics I want to name rather than
imply:

- **Supabase's in-database gateway configuration is documented but unverified
  by me.** Step 2A's test is the only thing that settles it. If it fails, that
  is not a defeat; path B is the configuration the proof already ran.
- **The phone has not yet run live over a real network.** Step 5 is that test,
  and it is the same 30 minutes as your Android scan test. Do them together.
