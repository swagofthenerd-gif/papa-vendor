# A year in the life — findings from twelve simulated months

Executable source: `apps/app/test/year-in-the-life.test.mjs` — a scripted
September-to-August of a Lahore rental house driven through the real seams
(seed, ScanSession, outbox, ledger, read models) on a controlled clock.
Every finding below carries the id the test pins it under; if a feature
ships and a wall comes down, remove the id there and the section here in
the same change. The simulation is green and must stay green: findings
live in this document, never as failing asserts.

Written 2026-09-11 against branch `year-hardening`. **Re-lived 2026-09-13
on `second-year` (W8)** against every merged wave — bookings, quoting,
the network — so the story now walks through the doors a vendor would
use: see [The second year](#the-second-year-w8) at the end. Cross-
references are to [`vendor-dream-plan.md`](vendor-dream-plan.md) phases
A–E.

---

## (a) Bugs found, with repro

Sections here are removed as their bugs are fixed (per the contract above);
each fix leaves a one-line record and the test now pins the CORRECT
behaviour where the wall used to be.

### 1. Two cameras answering to one code after an import — FIXED

Was `duplicate-asset-code`: the CSV import derived unit codes as `CODE-01`,
`CODE-02`… per file, so importing `Sony FX9,1,FX9` beside a seeded `FX9-01`
minted a second asset with the same visible sticker code. Fixed:
`allocateUnitCodes` (`packages/core/src/csv-import.ts`) collision-checks the
file's codes against every code already on an asset and **continues
numbering** (`FX9-03`), and the import result screen says honestly how many
codes were renumbered. (SEP block now pins uniqueness.)

### 2. The late-fee draft collapses to zero if the gear is scanned in first — FIXED

Was `latefee-after-scan-zero`. `lateFeeDraftFor` (now a pure read in
`khata.ts`, testable under Node) prices the union of what is still out
and what **came back in the job's most recent return session**, and the
days-late clock freezes at the last check-in scan — so the natural dock
order (scan in first, open the sheet second) shows the same Rs 84,000,
and the fee stops growing while the sheet sits open. (OCT block pins the
held draft.)

### 3. A mis-scan cannot be undone; the repair writes false history — FIXED

Was `no-scan-undo`. `voidScan` (`packages/core/src/scan.ts`) is the
scan-side sibling of the ledger's `reversal`: a `void_scan` op names the
outbox id it voids and queues BEHIND it (`depends_on`), so append-only
stays intact and a server can never see a void for a scan it has not
received. The projection re-derives the asset's state from the remaining
unvoided ops, and `decodeScanOps` skips voided ops once for every reader
— history, summaries, hisaab. No fabricated round-trip. (NOV block pins
the one-op undo; a UI affordance on the conflict row is follow-up — the
mechanism exists via `store.voidScan`.)

### 4. The debt clock resets on a bounced cheque — FIXED

Was `debt-age-resets-on-bounce`. The ledger now has a `reversal` kind
that NAMES the entry it voids (`reversal_of` — client-side column, and
as of migration 0018 the server ledger too: same-org/customer validated,
exact-negation enforced, once per target, mutually exclusive with
`corrects_entry_id`). `oldestUnpaidMs` skips a reversal and its target
as a pair — they cancel in time as well as in money — so "owed since"
keeps pointing at the original charge, and the statement prints
*reversed*, never *adjustment*, for a bounce the house did not cause.
(MAY block pins the surviving clock; `0018_jobs_meet_customers_test.sql`
pins the server rules.) The `no-adjustment-door` finding stands: outside
the charged-then-returned notice, no screen writes a reversal yet.

### 5. The payback bar counts damage recovery as earnings — FIXED

Was `payback-counts-damage`. `assetEarnings` now sums rental money only
(`charge + late_fee`); damage stays on the customer's khata but never
inflates the asset's bar, and — POLICY (owner may overrule) — a charge a
`reversal` later voided stops counting too, so a charged-then-returned
item keeps no phantom earnings. The server's `asset_earnings` view
matches since migration 0018: `damage_charge` is out, and so is anything
corrected or reversed — one figure, both sides. (JAN and MAR blocks pin
the honest figure; `khata.test.mjs` and the 0018 pgTAP suite pin the
exclusions on their respective sides.)

### 6. Same-millisecond ledger ties can flip the running balance — FIXED

Was the papercut-grade re-sort flip. `LedgerEntryView` now carries `seq`
(rowid, insertion order) and every pure re-sort — `oldestUnpaidMs`, the
balance card, the statement — breaks `createdAt` ties with it, exactly as
`rowsFor`'s SQL always did. A same-millisecond charge/payment pair keeps
its written order and the owed-since clock cannot jump. (Pinned in
`khata.test.mjs`.)

### 7. The clock is welded shut in three places — FIXED

Was `clock-welds`. All four welds are out: `Outbox` takes an injectable
clock and `ScanSession` hands its own `now` down, so a queued row's
`created_at` agrees with its payload's `device_time`; `SessionRegistry`
takes a clock and passes it into every session it opens (the year
simulation now drives the REAL registry); `recordPayment` / `chargeClient`
/ `recordLateFee` accept `whenMs`, so **money can be backdated** —
"the client paid me yesterday" is now a statable fact (a date field on the
payment sheet is UI follow-up); and `stats(nowMs)` can be asked about
another day. (SEP block pins the registry and outbox stamping the
simulated instant.)

### 8. A second import of the same file collided on its own ids — FIXED (W8)

Found while lifting `applyImport` out of `store.ts` (see (b)10): product
and asset ids were minted from the row's name and line number
(`prod-imported-<slug>-0`, `asset-imported-<slug>-<line>-<n>`), so
importing a file twice — or a second file whose product sat on the same
line as an earlier one — hit the primary key and rolled the whole
transaction back with nothing to say for itself. Ids are now made unique
against the table (`-2`, `-3`… on collision); the year imports twice
through the real routine and both land. (SEP + APR pin it.)

---

## Policy defaults adopted (the stress tests' product questions)

The hammer/stress runs raised four product questions; each now ships a
default, flagged `POLICY (owner may overrule)` at the code site, and the
tests pin the default instead of the accident.

- **Charged-then-returned — RESOLVED-with-default.** When a check-in scan
  lands for an asset with an uncorrected `charge`/`damage_charge` naming
  that asset+job, the khata and the session summary surface a
  NEEDS-A-DECISION notice ("Charged Rs X for FX9-02 on Job Y — it came
  back. Reverse?") with a one-tap correction draft behind a confirm tap —
  **never an auto-reverse** ("we keep the money anyway" is a real
  answer). Reversed charges are out of asset earnings on BOTH sides now
  (client `assetEarnings`; server `asset_earnings` since 0018).
  (`chargedButReturned` / `recordReversalOf` in `demo/khata.ts`; pinned
  in `stress-money.test.mjs`.)

- **Rescan-after-restart duplicate history rows — RESOLVED-with-default.**
  The write stays (append-only truth; the per-session dedupe honestly
  dies with the process), but the asset history view collapses
  consecutive same-event/same-job rows into one row with a "×2" marker
  (`collapseHistory` in `demo/read-model.ts`; pinned in
  `stress-registry.test.mjs`).

- **Negative balance (the house owes the client) — RESOLVED-with-default.**
  The balance card and the khata page say it plainly — "You owe them
  Rs X" / "Aap ke zimme Rs X" — never "Nothing owed": hiding the house's
  own debt is the confident lie in mirror image (`houseOwes` on
  `KhataStrings`; pinned in both languages in `khata.test.mjs`).

- **`write_off` kind — RESOLVED-with-default.** The client-side kind list
  and both string tables know `write_off` ("write-off" / the loanword
  "write off"), so a synced server write-off renders as a word instead of
  leaking snake_case — and February's absconded client is no longer an
  anonymous `adjustment` indistinguishable from a discount. No screen
  writes it yet (`no-adjustment-door` stands). POLICY comment at the kind
  union in `packages/core/src/ledger.ts`; the was-`write-off-illegible`
  finding is retired.

## (b) Missing features, ranked by how often the year hit the gap

Ranked by number of months the simulation ran into the wall, worst first.
Phase letters refer to `vendor-dream-plan.md`.

### 1. Jobs cannot be closed, and desk jobs have no customer — SHIPPED as B0

Was `no-close-job`, `no-customer-on-desk-job`, `no-add-customer` — the
year's worst wall, hit every single month, and the reason the money book
only worked for seeded customers. Phase B0 shipped the trio end to end:
the new-job sheet takes a customer (existing, or typed inline — the
nephew case stays legal and says its cost out loud); the link lives on
`jobs.customer_id`, the real 0017 column, synced to devices by 0018;
`close_job`/`closeJob` end a job only when nothing still projects onto
it (the refund gate's own `gear_still_out` predicate, enforced server-
side by RPC + trigger, mirrored exactly on-device), reopen is
owner/manager and audited, and closed jobs leave both boards but stay
reachable — dated, khata-linked, reopenable — behind a "Closed jobs"
door on the search surface. The simulation now creates jobs WITH their
customers and closes them at each month's end; its three SQL workaround
functions are deleted. October's paid-for lost cable used to make its job
REFUSE to close (the close rule was right; the cable had nowhere to go) —
Wave 2's terminal states (§4 below) fixed the other half: the owner marks
the cable `lost` and the job closes.

### 2. No bookings, and its two sharp edges — SHIPPED as the promise calendar (0022 + the client wave)

Was `no-bookings`, `double-promise`, `turnaway-blind-to-commitments` —
the Phase C gap the year hit across the whole season. Shipped end to end:
migration `0022_bookings` (four statuses, two periods, the exclusion
constraint on confirmed claims, confirm-allocates, bulk capacity as a
peak, pencils that expire by predicate, the extension-collision list as
data, the job bridge) and its on-phone twin (`demo/bookings.ts`: the same
rules over the local mirror, every write queued as the RPC op it
replays as) with the screens on top — the Desk tab (kit-list reader,
calendar, bookings), the month calendar, the booking page with its
Confirm / Extend / Convert / Send / Cancel doors, the new-booking sheet,
the extension-collision screen with its Substitute / Sub-rent / Call
doors, the scanner's PROMISED stamp, and the Today board's Promised
strip and overdue ladder.

- **Double promise — IMPOSSIBLE.** SEP's wedding now confirms through
  the calendar while the TVC's four batteries are held by name, and the
  confirm allocates the OTHER four: the truck leaves with eleven accepted
  rows, no wolf-crying. NOV's second shaadi booking, demanding a body
  Bilal already holds, is refused BY NAME — 'already promised to booking
  #N (Bilal Hussain)' — and the pencil stands; the desk moves Bilal's
  claim onto the third FX9 through the substitute door
  (`reallocate_reservation`), Sana confirms on the body she asked for,
  and both trucks leave with different cameras. (Both pinned.)
- **The demand log sees commitments.** An enquiry asked WITH dates
  subtracts confirmed claims over the window (`checkAvailability`'s
  `window`, `confirmedOverlap`, `shortReason: 'committed'`), and
  `recordTurnedAway` counts the committed refusal separately from a true
  shelf shortage (`turnedAwayByReason`). NOV's third client, DEC's
  last-week ask and APR's Eid ask are all counted. (Pinned.)
- **The extension-collision moment.** MAR: Hamza keeps the house's one
  C500 two days longer; the preview names Sana, the unit and when her
  hold begins, and changes nothing. No substitute exists, so the desk
  records a sub-rent intent and the extension writes BEHIND it in the
  outbox (ASSUMPTION #27 `#sub-rent-intent`) — her claim on the unit
  stands until the partner's unit covers it. (Pinned.)

The partner network shipped as W7 (0025; see (b)3 and the second-year
section). Two things remain around the calendar: the **sub-rent intent
still has no server realisation** — an op name and a chain position, but
no RPC in 0022 or 0025 — which the second year pins as
`sub-rent-intent-unreplayable` (below); and the manager escalation on
day 14 is one local flag (ASSUMPTION #28 `#manager-flag`), which MAY now
exercises end to end on the chronic late payer.

### 3. No expense side of the book — SHIPPED as the kharcha book (0019)

Was `no-expense-book`, `no-subrent-intake` — hit OCT, JAN, APR, JUN and
implicitly all year: the ledger was customer-only, so the Rs 45,000
camera repair, the partner house's sub-hire bill and the replacement
cables landed on **no book at all** and "what did the year actually
make" was structurally unanswerable. Shipped end to end: `org_expenses`
(migration 0019 — append-only like the ledger, six kinds, every amount
positive, reversals void a pair forward-only, desk-tier writes through
the shared money budget, invisible to warehouse phones) with its client
twin (`demo/kharcha.ts` + the entry sheet); a repair names the camera it
fixed and the payback bar's denominator honestly carries it, a sub-hire
names the job it rescued and the handover shows the margin, the hisaab
gained a Kharcha section and a double-ruled month profit line
(earned − spent), and the server answers the same questions through
`job_margin`, `asset_cost_history` and `monthly_profit`. The simulation
now records the JAN repair, the OCT cable purchase and the APR sub-hire
on the real book and asserts every margin; both ids are retired.

The intake flag rode with Phase E1 as predicted: `recordSubHireIn`
(0025) puts a borrowed unit on the shelf as `sub_rented_in` with a local
code, and `closeSubHire` sends it home as `returned_to_owner`, never
`retired`. APR now borrows the Eid lights through that door — and finds
the door's own wall, `subhire-cost-unlinkable` (second-year section).

### 4. No terminal state for gear — SHIPPED as the fleet lifecycle (0020)

Was `no-terminal-asset-state` and the theft half of
`no-blacklist-or-theft-export` — hit OCT, FEB, JUL, AUG: three ways gear
left the fleet this year, none expressible. Shipped end to end as Wave 2
(migration `0020_fleet_lifecycle`):

- **A `disposition` axis on assets** (`null | lost | stolen | sold |
  retired`), a projection like presence/health/ownership, driven by three
  new scan-event verbs — `mark_lost`, `mark_stolen`, `mark_sold` — through
  the same append-only pipeline (owner/manager-gated at the RPC), plus the
  existing `retire`. The reducer sends a terminal item `presence='gone'`
  **and clears `current_job_id`** — the line that finally lets October's
  ghost job close. `found` is the recovery door (clears the disposition,
  brings it home).
- The **paid-for lost cable** (OCT): the owner marks it `lost`; it leaves
  the fleet, off its job, and the job closes at last — the close rule never
  changed, the cable just had nowhere to go.
- The **absconded client** (FEB): the FX6 + lens are marked `stolen` and a
  **theft report** builds from local facts (code, serial, photo count,
  last-seen, org contact) — the forwardable police/insurance card. The
  **public tag resolver goes deliberately LOUD for a stolen tag** (a STOLEN
  notice with the org's contact line, `public_tag_show_owner` or not — the
  Phase E2 groundwork), while lost/sold/retired stay indistinguishable from
  an unknown tag (the anti-enumeration rule). Only the customer-side
  **blacklist flag** remains (narrowed to `no-blacklist`); the Rs 2.6M gear
  loss is now recorded as a disposition, not an eternal `out`.
- The **stocktake** (JUL): shipped as **ginti** — a cycle count is a diff
  (`cycleCountDiff`), and both sides now exist. The tech walks a shelf,
  the seen set is written as `inventory_count` events (non-destructive:
  `last_scanned_at` moves, presence does not), and the diff surfaces
  missing / unexpected / matched. Missing items are the owner's to decide
  (found elsewhere vs lost) — the count never auto-marks. JUL now catches
  the seeded C-Stand #8 discrepancy and prints a copyable report.

*Plan check:* Phase E2 (stolen-gear mode) and Phase D4 (cycle counting)
were the right shapes; the disposition axis rode with them as predicted.

### 5. The correction vocabulary is one unlabeled word — DEC, FEB, MAY
`no-adjustment-door`

The correction VOCABULARY now exists — `reversal(of=…)` and `write_off`
are real kinds, the statement prints "reversed", never a self-blaming
"adjustment", and the charged-then-returned notice writes a reversal
from its confirm tap. But the general-purpose door is still missing:
outside that one notice, **no screen posts a reversal, a write-off or an
adjustment**, and the void guard for double-taps (same customer + amount
+ kind within a few seconds is a confirmable duplicate, not a silent
second line) is still unbuilt.

*Plan check:* not in any phase. Slot into Phase B polish — it is pure
past-fact recording, offline-safe by the CONTRIBUTING rule.

### 6. Deposits have no door — SEP, DEC
`no-deposit-door`

The projection handles hold/apply/refund flawlessly (DEC pinned the whole
Rs 100,000 → damage → refund arc to the paisa). But only the seed has ever
written these kinds; no store method, no screen. Phase B item 7 is listed
as shipped-in-schema; it is not usable by a vendor.

### 7. Service, utilization and dead stock — MAR, JUN (largely SHIPPED as 0021)
`no-utilization-read` (narrowed), `no-lifetime-value-view`, `no-month-history-screen`

Was also `no-service-tracking` — the JUN wall ("the inputs are already all
on the device; nothing reads them for service"). Wave 3 (migration
`0021_living_fleet`) shipped Phase D items 1–2/5–6 end to end:

- **Service by usage** (Hilti's pattern, the 2026-09-02 strategy lens):
  per-product `service_due_after_rental_days` (null = no nudge), per-asset
  `rental_days_since_service` — a projection the reducer moves on check_in
  by the rental's calendar days, `(in::date − out::date) + 1`, partial day
  = full day, derived from the job's own out/in scan pair (echoes and
  loose check_ins add nothing; a rebuild re-derives from the log). Reset
  by a new desk-gated `serviced` scan event; `asset_service_log` is a
  VIEW over those events, and the optional cost link names the
  org_expenses repair that paid for the work — validated at the RPC. The
  JUN block now RUNS the scenario instead of pinning the wall: the meter
  grows past its synced 120 with the year's own scans, the Sehat surface
  names the unit, and the desk services it with the Rs 15,000 bill
  landing on the kharcha book and the link on the event.
- **Battery cycles**: `count_cycles` products count a cycle per check_out
  (`cycle_count`); crossing `retire_after_cycles` raises ONE open
  `cycle_threshold` alert and never changes state — auto-quarantine was
  considered and refused: a state the system changed by itself is a state
  nobody trusts, and "run it one more season" is a real answer only the
  owner can give.
- **Dead stock** (the `dead_stock` view; the client's Sehat group on the
  Gear screen and the hisaab's 'Idle 90+ days: N items · Rs X' line):
  rentable, non-terminal, on-the-shelf units whose last check_out — or,
  never rented, their created_at — is older than the org's
  `dead_stock_days` (settings, default 90), replacement value carried
  with the unpriced count honest. MAR now asserts the Rs 4.5M Xeen set
  and the idle Sachdeva surface while the light that just worked Ramzan
  does not.
- **Voice notes** (Phase D5, no finding id — Bykea's lesson) rode along:
  hold-to-record awaaz notes on the asset page and the return's
  discrepancy rows, stored on the condition-photos never-evict model
  (honest 'device full' refusal), played back inline, silently absent
  where MediaRecorder is.

What remains, still ranked by the year:

- `no-utilization-read`, NARROWED: no fleet ranking of earners — "which
  camera earned best" (AUG Q4) still means opening asset pages one at a
  time. The idle-days half of the finding is retired.
- `moneyStrip(nowMs)` answers *any* month — verified for October and
  December from March — but every caller hardcodes `Date.now()`, so the
  owner cannot see last month from this one. A month picker is nearly
  free; the API is already honest (`no-month-history-screen`).
- Lifetime value per customer is sitting in the entries every khata page
  already loads; the owed list just doesn't show it
  (`no-lifetime-value-view`).

*Plan check:* D1/D6 shipped as the predicted shapes; the month picker and
lifetime-value column stay cheap Phase B polish, not Phase D work.

### 8. The crisis-day swap — SHIPPED as the swap flow (0020)

Was `no-swap-flow` — the JAN camera drop, faked as a second one-line job
that split the rental charge and orphaned the photo evidence. Shipped as
one atomic RPC (`swap_asset`) and its offline twin (`swapAsset`): given a
live job, the broken asset on it, and a fit substitute, it records the
broken item's `check_in` (off the job), a `flag_damage`/`quarantine` on it,
and the substitute's `check_out` onto the **same job** — three linked
events in one session, the flag and the checkout carrying `implied_by`, the
payloads cross-referencing. Refuses cross-org, closed jobs, a broken item
not on the job, and terminal / off-shelf / unfit substitutes. NOV and JAN
now both run the real swap; the rental stays one job's story and the
evidence chain holds.

### 9. Health cannot be set standalone from the phone — JAN (narrowed)
`no-health-door`

Availability honesty **depends** on `health` (`'here' and health='ok'`).
The **swap** now sets it for the swap case — the dropped FX9 is flagged
`quarantined` in the same atomic flow that sends its substitute out, so
JAN no longer needs SQL — but a STANDALONE "this is broken, quarantine it"
toggle with no swap behind it still has no screen. That narrowed gap is
what `no-health-door` now names. (Related: retiring a peeled tag also has
no door — JUL.)

### 10. Import apply is welded to the store — RETIRED (W8)

Was `import-apply-welded`. `applyImport` lives in `read-model.ts` now
(the org, the plan and an injectable clock in; `{products, units,
renumbered}` out), `store.ts` binds the org and refreshes the catalogue,
and the year test drives the real routine twice — the replica it carried
is deleted. Lifting it surfaced fixed bug (a)8.

---

## (c) Small UX papercuts

- **The progress ring undercounts swaps.** `packedProgress` counts
  promised-and-out only; the wedding that legitimately took batteries 5–8
  instead of the promised 1–4 shows 7/11 forever after a reload (pinned,
  SEP).
- **A waived late fee leaves no trace** (`waived-fee-invisible`). The
  owner forgave 11 days on the documentary; nothing records the goodwill,
  so next quarter nobody remembers Ayesha already got her favour.
- **Statements are one tap per customer.** February's collections were
  five separate compose-and-send rounds; at a real house's scale this is
  an hour of thumbing. A "send all statements" batch (still via the
  owner's own WhatsApp, authority preserved) is the khata-app playbook.
- **`entry_method='assumed'` and the unknown-tag rows do their jobs** —
  the new-tech week (NOV) showed duplicates suppressed-but-acknowledged,
  unknown labels recorded-not-lost, and manual adds honestly marked. The
  scan loop's feedback design held up under a clumsy first week; worth
  saying because so much else in this doc is a gap.
- **Conflict repair now has a mechanism, not yet a button.** `voidScan`
  undoes a mis-scan in one op (see fixed finding 3); the scan screen's
  conflict row does not offer it yet, so a tech still needs the desk to
  know it exists.
- **Every booking write reads every booking** (found by the stress suite,
  W8). `pruneExpiredPencils` loads the whole `bookings` mirror on every
  create/confirm/extend/cancel, and `lastBookingOp` scans every pending
  outbox payload with three `LIKE`s. At a year's worth of bookings and
  an outbox that never drains (no pipe yet) a create costs ~2ms on
  node:sqlite — invisible on a desk, but the outbox scan is the kind of
  cost that only shows up on the phone that has been offline longest.
  Both are one `where` clause each; the pipe draining the outbox (W9)
  removes the second on its own.

## (d) The vendor's verdict

*(Year one's verdict is kept below for the record; this is year two's.)*

**Would he still be using it in month 12 of the second year? Yes — and
this time nobody kept a laptop nearby.** Every scenario that made him
reach for SQL in year one goes through a door the phone has now: the
wedding was a pencil the agency held and the desk confirmed; the lookbook
went out priced, haggled and final before the truck moved; the November
shaadi that wanted a promised body was refused BY NAME and the desk moved
the claim; the swap, the theft report, the ginti, the borrowed FX9 and its
homecoming, the season multiplier, the day-14 escalation, the parchi's
bytes for the printer — all of it is the app's own vocabulary. More than
250 scans, none lost; the balances never drifted a paisa across the
year's ledger; every month's profit netted the partner's bill without a
spreadsheet; the stress suite hammered the calendar, the pricing and the
network for a simulated year and found no double promise, no drifting
book, no lowered quote.

**What would make him quit in year two, in order:**

1. **The pipe.** Nothing in this year ever left the phone. There is no
   login, no sync and no RPC call in the app — every door writes an
   optimistically-mirrored row and an outbox op *named after* a server
   RPC that has never been called. The year is honest about what the
   phone does; it says nothing about what the server would answer. Until
   W9 the pilot is one phone, one desk, and a backup that does not exist.
2. **The four money doors he still has to fake**: a deposit
   (`no-deposit-door`), a reversal or write-off outside the
   charged-then-returned notice (`no-adjustment-door`), the blacklist the
   day-14 rung tells him to consider (`no-blacklist`), and the goodwill
   he extends when he waives a fee (`waived-fee-invisible`). Each is
   pure past-fact recording — a B-polish week, not a wave.
3. **The two walls the shipped doors have**, found only by using them in
   order: a sub-rent intent that the pipe cannot replay
   (`sub-rent-intent-unreplayable`) and a borrowed unit's cost that
   cannot be attached to the job it rescued if the job came second
   (`subhire-cost-unlinkable`). Both are W9's to close, because both are
   about what happens when the queue meets a server.

**The year's clearest instruction:** *the pipe before any more features.*
Everything the dream plan sequenced after Phase A has been built on top
of a Phase A that is half missing, and the simulated year cannot see the
half that is missing. The order of what remains is W9 (login, session,
sync, photo upload, the two new walls), then W10 (polish), then the
B-polish money doors — with the three human gates (the 30-minute APK
scan test, one rack of printed labels, the vendor afternoon) run in
parallel, because the answers change the settings, not the schema.

### Year one's verdict (2026-09-11, kept for the record)

**Would he still be using it in month 12? Yes — but only because someone
on the pilot team kept a laptop nearby.** The scan loop never lost a
single op in 254 scans across the year, the balances never drifted a
paisa across 90 ledger lines, and the out/in photo pair won the January
dispute outright. Those three are the product, and they held.

**What nearly made him quit, in order:**

1. **October**: discovering that jobs made in the app can't take charges
   (was `no-customer-on-desk-job` — since fixed, see (b)1). The money
   book — the reason he adopted — only worked for the four demo customers
   until SQL was typed on his behalf. On a real pilot with no engineer
   standing by, **this is the adoption cliff**, and it falls in week one.
2. **December**: the Today board scrolling through every job since
   September because none of them could be closed (since fixed, (b)1),
   right when twelve live jobs needed to be visible at once.
3. **February**: telling the client "your cheque bounced" with a statement
   that printed *adjustment* — as if the house had made the error — while
   the balance card claimed the debt was six days old.

The year's single clearest instruction to the plan: **Phase B needs a B0 —
customers, job-wiring, close-job, and the adjustment/deposit doors — before
any Phase C ambition.** Everything else on the dream plan's ordering
survived contact with the simulated year.

*B0 status:* the customers / job-wiring / close-job trio SHIPPED
(migration 0018 + the client wave; see (b)1) — the week-one adoption
cliff and the December board-pileup are gone from the walls list. The
adjustment and deposit doors remain open items (`no-adjustment-door`,
`no-deposit-door`).

---

## The second year (W8)

The same twelve months, re-lived on 2026-09-13 against the finished app
(`second-year`, every wave merged: bookings 0022/0023, quoting 0024,
the network 0025/0026). The narrative changes are in the test's own
comments; this is the ledger of what moved.

### What each month now does through a shipped door

| Month | Year one | Year two |
|---|---|---|
| SEP | Bookings created `confirmed` in one call | The wedding is a **pencil** (24h TTL from the desk clock), then confirmed, then converted; two ops in the queue, the way the server insists. The import runs the REAL `applyImport`. |
| OCT | A walk-in job | The lookbook is **quoted first**: 10d 6h → 11 calendar days → one 3-day week + a capped remainder = 6 billable days; the Komodo overridden to Rs 17,000 (final rate, reason kept, card rate remembered); confirmed with the manager's credential override; converted. Total Rs 150,000, final. |
| NOV | — (already the network) | Unchanged: the named collision, the substitute, the borrowed FX9 as `sub_rented_in` → `returned_to_owner`, crew on the parchi. |
| DEC | — | The desk sets the **season row** at ×1.25 (data, not code) and Hamza's confirmed hold prices 2 × 3 × Rs 25,000 × 1.25 = Rs 187,500, final; the text names the day. The bounced cheque's debt clock is still pinned in MAY. |
| FEB | — | An **extension collision settled by substitution**: Bilal's FX9-02 extension names Sana, her claim moves to another body through `reallocate_reservation`, the extend chains behind it, no unit ever carries two confirmed claims; Bilal's booking becomes his truck, Sana's is cancelled through the door. |
| APR | Borrowed lights by CSV, bill by hand | Roshan is a **partner**; two lights come in through `recordSubHireIn` with serials at Rs 15,000 each and go home as `returned_to_owner`. The **thermal parchi bytes** are built for the Eid job: init, centred/bold/double-size letterhead, 32 columns, the QR block, the cut, ASCII by construction, deterministic. |
| MAY | — | The **ladder's day-14 rung** fires on Ayesha: nudge → call → late-fee draft → manager escalation with a blacklist to consider; the local flag is written once and keeps its first date. |
| JUL | The ginti report | The missing C-Stand goes **STOLEN** from the count and the **partner broadcast** reads back in Roman Urdu with the house's public phone; a unit that is home has no broadcast. |
| AUG | Four questions | Plus: **turned-away by reason** summed over the year (every FX9 refusal was a *committed* one — the buy signal), and the payback bar's denominator carries the year's three repair bills. |

### Findings retired vs kept

- **Retired (1):** `import-apply-welded` — the routine moved, the replica
  died, and moving it fixed bug (a)8.
- **Kept (8), each a Phase B polish door the waves did not build:**
  `no-adjustment-door`, `no-deposit-door`, `no-blacklist`,
  `no-health-door`, `waived-fee-invisible`, `no-month-history-screen`,
  `no-lifetime-value-view`, `no-utilization-read`. None names a shipped
  feature: the store still has no `holdDeposit`, no standalone reversal
  or write-off door (only the charged-then-returned notice writes one),
  no health toggle without a swap, no blacklist toggle, no waiver line,
  no month picker on the Hisaab (`monthProfit()` is called with no
  clock), no lifetime column on the owed list, no earners leaderboard.
- **New (2), found only by using the shipped doors in a vendor's order:**

### New wall: `sub-rent-intent-unreplayable` — MAR

The extension screen's Sub-rent door records an intent as a
`sub_rent_intent` outbox op and chains the extension behind it
(ASSUMPTION #27). **No RPC answers to that op** — neither 0022 nor 0025
defines one. The moment W9's pipe replays the queue, the intent fails,
and by the outbox's own rule the extension chained behind it fails with
it, surfacing as one needs-attention card for a booking the desk
believes it extended weeks ago. W9 must either give the op a server
realisation (a sub-hire-in whose unit covers the other client's claim,
then the extend) or take it out of the chain.

### New wall: `subhire-cost-unlinkable` — APR

`recordSubHireIn` ties its expense to a job or a booking **at record
time**. The common order at the enquiry is borrow first, make the job
second — and then the bills sit on the kharcha book (the month's profit
nets them, the partner's page says Rs 30,000) but the job's margin reads
the full Rs 90,000, and no door attaches an expense to a job after the
fact. NOV shows the link working in the other order. The fix is one
door ("attach to job") on the expense row, or a booking-first flow on
the enquiry screen; either is small, and the server's
`booking_sub_hire_cost` already accepts both links.

### The stress suite (W8)

Three new seeded-deterministic files beside `stress-money` and
`stress-registry`, every invariant re-checked after every write:

- `stress-bookings`: 500 random bookings over twelve months on a 60-unit
  fleet (plus a second seed's 200) — no two confirmed claims overlap on a
  unit ('[)'), no dead pencil stands after a write and none survives the
  year, booking numbers are gapless, a refused extension changes nothing
  and equals its preview, availability is never negative, a converted
  job's expected set IS the allocation, one op per write and every later
  op chained.
- `stress-quoting`: 2,000 random quotes through `priceQuote` — totals are
  sums, unpriced never contributes, a multiplier ≥ 1 never lowers,
  override lines ignore it, billable ≤ calendar days except through the
  card's own minimum, indicative ⇔ unpriced-or-unconfirmed, and the same
  input prices the same twice.
- `stress-network`: 300 random sub-hire cycles per seed — every priced
  in-hire has exactly one live expense, every priced out-hire exactly one
  ledger charge, closing never moves either book and is refused twice, a
  borrowed unit goes home as `returned_to_owner` and never `retired`, the
  partner page's money line is the two books re-summed.

The suite found no invariant violation. It found the papercut in (c)
(every booking write reads every booking) and made the network
assertions batch their lookups — a reminder that the phone's read models
were written for one org's year, not for a test that runs one in five
seconds.
