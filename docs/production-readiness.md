# Production readiness

An honest ledger of what would have to be true to run this as a business, and
where it actually stands. Written because "is it secure and does it scale" is
not a yes/no question, and a confident yes would be the least useful answer.

**Status date:** 2026-08-12 · **Verdict: not production-ready.**
**Hosting decided:** Supabase Pro (~$25/mo), region **Singapore**, photos on
**Cloudflare R2**. Reasoning and the ten-lens analysis: `docs/hosting-decision.md`. The data layer
is genuinely solid and measured. Nothing is deployed, nobody can log in, and
several controls exist as schema without the surrounding operations.

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

1. **Concurrent write throughput.** Everything above is read-path. The
   per-statement watermark upsert serialises writes *within an org*, so two
   techs scanning fast in one warehouse is the case to measure. **Still
   untested — but downgraded.** The lock is held for sub-millisecond
   transaction duration, giving thousands/sec per org in theory against a real
   org's <5/sec. Worth measuring; unlikely to be the wall.

   **`change_seq` is no longer a concern at all.** `nextval` is
   non-transactional and cacheable; aggregate write rate at 10,000 orgs is
   ~46/sec average and ~500/sec peak against a ~2,000/sec durable ceiling on
   ordinary hardware. Previously listed here as a risk; it is not one.
2. **`scan_events` growth.** Append-only and never pruned. At 10k orgs × 400
   scans/day that is ~1.5bn rows/year. It needs **monthly partitioning** before
   real volume, and partitioning after the fact is painful. **Not done.**
3. **Connection pooling.** Not configured. At thousands of devices this is the
   first thing to fall over, before any query does.
4. **`rate_limits` growth.** `prune_rate_limits()` exists; nothing calls it.
   Needs a cron.
5. **Photo storage.** No bucket, no lifecycle policy, no egress budget.

**Honest read:** the read path holds at 200 orgs and the shape extends to
thousands. The write path and the event-log growth are where 100k users breaks,
and both are addressable — but they are unmeasured today, so treating the
system as proven at that scale would be false.

---

## Security

### Real, tested, enforced by the database

- **Multi-tenant isolation via RLS**, forced on every table, proven from inside
  the RPCs as a non-superuser. 241 SQL assertions, including explicit
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
| **No device DB encryption** (SQLCipher) | A stolen warehouse phone is the whole fleet, purchase prices, replacement values and the customer list, in plaintext | Days |
| **CNIC/NTN still sync to scanners** | PII on a warehouse phone under Pakistan's PECA regime. Column-level exclusion is specified, not implemented | Hours |
| **No backups / PITR** | No project exists, so nothing is backed up | **Corrected: PITR on Supabase is $100/mo — 4× the infra budget, not "hours".** Pre-revenue substitute: Pro's 7-day daily backups + the append-only event log + a nightly cold export. Turn PITR on at first revenue. |
| **No cold export of `scan_events`** | The one table that cannot be reconstructed has no independent copy | Hours |
| **No secrets management** | No keys exist yet; needs doing before any do | Hours |
| ~~No CI~~ | **Done 2026-08-12.** Typecheck + 120 JS tests + the real Vite build + all migrations + 241 pgTAP assertions, on every push, against stock Postgres. | ✅ |
| **No error tracking / monitoring** | A device with 400 queued writes for three days is invisible | Days |
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
4. **Device encryption + CNIC sync exclusion.** Both are small; both are
   breaches if skipped.
5. **`scan_events` partitioning** before real volume, plus the cold NDJSON
   export.
6. **A concurrent-write load test** — the genuine unknown.
7. **Monitoring**: Sentry, a `sync_health` view, and an alert when a device's
   queue ages past 24h.
8. Only then: the pilot warehouse.

---

## What I would tell a prospective customer today

The inventory model, the tenancy isolation and the offline sync are real,
measured and defended by 241 database assertions plus 120 application tests.
That is the hard, expensive part and it is done.

It is not deployed, nobody can log in, and a lost phone is currently an
unencrypted copy of a fleet. Those are days of work, not months — but they are
work that has not happened, and until it has, this runs a pilot at most.
