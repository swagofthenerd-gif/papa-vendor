> Supporting research for `docs/hosting-decision.md`. Produced 2026-08-12.

# Papa Vendor — Infrastructure Decision, Five Lenses

Status: research report (plan mode, no changes made). Date 2026-08-12.

## Headline

Run **Supabase Pro in ap-south-1 (Mumbai)**, ~$25/mo. Photos on **Cloudflare R2**, not
Supabase Storage. **OTP at enrolment only**, delivered by a Pakistani SMS aggregator or
WhatsApp — not Twilio-per-login. The database was never the risk. SMS pricing is.

---

## LENS 1 — Is "Supabase doesn't scale" true?

**Verdict: mostly folklore, with two real kernels — neither of which is the database,
and neither of which binds this app for years.**

### What is genuinely constrained

| Constraint | Reality | Bites this app? |
|---|---|---|
| Supavisor pool size | Hard-coded per compute tier; can't raise without upgrading compute. PostgREST advises staying under ~40% of pool. ([docs](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI)) | No — scanners are stateless HTTP cursor-pulls, no long-lived connections. This is the #1 killer for people who point Prisma-per-lambda at it. Not us. |
| No superuser | `supautils` gives the `postgres` role most of what matters; some GUCs are unreachable. ([docs](https://supabase.com/docs/guides/database/postgres/roles-superuser)) | Barely — schema uses one extension (`pgcrypto`) and a custom `papa_app` NOSUPERUSER role, which is *exactly* the posture Supabase already enforces. |
| postgresql.conf | Most params tunable via CLI/dashboard; a subset is not. ([docs](https://supabase.com/docs/guides/database/custom-postgres-config)) | No. |
| Extensions | Fixed allowlist. | No — one extension, and hand-written UUIDv7 was already chosen to avoid extension dependency. This decision has now paid for itself. |
| Read replicas / multi-region | Pro+ add-on, geo-routed since Apr 2025. ([docs](https://supabase.com/docs/guides/platform/read-replicas)) | Not yet. Available when needed. |
| Uptime | Real: Feb 12 2026, us-east-2 fully down 3h42m from an internal VPC Block Public Access misconfiguration. ([postmortem](https://supabase.com/blog/supabase-incident-on-february-12-2026)) StatusGator logged 18 component incidents in a recent 30-day window. | Yes, and this is the honest cost. Offline-first is the mitigation — scanners keep working through it. Pick Mumbai, not us-east-2. |

### "Debugging is a mess"

Largely a complaint about a different app shape. That critique comes from people debugging
`supabase-js` + RLS + Realtime *from a browser*, where failures surface as an empty array
with no error. **This app does none of that** — `packages/core` has zero deps, no Supabase
SDK, and the logic is 2,533 lines of SQL exercised by 226 assertions against stock
`postgres:16-bookworm` in CI.

What you actually get: `pg_stat_statements` pre-installed (last 5,000 statements),
Postgres logs, the query-performance dashboard, `EXPLAIN` unchanged.
What you actually lose vs RDS: Performance Insights, long log retention (7d on Pro),
core dumps, `auto_explain` depth. **A non-technical founder was never going to use
Performance Insights.** For a SQL-first codebase with a pgTAP harness, the debugging
surface is ~95% identical and it lives in your repo, not the vendor.

### What Supabase genuinely does well *for this specific app*

This is the part the "just use RDS" advice ignores. Supabase supplies, at $25/mo:

1. **PostgREST** — the app needs an API tier that sets org context per transaction.
   The schema *already* reads `request.jwt.claim.org_id`, which is the PostgREST/GoTrue
   convention. That component is otherwise ~2 weeks of Node you must write, deploy,
   patch and operate.
2. **GoTrue** — phone OTP, JWT issuance, session management. Otherwise weeks.
3. **Storage** with RLS + signed URLs.
4. **pg_cron + pg_net** — hold expiry, `prune_rate_limits()`, digests, with no worker to run. ([docs](https://supabase.com/docs/guides/cron))
5. **Managed backups, patching, TLS, failover** — with no operator.
6. **Migrations applied from CI** against the same Postgres the tests run on.

Replicating 1–5 yourself: conservatively 4–6 weeks of engineering the founder does not
have, plus permanent operational ownership he cannot discharge.

---

## LENS 2 — What breaks first, and at what number

Ranked by when it actually bites. Working assumption: 400 scans/org/day; 3–5 devices/org.

| # | Failure | Threshold | Status |
|---|---|---|---|
| 1 | **Photo storage + egress** | ~50–100 orgs | **Real, unbudgeted.** 1600px WebP ≈150KB; ~100 photos/org/day ⇒ **~5.5 GB/org/year**. At 100 orgs that is **~550 GB/yr** — 2,000× the database. On Supabase Storage: ~$12/mo storage + $0.09/GB egress. On R2: $0.015/GB and **$0 egress**. Use R2. |
| 2 | **PostgREST request rate** | ~1,000 orgs on Micro | 300 devices polling/60s = 5 req/s (trivial). 3,000 devices = 50 req/s (needs Small/Medium). 30,000 devices = ~1,000 req/s ⇒ Large + read replicas. Fixed by paying money, on a curve well behind revenue. |
| 3 | **`scan_events` growth** | ~500 orgs / ~50M rows / ~20 GB | Already flagged. 10k orgs ⇒ ~1.46bn rows/yr ≈ 300 GB/yr. **Monthly partitioning is genuinely required and genuinely painful after the fact.** Do it at 500 orgs, not 5,000. |
| 4 | **Concurrent writes / per-org watermark** | Not before ~50 simultaneous scanners *in one org* | The upsert takes a row lock for sub-ms transaction duration ⇒ theoretical thousands/sec per org; a real org does <5/sec. **The stated worry is over-weighted.** Still worth the load test, but it is unlikely to be the wall. |
| 5 | **Global `change_seq`** | Effectively never | `nextval` is non-transactional and cacheable; the documented remedy is a `CACHE` clause. Aggregate write rate at 10k orgs ≈ 46 writes/sec average, maybe 500/s peak — against a ~2,000 writes/sec durable ceiling on ordinary hardware. **Not a bottleneck. Drop this concern.** |
| 6 | **Connection exhaustion** | Not applicable | Already designed out by stateless cursor-pull. The classic Supabase killer does not apply here. |
| 7 | **First-sync payload** | ~5,000 assets/org | 68ms/2000-asset page measured. Paged already. Fine. |
| 8 | **RLS overhead** | Not applicable | Predicates measured as sargable, pushed into `Index Cond`. This is the thing everyone fears and it is already solved here. |

**How far does one well-tuned Postgres get this workload?** Absurdly far. OpenAI runs
ChatGPT for ~800M users on a **single-primary** Postgres (one Azure Flexible Server for
all writes, ~50 read replicas), millions of QPS, low-double-digit-ms p99, explicitly
choosing not to shard. ([OpenAI](https://openai.com/index/scaling-postgresql/),
[ByteByteGo](https://blog.bytebytego.com/p/how-openai-scaled-to-800-million))
Papa Vendor at 10,000 rental houses is a read-heavy workload roughly **five orders of
magnitude** smaller. **One instance is the answer through the entire realistic life of
this company.** Sharding, Aurora, Citus — all noise.

---

## LENS 3 — A bad night, per option, with no engineer

| Option | Who patches | Who notices disk full | Failover | Restoring a backup | Verdict |
|---|---|---|---|---|---|
| **Supabase** | Supabase | Supabase (alerts + auto-scale disk) | Managed; you find out from status page | Dashboard restore; PITR is a **$100/mo add-on** — Pro alone gives 7-day daily backups | **Defensible.** Bad night = read status page, tell customers, scanners keep working offline. |
| **AWS RDS + custom server** | You (RDS minor versions are managed; **your EC2/container is not**) | You, via CloudWatch alarms you must author | Multi-AZ ~60–120s, automatic | `RestoreDBInstanceToPointInTime` → new endpoint → **you must repoint the app** | **Negligent here.** Bad night = an unpatched Node box, a founder who cannot read CloudWatch, and nobody to page. |
| **Aurora** | AWS | AWS | Excellent | Good | Right answer, wrong company. ~$50+/mo floor before anything else, for scale you will never need. |
| **Neon** | Neon | Neon | Good | Branch-restore is genuinely nice | Fine DB, but **DB only** — auth, API, storage, cron all still unbuilt. Scale-to-zero saves nothing when devices poll continuously. |
| **Cloud SQL** | Google | Google | Good | Good | Equivalent to RDS. Same "and now build everything else" problem. |
| **Fly.io / Render** | Fly's *Managed* Postgres yes; classic Fly Postgres is **an app in a machine — you own backups, upgrades, failover** ([docs](https://fly.io/docs/mpg/)) | You | You | You | Fly MPG starts ~$38/mo. Render similar. Reasonable *compute* host; poor *only-operator* database. |
| **Self-managed VPS** | You | You | None | You, from a script you wrote and never tested | **Negligent.** A VPS with no operator is a data-loss event with a start date. |

Options that are **negligent given constraint #1 (no engineer, no on-call)**: self-managed
VPS, classic Fly Postgres, and AWS RDS + custom server. Not because they are bad
technology — because they transfer 24/7 responsibility to someone who cannot discharge it.

**The unglamorous truth about backups:** on every option, "we have backups" is worthless
until someone has *restored* one. Whatever is chosen, do a restore drill once, write down
the steps, and put them where the AI assistant can read them.

**The $100/mo PITR line is the single most under-appreciated fact in this whole analysis.**
`production-readiness.md` lists "No backups / PITR" as *"Hours, once hosted."* On Supabase
it is hours **plus $100/month** — 4× the infrastructure budget. Pre-revenue substitute:
Pro's 7-day daily backups + the append-only event log + a nightly `scan_events` NDJSON
export to R2 (which the doc already wants). Turn PITR on at first revenue.

---

## LENS 4 — Migration and reversibility

The audit's ~99% figure is credible **and unusually well-earned**: zero-dep core, one
extension, a vendor-free `papa.org_id` fallback exercised by all 226 tests, and CI running
against stock `postgres:16-bookworm`. That last item is the real asset — it is a
*continuous portability regression test*, and its value is routinely underestimated.

Worth noting: `docs/architecture.md` still recommends PowerSync + `supabase-js`. **The
built code has already diverged toward portability** and is better for it. Update the doc
so nobody reintroduces the SDK.

### Genuine cost of being wrong

- **At 100 orgs (~5 GB DB):** 1–2 days + a ~30-minute `pg_dump`/`pg_restore` window at
  night. Cheap. Real.
- **At 1,000 orgs (~50–100 GB, partitioned `scan_events`):** logical replication, a
  rehearsed cutover, DNS/JWT-issuer swap. ~1 week, genuinely risky, needs an engineer —
  but at 1,000 paying rental houses you can afford one.
- **What actually makes Postgres migrations hard** (in order): auth coupling, storage
  coupling, vendor extensions, connection semantics, downtime. **Schema is never the hard
  part.** Everyone optimises for the easy part.

### Rules that keep it cheap

1. Never FK to `auth.users`. *(already flagged)*
2. Never let a vendor SDK become the data layer. *(already flagged)*
3. **Never call `auth.uid()` inside an RLS policy or RPC.** Read org/actor only from
   `current_setting(...)` with the `papa.*` fallback. — see one-way door below.
4. Keep CI running against **stock `postgres:16`**. A test that requires Supabase to pass
   is a portability regression; treat it as a failing build.
5. Store an **opaque storage key** in the DB, never a vendor-signed URL. Resolve to a URL
   at read time behind one function.
6. `pg_cron` job bodies stay one line: `SELECT expire_holds();`. The function is portable,
   the scheduler is not.
7. No new extensions without an explicit written decision. One (`pgcrypto`) is the record
   to defend.
8. Migrations stay plain numbered SQL runnable by `psql`, never `supabase db push`-only.
9. Own the `users` table with your own UUID PK and a nullable `external_auth_id TEXT`.
10. Realtime is a nudge, never a correctness dependency. *(architecture already says this — keep it)*

### The one-way door

**Letting the identity model live in the vendor** — `auth.uid()` in policies, FKs to
`auth.users`, JWT claims your own schema cannot mint. Do that and migration stops being a
data move and becomes a re-authentication of every user and device in the field, on
offline phones, in warehouses. That is the decision that converts cheap to expensive.
Nothing else on this list is close.

---

## LENS 5 — The pieces that are not the database

This is where the decision is actually made.

| Piece | Supabase gives | Must build if you pick RDS/Neon |
|---|---|---|
| **API tier** (must `SET LOCAL papa.org_id` per txn) | PostgREST — and the schema already speaks its claim convention | A Node service: ~2 weeks build, then hosting, TLS, patching, deploys, forever |
| **Auth** (phone OTP, sessions, PIN) | GoTrue, incl. custom SMS hook and Twilio Verify/WhatsApp channel ([docs](https://supabase.com/docs/guides/auth/phone-login)) | Weeks, and it is the component where a mistake is a breach |
| **Photo storage** | Storage + signed URLs (**but see cost — use R2 anyway**) | R2 either way |
| **Cron** (hold expiry, `prune_rate_limits`, digests) | pg_cron + pg_net ([docs](https://supabase.com/docs/guides/cron)) — caveat: **no retries, no alerting, silent stop on a paused/unhealthy project**; add an external heartbeat | A worker + scheduler + its own uptime |
| **WhatsApp** | Edge Function calling Twilio/Meta | Same work either way |
| **CDN** | Cloudflare in front of R2, free | Same either way |
| **Monitoring** | Logs + dashboard; add Sentry free + UptimeRobot free | Same, plus CloudWatch alarms you must author |

### SMS is the real budget crisis, and nobody is looking at it

**Twilio charges ~$0.4734 per SMS segment to Pakistan**
([Sent](https://www.sent.dm/en/resources/sms-pricing/pakistan-sms-pricing)). Plivo is
~$0.08 — still ~6× cheaper but not cheap. At 100 orgs × 5 staff × 2 OTP logins/month:

- Twilio: **~$473/month** — 19× the entire infrastructure budget.
- Plivo: ~$80/month — still over budget.
- Local Pakistani aggregator (Jazz/Telenor shortcode): roughly $0.002–0.004 ⇒ **~$3/month**.

**The database costs $25/month. SMS-per-login costs $473/month. The founder has been
worrying about the wrong number by a factor of twenty.**

The fix is architectural, not a vendor swap, and the design already contains it:
**OTP at enrolment only**, then a long-lived device session plus a per-user PIN on shared
warehouse devices. That converts a recurring per-login cost into a one-time
per-staff-member cost: ~500 lifetime enrolments ≈ $2 via a local aggregator, ~$237 one-time
even at Twilio's rate. Add WhatsApp as the primary OTP channel (dominant in Pakistan,
supported natively by Twilio Verify through Supabase) with SMS as fallback.

**Conclusion: Supabase minimises total work by a wide margin, because for this app the
database was already the finished part and every other box is one Supabase already ticks.**

---

## RECOMMENDATION

**Supabase Pro, ap-south-1 (Mumbai). ~$25/mo. Photos on Cloudflare R2. OTP at enrolment
only via a local PK aggregator or WhatsApp.** Budget: ~$30/mo, inside the $50 cap.

Reasoning, weighted for a non-technical founder with no engineer:

1. The database is the *least* risky part of this system and it is already done to a
   standard most funded startups never reach. Choosing infrastructure to optimise the
   database is optimising the finished component.
2. Supabase's famous scaling wall — connection exhaustion via long-lived pooled
   connections — **was designed out of this architecture before it was built.**
3. Every non-database box (API tier, auth, storage, cron, backups, patching) is ticked at
   $25/mo. On RDS all of them become the founder's problem, at a *higher* real cost once
   NAT gateways (~$32/mo alone), an app host, and Multi-AZ (~$35/mo) are counted.
4. The portability the audit measured is real, so this is a **reversible** decision — and
   the migration price stays low as long as the ten rules above hold.
5. Mumbai gives ~40–60ms to Lahore and is not us-east-2, where the February 2026 outage
   happened.

Explicitly not chosen: Aurora (paying for scale that will never arrive), Neon (fine DB,
solves 20% of the problem, scale-to-zero worthless under continuous polling), Fly/Render
Postgres (you own failover), VPS (data loss with a start date).

---

## STAGED PATH

| Stage | Run | Cost | Trigger to move on |
|---|---|---|---|
| **0 users** | Supabase Pro Micro, Mumbai. CI applying migrations. R2 bucket. Sentry + UptimeRobot free. Nightly `scan_events` NDJSON → R2. **Restore drill once, written down.** | ~$25 | First paying customer |
| **~100 orgs** | Compute → Small. PITR on ($100/mo — affordable now). Cron heartbeat alert. Concurrent-write load test. | ~$150 | `scan_events` > 50M rows **or** > 20 GB **or** ~500 orgs |
| **~1,000 orgs** | Compute → Medium/Large. **Partition `scan_events` monthly — do NOT be late.** First read replica if p99 slips. Hire or contract an engineer. | ~$400–800 | p99 read latency > 200ms, or write p99 climbing, or a second geography |
| **~10,000 orgs** | Large/XL primary + read replicas (Mumbai/Singapore/Frankfurt). Still **one primary** — see OpenAI. Revisit self-hosting only if the bill exceeds an engineer's salary. | $2–5k | Bill > cost of an SRE. Not before. |

Sequencing note: `production-readiness.md`'s ordering is right, with one change — **CI
first, then the R2 bucket + photo pipeline before the pilot**, because photo egress is the
first cost surprise and the hardest thing to re-key after the fact.

---

## IF HE INSISTS ON AWS RDS + CUSTOM SERVER

**The steelman, honestly made:**
- Total control: any extension, any GUC, `auto_explain`, Performance Insights, arbitrary
  retention. Real advantages if you have someone to use them.
- No PostgREST in the path — your own API can enforce `SET LOCAL papa.org_id` explicitly
  and legibly, which some engineers rightly prefer to trusting JWT claim plumbing.
- PITR is included in RDS backups, not a $100/mo add-on. Genuinely a point in its favour.
- No vendor risk: no February-2026-style regional config error from someone else's
  deploy pipeline.
- The 99% portability is real, so this *is* technically achievable.

**And honestly: it is not defensible here.**
- It solves a problem that does not exist. Every RDS advantage is a *tuning* advantage,
  and there is nobody to tune. The measured hot path is 0.08ms.
- It is **more expensive**, not less: t4g.micro Multi-AZ ~$35 + storage + app host $10–15
  + NAT gateway ~$32 (if VPC'd correctly) ⇒ **$80–100/mo before auth, storage or cron
  exist**. Over budget on day one, for less functionality.
- It creates 4–6 weeks of work — API tier, auth, storage, cron, monitoring — that
  Supabase supplies for $25.
- It transfers 24/7 operational responsibility to a founder who cannot discharge it.
  "Who notices the disk is full at 2am?" has no answer, and that is a business risk, not
  a technical preference.
- Google suggested it because it is the *generic* answer to "production Postgres." It is
  the correct answer for a team with an SRE. It is the wrong answer for a team of one
  non-technical person and an AI.

**The one concession worth making:** the instinct behind "custom server" is sound. This
app *does* need a server-side place to set org context, and if PostgREST claim-plumbing
ever proves awkward, adding a thin Node/Deno service **in front of Supabase Postgres** is
a small, reversible step — you get the explicit `SET LOCAL` without giving up managed
backups, patching, auth or storage. Take that step if and when it is needed. Do not take
it on day one, and do not take the whole AWS bundle to get it.
