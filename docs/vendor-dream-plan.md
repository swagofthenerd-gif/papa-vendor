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

---

## New assumptions raised (add to docs/assumptions.md)

- Does the vendor need FBR-compliant invoice numbering at all? (Cut
  silently; now explicit.)
- Is seasonal/peak pricing actually practiced, or is pricing purely
  relational discounting?
- Is a mid-job swap negotiated by phone (recording problem) or expected
  from the system (allocation problem)?
- Attendant/crew-out custom: real and common, or high-end only?

## Contradiction flags resolved

- Udhaar ledger moves from phase 3 to Phase B on khata-playbook evidence;
  PLAN's "houses tolerate Excel invoicing" holds for *invoices*, not for
  the balance relationship.
- CNIC anything stays off phones (override #13); the defaulter check is
  server-side hashed lookup only.
- QR over RFID reconfirmed — RFID evidence is all vendor marketing.
