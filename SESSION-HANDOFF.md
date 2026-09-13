# Session handoff — for the next Claude (written by Fable 5.1, 2026-09-13, after W8)

You are picking up a long autonomous engineering run on **Papa Vendor**
at the end of its eighth wave. Read this file top to bottom before doing
anything. The working copy is `/mnt/windows/papa-vendor-work/papa-vendor`
(a clone made for this effort; the user's original at
`~/Scrrenplay-papa/papa-vendor` was deliberately never touched). Crew
worktrees live under `/mnt/windows/papa-vendor-work/wt-*` — do not touch
them. Everything below is true as of the head of branch `second-year`.

## Who you work for, and how to talk

The owner (Shaharyar, GitHub `swagofthenerd-gif`) is smart and
**non-technical**. Before committing/finishing anything significant, send
a plain-English account — no jargon, bad news first, numbers given
meaning, end with where things stand. This is codified in
`~/.claude/skills/no-bullshit/SKILL.md` and the repo's own
`.claude/skills/be-straight-up/SKILL.md`. Honor both. He has standing
orders: **"do not stop until all the phases are completed and tested
completely"** — the feature phases are complete; what remains is the
pipe, polish, and the human gates.

## The project in one paragraph

Papa Vendor is an offline-first inventory + operations app for film-gear
rental houses in Lahore. QR tags on gear, a thumb-driven scanner, a
WhatsApp-centric desk, an append-only evidence log, a full money book
(udhaar ledger + kharcha), a promise calendar with an exclusion
constraint, a pricing pipeline, and a partner network. Design identity:
**the challan book** — ledger-cream light theme (the default), carbon-copy
dark, rubber-stamp statuses, red margin rule, accountant's double
underlines, mono "typewritten" voice for codes/times/money. Master plan:
`docs/vendor-dream-plan.md` (phases now carry status marks). Lived
evidence: `docs/year-in-the-life.md` — a 12-month simulated vendor year
that runs as a permanent regression test
(`apps/app/test/year-in-the-life.test.mjs`), re-lived in W8 against every
shipped door. Honest gap ledger: `docs/production-readiness.md`.

## What has shipped (PRs #2–#20, all merged to main; 0001–0026 live)

- **Security hardening** (0015), **auth server side** (0016 — client NOT
  built), **money book** (0017), **jobs meet customers** (0018),
  **expenses / true profit** (0019), **fleet lifecycle** (0020),
  **living fleet** (0021).
- **W4/W5 bookings** (0022 server: exclusion constraint, gapless numbers,
  24h pencils, least-utilised allocation, credential gate,
  extension-collision list, convert-to-job; 0023 reservations sync; the
  client: Desk tab, calendar, booking page doors, extension sheet with
  Substitute / Sub-rent / Call, PROMISED stamp, overdue ladder).
- **W6 quoting** (0024 rate cards, org calendar with multipliers, weekend
  mask opt-in, logged overrides; 0026 rates sync; the client: Quote
  sheet, priced enquiry reply, Settings → Rates, golden text EN+UR).
- **W7 the network** (0025: partner houses, sub-hire in/out on the right
  books, crew on jobs, stolen broadcast, quote flags; the client: partner
  screens, Ask the market, sub-hire sheets, lend-out, thermal parchi
  bytes — golden-tested, hardware unverified).
- **W8 the second year** (this wave, branch `second-year`): the year test
  re-lived on the finished doors (pencil→confirm→convert, quotes with
  overrides and the season multiplier, substitute on extension collision,
  the real sub-hire door, thermal bytes, the day-14 rung, a stolen unit
  from the ginti with the broadcast); `applyImport` lifted out of
  `store.ts` (finding `import-apply-welded` retired; a duplicate-id
  rollback on a second import fixed); three stress files
  (`stress-bookings`, `stress-quoting`, `stress-network`); all docs
  refreshed. **No migration** — 0026 is still the last.
- **Also along the way**: challan-book UI, Roman Urdu string table with
  type-enforced parity, Capacitor Android APK with native ML Kit
  scanning, lookup mode, multi-session registry, parchi QR gate pass,
  Din ka hisaab, kit-list reader → job, WhatsApp nudges, scan void/undo,
  five steadiness principles (`docs/principles.md`).

## Current state — exactly

- Branch `second-year`, off `main` at `cb9ebfc` (every wave merged). Four
  W8 commits on top: the year + applyImport lift; the stress suite; the
  April sub-hire door with two new findings; the docs. **Pushed if the
  network allowed** — check `git status -sb`; if it says ahead of origin,
  push it (`git push -u origin second-year`). No PR was opened for W8
  (the lead decides).
- Gates at last full run (2026-09-13, on `second-year`): typecheck
  silent · **808 JS** · **31 e2e** (real Chromium, fake camera) ·
  **1,173 pgTAP** across 28 files (`==> all green`) · migrate harness
  `20 passed, 0 failed`. Run the db suites with your own container
  name/port: `PAPA_PG_CONTAINER=<name> PAPA_PG_PORT=<port>
  ./db/run-tests.sh` and `PAPA_PG_CONTAINER=<name>-migrate
  PAPA_PG_PORT=<other port> ./db/test-migrate.sh`. "postgres did not
  become ready" is a known flake — retry once.
- **Live Supabase DB** (project `evknfbkcszjdasjjwstw`, ap-southeast-1)
  has `0001`–`0026` applied. Every merge to main auto-deploys
  (`deploy.yml` + `SUPABASE_DB_URL`, the **session pooler** URL — the
  direct host is IPv6-only from GitHub runners) and re-proves tenancy.
- **Year findings** (the contract: ids live in the doc, never as failing
  asserts): 8 kept — `no-adjustment-door`, `no-deposit-door`,
  `no-blacklist`, `no-health-door`, `waived-fee-invisible`,
  `no-month-history-screen`, `no-lifetime-value-view`,
  `no-utilization-read` — all Phase B polish doors; 2 new —
  `sub-rent-intent-unreplayable` (the op has no RPC), `subhire-cost-
  unlinkable` (the cost link is made only at record time).

## THE ONE THING TO KNOW: the phone has no server connection

Say it to the owner exactly this plainly. There is **no auth client, no
sync, and no RPC call** in the app. Every feature — scans, bookings,
quotes, sub-hires — runs on the local demo store: an optimistic row in
the on-device mirror plus an outbox op *named after* the server RPC, with
the RPC's `p_*` arguments, chained in dependency order. The outbox has
never drained. The server side of all of it exists and is proven by
pgTAP; the two have never met. Until they do, the product is a
one-phone demo with no backup, not a pilot. `docs/production-readiness.md`
("the pipe — said plainly") is the reference.

## The remaining pipeline

Process for every wave: fresh branch off pulled main → background crew
with **commit-as-you-go** (host crashes and usage limits have hit this
run repeatedly; incremental commits are what saved it) → your own
verification → push → PR (a hook then REQUIRES a cdd-code-simplifier
agent pass over the PR diff before merge) → `gh pr merge N --merge` →
watch the "Deploy migrations" workflow → next wave. Crew briefs must
demand: strings in BOTH `strings.ts` and `strings-ur.ts`, challan-book
styling, glove targets/adjacency rules, no new deps, `packages/core`
untranspiled (no enums/decorators/namespaces), tests for everything,
year-test finding ids retired per the doc's contract when a gap closes,
injectable clocks (`Date.now` only as a default argument).

**W9 — the pipe.** In order, each verified before the next:
1. **Login**: OTP at enrolment → device session (0016's hashed session)
   → per-user PIN gate on the phone; wire `rate_limit_check` on the PIN
   path. A session store on the device; `papa.*` identity set per request.
2. **Pull sync**: the loop over `pull_changes` into `LOCAL_SCHEMA`'s
   mirror tables (the 0023 reservations and 0026 rates projections were
   built for exactly this; `buildPullList`/the read models already read
   the mirror's shape). Cursor persistence; the settle-lag semantics of
   0015; the PII guard means the phone never sees what it must not.
3. **Outbox drain**: send ops in `depends_on` order to the RPCs they are
   named after; map the server's minted ids back onto the mirror
   (`client_booking_id`, `client_job_id`, `client_sub_hire_id` ride in
   every payload for this); failure poisons the subtree as
   `packages/core/outbox.ts` already does. **Two year findings ride
   here**: give `sub_rent_intent` an RPC (a sub-hire-in that covers the
   other client's claim, then the extend) or take it out of the chain;
   add an attach-to-job door for a sub-hire's expense.
4. **Photo upload** to R2 (opaque keys, never signed URLs — CONTRIBUTING);
   the 24-month lifecycle rule is decided and not yet applied.
5. **On-device schema migration** for phones that already hold data.
6. **SQLCipher** must land before the first real phone holds real data
   (`device-key.ts` is the type-enforced seam).
Verify against the live project with a throwaway org; then the e2e
suite gains a "sync round-trip" test.

**W10 — polish.** Motion (`design-motion-principles`), the web-interface-
guidelines audit, the dark-theme pass, the conflict-row undo button
(`voidScan` exists), the payment sheet's date field, batch statements.

**B-polish week (after W9, before or inside W10).** The four money doors
the year still fakes — deposit hold/apply/refund, a general reversal /
write-off sheet with the double-tap guard, the blacklist toggle, a
waived-fee line — plus the month picker on the Hisaab, the lifetime
column on the owed list, and an earners leaderboard. Each is a sheet;
each retires a finding id.

**Human gates (owner; parallel with W9).** The 30-minute APK scan test on
a cheap Android; one rack of printed labels; the vendor afternoon
(`docs/assumptions.md` opens with the ten questions in order); one
parchi through the pilot house's receipt printer. Remind, don't nag.

## Standing decisions and traps (do not relearn these)

- PRs: never self-merge without authorization — the owner gave a
  standing "merge whatever" for this pipeline. Direct pushes to main are
  blocked by policy; always branch+PR.
- `db/fixtures.sql` disables RLS — TEST ONLY. Migrations 0001–0026 are
  applied history — never edit; new work = new migration, idempotent,
  RLS wrapped `(select current_org_id())`, writes only via SECURITY
  DEFINER RPCs with pinned `search_path`, pgTAP in `db/tests`,
  `db/test-migrate.sh`'s table count bumped if tables are added (47
  today, including the ledger table).
- The year test and the stress tests are deterministic (seeded,
  injectable clocks); never alter seeds. The year test clears the demo's
  placeholder Eid on day one so its quotes cannot depend on the run
  month; keep that.
- Money honesty: unpriced items are counted, never zero-priced; damage
  charges are khata money, never asset earnings; balances are
  projections of append-only entries; a sub-hire with no number writes
  no money row.
- One home per rule (`docs/principles.md` #4): pricing lives in
  `packages/core/pricing.ts` and mirrors 0024's `price_booking` step for
  step; booking rules in `packages/core/bookings.ts` + `demo/bookings.ts`;
  the status buckets in `status.ts`. Grep before adding a second copy.
- `applyImport` lives in `demo/read-model.ts` now; `store.ts` is a thin
  wiring layer and must stay one — new queries land in the read-model
  modules so they run under Node.
- Every booking write reads every booking (`pruneExpiredPencils`) and
  scans every pending outbox payload (`lastBookingOp`) — fine on a desk,
  noted in the year doc's papercuts; the pipe draining the outbox
  removes the second.
- ASSUMPTION-flagged guesses (42 rows) await the vendor afternoon;
  reference anchors in code, never numbers.
- The Papa Vendor vault (`~/PapaVendor-Vault`) is the thinking layer —
  `07-History/Session-Log.md` has an entry for every milestone including
  this one; write back on milestones. `~/.claude/skills/` has the design
  skills used for the challan identity.
- Dev demo: `cd apps/app && npx vite --port 5205` (localhost only;
  `xdg-open` for the user). Playwright is in-repo for screenshots —
  write temp .mjs in the repo root, delete after.
- Internet on this machine is intermittent: if `git push` fails, keep
  committing locally and say so.

## First moves on resume

1. `cd /mnt/windows/papa-vendor-work/papa-vendor && git checkout
   second-year && git status -sb` — push if ahead; verify gates
   (typecheck, `npm test`, db suites with your own container names).
2. Decide with the lead: PR `second-year` → simplifier pass → merge (no
   migration, so no deploy risk).
3. Brief the W9 crew from the "W9 — the pipe" list above and
   `docs/production-readiness.md`; give them a throwaway org on the live
   project.
4. Tell the owner where things stand, plainly: every feature is built and
   tested on the phone; the phone does not yet talk to the server; that
   is the next wave, and the three human gates can run alongside it.
