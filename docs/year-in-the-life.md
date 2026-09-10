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
that NAMES the entry it voids (`reversal_of`, client-side column;
**server-side ledger needs the same column in a follow-up migration**).
`oldestUnpaidMs` skips a reversal and its target as a pair — they cancel
in time as well as in money — so "owed since" keeps pointing at the
original charge, and the statement prints *reversed*, never *adjustment*,
for a bounce the house did not cause. (MAY block pins the surviving
clock.) The `no-adjustment-door` finding stands: no screen writes a
reversal yet.

### 5. The payback bar counts damage recovery as earnings — FIXED

Was `payback-counts-damage`. `assetEarnings` now sums rental money only
(`charge + late_fee`); damage stays on the customer's khata but never
inflates the asset's bar, and — POLICY (owner may overrule) — a charge a
`reversal` later voided stops counting too, so a charged-then-returned
item keeps no phantom earnings. **The server's `asset_earnings` view
(`db/migrations/0017_money_book.sql`) still sums `damage_charge` and
knows no reversals — follow-up migration needed to match.** (JAN and MAR
blocks pin the honest figure; `khata.test.mjs` pins both exclusions.)

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
  answer). Reversed charges are also out of asset earnings client-side;
  the server's `asset_earnings` view needs a follow-up migration.
  (`chargedButReturned` / `recordReversalOf` in `demo/khata.ts`; pinned
  in `stress-money.test.mjs`.)

## (b) Missing features, ranked by how often the year hit the gap

Ranked by number of months the simulation ran into the wall, worst first.
Phase letters refer to `vendor-dream-plan.md`.

### 1. Jobs cannot be closed, and desk jobs have no customer — every single month
`no-close-job`, `no-customer-on-desk-job`, `no-add-customer`

Thirty-one jobs were created over the year. **Every one** needed direct SQL
to (a) get a customer attached and (b) get closed when done. Without the
workarounds:

- `createJobFromLines` takes no customer, so **every job born at the desk
  is unchargeable forever** — `chargeClient`, `recordLateFee`, the deposit
  flow and the khata link all dead-end on `customerForJob → null`. Only
  the four seeded customers' seeded jobs can ever take a charge. This
  makes Phase B's money loop unreachable from Phase B's own front door.
- No API sets `status='closed'`, so the Today board accumulates every job
  ever made, and — pinned in SEP — a **finished job keeps claiming its
  promised gear in every availability answer** ("going to Documentary"
  weeks after the documentary wrapped). The enquiry screen degrades a
  little more with every completed job.
- No API creates a customer at all.

*Plan check:* the dream plan puts customers in Phase C ("the server era").
**Lived evidence says that is too late**: the ledger (Phase B, shipped)
needs customers and job-wiring *on-device now*. A local-first
add-customer + attach-to-job + close-job trio is two tables the demo
schema already has. Recommend pulling it forward into Phase B as B0.

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

### 3. No expense side of the book — OCT, JAN, APR, JUN (and implicitly all year)
`no-expense-book`, `no-subrent-intake`

The ledger is customer-only. Over the year the house paid out: a camera
repair (Rs 45,000), a partner house for two sub-rented lights, replacement
cables. **None of it is recordable anywhere**, so "what did the year
actually make" — the vendor's-dream question — is structurally
unanswerable, and the APR sub-rent had to be faked by importing the
partner's lights as *owned* assets (they now pollute the fleet, the
availability counts and any future stocktake; `ownership='subrented'` and
containment kind `subrented` exist in the schema and nothing sets them).

*Plan check:* the plan defers sub-rental costs to C4 (margin-before-quote)
and E1 (cross-hire). Lived evidence: the *intake* half (mark gear as a
partner's, with a cost line) is needed the first time Eid demand exceeds
the shelf, independent of quoting. A minimal `expense` ledger kind +
sub-rent intake flag belongs in late B / early C, not E.

### 4. No terminal state for gear — OCT, FEB, JUL, AUG
`no-terminal-asset-state`, `write-off-illegible`, `no-blacklist-or-theft-export`

Three ways gear left the fleet this year, none expressible:

- The **paid-for lost cable** (OCT): client paid the damage charge; the
  cable stays `presence='out'` on a closed job until the end of time. The
  Today board's out-count carries a ghost from October onward.
- The **absconded client** (FEB): FX6 + lens stolen. The board shows the
  red overdue row forever (correct!), but the write-off is an anonymous
  `adjustment` indistinguishable from a discount, the Rs 2.6M gear loss
  appears on **no book at all** (the money book only knows the Rs 38,000
  of unbilled rental), there is no blacklist flag for the client, and no
  theft export (serials + photos + last-scan) to hand police or partner
  houses.
- The **stocktake ghost** (JUL): C-Stand #8 is nowhere on the shelf, the
  mirror says `here` with full confidence, and there is no way to record
  the disagreement.

*Plan check:* Phase E2 (stolen-gear mode) covers the dramatic case but
nothing covers the mundane ones. A `lost/written_off/sold` presence or
disposition state is schema-level and should ride with Phase D's cycle
counting (D4), which the JUL stocktake showed is 80% missing anyway:
lookup mode walks a rack beautifully and writes nothing (verified — the
scan-free invariant held over ~100 lookups), but a stocktake is a *diff*,
and only one side of it exists.

### 5. The correction vocabulary is one unlabeled word — DEC, FEB, MAY
`no-adjustment-door`

Three distinct real events — a double-tapped charge, a write-off, a
bounced cheque — all had to be written as `adjustment`, and **no screen
can even write that**: the kind exists in core, nothing in the store or UI
posts it. Worse, the client-facing statement renders the bounce correction
as "adjustment +Rs 40,000", reading like the *house* fixed its own error.
The append-only ledger is the right skeleton; it needs a correction
vocabulary (`reversal(of=…)`, `write_off`, plus the void guard for
double-taps: same customer + amount + kind within a few seconds is a
confirmable duplicate, not a silent second line).

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

### 8. The crisis-day swap — JAN
`no-swap-flow`

Camera drops on set; the desk fakes the swap as a second one-line job.
Works, but: the rental charge splits across two jobs, the photo evidence
attaches to the first, and nothing links them. Phase D3's one-flow swap is
validated by the fake being *possible but illegible*.

### 9. Health cannot be set from the phone — JAN
`no-health-door`

Availability honesty **depends** on `health` (`'here' and health='ok'`),
but no screen sets it — the broken FX9 needed SQL to stop being offered to
the next client. Until the server era, a local quarantine toggle is a
one-column write with outsized honesty value. (Related: retiring a peeled
tag also has no door — JUL.)

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
   (`no-customer-on-desk-job`). The money book — the reason he adopted —
   only worked for the four demo customers until SQL was typed on his
   behalf. On a real pilot with no engineer standing by, **this is the
   adoption cliff**, and it falls in week one.
2. **December**: the Today board scrolling through every job since
   September because none of them could be closed, right when twelve live
   jobs needed to be visible at once.
3. **February**: telling the client "your cheque bounced" with a statement
   that printed *adjustment* — as if the house had made the error — while
   the balance card claimed the debt was six days old.

The year's single clearest instruction to the plan: **Phase B needs a B0 —
customers, job-wiring, close-job, and the adjustment/deposit doors — before
any Phase C ambition.** Everything else on the dream plan's ordering
survived contact with the simulated year.
