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
  updated_at          text
);
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

create table if not exists sync_meta (
  key   text primary key,
  value text
);
`

/** Device-only tables, i.e. what a wipe would destroy irrecoverably. */
export const DEVICE_ONLY_TABLES = ['outbox', 'pending_uploads', 'sync_meta'] as const

/** Tables sync replaces wholesale. Safe to drop and re-seed at any time. */
export const MIRROR_TABLES = ['assets', 'asset_tags', 'locations', 'jobs', 'products'] as const
