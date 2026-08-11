#!/usr/bin/env bash
#
# Applies every migration to a throwaway Postgres and runs the pgTAP suite.
#
# No Supabase account, no network, no shared dev database — a container, a
# schema, a verdict. The point is that the SQL in this repo is *verified*
# rather than merely written; an untested migration is a liability, and RLS
# bugs are silent by nature.
#
#   ./supabase/run-tests.sh          # run
#   KEEP=1 ./supabase/run-tests.sh   # leave the container up to poke at it
#
set -euo pipefail

CONTAINER=papa-pg-test
IMAGE=docker.io/library/postgres:16-bookworm
PORT=55433
DB=papa
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

runtime=$(command -v podman || command -v docker) || {
  echo "need podman or docker" >&2
  exit 1
}

cleanup() {
  if [[ "${KEEP:-}" != "1" ]]; then
    "$runtime" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  else
    echo "KEEP=1 — container '$CONTAINER' left running on port $PORT"
  fi
}
trap cleanup EXIT

"$runtime" rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "==> starting postgres"
"$runtime" run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=papa -e POSTGRES_DB="$DB" \
  -p "$PORT":5432 "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  "$runtime" exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
"$runtime" exec "$CONTAINER" pg_isready -U postgres -q || {
  echo "postgres did not become ready" >&2
  exit 1
}

echo "==> installing pgTAP"
# Cached in the image layer after the first run on a given machine; needs
# network only once.
"$runtime" exec "$CONTAINER" bash -lc \
  'apt-get update -qq && apt-get install -y -qq postgresql-16-pgtap' >/dev/null 2>&1
psql_() { "$runtime" exec -i "$CONTAINER" psql -U postgres -d "$DB" -X -q "$@"; }
psql_ -v ON_ERROR_STOP=1 -c 'create extension if not exists pgtap;'

echo "==> applying migrations"
for f in "$HERE"/migrations/*.sql; do
  echo "    $(basename "$f")"
  "$runtime" cp "$f" "$CONTAINER":/tmp/m.sql
  psql_ -v ON_ERROR_STOP=1 -f /tmp/m.sql >/dev/null
done

echo "==> running tests"
failed=0
for f in "$HERE"/tests/*.sql; do
  echo "--- $(basename "$f")"
  "$runtime" cp "$f" "$CONTAINER":/tmp/t.sql
  # Each test file is its own transaction ending in rollback, so the files are
  # order-independent and leave no residue.
  out=$(psql_ -f /tmp/t.sql 2>&1)

  # A failed assertion prints "not ok"; a broken *file* aborts the transaction
  # and prints ERROR without any "not ok" at all. Both must fail the run —
  # grepping only for "not ok" would report a completely broken suite as green.
  if grep -qE '^\s*not ok' <<<"$out" || grep -q 'ERROR:' <<<"$out"; then
    failed=1
    grep -E '^\s*not ok|ERROR:|^\s*#' <<<"$out" | head -40
  fi
  grep -cE '^\s*ok [0-9]+' <<<"$out" | xargs -I{} echo "    {} assertions passed"
done

if [[ $failed -ne 0 ]]; then
  echo "==> FAILED"
  exit 1
fi
echo "==> all green"
