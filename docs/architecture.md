> **⚠ SUPERSEDED IN PART.** This is the detailed technical reference — schema DDL, sync
> design, and the full conflict enumeration. **Twenty of its decisions are overridden by
> `PLAN.md`**, including the containment auto-scan, the ordering key, the correction
> mechanism, the sync engine choice, the theme strategy, and the phasing. Read
> `PLAN.md` → "What overrides the architecture document" before implementing anything
> from this file.

# Papa Vendor — Technical Architecture

Read: `/home/shaharyar/Scrrenplay-papa/papa-rentals/src/styles.css`, `types.ts`, `components/primitives.tsx`, `components/ui.tsx`, `vendors.ts`, `views/HostDashboard.tsx`, `store.tsx`, `.claude/skills/papa-rentals/SKILL.md`.

---

## 0. The framing, honestly

The user asked for "really smooth" and "the safest back end and front end". Those words don't mean what they sound like.

**Smooth is not animation.** Smooth is *never blocking a human on a network round-trip during physical work*. A grip holding a 40kg case in one hand and a phone in the other must see the scan register in under 100ms, always, including in a basement with no bars. That means: every scan writes to local SQLite first, the UI re-renders from local SQLite, and the network is a background process that the user never waits on. Any architecture where the scan handler `await`s an HTTP call has already failed, regardless of how fast the server is.

**Safe is not "a big trusted brand".** Safe here means four specific things:
1. **No client-trusted authorization.** The phone never decides what it's allowed to see or write. Postgres RLS + server-side write validation decide.
2. **Append-only truth on the scan loop.** You can never delete or silently rewrite the record of "who scanned what, when". Damage disputes are money disputes; the log is the evidence.
3. **Referential integrity enforced by the database**, not by hope. In an inventory system, integrity *is* the product.
4. **Recoverability.** PITR backups, and a rebuild-projections-from-events path so a bad deploy can't permanently corrupt inventory state.

There is a real, non-obvious tension between (1) and offline-first, and most of this document is about resolving it.

---

## 1. Stack recommendation

### 1.1 Verdict on Supabase

**Keep Supabase for Postgres, Auth, Storage, and (limited) Realtime. Do NOT use `supabase-js` as the data layer for the scanner.**

This is the single most important call in the document, so let me be specific about why.

Supabase's client model is: the browser holds a JWT, talks directly to PostgREST, and RLS policies decide what it can read and write. That model is excellent and genuinely safe *when online*. It has three properties that break under offline-first:

- **There is no offline story at all.** `supabase-js` has no local persistence, no write queue, no replication. You would be hand-rolling all of it.
- **Realtime + RLS compose poorly.** Supabase Realtime evaluates RLS per-subscriber per-change. It works, but under RLS-heavy multi-tenant load it is the component most likely to become your scaling wall, and it delivers *changes since you subscribed* — it does not solve "I was offline for six hours, catch me up", which is the actual requirement.
- **Direct table writes cannot express the invariant that matters.** The core business rule is "this asset is not double-booked over this interval." That is a constraint across rows, and RLS cannot express it. It must live in a Postgres exclusion constraint plus a server-side function. So writes must go through RPCs anyway — which means the "just write to the table from the client" convenience Supabase is famous for is unusable for us regardless.

So Supabase's *database* is right (Postgres is the correct choice — intervals, GiST exclusion constraints, `ltree`, `jsonb`, and logical replication are all load-bearing below). Supabase's *client architecture* is wrong for this app.

**Cost:** Free → $25/mo Pro (needed on day one for PITR and no project pausing) → ~$100–300/mo at scale. Add-ons for extra storage/egress.
**Alternative considered:** Neon + a hand-rolled Hono/Fastify API on Fly.io. More control, no RLS-vs-sync-rules duplication (see below), but you write auth, storage, and file uploads yourself — probably 6+ weeks of work you don't need to do.
**Risk it carries:** Supabase's connection pooler (Supavisor) and Realtime are the historical weak points. Mitigation: no long-lived direct connections from clients, use RPC over PostgREST, keep Realtime for low-volume "someone changed the calendar" nudges only, never as the sync mechanism.

### 1.2 Sync layer — the real decision

Four candidates, evaluated against *this* domain:

**A. Yjs / CRDTs — reject, firmly.**
CRDTs guarantee convergence, not correctness. If two devices offline both assign asset `FX9-002` to different jobs on the same day, a CRDT will *successfully merge* — and produce a state where the last writer silently wins and nobody is told there was a conflict. That is the worst possible outcome: a double-booking that looks clean. CRDTs are for collaborative text, where "any consistent merge" is acceptable. Here, the conflict is business-critical information that must survive to a human. Reject.

**B. ElectricSQL (post-2024 rewrite) — strong second place.**
Electric is now a read-path sync engine: it streams Postgres changes into "shapes" (filtered subsets) over HTTP with strong caching. It deliberately does *not* handle writes — you write through your own API. That write model is exactly what I want (server-authoritative RPCs). It's cheap, self-hostable, and the HTTP/CDN caching model is genuinely elegant for seeding a device fast.
**Why not first:** you still hand-roll the entire outbox, the local schema, retry/backoff, and reconciliation of optimistic local state against arriving shape updates. That is the hard 30% and Electric leaves it to you. Also its shape filters are another authorization surface distinct from RLS.

**C. PowerSync — recommend. Primary choice.**
PowerSync replicates Postgres → on-device SQLite via logical replication and "sync rules" (SQL-ish bucket definitions), and ships a first-class **upload queue** with transactional batching, retry, and crash-safety. Critically, its upload path is *your code*: a `uploadData()` hook that you point at Postgres RPC functions. So:
- Reads: server-filtered, incremental, resumable after arbitrary offline duration. This is the part that is genuinely hard to hand-roll (checkpoints, partial buckets, compaction) and PowerSync has solved it.
- Writes: go through your own `SECURITY DEFINER` RPCs, which enforce availability constraints, org scoping, and role permissions server-side. Nothing is client-trusted.
- Local store is real SQLite (via `@journeyapps/react-native-quick-sqlite` on native / wa-sqlite+OPFS on web), with reactive `watch()` queries that re-render React on local change. Sub-millisecond reads.

**Cost:** free dev tier; paid cloud roughly $35/mo entry, scaling with synced data volume and connected clients. **It is also self-hostable** (the sync service is open source, FSL→Apache), which caps the lock-in risk — if the bill or the vendor becomes a problem you run it on a Fly machine next to Supabase.
**Risk it carries, stated plainly:** (i) **Sync rules are a second authorization surface parallel to RLS.** If a sync rule is looser than the RLS policy, data leaks to a device even though PostgREST would have refused it. This is the #1 security risk in the whole design and gets its own mitigation (§7). (ii) Bucket design mistakes cause "bucket explosion" — devices re-syncing far too much data. (iii) It's a young-ish company; the self-host escape hatch is the insurance.

**D. Hand-rolled: event log + outbox + `updated_at` cursor pull.**
Entirely viable. ~3–4 weeks to get right, and you own every edge case (missed checkpoints, tombstones for deletes, clock skew, partial-sync tears). I'd choose this only if PowerSync's pricing model turns out hostile at scale.

**Decision: PowerSync + Supabase Postgres, with all writes via `SECURITY DEFINER` RPCs. Fallback plan documented: swap the read path to ElectricSQL, keeping the same RPC write path.** Because writes never depend on PowerSync, that swap is contained — this is why the write path must be built as "call an RPC", never as "PowerSync CRUD table ops", even though PowerSync makes the latter easy. **Write that rule down in CONTRIBUTING.md on day one.**

### 1.3 The rest

| Concern | Choice | Why | Alternative | Risk |
|---|---|---|---|---|
| UI framework | **React 18 + TypeScript + Vite** | Matches Papa Rentals exactly; the team already knows it; the shared token package assumes it. | Solid/Svelte (faster) | None material. Don't be clever here. |
| Native shell | **Capacitor 6** | Same as sibling app. Gives camera, background sync, native SQLite, deep links for QR URLs. | React Native / Expo (better camera + list perf, but a *second* codebase idiom and can't share the sibling's CSS) | Low-end Android WebView. The sibling's SKILL.md already records that clipboard and blob downloads fail there — assume the same constraints. |
| Desktop console | **Same bundle, PWA in a browser** | The rental desk has a real computer and a browser. No Electron. | Electron (needless) | Web SQLite (OPFS) is less battle-tested than native. Desktop needs less offline anyway — see §3.5. |
| Local store | **SQLite** (native on Android, wa-sqlite/OPFS on web) | Real indexes and SQL joins. The scan screen needs `SELECT` over 5–20k assets with filters in <10ms; IndexedDB object stores can't do that without hand-built indexes. | IndexedDB/Dexie | OPFS quota eviction on web — mitigate with `navigator.storage.persist()` and treat desktop local data as a cache, not a source of truth. |
| QR scanning | **`@capacitor-mlkit/barcode-scanning`** (Google ML Kit) on Android; `BarcodeDetector` API with a `zxing-wasm` polyfill on web | ML Kit decodes in native code at camera framerate, works in bad warehouse light and at oblique angles, supports continuous multi-scan. | `html5-qrcode` / `jsQR` — both pump frames through a JS canvas loop; on a low-end Android they hit ~5fps and feel broken. **Reject.** | ML Kit adds ~2–4MB to the APK (use the Play-services-distributed variant to avoid bundling). |
| Auth | **Supabase Auth** — phone/OTP primary, email/password secondary | Lahore warehouse staff have phones, not work emails. OTP via a local SMS provider. | Clerk (nicer DX, another vendor, another bill) | SMS deliverability + cost in PK. Mitigate: allow an org admin to set a staff PIN for shared warehouse devices (see §7 risk 6). |
| File storage | **Supabase Storage**, org-scoped buckets, RLS-protected, signed URLs | Condition photos are legal evidence in damage claims. Needs immutability + access control. | Cloudflare R2 (cheaper egress at volume) | Egress cost. Mitigate: client-side downscale to ~1600px WebP before upload, store an original only when the user taps "high detail". |
| Photo upload offline | **Capacitor Filesystem + a separate `pending_uploads` queue** | Photos are too large for the JSON outbox. Store the file locally, queue the metadata row, upload the binary on a background task when on WiFi. | Base64 in the outbox — will OOM the WebView. | Device storage fills up. Mitigate: delete local originals after confirmed upload, cap the local cache. |
| Realtime | **Supabase Realtime, narrow use only** — desk console live calendar/notifications | Genuinely nice for the desktop console where two agents edit the same day's bookings. | Rely purely on PowerSync stream (it already is realtime) | Don't build two live paths for the same data. Prefer PowerSync's stream; add Realtime only if a specific screen needs a signal PowerSync doesn't carry. |
| Server logic | **Postgres functions (plpgsql) for anything transactional; Supabase Edge Functions (Deno) for anything I/O-bound** (PDF invoices, SMS, WhatsApp, email) | Availability checks must be in the same transaction as the write. That means SQL. | A Node API tier | plpgsql is unpleasant to test. Mitigate: pgTAP tests in CI, and keep functions thin — validate + insert + return, no business sprawl. |
| Money / PDFs | Server-side PDF gen in an Edge Function; decimal amounts as `BIGINT` minor units (paisa) | Never float for money. | `numeric` (fine too, but painful across the JS boundary) | — |
| Build/deploy | Vite → Vercel/Netlify (desk console) + Capacitor → Play Store internal track (scanner). GitHub Actions CI. Supabase migrations in `supabase/migrations`, applied via CI. | Matches sibling's habits, minus gh-pages (this app needs real env vars and headers). | gh-pages like the sibling | Play Store review latency for urgent scanner fixes. Mitigate: keep the web layer OTA-updatable via Capacitor Live Updates or a versioned remote bundle, so only native changes need a store release. |
| Errors/telemetry | Sentry + a `sync_health` table the app writes to | You will not otherwise discover that one device has had 400 queued writes for three days. | — | PII in breadcrumbs — scrub. |

---

## 2. Data model

### 2.1 The foreign-key question — answered

The user's global convention says *no FK constraints, handled at app level*. **For this system I recommend breaking that convention on the core graph, and I'd argue for it strongly.**

The convention makes sense for high-write service systems where you shard, where you delete asynchronously, and where an orphan row is a cosmetic annoyance. Here, an orphan row is: a scan event pointing at an asset that doesn't exist, so a camera body is invisible; or a booking line pointing at a deleted product, so an invoice prints a blank line. *Referential integrity is the product.* And the app-level enforcement story is much weaker than usual here, because writes originate on **offline devices with stale data** — the exact scenario where app-level checks are guaranteed to be wrong.

Concretely:

- **FKs ON** for the ~18 tables in the inventory/booking/billing core (`assets`, `asset_tags`, `asset_containment`, `bookings`, `booking_lines`, `asset_reservations`, `scan_events`, `condition_reports`, `invoices`, `payments`, `maintenance_orders`). All `ON DELETE RESTRICT` — nothing in this system should ever cascade-delete; soft delete only.
- **FKs OFF** for append-only/analytical tables that must accept writes even if a referent is gone: `audit_log`, `sync_telemetry`, `analytics_*` rollups. These store IDs as bare `uuid` plus a denormalized text label so they remain readable forever.
- **The local SQLite schema has no constraints at all** — PowerSync's client schema is intentionally untyped and constraint-free. This is a feature, not a compromise: the device accepts anything optimistically and fast; the server is where truth is enforced. Strict server, lax client. That split is the honest resolution of the convention conflict.

Everything else in the conventions I'd keep as-is: `TEXT` not `VARCHAR`, `uuid` PKs (specifically **UUIDv7** — time-ordered, so index locality is good and client-generated IDs sort meaningfully in the event log), `TIMESTAMPTZ` in UTC, `deleted_at` soft deletes, `snake_case`.

Every tenant table carries `org_id uuid NOT NULL` as the **first column of every index** and every RLS policy is `org_id = current_org_id()`.

### 2.2 Tenancy, identity, roles

```sql
create table orgs (
  id uuid primary key default uuid_generate_v7(),
  name text not null,
  slug text not null unique,
  country text not null default 'PK',
  currency text not null default 'PKR',
  timezone text not null default 'Asia/Karachi',
  settings jsonb not null default '{}',   -- week_equals_days, prep_buffer_hours, etc.
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table users (            -- mirrors auth.users, holds profile
  id uuid primary key,          -- == auth.users.id
  display_name text not null,
  phone text,
  avatar_path text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table memberships (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id),
  user_id uuid not null references users(id),
  role text not null,           -- owner | manager | desk | warehouse | driver | readonly
  permissions jsonb not null default '{}',  -- per-user grants/revokes on top of role
  status text not null default 'active',    -- active | suspended
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, user_id)
);
```

Roles are a fixed enum with a **capability matrix in code** (shared package), not a `permissions` table — rental houses have 5 role shapes, not arbitrary RBAC, and a table would be over-engineering. `permissions` jsonb exists as the escape hatch for "let Bilal void invoices but nothing else".

Authorization is enforced three times, on purpose: RLS (can you see the row), RPC function body (can you perform this operation), UI (should we render the button). Only the first two are security.

`current_org_id()` reads a custom JWT claim set at login. Multi-org users switch orgs by re-minting the token — which **forces a full local re-sync**, so it's a deliberate, rare action, not a dropdown you flick.

### 2.3 The asset model — the hard part

Five distinct things get conflated by naive designs. Naming them:

1. **Product** — "Sony FX9". A catalog entry. Has specs, a default rate card, photos.
2. **Serialized asset** — one physical FX9 body, serial `1000345`, its own QR tag, its own condition and history.
3. **Bulk stock** — 200m of gaffer tape, 20 XLR cables. Individually indistinguishable. Counted, not identified.
4. **Kit / container** — a Pelican case that *holds* other assets. Is itself a physical thing with a tag.
5. **Permanent accessory** — the FX9's handle unit. Physically attached; moves with the parent; is not independently rentable.

**Decision: two tables, not one.** `assets` (things with identity) and `stock_lots` (things with quantity). I considered a single `assets` table with `tracking_mode` and a `quantity` column, and rejected it: every query would carry a mode branch, and bulk stock genuinely lacks the columns that make an asset an asset (serial, condition grade, service history, scan identity, containment). Forcing them together produces a table where half the columns are null half the time and the constraints can't be expressed.

```sql
create table products (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id),
  category text not null,             -- camera|lens|lighting|grip|audio|power|accessory
  manufacturer text not null,
  model text not null,
  display_name text not null,
  tracking_mode text not null,        -- serialized | bulk
  specs jsonb not null default '{}',
  default_rate_card_id uuid,
  replacement_value_minor bigint,     -- for insurance & damage claims
  hero_image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on products (org_id, category) where deleted_at is null;
```

```sql
create table assets (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id),
  product_id uuid not null references products(id),
  asset_code text not null,           -- human label: "FX9-02". Printed on the tag face.
  serial_number text,
  is_container boolean not null default false,   -- a case/kit body
  rentable boolean not null default true,        -- false for permanent accessories
  purchase_date date,
  purchase_price_minor bigint,

  -- PROJECTIONS, derived from scan_events. Never written by a client directly.
  status text not null default 'in_stock',
      -- in_stock | reserved | prepped | out | in_transit | overdue
      -- | in_service | quarantine | sub_rented_in | lost | retired | sold
  condition_grade text not null default 'good',  -- new|good|fair|poor|unserviceable
  current_location_id uuid references locations(id),
  current_booking_id uuid references bookings(id),
  current_parent_id uuid references assets(id),  -- what container it is inside now
  last_scan_event_id uuid,
  last_scanned_at timestamptz,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, asset_code)
);
create index on assets (org_id, status) where deleted_at is null;
create index on assets (org_id, product_id) where deleted_at is null;
create index on assets (org_id, current_parent_id);
```

```sql
create table stock_lots (              -- bulk: qty per product per location
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id),
  product_id uuid not null references products(id),
  location_id uuid not null references locations(id),
  qty_on_hand integer not null default 0,
  qty_reserved integer not null default 0,
  reorder_threshold integer,
  updated_at timestamptz not null default now(),
  unique (org_id, product_id, location_id)
);
```
`qty_on_hand` is also a projection — the truth is `stock_movements` (append-only deltas), so a miscount is corrected by appending an adjustment, never by editing the number. Same discipline as the scan log.

**Containment** — the "case came back but the battery plate didn't" problem:

```sql
create table asset_containment (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id),
  parent_asset_id uuid not null references assets(id),
  child_asset_id uuid not null references assets(id),
  relation text not null,            -- permanent | packed | subrented
  -- permanent: welded to the parent, always moves with it, never separately rentable
  -- packed:    currently living in this case, expected back in it
  expected boolean not null default true,   -- is it *supposed* to be here
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  check (parent_asset_id <> child_asset_id)
);
create unique index on asset_containment (child_asset_id) where removed_at is null;
```
The partial unique index is the key line: **a physical thing can be inside at most one container at a time.** That single constraint eliminates a whole class of "the plate is in two cases" bugs.

Kits are **not** a separate table. A kit *instance* is an asset with `is_container = true`; its contents are containment rows. What *is* separate is the **kit template** — the definition of what a "FX9 A-Cam Package" is supposed to contain:

```sql
create table kit_templates (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id),
  name text not null,
  pricing_mode text not null default 'fixed',  -- fixed | sum_of_parts | discount_pct
  rate_card_id uuid, discount_pct numeric(5,2),
  deleted_at timestamptz
);
create table kit_template_items (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  kit_template_id uuid not null references kit_templates(id),
  product_id uuid not null references products(id),
  qty integer not null default 1,
  required boolean not null default true   -- "nice to have" items don't block a pull
);
```

The check-in reconciliation is then a set difference: `expected_children(kit_asset) MINUS scanned_children(this check-in session)` → a `discrepancies` row per missing item, each with a resolution (`found_later`, `charged_to_customer`, `written_off`, `still_missing`). **This is a first-class screen, not an error toast.** It is the single most valuable feature in the product — losing a $400 battery plate is the daily bleed of every rental house.

**Permanent accessories** are `assets` with `rentable = false` and a `permanent` containment row. Scanning the parent implicitly moves them: the scan RPC walks the containment tree and writes child scan events with `implied_by_event_id` set, so the log stays complete and auditable without requiring the warehouse to scan 40 stickers.

### 2.4 QR tag identity — argue it

**The QR encodes an opaque, randomly-generated tag ID. Not the asset ID.** Firm position.

Encode:
```
https://tag.papavendor.pk/t/{v}{22-char base32 of 128 random bits}
```
- **Why a URL, not raw text:** an outside person (a client's production coordinator, a courier) who scans it with the stock phone camera gets a useful public page ("Sony FX9 · Property of XYZ Rentals · Call 03xx"). The app registers the domain as an Android App Link and intercepts it, parsing the ID locally — so it works with zero connectivity. You get both audiences from one label.
- **Why opaque and not the asset UUID:**
  1. **Re-issue.** Labels get soaked, peeled, gaffed over, printed on the wrong item. You need to print a new label for the same asset — a new tag ID bound to the same asset. If the tag *is* the asset ID you cannot distinguish "new label" from "different asset".
  2. **Revocation.** A destroyed/lost label must be markable dead, so scanning a peeled label found on the floor says "this tag was retired on 12 Mar", not "here's the FX9".
  3. **Pre-printing.** You print rolls of blank tags in advance and bind them at intake with a two-scan flow (scan tag → pick asset). With asset-ID tags you can only print after the asset exists, one at a time, which is operationally miserable.
  4. **No information leakage.** A tag ID reveals nothing about org, value, or inventory size to anyone who photographs a case in a hotel lobby. Encoding the org would be a small but real security and competitive leak.
  5. **Transfer.** When an asset is sold or sub-rented out permanently, unbinding the tag is a row update, not a re-labelling exercise.
- **Why 128 random bits:** guessing is infeasible, so the public resolve page can't be enumerated to scrape a competitor's inventory. `{v}` is a version char so a future format change is detectable.

```sql
create table asset_tags (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id),
  tag_code text not null unique,           -- GLOBALLY unique, not per-org
  asset_id uuid references assets(id),     -- null = printed but unbound
  status text not null default 'active',   -- unbound | active | retired | lost
  bound_at timestamptz, unbound_at timestamptz,
  label_batch text,                        -- which print run, for recalls
  created_at timestamptz not null default now()
);
create unique index on asset_tags (asset_id) where status = 'active';
```
Note `tag_code` is globally unique across orgs, not scoped — this is deliberate, so the public resolver is a single lookup and so a tag can never be ambiguous if two rental houses merge or one sub-rents to another. The `asset_tags` row itself is org-scoped by RLS; only the tiny public resolver function (SECURITY DEFINER, returns 4 public fields) can read across orgs.

**Every device caches the full `tag_code → asset_id` map locally.** It's ~50 bytes/row; 20,000 assets is 1MB. Offline scan resolution is a local index lookup, no network, sub-millisecond. An unknown tag offline is queued as an `unresolved_scan` and resolved on reconnect rather than rejected.

### 2.5 Bookings, holds, and the availability problem

Lifecycle: `draft → quoted → hold → confirmed → prepped → out → returned → closed`, with `cancelled` and `lost` terminals.

```sql
create table bookings (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id),
  booking_no text not null,                 -- gapless per-org, server-assigned
  customer_id uuid not null references customers(id),
  production_id uuid references productions(id),
  status text not null default 'draft',
  starts_at timestamptz not null,           -- customer-facing window
  ends_at timestamptz not null,
  prep_starts_at timestamptz,               -- widened window incl. prep + turnaround
  return_due_at timestamptz,
  pickup_mode text not null default 'pickup',  -- pickup | delivery
  quote_total_minor bigint, discount_minor bigint default 0,
  notes text,
  created_by uuid, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), deleted_at timestamptz,
  unique (org_id, booking_no)
);

create table booking_lines (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  booking_id uuid not null references bookings(id),
  line_kind text not null,       -- product | kit_template | specific_asset | bulk | service | subrental
  product_id uuid references products(id),
  kit_template_id uuid references kit_templates(id),
  asset_id uuid references assets(id),      -- set once a specific unit is allocated
  qty integer not null default 1,
  rate_card_id uuid, unit_rate_minor bigint, billed_days numeric(6,2),
  line_total_minor bigint,
  deleted_at timestamptz
);
```

The critical design point: **a booking line asks for a *product* ("an FX9"); a reservation binds a *specific asset*.** Desk staff book at the product level and shouldn't care which body. Allocation to a specific serial happens at prep time, or earlier if the customer demands a particular unit. This separation is what makes availability tractable — you check counts of a product over an interval, not a per-asset puzzle.

```sql
create table asset_reservations (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id),
  booking_id uuid not null references bookings(id),
  booking_line_id uuid not null references booking_lines(id),
  asset_id uuid not null references assets(id),
  period tstzrange not null,        -- ALREADY widened by prep + turnaround buffers
  state text not null,              -- hold | confirmed | out
  hold_expires_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,

  exclude using gist (
    asset_id with =,
    period with &&
  ) where (deleted_at is null and state in ('confirmed','out'))
);
create index on asset_reservations using gist (asset_id, period);
create index on asset_reservations (org_id, state, hold_expires_at);
```

Six things that constraint buys and that the design depends on:

1. **Double-booking becomes physically impossible at the database level.** Not "we check first" — the write fails. This is the safety guarantee that matters most, and it is why Postgres (not Firebase, not a document store) is non-negotiable.
2. **The partial `WHERE` means holds do not block each other.** Two agents can both hold the same camera for competing quotes — which is what a rental desk actually does. First to confirm wins; the other gets a clear "the FX9 was just confirmed to Zindagi Films" message, which is *correct business behavior*, not a bug.
3. **Buffers are baked into `period` at write time, not applied at query time.** A 2-hour prep window and a 4-hour turnaround are per-org settings; if you apply them in the availability query you must remember to apply them in ten places and you will forget one. Widening the stored range means the exclusion constraint enforces buffers for free.
4. **Holds expire via a `pg_cron` job** that soft-deletes `state='hold' AND hold_expires_at < now()`. Default TTL 24h, configurable, extendable by the desk. Expiry is announced (a notification), never silent.
5. **Late returns.** When `now() > upper(period)` and state is still `out`, a cron job extends `upper(period)` and flags `status='overdue'` on the asset. That extension **can collide with a downstream confirmed booking** — and the extension must still succeed, because the truck is already gone and reality outranks the schedule. So the extension is done with the exclusion constraint deferred/bypassed via a dedicated SECURITY DEFINER function that writes an `overbook_alerts` row instead of failing. **Principle: physical-reality events never fail; they raise alerts.** Schedule-intent events (confirming a future booking) *do* fail.
6. **Availability query** for "how many FX9 free 3–7 April":
```sql
select count(*) filter (where r.id is null)
from assets a
left join asset_reservations r
  on r.asset_id = a.id and r.deleted_at is null
 and r.state in ('confirmed','out')
 and r.period && tstzrange($start, $end, '[)')
where a.org_id = $org and a.product_id = $product
  and a.deleted_at is null
  and a.status not in ('retired','lost','in_service','sold');
```
GiST-indexed, fast. The desk console's calendar runs a bucketed variant with `generate_series` over days and caches per product.

### 2.6 The scan loop — event sourced, and only this

**Argument for event sourcing here specifically, and against it everywhere else.**

Event sourcing costs you: query complexity, projection rebuild machinery, schema-evolution pain on old events, and a much steeper learning curve for whoever maintains this. Paying that across the whole app (customers, invoices, rate cards) would be a mistake — CRUD with an audit log is plenty for those.

But the scan loop is different in four ways that flip the calculus:

1. **It is the offline write path.** Offline writes are inherently a log of intents that must be replayed in order against a server that has moved on. That *is* an event log; the only question is whether you admit it.
2. **Events commute badly but compose well.** "Asset X went out on booking B at 06:14 by user U at location L" is a complete, self-contained fact that is true regardless of what else happened. A state mutation ("set status = out") is not — replaying it later can clobber newer truth.
3. **It is the evidentiary record.** Damage disputes and insurance claims turn on "who had it and when". A mutable status column cannot answer that; an immutable log can, forever.
4. **Projections can be rebuilt.** If a status-derivation bug ships, you fix the reducer and replay. With mutable state, a bad deploy permanently corrupts inventory and the only recovery is a PITR restore that loses everything else too. This is worth a lot.

```sql
create table scan_events (
  id uuid primary key,                      -- UUIDv7, generated ON DEVICE
  org_id uuid not null references orgs(id),
  asset_id uuid references assets(id),      -- null iff tag unresolved at scan time
  tag_code text,                            -- always recorded, even if unresolved
  event_type text not null,
  -- check_out | check_in | move | pack_into | unpack_from | begin_prep | complete_prep
  -- | flag_damage | send_to_service | return_from_service | quarantine | release
  -- | retire | found | inventory_count | subrent_in | subrent_out
  booking_id uuid references bookings(id),
  session_id uuid,                          -- groups one pull/return session
  from_location_id uuid references locations(id),
  to_location_id uuid references locations(id),
  parent_asset_id uuid references assets(id),
  condition_grade text,
  actor_user_id uuid not null references users(id),
  device_id text not null,
  client_seq bigint not null,               -- monotonic per device, never resets
  device_time timestamptz not null,         -- what the phone thought. UNTRUSTED.
  device_clock_offset_ms bigint,            -- measured skew at time of scan
  effective_time timestamptz not null,      -- device_time + offset. Used for display/ordering.
  server_time timestamptz not null default now(),  -- authoritative arrival time
  payload jsonb not null default '{}',
  implied_by_event_id uuid references scan_events(id),  -- child moved with its parent
  superseded_by_event_id uuid references scan_events(id),
  created_at timestamptz not null default now(),
  unique (device_id, client_seq)            -- idempotency: replay is a no-op
);
create index on scan_events (org_id, asset_id, effective_time desc);
create index on scan_events (org_id, session_id);
create index on scan_events (org_id, server_time);
```

**No UPDATE, no DELETE.** Enforced with a rule/trigger and by granting only INSERT. A mistaken scan is corrected by appending a *correcting event* that sets `superseded_by_event_id` on the original — the original stays visible in history with a strikethrough. This is how a warehouse manager thinks anyway ("no, that went out on Tuesday not Monday") and it means the log can be trusted as evidence.

**Projection.** `assets.status/current_location_id/current_booking_id/current_parent_id` are maintained by an `AFTER INSERT` trigger running a pure reducer function `apply_scan_event(asset_row, event) → asset_row`, applied **only if the incoming event's ordering key is greater than the asset's `last_applied_key`**. Ordering key = `(effective_time, server_time, device_id, client_seq)`. Out-of-order late arrivals (a device that was offline for two days) therefore do *not* clobber newer truth — instead they insert into history and emit a `late_event_alerts` row if they would have changed the current state. That alert is a screen the manager reviews. **Silently discarding a late event is the bug that loses a camera; surfacing it is the feature.**

A `rebuild_asset_projection(asset_id)` function replays the whole log for one asset; a batch version replays an org. Both run in CI against golden fixtures.

### 2.7 Condition, damage, maintenance

```sql
create table condition_reports (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, asset_id uuid not null references assets(id),
  scan_event_id uuid references scan_events(id),
  booking_id uuid references bookings(id),
  phase text not null,                -- out | in | service | intake | periodic
  grade text not null,                -- new|good|fair|poor|unserviceable
  checklist jsonb not null default '{}',   -- per-product-category template answers
  notes text, actor_user_id uuid not null,
  created_at timestamptz not null default now()
);

create table condition_photos (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, condition_report_id uuid not null references condition_reports(id),
  storage_path text,                  -- null while still queued on the device
  local_uri text,                     -- device-side path, cleared after upload
  upload_status text not null default 'pending', -- pending|uploading|done|failed
  sha256 text, width int, height int, bytes int,
  captured_at timestamptz not null,
  annotations jsonb                   -- circles/arrows drawn on the photo
);

create table damage_claims (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, booking_id uuid references bookings(id),
  asset_id uuid references assets(id),
  discovered_scan_event_id uuid references scan_events(id),
  severity text not null,             -- cosmetic|functional|total_loss|missing
  status text not null default 'open',-- open|quoted|billed|waived|settled|disputed
  estimate_minor bigint, charged_minor bigint,
  out_report_id uuid references condition_reports(id),
  in_report_id  uuid references condition_reports(id),
  narrative text, resolved_at timestamptz
);

create table maintenance_orders (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, asset_id uuid not null references assets(id),
  kind text not null,                 -- repair|calibration|cleaning|firmware|inspection
  status text not null default 'open',-- open|in_progress|awaiting_parts|external|done
  opened_from_claim_id uuid references damage_claims(id),
  vendor_name text, cost_minor bigint,
  opened_at timestamptz not null default now(), closed_at timestamptz,
  due_at timestamptz,                 -- for scheduled/periodic service
  notes text
);
```
The out-report/in-report pairing on a claim is what makes damage billing *defensible*: you can put two photo sets side by side and say "this dent was not there on 3 April". This is a real revenue feature — most Lahore rental houses currently lose these arguments because they have no evidence.

`assets.condition_grade` is a projection of the latest condition report. `asset_health_score` (a view) blends: days since service, cumulative rental days, open claims, count of `fair/poor` reports in last 90d.

### 2.8 Pricing

The "3-day week" convention (a week of rental bills as 3 days) is an org-level setting *and* overridable per rate card, because it varies by category — cameras are often 3-day-week, grip is often 4.

```sql
create table rate_cards (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  name text not null,                 -- "Standard 2025", "Agency Tier", "Long-form"
  customer_tier text,                 -- null = default; else matches customers.tier
  currency text not null default 'PKR',
  week_equals_days numeric(4,2) not null default 3,
  month_equals_days numeric(5,2) not null default 10,
  min_billable_days numeric(4,2) not null default 1,
  weekend_counts_as numeric(4,2),     -- Fri-out/Mon-in billed as 1 day: a real convention
  effective_from date not null, effective_to date,
  deleted_at timestamptz
);

create table rate_card_entries (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, rate_card_id uuid not null references rate_cards(id),
  product_id uuid references products(id),
  category text,                      -- category-wide fallback if product_id is null
  day_rate_minor bigint not null,
  hourly_rate_minor bigint,
  replacement_value_minor bigint,
  unique (rate_card_id, product_id, category)
);

create table rate_tiers (             -- multi-day ladder, overrides the week formula
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, rate_card_id uuid not null references rate_cards(id),
  min_days integer not null, max_days integer,      -- null = open ended
  multiplier numeric(6,3),            -- billed_days = min(days, ...) * multiplier
  flat_days numeric(6,2)              -- OR: bill exactly N days regardless
);
```

Pricing is a **pure function in the shared TypeScript package**, `priceLine(line, card, tiers, calendar) → { billedDays, unitRate, total, explanation[] }`, mirrored by a plpgsql version used at invoice time. Two implementations of the same rule is a smell — mitigate by generating the SQL from the TS via a property test that fuzzes 10k inputs and asserts they agree, run in CI. If that proves painful, collapse to SQL-only and have the client call an RPC for quote previews (acceptable: quoting is a desk activity, always online).

The `explanation[]` array matters more than it looks: "6 days = 1 week (3d) + 3d → 6 billed days" printed on the quote stops the daily argument with the customer.

Kit pricing: `kit_templates.pricing_mode`. `fixed` uses the kit's own rate card entry; `sum_of_parts` sums children; `discount_pct` sums and discounts. Always show both numbers on the quote so the desk can see what the discount is.

### 2.9 Customers, invoices, money, sub-rentals

```sql
create table customers (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, kind text not null,   -- individual | company | production_house
  name text not null, tier text default 'standard',
  phone text, email text, ntn text, cnic text,   -- PK tax/ID numbers
  credit_limit_minor bigint default 0, payment_terms_days int default 0,
  blacklisted boolean default false, blacklist_reason text,
  deleted_at timestamptz
);
create table productions (   -- a shoot/project; groups bookings, has its own PO
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, customer_id uuid references customers(id),
  title text not null, kind text,   -- film|tvc|drama|corporate|wedding|music_video
  producer_name text, po_number text, starts_on date, ends_on date
);
create table invoices (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, invoice_no text not null,   -- GAPLESS, server-assigned
  customer_id uuid not null, booking_id uuid,
  status text not null default 'draft',  -- draft|issued|part_paid|paid|void|written_off
  issued_at timestamptz, due_at timestamptz,
  subtotal_minor bigint, tax_minor bigint, total_minor bigint,
  amount_paid_minor bigint default 0,
  snapshot jsonb not null,   -- frozen copy of lines+rates at issue time
  unique (org_id, invoice_no)
);
create table payments (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null, invoice_id uuid, customer_id uuid not null,
  kind text not null,             -- payment|deposit|deposit_refund|credit_note|write_off
  method text not null,           -- cash|bank_transfer|cheque|easypaisa|jazzcash|card
  amount_minor bigint not null,   -- signed
  reference text, received_at timestamptz not null,
  recorded_by uuid not null, created_at timestamptz not null default now()
);
create table sub_rentals (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  direction text not null,        -- in (we rented from them) | out (we lent to them)
  counterparty_org_id uuid,       -- set if they're also on Papa Vendor
  counterparty_name text not null,
  booking_id uuid,                -- the customer booking this covers
  product_id uuid, asset_id uuid, -- asset_id set for direction='in' shadow assets
  cost_minor bigint, charge_minor bigint,
  starts_at timestamptz, ends_at timestamptz,
  status text not null default 'requested'
);
```

**Sub-rental design note:** gear rented *in* gets a real `assets` row with `status='sub_rented_in'`, a temporary QR tag, and an owning `sub_rental_id`. This is important — the warehouse must be able to scan it exactly like owned gear (they will not remember which lens is borrowed), and the return-to-owner deadline must appear on the same calendar. A ghost/virtual representation would break the scan loop. On return, the asset is soft-deleted and the tag unbound.

**`invoice_no` and `booking_no` are gapless per org** — required for FBR/tax defensibility. Gapless means a serialized allocation, which means **online-only**. That's fine: nobody issues an invoice from the back of a truck.

### 2.10 Locations

```sql
create table locations (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  parent_id uuid references locations(id),
  path ltree not null,        -- 'warehouse_dha.room_2.rack_a.shelf_3.bin_11'
  kind text not null,         -- warehouse|room|rack|shelf|bin|vehicle|job_site|service
  name text not null,
  tag_code text,              -- bins get QR tags too: scan bin, then scan gear into it
  deleted_at timestamptz
);
create index on locations using gist (path);
```
`ltree` gives "everything under warehouse_dha" as one indexed query. Vehicles are locations — that's how you answer "what is on the Hiace right now", which is the question at 6am.

### 2.11 Audit log

```sql
create table audit_log (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,       -- deliberately NO fk
  table_name text not null, row_id uuid not null,
  action text not null,       -- insert|update|delete|rpc
  actor_user_id uuid, actor_label text,   -- denormalized, survives user deletion
  before jsonb, after jsonb, changed_fields text[],
  ip inet, device_id text, request_id text,
  at timestamptz not null default now()
) partition by range (at);
```
Written by a generic trigger on every mutable table plus explicit entries from RPCs. Monthly partitions, detached and archived to Storage after 24 months. Distinct from `scan_events`: audit is "who touched the record", scan events are "what happened to the object". Both are needed and they are not substitutes.

---

## 3. Offline and sync design

### 3.1 What lives on the device

Not "everything". A device syncs a **scoped working set** defined by PowerSync sync rules, keyed on org + role + a rolling time window:

| Data | Scanner (phone) | Desk (browser) |
|---|---|---|
| `asset_tags` (tag_code → asset_id) — full org | ✅ all | ✅ all |
| `assets` + `products` — full org | ✅ all | ✅ all |
| `locations`, `kit_templates`, `asset_containment` | ✅ all | ✅ all |
| `bookings` + lines + reservations | ⏱ −30d to +60d | ⏱ −180d to +365d |
| `customers`, `productions` | active only | ✅ all |
| `scan_events` | ⏱ last 14d only | ⏱ last 30d |
| `condition_reports` | for bookings in window | in window |
| Photos (binary) | thumbnails only, lazy full | lazy |
| `invoices`, `payments`, `rate_cards` | ❌ (rates: yes, read-only) | ✅ |
| `audit_log` | ❌ | ❌ (server query only) |

Sizing for a realistic Lahore house: ~4,000 assets, ~600 products, ~8,000 tags, ~1,500 bookings/yr. Total device payload ≈ **8–20 MB**. That's a 30-second first sync on 3G and nothing thereafter. Even a 40,000-asset house lands under 100MB. **There is no need for partial asset sync, and adding it would be premature.** Full-inventory-on-device is what makes the scanner instant.

`scan_events` are windowed because they grow unboundedly and the device only needs recent history to render "last seen". Full history is a server query on the asset detail screen (online-only, and that's fine — nobody needs 2-year-old history in a truck).

**Seeding:** on first login, a full sync with a progress screen that is honest ("Downloading your inventory — 3,200 of 4,100 items"). The app is unusable until it completes; that's the correct tradeoff, and it happens once. Subsequent app opens resume from a checkpoint. If a device is wiped or corrupted, the recovery is a fresh full sync — which must be a one-tap action in Settings, because it will be needed.

### 3.2 The outbox

Two queues, because photos and rows have different physics.

```
-- local SQLite, device-only
CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,       -- UUIDv7, becomes the server row id
  seq           INTEGER,                -- AUTOINCREMENT, never resets. Ordering key.
  op            TEXT NOT NULL,          -- rpc name: scan_asset, create_booking, ...
  payload       TEXT NOT NULL,          -- JSON args
  idem_key      TEXT NOT NULL UNIQUE,   -- device_id || ':' || seq
  depends_on    TEXT,                   -- outbox.id that must land first
  state         TEXT NOT NULL,          -- pending|inflight|acked|failed|conflicted
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  created_device_time INTEGER NOT NULL,
  clock_offset_ms     INTEGER NOT NULL,
  error_code    TEXT, error_detail TEXT,
  resolution    TEXT                    -- how a conflict was settled
);

CREATE TABLE pending_uploads (
  id TEXT PRIMARY KEY, outbox_id TEXT, local_uri TEXT NOT NULL,
  target_path TEXT NOT NULL, sha256 TEXT, bytes INTEGER,
  state TEXT NOT NULL, attempts INTEGER DEFAULT 0, wifi_only INTEGER DEFAULT 1
);
```

Rules:
- **Strictly ordered per device.** Flush in `seq` order, one batch at a time, stop on the first unresolved failure. Out-of-order flushing produces "checked in before it was checked out" and is not worth the throughput.
- **Idempotent by `idem_key`.** The server RPC does `INSERT ... ON CONFLICT (device_id, client_seq) DO NOTHING RETURNING`. A retry after a timeout where the server actually succeeded is a no-op. This is non-negotiable — flaky mobile networks *will* produce that case daily.
- **`depends_on`** handles local-only chains: create a booking offline, then scan gear onto it. The scan's payload references a client-generated booking UUID that doesn't exist server-side yet. Because IDs are client-generated UUIDv7 and the server accepts them, there is no ID-remapping problem at all — but ordering still matters, so the dependency edge stays.
- **Backoff:** 1s, 2s, 5s, 15s, 60s, 5m, 30m, cap 30m. Plus an immediate flush on `online` event and on app foreground.
- **Batching:** up to 50 ops per request, executed inside one Postgres transaction via a `submit_batch(ops jsonb[])` RPC. All-or-nothing per batch, so a partial network failure never half-applies a pull session.
- **Poison pill guard:** after 8 failed attempts with a non-retryable error, mark `failed`, *skip it* rather than blocking the queue forever, and surface it in a "Needs your attention" list. A single bad row must never freeze a warehouse's entire sync — that's the failure mode that gets an app uninstalled.
- Runs in a Capacitor background task so the queue drains even if the app is backgrounded in the van.

### 3.3 Conflict cases, enumerated

The four the brief names, plus five more that will actually happen.

**C1 — Two staff scan the same asset out to different jobs, both offline.**
Both writes succeed locally; the grip is holding one camera. On reconnect, both `scan_events` insert (the log is append-only and *both are true statements about what someone did*). The projection reducer applies the earlier `effective_time` and the later one is applied but flagged: `conflict_alerts(kind='double_checkout', asset_id, event_a, event_b)`. Server also attempts a `state='out'` reservation for each; the second hits the exclusion constraint and is recorded as an `overbook_alert` rather than rejected.
**Resolution: neither device is told it was wrong.** The desk console gets a red banner: "FX9-02 was checked out to two jobs. Physically it's on one truck. Which?" A human resolves; resolution appends a correcting event. **Do not auto-resolve this.** Any automatic rule (last-writer-wins, first-wins) produces a confidently wrong inventory, and confidently-wrong is worse than visibly-uncertain.

**C2 — Asset checked in on device A, simultaneously booked on device B.**
These do not actually conflict — check-in is a *past physical fact*, booking is a *future intent*. Both apply. The only real question is whether the check-in's condition grade makes the asset unbookable (`unserviceable`). If so, the booking's reservation is auto-flagged `needs_reallocation` and the desk sees "the FX9 you booked came back damaged — pick another body", with a one-tap swap to another available unit. **Auto-resolvable, because there's a safe default (surface + suggest) and no ambiguity about what happened.**

**C3 — Booking edited on desktop while the phone has stale data.**
The phone's pull list is a *snapshot*. When the phone flushes scans against a booking whose `version` (a monotonically incremented column) is newer than what the phone had, the server accepts the scans (physical facts again) but returns `booking_changed`. The phone shows a non-blocking bar: "This job changed while you were offline — 2 items added, 1 removed" with a diff. Items the warehouse already pulled that were since removed become `unexpected_items` on the pull sheet, not errors. **The person holding the gear is never blocked by a change made at a desk.**

**C4 — Asset retired while it's out.**
Retiring an asset that has an open `out` reservation is **rejected server-side** with an explicit reason. Retirement is an administrative act with no urgency; there is no reason to allow it optimistically. The correct flow is: mark `pending_retirement`, and the retirement executes automatically on check-in. If the retire was queued offline before the check-out arrived, the ordering (per-device seq, cross-device `effective_time`) determines the outcome, and if it lands after, the RPC converts it to `pending_retirement` and tells the user.

**C5 — Bulk stock count drift.** Two people count XLR cables offline: 18 and 20. Both are `stock_movements` of kind `count_adjustment` with an absolute observed value. **Last count wins for the projection**, both are retained, and a `count_discrepancy` alert fires if two counts within 6 hours disagree. Bulk stock is inherently approximate and pretending otherwise creates fake precision.

**C6 — Same tag bound to two assets offline.** Two people bind the same blank tag at intake. The `unique index on asset_tags(asset_id) where status='active'` plus a unique `tag_code` means the second binding fails server-side. The second device gets a clear "that tag is already on FX9-02" and its local asset row reverts to untagged with a prompt. **Rare but catastrophic if allowed — hence a hard constraint.**

**C7 — Kit disassembled on one device, packed on another.** The `unique index on asset_containment(child_asset_id) where removed_at is null` makes "in two cases" impossible. The later write wins (a thing can only physically be where it was last put), earlier one gets `removed_at` set, and if the moves are within 5 minutes an alert fires because it usually means someone scanned the wrong case.

**C8 — A device comes back after 3 weeks offline.** Its `scan_events` are all far in the past. They insert into history; the projection reducer applies none of them (all older than `last_applied_key`); a `stale_device_import` summary is generated: "Device WH-03 uploaded 240 events from 12–18 March. 14 of them contradict current state. Review?" This is a screen, not a silent merge.

**C9 — Clock-skewed device.** See §3.6.

### 3.4 Online-only operations

This list is a contract, and the UI must make each one legible.

**Must be online (server-authoritative):**
- **Confirming a booking** (`hold → confirmed`). This is the availability commitment; it needs the exclusion constraint in the same transaction. Doing it offline means promising a camera you may not have, to a customer, in writing. Never.
- Issuing an invoice or credit note (gapless numbering).
- Recording a payment (money — needs a durable, ordered ledger and often a receipt number).
- Binding a QR tag to an asset (uniqueness).
- Creating/retiring an asset, changing a rate card, inviting staff, changing roles.
- Anything touching another org (sub-rental requests).

**Fully offline-capable (the entire scan loop):**
- Every `scan_event` type: check-out, check-in, move, pack, unpack, damage flag, service in/out, inventory count.
- Creating condition reports and capturing photos.
- Creating a **draft** booking or quote (draft ≠ commitment).
- Placing a **soft hold** — holds may overlap by design, so an offline hold is harmless. Confirming is not.
- Viewing anything in the synced working set.
- Building and printing a pull list.

The rule that generates this list: **if the operation asserts a fact about the physical past, it works offline. If it makes a promise about the future or allocates a scarce resource, it needs the server.** State that rule in the codebase; it will settle 90% of future arguments.

### 3.5 Honest, non-noisy pending-state UI

The failure mode is a screen covered in spinners and yellow badges that people learn to ignore within a week. Design principles:

1. **Never spin on the critical path.** A scan renders its result instantly from local state. There is no loading state on a scan, ever.
2. **One global status affordance**, not per-row badges. A slim strip under the header with three states:
   - Nothing (online, queue empty) — the strip is *absent*, not green. Green "all good" indicators are noise.
   - `Offline · 14 scans saved` — calm, neutral, informative. Not a warning colour. Being offline is normal and expected; the app must not act like it's broken.
   - `3 items need your attention` — accent orange, tappable, goes to a resolution list. Only for genuine conflicts, never for pending sync.
3. **Per-row indication only where the row is genuinely uncertain**: a 2px accent left-border on a row whose write is still queued, and a subtle strikethrough-and-restore animation if a write is rejected. No text badges.
4. **Rejections are conversations, not toasts.** A failed write pushes a card into "Needs attention" with what happened, what the app did, and one or two buttons that fix it. Never a red toast that disappears in 3 seconds while someone is carrying a case.
5. **Sync age, not sync status.** On the desk console: "Warehouse phone last synced 4 minutes ago" is more useful than a connection dot.
6. **Deliberate honesty about the confirm boundary.** When offline, the "Confirm booking" button is not hidden — it's present, disabled, with inline text: "Needs internet — availability is checked on the server." Hiding it makes people think the feature is missing. Explaining it teaches them the model in one exposure.

### 3.6 Clock skew

Device time is untrusted. Cheap Android phones drift, users change the clock, timezones get set wrong, and a phone that boots without network can be years off.

Approach:
- On every successful server contact, compute `offset = server_now - device_now` (using the `Date` response header / an RPC that returns `now()`), with a round-trip-time correction. Store a rolling median of the last 20 samples in `sync_meta`.
- Every scan records `device_time`, `clock_offset_ms` (the offset in force at scan time), and derives `effective_time = device_time + offset`. All three persist. Never overwrite `device_time` — its divergence is diagnostic.
- If the device has *never* synced (fresh install, offline first-run), offset is unknown. Record `effective_time = device_time`, set `clock_confidence='unknown'`, and on first sync the server back-corrects the whole batch by the newly-measured offset **only if** the implied drift exceeds 5 minutes, writing `time_corrected_events` audit rows. Do not silently rewrite; the correction is auditable.
- **Ordering uses `(effective_time, server_time, device_id, client_seq)`** — a total order, deterministic, tie-broken stably. `device_id` in the tiebreak means the same two events always resolve the same way on every replay, which is what makes projection rebuild reproducible.
- Also maintain a per-device monotonic counter that never goes backwards even if the wall clock does. If `device_time` regresses relative to the previous event on that device, clamp `effective_time` to `previous + 1ms` and flag `clock_regression`. This prevents a user changing the clock from reordering their own session.
- Use `elapsedRealtime()` (monotonic since boot, via a Capacitor plugin) for intra-session deltas — durations, "scanned 4 seconds ago" — never the wall clock.

**Uncertainty I'll flag:** I'm confident about the ordering scheme but not about the 5-minute back-correction threshold. What would resolve it: instrument `clock_offset_ms` from day one and look at the real distribution across the first 20 devices before hardcoding a policy.

---

## 4. Front-end architecture

### 4.1 One codebase, two surfaces, no `isMobile` soup

`isMobile` branching fails because it conflates three orthogonal things: viewport size, input modality, and **job role**. A manager on a phone should get the *console* (in a phone layout), not the scanner. A warehouse tablet on a big screen should get the *scanner*.

**Structure: two "surfaces" as top-level app shells, one shared core.**

```
apps/scanner/   → mount point, routes, shell   (thumb-first, one-hand, dark-friendly)
apps/console/   → mount point, routes, shell   (dense, keyboard-first, multi-pane)
packages/core/  → domain logic, sync, db, hooks — zero UI, 100% shared
packages/ui/    → primitives + tokens, shared; a handful of components take a `density` prop
```

Rules that keep this honest:
- **`packages/core` never imports from a surface, and contains no JSX.** Everything shared lives there: the local DB, the outbox, the pricing function, availability math, the reducers, the zod schemas, the `useAsset()/useBooking()/useScanSession()` hooks. The two surfaces are then genuinely *thin* — mostly layout and affordance choices.
- **Surfaces do not share screens.** The scanner's "check out" screen and the console's "check out" panel are different components that call the same `useCheckOut()` hook. Attempting to share the screen component and branch inside it is the mess we're avoiding; duplicating ~200 lines of layout per screen is the price and it's cheap.
- **Surface selection at login**, from role + a user-overridable toggle in Settings. Not from `window.innerWidth`. Deep links carry a surface prefix so a notification opens the right one.
- **Responsiveness within a surface** is normal CSS (container queries, `clamp()`), not JS branching. The scanner adapts phone↔tablet; the console adapts laptop↔desktop.
- Where a component genuinely serves both (a `Money`, a `StatusPill`, an `AssetRow`), it takes `density: 'comfortable' | 'compact'` — a single explicit prop rather than an ambient boolean. `AssetRow` at comfortable density is a 72px touch target; at compact it's a 32px table row.

The one thing I'd watch: this is a bet that the two surfaces stay ~60% distinct. If after Phase 3 they're converging, collapse to one shell with density variants. Revisit at that point rather than deciding now.

### 4.2 Routing, state, data, forms

**Routing.** The sibling hand-rolls a hash router (`src/nav.tsx`, `View` discriminated union). That worked at 11k lines. This app is 4–5× bigger with deep links from QR codes, so use **TanStack Router**: typed routes, typed search params (the console's calendar filters belong in the URL), and route-level data loaders. Keep the sibling's good idea — a `Route` discriminated union derived from the router's types, so navigation stays exhaustively checked. Capacitor App Links map `tag.papavendor.pk/t/:code` → `/scan/resolve/:code`.

**State — three layers, deliberately separate:**
1. **Synced data** → SQLite via PowerSync `watch()` queries, wrapped in `useQuery(sql, params)` hooks in `packages/core`. Reactive: any local write re-renders subscribers in the same frame. **This replaces both the sibling's reducer store and any client cache for domain data.** There is no Redux, no normalized cache, no "fetch then store" — SQL *is* the cache and the query language.
2. **Server-only data** (analytics rollups, full asset history, PDF status) → **TanStack Query** against RPCs. Clearly labelled as online-only in the hook name (`useServerAssetHistory`).
3. **Ephemeral UI state** (current scan session, wizard step, selected rows, modal stack) → **Zustand**, one store per surface, plus plain `useState`. The scan session is Zustand-backed *and* mirrored into a local SQLite table so a crash mid-pull doesn't lose 40 scans — a real risk on a low-end phone.

Note what's absent: no `useReducer`+Context global store like the sibling. That pattern's cost — every unrelated change re-rendering every consumer (the SKILL.md already flags `useMemo([state])` re-render bugs as a live backlog category) — is unacceptable on a 60fps scan loop. Learn from the sibling's scars.

**Forms.** `react-hook-form` + `zod`. The zod schemas live in `packages/core/schemas` and are used in **three** places: client validation, the RPC's argument validation (via a Deno edge function or a generated plpgsql check), and TypeScript type derivation. One schema, three consumers, no drift.

**Data fetching on the scan path: none.** Zero network calls in the scan handler. Ever.

### 4.3 The shared design-token package

`packages/tokens` — framework-agnostic, published to a private registry or consumed via git/file: protocol, and consumed by **both** Papa Rentals and Papa Vendor.

Contents:
```
tokens/
  src/
    tokens.json          # SOURCE OF TRUTH. Single JSON, light + dark values.
    build.ts             # generates all outputs below
  dist/
    tokens.css           # :root { --accent: ... } + :root[data-theme='dark'] { ... }
    tokens.ts            # typed export: Tokens.accent, ColorToken union type
    tokens.d.ts
    tailwind.preset.js   # only if a surface opts into Tailwind (I'd not)
```

What goes in (mirroring `styles.css` lines 1–100 exactly, so both apps are literally the same values):
- Colour: `accent #ff6b2c`, `accent-dark`, `accent-soft`, `ink`, `muted`, `line`, `line-strong`, `bg`, `card`, `card-2`, semantic `green/green-ink/purple/red` + their `-soft` tints, `star`/`star-off`. Plus the dark-theme overrides under `:root[data-theme='dark']`. The `--green-ink` contrast fix in the sibling is a good example of why one source of truth matters — that fix must not have to be discovered twice.
- Radii `--r-sm/md/lg/xl/pill`, shadows `--shadow-xs..lg` (both themes), type scale `--fs-xs..2xl`, spacing `--sp-1..8`, easing `--ease-out`/`--ease-spring`, durations, `--tap: 44px`.
- **The icon set.** The sibling has a hand-rolled 800-line SVG icon set and a test that fails on emoji in the DOM. Move `icons.tsx` into `packages/ui` (not `tokens`, since it's JSX) and ship that emoji test with it. Papa Vendor needs ~40 new icons (barcode, scan, forklift, wrench, clipboard, truck, case) drawn in the same 24px/1.75-stroke grammar.
- Font: Plus Jakarta Sans, self-hosted woff2 files in the package with a documented `@font-face` snippet. The sibling's note that `@font-face` lives in `index.html` for relative-base builds is a real constraint — the package ships the CSS *and* the files, each app wires the paths.

What does **not** go in: components, layout, anything app-specific. Tokens + icons + fonts only. Version it semver'd; a breaking token change is a major.

Additions Papa Vendor needs that should be *added to the shared package*, not forked:
- `--tap-lg: 56px` (gloved hands in a warehouse)
- `--fs-scan: 32px` (asset codes read at arm's length)
- Status colours for the 12 asset states — but expressed as aliases of the existing palette (`--st-out: var(--purple)`) so the two apps can't drift into different oranges.

**Vendor-specific caveat:** the sibling's warm off-white `#fdfbf8` is lovely on a desk and washes out in direct sun on a loading dock. The scanner should default to the existing **dark** theme (`--bg: #161310`), which is already defined. That's not a fork — it's using the theme attribute the sibling already built.

### 4.4 Performance budget and the scan loop

Budget:
| Metric | Target | Hard fail |
|---|---|---|
| Cold start to usable scanner (warm sync) | < 1.5s | 3s |
| Camera ready after tapping Scan | < 400ms | 1s |
| Decode → visible feedback | **< 100ms** | 250ms |
| Consecutive scan throughput | ≥ 2/sec sustained | — |
| Local query (asset by tag) | < 5ms | 20ms |
| Frame budget during list scroll | 16.6ms | 33ms |
| JS bundle, scanner surface | < 250KB gz | 400KB |
| Memory, 30-min pull session | < 180MB | 250MB |

What specifically makes the scan loop feel instant (in order of impact):

1. **Zero network in the handler.** Decode → local SQLite lookup → optimistic insert → render. The whole path is local.
2. **The camera never closes between scans.** Continuous ML Kit scanning with a debounce ring buffer that suppresses the same tag for 2s. Closing/reopening the camera per scan is the single biggest perceived-slowness mistake and costs ~600ms every time.
3. **Feedback is haptic + audio first, visual second.** A ~20ms haptic tick and a short click fire on decode, *before* React re-renders. The sibling already has `buzz()` in `utils.ts` — same idea. Humans register haptics faster than pixels, and the scanner's user is not looking at the screen — they're looking at the gear. Distinct patterns for accepted / duplicate / unexpected-item / error, so the flow is operable by feel alone.
4. **Prepared statements + the tag index.** `SELECT ... FROM asset_tags WHERE tag_code = ?` on an indexed 8k-row table is microseconds. Prepare once at session start.
5. **The session list is virtualized** and renders newest-first with new rows appended at the top, no layout shift, no re-sort.
6. **The reducer runs synchronously in the same tick** as the insert — no `await`, no microtask hop, no `useEffect` chain. Use React 18's `flushSync` for the scan feedback specifically so it can't be batched into a later frame behind low-priority work.
7. **Photos are captured to disk, never held in JS memory.** Capacitor Camera writes a file; the app stores the URI. Base64 in state will OOM a 2GB Android device inside 20 photos.
8. **Everything else is `startTransition`.** Badge counts, availability recalcs, projections beyond the scanned asset — all deprioritized behind the scan feedback.

Measure with a `scan_latency_ms` field written into every event's payload, so the budget is enforced by real field data, not a dev-machine benchmark.

---

## 5. Repo and module structure

```
papa-vendor/
├─ apps/
│  ├─ scanner/               # thumb-first warehouse app; Capacitor Android target
│  │  ├─ src/routes/         # scan, pull, return, asset, session, settings
│  │  ├─ src/shell/          # bottom nav, big-target layout, offline strip
│  │  ├─ android/            # Capacitor native project (ML Kit, background sync)
│  │  └─ capacitor.config.ts
│  └─ console/               # dense rental-desk web app (PWA)
│     ├─ src/routes/         # calendar, bookings, quotes, invoices, inventory, reports
│     └─ src/shell/          # sidebar, command palette, multi-pane layout
├─ packages/
│  ├─ core/                  # ALL domain logic. No JSX. Shared by both apps.
│  │  ├─ db/                 # local SQLite schema, migrations, prepared queries
│  │  ├─ sync/               # PowerSync client, outbox, upload queue, backoff, clock
│  │  ├─ domain/             # pricing, availability, kit reconciliation, scan reducer
│  │  ├─ schemas/            # zod schemas — client validation + RPC contracts + types
│  │  ├─ hooks/              # useAsset, useBooking, useScanSession, useAvailability
│  │  └─ rpc/                # typed wrappers over every server function
│  ├─ ui/                    # shared components: primitives, icons, StatusPill, AssetRow
│  ├─ tokens/                # design tokens — SHARED WITH PAPA RENTALS
│  └─ testkit/               # fixtures, factories, an in-memory sync harness
├─ supabase/
│  ├─ migrations/            # numbered SQL migrations, applied by CI
│  ├─ functions/             # Deno edge functions: pdf, sms, whatsapp, exports
│  ├─ seed/                  # demo org + realistic Lahore inventory for dev
│  └─ tests/                 # pgTAP: RLS policies, exclusion constraints, reducers
├─ tools/
│  ├─ label-gen/             # QR label sheet PDF generator (Avery/Zebra layouts)
│  └─ import/                # CSV/Excel inventory importer (onboarding is 80% this)
├─ e2e/                      # Playwright: console flows + a scripted offline-sync suite
├─ .planning/                # specs, decision records, backlog (sibling's convention)
└─ .claude/skills/papa-vendor/SKILL.md   # conventions, traps, verify, deploy
```

One line each:
- `apps/scanner` — the warehouse floor surface and its native shell.
- `apps/console` — the rental desk surface.
- `packages/core/db` — local SQLite schema and every query the app runs against it.
- `packages/core/sync` — offline correctness: outbox, ordering, retry, clock, conflicts.
- `packages/core/domain` — pure business functions, exhaustively unit tested.
- `packages/core/schemas` — the one place a shape is defined.
- `packages/ui` — components and icons shared across surfaces.
- `packages/tokens` — the design contract with Papa Rentals.
- `supabase/migrations` — the authoritative schema; nothing changes prod except a migration.
- `supabase/tests` — proves RLS and the exclusion constraint actually hold.
- `tools/import` — the thing that decides whether a customer ever finishes onboarding.
- `e2e` — including a suite that runs the app with the network forcibly severed.

pnpm workspaces + Turborepo. Biome over ESLint+Prettier (one tool, fast). Vitest for units, Playwright for e2e.

---

## 6. Phasing

**Dependency spine:** tenancy/auth → asset model + tags → local DB + sync → scan loop → bookings/availability → prep/return reconciliation → money → analytics.

**Phase 0 — Foundations (2–3 wks).** Monorepo, `packages/tokens` extracted and consumed by *both* repos (do this first; retrofitting is worse), Supabase project, orgs/users/memberships + RLS, auth with phone OTP, CI with pgTAP. *Nothing user-visible.* Resist the urge to skip the RLS test harness here — it is much harder to add after 40 tables exist.

**Phase 1 — MVP: "Where is my gear?" (4–6 wks).** ← **This is the smallest genuinely useful thing.**
Products, serialized assets, locations, `asset_tags`, label printing (`tools/label-gen`), CSV import, `scan_events` with the check-out/check-in/move types, the projection reducer, local SQLite + PowerSync read sync + outbox, the scanner surface with a working continuous-scan loop, and a minimal console: asset list, asset detail with history, a "what's out right now" board.

Why this is the right cut: a Lahore rental house today tracks inventory in a paper register or a WhatsApp group. Just "scan out / scan in / see what's out and who has it", offline, on a phone, is *already* worth paying for. It requires no bookings, no invoicing, no pricing. It's also the highest-risk technical surface (offline sync), so building it first means the scariest thing is de-risked while the scope is small enough to rewrite if the sync approach proves wrong. **Ship this to one friendly rental house and watch them use it for three weeks before building Phase 2.**

**Phase 2 — Bookings and availability (4–5 wks).** Customers, productions, bookings + lines, `asset_reservations` with the exclusion constraint, holds and expiry, the console calendar, allocation of products→assets, and the quote→hold→confirm flow with the online-only boundary. This is where the desk starts living in the app.

**Phase 3 — Prep, return, and the money-saving bit (3–4 wks).** Kit templates and containment, pull lists on the scanner, check-in reconciliation and `discrepancies`, condition reports with photos and the offline photo queue, damage claims with out/in photo comparison. This phase is where the product starts *earning* rather than *recording* — missing-item detection pays for the subscription.

**Phase 4 — Commercial (4–5 wks).** Rate cards, tiers, the 3-day week, kit pricing, quotes as PDFs, invoices with gapless numbering, deposits and payments, customer statements. Deliberately after Phase 3, because rental houses will tolerate invoicing in Excel far longer than they'll tolerate losing gear.

**Phase 5 — Operations depth (3–4 wks).** Maintenance orders and asset health, sub-rentals in/out, staff roles and permission refinement, driver/delivery flow, notification rules (WhatsApp is the channel that matters in Pakistan).

**Phase 6 — Analytics and network effects (ongoing).** Utilization by asset and category, revenue per asset, ROI on purchases, dead-stock reports, and the integration with Papa Rentals — pushing available inventory to the marketplace and pulling marketplace bookings in as Papa Vendor bookings. That integration is the strategic prize but it depends on everything above being real.

---

## 7. Top 10 risks, ranked

**1. Adoption: warehouse staff don't scan.** *The single most likely cause of failure, and it is not technical.* If it's faster to shout "took the FX9" than to scan, people shout. Untagged gear leaves, inventory silently rots, trust dies in three weeks, and the rental house blames the app.
*Mitigation:* obsess over the scan loop's speed (§4.4 exists for this reason); make one-handed operation real; haptic/audio feedback so the phone can stay half-looked-at; batch-scan a full case in one continuous session rather than item-by-item confirmations; a "missed scans" report to the manager so it's *visible* when it's not happening; and give the manager a daily WhatsApp digest so the app produces value they can see even on day 1. Pilot with one house, sit in their warehouse at 6am, and watch. Do not design this from a desk.

**2. Sync rules and RLS policies drift apart, leaking one org's data to another's device.** Two authorization surfaces, one of which (sync rules) is not enforced by Postgres. A single wrong bucket parameter and a competitor's inventory lands on a phone.
*Mitigation:* generate both from a single `org_id` predicate; a CI test that, for every synced table, opens a session as org A and asserts the sync payload contains zero org-B rows; a nightly canary with two seeded orgs; and treat any table added without a matching RLS+sync-rule pair as a build failure.

**3. Double-booking still happens, via a path that bypasses the exclusion constraint.** The constraint only covers `confirmed`/`out`. Overrides, admin edits, late-return extensions, and sub-rental substitutions all deliberately bypass it.
*Mitigation:* exactly one code path may write reservations (`SECURITY DEFINER` RPC); revoke direct INSERT/UPDATE on the table from all roles; every bypass writes an `overbook_alert` and is visible on a dashboard; pgTAP tests that attempt each bypass and assert an alert exists.

**4. Data migration/onboarding fails and the customer never starts.** A rental house has 3,000 items in a battered Excel file with inconsistent names, no serials, and kits described in a Notes column. If import is painful they abandon at week one.
*Mitigation:* `tools/import` is a real product, not a script — column mapping UI, fuzzy product deduplication, a dry-run preview, partial import with a fix-later queue. Budget two full weeks for it in Phase 1, and offer a done-for-you import for the first ten customers. Pair it with a printed label sheet workflow so tagging 3,000 items is a structured afternoon, not an open-ended chore.

**5. Offline correctness bugs that only appear in the field.** The truck-at-6am scenario is unreproducible at a desk, and the bug class (ordering, partial batches, replay) produces *wrong data*, not crashes — so it's discovered weeks later as inventory that doesn't match reality.
*Mitigation:* a deterministic sync simulator in `packages/testkit` that runs N virtual devices with scripted partitions, clock skew, and interleavings, asserting projection convergence — run every commit; every event carries enough provenance to reconstruct what happened; a `rebuild_asset_projection` escape hatch; and property-based tests over event permutations.

**6. Shared warehouse devices break the audit trail.** Three staff share one scarred Android. If they don't switch users, every event is attributed to whoever logged in on Tuesday — and the audit trail's entire value is attribution.
*Mitigation:* design for it rather than against it — a device-level org login plus a fast per-user PIN or NFC-badge "who are you" gate that takes 2 seconds and re-arms after 15 minutes idle; show the current user's name persistently and largely on the scan screen; flag sessions with implausible attribution.

**7. PowerSync becomes a cost or availability problem.** A third-party in the hot path of a business's daily operations.
*Mitigation:* the write path never depends on it (RPC-only), so only the read path is coupled; self-host is a documented, rehearsed option; and a "degraded mode" where the app falls back to direct RPC reads when sync is down — slower but functional. Rehearse the self-host migration once in Phase 3, not during an outage.

**8. Postgres RLS + exclusion-constraint performance at scale.** Every query carries an RLS predicate; GiST range queries over a busy calendar can degrade; the desk's month view touches thousands of reservations.
*Mitigation:* `org_id` first in every index; `SELECT` policies written to be index-sargable (avoid function calls on the left side); a materialized daily availability rollup refreshed incrementally for calendar views; load-test with a synthetic 50-org, 50k-asset dataset before the tenth customer, not after.

**9. Two implementations of pricing (TypeScript and plpgsql) diverge, and a quote doesn't match its invoice.** A customer-facing trust failure and a support nightmare.
*Mitigation:* a fuzz test in CI asserting the two agree over 10k random inputs; and if that becomes a maintenance drag, collapse to SQL-only with the client calling an RPC (acceptable — quoting is always online). Decide by end of Phase 4; don't let both live for a year.

**10. Scope creep drowns the scan loop.** A rental house will ask for CRM, HR, fuel logs, and a driver app. Each is reasonable; together they turn a sharp tool into ERP-lite that does nothing well, and the scan loop stops getting the attention that makes it feel instant.
*Mitigation:* a written product principle — "if it isn't the scan loop or something that directly feeds it, it waits for a phase"; a public roadmap so saying no is saying "later"; and a periodic re-measurement of the §4.4 budget as the regression gate that proves the core hasn't rotted.

*Honourable mention (would be #11):* **the sibling app's design language may not survive contact with a warehouse.** The warm off-white, generous whitespace, and 44px targets are a consumer-marketplace aesthetic. A dense console showing 60 bookings and a sunlit loading dock both push against it. Mitigation is already in the design — the dark theme exists, `--tap-lg` and a `density` prop are additive — but expect real tension and resolve it by testing in the actual warehouse, not by argument.

---

## 8. Open uncertainties, and what would resolve each

1. **Are the two surfaces really 60% distinct?** If they converge, `apps/scanner` + `apps/console` is over-structure. *Resolves at:* end of Phase 2 — count the shared vs. duplicated screen code and decide then.
2. **Does PowerSync's sync-rule language express the role-scoped time windows in §3.1 cleanly?** If it needs contortions, the working-set design changes. *Resolves at:* a two-day spike in Phase 0, before any schema is committed.
3. **Real clock-skew distribution on cheap Android in Lahore.** The 5-minute back-correction threshold is a guess. *Resolves at:* telemetry from the first 20 devices.
4. **Whether check-in reconciliation should block or advise.** I've designed it as advisory (alerts, never errors). A rental house might want it to block. *Resolves at:* watching a real return session in Phase 3.
5. **Whether OTP-per-user is workable on shared warehouse devices**, or whether the PIN model must be primary from day one. *Resolves at:* the Phase 1 pilot.

---

### Critical Files for Implementation
- /home/shaharyar/Scrrenplay-papa/papa-rentals/src/styles.css — the token source to extract into `packages/tokens`; lines 1–100 are copied verbatim.
- /home/shaharyar/Scrrenplay-papa/papa-rentals/src/components/icons.tsx — the 800-line in-house SVG icon set to move into `packages/ui`, along with the no-emoji test.
- /home/shaharyar/Scrrenplay-papa/papa-rentals/src/components/primitives.tsx — the `Button`/`Chip`/`IconButton`/`SectionHeader` API that `packages/ui` should preserve and extend with a `density` prop.
- /home/shaharyar/Scrrenplay-papa/papa-rentals/src/types.ts — the shape vocabulary (`Item`, `Kit`, `Booking`, `OrderStatus`) Papa Vendor's schema must map onto for the eventual marketplace integration.
- /home/shaharyar/Scrrenplay-papa/papa-rentals/.claude/skills/papa-rentals/SKILL.md — the conventions, WebView constraints, and verify-against-the-built-bundle discipline that the new repo's own SKILL.md should inherit.
- /home/shaharyar/Scrrenplay-papa/papa-rentals/src/store.tsx — read as a cautionary case: the global `useReducer`+Context store and its `useMemo([state])` re-render problem are exactly what `packages/core`'s three-layer state split is designed to avoid.