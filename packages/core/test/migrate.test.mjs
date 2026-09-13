/**
 * The on-device schema migration, against a real SQLite.
 *
 * The one property that matters: an installed phone holding the OLDEST
 * schema any device could have (the pre-0018 shape, kept here as a fixture
 * string) is brought to the current schema without losing a queued write.
 * The steps in migrate.ts and the create-if-not-exists schema in schema.ts
 * are two descriptions of the same tables, so the second property is that
 * they agree: every table's column set after migrating equals a fresh
 * install's. Drift between history and present fails here, not on a phone.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import {
  LOCAL_MIGRATIONS, LOCAL_SCHEMA_VERSION, localSchemaVersion, migrateLocal,
} from '../src/db/migrate.ts'
import { metaGet } from '../src/meta.ts'

/**
 * The schema as a phone would have held it before 0018 — no customer on a
 * job, no disposition or meters on an asset, no bookings, no rates, no
 * network, no voice notes, no id map, no members. Pinned as text so a
 * change to LOCAL_SCHEMA cannot quietly move the starting line.
 */
const SCHEMA_V1 = `
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
create index if not exists assets_code_idx     on assets (asset_code);
create index if not exists assets_presence_idx on assets (presence);
create index if not exists assets_job_idx      on assets (current_job_id);
create table if not exists asset_tags (
  tag_code text primary key,
  asset_id text,
  status   text
);
create index if not exists asset_tags_asset_idx on asset_tags (asset_id);
create table if not exists asset_containment (
  parent_asset_id text not null,
  child_asset_id  text not null,
  kind            text not null,
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
create table if not exists outbox (
  id          text primary key,
  seq         integer not null,
  op          text not null,
  payload     text not null,
  depends_on  text,
  state       text not null default 'pending',
  attempts    integer not null default 0,
  next_retry_at integer,
  error_code  text,
  error_detail text,
  created_at  integer not null
);
create index if not exists outbox_state_seq_idx on outbox (state, seq);
create index if not exists outbox_depends_idx   on outbox (depends_on);
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
create table if not exists condition_photos (
  id          text primary key,
  asset_id    text not null,
  job_id      text,
  session_id  text,
  side        text not null,
  captured_at integer not null,
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

/** table → sorted column names, for every user table in the database. */
function shape(db) {
  const out = {}
  const tables = db
    .all(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`)
    .map((r) => r.name)
  for (const t of tables) {
    out[t] = db.all(`pragma table_info(${t})`).map((c) => c.name).sort()
  }
  return out
}

function openV1() {
  const db = new NodeSqliteDriver()
  db.exec(SCHEMA_V1)
  // A phone with work on it: queued scans, a photo waiting, a counter that
  // must not reset.
  db.exec(`insert into sync_meta (key, value) values ('outbox_seq', '41'), ('pull_cursor', '9000')`)
  db.exec(
    `insert into outbox (id, seq, op, payload, state, created_at)
     values ('o40', 40, 'submit_scan_batch', '{"asset_id":"a1","event_type":"check_out"}', 'pending', 1),
            ('o41', 41, 'submit_scan_batch', '{"asset_id":"a1","event_type":"check_in"}', 'pending', 2)`,
  )
  db.exec(
    `insert into condition_photos (id, asset_id, side, captured_at, local_uri)
     values ('ph1', 'a1', 'out', 1, 'data:image/jpeg;base64,AAAA')`,
  )
  db.exec(
    `insert into pending_uploads (id, local_uri, target_path, created_at)
     values ('ph1', 'data:image/jpeg;base64,AAAA', 'photos/ab/cd', 1)`,
  )
  return db
}

describe('the version ladder', () => {
  test('steps are strictly ascending from 2 and the top is the schema version', () => {
    const versions = LOCAL_MIGRATIONS.map((m) => m.version)
    assert.equal(versions[0], 2, 'version 1 is the baseline a phone HAD, never a step')
    for (let i = 1; i < versions.length; i++) {
      assert.ok(versions[i] > versions[i - 1], `steps must ascend (${versions[i - 1]} → ${versions[i]})`)
    }
    assert.equal(LOCAL_SCHEMA_VERSION, versions[versions.length - 1])
  })

  test('an empty database reads as 0, an unstamped one as 1', () => {
    assert.equal(localSchemaVersion(new NodeSqliteDriver()), 0)
    assert.equal(localSchemaVersion(openV1()), 1)
  })
})

describe('a fresh install', () => {
  test('gets the current schema in one go and is stamped, no steps run', () => {
    const db = new NodeSqliteDriver()
    const report = migrateLocal(db)
    assert.deepEqual(report, { from: 0, to: LOCAL_SCHEMA_VERSION, applied: [] })
    assert.equal(metaGet(db, 'schema_version'), String(LOCAL_SCHEMA_VERSION))
    assert.ok(db.get(`select 1 as one from id_map limit 0`) === undefined, 'id_map exists')
  })
})

describe('an installed v1 phone', () => {
  test('is brought to the current schema, step by step', () => {
    const db = openV1()
    const report = migrateLocal(db)
    assert.equal(report.from, 1)
    assert.equal(report.to, LOCAL_SCHEMA_VERSION)
    assert.deepEqual(report.applied, LOCAL_MIGRATIONS.map((m) => m.version))
    assert.equal(metaGet(db, 'schema_version'), String(LOCAL_SCHEMA_VERSION))
  })

  test('ends with EXACTLY a fresh install\'s tables and columns', () => {
    // History and present, welded: the steps must produce what the
    // create-if-not-exists schema produces, table for table, column for
    // column. A column added to schema.ts without a step fails here.
    const migrated = openV1()
    migrateLocal(migrated)
    const fresh = new NodeSqliteDriver()
    fresh.exec(LOCAL_SCHEMA)
    assert.deepEqual(shape(migrated), shape(fresh))
  })

  test('keeps every queued write, photo and counter — the rows that exist nowhere else', () => {
    const db = openV1()
    migrateLocal(db)
    assert.deepEqual(
      db.all(`select id, seq, state from outbox order by seq`).map((r) => [r.id, r.seq, r.state]),
      [['o40', 40, 'pending'], ['o41', 41, 'pending']],
    )
    assert.equal(metaGet(db, 'outbox_seq'), '41', 'the never-resets counter survives')
    assert.equal(metaGet(db, 'pull_cursor'), '9000')
    assert.equal(db.get(`select count(*) as n from condition_photos`).n, 1)
    assert.equal(db.get(`select state from pending_uploads where id = 'ph1'`).state, 'pending')
  })

  test('re-running is a no-op', () => {
    const db = openV1()
    migrateLocal(db)
    const before = shape(db)
    const again = migrateLocal(db)
    assert.deepEqual(again, { from: LOCAL_SCHEMA_VERSION, to: LOCAL_SCHEMA_VERSION, applied: [] })
    assert.deepEqual(shape(db), before)
  })

  test('a step interrupted halfway finishes on the next open', () => {
    // The app was killed between an ALTER and the stamp: the column exists,
    // the version does not say so. The runner must not die on 'duplicate
    // column name' — it skips what is there and adds what is not.
    const db = openV1()
    db.exec(`alter table jobs add column customer_id text`)
    const report = migrateLocal(db)
    assert.equal(report.applied[0], 2)
    const fresh = new NodeSqliteDriver()
    fresh.exec(LOCAL_SCHEMA)
    assert.deepEqual(shape(db), shape(fresh))
  })

  test('a phone stamped at an intermediate version runs only the later steps', () => {
    const db = openV1()
    // Hand-apply the first two steps and stamp 3, the way a phone that
    // installed the 0020 build would be.
    for (const step of LOCAL_MIGRATIONS.filter((m) => m.version <= 3)) {
      for (const s of step.sql.split(';').map((x) => x.trim()).filter(Boolean)) db.exec(s)
    }
    db.exec(`insert into sync_meta (key, value) values ('schema_version', '3')`)
    const report = migrateLocal(db)
    assert.deepEqual(report.applied, LOCAL_MIGRATIONS.filter((m) => m.version > 3).map((m) => m.version))
  })
})
