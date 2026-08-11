# Papa Vendor

Inventory and operations for film equipment rental houses. Every physical item carries a QR tag; staff scan gear in and out; inventory stays live and accurate — offline, one-handed, at 6am on a loading dock.

The vendor-side companion to the [Papa Rentals](../papa-rentals) marketplace. Standalone for now; designed so the marketplace can plug in later as a demand channel.

## Status

**Phase 0 — foundations.** Planning complete, no application code yet.

## Read in this order

| Document | What it is |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | The four principles and the hard rules. **Read before writing code.** |
| [`docs/PLAN.md`](docs/PLAN.md) | Authoritative. Design, phasing, and the 20 overrides on the architecture. |
| [`docs/architecture.md`](docs/architecture.md) | Detailed technical reference — schema, sync, conflict cases. Partially superseded; see the banner. |
| [`docs/research-pain-points.md`](docs/research-pain-points.md) | The sourced evidence base. Most design arguments trace back here with a URL. |
| [`docs/assumptions.md`](docs/assumptions.md) | Every guess made without field data, to walk with the pilot vendor. |

## The shape of it

- **Scanner** — thumb-driven Android app (React + Vite + Capacitor) for the warehouse floor. Offline-first; the scan loop never touches the network.
- **Console** — dense desk surface in the same codebase for quoting, bookings, and the Today board.
- **Postgres** (via Supabase) with row-level security, all writes through server functions, an append-only scan event log, and a database-enforced guarantee that a camera cannot be promised to two jobs.

## The one thing to understand

These systems fail when staff stop scanning — and adoption is a cliff, not a curve. So the product's answer to *"what if someone just doesn't scan?"* is not a compliance report. It's the **gate pass**: the printable challan the driver needs to leave the yard can only be generated from a completed scan session. Nobody has to police anybody.
