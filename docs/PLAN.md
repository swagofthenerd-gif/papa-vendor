# Papa Vendor — Rental House Operations Platform

## Context

Papa Rentals is a filmmaker gear + location rental marketplace (React + Vite, simulated backend, Lahore/PKR). It has a renter side and a thin host dashboard, but no real vendor operations: no inventory quantity, no listing edit, no calendar, no check-out/check-in, no staff, no real data.

**Papa Vendor** is the standalone operational app for those vendors — film equipment rental houses. Every physical item carries a QR tag; staff scan gear in and out; inventory stays live and accurate; and around that loop sits everything a rental house runs on: bookings and holds, prep and pull lists, condition and damage evidence, maintenance, pricing, invoicing, staff roles, sub-rentals, analytics.

It ships standalone. It is designed so Papa Rentals can later plug in as a demand channel, without that integration forcing decisions now.

### How this plan was built

Sourced domain research (rental-house pain points, incumbent software reviews, Pakistan market data) → a full technical architecture → **two adversarial reviewers, five lenses each, every lens revised** — one attacking the data model, sync correctness and failure modes, one attacking IA, scan UX, design, adoption and scope. This plan is the synthesis; it differs substantially from the first architecture, and the differences are the point.

Supporting documents to carry into the repo as `docs/`:
- **Research** — `~/.claude/plans/ok-i-am-making-valiant-fern-agent-a1c21978a8576dd4d.md` → `docs/research-pain-points.md`
- **Architecture** — `/tmp/claude-1000/-home-shaharyar/ce1d574d-c51f-41c5-b557-048dac34dd81/scratchpad/arch.md` → `docs/architecture.md` (the schema DDL, sync design and conflict enumeration live there in full; this plan records what overrides it)

### Confirmed decisions

| Decision | Choice |
|---|---|
| Backend | Real, multi-user, multi-device — not a simulation |
| Tenancy | Multi-tenant from day one |
| Offline | Offline-first, hard requirement — the scan loop never touches the network |
| Surfaces | Mobile scanner (warehouse) + desk console, one codebase |
| Repo | New sibling repo, shared design-token package |
| Language | English + Urdu, icon-led scanner |
| WhatsApp | Core to phase 1 — it is the client-facing interface, not an integration |
| Validation | Build the complete product first; the pilot vendor reviews at the end |

**Stack, in plain terms.** *Safest* here means four specific things, not a brand name: the phone never decides what it's allowed to see (the database enforces it), the record of who scanned what can never be edited, the database itself makes double-booking impossible rather than merely checking for it, and everything is recoverable. *Smooth* means the app never makes a person wait on the internet while they're holding a case.

- **Postgres via Supabase** for the database, login, and photo storage. Postgres because it can enforce "this camera cannot be promised to two jobs" as a hard database rule — not something Firebase or a document store can do.
- **React + TypeScript + Vite**, wrapped in **Capacitor** for Android. Same stack as Papa Rentals, so the design and the team's knowledge carry over.
- **SQLite on the device** is what the app actually reads and writes. The network syncs it in the background. This is what makes it instant and what makes it work in a basement.
- **Google ML Kit** for QR scanning — decodes in native code at camera speed, in bad light, at bad angles. JavaScript scanners hit ~5fps on a cheap Android and feel broken.
- **All writes go through server functions**, never direct table writes. This is the rule that keeps the phone from being trusted, and it must be written into `CONTRIBUTING.md` on day one.

---

## The central finding

The research is unambiguous about why these systems fail, and it isn't technology. From a Cheqroom review:

> *"missing an affordable way to track items without having to rely so heavily on users doing their part, as if users don't check items in and out, the whole system breaks down."*

Adoption is a **cliff, not a curve**. The data is only right if everyone scans every time; one busy morning of skipping poisons it; once staff stop trusting the numbers they walk to the shelf instead, and the app is dead weight people still have to type into. The three top-ranked pain points (#1 check-out/in speed, #2 offline, #9 staff bypass) all score maximum and are the same problem: **a two-second physical transaction, repeated 400 times a morning, in a place with bad signal.** Incumbents are desktop-era, event-industry, per-seat, online-only systems with a bolted-on mobile app. Nobody has built for that loop.

Four principles govern every decision below. Put them in `CONTRIBUTING.md`.

1. **Smooth means never blocking a human on a network round-trip during physical work.** No `await` in the scan handler, ever.
2. **If an operation asserts a fact about the physical past, it works offline. If it promises the future or allocates a scarce resource, it needs the server.** This settles almost every offline question.
3. **Physical-reality events never fail; they raise alerts.** The scanner has no rejections, only annotations. Schedule-intent events (confirming a booking) *do* fail.
4. **Zero *network* in the scan handler — but never zero *local* checks.** The device already knows this camera is out to someone else. Warn instantly, from local data, and still record.

### The wedge

"We know where our gear is" is a benefit, not a story. Two stories travel between rental houses in Lahore:

> **"We got paid for the battery plate."**
> **"He said we scratched it. I sent him the photo from the day it went out. He paid."**

Neither needs a booking engine, availability model, rate card, or invoice. Both were originally scheduled twelve to twenty weeks after staff are asked to start scanning. **They move to phase 1.**

### The enforcement mechanism

The app's answer to "what if someone just doesn't scan?" is not a compliance report — the research is explicit that surveillance framing causes abandonment. It is the **gate pass**: a printable, WhatsApp-shareable challan generatable **only from a completed scan session**. The driver won't leave without paper; the paper requires the scan. Nobody has to police anybody. It is also the bridge that lets the house stop using the notebook, avoiding the dual-running state the research names as the killer.

One day of work. Originally phase 4.

---

## What overrides the architecture document

`docs/architecture.md` is the detailed reference. These 20 corrections supersede it and must be applied before any code is written.

### Correctness — must fix or the product lies

| # | Change | Why |
|---|---|---|
| 1 | **Never emit implied `check_out` events for `packed` containment.** Only `permanent` (an FX9 handle genuinely can't leave without the body). Scanning a case opens a **case manifest** of unconfirmed rows; one big button confirms all with `entry_method='assumed'`. Assumed events are countable, visible, and **excluded from dispute evidence**. | As designed, the system converts belief into recorded fact. A plate pulled Tuesday and never scanned back would be recorded as checked out to today's client, by name, with a timestamp — a fabrication the database generated, used against a client who is right. |
| 2 | **Add `scan_events.entry_method`** — `scanned \| manual \| assumed \| implied \| counted` — and a **manual entry path**: search by code/name → tap to add, always reachable from the scan screen. Plus tag reprint in under 15s. | The research names the absence of a manual fallback as the #1 abandonment trigger. Tag under gaffer tape at 06:05 with no path forward teaches the tech on day one that the app has no answer for the real world. `entry_method` is also the basis of the trust report and is painful to backfill. |
| 3 | **State explicitly: confirming a booking allocates a specific asset.** Auto-pick the least-utilised available unit; reallocation is an `UPDATE ... SET asset_id` inside the same RPC, re-checked by the constraint. | The architecture says the exclusion constraint makes double-booking impossible *and* that allocation happens later at prep. Both can't be true. As written, an implementer builds the version where you can confirm five FX9 bookings against three bodies and the database accepts all five. |
| 4 | **Add `stock_reservations(product_id, location_id, qty, period, state)`.** Availability = `qty_on_hand − max(overlapping reserved qty)` over the window; enforced by a serializable RPC with a per-product advisory lock. | `stock_lots.qty_reserved` is a single number with no time dimension. You cannot ask "are 20 XLR cables free next Tuesday". Bulk is the majority of line items in a rental house. This is real unbudgeted work. |
| 5 | **Corrections point forward** — `corrects_event_id` on the new row, not `superseded_by_event_id` on the old. Supersession derived at read time. Same for unresolved-tag resolution: derive `asset_id` from `tag_code` at read time. | The architecture grants INSERT-only on `scan_events` and then describes a correction flow that requires UPDATE. Whoever hits this at 2am adds an UPDATE grant and the immutability that makes the log evidence quietly dies. |
| 6 | **Clamp `effective_time`, then order by `(effective_time, server_seq)`.** `effective_time = least(device_time + clock_offset, server_time)`. Intra-device ordering stays `client_seq`. | The architecture put the untrusted value first, so one phone four minutes off reorders an org's history on every rebuild. **But ordering by arrival instead — this row's original advice — is worse:** a device offline three weeks arrives last and would clobber three weeks of reality (conflict case C8). Clamping fixes both: a fast clock is pulled back to arrival, a slow clock applies as *old*, so skew can only push an event toward being ignored, never toward overwriting newer truth. Corrected during implementation; both directions tested. |
| 7 | **Store `customer_period` and `blocked_period` separately**, plus `buffer_policy_version`. The constraint sits on `blocked_period`. Buffers must also be shortenable **per reservation at confirm time**. | Baking buffers into one range means the client's confirmation says "3–7 April" while the only stored dates are "2 Apr 14:00 – 7 Apr 22:00". And same-day turnaround (in 10am, out 2pm) violates a 4-hour buffer daily — so the desk overrides daily, and a guarantee bypassed daily is an alert channel that gets muted in week two. |
| 8 | **Kit check-in needs a count block for bulk contents** — "6× XLR expected", stepper defaulting to **blank**, not 6. A blank count is itself a discrepancy. `discrepancies` gains `qty` and a `count_short` kind. | The set-difference reconciliation only covers tagged serialized items. The research's #3-ranked pain point is precisely the small untaggable things — cables, plates, caps. The architecture's answer to its own #3 pain point doesn't cover them. |
| 9 | **Make the pull session, not the container, the reconciliation unit.** Expected set = kit template expansions + explicit lines + permanent accessories. | Many real "packages" are assembled at prep from four shelves and never live in one case. For those, `expected_children` is empty and the flagship feature never fires. |
| 10 | **Add trigger-enforced soft-delete guards.** Refuse `deleted_at` on a product with live assets, a customer with open bookings, a location holding assets. | Keep the foreign keys (they catch bad IDs from offline devices — correct call, correctly argued). But `ON DELETE RESTRICT` + universal soft delete means the FK never fires for the failure that actually happens: nobody hard-deletes, they set `deleted_at`, and everything downstream is orphaned while the constraint reports success. |

### Money, evidence and security — must fix or it costs real money

| # | Change | Why |
|---|---|---|
| 11 | **Harden the photo evidence.** Server-side hashing on receipt (don't trust the device hash). Content-addressed write-once storage paths (`{org}/{sha256}`) so overwrite is semantically impossible. Server-stamped `received_at` shown next to `captured_at`. `condition_photos` append-only. | The out/in comparison is the best commercial feature in the product and as designed it is forgeable by exactly the person most likely to forge it — the staff member who scratched the lens. Device-computed hash, updatable `storage_path`, device-clock timestamp. |
| 12 | **Never evict an un-uploaded photo.** When the cache fills, **block new capture** with an explicit "Device full — 84 photos waiting" state. Default `wifi_only = 0`; downscale to 1600px WebP (~150KB). | A blocked capture is recoverable; a deleted photo is not. And `wifi_only=1` optimises for a data cost that doesn't exist — the research says Pakistan is among the cheapest data markets globally — paying for it in destroyed evidence. |
| 13 | **Encrypt the local database** (SQLCipher, key in Android Keystore). Bound the offline token with a stated "must reach the server every N days or lock" policy. Clear local data on membership suspension; honour a remote-wipe flag on next connectivity. **Exclude `cnic`/`ntn` columns from scanner sync.** | A fired tech with a stolen Redmi currently holds the entire fleet, purchase prices, replacement values, and the customer list — unencrypted, working, still queueing writes. The CNIC exposure is a PII breach under Pakistan's PECA regime. Add column-level assertions to the sync leak test, not just row-level. |
| 14 | **Replace mutable money totals with an append-only `customer_ledger_entries`.** Balance is a projection. Drop `invoices.amount_paid_minor` or make it a CI-checked materialised projection. Add **udhaar** (running client balance) and **cheque-held-as-security** as real objects. | The architecture argues brilliantly for append-only truth on the scan loop and then uses mutable running totals for money — where accountants have insisted on append-only for six hundred years. A denormalised `amount_paid` beside a `payments` table will drift, invisibly, until a customer disputes a balance. |
| 15 | **`deposits` as its own object with a state machine** — `held / partially_applied / refunded` — and an RPC-enforced gate: **refund requires the booking's check-in to have reached `inspected_clear`.** | The most direct money-loss path in the plan: a deposit refunded at the counter before the QC bench finds the cracked matte box. The research names this exact scenario. `payments.kind='deposit'` cannot express "held" and cannot block anything. |
| 16 | **Add `customer_credentials`** (kind: `cnic_photo \| guarantor \| cheque \| coi`, expiry, verified_by/at) with an RPC-level **block at first check-out to a new customer above a value threshold**, overridable by a manager with a logged reason. | The research's fraud theme is catastrophic-per-incident — the plausible stranger who doesn't come back; one incident equals a year's profit. The schema has `cnic text` and `blacklisted boolean`, and the check-out RPC has no customer gate at all. New client + Rs 4,000,000 camera + short notice currently produces zero friction. |
| 17 | **Role-gate the destructive and money-touching actions in the RPC bodies**, not the UI: `written_off`, `retire`, `lost`, deposit refunds, price overrides above a threshold. `written_off` must write a loss record, never just change a status. Rate-limit event insertion per device. | As designed, the tech who lost the Rs 90,000 battery plate resolves his own discrepancy as `written_off` and it disappears. |
| 18 | **Add `original_rate_minor`, `override_reason`, `overridden_by` to `booking_lines`.** | The research calls the logged manual price override *non-negotiable* — "never fight the owner's judgement; record it". It is absent while four tables of pricing speculation are present. Without it you cannot answer "why was this Rs 8,000". |
| 19 | **Every alert type declares an owner role, a severity, and a delivery channel in the same migration that creates it.** Minimum: WhatsApp/SMS to the manager for `overbook` and `double_checkout`. Plus an overdue escalation ladder: 1 day → tech, 3 days → manager WhatsApp, 14 days → auto-open a `severity='missing'` claim. | Seven alert types currently terminate in a dashboard nobody watches, with notifications scheduled four phases later. An alert with no delivery channel is a log line. Rental desks do not watch dashboards; in Lahore the business runs on WhatsApp. |
| 20 | **Daily append-only NDJSON export of `scan_events` + photo metadata to cold storage**, separate credentials, write-once. And default the **public tag page** to *"Found this equipment? Tell us"* — owner name/phone opt-in per org. | `scan_events` is the sole source of truth; everything else is a projection. A bad migration has no recovery but a PITR restore that rolls back everything else. Separately: a public page naming the owner tells a thief exactly who to peel the label for, and every case in a hotel lobby advertises which house is worth burgling. |

### Cuts — delete before building

Each of these is a bet placed before the second use case exists, or cargo from Western enterprise RMS products whose own reviewers hate them.

- **The TypeScript pricing implementation.** Ship SQL-only with an RPC for previews. The architecture identifies the divergence risk, prescribes exactly this cure, then ships the wound with a 10k-input fuzz harness attached. Quoting is always online by its own reasoning.
- **Three of four pricing tables.** Keep `rate_cards` (name, tier, `week_equals_days`, `min_billable_days`) + `rate_card_entries` (product, day rate). Delete `rate_tiers`, `month_equals_days`, `pricing_mode`. Fold `weekend_counts_as` into a calendar object with an org weekend day-mask and a `holidays` table — **Eid moves on the lunar calendar and Friday Jumma is a real half-day**; a rate engine that can't express Eid week is wrong in Lahore specifically. Pricing must be a **documented ordered pipeline** with named steps and golden-fixture tests; five knobs with no stated precedence is where every rental-system pricing bug lives.
- **`apps/scanner` + `apps/console` as separate shells.** One app, one shell, route-level code split, `packages/core` from day one. Extract surfaces when the duplication is *measured* — the architecture already says to decide this at end of phase 2, so simply don't build it until then.
- **Supabase Realtime.** The sync stream is already realtime. The architecture writes "don't build two live paths for the same data" and then keeps a fourth.
- **`ltree` locations.** `parent_id` + a text path. Add `ltree` when a customer has two warehouses. *Keep vehicles-as-locations* — that genuinely answers the 6am question.
- **Twelve asset statuses → six in phase 1** (`in_stock, reserved, out, in_service, lost, retired`), and see the status-axis split below.
- **Universal audit triggers in phase 0.** `scan_events` is already the immutable record for what matters. Phase 1 audits five things: reservations, invoices, payments, role changes, tag binding.
- **`productions` with `po_number`**, `customer_tier` rate cards, `credit_limit_minor`, `payment_terms_days`, gapless FBR-defensible invoice numbering, the six-state damage claim workflow, `permissions jsonb` per-user overrides, the whole `maintenance_orders` module. Replace the last with a flag on the asset ("in service, why, since when") that removes it from availability — 90% of the value at 5% of the cost.
- **`condition_grade`'s five levels + checklist → OK / Not OK + photo**, where "Not OK" opens a note. The research warns checklists over 3–6 items get rubber-stamped; five grades collapse to "good" for 99% of scans within a week, and then you have a column that *looks* like data and isn't — worse than no column, because people decide on it. The 3–6 item category checklist belongs at the return bench, where someone is standing still.

### The sync engine — build the simple one

The architecture recommends PowerSync and then names as its own #2 risk that PowerSync's sync rules are a **second authorization surface parallel to RLS** — a wrong bucket parameter leaks a competitor's inventory to a phone — requiring permanent CI infrastructure to defend.

But its own sizing says the full working set is **8–20MB**, the tag map is 1MB, and a 40,000-asset house lands under 100MB. The write path is already independent (RPCs only). So PowerSync buys exactly one thing: an incremental resumable *read* path. At 20MB that is "pull everything in my org changed since cursor X, plus tombstones" — a paginated query over `updated_at`-indexed tables, estimated at 3–4 weeks.

**Decision: build the cursor-pull sync.** It deletes risk #2 outright and keeps every authorization decision in one place — RLS, tested with pgTAP, which is being built anyway. Structure the read path behind an interface so PowerSync remains a contained swap if a customer's working set ever exceeds ~200MB or org count exceeds ~50. Both are years away.

Two sync rules the architecture misses either way:

- **Any state transition triggered by the passage of time must be derivable locally from stored timestamps, never only from a server cron job.** Hold expiry and overdue must be computed client-side at render; cron only materialises them for server queries and notifications. Otherwise a device offline for three days renders expired holds as live and 60-hour-overdue gear as fine, with total confidence.
- **Sync must always include the booking (and its customer) referenced by any asset's *current* state, regardless of date window.** Otherwise an asset out 45 days on a long-form drama renders as "OUT to «unknown»" — on exactly the assets most at risk of being lost.

And fix the outbox contradiction: strict ordering + all-or-nothing batches + "skip poison pills" are mutually incompatible. **Skipping cascades** — marking an op failed marks its entire `depends_on` descendant closure failed, surfaced as *one* "needs attention" card. State the invariant: *the queue is a DAG; failure poisons the subtree, never just the node.* Also mirror the outbox to an append-only JSON-lines file (Capacitor Filesystem) so SQLite corruption doesn't take the queue with it — and accept, in writing, that nothing survives an uninstall.

---

## Design

### Status: split the axes, encode by shape

Twelve statuses cannot be aliased onto Papa Rentals' five hues — and the current single column cannot represent a sub-rented lens that is currently out on a job, because `sub_rented_in` and `out` are mutually exclusive values and both are true.

**Split into three columns:** `presence` (here / out / in transit / gone), `health` (fine / in service / quarantined), `ownership` (ours / sub-rented in).

**On every glanceable surface, collapse to four buckets** — solid fills, not tints, with a redundant glyph so it survives greyscale, sunlight and deuteranopia (~8% of men; `--green #16a34a` and `--red #dc2626` are the canonical confusion pair, and the sibling's tinted badges sit at ~1.1:1 against the card):

| Bucket | States | Fill | Glyph |
|---|---|---|---|
| HERE | in_stock, prepped, reserved | solid `--green-ink` | ● |
| OUT | out, in_transit | solid `--purple` | ▸ |
| ATTENTION | overdue, quarantine, in_service | solid `--red` / `--accent` | ▲ |
| GONE | lost, retired, sold | dashed 2px, no fill | ○ |

Full precision appears only as **plain text** on the asset page, where there is time to read.

### Three themes, not two — dark is wrong for sunlight

The architecture proposes defaulting the scanner to dark because the warm off-white "washes out in direct sun". That is inverted: dark themes emit least light and are *least* readable in sun. And the sibling's dark theme is a *cozy* dark — `--card #211d18` on `--bg #161310` measures **1.10:1** (an earlier estimate of ~1.35 was wrong; the real figure is worse), a phone-in-bed palette whose card boundaries vanish next to a live camera viewfinder. Note that *darkening* the background makes this worse, not better — at these luminances the WCAG `+0.05` term dominates and both ends converge. The separation has to come from raising `--card`.

| | indoor (default) | truck (dark) | **sun (new)** |
|---|---|---|---|
| `--bg` / `--card` | `#fdfbf8` / `#ffffff` | `#0f0d0b` / `#1e1a16` | `#ffffff` / `#ffffff` |
| `--ink` | `#222222` | `#f2efec` | `#000000` |
| `--line` | `#ece7e0` | `#3f3831` *(raised)* | `#000000`, **2px** |
| shadows | as sibling | as sibling | **none** |
| `--accent` | `#ff6b2c` | `#ff7b40` | `#c93f00` |
| badges | tint + border | tint + border | **solid fill, white ink** |

Auto-selected by the ambient light sensor, manual lock in the header. Two load-bearing points: **shadows are worthless in sunlight**, so every card boundary in the marketplace's system disappears outdoors and the layout collapses into an undifferentiated white field — sun mode replaces every shadow with a hard 2px border. And `--accent #ff6b2c` is **2.9:1 on white**, failing AA as text; where accent means "needs attention" it must be `#c93f00`.

### Tokens: share primitives, own semantics

The architecture puts the twelve status colours in the shared package "so the two apps can't drift into different oranges". Right worry, wrong fix — it means Papa Rentals' next brand refresh silently changes what "overdue" looks like on a loading dock.

```
packages/tokens   (SHARED)  → primitives only: raw palette, radii, spacing,
                              type scale, easings, durations, font files
packages/icons    (SHARED)  → SVG path data + a small renderer, consumed by
                              all three apps, plus the no-emoji test
apps/*/semantic.css (OWNED) → meaning: --status-*, --tap-glove, --row-h-*,
                              --ff-code, sun-mode overrides
```

Icons must be their own shared package, not `packages/ui` — otherwise the moment Papa Vendor draws its ~40 new icons (barcode, forklift, wrench, truck, case) the two repos hold divergent sets with the same visual grammar and no shared source.

New tokens Papa Vendor needs:

```
--tap-glove: 64px;        /* 20-25mm gloved contact patch */
--tap-gap-glove: 12px;    /* minimum between ANY two adjacent targets */
--tap-gap-danger: 24px;   /* destructive vs non-destructive */
--row-h-compact: 32px;  --row-h-comfort: 56px;
--r-row: 4px;             /* rows never get the 20px card radius */
--ff-code                 /* see below */
--status-solid-{here,out,attention,gone}, --status-ink-on-solid
```

Glove mis-taps are **adjacency failures, not size failures** — the patch is wide and imprecise and lands on the neighbour. Hard rule: **no destructive action is ever adjacent to a frequent action on the scanner.** Destructive actions live behind a swipe or a hold, never a tap.

Console rows get **zero shadow, hairline separators only**. Shadows belong to floating things. The 20px radius + layered shadow is correct for a consumer grid of eight items and pure noise on a forty-row table.

**Asset codes need their own face.** "FX9-02" vs "FX9-O2"; "BAT-1I5" vs "BAT-115". Plus Jakarta Sans has a plain oval zero and near-identical `I`/`l`/`1`. Ship JetBrains Mono or IBM Plex Mono (400/600, slashed zero) as `--ff-code` for codes, serials and money; `tabular-nums` everywhere numbers change. And forbid ambiguous characters in generated `asset_code` at the source — Crockford base32, no `O I l 0 1`.

**Urdu decision, needed in phase 0 because it determines the font package:** Plus Jakarta Sans has no Arabic script; Noto Nastaliq Urdu needs ~1.8× line-height, which breaks every fixed-height row token above, and mixing RTL Urdu with LTR asset codes is a bidi problem exactly where a misread is expensive. **Use Roman Urdu in Latin script for the scanner** — keeps LTR, keeps the font, and matches how Pakistanis actually type to each other. Full Urdu script is a console-only option later.

### Information architecture

The console's routes must not be one-per-table — that is almost exactly Current RMS's nav, the product whose reviewers say "UI difficult to use and hard to learn quickly".

**Console home is a Today board**, three columns:
- **GOING OUT** — jobs with prep or start today: job · client · N items · prep ring (42/60) · pickup time, sorted by departure.
- **COMING BACK** — due today, with overdue pinned above in the attention style.
- **NEEDS A DECISION** — the union of every alert the system generates. Seven alert tables currently have no home; this is it.

`calendar` becomes secondary, reached from the quoting flow. `inventory` becomes **search-first** — one command-palette field matching asset code, serial, product, client, or job number — with two saved views behind it: *by shelf* (how you count) and *by product* rolled up ("FX9 — 4 total · 2 here · 1 out · 1 in service"). **A flat 4,000-row asset list is not a default view.**

**"Extremely detailed but extremely user friendly" resolves one way: detail lives at depth, on one canonical page, one action from anywhere.** That is the **asset page**, and it is the IA's spine — every list row, search hit, scan, pull line, discrepancy and invoice line resolves to the same page with the same layout. Learn it once, know the app. Single scrolling column, fixed section order, **no tabs**: identity → right now (plain sentences, not badges: *"On Job 482 (Zindagi Films) since 3 Apr. Due back tomorrow 09:00"*) → containment tree → **life** (the event stream, actor names and photo thumbnails inline — the evidence artefact) → money → health.

Breadth surfaces carry **four fields maximum per row**. That discipline is what makes both halves of the user's phrase true.

### The scan loop

**Cold app → scanning = 1 tap.** The scanner's home screen *is* today's jobs, sorted by truck departure, largest thing on screen. One tap on a job opens the camera bound to that job. Put this number in the performance budget beside the 100ms. If the app opens on a bare camera every scan is orphaned and needs desk cleanup nobody does; if it opens on a nav shell the budget is spent before the camera.

**Not a full-screen viewfinder** — that maximises the thing the tech isn't looking at and destroys all context.

```
┌─────────────────────────────┐
│  Job 482 · Zindagi Films    │  44px
├─────────────────────────────┤
│      [ CAMERA VIEW ]        │  ~38% of viewport, 2px accent frame, no chrome
├─────────────────────────────┤
│  ████████████░░░░░  42/60   │  progress + count in --ff-code at 32px
│  Rack A ✓   Rack B 6 left   │  REMAINING GROUPED BY SHELF
├─────────────────────────────┤
│  ● Sony FX9      FX9-02     │  newest at TOP, 56px, virtualized, no re-sort
│  ▲ Arri 300d     LT-07    ! │  amber = unexpected, count NOT incremented,
│                             │  two inline actions on the row
├─────────────────────────────┤
│  [ hold to finish · 6 left ]│  64px, 500ms hold with filling ring
└─────────────────────────────┘
```

- **Remaining is grouped and ordered by shelf**, so the tech walks the warehouse once. The architecture has locations and pull lists and never connects them; this is an ordering change that halves the walking.
- **Hold to finish, not tap.** A tap at the screen bottom is what a knuckle does while carrying a case.
- **Torch is a persistent thumb-reachable toggle, defaulting on in low light.** Never mentioned in the architecture; a Lahore warehouse before dawn is dark and ML Kit needs light.
- **Volume-down bound to capture/confirm.** A gloved hand finds a physical button by feel and cannot find an on-screen target by feel.
- **Session-complete is mandatory** and shows the shortfall: *"Pull complete — 34 of 36. Missing: 1× battery plate, 1× 5-pin XLR"* — **while the truck is still in the yard.** Currently there is no terminal state at all; a tech scans some things and walks away, and the two missing items surface at the client's set.
- **Snapshot age in the pull header, always visible:** *"List as of 04:12 · not refreshed"*. And when the desk edits a booking whose pull is in progress on an offline device: *"WH-02 is offline and will not see this. Call Bilal."*
- **In-flow damage capture is one gesture**, not a form: long-press row → camera → shutter → back to scanning. Grade defaults, checklist null. If flagging a scuff costs four taps and a dropdown, nobody flags scuffs and the out-side photo — half the evidence pair — never exists.

**Duplicate scans must never be silent.** The architecture suppresses the same tag for 2s. Silence is indistinguishable from "the camera didn't see it"; the tech rescans, gets nothing, and concludes the scanner is broken — which is precisely how the system dies. **Suppress the write, never the feedback:** distinct double-tick, two-tone chirp, and the existing row scrolls into view and pulses. Extend suppression to the whole session, not 2s.

**Feedback vocabulary** — a named constant table in `packages/core`. Haptics alone fail (phones live on lanyards); audio alone fails (generators, compressors). Audio must be **pitch-discriminable**, not beep-count-discriminable, because under noise humans count beeps wrong and hear pitch right.

| Event | Haptic | Audio | Visual |
|---|---|---|---|
| Accepted | 20ms tick | 880Hz, 40ms | row inserts top, green dot |
| Duplicate | 2 × 15ms | 880Hz ×2 | existing row pulses |
| Unexpected | 60ms ×2 | 660→440Hz glide | amber row, `!`, count unchanged |
| **Conflict** | distinct pattern | low double | warning row + reason required |
| Error | 200ms | 220Hz, 200ms | red dashed row |
| Complete | spring | rising triad | full-width confirmation |

**The bar: every one of these is operable by feel and ear with the screen face-down.**

**Nothing in the scan loop is ever a modal, a blocking toast, or a required decision.** Wrong item gets an amber row and two inline buttons — `Add anyway` / `Not this job` — neither required; unresolved rows are reviewed once at "hold to finish" with a `Resolve all as extras` bulk action.

**Thermals and battery are missing from the budget entirely.** Continuous ML Kit at camera framerate for 30 minutes on a Rs. 25,000 Android in a Lahore June will throttle, making the 100ms budget fiction at minute 18 — and nothing in the telemetry will explain why. Analyse at **15fps** (QR at 20cm needs no more), pause the analyser after 8s with no decode and resume on accelerometer motion, dim the screen to 40% during scanning, and record `session_elapsed_ms` + battery level alongside `scan_latency_ms`.

### The one screen to get perfect

**Return / check-in reconciliation.** Not the scan screen (used more often) and not the asset page (the best demo) — this one, because it is the scan loop, the inventory truth, and the money *at the same time*, at the moment of maximum anxiety in a rental house's day. Originally phase 3; it ships in phase 1.

Stage 1 is the scan shell above in return mode, with one difference: the bar counts **down** and shows money, not percentage. `54/60` with six left is not 90% good, it is Rs 18,000 unaccounted for.

Stage 2, reached by press-and-hold, is one full-height card, three zones, in this exact order:

```
┌────────────────────────────────────────────────┐
│  Job 482 · Zindagi Films        closed 19:14   │
├────────────────────────────────────────────────┤
│   NOT BACK                      Rs 18,000      │  ← FIRST, ALWAYS
│   ▲ Battery plate  BAT-07        Rs 12,000     │    solid ATTENTION fill
│     last seen: out 3 Apr, Bilal                │    two inline actions,
│     [ Charge client ]  [ Still looking ]       │    no modal
├────────────────────────────────────────────────┤
│   NEEDS A LOOK                                 │
│   ▲ Sony FX9  FX9-02                           │
│     [out photo] │ [in photo]  ← side by side   │    tap → fullscreen compare
│     "scratch on mount, not there on 3 Apr"     │
│     [ Open claim Rs ___ ]  [ It's fine ]       │
├────────────────────────────────────────────────┤
│   BACK AND FINE                         52  ▸  │  ← COLLAPSED to one line
├────────────────────────────────────────────────┤
│  [ Send summary on WhatsApp ]      64px        │
│  [ Print gate pass / receipt ]     64px        │
└────────────────────────────────────────────────┘
```

Why exactly this: **exceptions first, success collapsed to one line** — 52 green rows are the *absence* of information, and every incumbent check-in screen makes you hunt the six that matter. **Money on every missing line** — "battery plate missing" is a chore, "Rs 12,000" is a decision, and this is where money first becomes visible to the owner. **The out/in photo pair renders side by side in the row, before you tap** — if it's one tap away nobody discovers it exists. **The WhatsApp share is a primary full-width action**, sending the client the same three zones as a clean image; that message is the product's marketing, and every production coordinator in Lahore receives one. And **nothing on this screen is required** — the tech at 7pm is not the right person to decide whether to charge a client Rs 12,000, and forcing him is how everything gets marked "still looking" forever. Unresolved items land in the console's NEEDS A DECISION column and stay there.

### Adoption

The architecture's own risk-#1 mitigation is a "missed scans report to the manager" — which is the surveillance pattern its own research says causes abandonment, quoted two pages earlier. Two changes:

- **Reframe the manager's view from person to job.** Not "Bilal missed 6 scans" but *"Job 482: 54 of 60 items accounted for"*. Same information, opposite social effect — a shared problem instead of a personal indictment.
- **Give the tech an alibi tool that is theirs: "Prove it."** From their own session history, one tap produces a WhatsApp card: *"FX9-02, checked out 06:14, 3 Apr, by Bilal — 4 photos."* When a client claims a scratch, that is the tech's defence, not the owner's audit. The first time one tech uses it successfully, every tech in that warehouse will scan and no manager will have to ask. A day of work on infrastructure already planned.

**The owner's daily WhatsApp digest is a phase 1 deliverable**, and money-shaped, not activity-shaped:

> *Papa Vendor — 12 Aug*
> Out today: 7 jobs · Rs 340,000 of gear
> Back today: 5 of 6 — **Job 478 is 1 day late** (Rs 22,000, Zindagi Films)
> Not returned complete: 1 battery plate, Job 471 (Rs 18,000)

Four lines, one number per line, and he forwards it to the staff group himself. Enforcement then happens socially in WhatsApp, which is where authority in a Lahore rental house actually lives — never inside a React app.

**Auth: PIN-on-device is primary from day one; OTP is enrollment-only**, done once at the desk on WiFi. Fast user-switch on the shared device with the current user's name shown large and persistently on the scan screen. The architecture hedges this as an open uncertainty; the research already resolved it — Current RMS users were *"locked out for hours at a time, causing them to lose jobs"* over exactly this, and SMS deliverability in Pakistan is genuinely unreliable. An auth wall at 6am on a dock is an existential product failure.

**Onboarding: 800 items is 10–20 person-hours, not "a structured afternoon."** At a realistic 45–90s per item, and that assumes an accurate Excel that doesn't exist. Two changes:

- **Intake-by-scan, offline, ten seconds:** scan a blank tag → camera → one photo → speak or type a short name → done. No product record, no serial, no category; the desk enriches later from a chair. Photo-first also means a tech with limited literacy can do it. **This requires softening the online-only rule on asset creation** — tag binding uniqueness resolves on sync, and a collision is already an enumerated conflict case.
- **Tag by rack, not by catalogue.** Day one is not "tag 800 items" — it is print blank tags, pick one rack, scan the location tag, rapid-tag that rack. Forty minutes produces a complete, trustworthy sub-inventory the same day. The console shows *"Rack A — verified 12 Aug · Rack B — not yet."* Partial truth that is honest beats total coverage that is fabricated, and it gives the owner a visible ladder instead of an open-ended chore he never schedules.

**Cycle counting is a product, not an enum value.** Scan a bin's location tag → scan what's in it → diff. Ten minutes, one shelf a week. It is the **only** mechanism that catches gear that was lost without ever being scanned out — the failure mode the research says kills these systems, and which nothing else in the design will ever notice.

### The one irreversible marketplace decision

Everything else about Papa Rentals integration can wait for phase 6, correctly. But `products` is org-scoped with free-text `manufacturer`/`model`, and a marketplace needs **"Sony FX9" to be one thing across every vendor** or cross-vendor search and availability are impossible. Retrofitting a global catalogue over fifty orgs' free-text rows is a data-cleaning project that will never be scheduled.

**Add a nullable `global_product_id` on day one**, pointing at a small shared catalogue seeded with the few hundred products that matter (ARRI, RED, Sony, Canon, Aputure, Nanlite, Sachtler, Manfrotto). The importer fuzzy-matches and asks the operator to confirm. One day now; impossible later.

And reverse one line in the architecture: Papa Rentals' `types.ts` is **not** "the shape vocabulary Papa Vendor's schema must map onto". Those are a localStorage demo's toy shapes (`Item` carries `pricePerDay`, `icon`, `flashDeal`). When the integration happens, the marketplace adopts Vendor's vocabulary through an adapter. Say this now, before someone tries to be consistent.

---

## Phasing

You've chosen to build the complete product before the pilot vendor sees it. That's viable, and the sequencing below is unchanged by it — the ordering is driven by dependency and by which features repay the behaviour change, not by pilot availability. One honest note: the research flags several things as unsourceable and only answerable in the field (deposit norms, the pencil/challenge hold convention, cash-vs-digital split, whether COI-equivalent insurance exists at all). Those are built to explicit assumptions, marked in code as `// ASSUMPTION:`, and collected in `docs/assumptions.md` so the vendor review at the end has a checklist rather than a scavenger hunt.

**Phase 0 — Foundations (1–2 wks).** Monorepo; `packages/tokens` + `packages/icons` extracted and consumed by *both* repos (do this first — retrofitting is worse); Supabase project; orgs/users/memberships + RLS; PIN auth; pgTAP harness and the cross-org leak test (row *and* column level). Two-day spike: cursor-pull sync against the real schema shape. Settle the Roman Urdu decision. Nothing user-visible — and do not skip the RLS test harness, which is far harder to add once 35 tables exist.

**Phase 1 — "Where is my gear?" plus the wedge (6–8 wks).** The largest phase, deliberately.
- Products, assets, `asset_tags`, `global_product_id`, locations, label printing, CSV import with column mapping and fuzzy dedupe, **intake-by-scan**, tag-by-rack onboarding.
- `jobs` (three columns: label, contact, expected_back — free text). **Without this, phase 1 cannot answer "who has it", which is its entire pitch.** In phase 2 a job row is upgraded to a booking by adding `booking_id` and backfilling.
- `scan_events` + reducer + `entry_method`, local SQLite, cursor-pull sync, outbox, the local double-checkout warning.
- Scanner: 1-tap-to-camera, continuous scan, manual fallback, torch, feedback vocabulary, session-complete-with-shortfall.
- **Condition photos welded into the check-out scan, and the out/in comparison view.**
- **Component check at check-in with "returned with exceptions"** and the reconciliation screen above.
- **Gate pass PDF, generatable only from a completed scan session.** WhatsApp share of manifest and gate pass. The owner's daily digest. The tech's "Prove it" share.
- Console: Today board, search-first inventory, asset page.

**Phase 2 — Bookings, availability, alerts (5–6 wks).** Customers, bookings + lines, `asset_reservations` with the exclusion constraint, `stock_reservations` for bulk, holds with expiry and the challenge workflow, three-layer availability (available / pencil / confirmed), the **extension-collision preview** — *"extending this breaks Job #482 tomorrow 7am; options: sub-rent, substitute unit #3, call client"*, which the research calls the highest-value single screen and which no incumbent presents as a decision. Plus: alert delivery to WhatsApp, the overdue escalation ladder, cycle counting, the customer credential gate, and the **no-login client status link** (the public tag resolver already establishes the pattern — nearly free, kills three client complaints, and every production coordinator in Lahore sees it).

**Phase 3 — Commercial (4–5 wks).** Rate cards as an ordered pipeline with the calendar object, the 3-day week, kit pricing, the logged manual override, quotes as PDF/WhatsApp, invoices, the append-only customer ledger, udhaar, deposits with the QC-gated refund. Deliberately after phase 2 — houses tolerate invoicing in Excel far longer than they tolerate losing gear.

**Phase 4 — Operations depth (3–4 wks).** Asset health and service flags, sub-rentals in and out with margin, driver/delivery handoff, roles and permission refinement, richer notification rules.

**Phase 5 — Analytics and the marketplace (ongoing).** Utilization per asset, revenue vs acquisition cost, dead stock, the buy-vs-sub-rent report. Then the Papa Rentals integration: pushing availability out, pulling marketplace bookings in.

**Priority rule to state explicitly: the console may be plain; the scanner may not.** A plain console that is fast and correct is fine. A scanner that feels a beat slow is a dead product. A small team maintaining two surfaces will let one rot, and left unstated it will be the console — where the person who pays lives.

---

## Verification

Correctness here is mostly invisible — bad sync produces *wrong data*, not crashes, discovered weeks later as inventory that doesn't match reality. So verification is infrastructure, not an afterthought.

**Per-commit CI**
- **pgTAP** on every RPC: constraint enforcement, role gates, and one test per bypass path asserting an alert row exists.
- **Cross-org leak test** — for every synced table, open a session as org A and assert zero org-B rows *and* that excluded columns (`cnic`, `ntn`) are absent. Any new table without a matching RLS policy + sync rule fails the build.
- **Sync simulator** (`packages/testkit`) — N virtual devices with scripted partitions, clock skew, and interleavings, asserting projection convergence. This is the only way the 6am-truck scenario is reproducible at a desk.
- **Golden-fixture pricing tests** using the `explanation[]` array as the assertion format, pinning pipeline order.
- **Reducer replay tests** against fixtures, plus `rebuild_asset_projection` verified idempotent.
- **The no-emoji DOM test**, inherited from Papa Rentals with the icon package.

**On real hardware, not a Pixel** — a genuine low-end Android is the target device:
- The §4.4 budget re-measured as a regression gate: decode→feedback <100ms, cold-app→scanning = 1 tap, camera ready <400ms, ≥2 scans/sec sustained.
- **A 30-minute continuous scan session** measuring battery drain, thermal throttling, and decode latency at minute 25 — not minute 2.
- Screen legibility checked in **actual direct sunlight** for sun mode, and in a genuinely dark room for truck mode.
- The whole feedback vocabulary operated **with the screen face-down**.

**Manual end-to-end rehearsals**, each done at least once before the vendor review:
- Airplane mode for a full pull session, close the app, reopen, reconnect — verify every scan lands exactly once and nothing double-applies.
- Two devices, both offline, both check out the same asset to different jobs — verify the local warning fires on the second, both events survive, and the desk gets an unresolved conflict.
- Fill the photo cache offline — verify capture blocks with the explicit message and **no un-uploaded original is ever evicted**.
- Corrupt/clear the local database mid-queue — verify the JSON-lines mirror recovers the outbox.
- A full return with three missing items and one damaged, through to the WhatsApp summary and the printed gate pass.
- Suspend a membership and confirm the device locks and clears on next connectivity.

**Then the vendor review.** Walk `docs/assumptions.md` with them item by item, and watch a real 6am pull before changing anything based on opinion.

---

## Critical files

- `~/Scrrenplay-papa/papa-rentals/src/styles.css` — tokens at lines 1–100, the source to extract into `packages/tokens`
- `~/Scrrenplay-papa/papa-rentals/src/components/icons.tsx` — the ~85-icon set to extract into `packages/icons`, with its no-emoji test
- `~/Scrrenplay-papa/papa-rentals/src/components/primitives.tsx` — the `Button`/`Chip`/`IconButton`/`SectionHeader` API to preserve and extend with a `density` prop
- `~/Scrrenplay-papa/papa-rentals/.claude/skills/papa-rentals/SKILL.md` — the WebView constraints and verify-against-the-built-bundle discipline the new repo's own SKILL.md should inherit
- New: `papa-vendor/CONTRIBUTING.md` — the four principles, "all writes go through RPCs", and the queue-is-a-DAG invariant, written on day one
