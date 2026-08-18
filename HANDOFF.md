# Papa Vendor — complete handoff

**Written 2026-08-14 for continuing entirely on a local machine.**
Everything about the product, the code, every decision and why, every trap, and
what to do next. If you read one file, read this one.

---

## 0. First five minutes

```bash
git clone https://github.com/swagofthenerd-gif/papa-vendor
cd papa-vendor
npm ci
npm run typecheck   # tsc, must be silent
npm test            # 180 assertions, must all pass
npm run test:sql    # 321 pgTAP assertions — needs docker or podman
```

**If you are a Claude session:** read `.claude/skills/be-straight-up/SKILL.md`
before writing any reply. The user is smart and is not a programmer. Plain
words, actions in bullet points, bad news first, recommendations not menus.

**Ground truth for status is `docs/production-readiness.md`.** It is an honest
ledger kept current with measured numbers. Keep it that way — it is the only
reason this project survived a lost machine and a dead session.

---

## 1. What the product is

Inventory and operations for **film-equipment rental houses in Lahore**. Every
item of gear carries a QR tag. Staff scan gear out and back. Inventory stays
live and accurate — **offline, one-handed, at 6am on a loading dock.**

Vendor-side companion to Papa Rentals (a marketplace). Ships standalone.

### Who uses it

| Role | Surface | Needs |
|---|---|---|
| Prep tech | Scanner (phone) | One screen. Scan. No menus, gloves, no signal. |
| Rental desk | Console (browser) | Quotes, holds, the day's board, conflicts. |
| Owner | Console + WhatsApp | Money. What's out, what's late, what didn't come back. |
| Client | **No login at all** | A WhatsApp link with their kit list and status. |

**Driver: nothing.** The vendor confirmed this. Only the **owner or the tech**
may confirm equipment logs.

### Why it will succeed or fail

**Not technology. Adoption.** These systems die when staff stop scanning, and
adoption is a **cliff, not a curve** — one busy morning of skipping poisons the
data, and once people stop trusting the numbers they walk to the shelf instead.

Read `~/PapaVendor-Vault/02-Domain/Adoption-Cliff.md` before proposing anything
that adds a step to the scan loop.

---

## 2. Where everything lives

| What | Where |
|---|---|
| Code | `github.com/swagofthenerd-gif/papa-vendor` (private) |
| Thinking/decisions | `github.com/swagofthenerd-gif/papa-vendor-vault` (private) |
| Shared design tokens/icons | `github.com/swagofthenerd-gif/papa-design` (public) |

```
apps/app/          the UI — ONE app, role decides the screen
packages/core/     the offline engine: scan, outbox, sync, kit list
packages/icons/    vendor glyphs on top of @papa/design
db/migrations/     0001–0014, plain PostgreSQL 16
db/tests/          321 pgTAP assertions
db/fixtures.sql    ⚠ TEST ONLY — see §7
db/bench/          the concurrent-write measurement
docs/              plan, architecture, readiness ledger, decisions
```

---

## 3. What is built, and what is not

### Built and tested
- **Tenancy** — every table row-level secured and FORCED, proven from inside
  the RPCs as a non-superuser, with cross-org leak tests both directions.
- **Asset model** — products, assets, tags, containment, bulk stock, kits, jobs.
- **Scan event log** — append-only, enforced by trigger *and* by withholding
  the grant. The projection rebuilds from it.
- **Write path** — `submit_scan_batch`, `bind_tag`, `intake_asset`. One
  transaction, ordered, idempotent per (device, seq).
- **Offline engine** (`packages/core`) — outbox with dependency cascade, sync,
  cursor-pull, optimistic projection, tested against real SQLite.
- **Dispatches** (`0013`, `0014`) — see §5.
- **WhatsApp kit-list reader** — see §6.
- **Guards** — PII sync guard, view/RLS assertion, icon names, maintenance
  health. See §4.
- **CI** — typecheck + 180 JS + real Vite build + all migrations + 321 pgTAP,
  on every push, against stock Postgres.

### NOT built
- **Authentication. Nobody can log in.** Phone OTP at enrolment → device
  session → per-user PIN. None of it exists.
- **The phone app.** Capacitor is anticipated in comments and the Vite config
  but **is not installed**. There is no Android build.
- **Device database encryption.** `packages/core/src/db/device-key.ts` makes it
  *unskippable* by type, but the driver it guards does not exist.
- **CSV import** of the vendor's existing catalogue. High value — the kit-list
  reader matches against *their* product names, so it is much better once real
  data is loaded.
- **Invoicing / pricing / rate cards.** Deliberately phase 3.
- **Bookings.** Phase 2. Availability today means "physically here now".
- **Photos.** No bucket wired, no upload path.
- **`scan_events` partitioning.** Blocked on a decision — see §8.

---

## 4. The four structural guards, and why they exist

Documentation rots. These do not.

1. **PII sync guard** (`0009`). A registry of column names that **may not exist
   on any syncable table**. Derived from the schema, so a table added to sync
   later is covered automatically. Fails the build.
   *Why:* `pull_changes` uses `select *` for six of eight tables. The day
   someone adds `customers` to `make_syncable()` — one routine-looking line —
   `cnic` would ship to every warehouse phone. Under PECA that is a breach.
2. **View/RLS assertion** (`0011` test). Every view must declare
   `security_invoker = true`.
   *Why:* Postgres views default to the **owner's** privileges, the owner is a
   superuser, and superusers bypass RLS. `sync_health` leaked every org's
   devices on the first pass. A view *reads* like a query, so the DEFINER trap
   everyone watches for in functions is nearly invisible here.
3. **Icon-name check** (`apps/app/test/icon-names.test.mjs`).
   *Why:* `Icon` falls back to a generic box for an unknown name instead of
   failing. Three names were already wrong and shipping as blank boxes —
   including **the torch**, the control a tech needs in a dark warehouse.
4. **Maintenance health** (`0012`). Every scheduled task records that it ran; a
   task that has **never** run reads as *overdue*, not absent.
   *Why:* a cron that silently stops looks exactly like one that works.

---

## 5. The scan-and-confirm model (the core decision)

### The problem
What stops staff simply not recording that gear went out? If they skip it, the
data rots silently and the vendor abandons the app.

### What was rejected, and why
- **A printed gate pass.** Was the plan. **Vendors have no printers.** Dead.
- **OTP per batch.** ~$0.47/segment to Pakistan — ~$473/mo at 100 customers for
  *logins alone*, 19× the entire infra budget. And a competitor's users were
  locked out *"for hours at a time, causing them to lose jobs"*.
- **A missed-scan report to the owner.** The documented **surveillance trap**:
  it makes staff scan the easy things and skip the hard ones, producing data
  that is *confidently wrong* — worse than knowing it is incomplete.
- **A driver signature.** The vendor says the driver does nothing, and it was
  weak anyway: a driver cannot verify 40 items in a sealed case at 6am, so he
  would sign whatever is on screen — evidence in appearance, fiction in
  substance.
- **Anything that can block a truck leaving.** The owner disables it the first
  time it does.

### What was decided
**The artefact is not the enforcement. The money is.** No deposit release, no
damage claim, no billing without a confirmed dispatch. The enforcer becomes the
**owner**, who has money at stake and is not the one being slowed down. It runs
at the desk, hours later — **never blocking a departure.**

**A job is a running tally, not one moment.** Each departure is a *dispatch*.
`18 of 40 out · rest to follow` is a fact, not a failure; the 2pm run is a
second dispatch on the same job. This kills the false-shortfall failure (a case
topped up at the client's site) that would otherwise train the tech to distrust
the numbers.

**Confirmation is graded, not boolean:**

| Strength | How |
|---|---|
| Weak | mostly `assumed` — bulk-confirmed case. Belief, not observation. |
| Normal | confirmed by `warehouse` (the tech) |
| Strong | confirmed by `owner`/`manager` — unlocks money actions |

`confirmed_by_role` is captured **at confirmation time**, because a person's
role can change later and this must describe the authority the assertion was
made *with*.

**Every dispatch records where the gear is going.** Required to confirm, never
to open — the tech may not know at 6am while the desk is still on the phone.
This is also what finally represents **gear leaving with no booking at all**
(the owner's nephew borrowing a light), which is disproportionately the gear
that goes missing. Without it the item reads "on the shelf" forever.

**Still to build here:** the handover summary card (composition, never
completion — `40 items · 34 scanned · 4 by case · 2 not accounted for`, with no
control that collapses those into one tick), and the money gate itself.

---

## 6. The WhatsApp kit-list reader

Paste a client's message → it extracts the items → checks availability → gives
a reply to paste back. `packages/core/src/kit-list.ts` and `availability.ts`,
screen at `apps/app/src/routes/Enquiry.tsx`.

**No AI, deliberately.** It costs money per paste forever, needs signal that
~28% of users do not have, and is unauditable — when it turns "FX9" into the
wrong body nobody can say why. Matching against the vendor's *own* catalogue
runs on the phone, offline, instantly, free.

**It never silently guesses.** Anything short of a confident match carries **no
applicable id** and waits for a tap. C300 and C500 differ by one character and
are never auto-matched.

Misspellings work through three mechanisms: length-relative edit distance; a
compact form so `FX-9`/`FX 9`/`FX9` are one camera; and a **uniqueness rule** —
a near-miss may be applied only when the client named the *whole* product and
nothing else is close. That is why "Sachdeva Tripod" resolves and "4 batteries"
does not.

---

## 7. Traps — read before touching anything

- **`db/fixtures.sql` is TEST ONLY.** It disables row-level security so pgTAP
  can seed data. Applied to a live database it removes tenancy. Never run it
  outside the test harness.
- **Migrations 0001–0014 are applied history. Never edit them — add 0015.**
- **Postgres views default to the owner's privileges.** Always
  `security_invoker = true`. Guarded, but know why.
- **`Icon` silently falls back to a box** for unknown names. Guarded.
- **There is NO device-side schema migration mechanism.** `LOCAL_SCHEMA` uses
  create-if-not-exists, so an installed phone never receives a schema change.
  This is why four unused indexes were kept rather than dropped — removal is
  free for new installs and unrecoverable on existing ones. **Build a migration
  path before the first real phone ships.**
- **`packages/core` must run untranspiled** under `node --test`: no parameter
  properties, enums, namespaces, decorators, no build step, no dependencies.
  That is why pure logic lives in `.ts` files (`status.ts`, `hold.ts`,
  `scan-row.ts`, `kit-list.ts`) and JSX stays in `.tsx`.
- **The eight unrolled blocks in `pull_changes` (0006) are deliberate.** DRYing
  them into dynamic SQL cost **89ms per poll**. Do not "simplify" them.
- **`scan_events` is append-only** by trigger *and* grant. Even superuser
  deletes are refused without explicitly disabling the trigger.
- **Do not let the money gate creep forward** into "you cannot finish the
  session until X". The moment it can stop a truck, it gets switched off.

---

## 8. Open decisions — these need the user

1. **`scan_events` partitioning.** The leading technical risk: append-only,
   never pruned, ~1.5bn rows/year at scale, and painful to retrofit. But
   partitioning forces the `(device_id, client_seq)` idempotency constraint to
   admit the partition key, which would let a retry across a month boundary
   **double-apply a check_out**. The obvious cheap fix (a per-device high-water
   mark) is **unsafe** — `outbox.ts` parks failed ops and steps over them, so
   gaps and out-of-order arrival are designed behaviour.
   **Full analysis and the two required decisions: `docs/partitioning-decision.md`.**
2. **Photo retention.** ~2GB per rental house per month, accumulating forever
   while revenue per customer stays flat. Decide 24 months (or whatever) before
   the pilot. Unbounded retention is the one cost line that runs away.
3. **Is there a handover ritual today** — does someone read the list at the
   truck? If yes we are replacing a habit (easy). If no we are creating one
   (hard), and the money side must carry more weight.

---

## 9. Money — the numbers that shape the design

| Line | Cost | Note |
|---|---|---|
| Supabase Pro | ~$25/mo | Singapore. Region cannot be changed later. |
| **SMS via Twilio** | **~$473/mo at 100 customers** | 19× everything else. Hence OTP at **enrolment only**. |
| Photos on R2 | ~$0 egress | vs $0.09/GB on Supabase Storage — **~$8,000/mo apart at 10,000 customers** |
| PITR | $100/mo | Deliberately deferred until revenue |

---

## 10. Measured performance

At 200 orgs / 400k assets / 283MB:

| Path | Result |
|---|---|
| Tag lookup (scan hot path) | **0.08ms** |
| Caught-up poll | **0.09ms** |
| First-sync page (2000 assets) | **68ms**, one-time per device |
| RLS function calls | **90ms → 13ms** on a 200k-asset org (`0008`) |

**Concurrent writes within one org:** it serialises on `org_sync_watermark`,
and the unit is the **batch**, not the statement — Postgres holds row locks
until COMMIT. ~1,900 scans/s per org against a real org's <5/sec is ~400×
headroom. A documented ceiling, not a wall. Harness: `db/bench/`.

**Scan loop:** cut from 9–10 database round trips to 5. On Capacitor SQLite
each statement is a bridge crossing at ~1–3ms, so statement *count* is the
budget.

---

## 11. What I would do next, in order

1. **Finish the hosting setup** — `docs/HANDOFF-hosting-setup.md`. Check first
   whether the schema is already loaded:
   `select count(*) from pg_tables where schemaname='public';` — ~23+ means done.
2. **Auth.** Nothing is usable without it. OTP at enrolment only.
3. **CSV import** of the vendor's catalogue. Makes the kit-list reader real,
   and it is the onboarding step everything else waits on.
4. **The Capacitor shell** + the SQLCipher driver. Encryption is unskippable by
   type; honour it.
5. **The handover summary + money gate** (§5).
6. **Partitioning**, once decided.

---

## 12. Two hard truths worth keeping

**Revocation is not instant.** Suspending a membership takes effect server-side
immediately, but an offline phone keeps working until it next reaches the
server, bounded by `device_sessions.expires_at`. Never claim instant revocation
for an offline-first app.

**An uninstall destroys unsent scans.** Outbox rows exist nowhere else — not
even the server learns they existed. Mitigated by flushing on any connectivity,
a JSON-lines mirror, and a stale-device alert with a name attached. **Not
solved.**

---

## 13. Session history

Full narrative in the vault's `07-History/Session-Log.md`. The short version:

- **2026-08-11** — research, architecture, two adversarial reviews, plan.
- **2026-08-12** — Phase 0 through the scanner shell; hosting decided.
- **2026-08-14** — this session. Measured the write path. Added the four
  guards. Built dispatches, destination, and the kit-list reader. **Fixed six
  live bugs found by review rather than by failing tests**: a rewinding pull
  cursor, a pull that erased the tech's own scan timestamp, a cross-org leak in
  `sync_health`, and three blank icons including the torch.

**The pattern behind most of those bugs:** a rule lived in two places and the
copies drifted, or a value was written without comparing it to what was already
there. Worth hunting for more of both.

---

## 14. The demo (added 2026-08-18)

**`npm run dev`, open http://localhost:5173** — a working scanner with no
login, no server, and nothing to pay for.

It exists because ten weeks of correctness work had landed with no surface on
top of it, so nobody — including the owner — had ever used the scan loop. It
is not a mock of the engine: `ScanSession`, the outbox, the pull list, the
local double-checkout check and the kit-list reader are the real ones from
`packages/core`, running against real SQLite in the browser. Only the SERVER
is missing, which shows honestly as scans that queue and never send.

| Where | What |
|---|---|
| `apps/app/src/demo/seed.ts` | The demo house — 77 tagged items, 3 jobs, 6 shelves |
| `apps/app/src/demo/sqljs-driver.ts` | `SqlDriver` over sql.js |
| `apps/app/src/demo/store.ts` | Holds the database and the open scan session |
| `apps/app/src/camera/QrCamera.tsx` | Camera + QR decode |
| `apps/app/src/demo/Tags.tsx` | The labels, as QR codes (`#/settings`) |

### Four things worth knowing

- **The demo database is in memory and is lost on refresh.** Tag codes are
  therefore generated from a FIXED SEED, so a label printed today still scans
  tomorrow. Do not make them random.
- **`BarcodeDetector` does not exist in Chrome on Linux or Windows** — only on
  Android, ChromeOS and macOS. The camera falls back to jsQR there and labels
  the viewfinder "Desk decoder". Without that fallback the demo shows a live
  picture and decodes nothing on the machine it is being shown from.
- **sql.js is CommonJS and must go through Vite's pre-bundling.** Putting it in
  `optimizeDeps.exclude` produces a blank page.
- **The camera needs a secure page.** localhost counts; a LAN address does not.
  `npm run dev:https` serves over https with a self-signed certificate for
  testing on a phone — the phone warns about the certificate once.

### Phase 1 screens, added 2026-08-18

The shell (top bar + tab bar), Today, the search-first Gear list, the asset
page, and the handover summary. Then condition photos with the out/in
comparison, and the CSV catalogue import.

Then check-in (a return reconciled against what is physically out, not against
the job's list), attaching a printed label to gear, and printing the labels.

Then the case manifest (override #1 - a case scan records the case, never its
packed contents), and an end-to-end check that drives a real Chromium with a
QR code faked as its camera.

What phase 1 still lacks: intake-by-scan (adding gear the catalogue has never
heard of, from the rack) and the owner's daily digest. Phases 2-5 untouched.

### What it does NOT prove

Nothing about the real device. The performance budget (decode→feedback under
100ms, ≥2 scans/sec sustained, battery and thermals at minute 25) is measured
on a cheap Android through Capacitor and ML Kit, neither of which exists yet.
A laptop webcam through jsQR is not that measurement and must never be quoted
as it.
