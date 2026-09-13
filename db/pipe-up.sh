#!/usr/bin/env bash
#
# The pipe, locally (W9): a real Postgres and a real PostgREST in containers,
# migrated with the SAME runner that deploys (db/migrate.sh), seeded with one
# rental house (db/pipe-fixtures.sql), and configured the way the phone
# expects — the PostgREST contract, written down in docs/hosting-decision.md:
#
#   db-anon-role   = papa_app                  every request is papa_app
#   db-pre-request = public.auth_pre_request   x-papa-session → papa.* (0016)
#   no JWT secret                              identity is the session header
#   db-schemas     = public                    the RPCs, nothing else
#
#   ./db/pipe-up.sh            # bring it up; prints the URL
#   ./db/pipe-down.sh          # take it down
#   npm run test:pipe          # up → the six scenarios → down
#
# podman or docker; a user-defined network so PostgREST reaches Postgres by
# name in both. Ports and names are overridable so a second checkout can run
# its own beside this one.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NET="${PAPA_PIPE_NET:-papa-pipe-net}"
PG="${PAPA_PIPE_PG:-papa-pipe-pg}"
REST="${PAPA_PIPE_REST:-papa-pipe-rest}"
PG_PORT="${PAPA_PIPE_PG_PORT:-55450}"
REST_PORT="${PAPA_PIPE_REST_PORT:-3050}"
PG_IMAGE=docker.io/library/postgres:16-bookworm
REST_IMAGE="${PAPA_PIPE_REST_IMAGE:-docker.io/postgrest/postgrest:v12.2.3}"
DB=papa

runtime=$(command -v podman || command -v docker) || {
  echo "need podman or docker" >&2
  exit 1
}

"$runtime" rm -f "$REST" "$PG" >/dev/null 2>&1 || true
"$runtime" network inspect "$NET" >/dev/null 2>&1 || "$runtime" network create "$NET" >/dev/null

echo "==> starting postgres ($PG on :$PG_PORT)"
"$runtime" run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=papa -e POSTGRES_DB="$DB" \
  -p "$PG_PORT":5432 "$PG_IMAGE" >/dev/null

for _ in $(seq 1 60); do
  "$runtime" exec "$PG" pg_isready -U postgres -q 2>/dev/null && break
  sleep 1
done
"$runtime" exec "$PG" pg_isready -U postgres -q || {
  echo "postgres did not become ready" >&2
  exit 1
}
# pg_isready answers before the init script's restart finishes; one more
# real query proves the server that answers is the one that stays.
for _ in $(seq 1 30); do
  "$runtime" exec "$PG" psql -U postgres -d "$DB" -X -q -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done

echo "==> migrating with db/migrate.sh (inside the container, as the deploy does)"
"$runtime" exec "$PG" rm -rf /work >/dev/null 2>&1 || true
"$runtime" exec "$PG" mkdir -p /work >/dev/null
"$runtime" cp "$HERE" "$PG":/work/db
"$runtime" exec -e "DB=postgresql://postgres:papa@localhost:5432/$DB" "$PG" \
  bash /work/db/migrate.sh

echo "==> seeding the house"
"$runtime" exec "$PG" psql -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1 -f /work/db/pipe-fixtures.sql >/dev/null

echo "==> starting postgrest ($REST on :$REST_PORT)"
"$runtime" run -d --name "$REST" --network "$NET" \
  -e PGRST_DB_URI="postgres://papa_authenticator:papa@$PG:5432/$DB" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=papa_app \
  -e PGRST_DB_PRE_REQUEST=public.auth_pre_request \
  -e PGRST_SERVER_PORT=3000 \
  -e PGRST_LOG_LEVEL=info \
  -p "$REST_PORT":3000 "$REST_IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$REST_PORT/" >/dev/null 2>&1; then
    echo "==> the pipe is up: http://127.0.0.1:$REST_PORT  (postgres on :$PG_PORT)"
    exit 0
  fi
  sleep 1
done
echo "postgrest did not become ready:" >&2
"$runtime" logs "$REST" 2>&1 | tail -20 >&2
exit 1
