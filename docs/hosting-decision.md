# Infrastructure decision — hosting Papa Vendor for real

> The product plan lives in the repo at `docs/PLAN.md`. This file is the answer
> to one question: **what do we run this on, and does it survive success?**

## Context

You'd heard Supabase doesn't scale, that debugging it is a mess, and that Google
suggests AWS RDS + a custom server. You want complete stability at scale, and
you're building a business, not a hobby.

Three of your constraints decide this more than any technical argument:

1. **Operators: you and me. No engineer. Nobody to page at 3am.**
2. **Ambition: global.**
3. **Budget: under $50/month, pre-revenue, zero customers today.**

I ran deep research plus ten analytical passes — five technical, five business.
They converged, including on things I had wrong.

---

## The short answer

**Stay on Postgres. Start on Supabase. Do not build AWS RDS + a custom server.**

And the reason isn't loyalty to Supabase — it's that **the database was never
the risk.** Two other costs are 10–20× bigger and neither of us was looking at
them. More on those below, because they're the real finding here.

---

## 1. The premise, tested

**"Supabase doesn't scale" is mostly folklore.** Supabase *is* Postgres, plus
open-source tools around it. The question "does Postgres scale" has a public
answer:

> **OpenAI runs ChatGPT for ~800 million users on a single, unsharded PostgreSQL
> primary** — one writer, ~50 read replicas, millions of queries per second.
> Stated publicly at PGConf.Dev 2025.

Ten thousand rental houses is roughly **five orders of magnitude** smaller. One
Postgres instance covers the entire realistic life of this company.

The horror stories decompose into missing indexes, not using the connection
pooler, and an undersized tier — **identical failures happen on AWS.** They're
operator errors that got blamed on the platform.

**Two criticisms are genuinely real, and neither binds us:**

| Criticism | Real? | Does it bind us? |
|---|---|---|
| Connection limits under load | **Yes** — the classic wall | **No.** Our sync is stateless HTTP cursor-pull with no long-lived connections. Designed out before it was built. |
| "No control / can't tune" | **Partly** — no superuser | **No.** We use *one* extension (`pgcrypto`), and UUIDv7 is hand-written plpgsql precisely to avoid extension dependencies. We already run as a `NOSUPERUSER NOBYPASSRLS` role by choice. |
| "Debugging is a mess" | For a *different app shape* | That complaint is from people debugging `supabase-js` + RLS in a browser, where failures return an empty array and no error. **We have no SDK and zero dependencies in the core**, and 2,533 lines of SQL tested against stock Postgres in CI. |
| Outages | **Yes, real** | us-east-2 was down 3h42m on 12 Feb 2026. Mitigated by offline-first: **the truck still leaves.** |

Notably, your architecture already dodged all three of Supabase's genuine weak
points independently — we cut Realtime, we route all writes through RPCs, and
the scanner holds no database connection.

---

## 2. What AWS RDS + custom server would actually cost you

Steelmanned first, because the instinct behind it is sound: total control of
tuning, Performance Insights, and **PITR backups included rather than a $100/mo
add-on.** That last one is a genuine point in its favour.

**And still: not defensible here.**

- **More expensive, not less.** ~$80–100/month before auth, storage or scheduled
  jobs exist — over your budget on day one, for *less* functionality. Supabase
  Pro is $25 and includes auth, storage, a pooler and cron.
- **~7 weeks of work before writing a line of Papa Vendor code**, ~2.5 of those
  on authentication alone — the one component where a mistake leaks one rental
  house's data to another.
- **Then 4–8 hours every week, forever.** Who notices the disk is full at 2am?
  Every AWS advantage is a *tuning* advantage, and there's nobody to tune. Our
  hot path already measures **0.08ms**.
- **It expands your compliance burden.** Counter-intuitively, Supabase's SOC 2
  Type 2 and ISO 27001 make enterprise sales *easier*; building on raw AWS makes
  those audits your problem.
- **Pakistan-specific:** the State Bank caps cross-border card spend at roughly
  $30k/year. A $2k/month AWS bill burns that in ~15 months. A $200/month bill
  takes over a decade. A predictable charge is also far less likely to fail on a
  Pakistani card and suspend your account.

Google recommended it because it's the generic answer **for a team that has an
SRE.** You don't.

---

## 3. The three costs nobody was looking at — the actual finding

This is why the exercise was worth doing. **We have been worrying about the
wrong number by a factor of twenty.**

### SMS is the budget crisis, not the database

Twilio charges roughly **$0.47 per SMS segment to Pakistan.** At 100 customers
with 5 staff each logging in twice a month, that's **~$473/month — nineteen
times your entire infrastructure budget.**

The fix is already in the design and just needs holding to: **OTP at enrolment
only**, then a long-lived device session plus a per-user PIN. That converts a
recurring per-login cost into a one-time per-staff cost — about **$2 lifetime**
via a local Jazz/Telenor aggregator. Use **WhatsApp as the primary channel**,
which is where Pakistani business already happens.

### Photos are the only line that can ever hurt

Condition photos accumulate forever while revenue per customer stays flat —
the classic runaway shape. Roughly **2 GB/month per rental house.**

**Use Cloudflare R2 for photos, not Supabase Storage.** R2 charges **$0 egress**
vs $0.09/GB. Today that's a $9/month difference. At 10,000 customers it's
**~$8,000/month.** It costs nothing to get right now and is painful to re-key
later.

Also: **decide a photo retention policy before Phase 1 ships** (downscale after
24 months). Unbounded retention is the real long-run cost risk.

### PITR is $100/month, not "a few hours"

My own `production-readiness.md` listed backups as *"Hours, once hosted."* On
Supabase, point-in-time recovery is **$100/month — four times your infra
budget.** Correcting that below.

---

## 4. Recommendation and staged path

**Supabase Pro, ~$25/month, region: Singapore (`ap-southeast-1`).**

> **Singapore, not Mumbai.** My technical pass said Mumbai for latency; the
> business pass said Singapore for the India–Pakistan data-hosting sensitivity.
> **The business argument wins** — the app is offline-first, so latency barely
> matters, and region is expensive to change later. Flagging the disagreement
> because you should know it was a judgement call, not a unanimous one.

| Stage | What runs | Cost | Trigger to move on |
|---|---|---|---|
| **0 customers** (now) | Supabase Pro Micro · R2 for photos · Sentry + UptimeRobot free · nightly event-log export · **one rehearsed restore drill** | **~$30** | First paying customer |
| **~100 orgs** | Compute → Small · PITR on · cron heartbeat · concurrent-write load test | ~$150 | `scan_events` > 50M rows |
| **~1,000 orgs** | Medium/Large · **partition `scan_events` monthly — don't be late** · first read replica · hire an engineer | ~$400–800 | p99 reads > 200ms |
| **~10,000 orgs** | Large/XL + read replicas. **Still one primary.** | $2–5k | Bill exceeds the cost of an SRE |

Gross margin at PKR 15,000/customer is **91% at ten customers, 96–98%
thereafter — on every option modelled.** Infrastructure is 1.7–4% of revenue
regardless of what we choose, which is precisely why cost shouldn't decide it.

**Migrate only when all three are true at once:** >100 paying customers **and** a
full-time engineer **and** infra >15% of revenue. Two out of three is not enough.

---

## 5. What this changes in the work

Actions, in order:

1. **Correct `docs/production-readiness.md`** — PITR is $100/mo not "hours";
   add SMS and photo-storage cost lines, which are absent entirely; downgrade
   the watermark-serialisation concern (over-weighted — a real org does <5
   writes/sec against a ~2,000/sec ceiling); drop the `change_seq` concern
   (effectively never binds).
2. **Add an RLS optimisation now** — wrap policy function calls as
   `USING (org_id = (SELECT current_org_id()))` so they evaluate **once per
   query instead of once per row**. Benchmarks show 73ms → 2.2ms on this
   pattern. Cheap, and it compounds at scale.
3. **Rename `supabase/` → `db/`.** The directory name is the single biggest
   lock-in risk in the repo — someone will eventually assume it implies a
   dependency and add one. Update `package.json` and the CI workflow.
4. **Write the portability rules into `CONTRIBUTING.md`** (below) so they're
   enforced rather than remembered.
5. **Update `docs/architecture.md`**, which still recommends PowerSync and
   `supabase-js`. The built code has already diverged toward portability; the
   doc shouldn't invite anyone to undo that.
6. **Install the `llm-council` skill** you asked for — see note at the end.

Then resume the readiness list: Supabase project → auth → device encryption.

---

## 6. The rules that keep this reversible

The audit found the codebase is **~99% portable** — moving to RDS, Aurora, Neon
or Cloud SQL is **1–2 days of work.** That's not luck; it was designed for. It
stays true only if these hold:

- **Never write a foreign key from `users.id` to `auth.users.id`.**
- **Never let a vendor SDK become the data layer.** No `supabase-js` for queries.
- **Never call `auth.uid()` in a policy or function.** Read identity only from
  `current_setting()` with the `papa.*` fallback that all 226 tests already use.
- **CI stays on stock `postgres:16`.** A test that needs Supabase is a failing
  build. This is a continuous portability regression test and it's the most
  valuable thing protecting the decision.
- Store opaque storage keys, never vendor-signed URLs. Keep `pg_cron` bodies to
  a single `SELECT`. No new extensions without a written decision.

> **The one-way door:** letting the identity model live in the vendor. Do that
> and migration stops being a data move and becomes re-authenticating every user
> and every device in the field — on offline phones, in warehouses. Nothing else
> comes close.

## Verification

- `npm run test:all` stays green — typecheck, 120 JS tests, the Vite build, all
  migrations and 226 pgTAP assertions **against stock Postgres**, in CI. That is
  the portability proof, and it must keep passing after the rename.
- Re-run the 200-org / 400k-asset load seed after the RLS change and confirm the
  hot paths hold (tag lookup 0.08ms, caught-up poll 0.09ms).
- Do **one rehearsed restore drill** before any customer data exists, and write
  down the steps. "We have backups" is worthless until someone has restored one.

## Supporting research

- [`research/platform-options.md`](research/platform-options.md) — Supabase vs
  RDS vs Aurora vs Neon vs the rest, with pricing and sources
- [`research/technical-lenses.md`](research/technical-lenses.md) — five
  technical lenses
- [`research/business-lenses.md`](research/business-lenses.md) — five business
  lenses, unit economics, decision triggers
