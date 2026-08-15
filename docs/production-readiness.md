# Production readiness

An honest ledger of what would have to be true to run this as a business, and
where it actually stands. Written because "is it secure and does it scale" is
not a yes/no question, and a confident yes would be the least useful answer.

**Status date:** 2026-08-15 · **Verdict: not production-ready.**
**Hosting decided:** Supabase Pro (~$25/mo), region **Singapore**, photos on
**Cloudflare R2**. Reasoning and the ten-lens analysis: `docs/hosting-decision.md`. The data layer
is genuinely solid and measured. Nobody can log in, and
several controls exist as schema without the surrounding operations.

### Deployment status — verified 2026-08-15

**The schema IS deployed.** Supabase project `evknfbkcszjdasjjwstw` ("Papa
Vendors"), org `swagofthenerd-gif's Org`, AWS **ap-southeast-1 (Singapore)** —
the intended region. All 28 tables from migrations `0001`–`0014` are present.

Verified against the live database, and cross-checked against a clean container
built from the same migrations — both give identical numbers:

| Check | Live | Clean local | Verdict |
|---|---|---|---|
| public tables | 28 | 28 | match |
| RLS enabled | 24 | 24 | match |
| RLS forced | 23 | 23 | match |
| `sync_pii_violations()` | 0 rows | — | ✅ |
| `papa_app` bypasses RLS | false | — | ✅ |
| `papa_app` superuser | false | — | ✅ |
| rows in `orgs` / `users` / `assets` / `scan_events` | 0 / 0 / 0 / 0 | — | `fixtures.sql` was **not** applied ✅ |

**A correction to `docs/HANDOFF-hosting-setup.md`:** its step-2 verification
says to expect **23 tables with RLS on, 22 forced**, and to *stop* if the number
differs. Those figures are wrong — the migrations as they stand produce **24 and
23**, confirmed by building a clean database from them. The handoff's numbers
predate a later migration. Anyone following that document literally would halt
on a correct database. Fixed in the handoff.

**Photo storage is done too — verified 2026-08-15.** R2 bucket
`papa-vendor-photos`, location **Asia-Pacific (APAC)**, created 2026-08-14,
0 objects. Public Development URL is **off**, which is correct — photos must not
be world-readable. Account API token `papa-vendor-photos-rw` exists, scoped to
that one bucket, *Object Read & Write*, active.

So steps 1–3 of the hosting handoff are complete. Steps 4–6 are not.

**Still outstanding on hosting** (blocks the pilot, not the schema):

- **Plan is Free, not Pro.** The ledger's decision was Pro (~$25/mo) because the
  free tier pauses the project after inactivity, which looks to a user exactly
  like the app being broken. Not yet upgraded.
- **No GitHub secrets at all** — `gh secret list` returns empty. None of
  `SUPABASE_DB_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- **No `deploy.yml`,** and **the one drafted in the handoff would not work.**
  See below.
- **No photo pipeline** — a bucket and a key are not an upload path.
- **Photo retention: 24 months — DECIDED by the user 2026-08-15, NOT YET
  APPLIED.** Needs an R2 Object Lifecycle Rule on `papa-vendor-photos`:
  *delete objects 730 days after upload*, applied to the whole bucket. Blocked
  only on browser access; the decision itself is settled and should not be
  reopened. The bucket is still empty, so applying it now costs nothing and
  covers every photo ever taken. Every photo uploaded before the rule exists is
  kept forever by default, so this should land before the first upload, not
  before the pilot.

### ⚠ The drafted deploy workflow re-runs every migration and would fail

`docs/HANDOFF-hosting-setup.md` step 5 loops over `db/migrations/*.sql` on every
push to `main`. It hedges that the migrations "are not all idempotent". That is
too generous: **none of them are.** Across all 14 files there are **28 plain
`create table`** statements and **zero** `create table if not exists`. Verified
by grep, 2026-08-15.

Against the live database — which already has all 28 tables — that workflow
fails on the first statement of `0001`, and, having no `break`, goes on to fail
on all fourteen. The result is a permanently red pipeline that applies nothing.
Not destructive, but it does not do the job it exists for, and a red pipeline
that is *expected* to be red is how a genuinely broken deploy gets ignored.

**What is actually needed** before `0015` can ship: a record in the database of
which migration files have already been applied, and a runner that applies only
the ones missing. That is a small piece of design, not a copy-paste of the
snippet in the handoff. **Not yet built.**

---

## What "100,000 users" means here, and where it breaks

This is a B2B tool. 100k *users* is roughly **5,000–10,000 rental houses** —
each with a handful of staff. That is a different shape from 100k consumers,
and it matters because the plan's sync design was chosen for a much smaller
world.

`0005` says in a comment: *"Revisit if a customer's working set passes ~200MB
or org count exceeds ~50."* That threshold is now the stated target, so the
decision has been re-tested rather than defended.

### Measured, at 200 orgs / 400k assets / 283MB

| Path | Result | Note |
|---|---|---|
| Tag lookup (the scan hot path) | **0.08ms** | Index scan; this is the one that must never regress |
| "What is out right now" | **0.26ms** | |
| Caught-up poll | **0.09ms** | Was ~1.1ms; watermark short-circuit |
| First-sync page (2000 assets) | **68ms** | Was 97ms; static SQL + column projection. One-time per device |
| RLS predicate | Pushed into `Index Cond` | Sargable, not a post-filter — this is what makes org scoping free |
| RLS function calls | **90ms → 13ms** on a 200k-asset org | Policies wrapped as `(select current_org_id())` so they hoist into an InitPlan and evaluate once per query, not once per row (`0008`) |

**A correction worth recording:** I first measured a caught-up poll at 89ms and
diagnosed dynamic-SQL re-planning. That was wrong — the benchmark timed two
*nested* `pull_changes` calls. The real figure was already ~1ms. The wrong
number nearly justified a much larger rewrite.

### ⚠ The two costs this document originally missed entirely

Both are larger than the database bill, and neither appeared in the first
version of this ledger.

**SMS is the real budget crisis.** Twilio charges ~$0.47 per segment to
Pakistan. At 100 customers × 5 staff × 2 logins/month that is **~$473/month —
19× the entire infrastructure budget**, against a $25 database. The design
already contains the fix and it must be held to: **OTP at enrolment only**, then
a long-lived device session + per-user PIN, delivered by a local aggregator or
WhatsApp rather than Twilio. That converts a recurring per-login cost into a
one-time per-staff cost of roughly **$2 lifetime**.

**Photos are the only line that can ever hurt.** ~2GB per rental house per
month, accumulating forever while revenue per customer stays flat — the classic
runaway shape. **Use Cloudflare R2, not Supabase Storage**: R2 charges **$0
egress** vs $0.09/GB. A ~$9/month difference today; **~$8,000/month at 10,000
customers.** Also: decide a **24-month retention/downscale policy before Phase 1
ships** — unbounded retention is the real long-run risk.

### What has NOT been tested, and would break first

1. ~~**Concurrent write throughput.**~~ **Measured 2026-08-12** — see below.
   It does serialise within an org, the earlier reasoning about *why* was
   wrong, and the conclusion survives anyway.

   **`change_seq` is no longer a concern at all.** `nextval` is
   non-transactional and cacheable; aggregate write rate at 10,000 orgs is
   ~46/sec average and ~500/sec peak against a ~2,000/sec durable ceiling on
   ordinary hardware. Previously listed here as a risk; it is not one.
2. **`scan_events` growth.** Append-only and never pruned. At 10k orgs × 400
   scans/day that is ~1.5bn rows/year. It needs **monthly partitioning** before
   real volume, and partitioning after the fact is painful. **Not done — and
   it is not a mechanical change.** Partitioning forces the
   `(device_id, client_seq)` idempotency constraint to admit the partition key,
   which would let the same pair exist in two months and make a retry across a
   month boundary double-apply a `check_out`. It also breaks the primary key
   and both self-referencing FKs. Analysed in `docs/partitioning-decision.md`,
   which recommends a separate receipts table and **needs one decision before
   any migration is written**.
3. **Connection pooling.** Not configured. At thousands of devices this is the
   first thing to fall over, before any query does.
4. ~~**`rate_limits` growth.**~~ **Done 2026-08-12** (`0012`), along with
   expired `device_sessions`. The missing cron was the smaller half of the
   problem: **a cron that silently stops looks exactly like one that works**,
   and the first symptom would be a bill months later. So `run_maintenance()`
   is one entry point with per-task isolation, every run is recorded, and
   `maintenance_health` reports what is overdue — a task that has NEVER run
   reads as overdue rather than absent. Still needs a scheduler to call it.
5. **Photo storage.** No bucket, no lifecycle policy, no egress budget.

### Measured, concurrent writes within one org — 2026-08-12

Harness: `db/bench/concurrent-writes.sh`. Writers each flush batches of 25
scans through the real `submit_scan_batch`, as `papa_app`, with RLS on, against
20,000 assets per org. Durable settings (`fsync=on`, `synchronous_commit=on`).

Throughput, one org, as concurrency rises:

| Writers | SHARED (as shipped) | NOWM (watermark detached) |
|---|---|---|
| 1 | 1,150 scans/s | 1,654 scans/s |
| 4 | 1,933 scans/s | 5,204 scans/s |
| 8 | **1,736 scans/s** — plateaued, then declining | **5,631 scans/s** |

Latency at 8 writers: mean **89ms vs 23ms**, p95 **218ms vs 36ms**.

**It serialises, and the serialisation is attributed, not inferred.** `NOWM`
detaches only the `assets` watermark triggers and holds everything else fixed —
same policies, same projection trigger, same rows. It scales; the shipped
configuration flattens at ~1,900 scans/s from two writers onward. That gap is
`org_sync_watermark` and nothing else.

**The mechanism is not what this document previously claimed.** The earlier
entry reasoned that the lock is held for "sub-millisecond transaction
duration". It is not. `submit_scan_batch` applies an entire batch in ONE
transaction; the first scan's projection updates `assets`, which fires the
per-statement watermark upsert, which takes the org's watermark row lock — and
Postgres holds row locks until **COMMIT**. So the unit of serialisation within
an org is the **batch** (~10-90ms here), not the statement. Writers in one org
queue behind each other for whole batches.

**The conclusion survives the correction.** ~1,900 scans/s per org against a
real org's <5/sec is roughly 400× headroom, and the p95 of 218ms at eight
simultaneous scanners is invisible in a scan UI. Eight concurrent writers is
already well past what a Lahore rental house produces. **This is a documented
ceiling, not a wall, and it needs no work now.**

What would change that: raising `BATCH` (a 200-scan batch holds the lock ~8×
longer), or a single org running many devices — the successful-customer case,
the same shape that hid the RLS InitPlan cost until one org got large. If the
watermark ever does need fixing, note that a stale-HIGH watermark is harmless
(the device does a real query) while stale-LOW silently skips rows forever, so
any lock-free replacement must err upward.

**Caveat on the absolute numbers:** measured on a shared cloud container, not
production hardware. The *ratios* between configurations are the robust result;
treat the scans/s figures as an order of magnitude.

**Honest read:** the read path holds at 200 orgs and the shape extends to
thousands. The write path now has a measured per-org ceiling with ~400×
headroom over real demand. **Event-log growth is what is left** — `scan_events`
is unpartitioned and unpruned, and that is where 100k users actually breaks.

---

## Security

### Real, tested, enforced by the database

- **Multi-tenant isolation via RLS**, forced on every table, proven from inside
  the RPCs as a non-superuser. 288 SQL assertions, including explicit
  cross-org leak tests in both directions.
- **`papa_app` is `NOSUPERUSER NOBYPASSRLS` with no DELETE grant** — hard
  deletes are impossible for the application role, not merely discouraged.
- **`SECURITY INVOKER` everywhere except three places**, each argued in
  comments. DEFINER bypasses RLS, so every DEFINER function is a tenancy hole
  unless it re-checks by hand.
- **Append-only scan log and audit log**, enforced by trigger *and* by
  withholding the grant.
- **Audit is not optional** — `write_audit()` is the only door and takes the
  actor from the session, not an argument.
- **Rate limiting** on PIN attempts, the public tag resolver, and scan
  submission. The limiter table has no policy at all.
- **Opaque 128-bit tags** from a CSPRNG; the public resolver returns an
  identical shape for unknown, unbound and retired codes, so a fleet cannot be
  estimated from photographs.

### Designed but NOT BUILT — the gap that matters

| Gap | Consequence if shipped as-is | Effort |
|---|---|---|
| **No authentication at all** | Nobody can log in. There is no Supabase project. | Days |
| **No device DB encryption** (SQLCipher) | A stolen warehouse phone is the whole fleet, purchase prices, replacement values and the customer list, in plaintext | **Re-scoped 2026-08-12.** Not "days to add a flag" — **there is no device driver at all.** Capacitor is anticipated in comments and the Vite config but is not installed; the only `SqlDriver` is the node:sqlite one used by tests. The risk is ordering: whoever builds the Capacitor driver will get sync working first and come back for encryption, and SQLCipher **cannot open a plaintext database**, so retrofitting means an offline export/re-import on every installed phone — including the outbox, which exists nowhere else. `packages/core/src/db/device-key.ts` now makes the requirement a **type**: `openDeviceDatabase` will not accept a non-encrypted driver, and an empty key (which SQLCipher silently treats as *no encryption*) is refused. Encryption itself still has to be written. |
| ~~**CNIC/NTN still sync to scanners**~~ | **Corrected 2026-08-12 — this was never true.** There is no `customers` table and no `cnic`/`ntn` column in the schema; they arrive in phase 2, so nothing was leaking. The real exposure was that `pull_changes` uses `select *` for six of eight tables, so adding `customers` to `make_syncable()` — a one-line change that will look routine — would have shipped `cnic` to every warehouse phone. `0009` adds a registry of column names that may not exist on any syncable table, and the test fails the build if one ever does. Enforced structurally instead of documented. | ✅ |
| **No backups / PITR** | No project exists, so nothing is backed up | **Corrected: PITR on Supabase is $100/mo — 4× the infra budget, not "hours".** Pre-revenue substitute: Pro's 7-day daily backups + the append-only event log + a nightly cold export. Turn PITR on at first revenue. |
| ~~**No cold export of `scan_events`**~~ | **Done 2026-08-12** (`0010`). NDJSON export past a cursor, with a **settle lag** because `server_seq` is handed out before commit and transactions commit out of order — the same hazard that produced the row-skipping cursor bug in `0005`. The lag is a probability argument, so it is backed by a batch ledger and `export_gap_check()`, which proves completeness below the cursor rather than assuming it. Still needs the nightly job and a bucket to write to. | ✅ schema |
| **No secrets management** | No keys exist yet; needs doing before any do | Hours |
| ~~No CI~~ | **Done 2026-08-12.** Typecheck + 127 JS tests + the real Vite build + all migrations + 288 pgTAP assertions, on every push, against stock Postgres. | ✅ |
| **No error tracking / monitoring** | ~~A device with 400 queued writes for three days is invisible~~ — **`sync_health` done 2026-08-12** (`0011`): per-device freshness plus `raise_stale_device_alerts()`, idempotent so the channel does not become noise, and self-resolving when the phone returns. Built on **silence**, not `queued_writes` — an offline device cannot report its own queue depth, and the server only ever writes that column as zero. Sentry and app-level error tracking are still missing. |
| **No dependency scanning** | | Hours |
| **No penetration test** | | External |

### Two honest limits that cannot be engineered away

**Revocation is not instant.** Suspending a membership takes effect on the
server immediately — tested. A phone that is offline keeps working until it
next reaches the server, bounded by `device_sessions.expires_at`. The true
property is *"revoked within one connectivity window, hard-limited by session
expiry"*. Any claim of instant revocation for an offline-first app is false.

**An uninstall destroys unsent scans.** Outbox rows exist nowhere else. Nobody
— including the server — ever learns they existed. Mitigated by flushing on any
connectivity, a JSON-lines mirror against SQLite corruption, and an actionable
"this phone last synced 6h ago" alert with a name attached. Not solved.

---

## The shortest path to production

In order, because each depends on the last:

1. ~~**CI**~~ — ✅ done. Runs `db/run-tests.sh`, the same script used locally, so CI and local cannot drift.
2. **A Supabase project** — Singapore region, migrations applied from CI, secrets in place. **Plus the R2 bucket and photo pipeline before the pilot**, not after: re-keying stored photos later is painful.
3. **Auth**: phone OTP at enrolment, device session, per-user PIN gate. Wire
   `rate_limit_check` into the PIN path.
4. **Device encryption** (SQLCipher). ~~CNIC sync exclusion~~ — ✅ done as a
   structural guard (`0009`); the columns it protects do not exist yet, and now
   cannot be made syncable without failing the build.
5. **`scan_events` partitioning** before real volume — **blocked on one
   decision**, see `docs/partitioning-decision.md`. The cold NDJSON export is
   ✅ done (`0010`); it still needs a nightly job and a bucket to write to.
6. ~~**A concurrent-write load test**~~ — ✅ done 2026-08-12. Measured, attributed, and cleared with ~400× headroom. `db/bench/concurrent-writes.sh`.
7. **Monitoring**: ~~a `sync_health` view and an alert when a device goes
   quiet past 24h~~ — ✅ done (`0011`); it still needs a scheduler to call
   `raise_stale_device_alerts()` hourly, and a WhatsApp sender behind the
   alert's `channel`. Sentry is still missing.
8. Only then: the pilot warehouse.

---

## What I would tell a prospective customer today

The inventory model, the tenancy isolation and the offline sync are real,
measured and defended by 288 database assertions plus 127 application tests.
That is the hard, expensive part and it is done.

It is not deployed, nobody can log in, and a lost phone is currently an
unencrypted copy of a fleet. Those are days of work, not months — but they are
work that has not happened, and until it has, this runs a pilot at most.
