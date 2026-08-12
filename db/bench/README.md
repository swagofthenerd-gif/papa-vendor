# db/bench

Benchmarks that answer a specific question. Not a performance dashboard.

```bash
./db/bench/concurrent-writes.sh                      # defaults: 4 writers
WRITERS=8 BATCH=25 BATCHES=10 ./db/bench/concurrent-writes.sh
```

Needs a Postgres with the migrations applied. Point it at one with `PGHOST`,
`PGPORT`, `PGUSER`, `PGDATABASE` (defaults match `run-tests.sh`: `127.0.0.1:55433`).

**Not run in CI, deliberately.** Timing assertions on a shared runner are
flaky, and a flaky check is one people learn to ignore. The benchmark is run by
hand when the question comes up, and its findings are written down in
`docs/production-readiness.md` — where the numbers are reviewed rather than
merely green.

## concurrent-writes.sh

Answers: **does the write path serialise within an org, and if so, on what?**

Three configurations, identical work in each:

| Config | Setup | Purpose |
|---|---|---|
| `SHARED` | all writers in one org | the case a real warehouse produces |
| `SPLIT` | writers spread across two orgs | contention halved, not removed |
| `NOWM` | one org, `assets` watermark triggers detached | the control |

`SHARED` vs `NOWM` is the one that proves anything. It changes exactly one
mechanism and holds everything else — same RLS policies, same projection
trigger, same indexes, same rows — fixed. `SPLIT` is a secondary check that the
effect tracks org boundaries rather than something incidental.

Three properties of the harness are load-bearing, and each was a way to get a
wrong answer:

- **It runs as `papa_app` with RLS on.** Measuring the write path with tenancy
  disabled measures a system we do not ship.
- **`bench_submit` is `SECURITY INVOKER`.** A DEFINER wrapper runs as the
  superuser owner and bypasses RLS, quietly removing the policies from the
  measured path.
- **Each writer gets a disjoint asset range.** Two techs contending on the same
  asset row is a different phenomenon from two techs contending on the org's
  watermark row; mixed together, the result is unattributable.

Timing comes from `psql`'s `\timing`, so it includes commit — which is where
the contended lock is actually released. Measuring from inside the function
would miss the wait it is trying to detect.
