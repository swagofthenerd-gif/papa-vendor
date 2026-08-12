> Supporting research for `docs/hosting-decision.md`. Produced 2026-08-12.

# Database & Infrastructure Decision Research — Papa Vendor (B2B SaaS, film-equipment rental houses)

Researched 2026-08-12. All prices are as-quoted on that date and change frequently.
**Note on file location:** this session was in plan-mode, which restricts writes to this plan file only, so the report was written here instead of the requested scratchpad path. Content is the full report.

---

## 0. Executive summary — "Is Supabase actually a scaling problem?"

**No. Not for this business. Not for a very long time.**

The claim "Supabase doesn't scale" is, as usually stated, false — but it is a garbled version of two things that *are* true:

1. **Supabase's *managed platform layer* has real, hard, documented ceilings** — connection counts, pooler client caps, PostgREST throughput, Realtime concurrency. These are tier-limited numbers you hit by picking too small a compute tier, and they're fixed by paying for a bigger one. They are *configuration* ceilings, not architectural ones.
2. **The *debugging/control* complaint is partly legitimate.** You do not get full superuser. Self-hosted Supabase is missing a meaningful slice of the cloud product (logs, backups/restore, reports). Some failure modes are opaque because they happen inside Supabase's Go/Elixir services rather than in your code.

The decisive counter-evidence to the scaling claim: **OpenAI runs ChatGPT for ~800 million users on a single unsharded primary PostgreSQL instance** (Azure Postgres Flexible Server + ~50 read replicas + PgBouncer + heavy caching), doing millions of queries/sec at low-double-digit-ms p99. Stated publicly by OpenAI infra engineer Bohan Zhang at PGConf.Dev 2025.
— https://venturebeat.com/data/how-openai-is-scaling-the-postgresql-database-to-800-million-users
— https://blog.bytebytego.com/p/how-openai-scaled-to-800-million

If one Postgres primary serves 800M consumer users, then a B2B app serving staff at ~10,000 rental houses (call it 100k–300k human accounts, low write volume, heavily read-biased, business-hours traffic in one or two timezones) is **nowhere near any Postgres ceiling on any provider**. The database is not going to be what kills this company.

**The single most important structural fact in this whole report:** the app is built on **plain Postgres — RLS policies, SQL functions, SQL migrations, deliberately portable**. That means the provider choice is *reversible*. It is a rented decision, not a married one. `pg_dump` / logical replication moves it. This changes the correct decision from "pick the endgame platform now" to "pick the cheapest thing that lets you ship, and keep the exit door oiled."

**Recommendation in one line:** Stay on Supabase (or move to Neon/PlanetScale Postgres if a specific limit bites), keep the schema provider-neutral, and do not touch AWS RDS until you have either (a) a real engineer whose job is infrastructure, or (b) a customer contract that requires it. "AWS RDS + custom server" is not an upgrade — it is a transfer of ~1–2 FTE of unpaid operational work onto a pre-launch company with a non-technical founder.

**The counter-case, stated fairly:** the honest risks of staying on Supabase are *not* scale. They are (1) vendor concentration — auth, storage, realtime, and DB all from one company, so an outage takes the whole product down; (2) Supabase incident history is not spotless (see §1.4); (3) auth coupling is the one thing that makes migration genuinely painful later. Mitigations in §5.

---

## 1. Supabase

### 1.1 What it actually is, architecturally

Supabase is **not a database**. It is a bundle of open-source services wrapped around a stock (or near-stock) PostgreSQL instance running on AWS EC2 + EBS:

| Component | What it is | Language |
|---|---|---|
| **PostgreSQL** | The actual database. Real Postgres, not a fork. | C |
| **PostgREST** | Auto-generates a REST API from your schema; the `supabase-js` client mostly talks to this. | Haskell |
| **GoTrue / supabase-auth** | JWT issuance, OAuth, magic links; owns the `auth` schema. | Go |
| **Realtime** | Listens to the Postgres WAL, broadcasts row changes over WebSockets. | Elixir |
| **Supavisor** | Multi-tenant connection pooler (their pgbouncer replacement). | Elixir |
| **Storage** | S3-backed object store with RLS-aware access rules. | TypeScript |
| **Kong** | API gateway in front of all of it. | Lua/nginx |

— https://supabase.com/blog/supavisor-postgres-connection-pooler

The critical implication: **the Postgres underneath is genuinely yours and genuinely portable.** You can connect with `psql`, any ORM, any language, on port 5432 (direct) or 6543 (Supavisor transaction pooling). Nothing about the DB layer locks you in. What locks you in is the *other six boxes* — auth, storage, realtime, edge functions.

### 1.2 Can you access and tune the underlying Postgres? (This is the "no control" claim)

Mostly yes, with an asterisk:

- **Direct Postgres connection:** yes, full `psql` access as the `postgres` role.
- **Extensions:** yes, a large curated list — `pg_stat_statements`, `pgcrypto`, `uuid-ossp`, `pgvector`, `postgis`, `pg_cron`, `pgaudit`, `auto_explain`, etc. You cannot install arbitrary compiled extensions from disk.
- **`pg_stat_statements`:** available and pre-enabled. Slow query logs and query performance reports are in the dashboard.
- **`postgresql.conf`:** partially. Supabase ships a `supautils` extension that grants the `postgres` role a *subset* of superuser privileges. You can `ALTER DATABASE ... SET` any `user`-context parameter (e.g. `statement_timeout`), and the Supabase CLI exposes 40+ system-level parameters including `shared_buffers`, `max_connections`, `work_mem`, WAL and logging settings.
  — https://supabase.com/docs/guides/database/custom-postgres-config
- **What you do NOT get:** true `SUPERUSER`, filesystem access, `pg_upgrade` on your own schedule, arbitrary C extensions, or the ability to run a sidecar process on the DB host.

**Verdict on "you don't get control":** overstated. You get more control than RDS gives you in some respects (RDS also denies superuser and restricts `postgresql.conf` to parameter groups). The real control gap vs. a self-managed box is significant; the control gap vs. RDS is small.

### 1.3 The real, documented ceilings (compute tiers)

This is the concrete answer to "does it scale." Supabase publishes hard per-tier limits:

| Tier | vCPU | RAM | ~$/mo | Max direct connections | Max pooler clients |
|---|---|---|---|---|---|
| Micro | 2 (shared) | 1 GB | ~$10 | 60 | 200 |
| Small | 2 (shared) | 2 GB | ~$15 | 90 | 400 |
| Medium | 2 (shared) | 4 GB | ~$60 | 120 | 600 |
| Large | 2 (dedicated) | 8 GB | ~$110 | 160 | 800 |
| XL | 4 | 16 GB | ~$210 | 240 | 1,000 |
| 2XL | 8 | 32 GB | ~$410 | 380 | 1,500 |
| 4XL | 16 | 64 GB | ~$960 | 480 | 3,000 |
| 8XL | 32 | 128 GB | ~$1,870 | 490 | 6,000 |
| 12XL | 48 | 192 GB | ~$2,800 | 500 | 9,000 |
| 16XL | 64 | 256 GB | ~$3,730 | 500 | 12,000 |

Source: https://supabase.com/docs/guides/platform/compute-and-disk (fetched 2026-08-12). Plus the Pro plan base fee (~$25/mo) on top.

Disk: gp3 up to 16 TB ($0.125/GB, $0.024/extra IOPS, $0.95 per MB/s above the 125 MB/s baseline); io2 up to 60 TB ($0.195/GB, $0.119/provisioned IOPS). 4XL sustains 594 MB/s / 20,000 IOPS; 16XL sustains 2,375 MB/s / 80,000 IOPS.

**Read this table honestly.** The 16XL is a 64-vCPU / 256 GB machine — that is a *serious* database server, roughly what a mid-size bank runs a core system on. Getting there from a rental-house SaaS would require a scale of business that would make the ~$3,730/mo bill a rounding error. The "Supabase doesn't scale" claim is essentially someone who was on the Micro or Small tier, hit the 200-client pooler cap or ran out of 1 GB of RAM, and concluded the platform was broken.

**The most common real failure, documented:** a project "crashing at 5,000 users with queries taking 8+ seconds, the database hitting connection limits, and real-time subscriptions dropping constantly."
— https://www.princenocode.com/blog/scale-supabase-production-guide
Diagnosis in nearly every such write-up: **missing indexes + direct connections instead of the pooler + undersized tier.** These are self-inflicted, and identical mistakes produce identical outcomes on RDS.

### 1.4 Outages and incidents — EVIDENCE, distinguished from marketing

Supabase runs a public status page: https://status.supabase.com/

Third-party aggregator StatusGator (https://statusgator.com/services/supabase) records, among others:
- 2025-08-05 — dashboard/database access issues, ~24 min
- 2025-12-05 — auth login failures, ~23 min
- 2026-02-12 — connection timeouts and API issues, **4h 11m**
- 2026-04-17 to 2026-04-20 — a cluster of incidents reported as ranging from ~10 hours to multiple days

**Caveat, stated plainly:** the April 2026 events are from a third-party aggregator, not from a Supabase postmortem I was able to read. StatusGator flags *any* status-page component degradation, which inflates apparent severity, and aggregator durations often reflect "component not green" rather than "customers down." **I could not find a first-party Supabase postmortem for those dates.** Treat as "there was a bad stretch in April 2026, magnitude unverified," not as fact. If this decision matters, read status.supabase.com's own history for those dates directly.

The 4h11m February 2026 event is the kind of thing that matters: a multi-hour control-plane/connection incident on a shared platform is an outage you cannot fix, cannot escalate meaningfully at Pro-tier support, and cannot explain to a rental house whose crew is standing in a warehouse.

**This — not scaling — is the honest argument against Supabase.** Concentration risk. And note the symmetry: AWS also has multi-hour regional outages (us-east-1 is famous for it), and when AWS breaks, Supabase breaks too, because Supabase runs on AWS.

### 1.5 Scaling levers on Supabase

- **Vertical:** the tier table above. One click, brief restart.
- **Read replicas:** available on Pro+ (Supabase's own framing: https://supabase.com/blog/read-replicas-vs-bigger-compute). Supavisor load-balances reads across the cluster and routes writes to the primary.
- **Multi-region:** read replicas can be placed in other regions. There is **no multi-primary / global-write story.** For a Pakistan-based B2B app this is irrelevant.
- **Supavisor headroom:** Supabase published a demonstration of Supavisor proxying **1 million connections** (https://supabase.com/blog/supavisor-1-million). That is a benchmark of their pooler software, not a per-project entitlement — your project is capped by the per-tier "max pooler clients" number above. **This is a marketing claim, not an entitlement.** Do not confuse the two.

### 1.6 Published customers

Supabase cites Mobbin (migrated ~200k users off Firebase), Pebblely (1M users in 7 months), and Humata (millions of users). SOC 2 Type 2, HIPAA, ISO 27001:2022.
— https://unicoconnect.com/blogs/is-supabase-production-ready

Treat these as **marketing claims** — vendor-selected references, no independent load figures. They do establish that "nobody runs Supabase in production at scale" is false; they do not establish a ceiling.

### 1.7 Is self-hosting Supabase a real escape hatch or theatre?

**Mostly theatre, for this company.** The core is genuinely open source and genuinely runs. But self-hosted is missing significant parts of the product:

- Log aggregation and the analytics/reports UI (community reports of "No results found" for PostgREST, Edge Functions, and Cron logs)
- Managed backups and point-in-time restore
- Email template customisation, several dashboard tools

— https://github.com/orgs/supabase/discussions/40583
— https://www.supascale.app/blog/what-features-are-missing-in-selfhosted-supabase

Operational estimate commonly cited: **1–2 FTE** to run self-hosted Supabase properly.
— https://starterpick.com/guides/self-hosted-vs-cloud-supabase-saas-2026

For a pre-launch, non-technical-founder company, self-hosting Supabase would be the single worst option in this entire report. The real escape hatch is not self-hosting — it's **`pg_dump` to any other Postgres**, because the app is plain Postgres.

---

## 2. AWS RDS / Aurora — the "Google said this" option

### 2.1 The three products

| | **RDS for PostgreSQL** | **Aurora PostgreSQL** | **Aurora Serverless v2** |
|---|---|---|---|
| Engine | Real community Postgres | AWS's reimplementation of the storage layer under a Postgres-compatible engine | Same as Aurora, autoscaled |
| Storage | EBS volume you size | Distributed 6-way-replicated storage, auto-grows to 128 TB | Same |
| Read replicas | Up to 15, async, replica lag in seconds | Up to 15, share the same storage, lag typically <100 ms | Same |
| Failover | Multi-AZ, typically 60–120 s | Typically <30 s | Same |
| Portability | **Fully portable** — plain Postgres | Postgres-compatible but a fork; `pg_dump` out works, some behaviour differs | Same |
| Best for | Steady, predictable load. Cheapest of the three. | High read fan-out, fast failover, storage you don't want to size | Spiky/unpredictable load, dev environments |

**For this app, RDS Postgres is the right one of the three, if AWS at all.** Aurora's advantages (15 low-lag replicas, instant storage growth, sub-30s failover) solve problems a rental-equipment SaaS does not have. Aurora also charges for I/O in the standard configuration, which is the classic surprise-bill trap.

**Aurora Limitless** (sharded Aurora) is for workloads that genuinely exceed a single writer. Not remotely relevant here — see §4.5.

### 2.2 What "AWS RDS + custom server" actually means operationally

This is the part Google does not tell a non-technical founder. Moving from Supabase to "RDS + custom server" doesn't remove work — it *reassigns* it to you. Concretely, you now own:

- **VPC design** — subnets, route tables, security groups, NAT gateway (~$32/mo + data charges just for the NAT)
- **The app tier** — ECS/Fargate or EC2, task definitions, load balancer, autoscaling, deploy pipeline
- **Auth** — Supabase gave you GoTrue for free. Now: Cognito (painful), or Auth0/Clerk (~$0–$240+/mo and up), or you write it. **This is the single biggest hidden cost of leaving Supabase.**
- **File storage** — S3 + signed URLs + your own access rules. Supabase Storage's RLS integration disappears.
- **Realtime** — if the app uses it, you now build it (WebSockets + a WAL listener, or drop the feature)
- **Auto-generated API** — PostgREST gave you CRUD endpoints free. Now you write them.
- **Connection pooling** — RDS Proxy or self-run PgBouncer (see §2.5)
- **Backups + restore drills** — RDS automates snapshots; *verifying you can actually restore* is still your job
- **Patching windows** — RDS applies minor versions in a maintenance window; major version upgrades are yours to plan and test
- **Monitoring/alerting** — CloudWatch dashboards, alarms, Performance Insights, on-call rotation
- **IAM** — the single most common source of "why doesn't this work" days

**What a bad night looks like on Supabase:** the status page turns orange, you post in Discord, you wait, it comes back. You are powerless but you are also not awake at 3 a.m.

**What a bad night looks like on AWS:** an alarm fires (if you configured it). Connections are exhausted. You need to know whether it's the app leaking connections, RDS Proxy misconfigured, a runaway query, or a failover in progress. You need someone who can read `pg_stat_activity`, has console access, and knows the difference. **A non-technical founder cannot do this, and neither can a contractor who isn't on retainer.** Enterprise Support (which gets you a human quickly) starts at $15,000/month or 10% of spend, whichever is greater. Business Support (~$100/mo minimum, tiered on spend) gets you a ticket queue with a 1-hour response target for production-down.

### 2.3 Real costs at three scales

**Important honesty caveat:** AWS's live pricing pages render prices via JavaScript and could not be scraped. Third-party aggregators disagreed materially — one listed db.m7g.large at $0.168/hr, another at $0.34/hr (~$248/mo), likely a Single-AZ vs Multi-AZ or engine difference.
— https://instances.vantage.sh/aws/rds/db.m7g.large
— https://www.economize.cloud/resources/aws/pricing/rds/db.m7g.large/
**Treat the tables below as order-of-magnitude, not quotes.** Verify in the AWS Pricing Calculator for your actual region before deciding — and note Middle East / Mumbai regions run roughly 10–25% above us-east-1.

**(a) ~100 orgs / early launch** — us-east-1, Single-AZ, minimal

| Line | Est. $/mo |
|---|---|
| RDS db.t4g.medium Postgres, Single-AZ | ~$50–70 |
| 100 GB gp3 storage + backups | ~$15 |
| App tier: 1–2 small Fargate tasks or a t4g.small EC2 | ~$20–40 |
| ALB | ~$18–25 |
| NAT Gateway | ~$35–45 |
| S3 + CloudFront (light) | ~$5–15 |
| Auth (Cognito free tier / Clerk free tier) | $0 |
| CloudWatch logs/metrics | ~$10–20 |
| **Total** | **~$155–230/mo** |

**Supabase equivalent: ~$25–35/mo** (Pro plan + Small/Medium compute), including auth, storage, realtime, and the API layer that AWS is not providing above. **AWS is 5–8× more expensive at this scale and does less.**

**(b) ~5,000 orgs** — Multi-AZ, real traffic

| Line | Est. $/mo |
|---|---|
| RDS db.m7g.xlarge (4 vCPU/16 GB), **Multi-AZ** | ~$500–700 |
| 500 GB gp3 + provisioned IOPS + backups | ~$90–150 |
| RDS Proxy | ~$40–90 |
| App tier: 4–6 Fargate tasks (1 vCPU/2 GB) | ~$150–250 |
| ALB + NAT + data transfer | ~$90–150 |
| S3 + CloudFront (equipment photos/PDFs) | ~$40–120 |
| Auth (Clerk/Auth0 at ~50k MAU) | ~$250–600 |
| CloudWatch + Performance Insights | ~$50–120 |
| AWS Business Support (min ~$100, 10%/7% tiered) | ~$150–250 |
| **Total** | **~$1,360–2,430/mo** |

**Supabase equivalent: ~$235–435/mo** (Pro + XL/2XL compute + storage + bandwidth). Even doubling for overages, Supabase is **~3–5× cheaper** and includes auth and storage. And you still need a person to run the AWS side.

**(c) "Millions of users"** — see §4.6 first; for a B2B app with ~10k business customers this number is almost certainly a misunderstanding of what "user" means. But if it were real (say 2M MAU, heavy read traffic):

| Line | Est. $/mo |
|---|---|
| RDS db.r7g.4xlarge (16 vCPU/128 GB) Multi-AZ, or Aurora writer + 2 readers | ~$3,500–6,000 |
| 2–5 TB storage + IOPS + backups | ~$600–1,500 |
| 2–3 read replicas | ~$1,500–3,500 |
| RDS Proxy | ~$200–400 |
| App tier: 20–40 Fargate tasks + ALB + autoscaling | ~$1,200–2,500 |
| CDN + egress (this gets big fast) | ~$800–3,000 |
| Auth at 2M MAU (Cognito, or negotiated Auth0) | ~$1,000–5,000 |
| ElastiCache Redis (you will need it) | ~$300–800 |
| Observability (CloudWatch/Datadog) | ~$500–2,000 |
| Support (Business/Enterprise) | ~$1,000–15,000 |
| **Total** | **~$10,600–39,700/mo** |

Plus **2–4 engineers** whose job is partly or wholly this. At this scale AWS starts to make sense — because at this scale you can afford the people, and Reserved Instances / Savings Plans (up to 45% at 1-yr, 66% at 3-yr no-upfront for provisioned; Database Savings Plans launched at re:Invent 2025 offer up to 35% and cover Aurora Serverless v2) meaningfully change the math.
— https://www.usage.ai/blogs/aws/rds/aurora-serverless-v2/

**The shape of the answer: AWS is not cheaper. It is more controllable, and control costs money and people.**

### 2.4 Aurora Serverless v2 specifics

$0.12 per ACU-hour in us-east-1 (1 ACU ≈ 2 GB RAM + proportional CPU), scaling in 0.5 ACU steps from 0.5 up to 256 ACU. It can now scale to zero.

Breakeven rule of thumb from multiple analyses: **under ~40% average utilisation, Serverless v2 wins; above ~60%, provisioned wins.** At sustained 8 ACU, Serverless v2 runs ~$700/mo vs ~$489 cheaper for equivalent provisioned. One HN report claimed provisioned at ~17% the cost of equivalent Serverless v2 for a steady workload.
— https://www.usage.ai/blogs/aws/rds/aurora-serverless-v2/
— https://www.jusdb.com/blog/aws-rds-vs-aurora-vs-serverless-cost-comparison

A B2B rental app has **exactly the workload shape Serverless v2 is designed for** — business-hours spikes, near-zero at night, weekend troughs. If AWS were chosen, Aurora Serverless v2 is a defensible pick despite the fork-vs-plain-Postgres portability cost.

### 2.5 RDS Proxy — what problem does it solve?

RDS Proxy is AWS's managed connection pooler. It solves exactly the problem Supavisor solves on Supabase: **Postgres allocates a full backend process per connection (several MB of RAM each), so a few hundred connections will exhaust a mid-size box.** Serverless/containerised app tiers make this worse, because each new container opens its own pool.

- **Do you need it?** If the app runs on a fixed set of long-lived servers with a sane in-process pool (e.g. 10–20 connections each), no — you can go direct. If it runs on Lambda or aggressively autoscaling Fargate, yes.
- **Cost:** priced per vCPU of the underlying DB instance per hour; budget ~$40–90/mo at the (b) scale above.
- **Notable:** RDS Proxy is roughly a managed PgBouncer. **Supabase gives you the equivalent (Supavisor) free, on every tier.** This is a point in Supabase's favour that rarely gets counted.

### 2.6 AWS regions and latency from Lahore

**I could not find authoritative, measured Lahore→AWS-region latency figures.** Anything I quoted would be an estimate dressed as data. What I can say from sources:

- AWS has **no region in Pakistan.** Nearest options: `ap-south-1` (Mumbai), `me-central-1` (UAE), `me-south-1` (Bahrain), `eu-west-1` (Ireland), `eu-central-1` (Frankfurt).
- AWS re:Post guidance for Pakistani audiences points to **Mumbai (ap-south-1)** as the latency-optimal choice.
  — https://repost.aws/questions/QUYZZJ0zUXQo-HMadwC9pzhw/hosting-location-near-to-pakistan
- Caveat worth knowing: **India↔Pakistan network routing is politically fragile.** Traffic between the two frequently routes via Singapore, Europe, or the Gulf rather than directly, so "geographic proximity to Mumbai" does not reliably translate into low latency from Lahore. Gulf regions (UAE/Bahrain) often route more predictably from Pakistan via submarine cables landing in Karachi.
- One documented incident had ap-south-1↔me-south-1 inter-region latency spike from 34.4 ms to 160 ms.
  — https://repost.aws/questions/QUnLRWokxcQV-rKbf98FcZGg/significant-latency-increase-ap-south-1-mumbai-to-me-south-1-bahrain-inter-region-backbone

**Action, not estimate:** measure it. Run https://www.cloudping.co/ and https://cloudpingtest.com/aws from a Lahore connection on a normal weekday evening, from two different ISPs. That is 10 minutes of work and gives real numbers instead of my speculation. Do the same for Supabase's `ap-south-1` and `ap-southeast-1` regions.

**Perspective:** for a B2B app where a user loads a page and clicks things, the difference between 60 ms and 140 ms of DB-region latency is invisible next to the front-end's own render time. This is not a decision driver unless the app does chatty round-trips.

---

## 3. The other serious options

| Provider | Plain Postgres? | Pricing shape | Ops burden | Notes |
|---|---|---|---|---|
| **Neon** | Yes | $0.106/CU-hr (Launch) or $0.222/CU-hr (Scale); storage $0.35/GB-mo. 1 CU = 1 vCPU + 4 GB. Launch autoscales to 16 CU; Scale to 56 CU. | Very low | Separates storage from compute; **database branching** (a branch per PR/preview) is genuinely excellent. Scale-to-zero saves money on dev DBs. **Cold start 500 ms–2 s** — disable scale-to-zero for prod (~$19/mo on Launch to stay warm). Scale plan includes 99.95% SLA, SOC 2, HIPAA. Acquired by Databricks (2025). — https://www.saaspricepulse.com/tools/neon , https://selfhost.dev/blog/neon-pricing-cost-of-serverless-postgres/ |
| **PlanetScale Postgres** | Yes | From $5/mo (single node); **Metal from $50/mo** (M-10), down from $589. GA in 2025. | Very low | Historically MySQL/Vitess; **Postgres is real and GA as of 2025** — verified. "Metal" = local NVMe rather than network storage, which is a genuine performance advantage. Strong engineering reputation, strong observability. — https://planetscale.com/blog/planetscale-for-postgres-is-generally-available , https://planetscale.com/blog/50-dollar-planetscale-metal-is-ga-for-postgres |
| **Google Cloud SQL for Postgres** | Yes | Per-vCPU + per-GB-RAM + storage, similar order to RDS | Low-medium | Solid, boring, well-run. Slightly friendlier console than AWS. Mumbai + Middle East regions available. |
| **Google AlloyDB** | Postgres-compatible fork | Premium over Cloud SQL | Medium | Google's Aurora answer. Fast analytics on Postgres. Overkill here. |
| **Azure Database for PostgreSQL Flexible Server** | Yes | Per-vCore + storage | Low-medium | Worth noting: **this is what OpenAI runs ChatGPT on.** Underrated. Azure has a UAE region and reasonable South Asia presence. |
| **Crunchy Bridge** | Yes | ~$100+/mo for real prod instances | Low | Run by long-time Postgres core contributors. Best-in-class Postgres expertise attached to support. Boring in the good way. No auth/storage bundle. |
| **Timescale Cloud (Tiger)** | Postgres + TimescaleDB extension | Usage-based | Low | Only if you have heavy time-series (equipment telemetry, usage logs). Not a general-purpose pick. |
| **Xata** | Yes (now Postgres-based) | Usage-based | Low | Pivoted to Postgres + branching. Smaller company — vendor risk. |
| **Nile** | Yes, Postgres with built-in multi-tenancy | Usage-based | Low | Explicitly built for multi-tenant B2B SaaS — tenant isolation is a first-class primitive rather than something you hand-roll with RLS. **Conceptually the best fit for this exact app shape.** But it is a small, young company; adopting it means betting on their survival. |
| **Render Postgres** | Yes | ~$7–$450+/mo tiers | Very low | Fine for small apps. Weak at large scale, limited tuning. |
| **Fly.io Postgres** | Yes | Cheap VM-based | **Medium-high** | Fly explicitly frames its Postgres as "unmanaged — you own it." Not a managed database. Avoid unless you want the ops. |
| **Self-managed on Hetzner/DigitalOcean VPS** | Yes | **~$20–60/mo for hardware that would cost $500+ on RDS** — this is the real appeal | **Highest** | Hetzner dedicated boxes are absurdly good value. But: you own backups, replication, failover, patching, monitoring, disk-full-at-2am. Realistically **0.25–1 FTE**. For a non-technical founder, this is the worst possible choice regardless of price. |

**The shortlist for this business, in order:**
1. **Supabase** — cheapest all-in (auth + storage + realtime + pooler + API included), fastest to ship, adequate to well past 10k orgs.
2. **Neon** — if you want plain Postgres with excellent DX and branching, and you're willing to bring your own auth (Clerk/Better Auth). Slightly more "just a database."
3. **PlanetScale Postgres** — best operational engineering of the group; pick if performance predictability becomes the priority.
4. **AWS RDS** — the endgame if and only if enterprise customers demand it or you hire infra staff.

---

## 4. What actually breaks at scale, with concrete thresholds

Ordered by when you'll hit it.

### 4.1 Connections — breaks FIRST, always

Postgres forks a full OS process per connection (~5–10 MB each). Every provider caps this.

- **Threshold:** on Supabase Micro/Small (60–90 direct connections, 200–400 pooler clients) you can hit this with **a few hundred concurrent users** if the app opens connections carelessly.
- **Symptom:** `FATAL: remaining connection slots are reserved` / `sorry, too many clients already`, or requests that just hang.
- **Fix:** use the pooler (Supavisor port 6543 / RDS Proxy / PgBouncer) in **transaction mode**, and set a small per-process pool in the app. This is a one-line config change 90% of the time.
- **This is the "Supabase crashed at 5,000 users" story in nearly every case.** It is not a Supabase flaw; it is Postgres, and it happens identically on RDS.

### 4.2 Missing indexes — breaks SECOND

- **Threshold:** roughly **100k–1M rows** in your hot tables, depending on query shape.
- **Symptom:** a query that was 3 ms is now 800 ms; CPU pegged at 100%; everything slow at once.
- **Fix:** `pg_stat_statements` → find the top queries by total time → `EXPLAIN ANALYZE` → add the index. Available on every provider including Supabase.

### 4.3 RLS performance — is it a liability?

**Answer: no, if and only if the columns your policies filter on are indexed.** This is the single highest-value technical finding in this report for this codebase.

Benchmark evidence: with an index on `tenant_id`, count queries dropped from **~73 ms to 2.2 ms — a 26× speedup**; **RLS overhead on indexed conditions stays under 25%.** Without the index, Postgres launches a parallel sequential scan across every tenant's rows.
— https://dev.to/ashwin_sridhar_koto7/does-postgres-rls-actually-ruin-performance-lets-look-at-the-data-24jf
— https://postgres.fm/episodes/rls-vs-performance

**Concrete rules for the Papa Vendor schema:**
1. **Every table with an RLS policy must have an index on the tenant/org column** used in that policy. Non-negotiable.
2. **Wrap function calls in policies in `SELECT`** — write `USING (org_id = (SELECT current_org_id()))` rather than `USING (org_id = current_org_id())`. Postgres then evaluates the function **once per query** instead of **once per row**. This single change is worth orders of magnitude on large tables and is the most commonly missed RLS optimisation.
3. Keep policies as simple predicates. Policies containing subqueries against other tables are where RLS genuinely becomes a scaling liability.
4. Prefer `PERMISSIVE` single policies over stacks of policies — multiple policies OR together and complicate planning.

Documented limitations: RLS is weaker for complex/hierarchical authorization logic and adds operational overhead in debugging.
— https://www.bytebase.com/blog/postgres-row-level-security-limitations-and-alternatives/

**Verdict:** RLS + shared schema + indexed `tenant_id` is the mainstream, correct choice for multi-tenant B2B SaaS. Schema-per-tenant hits a practical ceiling around **10,000–50,000 schemas** and makes migrations agony. Stay with RLS.
— https://propelius.tech/blogs/multi-tenant-database-isolation-postgresql-rls-schema/

### 4.4 Read replicas

- **Threshold:** when the primary's CPU is sustained above ~70% and the workload is read-dominated. For this app, that is realistically **well past 10,000 orgs**.
- Supabase's own guidance says try bigger compute first, replicas second — correct advice.
  — https://supabase.com/blog/read-replicas-vs-bigger-compute
- Caveat: replicas are **eventually consistent**. Reads-after-write must go to the primary. This is an application change, not a config change — budget for it.

### 4.5 Sharding / Citus

- **Threshold:** when a **single writer** can no longer keep up. OpenAI didn't shard at 800M users because *write* volume didn't justify it.
- **For this business: never.** An equipment-rental SaaS's write volume (bookings, check-ins/outs, condition reports) is trivially small. If anyone proposes sharding, they have misdiagnosed the problem.

### 4.6 Table partitioning

- **Threshold:** append-only tables (audit logs, event streams, scan history) past roughly **50–100 million rows** or when index maintenance and vacuum start hurting.
- **Fix:** range-partition by month using declarative partitioning; drop old partitions instead of `DELETE`.
- Design the audit/event tables as partition-ready *now* (include a timestamp in the PK) — it costs nothing today and saves a painful migration later.

### 4.7 How far does ONE well-tuned Postgres actually go?

- **OpenAI: 800M users, millions of QPS, one unsharded primary + ~50 replicas.** (§0)
- Common practitioner consensus: a well-indexed single Postgres on modern hardware comfortably handles **tens of thousands of transactions per second** and **multiple terabytes**.
- **What "millions of users" means for THIS app:** the customers are ~10,000 rental businesses. Each has maybe 5–50 staff logins. That's **50,000–500,000 user accounts**, of which perhaps 5–15% are concurrent during business hours — call it **5,000–50,000 concurrent sessions at absolute peak**, doing low-frequency CRUD.

**That workload fits comfortably on a Supabase Large or XL tier (~$110–210/mo).** The founder should hear this clearly: **the "millions of users" framing is importing consumer-app intuition into a B2B problem where it does not apply.** The database is not the constraint. Getting 10,000 rental houses to pay is the constraint.

---

## 5. Migration reality

### 5.1 The database itself: easy

Because the app is plain Postgres — RLS, SQL functions, SQL migrations, no ORM lock-in — the DB move is genuinely routine:

- **Small (< ~50 GB, tolerate downtime):** `pg_dump` → `pg_restore`. Minutes to a few hours.
- **Large / zero-downtime:** **logical replication** — stand up the new DB as a subscriber, let it catch up, flip the connection string. Minutes of downtime, and this is the professional approach.
- **AWS DMS** exists but is over-engineered for Postgres→Postgres; logical replication is simpler and more reliable.

Documented gotchas: you must recreate the `anon`, `authenticated`, and `service_role` roles in the target or the import fails; and recreate extensions (`pgcrypto`, `uuid-ossp`, etc.) before restoring.
— https://www.bytebase.com/blog/how-to-migrate-from-supabase-to-aws/
— https://encore.dev/articles/migrate-supabase-to-aws

Supabase publishes migration guides *into* Supabase from RDS and from generic Postgres (https://supabase.com/docs/guides/platform/migrating-to-supabase/amazon-rds), which is a reasonable proxy for how mechanical the reverse is.

### 5.2 What actually makes it hard — the four couplings

Ranked by pain:

1. **Auth (worst).** GoTrue owns the `auth` schema, and RLS policies reference `auth.uid()`. Leaving Supabase means replacing GoTrue *and* rewriting every policy's identity source *and* migrating password hashes/OAuth identities. Every migration write-up flags auth as the hardest piece. — https://medium.com/@contact_62664/migrating-from-supabase-to-aws-rds-a-practical-guide-b6513d98529b
2. **Storage.** Supabase Storage's RLS-aware access rules have no direct S3 equivalent; you'd rebuild signed-URL logic.
3. **Realtime.** If the UI depends on live updates, that's a bespoke rebuild.
4. **PostgREST.** If the frontend uses `supabase-js` to query tables directly, you must write a real API layer. This is weeks of work, not days.

### 5.3 The cheap insurance policy (do this regardless of decision)

Four things, all cheap now, that keep the exit cost near zero:

1. **Wrap `auth.uid()` in your own function.** Define `app.current_user_id()` that today returns `auth.uid()`, and reference *that* in every RLS policy. Swapping auth providers later becomes a one-function change instead of a schema-wide rewrite.
2. **Do not query tables directly from the browser with `supabase-js`.** Route through your own API layer (Edge Functions, or a small server). This is the difference between a two-week migration and a three-month rewrite.
3. **Keep the schema in versioned SQL migration files** — which is already being done. Preserve that discipline; it is the actual portability.
4. **Store uploaded files under a path convention that maps cleanly to S3 keys**, and keep file metadata in your own table rather than relying on Supabase Storage's metadata.

Do those four and "we might have to leave Supabase" stops being a strategic risk and becomes a scheduled weekend.

---

## 6. Non-obvious Pakistan factors

### 6.1 Can a Pakistani company get and pay for AWS/GCP?

Yes, but with real friction — and this is a genuine argument *against* AWS that has nothing to do with technology:

- **The State Bank of Pakistan imposes an annual cap (commonly cited at ~$30,000/yr per individual) on card-based cross-border transactions.** Once hit across your banking portfolio, AWS payments get rejected. — https://fightyai.com/blog/how-to-pay-for-cloud-from-pakistan.html
- Pakistani debit cards default to **international transactions disabled**; the $1 pre-auth at signup commonly fails.
- **NayaPay and SadaPay cards are frequently blocked** — hyperscalers block prepaid/virtual BINs because billing is metered post-paid.
- Fix: a proper credit card from a major Pakistani bank (HBL, Meezan, Standard Chartered) with international + recurring transactions explicitly enabled, and adequate FX headroom. A corporate account with a business FX allocation is better than a personal card.
  — https://repost.aws/knowledge-center/credit-card-declined

**This applies to Supabase, Neon, and PlanetScale too** — they all bill in USD by card. But the sums are an order of magnitude smaller, which makes the FX-cap problem far less likely to bite. A $2,000/mo AWS bill consumes the annual card cap in ~15 months; a $200/mo Supabase bill takes 12+ years.

### 6.2 Data residency / regulation

- **Pakistan has no comprehensive data protection law in force** as of mid-2026. — https://practiceguides.chambers.com/practice-guides/data-protection-privacy-2026/pakistan
- The **draft Personal Data Protection Bill** would require controller registration, 72-hour breach notification, and **data localisation for "critical" personal data** — such data could not leave Pakistan and would have to be processed on infrastructure inside the country. Civil society has consistently opposed the localisation provisions. — https://itif.org/publications/2025/05/16/pakistan-cross-border-data-transfer-regulation/
- **PECA** (amended January 2025) gives the NCCIA exclusive powers over cybercrime including unauthorized data access and disclosure (Section 38).
- The Ministry of IT has issued Pakistan's first **Cloud Policy**, which would impose confidentiality obligations on cloud providers if implemented.
- **Practical read for this business:** equipment-rental operational data (bookings, inventory, invoices) is unlikely to be classified as "critical personal data" even under the draft bill. **No provider — including AWS — offers a region inside Pakistan**, so if hard localisation ever arrives, *every* option in this report is equally non-compliant and the answer becomes a local data centre. This is therefore **not a differentiator between the options**. Monitor the bill; don't architect around it today.

### 6.3 Support quality

| Vendor | Paid support reality |
|---|---|
| Supabase | Pro (~$25/mo): email + Discord, best-effort, no SLA. Team ($599/mo): SLA-backed, faster. Enterprise: dedicated. **Discord is genuinely responsive** but is not a support contract. |
| AWS | Developer (~$29/mo, 24h response, no production SLA). **Business (~$100/mo min, 10%/7%/5% of spend, 1-hour production-down SLA)** — this is the realistic minimum for a production AWS shop. Enterprise ($15k/mo min) for a TAM. |
| Neon | Scale plan includes 99.95% SLA at no extra monthly fee — notably generous vs. peers. |
| PlanetScale | Strong engineering-led support reputation; small enough to still care. |
| Crunchy Bridge | Support staffed by actual Postgres contributors. Best-in-class if Postgres expertise is what you're buying. |

**Timezone note (PKT = UTC+5):** US-headquartered vendors are asleep during your working day. AWS Business support is genuinely 24/7; Supabase Pro is not. If a 4-hour outage during a Pakistani workday is unacceptable, that's an argument for AWS Business support or Supabase Team — not for switching platforms.

### 6.4 Regional presence

- **Supabase** offers `ap-south-1` (Mumbai), `ap-southeast-1` (Singapore), and EU regions — no Middle East region.
- **AWS** has the broadest footprint: Mumbai, UAE, Bahrain.
- **Neon / PlanetScale** run on AWS/Azure regions — check their current region list for Mumbai/Singapore availability before committing.
- **Azure** has a UAE region and is worth a look given it's what OpenAI runs on.

Given the routing caveat in §2.6, **test before assuming Mumbai is fastest from Lahore.**

---

## 7. Comparison matrix

| | Supabase | AWS RDS + custom | Aurora Svls v2 | Neon | PlanetScale PG | Cloud SQL | Hetzner self-managed |
|---|---|---|---|---|---|---|---|
| Plain Postgres (portable) | ✅ | ✅ | ⚠️ fork | ✅ | ✅ | ✅ | ✅ |
| Includes auth | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Includes file storage | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Includes realtime | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Pooler included free | ✅ Supavisor | ❌ (RDS Proxy $) | ❌ | ✅ | ✅ | ⚠️ | ❌ |
| Cost at 100 orgs | **~$25–35** | ~$155–230 | ~$120–200 | ~$20–40 | ~$50 | ~$120–200 | ~$25 + your time |
| Cost at 5,000 orgs | **~$235–435** | ~$1,360–2,430 | ~$900–1,800 | ~$300–700 | ~$300–800 | ~$1,100–2,000 | ~$150 + your time |
| Realistic ops burden | **Near zero** | High (~0.5–1 FTE) | Medium-high | Near zero | Near zero | Medium | **Very high (0.25–1 FTE)** |
| Ceiling before pain | 16XL: 64 vCPU/256 GB + replicas | Effectively unlimited | 256 ACU | 56 CU (Scale) | Very high | Very high | Your skill |
| Read replicas | ✅ Pro+ | ✅ 15 | ✅ 15 | ✅ | ✅ | ✅ | Manual |
| Superuser | ❌ (supautils subset) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `pg_stat_statements` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Slow query logs | ✅ dashboard | ✅ CloudWatch/PI | ✅ | ✅ | ✅ | ✅ | ✅ DIY |
| Suits non-technical founder | ✅✅ | ❌ | ❌ | ✅✅ | ✅✅ | ⚠️ | ❌❌ |
| Effort to migrate *off* | Medium (auth is the cost) | Low | Medium | Low | Low | Low | Low |
| Pakistan payment friction | Low | **High** (FX cap) | High | Low | Low | Medium-high | Low |

---

## 8. Recommendation

**Stay on Supabase. Do not move to AWS RDS.** Reasons, in order of weight:

1. **The scaling premise is wrong.** The workload is ~10k B2B orgs, low write volume, business-hours traffic. Evidence (OpenAI, §4.7) says that fits on a single Postgres with room to spare, at a compute tier costing low hundreds of dollars.
2. **AWS is 3–8× more expensive at every scale this business will plausibly reach, while providing less** — you'd be paying more and separately buying auth, storage, and realtime that Supabase includes.
3. **A non-technical founder cannot operate AWS**, and hiring for it pre-launch is capital spent on the wrong problem.
4. **Pakistan-specific payment friction** (SBP FX cap) makes a large USD AWS bill an operational hazard in a way a small one isn't.
5. **The decision is reversible.** Plain Postgres + SQL migrations means the exit is `pg_dump` plus an auth swap.

**Do these five things now (all cheap, all high-leverage):**
1. **Index every column referenced in an RLS policy** — especially `org_id`/`tenant_id`. Highest-value single action in this report.
2. **Rewrite RLS policies to wrap function calls in `SELECT`**: `USING (org_id = (SELECT app.current_org_id()))`. Once-per-query instead of once-per-row.
3. **Introduce `app.current_user_id()` / `app.current_org_id()` wrappers** over `auth.uid()`, and use only those in policies. This is the auth-migration insurance policy.
4. **Always connect through Supavisor (port 6543, transaction mode)**, never directly, and keep the app-side pool small.
5. **Never let the browser query tables directly** — route through your own API layer.

**Revisit this decision only when one of these is true — not before:**
- Sustained CPU >70% on a **2XL or larger** tier (i.e. you've already outgrown 8 vCPU / 32 GB)
- An enterprise customer contractually requires a specific cloud or region
- You have hired someone whose actual job is infrastructure
- Supabase support quality becomes a documented, recurring business problem (keep a log of incidents — evidence, not vibes)

**If a move ever becomes necessary, the first stop is Neon or PlanetScale Postgres, not AWS.** Both are plain Postgres, both are near-zero ops, both are dramatically cheaper than AWS, and both eliminate the "Supabase-specific" concern while keeping the founder out of the infrastructure business.

---

## 9. Sources

- https://supabase.com/docs/guides/platform/compute-and-disk — compute tiers, connection limits, disk pricing (fetched 2026-08-12)
- https://supabase.com/docs/guides/database/custom-postgres-config — what can be tuned, supautils
- https://supabase.com/blog/supavisor-postgres-connection-pooler — Supavisor architecture
- https://supabase.com/blog/supavisor-1-million — 1M connection benchmark (marketing claim)
- https://supabase.com/blog/read-replicas-vs-bigger-compute — Supabase's own scaling guidance
- https://supabase.com/docs/guides/database/connection-management
- https://status.supabase.com/ — first-party incident history
- https://statusgator.com/services/supabase — third-party incident aggregation (unverified durations)
- https://www.princenocode.com/blog/scale-supabase-production-guide — documented 5k-user failure case
- https://unicoconnect.com/blogs/is-supabase-production-ready — customer claims, compliance
- https://github.com/orgs/supabase/discussions/40583 — self-hosted feature-parity gaps
- https://www.supascale.app/blog/what-features-are-missing-in-selfhosted-supabase
- https://starterpick.com/guides/self-hosted-vs-cloud-supabase-saas-2026 — 1–2 FTE self-hosting estimate
- https://venturebeat.com/data/how-openai-is-scaling-the-postgresql-database-to-800-million-users — OpenAI single-primary Postgres
- https://blog.bytebytego.com/p/how-openai-scaled-to-800-million
- https://dev.to/ashwin_sridhar_koto7/does-postgres-rls-actually-ruin-performance-lets-look-at-the-data-24jf — RLS benchmark (73ms→2.2ms)
- https://postgres.fm/episodes/rls-vs-performance
- https://www.bytebase.com/blog/postgres-row-level-security-limitations-and-alternatives/
- https://propelius.tech/blogs/multi-tenant-database-isolation-postgresql-rls-schema/ — schema-per-tenant ceilings
- https://instances.vantage.sh/aws/rds/db.m7g.large — RDS instance pricing (conflicting figures)
- https://www.economize.cloud/resources/aws/pricing/rds/db.m7g.large/
- https://www.usage.ai/blogs/aws/rds/aurora-serverless-v2/ — ACU pricing, breakeven, Savings Plans
- https://www.jusdb.com/blog/aws-rds-vs-aurora-vs-serverless-cost-comparison
- https://repost.aws/questions/QUYZZJ0zUXQo-HMadwC9pzhw/hosting-location-near-to-pakistan
- https://repost.aws/questions/QUnLRWokxcQV-rKbf98FcZGg/significant-latency-increase-ap-south-1-mumbai-to-me-south-1-bahrain-inter-region-backbone
- https://www.cloudping.co/ , https://cloudpingtest.com/aws — measure real latency yourself
- https://www.saaspricepulse.com/tools/neon , https://selfhost.dev/blog/neon-pricing-cost-of-serverless-postgres/ — Neon pricing, cold starts
- https://planetscale.com/blog/planetscale-for-postgres-is-generally-available , https://planetscale.com/blog/50-dollar-planetscale-metal-is-ga-for-postgres
- https://www.bytebase.com/blog/how-to-migrate-from-supabase-to-aws/ , https://encore.dev/articles/migrate-supabase-to-aws , https://medium.com/@contact_62664/migrating-from-supabase-to-aws-rds-a-practical-guide-b6513d98529b — migration mechanics
- https://itif.org/publications/2025/05/16/pakistan-cross-border-data-transfer-regulation/ — Pakistan localisation draft
- https://practiceguides.chambers.com/practice-guides/data-protection-privacy-2026/pakistan — no comprehensive law in force
- https://fightyai.com/blog/how-to-pay-for-cloud-from-pakistan.html — SBP $30k FX cap, card BIN blocks
- https://repost.aws/knowledge-center/credit-card-declined

### Things I could NOT verify (stated rather than estimated)
- **Measured Lahore→AWS-region latency.** No authoritative figures found. Must be measured locally.
- **Exact current RDS us-east-1 hourly prices.** AWS pricing pages are JS-rendered; third-party aggregators conflicted ($0.168 vs $0.34/hr for db.m7g.large). All AWS cost tables are order-of-magnitude.
- **First-party Supabase postmortems for the April 2026 incidents.** Only third-party aggregator data found; severity unconfirmed.
- **Independent load benchmarks for Supabase's named customers.** Vendor marketing claims only.
