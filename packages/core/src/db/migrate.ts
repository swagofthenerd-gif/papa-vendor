import type { SqlDriver } from './driver.ts'
import { LOCAL_SCHEMA } from './schema.ts'
import { metaGetNumber, metaSet } from '../meta.ts'

/**
 * The on-device schema migration (W9).
 *
 * THE GAP THIS CLOSES. schema.ts has said, at every column added since 0018,
 * "no installed phone exists yet, so create-if-not-exists still covers every
 * real database — but a local migration path stays a pre-ship requirement
 * before ANY device persists this schema." This is that path. The pipe is
 * the wave where a phone's database first outlives a page load, so it is
 * also the wave where a phone can be OLDER than the app that opens it.
 *
 * THE SHAPE. `sync_meta.schema_version` names what the database has been
 * given. Absent on a database that has tables means version 1 — the schema
 * as it stood before 0018, which is the oldest shape any device could hold.
 * Absent on an EMPTY database means a fresh install: the current schema is
 * applied in one go and stamped, and no step runs. Every step runs in its
 * own transaction and stamps its version inside it, so "applied" and
 * "recorded as applied" cannot come apart — the same rule db/migrate.sh
 * holds for the server.
 *
 * IDEMPOTENT BY CONSTRUCTION, not by hope. SQLite has no `add column if not
 * exists`, so the runner checks `pragma table_info` before every add-column
 * statement and skips the ones already there. A step can therefore be
 * re-run against a database that already carries half of it (the app was
 * killed between the ALTER and the stamp — a routine Tuesday on a warehouse
 * phone) and finish the other half.
 *
 * ONE HOME, STATED HONESTLY. The steps below repeat column definitions that
 * also live in LOCAL_SCHEMA. That is deliberate: the steps are HISTORY (what
 * a v3 phone must be given), the schema is the PRESENT (what a fresh install
 * gets), and packages/core/test/migrate.test.mjs welds them together by
 * migrating a v1 snapshot and asserting every table's column set equals a
 * fresh database's. Drift between the two fails the build.
 *
 * WHAT A STEP MAY NEVER DO: touch the outbox, pending_uploads,
 * condition_photos or voice_notes rows. Those exist nowhere else. A step
 * that needs to reshape one of them copies first and is tested on a
 * database with rows in it.
 */

export interface LocalMigration {
  version: number
  /** Plain statements separated by `;` — no comments inside the SQL. */
  sql: string
}

/**
 * The steps, oldest first. Version 1 is the pre-0018 baseline and has no
 * step: it is what a phone HAD, not something it is given.
 */
export const LOCAL_MIGRATIONS: LocalMigration[] = [
  {
    // 0018: jobs meet customers; the containment tombstone.
    version: 2,
    sql: `
      alter table jobs add column customer_id text;
      alter table jobs add column closed_at text;
      alter table asset_containment add column removed_at text;
    `,
  },
  {
    // 0020: the fleet lifecycle — why an item left.
    version: 3,
    sql: `
      alter table assets add column disposition text;
    `,
  },
  {
    // 0021: the living fleet — the two usage meters, the service
    // threshold, the battery flag, the cycle ceiling, and the awaaz note.
    version: 4,
    sql: `
      alter table assets add column rental_days_since_service integer default 0;
      alter table assets add column cycle_count integer default 0;
      alter table products add column service_due_after_rental_days integer;
      alter table products add column count_cycles integer default 0;
      alter table products add column retire_after_cycles integer;
      create table if not exists voice_notes (
        id          text primary key,
        asset_id    text,
        job_id      text,
        session_id  text,
        duration_ms integer not null default 0,
        captured_at integer not null,
        bytes       integer not null default 0,
        mime        text,
        local_uri   text not null,
        uploaded    integer not null default 0
      );
      create index if not exists voice_notes_asset_idx on voice_notes (asset_id);
      create index if not exists voice_notes_session_idx on voice_notes (session_id);
    `,
  },
  {
    // 0022/0023: the promise calendar reaches the phone.
    version: 5,
    sql: `
      alter table assets add column rentable integer default 1;
      alter table products add column tracking_mode text default 'serialized';
      alter table jobs add column booking_id text;
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
      create table if not exists booking_lines (
        id                  text primary key,
        org_id              text not null,
        booking_id          text not null,
        product_id          text,
        asset_id            text,
        qty                 integer not null default 1
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
    `,
  },
  {
    // 0024/0026: the rate card, the calendar, the line override.
    version: 6,
    sql: `
      alter table booking_lines add column rate_minor integer;
      alter table booking_lines add column original_rate_minor integer;
      alter table booking_lines add column override_reason text;
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
    `,
  },
  {
    // 0025: the network — partner houses, sub-hires, the crew line.
    version: 7,
    sql: `
      alter table jobs add column attendant_names text;
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
      create table if not exists sub_hires (
        id                  text primary key,
        org_id              text not null,
        direction           text not null,
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
        role       text not null default 'attendant',
        created_at text not null
      );
      create unique index if not exists job_attendants_job_user_idx on job_attendants (job_id, user_id);
    `,
  },
  {
    // W9: the pipe — the id map and the members mirror (0027).
    version: 8,
    sql: `
      create table if not exists id_map (
        client_id  text primary key,
        server_id  text not null,
        kind       text not null,
        mapped_at  integer not null
      );
      create index if not exists id_map_server_idx on id_map (server_id);
      create table if not exists members (
        id           text primary key,
        org_id       text not null,
        display_name text not null,
        role         text not null,
        has_pin      integer not null default 0
      );
    `,
  },
  {
    // W11: every write crosses — the org mirror (0028), one row: the
    // house's name for the letterhead.
    version: 9,
    sql: `
      create table if not exists org (
        id       text primary key,
        name     text not null,
        currency text,
        timezone text
      );
    `,
  },
]

/** What a fresh install is stamped with, and what every phone must reach. */
export const LOCAL_SCHEMA_VERSION = LOCAL_MIGRATIONS[LOCAL_MIGRATIONS.length - 1]!.version

const VERSION_KEY = 'schema_version'

export interface MigrateReport {
  /** 0 for a fresh install (no tables at all), else the version found. */
  from: number
  to: number
  /** The step versions that ran, in order. Empty on a fresh install and on
   *  a re-run. */
  applied: number[]
}

function tableExists(db: SqlDriver, table: string): boolean {
  return db.get<{ one: number }>(
    `select 1 as one from sqlite_master where type = 'table' and name = ?`,
    [table],
  ) !== undefined
}

function columnExists(db: SqlDriver, table: string, column: string): boolean {
  return db.all<{ name: string }>(`pragma table_info(${table})`).some((c) => c.name === column)
}

/** The version a database is at: 0 when empty, 1 when unstamped. */
export function localSchemaVersion(db: SqlDriver): number {
  if (!tableExists(db, 'sync_meta')) return 0
  return metaGetNumber(db, VERSION_KEY, 1)
}

/**
 * Bring a database to LOCAL_SCHEMA_VERSION. Safe to call on every open.
 */
export function migrateLocal(db: SqlDriver): MigrateReport {
  const from = localSchemaVersion(db)

  if (from === 0) {
    db.transaction(() => {
      db.exec(LOCAL_SCHEMA)
      metaSet(db, VERSION_KEY, LOCAL_SCHEMA_VERSION)
    })
    return { from, to: LOCAL_SCHEMA_VERSION, applied: [] }
  }

  const applied: number[] = []
  for (const step of LOCAL_MIGRATIONS) {
    if (step.version <= from) continue
    db.transaction(() => {
      for (const statement of statementsOf(step.sql)) {
        const add = /^alter\s+table\s+(\w+)\s+add\s+column\s+(\w+)/i.exec(statement)
        if (add && columnExists(db, add[1]!, add[2]!)) continue
        db.exec(statement)
      }
      metaSet(db, VERSION_KEY, step.version)
    })
    applied.push(step.version)
  }

  // The present, applied last: anything create-if-not-exists (a new index,
  // a table the steps and the schema both know) lands here, and a database
  // that was already current is untouched.
  db.transaction(() => {
    db.exec(LOCAL_SCHEMA)
    metaSet(db, VERSION_KEY, LOCAL_SCHEMA_VERSION)
  })

  return { from, to: LOCAL_SCHEMA_VERSION, applied }
}

function statementsOf(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
