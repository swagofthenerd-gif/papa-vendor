-- ============================================================================
-- 0009 — Keeping PII off the scanners, structurally
--
-- PLAN.md override 13 requires `cnic`/`ntn` to be excluded from scanner sync,
-- and the readiness ledger has carried "CNIC/NTN still sync to scanners" as an
-- open PII gap. Both were written against a schema that does not exist yet:
--
--   THERE IS NO `customers` TABLE AND NO cnic/ntn COLUMN TODAY. Nothing is
--   leaking, because there is nothing to leak. Those arrive in phase 2.
--
-- So an "exclusion" has nothing to exclude, and writing one now would be
-- theatre. The real exposure is the shape of the sync itself:
--
--   `pull_changes` uses `select *` for six of its eight tables. The day
--   someone adds `customers` to make_syncable()'s array — a one-line change
--   that will look completely routine — every column on it goes to every
--   warehouse phone in the org, cnic included, with nothing in the way.
--
-- That is a trap laid for a future developer who has no reason to suspect it.
-- The fix is to make the trap impossible to walk into rather than to write a
-- rule down and hope it is read. This migration adds no runtime behaviour: it
-- adds a REGISTRY and a CHECK, and 0009's test fails the build the moment a
-- sensitive column becomes syncable.
--
-- Under Pakistan's PECA regime a CNIC on a warehouse phone is a breach, and
-- the phone is a Redmi in a tech's pocket. This is cheap now and expensive
-- after the fact.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- sync_sensitive_columns — the names that must never reach a device
--
-- A table rather than a hardcoded list so phase 2 can extend it in a migration
-- alongside the schema that needs it, and so the reasoning travels with the
-- entry instead of living in a commit message.
-- ---------------------------------------------------------------------------
create table sync_sensitive_columns (
  column_name text primary key,
  reason      text not null,
  added_at    timestamptz not null default now()
);

insert into sync_sensitive_columns (column_name, reason) values
  ('cnic',        'Pakistani national ID. PII under PECA; a stolen phone must not carry it.'),
  ('cnic_number', 'as cnic'),
  ('cnic_image',  'as cnic, and worse — an image is a forgeable credential'),
  ('ntn',         'tax identifier; commercially sensitive and identifying'),
  ('national_id', 'generic form of cnic'),
  ('passport_no', 'identity document'),
  ('tax_id',      'generic form of ntn'),
  ('date_of_birth', 'identifying, and never needed by a scanner');

comment on table sync_sensitive_columns is
  'Column names that may not exist on any syncable table. Enforced by sync_pii_violations() and asserted in the test suite.';

-- ---------------------------------------------------------------------------
-- sync_pii_violations — the check itself
--
-- Deliberately blunt: a sensitive column may not EXIST on a syncable table,
-- rather than "may exist but must be left out of the projection".
--
-- The softer rule cannot be verified. `pull_changes` is static SQL by design
-- (0006 — dynamic SQL cost 89ms per poll), so a projection is a hand-written
-- column list, and proving a hand-written list stays correct across future
-- edits means parsing the function body. A rule that can only be checked by
-- reading code is a rule that silently stops being true.
--
-- The blunt rule has an unambiguous remedy: split the table. `customers`
-- syncs; `customer_private` holds cnic/ntn and is never made syncable. That
-- is the same shape as the column exclusion PLAN.md asked for, expressed in a
-- way the database can actually enforce.
-- ---------------------------------------------------------------------------
create or replace function sync_pii_violations()
returns table (table_name text, column_name text)
language sql
stable
as $$
  -- A table is syncable exactly when make_syncable() gave it change_seq.
  -- Deriving it from the schema rather than from a list means a table added
  -- to sync in future is covered without anyone remembering to update this.
  select c.table_name::text, c.column_name::text
    from information_schema.columns c
   where c.table_schema = 'public'
     and lower(c.column_name) in (select column_name from sync_sensitive_columns)
     and exists (
       select 1 from information_schema.columns s
        where s.table_schema = 'public'
          and s.table_name = c.table_name
          and s.column_name = 'change_seq'
     )
   order by 1, 2;
$$;

comment on function sync_pii_violations() is
  'Sensitive columns living on syncable tables. Must always return zero rows — asserted in 0009_sync_pii_guard_test.sql. Remedy is to split the table, not to widen the list.';

grant select on sync_sensitive_columns to papa_app;
grant execute on function sync_pii_violations() to papa_app;

-- The registry is org-independent reference data, readable by anyone who can
-- read anything. No RLS: there is no tenant dimension to scope it by, and the
-- contents are a policy statement rather than customer data.
alter table sync_sensitive_columns enable row level security;
create policy sync_sensitive_columns_readable on sync_sensitive_columns
  for select using (true);
