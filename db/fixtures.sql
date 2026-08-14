-- ============================================================================
-- Test fixture helpers
--
-- NOT A MIGRATION. Applied by run-tests.sh after the migrations and before the
-- tests, so it never ships to a real database. Test scaffolding in a migration
-- is scaffolding you find in production.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
--
-- Every test file seeds data as `postgres`, which means turning row-level
-- security off for the tables it inserts into and back on afterwards. That
-- dance was 133 hand-written lines across twelve files, and each one is a
-- list that has to be kept in step with the tables that file happens to touch.
--
-- Two things go wrong with a hand-written list, and the second one is nasty:
--
--   1. Add a table to a fixture, forget to add it to BOTH lists.
--   2. Forget to re-enable one. Every assertion after that point in the file
--      then runs against a table with NO TENANCY ENFORCEMENT — and passes,
--      because the rows are all visible. A tenancy test that cannot fail is
--      the exact failure mode this project already hit once.
--
-- So the pair below snapshots what was actually on and restores exactly that.
-- Not "enable everything" — that would silently turn RLS ON for any table
-- deliberately left without it, which is a different way to be wrong.
--
-- NOTE: a shared seed_baseline() was considered and rejected. The fixture DATA
-- genuinely differs per file — one to three users, zero to six memberships,
-- different roles, and 0004 needs org settings jsonb — so a single seed would
-- change what each test exercises. Only the RLS toggling is truly identical,
-- so only that is shared.
-- ============================================================================

create or replace function fixture_rls_off()
returns void
language plpgsql
as $$
declare t text;
begin
  -- `on commit drop` so it cannot leak between test files even if one forgets
  -- to call fixture_rls_on(). Tests roll back anyway; this is the second lock.
  create temp table if not exists _rls_snapshot (relname text primary key)
    on commit drop;

  insert into _rls_snapshot (relname)
  select c.relname
    from pg_class c
   where c.relkind = 'r'
     and c.relnamespace = 'public'::regnamespace
     and c.relrowsecurity
  on conflict do nothing;

  for t in select relname from _rls_snapshot loop
    execute format('alter table %I disable row level security', t);
  end loop;
end
$$;

create or replace function fixture_rls_on()
returns void
language plpgsql
as $$
declare t text;
begin
  -- Restores exactly what was recorded as on, and nothing else. `force` is a
  -- separate flag that `disable` does not clear, so it survives the round trip
  -- untouched — which matters, because force is what makes RLS apply to the
  -- table owner too.
  for t in select relname from _rls_snapshot loop
    execute format('alter table %I enable row level security', t);
  end loop;

  delete from _rls_snapshot;
end
$$;

comment on function fixture_rls_off() is
  'Test-only. Snapshots which tables have RLS on, then disables them. Pair with fixture_rls_on().';
