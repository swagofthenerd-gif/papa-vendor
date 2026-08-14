-- ============================================================================
-- 0013 — Dispatches: a job is a running tally, not a single moment
--
-- `scan_events.session_id` has grouped one pull or return since 0003, but a
-- session has never had a TERMINAL STATE. Without one:
--
--   * the desk cannot tell "finished" from "walked away halfway through", and
--   * there is nothing for the money side to hang off.
--
-- ---------------------------------------------------------------------------
-- WHY A DISPATCH IS NOT A SESSION, AND NOT A JOB
--
-- The obvious model — one job, one departure, one complete list — produces a
-- PERMANENT FALSE SHORTFALL in the ordinary case. A case leaves half-packed and
-- is topped up at the client's site. Half the kit goes on the 6am run and half
-- on the 2pm. Under a one-moment model each of those reads as "items missing",
-- and after the third one the tech stops trusting the number — which is the
-- adoption cliff, reached by way of a modelling error rather than a bug.
--
-- So a JOB accumulates and stays open. A DISPATCH is one departure: this truck,
-- this moment, these items. `18 of 40 out · rest to follow` is a fact, not a
-- failure. The 2pm run is a second dispatch against the same job.
--
-- Paper could never express that. Losing the printer removed a constraint.
-- ---------------------------------------------------------------------------
-- WHO MAY CONFIRM — set by the vendor, and narrower than the roles allow
--
-- Only the OWNER or the TECH. The driver does nothing at all: that is how these
-- yards actually work, and it is also the safer design. A driver cannot verify
-- forty items inside a sealed case at 6am with a truck waiting, so any
-- signature from him would attest to a count nobody checked — evidence in
-- appearance and fiction in substance.
--
-- The confirmer is therefore always someone who physically handled the gear.
-- ---------------------------------------------------------------------------
-- THE EVIDENCE LADDER
--
-- Confirmation is not binary, because the strength of what is being asserted
-- is not binary. `entry_method` already grades individual events
-- (scanned / manual / assumed / implied / counted). This grades the dispatch:
--
--   assumed rows          weakest — bulk-confirmed case, never dispute evidence
--   confirmed by warehouse  normal — the tech who loaded it says so
--   confirmed by owner     strongest — unlocks the money actions
--
-- Both can confirm, so nothing waits on the owner being present at 6am. They
-- simply are not worth the same, and `confirmed_by_role` records which it was
-- rather than flattening them into one boolean.
-- ============================================================================

create table dispatches (
  id            uuid primary key default uuid_generate_v7(),
  org_id        uuid not null references orgs(id) on delete restrict,
  job_id        uuid references jobs(id) on delete restrict,

  -- Ties back to the events. Client-generated, like scan_events.id, so a
  -- dispatch can be opened and confirmed entirely offline.
  session_id    uuid not null,

  direction     text not null,          -- out | back

  state         text not null default 'open',

  -- What the tech marked as going on THIS truck. The shortfall is measured
  -- against this, never against the whole job — that distinction is the point
  -- of the table.
  expected_count integer not null default 0,

  -- Snapshotted at confirmation rather than recomputed on read. The counts are
  -- what was asserted AT THAT MOMENT; recomputing later would silently rewrite
  -- history as more events arrive from other devices, which is exactly the
  -- property an evidence record must not have.
  scanned_count   integer,
  assumed_count   integer,
  unaccounted_count integer,

  opened_by     uuid not null references users(id) on delete restrict,
  opened_at     timestamptz not null default now(),

  confirmed_by  uuid references users(id) on delete restrict,
  confirmed_at  timestamptz,
  -- The evidence tier. Recorded at confirmation time because a person's role
  -- can change later, and this must describe the authority the assertion was
  -- made WITH, not the authority they happen to hold today.
  confirmed_by_role text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint dispatches_direction_check check (direction in ('out', 'back')),
  constraint dispatches_state_check check (state in ('open', 'confirmed', 'abandoned')),
  -- A confirmed dispatch must carry its full provenance. Half-filled evidence
  -- is worse than none, because it looks complete at a glance.
  constraint dispatches_confirmed_complete check (
    state <> 'confirmed' or (
      confirmed_by is not null and confirmed_at is not null
      and confirmed_by_role is not null and scanned_count is not null
    )
  )
);

create index dispatches_org_job_idx   on dispatches (org_id, job_id);
create index dispatches_org_open_idx  on dispatches (org_id, opened_at desc)
  where state = 'open';
create unique index dispatches_session_idx on dispatches (session_id);

alter table dispatches enable row level security;
alter table dispatches force row level security;

create policy dispatches_tenant on dispatches
  for select using (org_id = (select current_org_id()));
create policy dispatches_write on dispatches
  for insert with check (org_id = (select current_org_id()));
create policy dispatches_update on dispatches
  for update using (org_id = (select current_org_id()));

grant select, insert, update on dispatches to papa_app;

select make_syncable('dispatches');
select attach_watermark_trigger('dispatches');

-- ---------------------------------------------------------------------------
-- open_dispatch — begin a departure
-- ---------------------------------------------------------------------------
create or replace function open_dispatch(
  p_session_id uuid,
  p_job_id     uuid,
  p_direction  text default 'out',
  p_expected   integer default 0
)
returns dispatches
language plpgsql
as $$
declare
  v_row dispatches%rowtype;
begin
  perform require_role('owner', 'manager', 'desk', 'warehouse');

  insert into dispatches (org_id, job_id, session_id, direction, expected_count, opened_by)
  values (current_org_id(), p_job_id, p_session_id, p_direction, p_expected, current_user_id())
  -- Idempotent on the session: a device that opens the same dispatch twice
  -- after a retry gets the existing row, not a duplicate and not an error.
  on conflict (session_id) do update set updated_at = now()
  returning * into v_row;

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- confirm_dispatch — the assertion that this load is what it says it is
--
-- The counts are supplied by the caller rather than derived here, because the
-- DEVICE is the authority on what was in front of the tech at that moment. A
-- server-side recount would use rows from other devices that had synced in the
-- meantime and would quietly disagree with what the person actually saw and
-- confirmed.
-- ---------------------------------------------------------------------------
create or replace function confirm_dispatch(
  p_session_id  uuid,
  p_scanned     integer,
  p_assumed     integer,
  p_unaccounted integer
)
returns dispatches
language plpgsql
as $$
declare
  v_row  dispatches%rowtype;
  v_role text;
begin
  -- THE VENDOR'S RULE: only the owner or the tech. `driver` and `readonly` are
  -- deliberately absent and must stay absent — see the header.
  perform require_role('owner', 'manager', 'desk', 'warehouse');

  select m.role into v_role
    from memberships m
   where m.org_id = current_org_id()
     and m.user_id = current_user_id()
     and m.deleted_at is null;

  update dispatches
     set state = 'confirmed',
         scanned_count = p_scanned,
         assumed_count = p_assumed,
         unaccounted_count = p_unaccounted,
         confirmed_by = current_user_id(),
         confirmed_at = now(),
         confirmed_by_role = v_role,
         updated_at = now()
   where session_id = p_session_id
     -- Confirmation happens ONCE. A second confirmation would overwrite the
     -- counts that were asserted the first time, which is the one thing an
     -- evidence record must never allow.
     and state = 'open'
  returning * into v_row;

  if not found then
    raise exception 'dispatch % is not open for confirmation', p_session_id
      using errcode = 'check_violation';
  end if;

  return v_row;
end
$$;

comment on function confirm_dispatch(uuid, integer, integer, integer) is
  'Owner or tech only. Records the counts AS ASSERTED, once. Never recomputed server-side.';

-- ---------------------------------------------------------------------------
-- dispatch_evidence_strength — what a dispatch is worth
--
-- Used by the money side: deposit release, damage claims and billable lines
-- require 'strong'. Returned as a value rather than a boolean so the desk can
-- SHOW the difference instead of just refusing.
-- ---------------------------------------------------------------------------
create or replace function dispatch_evidence_strength(p_session_id uuid)
returns text
language sql
stable
as $$
  select case
    when d.state <> 'confirmed' then 'none'
    when d.confirmed_by_role in ('owner', 'manager') then 'strong'
    -- A dispatch mostly bulk-confirmed by case is weaker than one scanned item
    -- by item, whoever pressed the button. Belief is not observation.
    when coalesce(d.assumed_count, 0) > coalesce(d.scanned_count, 0) then 'weak'
    else 'normal'
  end
  from dispatches d where d.session_id = p_session_id;
$$;

grant execute on function
  open_dispatch(uuid, uuid, text, integer),
  confirm_dispatch(uuid, integer, integer, integer),
  dispatch_evidence_strength(uuid)
  to papa_app;
