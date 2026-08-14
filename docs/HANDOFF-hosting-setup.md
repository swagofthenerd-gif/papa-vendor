# Handoff: get Papa Vendor onto Supabase + Cloudflare R2

**For a local Claude Code session with the user present.** The user has already
created a Supabase account and a Cloudflare account and has both open in a
browser. They are **not** a programmer — explain what you are doing in plain
words, and never ask them to run something you have not explained.

Everything here needs either their browser or their secrets, which is why it
could not be done from the cloud session.

---

## What already exists

The repo is at `swagofthenerd-gif/papa-vendor`, branch
`claude/concurrent-write-load-test` (PR #1, CI green).

- `db/migrations/0001` … `0014` — the whole schema. Plain PostgreSQL 16, no
  Supabase-specific anything. `db/README.md` explains why that matters.
- `db/fixtures.sql` — **TEST ONLY. NEVER apply this to the real database.**
  It exists so pgTAP fixtures can toggle row-level security. On a live database
  it is a way to turn tenancy off.
- `db/tests/` — 321 pgTAP assertions.
- `.github/workflows/ci.yml` — runs tests on every push. Does **not** deploy.
- `docs/production-readiness.md` — the honest ledger. **Update it as you go.**

Nothing has ever been deployed. There is no live database yet.

---

## Step 1 — Supabase project

In the browser, with the user:

1. **New project.** Region **Singapore** (`ap-southeast-1`).
   This was decided deliberately — see `docs/hosting-decision.md`. Hosting
   Pakistani rental houses' customer records in **Mumbai** is a live political
   sensitivity, and the region cannot be changed later without recreating the
   project and migrating data.
2. Plan: **Pro (~$25/mo)**. Free tier pauses after inactivity, which will look
   like the app is broken.
3. **Set a strong database password and save it in their password manager.**
   Supabase shows it once.
4. Do **not** turn on Point-in-Time Recovery. It is $100/mo — four times the
   rest of the infrastructure. The ledger records the decision to wait for
   revenue and rely on Pro's 7-day backups plus the append-only event log.

Then: **Project Settings → Database → Connection string → URI**.
Take the **direct connection** (port 5432), not the pooled one (6543).
Migrations create roles and extensions; the pooler cannot.

---

## Step 2 — Apply the migrations

From the repo root, with `SUPABASE_DB_URL` set to that direct URI:

```bash
for f in db/migrations/*.sql; do
  echo "applying $(basename "$f")"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f" || break
done
```

**In order. Never skip one. Never apply `db/fixtures.sql`.**

Things that may bite, in likelihood order:

- **`pgcrypto`** — `0001` creates it. Supabase usually has it; if the extension
  lives in a `extensions` schema, `gen_random_bytes` may need
  `set search_path = public, extensions;` first.
- **`papa_app`** — `0001` creates it as `nologin nosuperuser nobypassrls`.
  `nologin` is correct: it is assumed via `set role`, not connected as. Do not
  "fix" that by giving it a password without understanding what it does to
  tenancy — the whole isolation model rests on the app never being superuser.
- **Supabase's own roles** (`anon`, `authenticated`, `service_role`) are
  untouched by these migrations and can be ignored for now. **Auth is not built
  yet** — nobody can log in regardless.

**Verify it took.** Run these and expect what is stated:

```sql
-- 23 tables with row-level security ON, 22 of them FORCED
select count(*) filter (where relrowsecurity)      as rls_on,
       count(*) filter (where relforcerowsecurity) as forced
  from pg_class where relkind='r' and relnamespace='public'::regnamespace;

-- must return ZERO rows: no sensitive column on any syncable table
select * from sync_pii_violations();

-- must be false: papa_app must never bypass RLS
select rolbypassrls from pg_roles where rolname = 'papa_app';
```

If `rls_on` is not 23, stop and find out why before going further. Everything
about tenancy depends on it.

---

## Step 3 — Cloudflare R2 bucket

1. **R2 → Create bucket**, name `papa-vendor-photos`. Location: **APAC**.
2. **R2 → Manage API tokens → Create API token**, permission
   *Object Read & Write*, scoped to that bucket only.
3. Save the **Access Key ID** and **Secret Access Key** — shown once.

R2 rather than Supabase Storage because R2 charges **$0 egress** against
Supabase's $0.09/GB. About $9/month different today; roughly **$8,000/month at
10,000 customers**. This is in the ledger; do not quietly switch it.

**Also agree a photo retention policy with the user before the pilot** —
24 months is the ledger's suggestion. Photos accumulate forever while revenue
per customer stays flat, which is the one cost line that can run away.

---

## Step 4 — Secrets into GitHub, not into chat

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `SUPABASE_DB_URL` | the direct connection URI from step 1 |
| `R2_ACCESS_KEY_ID` | from step 3 |
| `R2_SECRET_ACCESS_KEY` | from step 3 |
| `R2_BUCKET` | `papa-vendor-photos` |

**Never commit these to the repo and never paste them into a chat transcript.**
If one is pasted somewhere by accident, rotate it rather than hoping.

---

## Step 5 — Deploy migrations from CI

Add a **separate** workflow, not a step inside `ci.yml`. Tests must be able to
run on a pull request without touching the live database.

`.github/workflows/deploy.yml`:

```yaml
name: Deploy migrations

on:
  push:
    branches: [main]        # main only — never from a PR branch
  workflow_dispatch:

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Apply migrations in order
        env:
          DB: ${{ secrets.SUPABASE_DB_URL }}
        run: |
          for f in db/migrations/*.sql; do
            echo "applying $(basename "$f")"
            psql "$DB" -v ON_ERROR_STOP=1 -f "$f"
          done
      - name: Tenancy must still hold
        env:
          DB: ${{ secrets.SUPABASE_DB_URL }}
        run: |
          psql "$DB" -tAc "select count(*) from sync_pii_violations()" | grep -qx 0
          psql "$DB" -tAc "select rolbypassrls from pg_roles where rolname='papa_app'" | grep -qx f
```

The migrations are written to be re-runnable, but **they are not all
idempotent** — check before assuming a re-run is safe.

---

## Step 6 — Tell the cloud session

Reply in the cloud session with:

- the **Supabase project URL** (`https://<ref>.supabase.co`) — not secret
- the **region** it actually got created in
- the **R2 bucket name**
- whether the three verification queries in step 2 returned what they should

Then it can wire up auth and the photo pipeline.

---

## Do NOT do these

- **Do not apply `db/fixtures.sql` to the live database.** It disables
  row-level security. It exists only so the test suite can seed data.
- **Do not enable PITR** yet ($100/mo). Decision is in the ledger.
- **Do not switch photos to Supabase Storage.** See the egress numbers above.
- **Do not give `papa_app` superuser or `bypassrls`.** Every tenancy guarantee
  in 321 assertions assumes it has neither.
- **Do not edit migrations 0001–0014** now that they are applied anywhere.
  Add `0015`.

---

## What is still not done afterwards

Deploying the database does not make the app usable. Still missing:

1. **Auth** — phone OTP at enrolment, device session, per-user PIN.
   OTP **at enrolment only**: ~$0.47/segment to Pakistan, ~$473/mo at 100
   customers for logins alone, 19× the infra budget. And a competitor's users
   were locked out by OTP *"for hours at a time, causing them to lose jobs"*.
2. **SQLCipher on the device.** See `packages/core/src/db/device-key.ts` — the
   contract is written and the requirement is enforced by types; the driver
   itself does not exist. **There is no Capacitor app yet.**
3. **`scan_events` partitioning** — `docs/partitioning-decision.md` needs two
   decisions from the user before any migration is written.
4. **A scheduler** calling `run_maintenance()` hourly (Supabase cron works),
   and one calling the cold export.
5. **Connection pooling** — for normal app traffic use the pooled connection
   (6543). Migrations are the exception.
