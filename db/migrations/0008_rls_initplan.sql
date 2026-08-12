-- ============================================================================
-- 0008 — Make RLS policies evaluate their function calls ONCE per query
--
-- THE PROBLEM. A policy written as:
--
--     using (org_id = current_org_id())
--
-- calls `current_org_id()` **once for every row the planner examines**. On a
-- 300-row table nobody notices. On a table where a query touches 100k rows, it
-- is 100k function calls that all return the same value.
--
-- Wrapping the call in a scalar subquery:
--
--     using (org_id = (select current_org_id()))
--
-- lets Postgres hoist it into an InitPlan — evaluated ONCE, then compared as a
-- constant. Published benchmarks on this exact pattern show **73ms -> 2.2ms**,
-- roughly 26x, on a multi-tenant table.
--
-- Why it looks wrong and is not: a scalar subquery normally implies MORE work,
-- not less. The gain comes from the function being `stable` — the planner is
-- allowed to evaluate a stable function once per statement, but only when it
-- appears somewhere it can hoist. Inline in the predicate, it is re-evaluated
-- per row.
--
-- WHY A NEW MIGRATION RATHER THAN EDITING THE ORIGINALS. Nothing is deployed
-- yet, so editing 0001-0007 in place would work today and produce a tidier
-- history. It is not done because the habit is the point: once a migration has
-- run against a database anyone depends on, it is immutable. Establishing that
-- rule the first time it is inconvenient is the only way it survives.
--
-- Our own measurements did not catch this, and it is worth understanding why:
-- at 200 orgs each org holds ~2,000 assets, so a per-org query touches a couple
-- of thousand rows and the overhead hides inside 1-2ms. It emerges when a
-- single org gets large, which is exactly the successful-customer case.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0001 — tenancy
-- ---------------------------------------------------------------------------
drop policy if exists orgs_select on orgs;
create policy orgs_select on orgs
  for select using (
    id = (select current_org_id())
    and exists (
      select 1 from memberships m
      where m.org_id = orgs.id
        and m.user_id = (select current_user_id())
        and m.status = 'active'
        and m.deleted_at is null
    )
  );

drop policy if exists orgs_update on orgs;
create policy orgs_update on orgs
  for update using (id = (select current_org_id()) and (select has_role('owner')))
  with check (id = (select current_org_id()));

drop policy if exists users_select on users;
create policy users_select on users
  for select using (
    id = (select current_user_id())
    or exists (
      select 1
      from memberships mine
      join memberships theirs on theirs.org_id = mine.org_id
      where mine.user_id  = (select current_user_id())
        and mine.org_id   = (select current_org_id())
        and mine.status   = 'active'
        and mine.deleted_at is null
        and theirs.user_id = users.id
        and theirs.deleted_at is null
    )
  );

drop policy if exists users_update_self on users;
create policy users_update_self on users
  for update using (id = (select current_user_id()))
  with check (id = (select current_user_id()));

drop policy if exists memberships_select on memberships;
create policy memberships_select on memberships
  for select using (org_id = (select current_org_id()));

drop policy if exists memberships_write on memberships;
create policy memberships_write on memberships
  for all using (org_id = (select current_org_id()) and (select has_role('owner', 'manager')))
  with check (org_id = (select current_org_id()) and (select has_role('owner', 'manager')));

-- ---------------------------------------------------------------------------
-- 0002 — the tenant tables, regenerated through the same loop that made them
--
-- Kept as a loop so the ten policies cannot drift apart by hand. A policy that
-- looks different from its neighbours is where a leak hides.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'locations', 'products', 'assets', 'asset_tags', 'asset_containment',
    'stock_lots', 'stock_movements', 'kit_templates', 'kit_template_items', 'jobs'
  ]
  loop
    execute format('drop policy if exists %1$s_tenant on %1$s', t);
    execute format(
      'create policy %1$s_tenant on %1$s for all
         using (org_id = (select current_org_id()))
         with check (org_id = (select current_org_id()))', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 0003 — devices, scan_events, alerts
--
-- scan_events keeps SELECT and INSERT as separate policies with no UPDATE or
-- DELETE policy at all. That is deliberate and unchanged: the append-only
-- guarantee is enforced by the absent grant, the absent policy, AND a trigger.
-- ---------------------------------------------------------------------------
drop policy if exists devices_tenant on devices;
create policy devices_tenant on devices for all
  using (org_id = (select current_org_id()))
  with check (org_id = (select current_org_id()));

drop policy if exists scan_events_select on scan_events;
create policy scan_events_select on scan_events for select
  using (org_id = (select current_org_id()));

drop policy if exists scan_events_insert on scan_events;
create policy scan_events_insert on scan_events for insert
  with check (org_id = (select current_org_id()));

drop policy if exists alerts_tenant on alerts;
create policy alerts_tenant on alerts for all
  using (org_id = (select current_org_id()))
  with check (org_id = (select current_org_id()));

-- ---------------------------------------------------------------------------
-- 0006 — the sync watermark
-- ---------------------------------------------------------------------------
drop policy if exists org_sync_watermark_tenant on org_sync_watermark;
create policy org_sync_watermark_tenant on org_sync_watermark
  for select using (org_id = (select current_org_id()));

-- ---------------------------------------------------------------------------
-- 0007 — sessions, revocations, audit
-- ---------------------------------------------------------------------------
drop policy if exists device_sessions_tenant on device_sessions;
create policy device_sessions_tenant on device_sessions for select
  using (org_id = (select current_org_id()));

drop policy if exists revocations_tenant on revocations;
create policy revocations_tenant on revocations for select
  using (org_id = (select current_org_id()));

drop policy if exists audit_log_read on audit_log;
create policy audit_log_read on audit_log for select
  using (org_id = (select current_org_id()) and (select has_role('owner', 'manager')));
