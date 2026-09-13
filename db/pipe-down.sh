#!/usr/bin/env bash
# Take the local pipe down (see pipe-up.sh).
set -euo pipefail
NET="${PAPA_PIPE_NET:-papa-pipe-net}"
PG="${PAPA_PIPE_PG:-papa-pipe-pg}"
REST="${PAPA_PIPE_REST:-papa-pipe-rest}"
runtime=$(command -v podman || command -v docker) || exit 0
"$runtime" rm -f "$REST" "$PG" >/dev/null 2>&1 || true
"$runtime" network rm "$NET" >/dev/null 2>&1 || true
echo "==> the pipe is down"
