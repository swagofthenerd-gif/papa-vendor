# db/

Migrations, tests, and the local test harness.

## Why this is not called `supabase/`

It was, and the name was the single biggest lock-in risk in the repository —
not because of anything in the code, but because a directory called `supabase/`
eventually convinces someone that a Supabase dependency exists, and then they
add one.

**None of this is Supabase-specific.** It is plain PostgreSQL 16:

- one extension, `pgcrypto`
- UUIDv7 hand-written in plpgsql, deliberately avoiding an extension dependency
- a `papa_app` role owned by this repo (`NOSUPERUSER NOBYPASSRLS`, no DELETE)
- identity read from `current_setting()`, with a vendor-free `papa.*` fallback
  that every one of the 241 assertions uses
- `SECURITY INVOKER` everywhere except three argued exceptions

`run-tests.sh` proves it on every push: it applies every migration and runs the
whole suite against stock `postgres:16-bookworm` in a container. **That is a
continuous portability regression test**, and it is the most valuable thing
protecting our freedom to move hosts.

Moving to RDS, Aurora, Cloud SQL or Neon is roughly **1–2 days** of work. It
stays that way only if the rules in `CONTRIBUTING.md` hold.

## Run it

```bash
npm run test:sql          # throwaway container, migrations, pgTAP
KEEP=1 ./db/run-tests.sh  # leave the container up to poke at it
```

Needs podman or docker. No Supabase account, no cloud, no network beyond
pulling the Postgres image once.
