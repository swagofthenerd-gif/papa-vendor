#!/usr/bin/env bash
#
# npm run test:pipe — bring the pipe up, run the ten scenarios against it,
# take it down, and say which of the three failed.
#
#   KEEP=1 npm run test:pipe   # leave the containers up afterwards
#
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

"$HERE/pipe-up.sh" || { echo "==> pipe-up failed" >&2; "$HERE/pipe-down.sh"; exit 1; }

export PAPA_PIPE_URL="${PAPA_PIPE_URL:-http://127.0.0.1:${PAPA_PIPE_REST_PORT:-3050}}"
export PAPA_PIPE_PG="${PAPA_PIPE_PG:-papa-pipe-pg}"
(cd "$ROOT" && node --test "apps/app/test/pipe/*.pipe.mjs")
rc=$?

if [[ "${KEEP:-}" == "1" ]]; then
  echo "KEEP=1 — the pipe is left up at $PAPA_PIPE_URL"
else
  "$HERE/pipe-down.sh"
fi
exit $rc
