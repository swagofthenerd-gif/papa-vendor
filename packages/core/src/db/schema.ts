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
  presence            text default 'here',
  health              text default 'ok',
  ownership           text default 'owned',
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

create table if not exists jobs (
  id text primary key, org_id text, label text, contact text,
  expected_back text, status text
);

create table if not exists products (
  id text primary key, org_id text, display_name text, category text
);

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

create table if not exists sync_meta (
  key   text primary key,
  value text
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
  'sync_meta',
] as const

/** Tables sync replaces wholesale. Safe to drop and re-seed at any time. */
export const MIRROR_TABLES = [
  'assets', 'asset_tags', 'asset_containment', 'locations', 'jobs', 'products',
] as const
