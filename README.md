# Papa Vendor

Inventory and operations for film equipment rental houses. Every physical item carries a QR tag; staff scan gear in and out; inventory stays live and accurate — offline, one-handed, at 6am on a loading dock.

The vendor-side companion to the Papa Rentals marketplace. Standalone for now; designed so the marketplace can plug in later as a demand channel.

## Status

**Phase 0 — foundations.** Planning complete, no application code yet.

## How this connects to Papa Rentals

**Separate repos, deliberately.** This is its own git repo; Papa Rentals lives inside the `Scrrenplay-papa` monorepo at `../papa-rentals` and is ignored by that repo's `.gitignore`. Different lifecycles, different release cadence, different risk profile — a marketplace demo and a system a business depends on shouldn't share a commit history.

Three connections, in order of when they matter:

| Connection | When | How |
|---|---|---|
| **Design tokens + icons** | Phase 0 | `packages/tokens` and `packages/icons` are consumed by both apps. Separate repos means these must be *published*, not path-imported — see below. |
| **`global_product_id`** | Phase 1 | A nullable column on `products` pointing at a small shared catalogue, so "Sony FX9" is one thing across every vendor. Cheap now, impossible to retrofit. |
| **Marketplace integration** | Phase 5 | Push available inventory out, pull marketplace bookings in as Papa Vendor bookings. When it happens, the marketplace adopts *this* schema's vocabulary through an adapter — not the reverse. |

### The shared-package consequence

With one repo, `packages/tokens` is a workspace path import. With two, it isn't. Options, in order of preference:

1. **A third small repo** (`papa-design`) published to GitHub Packages, consumed by both as a versioned dependency. Cleanest; a breaking token change is a major version and both apps upgrade deliberately.
2. **Git dependency** — `"@papa/tokens": "github:user/papa-design#v1.2.0"`. No registry setup, works today, but no local dev loop without linking.
3. **Copy, with a sync script and a CI check** that fails if the two drift. Ugly, honest, and fine until there's a second consumer.

Decide this in Phase 0, before either app imports anything. Whichever wins, the rule from `docs/PLAN.md` holds: **primitives are shared, semantic tokens are owned by each app** — so a marketplace brand refresh can't silently change what "overdue" looks like on a loading dock.

**Companion vault:** `~/PapaVendor-Vault` (Obsidian) holds the thinking layer — decisions, domain research, and why the architecture doc is partially superseded.

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
