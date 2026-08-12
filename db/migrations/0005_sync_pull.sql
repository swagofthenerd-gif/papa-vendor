-- ============================================================================
-- 0005 — The sync read path
--
-- The device pulls everything in its org that changed since a cursor. That is
-- the whole design, and it is deliberately the dumb one.
--
-- WHY NOT POWERSYNC. The architecture recommended it, then named as its own
-- #2 risk that PowerSync's sync rules are a SECOND AUTHORIZATION SURFACE
-- running parallel to RLS — one wrong bucket parameter and a competitor's
-- inventory lands on a phone — requiring permanent CI infrastructure to
-- defend. Meanwhile its own sizing puts the full working set at 8-20MB.
--
-- So the trade was: roughly three weeks of saved work, in exchange for a
-- vendor in the hot path, a bucket-explosion failure mode, a self-hosting
-- escape hatch to rehearse, and a second place where tenancy can be got
-- wrong. At this data size that is not worth it. Cursor-pull deletes the
-- entire risk by keeping every authorization decision in RLS, which is
-- already tested.
--
-- Revisit if a customer's working set passes ~200MB or org count passes ~50.
-- Because the write path never depended on the sync layer, that swap stays
-- contained by construction.
--
-- ---------------------------------------------------------------------------
-- THE CURSOR IS A SEQUENCE, NOT A TIMESTAMP.
--
-- The obvious design — "give me everything with updated_at > :since" — loses
-- writes, silently and unrecoverably. Two transactions can take their
-- timestamp at start and commit in the other order, so a row can become
-- visible with an updated_at EARLIER than a cursor the client has already
-- advanced past. That row is then never sent again. The device is missing an
-- asset and neither side knows.
--
-- A global sequence assigned at write time has no such hole: values become
-- visible in commit order relative to a reader's snapshot, and the client
-- only ever advances to the highest value it actually received.
-- ============================================================================

create sequence change_seq_seq;

create or replace function set_change_seq()
returns trigger
language plpgsql
as $$
begin
  new.change_seq := nextval('change_seq_seq');
  return new;
end
$$;

/**
 * Make a table syncable: add the cursor column, index it, and stamp it on
 * every write.
 *
 * Applied through one function so a table cannot be made syncable while
 * missing a piece — the index in particular, whose absence turns every pull
 * into a sequential scan and would only show up as mysterious slowness at a
 * customer with real data.
 */
create or replace function make_syncable(p_table text)
returns void
language plpgsql
as $$
begin
  execute format('alter table %I add column if not exists change_seq bigint', p_table);
  execute format(
    'create index if not exists %I on %I (org_id, change_seq)',
    p_table || '_change_seq_idx', p_table);
  execute format('drop trigger if exists %I on %I', p_table || '_change_seq', p_table);
  execute format(
    'create trigger %I before insert or update on %I
       for each row execute function set_change_seq()',
    p_table || '_change_seq', p_table);
  -- Existing rows need a value or the first pull would skip them entirely.
  execute format('update %I set change_seq = nextval(''change_seq_seq'') where change_seq is null', p_table);
end
$$;

select make_syncable(t) from unnest(array[
  'products', 'assets', 'asset_tags', 'locations', 'jobs',
  'kit_templates', 'kit_template_items', 'asset_containment'
]) as t;

-- ---------------------------------------------------------------------------
-- pull_changes
--
-- SECURITY INVOKER, like the rest of the write path: RLS scopes every one of
-- these reads to the caller's org automatically. There is no org filter in
-- the SQL below and there must not be one — a hand-written filter alongside
-- RLS is a second place to get tenancy wrong, and the two would eventually
-- disagree.
--
-- Soft deletes ARE the tombstones. A row with deleted_at set still syncs, its
-- change_seq bumps, and the client removes it from its mirror. No separate
-- tombstone table, and no way for a delete to be missed by a device that was
-- offline when it happened.
-- ---------------------------------------------------------------------------
create or replace function pull_changes(
  p_since bigint default 0,
  p_limit int default 2000
)
returns jsonb
language plpgsql
stable
as $$
declare
  result    jsonb := '{}'::jsonb;
  t         text;
  rows      jsonb;
  tbl_max   bigint;
  tbl_count int;
  -- The highest value it is SAFE to advance to. See the note below.
  safe_max  bigint := null;
  seen_max  bigint := p_since;
  truncated boolean := false;
  tables    constant text[] := array[
    'products', 'assets', 'asset_tags', 'locations', 'jobs',
    'kit_templates', 'kit_template_items', 'asset_containment'
  ];
begin
  if current_org_id() is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  foreach t in array tables
  loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(x) order by x.change_seq), ''[]''::jsonb),
              max(x.change_seq), count(*)
         from (select * from %I
                where change_seq > $1
                order by change_seq
                limit $2) x',
      t)
      into rows, tbl_max, tbl_count
      using p_since, p_limit;

    result := result || jsonb_build_object(t, rows);

    if tbl_max is not null and tbl_max > seen_max then
      seen_max := tbl_max;
    end if;

    -- ---------------------------------------------------------------------
    -- THE CURSOR IS THE MINIMUM SAFE ADVANCE, NOT THE MAXIMUM SEEN.
    --
    -- Each table is paged independently, so they truncate at different
    -- points in one shared sequence. Returning max(seq) across all of them
    -- SKIPS ROWS, permanently and silently:
    --
    --   assets   has rows at 103,104,105,106,107 — limit 2 returns 103,104
    --   products has a row  at 108              — returned in full
    --   max seen = 108, client advances to 108
    --   assets 105,106,107 are below the cursor and were never sent.
    --   They will never be sent again. The device is missing three assets
    --   and neither side has any way to notice.
    --
    -- This is not hypothetical — the first version of this function did
    -- exactly that, and a test reproduced it. So: if ANY table filled its
    -- page, the cursor may not pass that table''s last returned row.
    -- ---------------------------------------------------------------------
    if tbl_count = p_limit and tbl_max is not null then
      truncated := true;
      if safe_max is null or tbl_max < safe_max then
        safe_max := tbl_max;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'cursor', coalesce(safe_max, seen_max),
    -- More waiting if any table filled its page, or if anything sits above
    -- the (possibly held back) cursor.
    'has_more', truncated or coalesce(safe_max, seen_max) < seen_max,
    'server_time', now(),
    'tables', result
  );
end
$$;

comment on function pull_changes(bigint, int) is
  'Cursor-pull sync. The cursor is a global sequence, NOT a timestamp: timestamps lose writes when transactions commit out of order, silently and permanently.';

grant execute on function pull_changes(bigint, int) to papa_app;
grant usage, select on sequence change_seq_seq to papa_app;
