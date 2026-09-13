-- ============================================================================
-- 0028 — Every write crosses the pipe (W11): the doors the phone had none
--        of, a margin that sees the booking's bills, and the org mirror
--
-- After W9 the phone replayed bookings, the network, rates and scans
-- against this server; the money book, the walk-in job, the customer and
-- the due date were still written to the mirror alone. Auditing every
-- store write (docs/the-pipe.md, "What crosses") found four things with
-- NO server door at all — customers and jobs were direct DML, which
-- replay_op (0027) cannot carry; a due-date change had no RPC; and the
-- extension screen's sub-rent intent queued an op nothing answered (year
-- finding `sub-rent-intent-unreplayable`). Plus one honesty gap: a bill
-- tagged to the BOOKING a job was born from was invisible to job_margin
-- (year finding `subhire-cost-unlinkable`).
--
--   D1  create_customer(p_name, p_phone, p_note) → customers. The khata's
--       add-customer door as an RPC: the same writer roles the 0017 direct
--       policy allows (everyone but readonly/driver), tenancy from the
--       GUCs, one row. The phone's `cust-…` id maps to the reply's id.
--
--   D2  create_job(p_label, p_contact, p_expected_back, p_customer_id,
--       p_note) → jobs. The walk-in. owner/manager/desk (closing is desk
--       work, 0018; so is opening), the 0018 job-state budget, the
--       customer's tenancy through the 0017 trigger, audited as
--       job_created. The bridge and the lend-out keep minting their own
--       jobs inside their RPCs; this door is for the job born at the desk
--       from a kit list or from nothing.
--
--   D3  set_job_expected_back(p_job_id, p_expected_back) → jobs. The due
--       date, settable and clearable (null = honest 'no date'). Same roles.
--
--   D4  set_booking_note(p_booking_id, p_note, p_append) → bookings. The
--       smallest honest realisation of the sub-rent intent: the line the
--       desk wrote ('Sub-rent FX9 ×1 for #5') is APPENDED to the server's
--       note, and the extension queued behind it replays. The intent's
--       calendar meaning is unchanged — the other client's claim stands
--       until a sub-hire IN covers it (ASSUMPTION #sub-rent-intent).
--       booking_write_context's roles and budget.
--
--   D5  job_margin, second edition: live expenses tagged to the job OR —
--       when they name no job — to the booking the job came from
--       (jobs.booking_id). The desk borrows at the enquiry and tags the
--       pencil; the pencil becomes the job; the job's margin must see the
--       bill. booking_sub_hire_cost (0024 D9) already read both links from
--       the booking's side; this is the same rule from the job's.
--
--   D6  The org mirror. orgs becomes syncable (change_seq, the settle
--       columns, the watermark — its own trigger, since orgs has `id`
--       where every other syncable table has `org_id`) and pull_changes
--       gains an ELEVENTH edition: 0027's tenth verbatim plus one block,
--       `org`: id, name, currency, timezone — one row, the caller's own
--       org (RLS scopes it; the predicate says so too). The parchi
--       letterhead and the money documents carry the HOUSE's name from it,
--       never the enrolled person's. `settings` and `slug` stay home.
--       ASSUMPTION: see docs/assumptions.md#org-mirror
--
-- No new table: db/test-migrate.sh's count stays 48. Idempotent: OR
-- REPLACE / IF NOT EXISTS throughout; the view is dropped and re-created.
-- 0001–0027 stay untouched; the three sync tests that count pull tables
-- move from seventeen to eighteen.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- D1: create_customer
-- ---------------------------------------------------------------------------
create or replace function create_customer(
  p_name  text,
  p_phone text default null,
  p_notes text default null
)
returns customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_user uuid := current_user_id();
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_row  customers%rowtype;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;
  -- The 0017 direct-DML policy's writers: everyone who is not readonly or
  -- a driver. The warehouse phone may name a walk-in too.
  perform require_role('owner', 'manager', 'desk', 'warehouse');

  if v_name is null then
    raise exception 'a customer needs a name' using errcode = 'check_violation';
  end if;

  if not rate_limit_check('customer:' || v_org::text || ':' || v_user::text, 60, '1 minute') then
    raise exception 'too many customers; wait a moment'
      using errcode = 'too_many_connections';
  end if;

  insert into customers (org_id, name, phone, notes, created_by)
  values (v_org, v_name,
          nullif(trim(coalesce(p_phone, '')), ''),
          nullif(trim(coalesce(p_notes, '')), ''),
          v_user)
  returning * into v_row;

  return v_row;
end
$$;

comment on function create_customer(text, text, text) is
  'The khata''s add-customer door as an RPC (0028 D1), so the phone''s queued row crosses through replay_op: writer roles (not readonly/driver), tenancy from the GUCs, a trimmed non-empty name. Returns the row; the phone maps its client id to the returned id.';

revoke all on function create_customer(text, text, text) from public;
grant execute on function create_customer(text, text, text) to papa_app;

-- ---------------------------------------------------------------------------
-- D2: create_job — the walk-in
-- ---------------------------------------------------------------------------
create or replace function create_job(
  p_label         text,
  p_contact       text default null,
  p_expected_back date default null,
  p_customer_id   uuid default null,
  p_note          text default null
)
returns jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org   uuid := current_org_id();
  v_user  uuid := current_user_id();
  v_label text := nullif(trim(coalesce(p_label, '')), '');
  v_job   jobs%rowtype;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- Opening a job is desk work, like closing one (0018 D3).
  perform require_role('owner', 'manager', 'desk');

  if v_label is null then
    raise exception 'a job needs a label' using errcode = 'check_violation';
  end if;

  -- The 0018 job-state budget, shared with close/reopen.
  if not rate_limit_check('jobstate:' || v_org::text || ':' || v_user::text, 60, '1 minute') then
    raise exception 'too many job changes; wait a moment'
      using errcode = 'too_many_connections';
  end if;

  -- The customer's tenancy is the 0017 trigger's (jobs_customer_tenancy):
  -- a foreign customer raises foreign_key_violation from the insert.
  insert into jobs (org_id, label, contact, expected_back, status, created_by, customer_id)
  values (v_org, v_label,
          nullif(trim(coalesce(p_contact, '')), ''),
          p_expected_back, 'open', v_user, p_customer_id)
  returning * into v_job;

  perform write_audit(
    'job_created', 'job', v_job.id, v_job.label,
    jsonb_build_object('customer_id', p_customer_id,
                       'expected_back', p_expected_back,
                       'note', nullif(trim(coalesce(p_note, '')), '')));

  return v_job;
end
$$;

comment on function create_job(text, text, date, uuid, text) is
  'The walk-in job (0028 D2): owner/manager/desk through the 0018 job-state budget; label required; the customer''s tenancy checked by the 0017 trigger; audited as job_created. The bridge (convert_booking_to_job) and the lend-out (record_sub_hire_out) mint their own jobs — this door is the desk''s.';

revoke all on function create_job(text, text, date, uuid, text) from public;
grant execute on function create_job(text, text, date, uuid, text) to papa_app;

-- ---------------------------------------------------------------------------
-- D3: set_job_expected_back — the due date
-- ---------------------------------------------------------------------------
create or replace function set_job_expected_back(
  p_job_id        uuid,
  p_expected_back date default null
)
returns jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid := current_org_id();
  v_user uuid := current_user_id();
  v_job  jobs%rowtype;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  perform require_role('owner', 'manager', 'desk');

  if not rate_limit_check('jobstate:' || v_org::text || ':' || v_user::text, 60, '1 minute') then
    raise exception 'too many job changes; wait a moment'
      using errcode = 'too_many_connections';
  end if;

  update jobs
     set expected_back = p_expected_back
   where id = p_job_id and org_id = v_org and deleted_at is null
  returning * into v_job;
  if not found then
    raise exception 'job % does not belong to this org', p_job_id
      using errcode = 'foreign_key_violation';
  end if;

  return v_job;
end
$$;

comment on function set_job_expected_back(uuid, date) is
  'Set or clear a job''s due date (0028 D3): owner/manager/desk, the 0018 job-state budget, tenancy by hand. Null is the honest ''no date''.';

revoke all on function set_job_expected_back(uuid, date) from public;
grant execute on function set_job_expected_back(uuid, date) to papa_app;

-- ---------------------------------------------------------------------------
-- D4: set_booking_note — the sub-rent intent's door
-- ---------------------------------------------------------------------------
create or replace function set_booking_note(
  p_booking_id uuid,
  p_note       text default null,
  p_append     boolean default false
)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_line text := nullif(trim(coalesce(p_note, '')), '');
  v_b    bookings%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from booking_write_context(array['owner', 'manager', 'desk']);

  select b.* into v_b
    from bookings b
   where b.id = p_booking_id and b.org_id = v_org and b.deleted_at is null
   for update;
  if v_b.id is null then
    raise exception 'booking % does not belong to this org', p_booking_id
      using errcode = 'foreign_key_violation';
  end if;

  update bookings
     set note = case
                  when coalesce(p_append, false)
                    then nullif(concat_ws(E'\n', nullif(trim(coalesce(v_b.note, '')), ''), v_line), '')
                  else v_line
                end
   where id = v_b.id and org_id = v_org
  returning * into v_b;

  return v_b;
end
$$;

comment on function set_booking_note(uuid, text, boolean) is
  'Set — or with p_append, append a line to — a booking''s note (0028 D4). The sub-rent intent''s server realisation: the extension screen''s line lands on the booking and the extension chained behind it replays. booking_write_context''s roles and budget.';

revoke all on function set_booking_note(uuid, text, boolean) from public;
grant execute on function set_booking_note(uuid, text, boolean) to papa_app;

-- ---------------------------------------------------------------------------
-- D5: job_margin, second edition — the booking's bills count
-- ---------------------------------------------------------------------------
drop view if exists job_margin;
create view job_margin with (security_invoker = true) as
select
  j.org_id,
  j.id            as job_id,
  j.label,
  j.customer_id,
  j.status,
  coalesce(i.s, 0)::bigint                    as income_minor,
  coalesce(x.s, 0)::bigint                    as expense_minor,
  (coalesce(i.s, 0) - coalesce(x.s, 0))::bigint as margin_minor
  from jobs j
  left join lateral (
    select sum(e.amount_minor) as s
      from customer_ledger_entries e
     where e.job_id = j.id
       and e.entry_kind in ('charge', 'late_fee', 'damage_charge')
       and not exists (select 1 from customer_ledger_entries c
                        where c.corrects_entry_id = e.id)
       and not exists (select 1 from customer_ledger_entries v
                        where v.reversal_of = e.id)
  ) i on true
  left join lateral (
    select sum(e.amount_minor) as s
      from org_expenses e
     where (e.job_id = j.id
            or (e.job_id is null and j.booking_id is not null and e.booking_id = j.booking_id))
       and e.reversal_of is null
       and not exists (select 1 from org_expenses r where r.reversal_of = e.id)
  ) x on true
 where j.deleted_at is null
   and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk');

comment on view job_margin is
  'What one job actually made: live charge-side ledger income naming the job minus live expenses naming it — or, when they name no job, the booking it was born from (0028 D5; booking_sub_hire_cost reads the same two links from the booking''s side). security_invoker + an explicit role predicate — non-money roles get zero rows, never zero margins.';

grant select on job_margin to papa_app;

-- ---------------------------------------------------------------------------
-- D6: the org mirror — orgs becomes syncable
--
-- make_syncable indexes (org_id, change_seq) and bump_org_watermark reads
-- new_rows.org_id; orgs has `id`. The same three columns and the same
-- trigger function, spelled for this one table.
-- ---------------------------------------------------------------------------
alter table orgs add column if not exists change_seq bigint;
alter table orgs add column if not exists changed_at timestamptz not null default clock_timestamp();
alter table orgs add column if not exists changed_xid8 xid8 not null default pg_current_xact_id();
create index if not exists orgs_change_seq_idx on orgs (id, change_seq);
drop trigger if exists orgs_change_seq on orgs;
create trigger orgs_change_seq before insert or update on orgs
  for each row execute function set_change_seq();
update orgs set change_seq = nextval('change_seq_seq') where change_seq is null;

create or replace function bump_own_org_watermark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into org_sync_watermark (org_id, max_change_seq, updated_at)
  select id, max(change_seq), now()
    from new_rows
   where change_seq is not null
   group by id
  on conflict (org_id) do update
    set max_change_seq = greatest(org_sync_watermark.max_change_seq, excluded.max_change_seq),
        updated_at = now();
  return null;
end
$$;

comment on function bump_own_org_watermark() is
  'bump_org_watermark for the orgs table itself (0028 D6), whose org id is its `id`.';

drop trigger if exists orgs_watermark_ins on orgs;
drop trigger if exists orgs_watermark_upd on orgs;
create trigger orgs_watermark_ins after insert on orgs
  referencing new table as new_rows
  for each statement execute function bump_own_org_watermark();
create trigger orgs_watermark_upd after update on orgs
  referencing new table as new_rows
  for each statement execute function bump_own_org_watermark();

revoke all on function bump_own_org_watermark() from public;

-- The 0015 settle columns: changed_at / changed_xid8 are stamped by the
-- same before-update path every syncable table uses.

-- ---------------------------------------------------------------------------
-- pull_changes, eleventh edition (D6)
--
-- 0027's tenth edition verbatim — static SQL, the watermark early-out, THE
-- CURSOR IS THE MINIMUM SAFE ADVANCE, the C1 settle holdback, explicit
-- projections everywhere — plus ONE block, `org`, and its key in the
-- early-out set (eighteen tables now; the sync tests count them). The
-- excluded jobs column stays projected out (the M6 rule; the guard greps
-- this function's source, so it is not named here).
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
  tbl_wait   bigint;   -- lowest returned seq that is not yet safely settled
  safe_max   bigint := null;   -- holdback from a table that filled its page
  settle_min bigint := null;   -- holdback from unsettled rows (C1)
  seen_max   bigint := p_since;
  truncated  boolean := false;
  watermark  bigint;
  v_xmin     xid8 := pg_snapshot_xmin(pg_current_snapshot());
  v_own      xid8 := pg_current_xact_id_if_assigned();
  -- clock_timestamp, not now(): now() is frozen at transaction start, and a
  -- pull inside a longer transaction would otherwise never see rows settle.
  v_fresh    timestamptz := clock_timestamp() - interval '3 seconds';
begin
  if current_org_id() is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- THE EARLY OUT. One indexed lookup answers the question a polling device
  -- actually asks, which is "is there anything for me?" — and the answer is
  -- almost always no. Safe without settle logic: it hands p_since straight
  -- back, and a cursor that never advances cannot skip a row.
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
        'kit_template_items', '[]'::jsonb, 'asset_containment', '[]'::jsonb,
        'bookings', '[]'::jsonb, 'booking_lines', '[]'::jsonb,
        'asset_reservations', '[]'::jsonb, 'stock_reservations', '[]'::jsonb,
        'stock_lots', '[]'::jsonb,
        'rate_cards', '[]'::jsonb, 'rate_card_entries', '[]'::jsonb,
        'org_calendar_days', '[]'::jsonb,
        'members', '[]'::jsonb,
        'org', '[]'::jsonb));
  end if;

  -- Each block: page one table, fold it in, hold the cursor back if this
  -- table filled its page, and hold it below any row whose writing
  -- transaction was concurrent with one that is still in flight (C1).
  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, global_product_id, category, manufacturer, model,
                 display_name, tracking_mode, specs, replacement_value_minor,
                 service_due_after_rental_days, count_cycles, retire_after_cycles,
                 hero_image_path, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from products where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('products', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- Explicit projection, not `select *`. Two reasons, both measured:
    -- it is ~37% faster to serialise (40ms -> 25ms for a 2000-row page), and
    -- it cuts the payload the device has to pull over 3G, where ~28% of
    -- Pakistani mobile users are still on 2G. Columns the client does not
    -- mirror cost bandwidth on every first sync and buy nothing.
    from (select id, org_id, product_id, asset_code, serial_number, is_container,
                 rentable, presence, health, ownership, disposition,
                 rental_days_since_service, cycle_count, current_location_id,
                 current_parent_id, current_job_id, last_scanned_at,
                 notes, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from assets where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('assets', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, tag_code, asset_id, status, updated_at,
                 change_seq, changed_xid8, changed_at
            from asset_tags where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_tags', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, parent_id, name, kind, path, code, last_counted_at,
                 created_at, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from locations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('locations', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- The jobs projection deliberately omits the phone-number column — see
    -- sync_column_exclusions. The desk reads it server-side; the warehouse
    -- floor never needs it and a stolen scanner must not carry it. (Not named
    -- here: sync_exclusion_violations() greps this function's source.)
    -- 0018 D5: customer_id (opaque uuid) and closed_at ride along so the
    -- boards can show the chip and stop accumulating finished jobs.
    -- 0023: booking_id (the 0022 D8 bridge) joins them — the phone now
    -- reads it to refuse a second conversion and a cancel under a live job.
    -- 0025 D8: attendant_names — the crew line, display names only, in
    -- assignment order, [] when nobody is on it. Names are not in the
    -- sensitive registry (the 0023 D1 reasoning); assign/unassign touch the
    -- job row so this projection re-syncs when the crew changes.
    from (select j.id, j.org_id, j.label, j.expected_back, j.status, j.customer_id, j.closed_at,
                 j.booking_id, j.created_by, j.created_at, j.updated_at, j.deleted_at,
                 job_attendant_names(j.id) as attendant_names,
                 j.change_seq, j.changed_xid8, j.changed_at
            from jobs j where j.change_seq > p_since order by j.change_seq limit p_limit) x;
  result := result || jsonb_build_object('jobs', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, name, notes, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from kit_templates where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('kit_templates', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, kit_template_id, product_id, qty, required,
                 change_seq, changed_xid8, changed_at
            from kit_template_items where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('kit_template_items', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select id, org_id, parent_asset_id, child_asset_id, relation, expected,
                 added_at, removed_at, change_seq, changed_xid8, changed_at
            from asset_containment where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_containment', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- 0023: the promise calendar. The two tstzranges are projected as
    -- their bounds (SQLite has no range type; both are '[)'). The client's
    -- NAME is denormalised in from customers — the customers table itself
    -- never syncs (0009/0015) — so a phone can say who a promise is for
    -- without carrying the khata. A rename reaches the phone with the
    -- booking's next write; the desk owns the name, the phone displays it.
    -- The credential override note stays server-side: a manager's remark
    -- about a stranger's paperwork has no business on a warehouse phone.
    from (select b.id, b.org_id, b.booking_no, b.customer_id,
                 (select c.name from customers c where c.id = b.customer_id) as customer_name,
                 b.status,
                 lower(b.customer_period) as customer_from,
                 upper(b.customer_period) as customer_until,
                 lower(b.blocked_period) as blocked_from,
                 upper(b.blocked_period) as blocked_until,
                 b.pencil_expires_at, b.note, b.cancel_reason,
                 b.created_at, b.updated_at, b.deleted_at,
                 b.change_seq, b.changed_xid8, b.changed_at
            from bookings b where b.change_seq > p_since order by b.change_seq limit p_limit) x;
  result := result || jsonb_build_object('bookings', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait

    -- 0026: the 0024 D8 override — the owner's final day rate, the card
    -- rate it replaced, and why — so the phone's quote shows the owner's
    -- number, not the card's. overridden_by / overridden_at stay home:
    -- the phone renders the reason, the audit row keeps the who and when.
    from (select id, org_id, booking_id, product_id, asset_id, qty,
                 rate_minor, original_rate_minor, override_reason,
                 created_at, deleted_at, change_seq, changed_xid8, changed_at
            from booking_lines where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('booking_lines', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- The reservation tombstones are what make an expired or cancelled
    -- pencil's claims vanish from every phone: prune_expired_pencils and
    -- cancel_booking set deleted_at, change_seq bumps, the mirror deletes.
    from (select id, org_id, booking_id, booking_line_id, asset_id,
                 lower(blocked_period) as blocked_from,
                 upper(blocked_period) as blocked_until,
                 state, created_at, deleted_at, change_seq, changed_xid8, changed_at
            from asset_reservations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('asset_reservations', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait

    from (select id, org_id, booking_id, booking_line_id, product_id, qty,
                 lower(blocked_period) as blocked_from,
                 upper(blocked_period) as blocked_until,
                 state, created_at, deleted_at, change_seq, changed_xid8, changed_at
            from stock_reservations where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('stock_reservations', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- The bulk shelf count the phone's availability answer starts from
    -- (0022 D6 here-now). Slim on purpose: no reorder threshold, no costs.
    -- stock_lots has no deleted_at — a lot is never tombstoned, only
    -- counted to zero.
    from (select id, org_id, product_id, location_id, qty_on_hand,
                 created_at, updated_at, change_seq, changed_xid8, changed_at
            from stock_lots where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('stock_lots', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;


  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- 0026: the rate card (0024 D3/D4/D10). Slim: the three knobs and the
    -- default flag; created_by stays home. RLS role-gates this table to
    -- owner/manager/desk, and pull_changes is INVOKER — a warehouse phone
    -- receives an empty page here, the price list never reaches the floor.
    from (select id, org_id, name, is_default, week_equals_days, min_billable_days,
                 weekend_mask, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from rate_cards where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('rate_cards', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- 0026: one product's day rate on one card (0024 D5). Same role gate
    -- as the card. A soft-deleted entry is the tombstone that sends the
    -- line back to unpriced on every phone — never to zero.
    from (select id, org_id, rate_card_id, product_id, day_rate_minor,
                 created_at, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from rate_card_entries where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('rate_card_entries', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- 0026: the calendar (0024 D6/D7) — every member sees it, season
    -- shading is useful on every screen. day is projected as text.
    from (select id, org_id, day::text as day, kind, name, rate_multiplier,
                 created_at, updated_at, deleted_at, change_seq, changed_xid8, changed_at
            from org_calendar_days where change_seq > p_since order by change_seq limit p_limit) x;
  result := result || jsonb_build_object('org_calendar_days', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    -- 0027 (W9): who can pick up this phone. The user id is the row's id
    -- (switch_session_user takes it); the display name and whether a PIN
    -- is set come through member_projection() — DEFINER, so the users
    -- row's grants and the hidden hash column are never touched from
    -- here, and the guard that greps this function's source finds no
    -- sensitive name. A suspended membership is projected as a tombstone:
    -- the person leaves every phone's picker at its next sync.
    from (select m.user_id as id, m.org_id, mp.display_name, m.role, mp.has_pin,
                 m.created_at, m.updated_at,
                 case when m.status = 'active' then m.deleted_at
                      else coalesce(m.deleted_at, m.updated_at) end as deleted_at,
                 m.change_seq, m.changed_xid8, m.changed_at
            from memberships m
            cross join lateral member_projection(m.user_id) mp
           where m.change_seq > p_since order by m.change_seq limit p_limit) x;
  result := result || jsonb_build_object('members', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  -- 0028 (W11): the house itself — ONE row, the org's name, currency and
  -- timezone. Never `settings` (policy knobs the phone reads through their
  -- own projections) and never `slug`. Read by the parchi letterhead and
  -- the money documents, which say the HOUSE's name and never a person's.
  select coalesce(jsonb_agg(to_jsonb(x) - 'changed_xid8' - 'changed_at' order by x.change_seq), '[]'::jsonb),
         max(x.change_seq), count(*),
         min(x.change_seq) filter (where x.changed_xid8 is distinct from v_own
                                     and (x.changed_xid8 >= v_xmin
                                          or x.changed_at > v_fresh))
    into rows, tbl_max, tbl_count, tbl_wait
    from (select o.id, o.name, o.currency, o.timezone, o.updated_at, o.deleted_at,
                 o.change_seq, o.changed_xid8, o.changed_at
            from orgs o where o.id = current_org_id() and o.change_seq > p_since
            order by o.change_seq limit p_limit) x;
  result := result || jsonb_build_object('org', rows);
  if tbl_max > seen_max then seen_max := tbl_max; end if;
  if tbl_count = p_limit then truncated := true;
     safe_max := least(coalesce(safe_max, tbl_max), tbl_max); end if;
  if tbl_wait is not null then
     settle_min := least(coalesce(settle_min, tbl_wait - 1), tbl_wait - 1); end if;

  return jsonb_build_object(
    -- The cursor never passes a truncated page NOR an unsettled row (C1).
    'cursor', least(coalesce(safe_max, seen_max),
                    coalesce(settle_min, coalesce(safe_max, seen_max))),
    -- The watermark also answers has_more without a scan: anything above the
    -- cursor is, by definition, still waiting. Deliberately computed WITHOUT
    -- the settle holdback: a lag-held row was already DELIVERED in this
    -- response, so there is nothing more to fetch right now, and reporting
    -- has_more=true would make a pull-until-done client spin for the whole
    -- settle window.
    'has_more', truncated or coalesce(safe_max, seen_max) < watermark,
    'server_time', now(),
    'tables', result
  );
end
$$;

comment on function pull_changes(bigint, int) is
  'Cursor-pull sync, eleventh edition (0028): the 0027 tenth edition plus the org mirror (one row: id, name, currency, timezone — the letterhead''s name). The cursor is the minimum safe advance; explicit projections everywhere; the excluded jobs column stays out.';

grant execute on function pull_changes(bigint, int) to papa_app;
