# Production readiness

An honest ledger of what would have to be true to run this as a business, and
where it actually stands. Written because "is it secure and does it scale" is
not a yes/no question, and a confident yes would be the least useful answer.

**Status date:** 2026-09-13 (after W8) · **Verdict: not production-ready
— and the reason is now one thing, not many: the phone has no server
connection.** Migrations `0001`–`0026` are live on the Supabase project
and proven (1,173 pgTAP assertions on stock Postgres, tenancy re-proved on
every deploy); every desk feature in the dream plan's phases B–E is built
on the phone and tested against a simulated year. But the app has **no
auth client, no sync, and has never made an RPC call** — every write it
makes is an optimistic local row plus an outbox op *named after* a server
function that nothing has ever invoked. That is W9, "the pipe", and it is
the whole gap between a demo that runs a business on one phone and a
product. Full account: [2026-09-13 — the second year](#2026-09-13--the-second-year-w8-where-it-stands-and-the-pipe).
**Hosting decided:** Supabase Pro (~$25/mo), region **Singapore**, photos on
**Cloudflare R2**. Reasoning and the ten-lens analysis: `docs/hosting-decision.md`.

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
- ~~**No `deploy.yml`**~~ — **Done 2026-08-15.** `db/migrate.sh` plus
  `.github/workflows/deploy.yml`. See below.
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

**Built 2026-08-15** — `db/migrate.sh`, 20 assertions in `db/test-migrate.sh`,
run in CI on every push. The database keeps a `schema_migrations` ledger and
only pending files are applied.

Four decisions in it worth knowing:

- **The ledger table belongs to the runner, not to a migration.** As `0015` it
  would be applied last, on a database where the runner needs to read it first.
  It is also granted to nobody — `papa_app` cannot see it.
- **Each migration runs inside one transaction, together with the row recording
  it.** Nothing here forbids a transaction (no `CREATE INDEX CONCURRENTLY`,
  checked), so a failure rolls back completely. The alternative failure mode is
  the worst one available: a migration marked done that never ran, then skipped
  forever.
- **Checksums.** "Never edit 0001–0014" appears in three documents, which is
  the kind of rule someone breaks by fixing a typo. Editing an applied
  migration is invisible to the test suite — the tests build a fresh database
  from the files, so they pass either way while the live database diverges. The
  runner refuses to continue and names the file.
- **`--baseline`** adopts a hand-migrated database without re-running anything.
  Needed exactly once, for this database. Refused a second time, because on a
  managed database it would mark a real pending migration as done.

**The tests were verified to be capable of failing**, by deleting each guard in
turn: removing the checksum check turned 2 red, recording outside the
transaction turned 3 red. Removing the baseline guard turned **none** red — the
duplicate-key error happened to produce the same exit code, so that test was
passing by luck. It now asserts the refusal message, and goes red when the
guard is removed.

**Still to do:** the live database must be adopted once, by hand, before the
first deploy — `DB=<direct URI> ./db/migrate.sh --baseline`. Until then
`deploy.yml` reports "not configured" and stops rather than failing.

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
| ~~**No authentication at all**~~ **No auth CLIENT** | The server side shipped in 0016 (OTP-at-enrolment, hashed device sessions, PIN gate, revocation, device binding); the phone has no login screen, no session store and no token — nobody can log in **from the app**. | Days — W9 |
| **No sync, no RPC calls** (added 2026-09-13) | The phone never pulls and never pushes. `pull_changes` has never been called by the app; the outbox has never drained. Every feature runs on the local demo store. A lost phone is a lost business, not a lost device. | The largest open item — W9 |
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

In order, because each depends on the last (re-cut 2026-09-13):

1. ~~**CI**~~ — ✅ done. Runs `db/run-tests.sh`, the same script used locally, so CI and local cannot drift.
2. ~~**A Supabase project**~~ — ✅ done: project `evknfbkcszjdasjjwstw`, Singapore, `0001`–`0026` applied by `deploy.yml` on every merge, tenancy re-proved after each. R2 bucket exists; **the photo pipeline does not** (W9).
3. ◐ **Auth**: ~~server~~ ✅ (0016). **Client: W9** — login, device session, PIN gate on the phone; wire `rate_limit_check` into the PIN path.
3b. **The pipe (W9)**: the pull loop over `pull_changes` into the on-device mirror (the read models already read the mirror's shape — 0023/0026 projections were built for this), the outbox drain calling the RPCs every op is already named after, photo upload to R2, and an on-device schema migration story for phones that already hold data. Two year-findings ride with it: `sub_rent_intent` needs an RPC or must leave the chain; a sub-hire's cost needs an attach-to-job door.
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

*(Rewritten 2026-09-13.)* The inventory model, the tenancy isolation, the
money book, the promise calendar, the pricing pipeline and the partner
network are real on both sides, measured, and defended by 1,173 database
assertions, 808 application tests, 31 browser tests with a fake camera,
and a simulated year that a vendor could re-read as a story. That is the
hard, expensive part and it is done.

The phone does not talk to the server. Nobody can log in from it, nothing
it records leaves it, and a lost phone is an unencrypted copy of a fleet
*and* of every booking and rupee since the pilot began. That is weeks of
work, not months — the RPCs exist, the mirrors exist, the ops are already
shaped for them — but until it has happened, this runs a one-phone demo,
not a pilot.

---

## 2026-09-02 — four-lens review: what it found and what was fixed

Four independent review passes (security, data-correctness, code
cleanliness, product strategy) ran over the whole repo. Full record:
`docs/review-2026-09-02.md`. The five principles they produced:
`docs/principles.md`.

**Fixed the same day** (migration `0015_hardening.sql` + `packages/core` +
`apps/app`; every fix carries a test that fails without it):

- **Projection forgery closed.** `apply_scan_event` / `rebuild_asset_projection`
  were callable by any app user — state could change with no event row.
  Revoked; the scan pipeline is now SECURITY DEFINER with pinned search_path
  and row locks (also fixing the older-event-clobbers-newer race).
- **PIN hashes are no longer org-readable.** Column-level revoke plus a
  rate-limited `verify_pin()`. Attribution claims hold again.
- **Role gates are now database-enforced.** readonly/driver can no longer
  write around the RPCs; dispatch confirmation state cannot be forged by
  direct UPDATE.
- **The pull cursor can no longer permanently skip a row** committed out of
  sequence order (snapshot-xmin horizon + 3s settle lag, dblink-tested).
- **Unresolved-tag scans now project once the tag is bound**, and raise the
  `unresolved_tag` alert until then.
- **`jobs.contact` (a phone number) no longer syncs to devices**; the PII
  guard is pattern-based now and every pull block is an explicit projection
  (`select *` in pull paths fails the build).
- **All-assumed dispatches can no longer grade `strong`** just because an
  owner pressed the button.
- **Transient network failures can no longer park good scans**, and a poison
  op in a batch is isolated exactly (server-named seq or bisection) instead
  of parking an innocent one.
- Retired tags stop resolving locally; case manifests respect `removed_at`;
  check_out→check_in in one session both record; torch defaults on in low
  light; the status-bucket rule has one home.

Counts after: **270 application tests, 395 database assertions, all green**;
typecheck silent; real build passes.

**Known and deliberately open** (see the review doc for detail): device_id on
*direct* scan_events insert is not org-checked (submit_scan_batch is);
`has_more` can read true against the dispatches watermark; a long-open write
transaction stalls cursor advancement org-wide (bounded to re-delivery,
never loss); CI actions pinned to tags not SHAs.

**⚠ Deployment note:** the live Supabase database has `0001`–`0014` applied.
`0015_hardening.sql` closes real holes — deploy it before any real data
exists, and before anyone is given credentials.

## 2026-09-11 — thermal printing (0025 client wave)

**Bytes golden-tested, hardware unverified.** The parchi's ESC/POS stream
(`packages/core/src/escpos.ts`: init, alignment, bold, double-size title,
`GS ( k` QR model 2 / size 6 / EC M with correct `pL pH`, `GS V 66 0`
cut, 32-column word wrap, ASCII fold with LF kept for the QR payload) is
pinned byte-for-byte in `packages/core/test/escpos.test.mjs` against the
Epson reference. **No printer has fed paper.** The transport seam is
`apps/app/src/print/thermal.ts` (`ThermalPrinter { print(bytes) }`): the
Android build registers a **Bluetooth SPP** transport there — the
Capacitor wave, out of scope now — and until then the handover's
"Thermal print" door says *No printer connected* in the built bundle
(a `.bin` download in dev, for piping to `/dev/rfcomm0` from a laptop).
Open item before the pilot: feed one parchi through the pilot house's
printer and read its QR back with a phone (ASSUMPTION #thermal-58mm).

## 2026-09-13 — the second year (W8): where it stands, and the pipe

Waves 1–7 shipped as PRs #12–#20; migrations `0019`–`0026` are live on
the Supabase database. W8 re-lived the simulated year against all of it,
extended the stress suite over bookings, quoting and the network, and
re-cut the plan. This section is the honest ledger after that.

### Numbers (all green on `second-year`, 2026-09-13)

| Gate | Result |
|---|---|
| `npm run typecheck` | silent |
| `npm test` | **808** tests, 0 failures (three new stress files; the year test at 15 blocks) |
| `npm run build:app && npm run test:e2e` | built in 3.15s · **31** e2e tests, 0 failures (real Chromium, fake camera) |
| `db/run-tests.sh` | **1,173** pgTAP assertions across 28 files, `==> all green` |
| `db/test-migrate.sh` | `20 passed, 0 failed` |
| Year findings | 1 retired (`import-apply-welded`), 8 kept (all Phase B polish doors), 2 new (`sub-rent-intent-unreplayable`, `subhire-cost-unlinkable`) |

### The pipe — said plainly

**The phone has no server connection** (as of W8; see "The pipe (W9)" below, which closes this on this machine). Not "partial", not "stubbed":

- **No auth client.** 0016's OTP / device-session / PIN model exists in
  Postgres and is tested there. The app has no login screen, stores no
  session, sends no token. `current_user_id()` has never been set by a
  request from this app.
- **No sync.** `pull_changes` (0005/0006, hardened 0015, with the 0023 and
  0026 projections built specifically so the phone can mirror
  reservations and rate cards) has never been called by the app. The
  on-device mirror is filled by `seedDemo` and by the app's own
  optimistic writes, and by nothing else.
- **No RPC calls.** Every write — a scan batch, a booking, a confirm, a
  quote override, a sub-hire, a close — lands as a local row plus an
  outbox op whose `op` is the RPC's name and whose payload is the RPC's
  `p_*` arguments. The outbox has never drained. The dependency chains
  (create → confirm → extend; record → close) are correct in shape and
  untested against a server.
- **No photo upload.** Photos live in the never-evict local store; the R2
  bucket is empty.
- **No on-device schema migration.** `LOCAL_SCHEMA` is create-if-not-
  exists; a phone that already holds data and receives a new column has
  no path today.

What this means for the pilot: **one phone, one desk, no backup.** The
year test's every promise ("no scan is ever lost", "balances never
drift") is a promise about that one phone's SQLite. The "Backed up ✓"
chip the dream plan wants cannot be shown honestly.

### The gap table after W8

| Gap | Where it stands | Owner / wave |
|---|---|---|
| Login, device session, PIN on the phone | Server done (0016); client absent | **W9** |
| Pull sync into the mirror | Server done (0005–0015, 0023, 0026); client absent | **W9** |
| Outbox drain → RPC calls | Ops shaped and chained; never sent | **W9** |
| Photo upload to R2 | Bucket exists; no path | **W9** |
| On-device schema migration | None | **W9** |
| `sub_rent_intent` has no RPC | The extension chained behind it would fail on replay (year finding) | **W9** |
| Sub-hire cost attach-to-job | Link made only at record time (year finding) | **W9** (one door) |
| SQLCipher | Type-enforced seam, no driver | W9/W10 — must land before the first real phone holds data |
| Thermal printer transport | Bytes golden; Bluetooth SPP is the Capacitor wave; no paper fed | W10 + a human gate |
| Deposit / reversal / write-off / blacklist / waiver doors | Schema and projections exist; no phone doors | B-polish week after W9 |
| Month picker, lifetime value, earners leaderboard | Reads exist (`moneyStrip(nowMs)`, entries), no screens | B-polish |
| Motion, WIG audit, dark theme pass | Not started | **W10** |
| Scheduler for `run_maintenance()` / `raise_stale_device_alerts()` | Functions exist, nothing calls them | Ops, before pilot |
| `scan_events` partitioning | Decision still open (`partitioning-decision.md`) | Before real volume |
| PITR / nightly cold export job | Export function exists (0010); no job, no bucket | At first revenue |
| Sentry / app-level error tracking | None | Before pilot |

### The human gates (unchanged, still open)

Three things no review can answer and the owner can, one afternoon each:
**the 30-minute scan test on a cheap Android** (decode-to-feedback under
100ms; the thermal budget), **one rack of printed labels** (the
tag-survival clock starts the day they go on), and **the vendor
afternoon** (`docs/assumptions.md` now opens with the ten questions in
order). A fourth, small: **feed one parchi through the pilot house's
receipt printer** and read its QR back with a phone.

### What W8 changed in the code

Deliberately little. `applyImport` moved from `store.ts` to
`read-model.ts` (so the year test runs the real routine; a latent
duplicate-id rollback on a second import of the same file was fixed on
the way), and three stress files were added. Everything else W8 did is
tests and documents — the point of the wave was to look, not to build.

<!-- ===================== The pipe (W9) — appended as one section; keep delimited ===================== -->

## The pipe (W9) — the phone and the server have met

**Built and proven on this machine** (`npm run test:pipe`: a real
`postgrest/postgrest:v12.2.3` in front of a real `postgres:16`, migrated by
`db/migrate.sh`, driven by a phone-side SQLite in Node). This changes three
rows of the "Designed but NOT BUILT" table above and adds nothing to the
security column that was not already there:

| Gap (from the table above) | Now |
|---|---|
| **No authentication at all** | The phone enrols (`complete_enrolment`), carries the session in `x-papa-session`, switches users by PIN (`switch_session_user`), signs out (`sign_out_device`). The PIN gate covers an enrolled phone on open. Still hosting-specific: the SMS transport that calls `request_otp` as `papa_auth` — documented as a seam, not built. Still the device-driver wave: SQLCipher at rest; the browser build keeps the token in memory and says so. |
| No sync at all (implicit above) | `SyncLoop`: pull → apply → flush, kicked by `online`, foreground, a 30s poll and every write; scans idempotent per `(device, client_seq)` as before; **every non-scan op exactly-once through `replay_op` (0027)** with the server's minted ids mapped back onto the phone's rows. Principle 3's test passes against the real server: the network dies after the server commits, nothing is lost, the retry is acked as duplicates, the row count is exact. |
| No device migration path (schema.ts's standing caveat) | `migrateLocal`: a versioned ladder from the pre-0018 shape to today, welded to `LOCAL_SCHEMA` by a test; an interrupted step finishes on the next open. |

**Honest limits, stated:**

- The proof runs in Node against containers. No phone has run the live
  mode over a real network; the Android build (Capacitor driver, SQLCipher)
  is still the wave that makes the token survive a reboot.
- `replay_op` makes non-scan ops exactly-once **per device**; a booking
  placed on two phones is two bookings by design, and the second confirm
  parks with the server's message (scenario 5).
- Ops that never existed cannot cross: the money book, expenses, the
  walk-in job and job close on the phone still enqueue nothing (they were
  local-only before this wave and remain so). The dispatcher is generic —
  they cross the day their write sides enqueue a `p_*` payload.
- The upload seam has a URL provider and a test, but no host: photos and
  voice notes still do not leave the phone until R2 (or equivalent) is
  wired behind `Uploader`.

Details: `docs/the-pipe.md`. Contract: `docs/hosting-decision.md`, "The
PostgREST contract".

<!-- ===================== end: The pipe (W9) ===================== -->
