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

### 1. Two cameras answering to one code after an import — `duplicate-asset-code`

The CSV import derives unit codes as `CODE-01`, `CODE-02`… from the file's
code column. Importing a row `Sony FX9,1,FX9` into a house that already has
a seeded `FX9-01` creates a **second asset with the visible code `FX9-01`**.
Nothing warns; there is no uniqueness rule on `asset_code`. Manual search
("can't scan it" path) now shows two identical rows and the tech picks one
at coin-flip.

*Repro:* seed the demo, apply an import plan whose row code prefix matches
an existing product's, `select count(*) from assets where asset_code =
'FX9-01'` → 2. (SEP block.)

*Fix direction:* the import planner should collision-check codes against
existing assets and continue numbering (`FX9-03`), the same way it already
refuses to merge ambiguous names.

### 2. The late-fee draft collapses to zero if the gear is scanned in first — `latefee-after-scan-zero`

`lateFeeDraftFor` prices the draft off **what is still physically out on
the job**. The natural dock order — tech scans everything in, THEN the
desk opens the charge sheet — leaves nothing out, so a 3-days-late job
drafts *zero, unpriced*. The owner sees no number exactly when he needs
one. Nothing tells the desk that the order of operations matters.

*Repro:* job overdue 3 days with a Komodo + Ronin out → draft Rs 84,000.
Scan both in, recompute → `totalMinor 0, priced 0`, `moneyLabel` null.
(OCT block.)

*Fix direction:* price the draft off what came back **in the return
session** (the session knows), or snapshot the out-set when the return
session opens.

### 3. A mis-scan cannot be undone; the repair writes false history — `no-scan-undo`

A new tech scans the C500 into the wrong job. The conflict warning fires
correctly — and records, correctly (reality outranks the schedule). But
there is **no undo**: the projection now says the camera is on the wrong
job, and the only repair is a check-in on no job plus a re-check-out on
the right one. That leaves two fabricated movement events in the permanent
scan history and, on a synced device, in the server's append-only log. The
asset page will forever show a phantom round-trip.

*Repro:* NOV block, the "wrong-job scan" sequence — three extra ops to fix
one mistake, `current_job_id` corrupted in between.

*Fix direction:* a `void_scan` op referencing the outbox id (append-only
stays intact; the projection and history readers skip voided ops). This is
the scan-side sibling of the ledger's `adjustment`.

### 4. The debt clock resets on a bounced cheque — `debt-age-resets-on-bounce`

`oldestUnpaidMs` returns the start of the *current stretch* of positive
balance. A payment that clears the book, later reversed by an adjustment
(the only way to record a bounced cheque), makes the debt look **six days
old instead of six weeks**. "Owed since" on the balance card — the number
collections pressure runs on — understates every debtor who ever bounced.

*Repro:* MAY block. Charge → cheque payment (balance 0) → bounce
adjustment. `oldestUnpaidMs` = the bounce date, not the charge date.

*Fix direction:* a reversal kind that re-links to the payment it voids, so
the projection can treat the pair as if the payment never happened.

### 5. The payback bar counts damage recovery as earnings — `payback-counts-damage`

`assetEarnings` sums `charge + late_fee + damage_charge`. The FX9 that
cracked its handle "earned" Rs 150,000 of repair recovery, and its payback
bar celebrates accordingly. A camera that gets broken often will look like
the best performer in the fleet.

*Repro:* JAN block — `earnedMinor` includes the Rs 150,000 damage line.

*Fix direction:* keep damage in the customer's khata but out of the
asset's payback figure (or show it as a separate strand of the bar).

### 6. Same-millisecond ledger ties can flip the running balance — papercut-grade

`oldestUnpaidMs` re-sorts entries by `createdAt` alone. The khata screen
holds entries newest-first, so a charge and payment written in the same
millisecond flip order after the stable re-sort, momentarily dipping the
running balance negative and resetting the owed-since clock. Unlikely from
human taps, likely from any future bulk import of ledger history. The
simulation had to space charge and payment an hour apart to keep its
assertions deterministic.

*Fix direction:* carry `rowid` (insertion order) into `LedgerEntryView`
and use it as the tie-break, as `rowsFor` already does in SQL.

### 7. The clock is welded shut in three places — `clock-welds`

Audit of hidden `Date.now()` / `new Date()` reads (the code takes `nowMs`
almost everywhere — these are the leaks):

| Place | Weld | Consequence |
|---|---|---|
| `Outbox.enqueue` (`packages/core/src/outbox.ts:101`) | `created_at = Date.now()` | The hisaab's day grouping and asset history read outbox `created_at`, not the payload's `device_time` — a simulated or wrong clock splits the two records of when a scan happened. Din-ka-hisaab for any day but the real today is untestable. |
| `SessionRegistry.open` (`apps/app/src/demo/sessions.ts:104`) | `startedAt: Date.now()`, and it never passes `now` into `ScanSession` | The registry cannot run on an injected clock at all; this simulation had to bypass it and drive `ScanSession` directly. |
| `DemoStore.recordPayment` / `chargeClient` / `recordLateFee` (`store.ts`) | `createdAt: Date.now()`, no parameter | **The vendor cannot backdate money.** "The client paid me yesterday, I'm entering it this morning" is an everyday fact the ledger cannot state. The statement then books it in the wrong day — and potentially the wrong month. |
| `DemoStore.stats` (`store.ts:486`) | `dueBoard(this.db, Date.now())` | Consistent for the UI, but the one store read that cannot be asked about another day. |

The backdating gap is the user-facing half; the rest is testability debt.

---

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
- **Conflict repair needs a script.** The three-scan undo dance (NOV) is
  performable but nothing in the UI suggests it; a tech who mis-scans
  either invents it or leaves the projection wrong.

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
