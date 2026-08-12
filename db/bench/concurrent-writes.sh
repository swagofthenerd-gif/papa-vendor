#!/usr/bin/env bash
#
# Concurrent write throughput — the last unmeasured path.
#
# docs/production-readiness.md lists this as the one genuine unknown: everything
# measured so far is the READ path. The suspicion it tests is specific.
#
#   submit_scan_batch applies a whole outbox batch in ONE transaction. Every
#   scan event fires a per-row projection trigger that UPDATEs assets, which
#   fires the per-statement watermark trigger, which upserts ONE row in
#   org_sync_watermark keyed by org. Postgres holds that row lock until COMMIT.
#
# So the unit of serialisation within an org is plausibly the BATCH, not the
# statement. That distinction is the whole question: the ledger's optimistic
# reading assumed sub-millisecond statement duration, which would make this a
# non-issue. If it is really batch duration, two techs scanning the same
# warehouse serialise against each other.
#
# The experiment isolates it by running identical work two ways:
#
#   SHARED  — all writers in one org      (contends on one watermark row)
#   SPLIT   — writers spread across orgs  (same work, no shared row)
#
# Same rows written, same triggers fired, same indexes used. The only variable
# is whether the watermark row is shared. The GAP is the contention.
#
#   ./db/bench/concurrent-writes.sh              # defaults
#   WRITERS=8 BATCH=50 BATCHES=20 ./db/bench/concurrent-writes.sh
#
set -euo pipefail

WRITERS=${WRITERS:-4}     # concurrent devices
BATCH=${BATCH:-25}        # scans per outbox flush
BATCHES=${BATCHES:-20}    # flushes per device

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-55433}
PGUSER=${PGUSER:-postgres}
PGDATABASE=${PGDATABASE:-papa}
export PGHOST PGPORT PGUSER PGDATABASE

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

ORG1=11111111-1111-7111-8111-111111111111
ORG2=22222222-2222-7222-8222-222222222222
JOB1=30000000-0000-7000-8000-000000000001
JOB2=30000000-0000-7000-8000-000000000002

# ---------------------------------------------------------------------------
# One writer: its own connection, its own transaction per batch.
#
# \timing is measured by psql around the whole statement, so it INCLUDES commit
# — which is exactly where the contended lock is released, and therefore where
# a queued writer's wait actually ends. Timing from inside the function would
# miss it.
# ---------------------------------------------------------------------------
writer() {
  local w=$1 org=$2 org_n=$3 job=$4 user_n=$5 out=$6
  {
    echo "set role papa_app;"
    echo "set papa.org_id  = '$org';"
    echo "set papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-$(printf '%012d' "$user_n")';"
    echo "\\timing on"
    for ((b = 0; b < BATCHES; b++)); do
      echo "select bench_submit($w, $b, $BATCH, $org_n, '$job');"
    done
  } | psql -X -q -v ON_ERROR_STOP=1 2>&1 | grep -oP '^Time: \K[0-9.]+' > "$out"
}

# ---------------------------------------------------------------------------
# Reset between configurations. Both runs must start from the same state, or
# the second inherits the first's dead tuples and bloat and looks slower for a
# reason that has nothing to do with locking.
# ---------------------------------------------------------------------------
reset_state() {
  psql -X -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
set role postgres;
alter table scan_events disable row level security;
alter table assets      disable row level security;
alter table devices     disable row level security;
alter table alerts      disable row level security;
-- scan_events is append-only, enforced by trigger as well as by withholding
-- the grant — the delete below is refused even as superuser without this.
-- Worth stating plainly: needing an explicit override to reset a BENCHMARK is
-- the guard working exactly as intended.
alter table scan_events disable trigger scan_events_no_delete;
delete from alerts;
delete from scan_events;
delete from devices;
alter table scan_events enable trigger scan_events_no_delete;
update assets set presence = 'here', current_job_id = null,
                  last_applied_at = null, last_applied_seq = null;
alter table scan_events enable row level security;
alter table assets      enable row level security;
alter table devices     enable row level security;
alter table alerts      enable row level security;
vacuum (analyze) assets, scan_events, org_sync_watermark;
SQL
}

# ---------------------------------------------------------------------------
# NOWM detaches ONLY the assets watermark triggers, leaving every other part of
# the path in place. This is the control that turns a correlation into an
# attribution: SHARED vs SPLIT shows *a* difference between configurations,
# but SHARED vs NOWM changes exactly one mechanism and holds the rest fixed.
# ---------------------------------------------------------------------------
detach_watermark() {
  psql -X -q -v ON_ERROR_STOP=1 -c \
    "set role postgres;
     drop trigger if exists assets_watermark_ins on assets;
     drop trigger if exists assets_watermark_upd on assets;" >/dev/null
}

attach_watermark() {
  psql -X -q -v ON_ERROR_STOP=1 -c \
    "set role postgres; select attach_watermark_trigger('assets');" >/dev/null
}

run_config() {
  local label=$1 mode=$2
  reset_state

  local start end pids=()
  start=$(date +%s.%N)
  for ((w = 1; w <= WRITERS; w++)); do
    if [[ $mode == shared ]]; then
      writer "$w" "$ORG1" 1 "$JOB1" "$w" "$OUT/$label-$w.txt" &
    else
      # Alternate orgs. Odd writers to org 1, even to org 2.
      if ((w % 2 == 1)); then
        writer "$w" "$ORG1" 1 "$JOB1" "$w" "$OUT/$label-$w.txt" &
      else
        writer "$w" "$ORG2" 2 "$JOB2" "$w" "$OUT/$label-$w.txt" &
      fi
    fi
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  end=$(date +%s.%N)

  cat "$OUT/$label"-*.txt > "$OUT/$label-all.txt"

  local total_scans
  total_scans=$((WRITERS * BATCHES * BATCH))

  # Sorted by `sort -n` rather than in awk: mawk (the default awk on Debian and
  # on GitHub's runners) has no asort, and a benchmark that only runs on gawk
  # is a benchmark that silently stops running.
  sort -n "$OUT/$label-all.txt" | awk -v label="$label" \
      -v wall="$(echo "$end - $start" | bc)" -v scans="$total_scans" '
    { t[NR] = $1; sum += $1 }
    END {
      n = NR
      if (n == 0) { printf "%-8s NO SAMPLES\n", label; exit 1 }
      i50 = int(n * 0.50); if (i50 < 1) i50 = 1
      i95 = int(n * 0.95); if (i95 < 1) i95 = 1
      printf "%-8s batches=%-4d mean=%7.1fms  p50=%7.1fms  p95=%7.1fms  max=%8.1fms  wall=%6.2fs  %7.0f scans/s\n",
             label, n, sum / n, t[i50], t[i95], t[n], wall, scans / wall
    }'
}

echo "==> seeding"
psql -X -q -v ON_ERROR_STOP=1 -f "$HERE/seed.sql"    >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -f "$HERE/bench-fn.sql" >/dev/null

echo "==> ${WRITERS} writers x ${BATCHES} batches x ${BATCH} scans = $((WRITERS * BATCHES * BATCH)) scans per config"
echo
run_config SHARED shared
run_config SPLIT  split

detach_watermark
run_config NOWM shared
attach_watermark

echo
echo "SHARED = all writers in one org        (one contended watermark row)"
echo "SPLIT  = writers spread across orgs    (contention halved, not removed)"
echo "NOWM   = one org, watermark detached   (the control)"
echo
echo "SHARED vs NOWM is the attribution: identical work in the same org, with"
echo "the watermark trigger as the only variable. Read the throughput column —"
echo "if SHARED plateaus as writers double while NOWM keeps climbing, the write"
echo "path is serialising on that one row."
