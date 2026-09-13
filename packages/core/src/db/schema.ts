/**
 * The on-device schema.
 *
 * STRICT SERVER, LAX CLIENT. There are almost no constraints here, and that is
 * a design decision rather than an oversight: the device accepts anything
 * optimistically and fast, and the server is where truth is enforced. A
 * constraint violation on a phone at 06:14 would reject a scan of something
 * physically in the tech's hands, which is both wrong and unrecoverable —
 * the gear leaves anyway and the record does not.
 *
 * Two kinds of table live here:
 *   - MIRRORS of server tables, replaced wholesale by sync. Never authored
 *     locally except as optimistic projections.
 *   - DEVICE-ONLY tables (outbox, sync_meta) that exist nowhere else and are
 *     the one thing a wipe would destroy irrecoverably.
 */
export const LOCAL_SCHEMA = /* sql */ `
-- ---------------------------------------------------------------------------
-- Mirrors. Sync overwrites these; nothing here is authoritative.
-- ---------------------------------------------------------------------------
create table if not exists assets (
  id                  text primary key,
  org_id              text not null,
  product_id          text,
  asset_code          text,
  serial_number       text,
  display_name        text,
  is_container        integer default 0,
  -- Whether the unit may be promised at all (0022 create/confirm_booking
  -- refuse a non-rentable unit). Mirrored so the phone's availability
  -- answer counts the same fleet the server does. Same create-if-not-
  -- exists caveat as disposition below.
  rentable            integer default 1,
  presence            text default 'here',
  health              text default 'ok',
  ownership           text default 'owned',
  -- Why it left the fleet: null | lost | stolen | sold | retired (0020). A
  -- projection like presence/health/ownership, driven by mark_* / retire /
  -- found scan events. Added under the same caveat as current_job_id and the
  -- other 0018 columns: no installed phone exists yet (pre-auth, demo only),
  -- so create-if-not-exists still covers every real database — but a local
  -- migration path stays a pre-ship requirement before ANY device persists.
  disposition         text,
  -- The two usage meters (0021): rental days worked since the last
  -- serviced event, and check_out cycles on flagged products. Projections
  -- like presence — the device moves its optimistic copy from its own
  -- queue (project.ts) and the server's authoritative count overwrites it
  -- on sync. Same create-if-not-exists caveat as disposition above.
  rental_days_since_service integer default 0,
  cycle_count         integer default 0,
  current_location_id text,
  current_parent_id   text,
  current_job_id      text,
  last_scanned_at     text,
  notes               text,
  updated_at          text
);
-- ---------------------------------------------------------------------------
-- SPECULATIVE INDEXES. No query in the codebase filters on asset_code,
-- presence, current_job_id or asset_tags.asset_id today, so these are pure
-- write cost on first sync — four extra b-tree writes per row across ~4000
-- rows. A performance review flagged them for removal.
--
-- KEPT DELIBERATELY, because the asymmetry runs the other way. This schema is
-- applied with create-if-not-exists and THERE IS NO DEVICE-SIDE MIGRATION
-- MECHANISM: an installed phone never receives a schema change. So dropping an
-- index costs nothing to new installs and is unrecoverable on existing ones,
-- while keeping it costs a few milliseconds once. asset_code in particular is
-- certain to be needed — manual search by code is phase 1, and its absence is
-- what the research names as the single biggest abandonment trigger.
--
-- Revisit when a device migration path exists. That gap is the real finding
-- here, and it is bigger than the indexes.
-- ---------------------------------------------------------------------------
create index if not exists assets_code_idx     on assets (asset_code);
create index if not exists assets_presence_idx on assets (presence);
create index if not exists assets_job_idx      on assets (current_job_id);

-- The tag map is the hot path: decode -> asset in a single indexed lookup with
-- no network. ~50 bytes a row, so 20,000 assets is about 1MB and the whole
-- fleet fits on the device. That is what makes a scan feel instant.
create table if not exists asset_tags (
  tag_code text primary key,
  asset_id text,
  status   text
);
create index if not exists asset_tags_asset_idx on asset_tags (asset_id);

/*
 * What is inside what.
 *
 * permanent - welded to its parent. An FX9 handle genuinely cannot leave
 *             without the body, so scanning the body may record it too.
 * packed    - currently living in this case, expected back in it.
 * subrented - living in this case but belonging to someone else. Same manifest
 *             rule as packed, kept distinct because a dispute over it is a
 *             dispute with a supplier, not a client.
 *
 * THAT DISTINCTION IS NOT COSMETIC. A case scan may emit implied events for
 * permanent children ONLY. For packed children it must open a MANIFEST of
 * unconfirmed rows, because "packed" means "we believe this is in there", and
 * turning that belief into a recorded fact with a timestamp and an actor
 * fabricates evidence against a client who is right: a plate pulled on Tuesday
 * and never scanned back would be recorded as checked out to today's job, by
 * name, with a time.
 */
create table if not exists asset_containment (
  parent_asset_id text not null,
  child_asset_id  text not null,
  kind            text not null,
  -- The server-side tombstone, mirrored. A row with removed_at set is
  -- HISTORY, not contents: it must never appear on a manifest, or the tech is
  -- invited to confirm — as 'assumed', with their name on it — gear that was
  -- pulled out weeks ago. Added while no installed phone exists; this schema
  -- is create-if-not-exists (see the index comment above), so the NEXT column
  -- needs a real migration path first.
  removed_at      text,
  primary key (parent_asset_id, child_asset_id)
);
create index if not exists containment_child_idx on asset_containment (child_asset_id);

create table if not exists locations (
  id text primary key, org_id text, name text, kind text, path text, code text
);

-- customer_id and closed_at mirror the 0018 server columns (the customer
-- chip; boards that stop accumulating finished jobs). Added under the same
-- caveat as asset_containment.removed_at above: no installed phone exists
-- yet (pre-auth, demo only), so create-if-not-exists still covers every
-- real database — but a local migration path remains a pre-ship
-- requirement before ANY device persists this schema.
-- booking_id mirrors the 0022 D8 bridge, projected as of 0023: the one
-- live job a confirmed booking became, so the phone can refuse a second
-- conversion and a cancel while the job is open — the server's own rules.
-- attendant_names (0025 D8): the crew line as JSON text — display names in
-- assignment order, '[]' when nobody is on it. Rides the jobs projection
-- because job_attendants itself never syncs.
create table if not exists jobs (
  id text primary key, org_id text, label text, contact text,
  expected_back text, status text, customer_id text, closed_at text,
  booking_id text, attendant_names text
);

-- service_due_after_rental_days / count_cycles / retire_after_cycles mirror
-- the 0021 server columns: the service threshold (null = no nudge), the
-- battery flag, and the cycle ceiling — what lets the phone draw the
-- service line and the Sehat groups with no network.
-- tracking_mode (serialized | bulk | consumable) arrives with 0023: the
-- booking rules branch on it (units are allocated, bulk is counted), so
-- the phone must know which kind of product a line names.
create table if not exists products (
  id text primary key, org_id text, display_name text, category text,
  tracking_mode text default 'serialized',
  service_due_after_rental_days integer,
  count_cycles integer default 0,
  retire_after_cycles integer
);

/*
 * The promise calendar's mirrors (0022, projected by 0023).
 *
 * Periods arrive SPLIT — the server's tstzrange is projected as its two
 * bounds, ISO text like every other mirrored timestamp — because SQLite has
 * no range type and the rules (packages/core/src/bookings.ts) want epoch
 * ms, which Date.parse gives from ISO in one step. Both ranges are '[)'.
 *
 * customer_name rides the bookings projection (the customers table never
 * syncs — 0009/0015 keep phone and CNIC off the scanner), so a booking on
 * the phone can name who it is for without the phone holding the khata.
 *
 * The three reservation mirrors are OPTIMISTICALLY authored too: the
 * demo's write side (apps/app/src/demo/bookings.ts) inserts here while it
 * enqueues the matching RPC op, so an offline desk sees the same calendar
 * the server will confirm. A server tombstone (deleted_at) deletes the row
 * — that is how an expired pencil's claims vanish from every phone.
 *
 * stock_lots is the bulk shelf count the availability answer subtracts
 * confirmed claims from (0022 D6); slim projection, no costs.
 */
create table if not exists bookings (
  id                text primary key,
  org_id            text not null,
  booking_no        integer not null,
  customer_id       text not null,
  customer_name     text,
  status            text not null default 'draft',
  customer_from     text not null,
  customer_until    text not null,
  blocked_from      text not null,
  blocked_until     text not null,
  pencil_expires_at text,
  note              text,
  cancel_reason     text,
  updated_at        text
);
create index if not exists bookings_status_idx on bookings (status);
create index if not exists bookings_customer_idx on bookings (customer_id);

-- rate_minor / original_rate_minor / override_reason arrive with 0026
-- (the 0024 D8 override columns): the owner's last word on a line's day
-- rate, the card rate it replaced, and why. Null rate_minor = price from
-- the card. Same create-if-not-exists caveat as every column since 0018.
create table if not exists booking_lines (
  id                  text primary key,
  org_id              text not null,
  booking_id          text not null,
  product_id          text,
  asset_id            text,
  qty                 integer not null default 1,
  rate_minor          integer,
  original_rate_minor integer,
  override_reason     text
);
create index if not exists booking_lines_booking_idx on booking_lines (booking_id);

create table if not exists asset_reservations (
  id               text primary key,
  org_id           text not null,
  booking_id       text not null,
  booking_line_id  text not null,
  asset_id         text not null,
  blocked_from     text not null,
  blocked_until    text not null,
  state            text not null
);
create index if not exists asset_reservations_asset_idx on asset_reservations (asset_id);
create index if not exists asset_reservations_booking_idx on asset_reservations (booking_id);

create table if not exists stock_reservations (
  id               text primary key,
  org_id           text not null,
  booking_id       text not null,
  booking_line_id  text not null,
  product_id       text not null,
  qty              integer not null,
  blocked_from     text not null,
  blocked_until    text not null,
  state            text not null
);
create index if not exists stock_reservations_product_idx on stock_reservations (product_id);
create index if not exists stock_reservations_booking_idx on stock_reservations (booking_id);

create table if not exists stock_lots (
  id           text primary key,
  org_id       text not null,
  product_id   text not null,
  location_id  text,
  qty_on_hand  integer not null default 0
);
create index if not exists stock_lots_product_idx on stock_lots (product_id);

/*
 * The rate card and the org calendar (0024, projected by 0026) — what the
 * phone's quote pipeline (packages/core/src/pricing.ts) reads so a pasted
 * kit list can be priced offline with the server's own numbers.
 *
 * weekend_mask is the server's integer[] carried as JSON text ('[6,7]');
 * numerics (week_equals_days, rate_multiplier) are stored as REAL. The
 * server role-gates rate_cards and rate_card_entries to owner/manager/
 * desk in RLS, so a warehouse phone's pull simply carries none — the
 * price list never reaches the floor; the calendar reaches everyone
 * (season shading is useful on every screen).
 *
 * Optimistically authored like the reservation mirrors: setRate /
 * setCalendarDay (apps/app/src/demo/quotes.ts) write here while they
 * queue the 0024 RPC op, so the desk's next quote reads the number it
 * just typed.
 */
create table if not exists rate_cards (
  id                 text primary key,
  org_id             text not null,
  name               text not null,
  is_default         integer not null default 0,
  week_equals_days   real not null default 3,
  min_billable_days  integer not null default 1,
  weekend_mask       text not null default '[]',
  updated_at         text
);

create table if not exists rate_card_entries (
  id              text primary key,
  org_id          text not null,
  rate_card_id    text not null,
  product_id      text not null,
  day_rate_minor  integer not null
);
create index if not exists rate_card_entries_card_idx on rate_card_entries (rate_card_id, product_id);

create table if not exists org_calendar_days (
  id               text primary key,
  org_id           text not null,
  day              text not null,
  kind             text not null,
  name             text not null,
  rate_multiplier  real not null default 1
);
create index if not exists org_calendar_days_day_idx on org_calendar_days (day);

-- ---------------------------------------------------------------------------
-- --- network --- (0025). Desk-side tables that NEVER sync: partner_houses
-- carries a phone (PII — 0025 D1 gives it no change_seq), sub_hires is
-- papa_app SELECT for desk roles only (D2), job_attendants rides the jobs
-- projection as attendant_names (D8). In this wave the demo store owns them
-- locally and writes them beside the outbox op the server will replay;
-- on the real pipe the desk role reads them through RPC-backed reads.
-- Same create-if-not-exists caveat as every column above.
-- ---------------------------------------------------------------------------
create table if not exists partner_houses (
  id                  text primary key,
  org_id              text not null,
  name                text not null,
  phone               text,
  whatsapp_group_note text,
  city                text not null default 'Lahore',
  notes               text,
  created_at          text,
  updated_at          text,
  deleted_at          text
);
create index if not exists partner_houses_live_idx on partner_houses (deleted_at, name);

-- period arrives split like the bookings' ranges ('[)', ISO text).
-- Amounts nullable ON PURPOSE (0025 D6): unpriced is counted, never zeroed.
create table if not exists sub_hires (
  id                  text primary key,
  org_id              text not null,
  direction           text not null,          -- 'in' | 'out'
  partner_house_id    text not null,
  booking_id          text,
  job_id              text,
  product_id          text not null,
  qty                 integer not null default 1,
  asset_id            text,
  period_from         text not null,
  period_until        text not null,
  agreed_cost_minor   integer,
  agreed_charge_minor integer,
  expense_id          text,
  ledger_entry_id     text,
  returned_at         text,
  note                text,
  created_at          text not null
);
create index if not exists sub_hires_partner_idx on sub_hires (partner_house_id, returned_at);
create index if not exists sub_hires_job_idx on sub_hires (job_id);
create index if not exists sub_hires_asset_idx on sub_hires (asset_id);

create table if not exists job_attendants (
  id         text primary key,
  org_id     text not null,
  job_id     text not null,
  user_id    text not null,
  role       text not null default 'attendant',   -- 'attendant' | 'driver'
  created_at text not null
);
create unique index if not exists job_attendants_job_user_idx on job_attendants (job_id, user_id);

-- ---------------------------------------------------------------------------
-- Device-only. NOT mirrored, NOT recoverable from the server.
-- ---------------------------------------------------------------------------

/*
 * The outbox.
 *
 * Every local write lands here first and is retired only when the server
 * confirms it. Rows in this table are the ONLY data on the device that does
 * not exist anywhere else — an uninstall destroys them and nobody, including
 * the server, ever learns they existed. That is an accepted, documented limit
 * rather than a solved problem; the mitigations are flushing on any
 * connectivity and an actionable "this phone last synced 6h ago" alert with a
 * name attached, because a person is the only real control here.
 */
create table if not exists outbox (
  id          text primary key,
  seq         integer not null,        -- monotonic per device, NEVER resets
  op          text not null,           -- the RPC to call
  payload     text not null,           -- JSON args
  depends_on  text,                    -- outbox.id that must land first
  state       text not null default 'pending',
  attempts    integer not null default 0,
  next_retry_at integer,
  error_code  text,
  error_detail text,
  created_at  integer not null
);
create index if not exists outbox_state_seq_idx on outbox (state, seq);
create index if not exists outbox_depends_idx   on outbox (depends_on);

/*
 * Photos, queued separately.
 *
 * Binaries are too large for the JSON outbox — base64 in the queue would OOM
 * a 2GB Android inside twenty photos. The file stays on disk and only its
 * metadata is queued.
 *
 * wifi_only defaults to 0, against the architecture's 1. Defaulting to
 * wifi-only optimises for a data cost that does not exist in this market and
 * pays for it in destroyed evidence: photos pile up, the cache fills, and the
 * out-side half of a damage dispute is gone.
 */
create table if not exists pending_uploads (
  id          text primary key,
  local_uri   text not null,
  target_path text not null,
  sha256      text,
  bytes       integer,
  state       text not null default 'pending',
  attempts    integer not null default 0,
  wifi_only   integer not null default 0,
  created_at  integer not null
);

/*
 * Condition photos — the evidence.
 *
 * The row is written the moment the shutter fires and is NEVER deleted by the
 * app. Bytes are queued separately in pending_uploads, because base64 in the
 * JSON outbox would OOM a 2GB Android inside twenty photos.
 *
 * side is what makes the pair: the same asset photographed on the way out and
 * on the way back is the entire commercial argument of this product, and it
 * only works if the two halves can find each other without a server.
 *
 * captured_at is the DEVICE's clock and is labelled as such wherever it is
 * shown. The server stamps its own received_at on arrival; until then there is
 * exactly one timestamp here and it is the untrusted one.
 */
create table if not exists condition_photos (
  id          text primary key,
  asset_id    text not null,
  job_id      text,
  session_id  text,
  side        text not null,          -- 'out' | 'in'
  captured_at integer not null,       -- device clock, epoch ms
  sha256      text,
  bytes       integer not null default 0,
  local_uri   text not null,
  note        text,
  uploaded    integer not null default 0
);
create index if not exists condition_photos_asset_idx on condition_photos (asset_id, side);
create index if not exists condition_photos_session_idx on condition_photos (session_id);

/*
 * Voice notes — the awaaz note (0021; vendor-dream-plan Phase D5).
 *
 * Bykea's lesson: typing is the barrier. A scratch explained in ten spoken
 * seconds beats a note field nobody fills in. The storage model is the
 * condition-photos model, deliberately and exactly: the row is written when
 * the recording stops and is NEVER deleted by the app; the bytes ride
 * local_uri (a data URI in the browser, a file path on Android) and are
 * queued separately in pending_uploads; captured_at is the DEVICE's clock
 * and is labelled as such wherever shown. Until an upload succeeds this row
 * is the only copy of somebody's spoken explanation — which is why
 * VoiceNoteStore refuses new recordings when full instead of evicting old
 * ones (see voice-notes.ts).
 */
create table if not exists voice_notes (
  id          text primary key,
  asset_id    text,
  job_id      text,
  session_id  text,
  duration_ms integer not null default 0,
  captured_at integer not null,       -- device clock, epoch ms
  bytes       integer not null default 0,
  mime        text,
  local_uri   text not null,
  uploaded    integer not null default 0
);
create index if not exists voice_notes_asset_idx on voice_notes (asset_id);
create index if not exists voice_notes_session_idx on voice_notes (session_id);

create table if not exists sync_meta (
  key   text primary key,
  value text
);

/*
 * The id map — the pipe's memory of which name the server gave a thing the
 * phone named first (W9).
 *
 * The server mints its own ids for bookings, jobs, partner houses, borrowed
 * units, expenses… The phone cannot wait for them (a pencil is placed
 * offline), so it mints a client id, writes the mirror optimistically, and
 * queues the op with that id riding beside the RPC args as client_*. When
 * the server accepts, its reply names the real id; this table records the
 * pair, every later op that still names the client id is rewritten before it
 * is sent, and the local rows are re-keyed to the server's name in the same
 * transaction as the ack (docs/the-pipe.md, "Id mapping").
 *
 * Device-only: it exists nowhere else, and a wipe would leave every queued
 * op naming ids the server has never heard of.
 */
create table if not exists id_map (
  client_id  text primary key,
  server_id  text not null,
  kind       text not null,
  mapped_at  integer not null
);
create index if not exists id_map_server_idx on id_map (server_id);

/*
 * The members mirror (0027, W9) — who can pick up this phone. Slim on
 * purpose: id (the user id switch_session_user takes), display name, role,
 * and whether a PIN is set. Names and roles are not PII (the 0023 D1
 * reasoning; phones and CNICs never leave the server). Read by the PIN
 * gate and Settings → This phone.
 */
create table if not exists members (
  id           text primary key,
  org_id       text not null,
  display_name text not null,
  role         text not null,
  has_pin      integer not null default 0
);

/*
 * The org mirror (0028, W11) — one row: the house's own name, currency and
 * timezone. The parchi letterhead and every money document say the HOUSE's
 * name, never the enrolled person's; until this row arrives the letterhead
 * is blank rather than wrong.
 */
create table if not exists org (
  id       text primary key,
  name     text not null,
  currency text,
  timezone text
);
`

/** Device-only tables, i.e. what a wipe would destroy irrecoverably. */
export const DEVICE_ONLY_TABLES = [
  'outbox',
  'pending_uploads',
  // Photos belong here, not with the mirrors: the row and its bytes exist
  // ONLY on the device until an upload succeeds. A wipe destroys the one copy
  // of the evidence, which is why nothing in the app ever deletes one.
  'condition_photos',
  // Voice notes share the photos' reasoning exactly (0021): the recording
  // exists nowhere else until it uploads, so nothing in the app deletes one.
  'voice_notes',
  'sync_meta',
  // The pipe's memory of the server's names for locally-minted ids (W9).
  // Lose it and every queued op names ids the server never issued.
  'id_map',
] as const

/** Tables sync replaces wholesale. Safe to drop and re-seed at any time. */
export const MIRROR_TABLES = [
  'assets', 'asset_tags', 'asset_containment', 'locations', 'jobs', 'products',
  'bookings', 'booking_lines', 'asset_reservations', 'stock_reservations',
  'stock_lots', 'rate_cards', 'rate_card_entries', 'org_calendar_days',
  'members', 'org',
] as const
