# Session handoff — for the next Claude (written by Fable 5, 2026-09-13)

You are picking up a long autonomous engineering run on **Papa Vendor**
mid-pipeline. Read this file top to bottom before doing anything. The
working copy is `/mnt/windows/papa-vendor-work/papa-vendor` (a clone made
for this effort; the user's original at `~/Scrrenplay-papa/papa-vendor`
was deliberately never touched). Everything below is true as of commit
`46b6892` on branch `bookings-server`.

## Who you work for, and how to talk

The owner (Shaharyar, GitHub `swagofthenerd-gif`) is smart and
**non-technical**. Before committing/finishing anything significant, send
a plain-English account — no jargon, bad news first, numbers given
meaning, end with where things stand. This is codified in
`~/.claude/skills/no-bullshit/SKILL.md` and the repo's own
`.claude/skills/be-straight-up/SKILL.md`. Honor both. He has standing
orders: **"do not stop until all the phases are completed and tested
completely"** — you are mid-way through executing that.

## The project in one paragraph

Papa Vendor is an offline-first inventory + operations app for film-gear
rental houses in Lahore. QR tags on gear, a thumb-driven scanner, a
WhatsApp-centric desk, an append-only evidence log, and now a full money
book (udhaar ledger). Design identity: **the challan book** — ledger-cream
light theme (the default), carbon-copy dark, rubber-stamp statuses, red
margin rule, accountant's double underlines, mono "typewritten" voice for
codes/times/money. The strategic thesis: phase 1 answered "where is my
gear?", the current era answers "where is my money?", the endgame is the
cross-house network. Master plan: `docs/vendor-dream-plan.md`. Lived
evidence: `docs/year-in-the-life.md` (a 12-month simulated vendor year
that runs as a permanent regression test:
`apps/app/test/year-in-the-life.test.mjs`).

## What has shipped (PRs #2–#14, all merged to main, all deployed)

- **Security hardening** (0015): projection forgery closed, PIN hashes
  unreadable, role gates DB-enforced, PII sync guard pattern-based,
  settle-lag sync hole fixed, projection row locks.
- **Auth** (0016): OTP-at-enrolment, hashed device sessions, PIN gate,
  revocation, device-binding in submit_scan_batch. Design:
  `docs/auth-design.md`. Client integration NOT built yet.
- **Money book** (0017): customers, append-only customer_ledger_entries,
  deposits state machine (refund gated on shortfalls), credentials,
  khata page / owed list / Today money strip / charge-from-dock /
  late-fee drafts / per-asset earnings + payback bar.
- **Jobs meet customers** (0018): customer picker on job creation,
  close/reopen job (gear-still-out gate), ledger reversal_of,
  asset_earnings = rental money only.
- **Expenses / true profit** (0019): org_expenses (kharcha), job margin,
  asset cost history, monthly profit in Din ka hisaab.
- **Fleet lifecycle** (0020): disposition lost|stolen|sold|retired via
  scan events, loud stolen tag pages, theft report card, atomic swap
  flow, ginti (cycle count) with diff report.
- **Living fleet** (0021): service-by-usage meters + serviced event +
  service log, battery cycle ceilings (alert, never auto-state), dead
  stock view, Sehat surface, awaaz (voice) notes on the photos storage
  model.
- **Also shipped along the way**: challan-book UI (light default), Roman
  Urdu string table (`strings-ur.ts`, full parity type-enforced, switch
  in Settings), Capacitor Android APK with native ML Kit scanning +
  haptics/tones + a long-press perf instrument
  (`apps/app/android/.../app-debug.apk`), vendor conveniences (lookup
  mode, multi-session registry, parchi QR gate pass, Din ka hisaab,
  kit-list reader → job creation, WhatsApp nudges), scan void/undo,
  five steadiness principles (`docs/principles.md`), stress suite
  (`stress-*.test.mjs`, seeded-deterministic).

## Current state — exactly

- Branch `bookings-server` (pushed to origin, **NOT yet PR'd**), 3 commits
  ahead of main: migration **0022_bookings** — bookings/lines/
  asset_reservations with the gist EXCLUSION CONSTRAINT (double-booking
  physically impossible, confirmed-only; pencils never block), gapless
  booking_no, pencil holds (ASSUMPTION 24h TTL, assumptions.md #hold-ttl),
  least-utilized allocation, credential gate, extend_booking → structured
  collision list, convert_booking_to_job, booking_availability
  three-layer function. 103 new pgTAP. Phone sync of reservations
  deliberately deferred to the client wave (migration note D13).
- Gates at last full run: typecheck clean · **611 JS** · **16 e2e** ·
  **~900 pgTAP** (suite-wide) · migrate harness 20/20.
- **Live Supabase DB** (project `evknfbkcszjdasjjwstw`, ap-southeast-1)
  has migrations 0001–**0021** applied. 0022 deploys automatically when
  the branch merges (deploy.yml + `SUPABASE_DB_URL` secret, which is the
  **session pooler** URL — the direct host is IPv6-only and unreachable
  from GitHub runners). Every merge to main auto-deploys and re-proves
  tenancy.
- Task tracker (in-session; recreate if lost): W1-W4 complete, W5-W8
  pending.

## The remaining pipeline — waves 5–8 (specs)

Process for every wave: fresh branch off pulled main → background crew
with **commit-as-you-go** (host crashed 3× and hit usage limits 2× this
run; incremental commits are what saved it) → your own verification →
push → PR (a hook then REQUIRES a cdd-code-simplifier agent pass over the
PR diff before merge) → `gh pr merge N --merge` → watch the "Deploy
migrations" workflow → update tracker → next wave. Known flake:
`./db/run-tests.sh` sometimes fails "postgres did not become ready"
(port-teardown race) — retry once. Crew briefs must demand: strings in
BOTH `strings.ts` and `strings-ur.ts` (parity is type-enforced + guarded),
challan-book styling conventions, glove targets/adjacency rules, no new
deps, packages/core untranspiled (no enums/decorators/namespaces), tests
for everything, year-test finding-ids retired per the doc's contract when
a gap is closed.

**W5 — Bookings client.** Consume 0022's RPCs (signatures + error codes
are documented in the migration header and the W4 crew report — 23P01 =
"already promised to booking #N", 23514 carries honest shortfall math).
Build: three-layer availability calendar (here-now/pencilled/confirmed)
with wedding-season shading; booking creation from enquiry + walk-in;
pencil rows with expiry countdowns (expiry computed client-side —
CONTRIBUTING hard rule); THE extension-collision preview screen (the
structured collision list → three doors: sub-rent / substitute / call);
scanner warning when an asset is promised soon (this is where the
deferred slim sync projection ships, schema+consumer together); overdue
escalation ladder wiring. Retire the year's `no-bookings`
double-promise finding: NOV must become IMPOSSIBLE in the year test.

**W6 — Quoting.** Migration 0023: rate_cards + entries,
week_equals_days=3 (ASSUMPTION), org holiday/season calendar with rate
multiplier (ASSUMPTION — seasonal pricing practice unverified), logged
manual overrides (PLAN override #18). Client: the kit-list/enquiry reply
becomes a real priced quote (per-line rates, 3-day-week math, seasonal
multiplier, indicative → real), margin-before-quote (net of sub-hire
costs from the kharcha book), quote text golden-tested EN+UR.

**W7 — The network.** Partner-house list; "Ask the market" formatted
WhatsApp broadcast from shortage screens; record sub-hire in/out tying to
org_expenses; stolen-gear public page already flips (0020) — add the
broadcast card; verified-client fast lane surfaced on quotes (0017's
verified_customers view); attendant assignment on jobs (ASSUMPTION);
ESC/POS thermal parchi byte-stream builder (golden-test the bytes;
hardware untestable — document).

**W8 — The second year + ship.** Re-live the simulated year against the
finished app (double-promise impossible, swap/theft/ginti/expenses/
bookings/quotes all real); extend the stress suite over
bookings/quoting; full gate sweep; update `docs/vendor-dream-plan.md`
(phases marked done) + `docs/production-readiness.md`; final plain-
English account to the owner.

## Standing decisions and traps (do not relearn these)

- PRs: never self-merge without authorization — but the owner gave a
  standing "merge whatever" for this pipeline; merges have been fine
  since. Direct pushes to main are blocked by policy; always branch+PR.
- `db/fixtures.sql` disables RLS — TEST ONLY. Migrations 0001–0021 are
  applied history — never edit; new work = new migration. 0022 is
  editable until merged.
- The year test and stress tests are deterministic (seeded, injectable
  clocks — `Date.now` is banned in their logic); never alter seeds.
- Money honesty rules: unpriced items are counted never zero-priced;
  damage charges are khata money, never asset earnings; balances are
  projections of append-only entries.
- ASSUMPTION-flagged guesses (pencil TTL, buffers, seasonal pricing,
  attendant custom, rates in seed) await the owner's **vendor
  afternoon**; docs/assumptions.md is the ledger of guesses.
- Human gates still open with the owner: the 30-minute APK scan test on
  a cheap Android, printing one rack's labels (wear clock), the vendor
  afternoon. Remind, don't nag.
- The Papa Vendor vault (`~/PapaVendor-Vault`) is the thinking layer —
  its `07-History/Session-Log.md` has entries for this whole run; write
  back on milestones. `~/.claude/skills/` has the design skills
  (frontend-design etc.) used for the challan identity.
- Dev demo: `cd apps/app && npx vite --port 5205` (localhost only;
  `xdg-open` for the user). Playwright is in-repo for screenshots —
  write temp .mjs in repo root, delete after. The in-app preview
  harness's screenshot path is unreliable; Playwright is the way.

## First moves on resume

1. `cd /mnt/windows/papa-vendor-work/papa-vendor && git checkout
   bookings-server` — verify gates still green (typecheck, npm test,
   db suite with one retry allowance).
2. PR bookings-server → simplifier pass (hook will demand it) → merge →
   watch deploy → confirm 0022 live.
3. Recreate the task tracker (W5–W8) and launch the W5 crew.
4. Tell the owner where things stand, plainly.
