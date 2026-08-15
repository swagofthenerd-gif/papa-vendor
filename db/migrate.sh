#!/usr/bin/env bash
#
# Applies the migrations a database has not had yet, and nothing else.
#
#   DB=postgresql://... ./db/migrate.sh
#   DB=postgresql://... ./db/migrate.sh --baseline
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
#
# The obvious deploy script is `for f in migrations/*.sql; do psql -f "$f"; done`
# and it was in the hosting handoff. It cannot work. Not one of these
# migrations is re-runnable: 28 plain `create table`, zero `if not exists`. On
# a database that has already been migrated it dies on the first statement of
# 0001, and a CI job that is red every single time is a job nobody reads on the
# day it goes red for a real reason.
#
# So the database has to remember what it has already been given.
#
# ---------------------------------------------------------------------------
# WHY THE BOOKKEEPING TABLE IS NOT A MIGRATION
#
# It would have to be migration 0015, applied last — but the runner needs to
# read it first, on a database where it does not exist yet. Making it the
# runner's own table dissolves the ordering problem, and it is honest about
# what it is: deployment bookkeeping, not part of the rental-house schema.
#
# It is deliberately granted to nobody. `papa_app` cannot read it, write it, or
# learn from it. Nothing in the application should ever know this table exists.
#
# ---------------------------------------------------------------------------
# WHY CHECKSUMS
#
# "Never edit 0001-0014" is written in three documents, which is exactly the
# kind of rule that survives until someone who has not read them fixes a typo.
# Editing an applied migration is silent by construction: the file and the
# database disagree, every test still passes because the tests build from the
# file, and the live database quietly diverges from the thing everyone reviews.
#
# So the checksum of every applied file is recorded, and a change to one stops
# the run. It cannot be nagged past.
#
# ---------------------------------------------------------------------------
# WHY EACH MIGRATION IS ONE TRANSACTION
#
# A migration that fails halfway leaves a database that is neither the old
# shape nor the new one, and no test anywhere covers that shape. Postgres can
# roll back DDL, and none of these migrations contain anything that forbids a
# transaction (no CREATE INDEX CONCURRENTLY, no VACUUM) — checked. The record
# of the migration is written inside the SAME transaction as the migration
# itself, so "applied" and "recorded as applied" cannot come apart. If they
# could, the failure mode is the worst one available: a migration marked done
# that never ran, skipped silently for ever after.
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS="$HERE/migrations"

baseline=0
for arg in "$@"; do
  case "$arg" in
    --baseline) baseline=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

: "${DB:?set DB to the database connection URI (the direct one, port 5432 — the pooler cannot create roles or extensions)}"

psql_() { psql "$DB" -X -q -v ON_ERROR_STOP=1 "$@"; }
value()  { psql "$DB" -X -tAq -v ON_ERROR_STOP=1 -c "$1"; }

# ---------------------------------------------------------------------------
# The ledger
# ---------------------------------------------------------------------------
psql_ -c "
  create table if not exists schema_migrations (
    filename   text        primary key,
    checksum   text        not null,
    applied_at timestamptz not null default now()
  );
  comment on table schema_migrations is
    'Deployment bookkeeping: which migration files this database has been given. Not application data; granted to nobody.';
" >/dev/null

shopt -s nullglob
files=("$MIGRATIONS"/*.sql)
shopt -u nullglob
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no migrations found in $MIGRATIONS" >&2
  exit 1
fi

sum_of() { sha256sum "$1" | cut -d' ' -f1; }

# ---------------------------------------------------------------------------
# Has anything already applied been edited since?
#
# Checked for EVERY file before ANY file is applied. Finding out halfway
# through would mean stopping with the database in a state nobody chose.
# ---------------------------------------------------------------------------
changed=()
pending=()
for f in "${files[@]}"; do
  name=$(basename "$f")
  recorded=$(value "select checksum from schema_migrations where filename = '$name'")
  if [[ -z "$recorded" ]]; then
    pending+=("$f")
  elif [[ "$recorded" != "$(sum_of "$f")" ]]; then
    changed+=("$name")
  fi
done

if [[ ${#changed[@]} -gt 0 ]]; then
  {
    echo "REFUSING TO RUN — these migrations were edited after being applied:"
    printf '  %s\n' "${changed[@]}"
    echo
    echo "The database was built from a different version of these files than the"
    echo "one in the repository, and no test can see the difference: the tests"
    echo "build a fresh database from the files, so they pass either way."
    echo
    echo "Do not edit an applied migration. Add a new one that makes the change."
  } >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Adopting a database that was migrated by hand
#
# One-time, and refused a second time. Running it again on a managed database
# would mark a genuinely pending migration as done and skip it for ever — a
# missing table with no error anywhere.
# ---------------------------------------------------------------------------
if [[ $baseline -eq 1 ]]; then
  already=$(value "select count(*) from schema_migrations")
  if [[ "$already" != "0" ]]; then
    {
      echo "REFUSING TO BASELINE — this database is already managed ($already migrations recorded)."
      echo
      echo "Baseline adopts files as already-applied WITHOUT running them. On a"
      echo "managed database that would silently skip a real pending migration."
      echo "If you want to apply what is pending, run without --baseline."
    } >&2
    exit 1
  fi
  echo "==> baselining: adopting ${#files[@]} migrations as already applied, running none"
  for f in "${files[@]}"; do
    name=$(basename "$f")
    echo "    adopt $name"
    psql_ -c "insert into schema_migrations (filename, checksum) values ('$name', '$(sum_of "$f")')" >/dev/null
  done
  echo "==> baselined. Run without --baseline to apply anything new."
  exit 0
fi

if [[ ${#pending[@]} -eq 0 ]]; then
  echo "==> nothing to do — all ${#files[@]} migrations already applied"
  exit 0
fi

echo "==> ${#pending[@]} migration(s) to apply"
for f in "${pending[@]}"; do
  name=$(basename "$f")
  echo "    applying $name"
  # The migration and the record of it, in one transaction. Either both happen
  # or neither does.
  if ! {
    cat "$f"
    printf "\ninsert into schema_migrations (filename, checksum) values ('%s', '%s');\n" \
      "$name" "$(sum_of "$f")"
  } | psql "$DB" -X -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null; then
    {
      echo
      echo "FAILED applying $name — rolled back."
      echo
      echo "The database is exactly as it was before this migration started, and"
      echo "$name is NOT recorded as applied, so fixing it and running again is"
      echo "safe. Migrations before this one in the same run are already applied"
      echo "and recorded; they will not be re-run."
    } >&2
    exit 1
  fi
done
echo "==> applied ${#pending[@]} migration(s)"
