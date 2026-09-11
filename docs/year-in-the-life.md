# A year in the life — findings from twelve simulated months

Executable source: `apps/app/test/year-in-the-life.test.mjs` — a scripted
September-to-August of a Lahore rental house driven through the real seams
(seed, ScanSession, outbox, ledger, read models) on a controlled clock.
Every finding below carries the id the test pins it under; if a feature
ships and a wall comes down, remove the id there and the section here in
the same change. The simulation is green and must stay green: findings
live in this document, never as failing asserts.

Written 2026-09-11 against branch `year-hardening`. Cross-references are
to [`vendor-dream-plan.md`](vendor-dream-plan.md) phases A–E.

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

### 2. No bookings, and its two sharp edges — SEP, NOV, DEC, APR (the whole season)
`no-bookings`, `double-promise`, `turnaway-blind-to-commitments`

The known Phase C gap, but the year found its exact teeth:

- **Double promise.** `createJob` allocates from `presence='here'` only —
  it does not know what other open jobs promised. Two shaadi jobs for the
  same weekend were handed the *same two FX9s* (NOV, pinned); the seed
  itself promises V-Mounts 1–4 to two jobs at once (SEP, pinned). First
  truck wins; the second job's scan session cries missing/unexpected on
  the ordinary case — the exact wolf-crying the return flow was built to
  avoid.
- **The demand log is blind to commitment-driven refusals.** The
  turned-away log only records *shelf* shortages. In NOV the shelf showed
  3 FX9s "available" while two open jobs claimed them; the owner turned
  the third client away and `recordTurnedAway` recorded **zero**. The buy
  signal misses precisely the wedding-season demand it was built to
  capture. (Cheap partial fix inside Phase B: count a line as turned away
  when `onHand - committed < wanted`, flagged separately from true
  shortage.)

*Plan check:* Phase C's ordering (bookings before pricing) is confirmed;
the extension-collision preview will matter, but plain
allocation-awareness in `createJob` is the bleeding edge and could ship
device-side sooner.

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

One deliberate remainder: the borrowed lights themselves still enter by
import stamped `ownership='owned'` — the partner's BILL is on the book,
but nothing yet sets `ownership='subrented'` on the units, so a
stocktake still counts them as fleet. That intake flag rides with Phase
E1 (cross-hire), where the partner list lives.

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

### 7. Service, utilization and dead stock — MAR, JUN
`no-service-tracking`, `no-utilization-read`, `no-lifetime-value-view`, `no-month-history-screen`

The data exists; the readers don't:

- The outbox holds every checkout of the year (the FX9's real usage), yet
  `assetEarnings.jobs` says 3 because only lines that happen to carry an
  asset id count. No `rental_days_since_service`, no threshold, no nudge
  (Phase D1) — and JUN showed the inputs are already all on the device.
- No fleet ranking of earners, no idle-days / dead-stock view (D6): the
  owner opens asset pages one at a time.
- `moneyStrip(nowMs)` answers *any* month — verified for October and
  December from March — but every caller hardcodes `Date.now()`, so the
  owner cannot see last month from this one. A month picker is nearly
  free; the API is already honest.
- Lifetime value per customer is sitting in the entries every khata page
  already loads; the owed list just doesn't show it.

*Plan check:* D1/D6 confirmed as the right shape; the month picker and
lifetime-value column are cheap Phase B polish, not Phase D work.

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

### 10. Import apply is welded to the store — SEP
`import-apply-welded`

`applyImport` (a pure-DB transaction) lives in `store.ts` beside the
sql.js driver, so it cannot run — or be reused — under Node; this
simulation carries a line-for-line replica. The 2026-09-02 review's "lift
the read-model SQL out of store.ts" applies verbatim; move it to
`read-model.ts` next time it is touched, and the replica in the year test
can be deleted.

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

## (d) The vendor's verdict

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
