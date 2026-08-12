> Supporting research for `docs/hosting-decision.md`. Produced 2026-08-12.

# Papa Vendor — The Infrastructure Decision, Judged as a Business Decision

**Five business lenses. No technical lens — another review covers that.**
Written for a non-technical founder. Every number shows its working.

Exchange rate used throughout: **PKR 285 = USD 1**.

---

## The one-paragraph answer

Infrastructure is not a meaningful cost in this business and it is not a meaningful risk. At any customer count you can realistically reach in the next three years, hosting costs **1–5% of revenue** on every option considered. What differs between the options is not money — it is **how many weeks pass before a rental house in Lahore is paying you**, and **who wakes up at 3am when something breaks** (answer: nobody, because you have no engineer). On both of those, the managed platform wins decisively and the gap is not close. Build on Supabase, ship Phase 1, get the pilot vendor paying, and keep the database portable — which it already is. Revisit in eighteen months with revenue, customers and possibly an engineer, at which point the migration is a 1–2 day job you can afford to pay someone to do.

---

# LENS 1 — Unit economics and the pricing model

## What a Lahore rental house can actually pay

Incumbents charge **$19/user/month (Rentman) to $50/user/month (Current RMS)** ([SelectHub](https://www.selecthub.com/equipment-rental-software/rentman-vs-current-rms/)). A rental house with an owner, two desk staff and five casual prep techs is eight seats — **$152 to $400/month, or PKR 43,000 to 114,000/month**. Your own research already establishes this is a non-starter here, and reviewers confirm it even in richer markets ("Abit pricey for small business in South Africa").

A defensible flat PKR band for a Lahore house, unlimited users:

| Tier | PKR/month | USD/month |
|---|---|---|
| Small house (~200–500 assets) | 6,000–8,000 | $21–28 |
| Mid house (~800–1,500 assets) | 12,000–18,000 | $42–63 |
| Large / multi-location | 25,000–40,000 | $88–140 |

**Anchor for all modelling below: PKR 15,000/month = $53/customer/month.** This is a guess and belongs in `docs/assumptions.md` — it is the single most consequential unmodelled number in the business, more consequential than every infrastructure decision in this report combined.

## The cost driver is photos, and only photos

The database is small. Your own architecture sizes a 40,000-asset house at under 100MB. A thousand of those is 100GB of database — trivially cheap.

Condition photos are different, because they **accumulate forever and are never deleted**, while revenue per customer stays flat. That is the classic runaway-cost shape.

Per-house photo accrual, using your own spec (1600px WebP ≈ 150KB):

```
15 jobs/month × 40 items/job × 2 photos × 2 directions (out + in)
= 2,400 photos/month = ~360 MB/month
```

Round up hard for kit components, re-shoots and damage detail: **2 GB/month per house, 24 GB/year per house.** Egress (WhatsApp shares, dispute comparisons, device sync of recent photos): assume **5 GB/month per house** at steady state.

## Cost per customer, per month, by scale

Assumes end of year 2 of operation (24 months of photo accumulation) so the storage figure is honest rather than flattering.

| Customers | Photos stored | Egress/mo | **Supabase all-in** | **Supabase + Cloudflare R2 for photos** | **AWS self-managed** |
|---|---|---|---|---|---|
| 10 | 480 GB | 50 GB | $46/mo → **$4.60/cust** | $37/mo → **$3.70/cust** | ~$75/mo → **$7.50/cust** |
| 100 | 4.8 TB | 500 GB | $250/mo → **$2.50/cust** | $137/mo → **$1.37/cust** | ~$300/mo → **$3.00/cust** |
| 1,000 | 48 TB | 5 TB | $1,970/mo → **$1.97/cust** | $1,050/mo → **$1.05/cust** | ~$2,400/mo → **$2.40/cust** |
| 10,000 | 480 TB | 50 TB | $16,900/mo → **$1.69/cust** | $8,900/mo → **$0.89/cust** | ~$12,000/mo → **$1.20/cust** |

**Gross margin at the PKR 15,000 anchor: 91% at ten customers, 95% at a hundred, 96–98% thereafter.** On every option. Including the "expensive" one.

Rates used: Supabase Pro $25 base, file storage $0.0213/GB/mo, egress $0.09/GB over 250GB included, database disk $0.125/GB, compute Micro $10 → 16XL $3,730 ([Supabase pricing](https://supabase.com/pricing)). Cloudflare R2 $0.015/GB/mo storage, **$0 egress** ([Cloudflare R2 pricing 2026](https://egresscost.com/cloudflare/)). AWS RDS db.t4g.micro ≈ $11.68/mo single-AZ, ≈ $23–24/mo Multi-AZ, plus app server, load balancer, S3 at $0.023/GB and S3 egress at $0.09/GB ([AWS RDS cost breakdown 2026](https://infratally.com/articles/aws-rds-pricing-explained-2026/), [Vantage](https://instances.vantage.sh/aws/rds/db.t4g.micro)).

### Findings, ranked by how much they should move the decision

**1. Infrastructure cost is not a decision input at this stage. It is noise.** The spread between the cheapest and most expensive option at 100 customers is about **$160/month — one-third of one customer's subscription.** Any decision that trades even two weeks of founder time to save that money is a bad trade. This finding outranks everything else in this lens.

**2. Photo egress is the only line that can ever hurt you, and it is fixable in two days whenever it starts to.** At 10,000 customers, Supabase egress alone is roughly **$4,300/month** while Cloudflare R2 serves the same photos for **$0 in egress** — a 60× difference on the bandwidth line ([R2 vs S3 comparison](https://tech-insider.org/cloudflare-r2-vs-s3-vs-backblaze-b2-2026/)). This is a real difference, but note *when* it matters: it is a $9/month problem at ten customers and an $8,000/month problem at ten thousand. Moving photo storage to R2 is a change to one storage adapter — it does not touch the database, the sync engine or the app. **Do not do it now. Write it down as a trigger.**

**3. Per-seat pricing does not exist on any platform you are considering — but per-*operation* pricing does, and it would destroy this business.** Supabase charges per monthly active user only above 100,000 MAU, at $0.00325 each. Ten thousand rental houses × eight staff = 80,000 users — **still inside the included allowance, costing you zero.** AWS RDS has no user-based pricing at all. But if you had followed the instinct toward Firebase/Firestore, you would pay **per document read** — and an offline-first app that syncs a whole org's inventory to every device generates enormous read counts by design. That model would have made your flat-PKR pricing structurally unprofitable. Your architecture already rejected document stores for correctness reasons; it happens to also be the right commercial call. This is worth knowing because it is the one place the intuitive answer really is a business killer.

**4. The genuine long-run margin risk is unbounded photo retention, not the platform.** Storage cost per customer grows linearly and forever while their subscription stays flat. At 2 GB/month a customer costs $0.51/month in storage in year one and **$3.07/month in year five** — still fine. But if real usage is 5× your estimate (plausible — techs photograph liberally when it is one gesture), year-five storage is **$15/month against $53 of revenue: 28% of that customer's price, from one line item.** The fix is a policy decision, not an infrastructure one: full-resolution evidence photos retained 24 months, then downscaled to thumbnails; original retention purchasable as an add-on. Decide this before Phase 1 ships, because retro-deleting evidence is a legal and trust problem you do not want.

**5. Your pricing power is stronger than you think, and that is where the margin actually is.** You are replacing a product that costs a comparable house $152–400/month with one that costs PKR 15,000 ($53). You have room. The business's financial risk is entirely on the revenue side — whether Lahore houses pay at all, and how many exist — not the cost side.

### Revision of this lens

My first pass treated the four platforms as materially different on cost. Re-reading the numbers, that framing is wrong and I am dropping it. At every scale below ten thousand customers the entire infrastructure bill is **under 5% of revenue on every option**, and the differences between them are under 2 percentage points of gross margin. A lens that produces a 2-point margin difference should not decide anything. What survives from this lens is exactly two things: **egress-priced photo storage is the one line worth watching**, and **per-operation billing models are disqualifying**. Everything else here is arithmetic that confirms the decision does not matter financially — which is itself the most decision-relevant finding in the report.

---

# LENS 2 — Runway, opportunity cost and the cost of being early

## What "AWS RDS + custom server" actually costs in founder time

Supabase gives you, working, on day one: Postgres, user login and sessions, row-level security tied to that login, file storage with signed URLs, an auto-generated API, database backups, connection pooling, TLS, a dashboard, and a migration tool. Choosing raw AWS means **you build or assemble every one of those yourself** before you write a single line of Papa Vendor.

Honest estimate for you-plus-an-AI-assistant, in calendar weeks:

| Work item | Weeks |
|---|---|
| Networking, security groups, RDS setup, backups, restore *tested* | 1.0 |
| Application server, deployment pipeline, TLS, domains | 1.0 |
| **Authentication built from scratch** — org/user/membership, sessions, PIN auth, password reset, token refresh | 2.5 |
| Row-level security policies + a test harness proving no cross-tenant leak | 1.0 |
| File storage, signed URLs, upload flow, content-addressed paths | 0.75 |
| Monitoring, alerting, log aggregation | 0.5 |
| Secrets management, environment config | 0.25 |
| **Total before any product work begins** | **≈ 7 weeks** |

Then an ongoing tax of roughly **4–8 hours per week, forever**: OS patches, certificate renewals, disk-space watching, backup verification, dependency upgrades, security advisories. That is 200–400 hours per year — **five to ten weeks of full-time founder capacity annually** — spent on work no customer can see and no investor will value.

Your Phase 1 is scoped at 6–8 weeks. **Choosing AWS roughly doubles the time to your first working product**, and permanently taxes every week after.

Note carefully: authentication is the largest single item and the most dangerous. It is the component where a mistake means a competitor reads another rental house's customer list and fleet valuations. A non-technical founder building auth from scratch is taking on the one risk that could end the company outright, in exchange for saving about $20/month.

## What actually kills companies at your stage

CB Insights' analysis of 431 shut-down startups: **70% ran out of capital**, but that is the symptom. The underlying causes are **poor product-market fit (43%)**, **no market need (~42%)**, **bad timing (29%)**, **unsustainable unit economics (19%)** ([CB Insights](https://www.cbinsights.com/research/report/startup-failure-reasons-top/)).

"Outgrew our database" does not appear on the list. It is not on any version of this list. Companies do not die from scaling problems, because **scaling problems are problems you only get to have if customers showed up** — and by then you have revenue to solve them with, and can hire someone who has solved them before.

Your specific situation makes this sharper than usual. You have **a rental-house partner with a real working business, waiting.** That is the scarcest asset in the whole venture — a design partner who will tell you the truth about deposit norms, hold conventions, and whether the 3-day week is right in Lahore. Your own `assumptions.md` lists **fourteen guesses that can only be resolved by putting the product in front of that person.** Every week spent configuring networking is a week those fourteen assumptions stay unverified, and a week that partner's goodwill decays.

### Findings, ranked

**1. The real risk is "we never shipped," not "we outgrew our database" — by a wide margin.** Zero customers, zero revenue, no engineer, fourteen unvalidated assumptions about the market. The failure mode is that Phase 1 takes seven months instead of two, the partner loses interest, and you never learn whether Lahore houses pay. Infrastructure work is the most seductive form of this failure because it *feels* like progress and produces artefacts.

**2. Optimising for millions of users before you have one is the classic pre-launch mistake, and yes, you are about to make it.** Said plainly and kindly: the ambition is right and the sequencing is wrong. "Complete stability at millions of users" is a real engineering problem — for a company with millions of users, which has revenue, a team, and information about which parts actually broke. Trying to solve it now means guessing what will break, and you will guess wrong, because nobody predicts their own bottlenecks correctly. **The correct pre-launch stability investment is not a bigger database; it is the offline-first design you have already committed to** — which makes the warehouse keep working when the backend does not. You have already bought the stability that matters most. Buying more is buying the wrong kind.

**3. The seven weeks have a price you can name.** If Papa Vendor reaches ten paying customers at PKR 15,000, that is PKR 150,000/month. Seven weeks of delay is roughly **PKR 250,000 of revenue never collected**, permanently — plus seven weeks of competitor runway, plus the compounding cost of learning fourteen market truths two months later than you could have. Against a saving of, at most, **$20/month**. The trade is roughly **forty to one against you**, and that ignores the ongoing 4–8 hours weekly.

**4. Migration later is cheap and gets cheaper, not more expensive — which inverts the usual argument.** The instinct is "do it right now, it'll be harder later." Here the opposite holds, because your database layer is already ~99% portable plain Postgres with 226 passing assertions proving it. Moving hosts is 1–2 days. **Later you will have money to pay a contractor for those two days, and a real load profile telling you what to move to.** Today you have neither. Deferring this decision makes it *strictly better informed and strictly cheaper to execute*. That is unusual and it is the strongest argument in this report.

**5. The AI assistant does not close the gap, and may widen it.** An AI can write Terraform. It cannot be paged at 3am, cannot notice that a certificate expires in nine days, and cannot be held accountable for a misconfigured security group that exposes a database. Managed platforms remove work that *has no owner in your org*. Self-managing adds work to a founder who is also the salesperson, the product manager, and the only person who can talk to the pilot vendor.

### Revision of this lens

My first pass leaned on "managed is faster" as the argument. That is true but soft, and a determined founder can dismiss it as laziness. The harder and more defensible version is the **asymmetry of information over time**: today, choosing AWS means guessing your scaling needs with zero data and paying seven weeks for the guess. In eighteen months, the same decision costs two days and is made with real load data, real customer requirements, and possibly a real engineer. There is no scenario where deciding now beats deciding later — the cost falls and the information rises simultaneously. I have promoted that to finding #4 and demoted the speed argument, because "you'll be faster" is an opinion and "the decision gets cheaper and better-informed if you wait" is a structural fact about your situation.

---

# LENS 3 — Risk, reliability and what the customer actually experiences

## The offline-first design has already answered the reliability question

This is the most under-appreciated fact in the whole decision, and it changes the calculus completely.

Your Phase 1 scan loop reads and writes **SQLite on the phone**. Principle 1 in your own plan: *"no `await` in the scan handler, ever."* The gate pass generates from a completed local scan session. Which means, during a total backend outage at 6:00am:

| Function | Backend down |
|---|---|
| Scan gear out, continuous scan mode | ✅ works |
| Condition photos | ✅ works, queues for upload |
| Session-complete with shortfall | ✅ works |
| Gate pass / challan, truck departs | ✅ works |
| Check-in and reconciliation | ✅ works |
| Local double-checkout warning | ✅ works |
| Desk confirms a *new* booking | ❌ blocked |
| Cross-device sync (two phones agreeing) | ⏸ delayed, converges on recovery |
| WhatsApp digest, alerts | ⏸ delayed |

**The truck leaves.** That is the whole ballgame. Your customer's catastrophic scenario — the 6am truck that cannot depart — is caused by an *online-only* system, and is precisely the failure your research documents at Current RMS, where an OTP prompt locked users out "for hours at a time, causing them to lose jobs."

An outage on Papa Vendor costs the rental desk some booking-confirmation delay. An outage on an incumbent costs a rental house its morning. **You are not selling into the same risk category as your competitors, and that is a marketing asset as much as an engineering one.**

## Time-to-recovery, with no engineer

Uptime percentages are the wrong metric for you. **Time-to-recovery is the right one**, because it is where "no engineer" bites.

| Scenario | Supabase | Self-managed AWS |
|---|---|---|
| Database process crashes | Supabase's on-call fixes it. **Your TTR contribution: zero.** Typically minutes to a couple of hours. | Nobody is watching. TTR = however long until you notice, plus however long until you or an AI can diagnose Postgres. **Hours to days.** |
| Disk fills up | Auto-scaled / alerted by platform | Silent until writes fail. Then a founder debugging disk usage at 3am. |
| Certificate expires | Platform's problem | **Your problem.** Whole app down. A genuinely common cause of small-company outages. |
| Security patch needed | Applied for you | You must notice the advisory, then patch, then not break anything |
| Regional AWS failure | Affects both equally | Affects both equally |
| **Surface area you personally own** | Your application code only | OS, app server, load balancer, certificates, database, backups, networking |

The decisive point is not that Supabase fails less often. **It is that when Supabase fails, professionals who are awake and paid are already fixing it, and when your own server fails, the responder is a non-technical founder in a different timezone from the incident.** Managed hosting is not primarily a convenience purchase at your stage — it is the purchase of an on-call team you cannot otherwise afford, at roughly $25/month.

## Are SLAs worth anything?

Almost nothing, and this matters because it removes AWS's most-cited advantage.

- **Supabase**: Free, Pro and Team have **no uptime SLA**; the 99.9% commitment is Enterprise-only ([Supabase SLA](https://supabase.com/sla), [DevHelm analysis](https://devhelm.io/sla/supabase)). At $25/month you have no SLA.
- **AWS RDS**: 99.95% Multi-AZ, 99.5% single-AZ — but remedies are **service credits only**, capped at a percentage of that service's monthly charge.

Run the numbers on the credit. If AWS breaches its SLA and you are billed $50/month, your compensation for a full day of downtime is roughly **$5–12 in credit against next month's bill**. Your customer lost a shoot day worth PKR 200,000. **An SLA is not insurance. It never pays for the damage.** It is a signal of vendor confidence and nothing more, and neither platform gives you a meaningful one at prices you can afford. **Anyone arguing "AWS because SLA" has not read what the SLA pays.**

## The reputational cost of one bad morning in Lahore

Real and asymmetric. Your research shows the market is small and concentrated — a handful of houses in Lahore, all of whom know each other, all of whom talk. Your entire go-to-market depends on the two stories travelling ("We got paid for the battery plate" / "I sent him the photo"). **A third story — "their app died and our truck was two hours late" — travels faster and further than both, and it does not decay.** In a market this size, one bad morning could plausibly cost you 20–30% of your addressable pipeline.

But note where that risk actually lives. It is **not** in the database platform. It is in: the scan loop being slow, the sync engine losing an event, the app crashing on a Rs 25,000 Android, the outbox corrupting, the photo cache filling. **Every one of those is your own code, on the phone, and none of them is affected by whether the database is hosted by Supabase or by you.** Money spent on database redundancy is money not spent on the 30-minute thermal-throttling test on real hardware — and the second one is where your reputational risk genuinely sits.

### Findings, ranked

**1. Offline-first has already bought you the reliability that matters, and further backend redundancy buys very little.** The truck leaves during an outage. Recognise this as a completed purchase and stop paying for it again.
**2. Time-to-recovery, not uptime, is your metric — and it is the one place the platforms differ enormously.** Managed = someone competent is already awake. Self-managed = the responder is you, and you cannot fix Postgres.
**3. SLAs at your price point are worthless on both platforms.** Remove this from the argument entirely.
**4. Your real reliability risk is in the mobile app, not the backend.** Spend the engineering attention there — the on-real-hardware tests already in your verification plan are worth more than any hosting choice.
**5. Self-managing multiplies the number of things that can break by roughly six**, and every one of them has the same responder: a non-technical founder.

### Revision of this lens

My first pass compared uptime percentages, which I now think is close to useless — the difference between 99.9% and 99.95% is about 21 minutes a month, and for an offline-first warehouse app those 21 minutes are almost entirely invisible to the customer. I have dropped that comparison. I also initially under-weighted the point that **the reputational risk sits in the phone app, not the backend.** That belongs higher than it first appeared, because it redirects the founder's anxiety from a decision that does not matter to one that does. Conversely I have promoted the "who responds at 3am" asymmetry to the top, because it is the only reliability difference between the options that a customer would ever actually feel.

---

# LENS 4 — Fundraising, due diligence, enterprise sales, acquisition

## Do investors care?

**At pre-seed and seed: no. Not at all.** Investors at your stage diligence the founder, the market, the design partner, and whatever traction exists. Nobody at a pre-revenue B2B SaaS pitch has ever asked which company hosts the Postgres. If it comes up, it comes up as a *positive* — "you shipped in eight weeks with no engineer" is a competence signal.

**At Series A and beyond: they care about two things**, and they are the same two things regardless of platform:

1. **Can you get your data out?** Yours is plain Postgres, ~99% portable, `pg_dump` and go, with 226 passing assertions proving the layer is sound. This is a complete answer.
2. **Is there any single-vendor dependency that could kill the company?** Supabase is **open source and self-hostable.** If Supabase raised prices tenfold or shut down tomorrow, you run the same software yourself. That is a stronger answer than most AWS-native companies can give, because AWS-native companies are usually far *more* locked in — to proprietary services with no open-source equivalent.

**The line you can repeat to an investor, verbatim:**

> *"We're on standard Postgres, hosted by Supabase. It's plain SQL with no proprietary extensions — we've tested that. Migrating to any other Postgres host, including our own AWS, is a one-to-two-day job whenever the numbers justify it. We chose the option that got a product in front of paying rental houses in eight weeks instead of sixteen, and we'll spend the two days when a customer's requirement or our own bill makes it worth it."*

That is a strong answer. It shows you understood the trade-off and made it deliberately, which is what the question is actually testing.

## Enterprise sales and compliance — the counterintuitive finding

If you eventually sell to large studios, broadcasters, or Western production companies, they will ask for **SOC 2 Type 2** and possibly **ISO 27001**.

Here is the part that inverts the popular assumption. **Supabase holds SOC 2 Type 2 and ISO 27001 today** ([Supabase SOC 2 docs](https://supabase.com/docs/guides/security/soc-2-compliance), [Supabase security](https://supabase.com/security)). AWS also holds these — but **AWS's certification covers AWS's data centres, not your application.** In both cases *you* still need your own audit. The difference is **scope**: on Supabase your auditor's questions about database access controls, encryption at rest, backup procedures and infrastructure change management are answered by inheriting a certified provider's controls. On self-managed AWS, **every one of those becomes your own control that you must document, implement and evidence** — as a non-technical founder.

Your own SOC 2 Type 2 audit costs roughly **$15,000–40,000 and 3–6 months** either way. **Building on Supabase shortens that project; building on raw AWS lengthens it.** So the "AWS looks more serious to enterprise buyers" instinct is not just neutral — it is **backwards on the specific thing enterprise buyers actually check.**

One caveat with a price on it: the SOC 2 Type 2 *report* is available to **Team ($599/month) and Enterprise** customers. So the first enterprise customer who demands the report costs you an upgrade from $25 to $599/month. **That is a real number, but it is triggered by a customer who is by definition paying you enough to cover it** — and it is far cheaper than a $30,000 audit you'd need anyway.

## Is "we're on Supabase" ever a genuine objection?

In practice, essentially never, for two reasons. Supabase is Postgres — the most boring, most auditable, most widely-understood database in enterprise software. And a buyer's security questionnaire asks about *certifications, encryption, access control and breach notification*, all of which Supabase answers. Where objections do genuinely arise, they are about **data residency** (covered in Lens 5), not about the vendor's name.

The one place it could surface is acquisition by a large acquirer with a mandated cloud. That is a post-Series-B concern, it is a two-day migration, and no acquisition has ever failed over a Postgres host.

## AWS Activate credits — do they change the calculus?

No, and it is worth showing why, because credits are the most common reason founders make this mistake.

As an unfunded, unaffiliated founder you qualify for **AWS Activate Founders: $1,000 in credits plus $350 support credits** (some sources cite $5,000; treat $1,000 as the reliable figure). Larger packages of $5,000–$100,000 require **affiliation with a partner VC or accelerator**, which you do not have ([AWS Activate 2026 guide](https://cloudkompas.com/blog/aws-activate-complete-guide-2026), [Northflank](https://northflank.com/blog/how-to-get-free-aws-credits-for-your-startup)).

So the credit is worth **$1,000, once**. Your infrastructure bill on the managed path is about **$25–46/month**, meaning the credit covers roughly **two years of a bill you can already afford.** Against that, the seven weeks of founder time from Lens 2 is worth an estimated PKR 250,000+ in delayed revenue. **The credits are worth about one-quarter of the cost of accepting them.**

Two further warnings. Credits **expire** — typically 12–24 months — creating a cliff where a founder who architected for "free" suddenly faces a real bill and a migration under pressure. And credits create a **behavioural trap**: knowing you have $1,000 to spend encourages using more AWS services, deepening the lock-in that Lens 4 says investors actually ask about. **Take the credits if you like — apply them to something else, like S3 backups. Do not let them choose your platform.**

If you later join an accelerator, the $5,000–100,000 tier becomes available and the arithmetic changes materially. **That is a trigger, and it is on the list at the end.**

## Does Papa Rentals marketplace integration change anything?

Not the hosting decision. Both sides are Postgres; integration is a schema and API question, already handled by the `global_product_id` decision in your plan.

Two small points in the managed platform's favour, though. The **no-login client status link** and the **public tag resolver** — both Phase 2 items, both explicitly identified as viral acquisition channels — are cheap on Supabase (edge functions plus anonymous row-level security policies) and are meaningful build items on raw AWS. And when the marketplace does connect, it will need to read availability across many vendor orgs; row-level security you have already built and tested with pgTAP is the mechanism, and it exists on the managed path from day one.

### Findings, ranked

**1. No investor at your stage will ask, and if they do, "portable Postgres, two-day migration" is a complete and impressive answer.** Do not optimise for a diligence conversation that is three years and two funding rounds away.
**2. Supabase's SOC 2 Type 2 and ISO 27001 make enterprise sales *easier*, not harder — the popular intuition is backwards.** This is the single most surprising finding in this lens.
**3. AWS Activate credits are worth ~$1,000 and cost you ~PKR 250,000 in delayed revenue to collect.** Reject the credit as a decision input; revisit only if an accelerator unlocks the six-figure tier.
**4. Budget $599/month for Supabase Team the day a customer's procurement team demands the SOC 2 report.** Not before. That customer pays for it many times over.
**5. Open-source self-hostability is a genuine anti-lock-in argument that raw AWS cannot match.** Most AWS-native startups are *more* vendor-locked, not less.

### Revision of this lens

My first pass treated compliance as a wash between the platforms. That was wrong and I have corrected it — the **audit-scope difference is a genuine, material advantage for the managed platform**, and it points in the opposite direction to what the founder has been told, which makes it the most useful thing in this section. I have also hardened the credits analysis: my first pass called them "not a big factor," which is too soft. They are actively a trap, because the mechanism by which they cause harm (architecting for a subsidised bill, then facing a cliff and a lock-in) is well documented and specifically dangerous for a founder who cannot execute a migration himself. Finally I removed a speculative point about acquirers preferring AWS-native stacks — I could not evidence it, and it is almost certainly false at the scale of any acquisition Papa Vendor would plausibly see.

---

# LENS 5 — Strategic optionality and the Pakistan/global split

## Latency: a non-issue, with one political footnote

Both Supabase and AWS offer **Mumbai (ap-south-1)** and **Singapore (ap-southeast-1)**. Lahore→Mumbai is roughly 40–60ms; Lahore→Singapore roughly 80–100ms. **Neither matters**, because your architecture's first principle is that the scan loop never touches the network. Latency affects only desk-console page loads, where 60ms versus 100ms is imperceptible.

**The footnote is not technical and it is worth raising because nobody else will:** hosting Pakistani rental houses' customer records, CNIC images and fleet valuations in **Mumbai** may draw an objection from a Pakistani customer, and would be an awkward line in any future government or defence-adjacent contract. India–Pakistan data hosting is a live sensitivity, not a hypothetical one. **Singapore is the diplomatically neutral choice at a cost of ~40ms that your architecture cannot feel.** Both platforms support it equally, so this is not a platform decision — but **it is a region decision you should make deliberately, in Phase 0, and it is currently unmade in your plan.** Changing region later means recreating the project and migrating data.

## Data residency and Pakistani law

As of 2026, Pakistan **has no enacted comprehensive data protection law.** Successive drafts of the Personal Data Protection Bill have failed to pass ([ICLG Pakistan 2026](https://iclg.com/practice-areas/data-protection-laws-and-regulations/pakistan/), [Mondaq](https://www.mondaq.com/privacy-protection/1716564/why-pakistan-is-stalling-on-data-protection-a-nations-digital-dilema)). PECA governs cybercrime and applies to your CNIC handling — which your architecture already addresses by excluding `cnic`/`ntn` columns from scanner sync.

**The forward risk:** the draft bill contains **data localisation provisions** requiring sensitive and "critical" personal data to be stored on domestic servers, and the PTA already enforces localisation on telecom operators under CTDISR-2025. If a version of that bill passes and CNIC images are classified sensitive, **you would need Pakistani hosting**, which neither Supabase nor AWS offers as a managed region.

**Here the open-source platform wins outright, and it is the strongest single optionality argument in this report.** Supabase can be **self-hosted on any server, including one in a Pakistani data centre.** Your escape route from a localisation law is to run the same software you already run, on a box in Karachi. On managed AWS you would be rebuilding on a Pakistani provider from scratch. This is a low-probability, high-impact regulatory risk, and the managed open-source option is the only one of the four that has a cheap answer to it.

## Payment friction — genuinely underrated, and it favours predictable pricing

This is the Pakistan-specific risk most likely to cause you actual operational pain, and it is barely discussed in infrastructure comparisons.

Both AWS and Supabase bill in USD and require an international card. From Pakistan that means: SBP restrictions on retaining foreign currency (freelancers may hold only ~50% of foreign income in dollar accounts), **withholding tax on international card transactions used for software subscriptions like AWS, Google Cloud and Adobe** ([HisaabKar 2026](https://hisaabkar.pk/guides/international-credit-card-tax-pakistan-2026/), [Digital Pakistan](https://digitalpakistan.pk/pakistan-freelance-economy/)), low international limits on PKR-denominated debit cards, and declines that are common enough to be routine.

Both platforms share this problem. **But the shape of the bill differs, and the difference matters:**

- **Supabase is one predictable line: $25.** A card with a $100 monthly international limit clears it every month, indefinitely.
- **AWS is a variable, multi-service invoice that can spike** — a misconfigured backup, an unexpected egress month, a runaway log group. A spike that exceeds your card limit means a **failed payment, which on AWS can lead to account suspension** — and account suspension means your customers' rental houses stop syncing.

**A predictable $25 charge is materially more robust on a fragile payment rail than a variable $60 charge that could be $200.** That is a genuine Pakistan-specific argument for the managed platform that has nothing to do with technology.

**Practical action either way:** open a Payoneer or Wise USD card now, before Phase 0, and set a hard billing alert. Do not discover your payment rail is broken on the day a customer is onboarding.

## Vendor risk

Real, and worth naming honestly rather than dismissing.

- **Supabase could be acquired or raise prices.** Precedent exists in this exact category: **Neon was acquired by Databricks in 2025.** Vendor risk in the managed-Postgres space is not theoretical.
- **Your insurance is threefold and unusually strong:** it is plain Postgres (portable), the platform is open source (self-hostable), and your database layer is already proven ~99% portable with a 1–2 day migration cost. **You have already bought the insurance.** That is precisely why you are free to make the cheap, fast choice now.
- **AWS carries its own vendor risk** in the form of price increases and the fact that self-managed infrastructure is *harder* to leave, not easier — you would be migrating a live production system you do not fully understand, rather than a portable database you do.

## Gulf and Western expansion

Supabase offers Frankfurt, London, US East/West, Singapore and Sydney. Expansion means either creating a regional project per market or accepting cross-region latency — and **an offline-first app tolerates cross-region latency far better than any conventional SaaS**, because the physical work never waits on the network. A Dubai rental house on a Singapore database would have a perfectly usable scanner and a slightly slower desk console. **Your architecture has made geographic expansion cheap. That is another purchase already made.**

### Findings, ranked

**1. Choose your region deliberately in Phase 0, and choose Singapore over Mumbai.** Not for latency — for the India–Pakistan data-hosting sensitivity, which is real, which no vendor will raise with you, and which is expensive to change later. This is the only *urgent* action item in this lens.
**2. Open-source self-hostability is your only real answer to a future Pakistani data-localisation law.** Low probability, high impact, and only one option covers it.
**3. Payment friction favours predictable flat pricing, and this is a Pakistan-specific argument nobody makes.** A variable AWS bill on a constrained Pakistani card is an operational risk to your customers' service, not just your accounting.
**4. Vendor risk is real (see Neon/Databricks) and you have already insured against it** through portable Postgres plus an open-source platform. Say this out loud when someone raises lock-in.
**5. Offline-first has made global expansion a non-event.** Latency tolerance is a strategic asset you built for the warehouse and get to reuse for geography.

### Revision of this lens

My first pass framed latency as a meaningful comparison point. It is not — for this architecture it is close to irrelevant, and I have replaced it with the **region-politics** point, which is genuinely actionable and time-sensitive in a way latency is not. I also initially listed payment friction as an equal problem for both platforms; on reflection that is wrong, because **bill variance interacts with card limits** in a way that makes the two materially different in practice. I dropped a point about needing multi-region architecture for global expansion — offline-first defuses it, and including it would have manufactured a problem the design has already solved.

---

# RECOMMENDATION

## In business terms

**Build on Supabase. Ship Phase 1. Get the pilot vendor paying. Do not touch this decision again until one of the triggers below fires.**

The reasoning, in the form you can repeat to an investor or to yourself when you doubt it:

> **Infrastructure is 2–4% of our revenue at every scale we can model, on every option we considered. So we optimised the decision for the things that actually kill companies at our stage: time to first paying customer, and having no engineer on call. Supabase gives us login, security, file storage and a managed database on day one — about seven weeks of work we'd otherwise do before writing any product. It's plain Postgres with no proprietary extensions; we've tested that our data layer is portable and moving hosts is a one-to-two-day job. We'll spend those two days when a real customer requirement or a real bill justifies it, not before. And because Supabase is open source, if it ever disappears or a data-localisation law lands, we run the same software ourselves.**

Three supporting points worth memorising:

1. **The reliability you needed, you already built.** The app is offline-first — the truck leaves at 6am whether the backend is up or not. That is your differentiator against Rentman and Current RMS, and it means backend redundancy is not where your reliability budget belongs.
2. **Supabase's SOC 2 Type 2 and ISO 27001 make enterprise sales easier, not harder.** Building on raw AWS would *expand* the scope of your own future audit, not shrink it.
3. **"Supabase doesn't scale" is a misunderstanding, and the specific version of it does not apply to you.** Supabase is Postgres on real hardware, up to 64 vCPU and 256GB RAM — a machine that serves far more than ten thousand rental houses. The three genuine complaints people have are: connection limits with serverless functions (you have a mobile app with a connection pooler — not applicable), the Realtime service under load (**your plan already cut Realtime**), and the auto-generated API under heavy write load (**your plan already routes every write through stored procedures**). Your architecture independently designed around all three known weak points before you asked this question. That is not luck; it is because those weak points come from using Supabase as a backend-in-a-box, and you are not doing that.

## Cost model across the growth stages

Two-year steady state, PKR 15,000 ($53) per customer per month.

| Stage | Customers | Revenue/mo | Recommended setup | Infra/mo | Infra as % of revenue | Gross margin |
|---|---|---|---|---|---|---|
| **Pre-launch** | 0 | $0 | Supabase Free → Pro | **$0–25** | — | — |
| **Pilot** | 1–10 | $53–530 | Supabase Pro, Micro compute | **$25–46** | 9% | **91%** |
| **Early traction** | 100 | $5,300 | Supabase Pro, Small/Medium compute, PITR add-on | **$150–250** | 4% | **96%** |
| **Scaling** | 1,000 | $53,000 | Supabase Pro/Team, Large compute, read replica, **photos on Cloudflare R2** | **$1,050–1,400** | 2.5% | **97.5%** |
| **Scale** | 10,000 | $530,000 | Supabase Team/Enterprise or self-managed, R2, sharded by region | **$8,900–17,000** | 1.7–3% | **97%+** |

Note the shape: **infrastructure as a share of revenue falls as you grow.** There is no scale at which this cost structure becomes a problem, on any option. The only line that ever needs managing is photo egress, and it has a two-day fix.

## Decision triggers — the specific events that should change the platform

Not dates. Not feelings. **Events.** Write these somewhere you will see them.

| # | Trigger | Action | Est. cost |
|---|---|---|---|
| 1 | **Photo storage + egress exceeds 10% of any customer's monthly fee** (≈$5.30/customer) | Move photo storage to Cloudflare R2. Zero egress fees. **Not a platform change.** | 2 days |
| 2 | **Total monthly infra bill crosses $400 while under 50 customers** | Investigate — something is misconfigured. **Do not migrate; diagnose.** | 1 day |
| 3 | **A customer's procurement demands the SOC 2 Type 2 report** | Upgrade to Supabase Team ($599/mo). That customer's contract pays for it. | Same day |
| 4 | **A customer contractually requires data stored inside Pakistan** | Self-host Supabase on a Pakistani provider. Same software. | 1–2 weeks |
| 5 | **Aggregate device working set exceeds ~200MB, or org count exceeds ~50** | Revisit the *sync engine* (PowerSync swap, already designed for). **Not the host.** | Already planned |
| 6 | **Photo retention passes 24 months for the first cohort** | Enforce the downscale-after-24-months policy. Decide the policy *before* Phase 1 ships. | 3 days |
| 7 | **You join an accelerator or raise a round unlocking AWS Activate Portfolio ($5k–100k)** | *Then* re-run this analysis. Six figures of credits genuinely changes the arithmetic; $1,000 does not. | Re-evaluate |
| 8 | **ALL THREE at once:** >100 paying customers **AND** a full-time engineer on the team **AND** infra >15% of revenue | Evaluate self-managed AWS seriously. **Two out of three is not enough.** | 2–4 weeks |
| 9 | **Three or more Supabase incidents in a quarter that a customer actually noticed** | Escalate to Supabase, then evaluate. **Log every incident from day one** so this trigger is measurable rather than emotional. | Measure first |

**Do this in Phase 0, before anything else:** choose **Singapore (ap-southeast-1)**, not Mumbai. Region is expensive to change and the India–Pakistan hosting sensitivity is real.

## The honest answer to "should I use AWS RDS + a custom server?"

**No. Not now. Not for this business at this stage. And the reasons are business reasons, not technical ones.**

Google's suggestion isn't stupid — it's the standard answer for a company with an engineering team, which is exactly what you don't have. Here is what it would actually cost you:

**In money:** roughly **$75/month** at the pilot stage against $25–46 on the managed path. **It is not cheaper. It is about 60% more expensive**, because you pay for a database *and* an application server *and* a load balancer, where the managed platform bundles them.

**In time:** approximately **seven weeks before you write a single line of Papa Vendor** — over half of it building authentication, the one component where a mistake could end the company by leaking one rental house's data to another. Then **4–8 hours every week, forever** — five to ten weeks of your capacity per year, on work no customer sees.

**In risk:** you become the on-call engineer for six systems instead of one, in a business where the responder to a 3am incident is a non-technical founder. The AI assistant can write the configuration; it cannot be paged.

**And here is what it buys you: nothing you can use.** Not lower cost (it's higher). Not better uptime (SLAs pay in credits worth $5–12, and your app works offline anyway). Not investor credibility (they don't ask, and portable Postgres is the better answer when they do). Not enterprise credibility (it *expands* your SOC 2 audit scope rather than shrinking it). Not scale headroom (Supabase runs Postgres on hardware up to 64 vCPU and 256GB RAM, and your architecture already avoids all three of Supabase's genuine weak points). The only thing it genuinely buys is **control at a scale you are years and thousands of customers away from** — and that control is purchasable later for **one to two days of contractor time**, because your database layer is already portable and proven.

Put it as a trade: **you would be spending seven weeks and about PKR 250,000 of delayed revenue, plus a permanent weekly tax, to solve a problem you do not have, using money you do not have, at a stage where 43% of companies die from not finding product-market fit and approximately zero die from database hosting.**

You asked for the truth and for complete stability at millions of users. The truth is that **stability at millions of users is bought by companies that have millions of users, with revenue, from engineers who have watched their own system break.** You cannot buy it in advance, and every attempt to do so trades a certain cost today against a speculative benefit years away. The stability you *can* buy today, you already have: an offline-first design where the warehouse keeps working when everything else stops. That is worth more to a Lahore rental house at 6am than any database architecture, and it is the thing your competitors do not have.

**Build the product. Get the pilot vendor paying. Come back to this question in eighteen months, when it will be cheaper to answer and you will finally have the data to answer it correctly.**
