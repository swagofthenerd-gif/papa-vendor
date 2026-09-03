#!/usr/bin/env bash
#
# Tests for db/migrate.sh, against a real Postgres.
#
# The runner's whole job is to be trusted with a live database, so the things
# worth asserting are the ones that would corrupt it or lie about it: applying
# a file twice, applying a file that was edited after it shipped, recording a
# migration that actually failed. None of those can be checked by reading the
# script; they need a database with state in it.
#
#   ./db/test-migrate.sh
#
set -euo pipefail

CONTAINER=papa-pg-migrate-test
IMAGE=docker.io/library/postgres:16-bookworm
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

runtime=$(command -v podman || command -v docker) || {
  echo "need podman or docker" >&2
  exit 1
}

cleanup() { "$runtime" rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "==> starting postgres"
"$runtime" run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=papa -e POSTGRES_DB=postgres "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  "$runtime" exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
"$runtime" exec "$CONTAINER" pg_isready -U postgres -q || {
  echo "postgres did not become ready" >&2; exit 1; }

DB_BASE='postgresql://postgres:papa@localhost:5432'

passed=0; failed=0
ok()   { passed=$((passed+1)); echo "    ok — $1"; }
notok(){ failed=$((failed+1)); echo "not ok — $1"; }
is()   { # is <actual> <expected> <name>
  if [[ "$1" == "$2" ]]; then ok "$3"; else notok "$3 (got '$1', wanted '$2')"; fi
}

# Each case gets its own database, so a case cannot pass because of residue
# left by the one before it.
fresh_db() {
  "$runtime" exec "$CONTAINER" psql -U postgres -X -q -c "drop database if exists $1" >/dev/null
  "$runtime" exec "$CONTAINER" psql -U postgres -X -q -c "create database $1" >/dev/null
}

# A pristine copy of db/ inside the container for every case, so a case that
# edits a migration on purpose cannot leak that edit into the next one — or,
# far worse, into the real working tree.
load_db_dir() {
  "$runtime" exec "$CONTAINER" rm -rf /work >/dev/null 2>&1 || true
  "$runtime" exec "$CONTAINER" mkdir -p /work >/dev/null
  "$runtime" cp "$HERE" "$CONTAINER":/work/db
}

run_migrate() { # run_migrate <dbname> [args...]  -> prints output, returns exit code
  local db="$1"; shift
  "$runtime" exec -e "DB=$DB_BASE/$db" "$CONTAINER" \
    bash /work/db/migrate.sh "$@" 2>&1
}

q() { # q <dbname> <sql> -> single value
  local db="$1"; shift
  "$runtime" exec "$CONTAINER" psql "$DB_BASE/$db" -X -tAq -c "$1"
}

file_count=$(ls "$HERE"/migrations/*.sql | wc -l | tr -d ' ')

# ---------------------------------------------------------------------------
# A fresh database gets every migration, and a record of every migration
# ---------------------------------------------------------------------------
echo "--- fresh database"
fresh_db t1; load_db_dir
out=$(run_migrate t1) && rc=0 || rc=$?
is "$rc" "0" "the runner succeeds on an empty database"
is "$(q t1 'select count(*) from schema_migrations')" "$file_count" \
   "every migration file is recorded as applied"
is "$(q t1 "select count(*) from pg_tables where schemaname='public'")" "30" \
   "the 29 schema tables exist, plus the bookkeeping table itself"

# ---------------------------------------------------------------------------
# Running it again does nothing — the property the whole thing exists for
#
# The drafted CI workflow failed here: it re-applied 0001 to a database that
# already had those tables, and died on the first statement.
# ---------------------------------------------------------------------------
echo "--- run twice"
out=$(run_migrate t1) && rc=0 || rc=$?
is "$rc" "0" "a second run succeeds instead of failing on 'table already exists'"
is "$(q t1 'select count(*) from schema_migrations')" "$file_count" \
   "and it records nothing new"
if grep -qi 'nothing to do\|up to date' <<<"$out"; then
  ok "it says so out loud rather than printing a silent success"
else
  notok "a no-op run should say it did nothing (got: $(head -3 <<<"$out"))"
fi

# ---------------------------------------------------------------------------
# Only the new file is applied
# ---------------------------------------------------------------------------
echo "--- a new migration appears"
"$runtime" exec "$CONTAINER" bash -c \
  "printf 'create table later_on (id int primary key);\n' > /work/db/migrations/0015_later.sql"
out=$(run_migrate t1) && rc=0 || rc=$?
is "$rc" "0" "the runner succeeds"
is "$(q t1 'select count(*) from schema_migrations')" "$((file_count+1))" \
   "the new migration is recorded"
is "$(q t1 "select count(*) from pg_tables where schemaname='public' and tablename='later_on'")" "1" \
   "and it actually ran"

# ---------------------------------------------------------------------------
# An edited migration is refused
#
# 'Never edit 0001-0014' is written in three documents. A rule that is only
# written down is a rule that gets broken by someone who did not read them.
# ---------------------------------------------------------------------------
echo "--- an already-applied migration is edited"
"$runtime" exec "$CONTAINER" bash -c \
  "printf '\n-- an innocent-looking comment\n' >> /work/db/migrations/0001_tenancy.sql"
out=$(run_migrate t1) && rc=0 || rc=$?
is "$rc" "1" "the runner refuses to continue"
if grep -q '0001_tenancy.sql' <<<"$out"; then
  ok "and it names the file that changed"
else
  notok "the error must name the changed file (got: $(head -5 <<<"$out"))"
fi

# ---------------------------------------------------------------------------
# A migration that fails leaves NOTHING behind — not half a schema, and above
# all not a row claiming it succeeded
# ---------------------------------------------------------------------------
echo "--- a migration that fails partway"
fresh_db t2; load_db_dir
"$runtime" exec "$CONTAINER" bash -c \
  "printf 'create table half_a (id int primary key);\nselect 1/0;\n' > /work/db/migrations/0015_broken.sql"
out=$(run_migrate t2) && rc=0 || rc=$?
is "$rc" "1" "the runner fails loudly"
is "$(q t2 "select count(*) from schema_migrations where filename='0015_broken.sql'")" "0" \
   "the broken migration is NOT recorded as applied"
is "$(q t2 "select count(*) from pg_tables where schemaname='public' and tablename='half_a'")" "0" \
   "and the half of it that did work is rolled back"

# ---------------------------------------------------------------------------
# --baseline: the live database, migrated by hand, adopted without re-running
# ---------------------------------------------------------------------------
echo "--- baseline an already-migrated database"
fresh_db t3; load_db_dir
# Apply by hand exactly as the live database was, with no bookkeeping at all.
for f in "$HERE"/migrations/*.sql; do
  "$runtime" cp "$f" "$CONTAINER":/tmp/m.sql
  "$runtime" exec "$CONTAINER" psql "$DB_BASE/t3" -X -q -v ON_ERROR_STOP=1 -f /tmp/m.sql >/dev/null
done
out=$(run_migrate t3 --baseline) && rc=0 || rc=$?
is "$rc" "0" "baseline succeeds on a hand-migrated database"
is "$(q t3 'select count(*) from schema_migrations')" "$file_count" \
   "every existing migration is adopted as already-applied"
out=$(run_migrate t3) && rc=0 || rc=$?
is "$rc" "0" "and a normal run afterwards is a clean no-op"

# Baseline is a one-time act. Running it on a database the runner already
# manages would silently mark a genuinely pending migration as done.
echo "--- baseline is refused twice"
out=$(run_migrate t3 --baseline) && rc=0 || rc=$?
is "$rc" "1" "a second baseline is refused rather than quietly marking things done"
# Exit code alone is not enough here: with the guard removed, the second
# baseline still fails — on a duplicate primary key, by luck rather than by
# design. That is a crash, not a refusal, and it would stop being a crash the
# moment a new migration file is added. Checked this, and the exit code test
# did NOT go red when the guard was deleted, so it is checked by message.
if grep -q 'REFUSING TO BASELINE' <<<"$out"; then
  ok "refused deliberately by the guard, not by luck of a duplicate key"
else
  notok "the refusal must come from the guard (got: $(head -3 <<<"$out"))"
fi
is "$(q t3 'select count(*) from schema_migrations')" "$file_count" \
   "and the ledger is untouched by the refused attempt"

echo
echo "    $passed passed, $failed failed"
[[ $failed -eq 0 ]] || { echo "==> FAILED"; exit 1; }
echo "==> all green"
