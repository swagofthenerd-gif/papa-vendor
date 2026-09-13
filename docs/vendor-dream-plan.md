# The vendor's dream — the "where is my money" era

Written 2026-09-10 from two research passes: an inward walk of a vendor's
month against everything built and planned, and an outward study of the
khata-app adoption playbook (KhataBook, OkCredit, Udhaar Book), incumbent
rental software's praised/cursed features, Lahore/Mumbai rental practice,
and adjacent industries (Hilti ON!Track, telematics, Lenstag, ShareGrid).
Sources and full findings: the 2026-09-10 session log entry in the vault;
contradiction flags below. Supersedes nothing — this SEQUENCES phases 2–5
of `PLAN.md` and adds eight features missing from every prior plan.

**The thesis.** Phase 1 answered *"where is my gear?"* The vendor's dream
is *"where is my money?"* — and every piece of the money story projects
from artifacts the scan loop already produces. The khata apps proved the
loop that wins this market: **every ledger entry sends the client a
balance message; the owner collects faster; the message itself recruits
the next customer.** That loop is Papa Vendor's to own, because we have
the thing khata apps never had: the gear-truth behind every rupee.

**The guardrail** (from the khata graveyard): ledger fees, storefronts and
lending all failed; flat per-business pricing and transaction-shaped
adjacencies (cross-hire, marketplace) are the durable model. No BNPL, no
per-seat pricing, ever.

**Status marks (added 2026-09-13, W8).** Each phase below carries a
*Status* block: ✅ shipped (with the migration or screen), ◐ partial (with
what is missing), ✗ not started. The blunt summary: **Phases B–E are
built on the phone and on the server; Phase A — the part that makes any
of it real — is half missing.** The server side of auth exists (0016);
the phone has no login, no session, no sync and has never called an RPC.
See [What the second year said](#what-the-second-year-said) at the end.

---

## Phase A — Make it real (the gate; ~2–3 weeks)

Nothing below counts until a phone in a warehouse runs it.

1. **Auth**: phone-OTP at enrolment only (SMS economics), device sessions,
   per-user PIN fast-switch. Binds `device_id` to sessions — closing the
   security review's accepted-open item.
2. **Android build**: Capacitor + ML Kit + SQLCipher (the type-enforced
   seam exists). FIRST: the throwaway speed spike on a cheap Android —
   <100ms decode-to-feedback and the 30-minute thermal budget are still
   unproven and are the product's kill-shot test.
3. **Photo upload path** to R2 (bucket exists; hours, not days).
4. **Roman Urdu switch**: STR_UR mirroring strings.ts + a language toggle
   in settings. Ship a first draft; the pilot techs correct the wording
   (assumptions #8–9 validated by use, not meetings).
5. Non-code, parallel: print one rack's labels (tag-survival clock),
   one afternoon with the pilot vendor (deposits, pencils, seasonal
   pricing, attendant custom — the assumptions gate on phase C).

*Status (W8):*
1. ◐ **Auth** — server shipped (0016: OTP-at-enrolment, hashed device
   sessions, PIN gate, revocation, device binding in `submit_scan_batch`);
   **no client**: the app has no login screen, no session store, no
   token. → W9.
2. ◐ **Android build** — Capacitor APK with native ML Kit scanning,
   haptics and a long-press perf instrument exists
   (`apps/app/android/…/app-debug.apk`); SQLCipher is a type-enforced seam
   (`device-key.ts`) with no driver behind it; the speed spike on a cheap
   phone is an open human gate.
3. ✗ **Photo upload** — bucket and key exist (R2), no upload path. → W9.
4. ✅ **Roman Urdu** — `strings-ur.ts`, full parity type-enforced and
   tested, the switch in Settings.
5. ✗ **Non-code** — the three human gates are still open: printed labels,
   the vendor afternoon (`docs/assumptions.md` now opens with the
   checklist), the 30-minute scan test.

## Phase B — The money book (the heart; offline-first; ~3–4 weeks)

Every item here records the past → works offline by the CONTRIBUTING rule.

1. **The udhaar ledger**: append-only `customer_ledger_entries`
   (charge / payment / deposit / late fee / damage charge); balance is a
   projection. Override #14 pulled forward from phase 3 — the khata
   evidence says the ledger IS the owner-side adoption wedge.
2. **The "Send balance" card**: one tap on a customer → WhatsApp image
   card (Rs owed, last 3 entries, oldest date) sent from the owner's own
   phone. Free, brand-carrying, authority-preserving.
3. **Charge-from-the-dock**: the reconciliation card's "Charge client"
   button writes a real ledger line; late returns auto-draft a late-fee
   line (owner confirms); the unbilled-extras leak closes.
4. **Monthly statement**: the month-end hisaab per customer, WhatsApp-
   forwardable, same challan-book styling.
5. **Money on the Today board**: a third strip — owed to me / due in
   today / earned this month — so the owner's morning glance covers the
   whole business, not just gear.
6. **Per-asset earnings + payback bar**: asset page money section (sum of
   ledger lines); the digest celebrates "FX9-02 has now earned back its
   Rs 3,500,000."
7. **Deposits + credentials**: CNIC photo at first rental (override #16),
   deposit held/applied/refunded with refund gated on clear inspection,
   and the **verified-client fast lane** (clean history ⇒ skip the gate,
   lighter deposit) — the gate blocks strangers; the fast lane makes
   clients *want* registration (Toehold/SharePal pattern).
8. **Payment QR**: org's JazzCash/Easypaisa/RAAST QR stamped on every
   money document. No gateway integration.
9. Two tiny wedges alongside: **turned-away demand log** (when Enquiry
   says no, persist it; "FX9: turned away 6× this month" on the product
   page — the buy signal) and the **"Backed up ✓" chip** (surface the
   real sync as reassurance; khata apps sell backup as a headline).

*Status (W8):*
1. ✅ Ledger — 0017 `customer_ledger_entries`, balances as projections;
   `reversal(of=…)` and `write_off` kinds (0018).
2. ✅ Send-balance card — `balanceCardText` → the owner's own WhatsApp.
3. ✅ Charge-from-the-dock + the late-fee draft (`lateFeeDraftFor`, the
   draft that holds after the scan-in).
4. ✅ Monthly statement — `monthlyStatementText`, one tap per customer
   (a batch send is a papercut in the year doc).
5. ✅ Money on the Today board — the strip; the Hisaab's month profit
   (0019).
6. ✅ Per-asset earnings + payback bar — rental money only, repairs in
   the denominator (0018/0019).
7. ◐ Deposits + credentials — the deposit state machine and the refund
   gate exist in schema and projection (0017) and **no phone door writes
   a deposit** (`no-deposit-door`); credentials: the server's
   `verified_customers` view and the phone's one local flag
   (ASSUMPTION #26); the verified-client fast lane is on quotes (0025
   D10, `#deposit-hint`).
8. ✅ Payment QR — `setPaymentQr`, stamped on money documents.
9. ◐ Turned-away log ✅ (with reason: shelf-short vs committed, 0022 +
   the client); the "Backed up ✓" chip ✗ — there is no sync to surface.
   → W9.
   Also outstanding from the year: `no-adjustment-door`, `no-blacklist`,
   `waived-fee-invisible`, `no-month-history-screen`,
   `no-lifetime-value-view`, `no-utilization-read` — the **B-polish
   week** the year doc's verdict asks for after W9.

## Phase C — Bookings without fear (the server era; ~4–5 weeks)

PLAN.md phase 2 + pricing, sequenced after the vendor afternoon validates
the assumptions it stands on.

1. Customers, bookings + lines, the exclusion constraint (double-booking
   impossible), pencils with expiry, three-layer availability calendar —
   with **wedding-season shading** (Dec–Feb is booked 4–6 months out).
2. **Extension-collision preview** — the "highest-value single screen in
   the product"; no incumbent shows it.
3. **WhatsApp-paste quoting**: the kit-list reader already parses the
   RFQ format Lahore actually uses; add rate cards (3-day week, holiday
   mask, logged overrides, **seasonal multiplier** on the org calendar)
   and the reply becomes a priced quote in under two minutes.
   First-to-quote wins deals — documented repeatedly.
4. **Margin-before-quote**: sub-rental costs and discounts net out on the
   quote screen, not in a phase-5 report.
5. Overdue escalation ladder (override #19) wired to the ledger's
   late-fee lines.

*Status (W8):*
1. ✅ Bookings — 0022 (the gist exclusion constraint: double-booking
   physically impossible; gapless numbers; pencils with a 24h TTL by
   predicate; least-utilised allocation; the credential gate) + 0023
   (reservations reach the phone) + the client (Desk tab, month calendar
   with wedding-season shading, the booking page's Confirm / Extend /
   Convert / Send / Cancel doors, the PROMISED stamp on the scanner).
2. ✅ Extension-collision preview — the structured collision list as
   data, three doors: Substitute (`reallocate_reservation`), Sub-rent
   (an intent line on the booking's note, crossing as `set_booking_note`
   since W11 — was year finding `sub-rent-intent-unreplayable`), Call.
3. ✅ WhatsApp-paste quoting — 0024 rate cards, the 3-day week, the
   opt-in weekend mask, the org calendar with multipliers, logged
   overrides as the final rate; the enquiry reply is a priced quote
   (`quoteForLines`), golden-tested EN + UR.
4. ✅ Margin-before-quote — `booking_sub_hire_cost` / `subHireCostFor`
   net every live expense tagged to the booking or its job, and since
   W11 `job_margin` reads the booking's bills from the job's side too:
   pencil at the enquiry, borrow against it, convert (was year finding
   `subhire-cost-unlinkable`).
5. ◐ Escalation ladder — desk-facing (`escalationStep`: nudge → call →
   late-fee draft → manager), the day-7 rung IS the khata's draft, the
   day-14 rung a local flag (ASSUMPTION #28); no server escalation row.

## Phase D — The living fleet (~2–3 weeks, interleavable)

1. **Usage-based service nudge**: `rental_days_since_service` vs a
   per-product threshold → NEEDS-A-DECISION card (Hilti's pattern;
   rescues the maintenance cut without rebuilding the module).
2. Battery-cycle auto-increment on flagged categories; auto-quarantine
   at threshold (research differentiator #11, rescued).
3. **Crisis-day swap**: from an asset page, swap a substitute onto a live
   job in one flow; damage claim = photo pair + amount + ledger line (no
   six-state machine).
4. Cycle counting (shelf-scan diff) + intake-by-scan (phase-1 leftover).
5. **Voice notes** on discrepancies/jobs/assets (Bykea's lesson: typing
   is the barrier; a scratch explained in ten spoken seconds).
6. **Dead-stock digest line**: "Idle 90+ days: Rs 1.4M of gear" monthly.

*Status (W8):*
1. ✅ Service by usage — 0021 (`rental_days_since_service` moved by the
   reducer on check_in, the `serviced` event with its expense link, the
   Sehat surface).
2. ◐ Battery cycles — counted per check_out; crossing the ceiling raises
   ONE alert; **auto-quarantine deliberately refused** (a state the
   system changed by itself is a state nobody trusts).
3. ✅ Crisis-day swap — 0020 `swap_asset`, three linked events in one
   session; the damage claim is the photo pair + a ledger line.
4. ◐ Cycle counting ✅ (ginti: `inventory_count` events, the diff, the
   copyable report); intake-by-scan ✗.
5. ✅ Voice notes — awaaz notes on the never-evict photo model.
6. ✅ Dead stock — the `dead_stock` view, the Sehat group, the Hisaab
   line with the unpriced count honest.

## Phase E — The network moat (the endgame)

1. **Cross-hire "Ask the market"**: shortage screens generate a formatted
   WhatsApp broadcast to a saved partner-house list; replies recorded as
   sub-rentals with cost and margin. The partner graph is the seed of the
   marketplace network before phase 5 arrives.
2. **Stolen-gear mode**: one tap flips the public tag/serial page to
   STOLEN with contact info + broadcast card to the partner list
   (Lenstag's proof: indexed serial pages + first-hours speed work).
3. **Hashed-CNIC defaulter check** (opt-in, cross-org, server-side hash
   only, legal review first — PECA posture preserved). The strongest
   moat available; handle like the loaded gun it is.
4. **Thermal-printer challan** (ESC/POS over Bluetooth, ~Rs 5,000
   hardware) — the parchi's paper twin.
5. Attendant/crew-out mode — only after the vendor confirms the custom
   (new assumptions entry).

*Status (W8):*
1. ✅ Cross-hire — 0025 partner houses, "Ask the market" from every
   shortage screen, sub-hire in (the unit joins as `sub_rented_in`, the
   cost on the kharcha book) and out (a real job, the charge on the
   partner's khata), `returned_to_owner`.
2. ✅ Stolen-gear mode — the public tag page goes loud (0020), the
   partner broadcast card in both languages (0025).
3. ✗ Hashed-CNIC defaulter check — not started; legal review first, as
   written.
4. ◐ Thermal challan — the ESC/POS bytes are golden-tested
   (`escpos.ts`); the Bluetooth transport is the Capacitor wave and **no
   printer has fed paper** (ASSUMPTION #42).
5. ✅ Attendant/crew — 0025 D7, names on the job card and the parchi
   (ASSUMPTION #29 — unverified custom, as the plan asked).

---

## New assumptions raised (add to docs/assumptions.md)

- Does the vendor need FBR-compliant invoice numbering at all? (Cut
  silently; now explicit.) *Still not in the ledger of guesses — ask it
  in the vendor afternoon anyway.*
- Is seasonal/peak pricing actually practiced, or is pricing purely
  relational discounting? *→ assumptions #20 (`#seasonal-pricing`), #38.*
- Is a mid-job swap negotiated by phone (recording problem) or expected
  from the system (allocation problem)? *The swap shipped as a recording
  door (0020); the allocation reading is what the substitute door on the
  calendar does. Ask which one they reach for.*
- Attendant/crew-out custom: real and common, or high-end only?
  *→ assumptions #29 (`#attendant-custom`).*

## Contradiction flags resolved

- Udhaar ledger moves from phase 3 to Phase B on khata-playbook evidence;
  PLAN's "houses tolerate Excel invoicing" holds for *invoices*, not for
  the balance relationship.
- CNIC anything stays off phones (override #13); the defaulter check is
  server-side hashed lookup only.
- QR over RFID reconfirmed — RFID evidence is all vendor marketing.

---

## What the second year said

The simulated year was re-lived on 2026-09-13 against every merged wave
(`docs/year-in-the-life.md`, "The second year"). What it says about
this plan:

1. **The sequencing held.** Every phase B–E feature the plan ordered was
   used in the month a vendor would use it, in the shape the plan
   predicted: the calendar refused the double promise by name, the
   quote went out before the truck, the swap kept one job's story, the
   ginti found the seeded discrepancy, the partner's unit came and went
   with its money on the right book. Nothing on the dream plan was
   built in the wrong order — **except that all of it was built before
   Phase A finished.**
2. **The pipe is the whole remaining risk.** The year cannot see a
   server. It proves what one phone does; it proves nothing about what
   happens when its queue — ops named after RPCs it has never called —
   meets Postgres. Two of the year's new findings were exactly that kind:
   an op with no RPC (`sub-rent-intent-unreplayable`) and a link the
   server accepts but the phone could not make after the fact
   (`subhire-cost-unlinkable`) — both closed in W11, when every write
   learned to cross. **W9 "the pipe"** (login, device
   session, pull sync, outbox drain, photo upload, on-device schema
   migration) is not a phase on this list because it is Phase A — and it
   comes before anything else.
3. **The money book's four missing doors are the adoption papercuts.**
   Deposits, reversals/write-offs, the blacklist, the waived fee — every
   one is past-fact recording, offline-safe, a sheet each. They were
   pinned in year one and are still pinned; the waves that followed
   built bigger things. **A B-polish week after W9**, before W10's
   motion and dark-theme work.
4. **The guesses are the next cheapest thing to fix.** Forty-two
   assumptions, every one flagged in code; the ten that cost most are
   now a checklist at the top of `docs/assumptions.md`, in the order to
   ask them in one afternoon. None of them changes a migration; most
   change one setting. Nothing in W9 depends on the answers, so the
   afternoon and the pipe can run in parallel.
5. **Thermal, SQLCipher and the phone's speed are still unproven by
   hardware.** Bytes are golden, the seam is typed, the APK scans — and
   no printer has fed paper, no encrypted database has opened, no cheap
   Android has run the 30-minute test. Those are the three things a
   review cannot answer and the owner can, in an afternoon each.
