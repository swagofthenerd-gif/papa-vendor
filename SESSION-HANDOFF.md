# Session handoff — for the next Claude (written by Fable 5.1, 2026-09-13, after W11)

You are picking up a long autonomous engineering run on **Papa Vendor**
after its eleventh wave. Read this file top to bottom before doing
anything. The working copy is `/mnt/windows/papa-vendor-work/papa-vendor`
(a clone made for this effort; the user's original at
`~/Scrrenplay-papa/papa-vendor` was deliberately never touched). Crew
worktrees live under `/mnt/windows/papa-vendor-work/wt-*` (`wt-network`
has `node_modules`; `wt-quoting` does not). Everything below is true as
of the head of branch `every-write-crosses` (PR #24 → main).

## Who you work for, and how to talk

The owner (Shaharyar, GitHub `swagofthenerd-gif`) is smart and
**non-technical**. Before committing/finishing anything significant, send
a plain-English account — no jargon, bad news first, numbers given
meaning, end with where things stand. This is codified in
`~/.claude/skills/no-bullshit/SKILL.md` and the repo's own
`.claude/skills/be-straight-up/SKILL.md`. Honor both. His standing order
was **"do not stop until all the phases are completed and tested
completely"** and, on resume, **"go as big as you want — any idea that
makes the experience better is welcome"**. The feature phases, the pipe
and the polish are complete; what remains is hosting setup, the Android
device wave, and the human gates.

## The project in one paragraph

Papa Vendor is an offline-first inventory + operations app for film-gear
rental houses in Lahore. QR tags on gear, a thumb-driven scanner, a
WhatsApp-centric desk, an append-only evidence log, a full money book
(udhaar ledger + kharcha), a promise calendar with an exclusion
constraint, a pricing pipeline, a partner network — and, since W9, a
real pipe to the server (enrol, PIN gate, sync loop, exactly-once
replay). Design identity: **the challan book** — ledger-cream light
theme, carbon-copy dark, rubber-stamp statuses, red margin rule, mono
"typewritten" voice for codes/times/money; W10 added purposeful motion
(sheets with drag-to-dismiss, a sliding tab pill, stamps that land once).
Master plan: `docs/vendor-dream-plan.md`. Lived evidence:
`docs/year-in-the-life.md` (a 12-month simulated year, re-lived on every
door; permanent regression test). Honest gap ledger:
`docs/production-readiness.md`. The pipe's contract: `docs/the-pipe.md`;
the PostgREST contract: `docs/hosting-decision.md`. UI audit:
`docs/ui-audit-2026-09.md`.

## What has shipped (PRs #2–#24; migrations 0001–0028)

- Security hardening (0015), auth server (0016), money book (0017), jobs
  meet customers (0018), expenses / true profit (0019), fleet lifecycle
  (0020), living fleet (0021).
- **W4/W5 bookings** (0022 server; 0023 reservations sync; the Desk tab,
  calendar, booking page, extension-collision sheet, PROMISED stamp,
  overdue ladder). Nav is **Today · Gear · Desk · Khata** with Settings
  behind the top-bar glyph.
- **W6 quoting** (0024 rate cards + org calendar + logged overrides,
  weekend mask opt-in; 0026 rates sync; Quote sheet, priced enquiry
  reply, Settings → Rates).
- **W7 the network** (0025 partner houses, sub-hire in/out on the right
  books, crew on jobs, stolen broadcast, quote flags; partner screens,
  Ask the market, sub-hire sheets, thermal parchi bytes golden-tested).
- **W8 the second year** (year re-lived, stress suites for bookings /
  quoting / network, docs, the vendor-afternoon checklist).
- **W9 the pipe** (0027 members sync + `replay_op` receipts:
  PostgREST transport with `x-papa-session`, strict-order dispatcher with
  id mapping, poison rule as one card per refusal, `SyncLoop`, Enrol /
  PIN gate / This phone screens, on-device schema migration ladder,
  upload seam, `npm run test:pipe` against real containers).
- **W10 polish** (sheet motion + drag-to-dismiss, tab pill, stamp
  landing, 512 touch targets to the 48px floor, 80 contrast fixes,
  overflow root cause, empty states everywhere, seven papercuts).
- **W11 every write crosses** (0028: `create_customer`, `create_job`,
  `set_job_expected_back`, `set_booking_note`, `orgs` mirror, `job_margin`
  second edition; every ledger/expense/job write enqueues an op; the two
  W8 walls closed; 14 pipe scenarios).

## Current state — exactly

- Gates at last full lead run (2026-09-13, `every-write-crosses` merged
  with `main`): typecheck silent · **900 JS** · **36 e2e** · **14 pipe**
  scenarios · **1,249 pgTAP** (30 files) · migrate `20 passed`.
- **Live Supabase DB** (project `evknfbkcszjdasjjwstw`, ap-southeast-1)
  has `0001`–`0027` applied; `0028` deploys with PR #24's merge. Every
  merge to main auto-deploys (`deploy.yml` + `SUPABASE_DB_URL`, the
  **session pooler** URL) and re-proves tenancy.
- **Live PostgREST is NOT configured on Supabase yet.** The pipe is
  proven against local containers only. To go live the host needs:
  `db-pre-request = public.auth_pre_request`, `db-anon-role = papa_app`,
  the `papa_authenticator` login role, and an SMS transport for
  `request_otp` (papa_auth-only). See `docs/hosting-decision.md`, "The
  PostgREST contract (W9)". On Supabase this may need their support or a
  self-hosted PostgREST in front of the pooler — decide with the owner.
- **Year findings kept** (all Phase-B polish doors, explained in the doc):
  `no-adjustment-door`, `no-deposit-door`, `no-blacklist`,
  `no-health-door`, `waived-fee-invisible`, `no-month-history-screen`,
  `no-lifetime-value-view`, `no-utilization-read`.
- No phone has run live mode over a real network. The browser build keeps
  the session token in memory (sql.js); the Capacitor SQLite + SQLCipher
  driver is the device wave.

## The remaining pipeline (proposed; the owner decides)

- **W12 the device wave**: Capacitor SQLite driver behind `SqlDriver`,
  SQLCipher key via `device-key.ts` (type-enforced), session token at
  rest, Bluetooth SPP for the thermal parchi behind `ThermalPrinter`,
  the APK rebuilt, the 30-minute scan test on a cheap Android in
  live mode.
- **Hosting setup** (non-code, with the owner): PostgREST config, SMS
  transport (edge function calling `request_otp`), R2 signed-URL
  provider behind `Uploader`, PITR at first revenue.
- **The money doors** (kept findings): deposit door on the phone,
  adjustment/write-off door, blacklist toggle, health toggle, waived-fee
  rendering, month history, lifetime value, utilisation read — each a
  small screen on existing server doors.
- **Ledger backdating on the server**: `record_ledger_entry` has no
  timestamp argument (ASSUMPTION `#ledger-server-time`); a 0029 signature
  edition if the vendor afternoon says backdating matters.

Process for every wave: fresh branch off pulled main → crew with
commit-as-you-go (a session usage limit killed a crew once; the scratchpad
is wiped on restart, so briefs must be re-creatable from the vault) →
the lead's OWN gate run (typecheck, `npm test`, `build:app && test:e2e`,
db suites with your own `PAPA_PG_CONTAINER`/`PAPA_PG_PORT`, `test:pipe`
when the pipe is touched) and a look at the crew's Playwright screenshots
→ push → PR → a simplification pass over the diff → merge → watch the
deploy → vault entry → plain-English account.

## Standing decisions and traps (do not relearn these)

- PRs: the owner gave a standing "merge whatever" for this pipeline.
  Direct pushes to main are blocked by policy; always branch+PR.
- `db/fixtures.sql` disables RLS — TEST ONLY. Migrations 0001–0028 are
  applied history — never edit; new work = new migration, idempotent,
  RLS wrapped `(select current_org_id())`, writes only via SECURITY
  DEFINER RPCs with pinned `search_path`, pgTAP in `db/tests`,
  `db/test-migrate.sh`'s table count bumped if tables are added.
  `pull_changes` is at its ELEVENTH edition (0028): a new edition is the
  previous one verbatim plus the addition, and the key-count assertions
  in 0023/0026/0027 tests move with it.
- The year test and the stress tests are deterministic (seeded,
  injectable clocks); never alter seeds. The year test clears the demo's
  placeholder Eid on day one; keep that.
- Money honesty: unpriced items are counted, never zero-priced; damage
  charges are khata money, never asset earnings; balances are projections
  of append-only entries; a sub-hire with no number writes no money row;
  every day bills unless a card opts the weekend out.
- One home per rule (`docs/principles.md` #4): pricing in
  `packages/core/pricing.ts` mirrors 0024 step for step; booking rules in
  `packages/core/bookings.ts` + `demo/bookings.ts`; share-to-WhatsApp in
  `apps/app/src/share.ts`; ops/re-key columns in `demo/ops.ts`; the
  sheet in `components/Sheet.tsx`. Grep before adding a second copy.
- The pipe: every write that leaves the phone is an outbox op named
  after its RPC with `p_*` args and `client_*` ids; the dispatcher strips,
  rewrites and replays through `replay_op` (exactly-once per device); a
  refusal parks the op and its dependants as ONE card. Never bypass it.
- `store.ts` is a thin wiring layer; new queries land in the read-model
  modules (`demo/*.ts`) so they run under Node.
- ASSUMPTION-flagged guesses (49 rows) await the vendor afternoon; the
  checklist is at the top of `docs/assumptions.md`; reference anchors in
  code, never numbers.
- The Papa Vendor vault (`~/PapaVendor-Vault`) is the thinking layer —
  `07-History/Session-Log.md` has an entry for every milestone; write
  back on milestones.
- Dev demo: `cd apps/app && npx vite --port 5205`. Playwright is in-repo
  for screenshots — temp .mjs in the repo root, deleted after. Pipe proof:
  `npm run test:pipe` (podman; `./db/pipe-down.sh` clears a stale pod).
- Internet on this machine is intermittent: if `git push` or `gh` fails,
  keep committing locally and retry.
- Test scripts honour `PAPA_PG_CONTAINER` / `PAPA_PG_PORT`; two suites at
  once on the defaults collide. "postgres did not become ready" is a
  known flake — retry once on a fresh name/port.

## First moves on resume

1. `cd /mnt/windows/papa-vendor-work/papa-vendor && git checkout main &&
   git pull` — verify PR #24 merged and `0028` deployed (`gh run list
   --workflow "Deploy migrations" --limit 1`).
2. Run the gates once on main (own container names; `test:pipe` too).
3. Read the vault's last session-log entry and `docs/production-readiness.md`'s
   final sections; then propose the next wave to the owner in plain
   English (the device wave and the hosting setup are the ones that make
   a pilot possible) and wait for the human gates' results.
