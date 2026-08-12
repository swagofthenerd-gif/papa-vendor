# Papa Vendor

Inventory and operations for film equipment rental houses. Every physical item carries a QR tag; staff scan gear in and out; inventory stays live and accurate — offline, one-handed, at 6am on a loading dock.

The vendor-side companion to the Papa Rentals marketplace. Standalone for now; designed so the marketplace can plug in later as a demand channel.

## Status

**Phase 0 — foundations, largely complete.** Schema, RLS, scan event log, write path, cursor-pull sync and the offline engine are built and verified. Scanner UI is next.

## How this connects to Papa Rentals

**Separate repos, deliberately.** This is its own git repo; Papa Rentals lives inside the `Scrrenplay-papa` monorepo at `../papa-rentals` and is ignored by that repo's `.gitignore`. Different lifecycles, different release cadence, different risk profile — a marketplace demo and a system a business depends on shouldn't share a commit history.

Three connections, in order of when they matter:

| Connection | When | How |
|---|---|---|
| **Design tokens + icons** | Phase 0 | Live in their own public repo, [papa-design](https://github.com/swagofthenerd-gif/papa-design), consumed as a versioned git dependency — see below. |
| **`global_product_id`** | Phase 1 | A nullable column on `products` pointing at a small shared catalogue, so "Sony FX9" is one thing across every vendor. Cheap now, impossible to retrofit. |
| **Marketplace integration** | Phase 5 | Push available inventory out, pull marketplace bookings in as Papa Vendor bookings. When it happens, the marketplace adopts *this* schema's vocabulary through an adapter — not the reverse. |

### The shared design package

Tokens and the shared icon set live in their own repo,
[**papa-design**](https://github.com/swagofthenerd-gif/papa-design), consumed
here as a versioned git dependency:

```jsonc
"@papa/design": "github:swagofthenerd-gif/papa-design#v0.1.1"
```

It is **public**, deliberately: it holds colour values and SVG paths that are
already public in the marketplace repo, and public means consumers and CI
install it with no token ceremony. Strategy, competitive analysis and the
operational schema stay private, here.

The rule it enforces: **primitives are shared, semantic tokens are owned by
each app.** Sharing primitives stops the two apps drifting into different
oranges; keeping semantics local stops a marketplace brand refresh silently
changing what "overdue" looks like on a loading dock. Papa Vendor's semantic
layer is `apps/app/src/semantic.css` — status buckets, glove targets,
`--ff-code`, and the sun theme.

Vendor-specific glyphs stay in `packages/icons`, merged with the shared set at
render time, which also keeps parity with the marketplace mechanically
checkable.

A breaking token change is a **major version**, so both apps upgrade
deliberately rather than waking up restyled.

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
