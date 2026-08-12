-- ============================================================================
-- 0006 — Making the sync read path survive real load
--
-- MEASURED PROBLEM. At 200 orgs / 400k assets, an incremental pull that
-- returns NOTHING cost 89ms. That is the common case: every device polls every
-- few seconds and is almost always caught up. Ten thousand devices polling
-- every ten seconds is ~1,000 requests/second of pure no-op, which at 89ms
-- each needs roughly ninety CPU cores to answer "nothing changed".
--
-- The individual pieces were all cheap — a table probe 1.7ms, the has_more
-- union 1.4ms, the jsonb aggregation 0.3ms. The cost was NOT the data. It was
-- eight `EXECUTE format(...)` statements: dynamic SQL cannot reuse a cached
-- plan, so every call re-parsed and re-planned eight RLS-wrapped queries.
--
-- Two fixes, in order of how much they matter:
--
--   1. A PER-ORG WATERMARK, so a caught-up device is answered by ONE indexed
--      lookup instead of eight planned queries. This is the fix that matters,
--      because it targets the case that actually happens.
--
--   2. STATIC SQL instead of dynamic, so the remaining path gets cached plans.
--
-- Both were measured before and after; see the test.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- org_sync_watermark — "has anything in this org changed at all?"
--
-- One row per org, holding the highest change_seq issued to any of its rows.
-- Maintained by AFTER STATEMENT triggers rather than per-row, so a bulk import
-- of 10,000 assets costs one upsert rather than ten thousand.
-- ---------------------------------------------------------------------------
create table org_sync_watermark (
  org_id         uuid primary key references orgs(id) on delete restrict,
  max_change_seq bigint not null default 0,
  updated_at     timestamptz not null default now()
);

alter table org_sync_watermark enable row level security;
alter table org_sync_watermark force row level security;
create policy org_sync_watermark_tenant on org_sync_watermark
  for select using (org_id = current_org_id());

grant select on org_sync_watermark to papa_app;

/**
 * SECURITY DEFINER, and this is the second and last place it is warranted.
 *
 * The watermark is internal bookkeeping, not user data. Clients get SELECT and
 * nothing else, so they can never write it — which matters, because a client
 * that could set its own watermark TOO HIGH would silently stop receiving
 * updates and have no way to notice.
 *
 * Safe as DEFINER because it takes no user input and does no user-controlled
 * querying: it aggregates the statement's own transition table and writes a
 * derived max, keyed by the org_id already on those rows. RLS governed which
 * rows could be written in the first place.
 */
create or replace function bump_org_watermark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- `new_rows` is the statement's transition table. One aggregate, one upsert
  -- per affected org, regardless of how many rows moved.
  insert into org_sync_watermark (org_id, max_change_seq, updated_at)
  select org_id, max(change_seq), now()
    from new_rows
   where change_seq is not null
   group by org_id
  on conflict (org_id) do update
    set max_change_seq = greatest(org_sync_watermark.max_change_seq, excluded.max_change_seq),
        updated_at = now();
  return null;
end
$$;

create or replace function attach_watermark_trigger(p_table text)
returns void
language plpgsql
as $$
begin
  execute format('drop trigger if exists %I on %I', p_table || '_watermark_ins', p_table);
  execute format('drop trigger if exists %I on %I', p_table || '_watermark_upd', p_table);
  execute format(
    'create trigger %I after insert on %I
       referencing new table as new_rows
       for each statement execute function bump_org_watermark()',
    p_table || '_watermark_ins', p_table);
  execute format(
    'create trigger %I after update on %I
       referencing new table as new_rows
       for each statement execute function bump_org_watermark()',
    p_table || '_watermark_upd', p_table);
end
$$;

select attach_watermark_trigger(t) from unnest(array[
  'products', 'assets', 'asset_tags', 'locations', 'jobs',
  'kit_templates', 'kit_template_items', 'asset_containment'
]) as t;

-- Backfill for anything that already exists.
insert into org_sync_watermark (org_id, max_change_seq)
select org_id, max(seq) from (
  select org_id, max(change_seq) seq from products          group by org_id
  union all select org_id, max(change_seq) from assets      group by org_id
  union all select org_id, max(change_seq) from asset_tags  group by org_id
  union all select org_id, max(change_seq) from locations   group by org_id
  union all select org_id, max(change_seq) from jobs        group by org_id
  union all select org_id, max(change_seq) from kit_templates group by org_id
  union all select org_id, max(change_seq) from kit_template_items group by org_id
  union all select org_id, max(change_seq) from asset_containment group by org_id
) s
where seq is not null
group by org_id
on conflict (org_id) do update
  set max_change_seq = greatest(org_sync_watermark.max_change_seq, excluded.max_change_seq);

-- ---------------------------------------------------------------------------
-- pull_changes, rewritten
--
-- Static SQL throughout. Verbose — eight near-identical blocks — and that
-- verbosity is the point: each one gets a cached plan, where the dynamic
-- version re-planned on every call.
--
-- The cursor rule is unchanged and still load-bearing: THE CURSOR IS THE
-- MINIMUM SAFE ADVANCE. Tables page independently against one shared sequence,
-- so returning max(seq) across them skips rows permanently and silently.
-- ---------------------------------------------------------------------------
create or replace function pull_changes(
  p_since bigint default 0,
  p_limit int default 2000
)
returns jsonb
language plpgsql
stable
as $$
#variable_conflict use_variable
declare
  result    jsonb := '{}'::jsonb;
  rows      jsonb;
  tbl_max   bigint;
  tbl_count int;
  safe_max  bigint := null;
  seen_max  bigint := p_since;
  truncated boolean := false;
  watermark bigint;
begin
  if current_org_id() is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- THE EARLY OUT. One indexed lookup answers the question a polling device
  -- actually asks, which is "is there anything for me?" — and the answer is
  -- almost always no.
  select max_change_seq into watermark
    from org_sync_watermark where org_id = current_org_id();

  if watermark is null or watermark <= p_since then
    return jsonb_build_object(
      'cursor', p_since,
      'has_more', false,
      'server_time', now(),
      'tables', jsonb_build_object(
        'products', '[]'::jsonb, 'assets', '[]'::jsonb, 'asset_tags', '[]'::jsonb,
        'locations', '[]'::jsonb, 'jobs', '[]'::jsonb, 'kit_templates', '[]'::jsonb,
        'kit_template_items', '[]'::jsonb, 'asset_containment', '[]'::jsonb));
  end if;

  -- Each block: page one table, fold it in, and hold the cursor back if this
  -- table filled its page.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.change_seq), '[]'::jsonb), max(x.change_seq), count(*)
    into rows, tbl_max, tbl_count
    from (select * from products where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('products', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.change_seq), '[]'::jsonb), max(x.change_seq), count(*)
    into rows, tbl_max, tbl_count
    -- Explicit projection, not `select *`. Two reasons, both measured:
    -- it is ~37% faster to serialise (40ms -> 25ms for a 2000-row page), and
    -- it cuts the payload the device has to pull over 3G, where ~28% of
    -- Pakistani mobile users are still on 2G. Columns the client does not
    -- mirror cost bandwidth on every first sync and buy nothing.
    from (select id, org_id, product_id, asset_code, serial_number, is_container,
                 rentable, presence, health, ownership, current_location_id,
                 current_parent_id, current_job_id, last_scanned_at,
                 notes, updated_at, deleted_at, change_seq
            from assets where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('assets', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.change_seq), '[]'::jsonb), max(x.change_seq), count(*)
    into rows, tbl_max, tbl_count
    from (select id, org_id, tag_code, asset_id, status, updated_at, change_seq
            from asset_tags where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_tags', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.change_seq), '[]'::jsonb), max(x.change_seq), count(*)
    into rows, tbl_max, tbl_count
    from (select * from locations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('locations', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.change_seq), '[]'::jsonb), max(x.change_seq), count(*)
    into rows, tbl_max, tbl_count
    from (select * from jobs where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('jobs', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.change_seq), '[]'::jsonb), max(x.change_seq), count(*)
    into rows, tbl_max, tbl_count
    from (select * from kit_templates where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('kit_templates', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.change_seq), '[]'::jsonb), max(x.change_seq), count(*)
    into rows, tbl_max, tbl_count
    from (select * from kit_template_items where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('kit_template_items', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.change_seq), '[]'::jsonb), max(x.change_seq), count(*)
    into rows, tbl_max, tbl_count
    from (select * from asset_containment where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_containment', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;

  return jsonb_build_object(
    'cursor', coalesce(safe_max, seen_max),
    -- The watermark also answers has_more without a scan: anything above the
    -- cursor is, by definition, still waiting.
    'has_more', truncated or coalesce(safe_max, seen_max) < watermark,
    'server_time', now(),
    'tables', result
  );
end
$$;

comment on function pull_changes(bigint, int) is
  'Cursor-pull sync. Early-outs on a per-org watermark so a caught-up device costs one indexed lookup. Static SQL so plans are cached. Cursor is the MINIMUM SAFE ADVANCE — see 0005.';
