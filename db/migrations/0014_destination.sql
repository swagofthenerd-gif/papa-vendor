-- ============================================================================
-- 0014 — Where is it going? Always.
--
-- The vendor's rule: **every dispatch records where the equipment is going.**
-- Not optional, not "if there's a booking".
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS MORE THAN ONE COLUMN
--
-- It closes the hole the design debate identified and could not solve: gear
-- that leaves with NO JOB AT ALL. The owner's nephew taking a light for a
-- personal shoot, a favour for a friend, an internal loan to the edit suite.
-- The debate's own observation was that this is DISPROPORTIONATELY the gear
-- that goes missing, and every job-keyed mechanism is blind to it by
-- construction.
--
-- Requiring a destination rather than a booking dissolves that. `job_id` was
-- already nullable, so a jobless departure is now a first-class dispatch:
-- no customer record, no rate card, no ceremony — a destination and a name.
--
-- The point is NOT to police the nephew. It is that when the app has no way
-- to represent undocumented movement, the item reads as "on the shelf"
-- forever — and an item confidently believed to be on a shelf it is not on is
-- the exact state where the data silently rots and the vendor walks away.
--
-- A two-second honest record beats a permanent silent lie.
-- ---------------------------------------------------------------------------
-- WHY IT IS ENFORCED AT CONFIRMATION, NOT AT OPENING
--
-- The tech opens a dispatch with his hands full at 6am and may genuinely not
-- know the destination yet — the desk is still on the phone with the client.
-- Blocking there would put a required field in the middle of the scan loop,
-- which is precisely the friction that gets an app abandoned.
--
-- By confirmation the departure is real and somebody knows where the truck is
-- headed. So the constraint sits on the CONFIRMED state: you may scan all
-- morning without answering, and you may not assert a completed departure to
-- nowhere.
-- ============================================================================

alter table dispatches add column destination text;

-- Who physically took it. Free text on purpose: at this point in the product
-- there is no customer entity, and forcing one would mean the nephew case
-- cannot be recorded at all — which is the situation this migration exists to
-- end. A name someone typed is worth more than a foreign key nobody could fill.
alter table dispatches add column recipient text;

-- The rule, in the database rather than in a screen. A screen-level check is
-- one refactor away from being lost, and this is the field the whole
-- jobless-gear story depends on.
alter table dispatches add constraint dispatches_confirmed_has_destination check (
  state <> 'confirmed' or (destination is not null and length(trim(destination)) > 0)
);

comment on column dispatches.destination is
  'Where the gear is going. Required to confirm, for every dispatch, with or without a job.';
comment on column dispatches.recipient is
  'Who took it. Free text: a typed name beats an unfillable foreign key.';

-- Finding what is out, and where, without a job. This is the query the owner
-- actually asks — "what is not in the building" — and it must not depend on a
-- booking existing.
create index dispatches_org_destination_idx on dispatches (org_id, state, opened_at desc)
  where job_id is null;

-- ---------------------------------------------------------------------------
-- open_dispatch / confirm_dispatch — carry the destination
--
-- Replaced rather than altered: these are the whole write path for departures
-- and a reader should see one current definition, not a base plus a patch.
-- ---------------------------------------------------------------------------
create or replace function open_dispatch(
  p_session_id  uuid,
  p_job_id      uuid,
  p_direction   text default 'out',
  p_expected    integer default 0,
  p_destination text default null,
  p_recipient   text default null
)
returns dispatches
language plpgsql
as $$
declare
  v_row dispatches%rowtype;
begin
  perform require_role('owner', 'manager', 'desk', 'warehouse');

  insert into dispatches (org_id, job_id, session_id, direction, expected_count,
                          destination, recipient, opened_by)
  values (current_org_id(), p_job_id, p_session_id, p_direction, p_expected,
          nullif(trim(p_destination), ''), nullif(trim(p_recipient), ''), current_user_id())
  on conflict (session_id) do update
    -- coalesce, not overwrite: a retry that carries no destination must not
    -- erase one the desk filled in between the first attempt and this one.
    set destination = coalesce(nullif(trim(p_destination), ''), dispatches.destination),
        recipient   = coalesce(nullif(trim(p_recipient), ''), dispatches.recipient),
        updated_at  = now()
  returning * into v_row;

  return v_row;
end
$$;

create or replace function confirm_dispatch(
  p_session_id  uuid,
  p_scanned     integer,
  p_assumed     integer,
  p_unaccounted integer,
  p_destination text default null,
  p_recipient   text default null
)
returns dispatches
language plpgsql
as $$
declare
  v_row  dispatches%rowtype;
  v_role text;
  v_dest text;
begin
  -- Only the owner or the tech. `driver` and `readonly` stay absent.
  perform require_role('owner', 'manager', 'desk', 'warehouse');

  select m.role into v_role
    from memberships m
   where m.org_id = current_org_id()
     and m.user_id = current_user_id()
     and m.deleted_at is null;

  -- Whatever is supplied now wins; otherwise whatever was set at open time.
  select coalesce(nullif(trim(p_destination), ''), d.destination)
    into v_dest
    from dispatches d
   where d.session_id = p_session_id;

  if v_dest is null then
    raise exception 'a dispatch cannot be confirmed without saying where the equipment is going'
      using errcode = 'check_violation';
  end if;

  update dispatches
     set state = 'confirmed',
         destination = v_dest,
         recipient = coalesce(nullif(trim(p_recipient), ''), recipient),
         scanned_count = p_scanned,
         assumed_count = p_assumed,
         unaccounted_count = p_unaccounted,
         confirmed_by = current_user_id(),
         confirmed_at = now(),
         confirmed_by_role = v_role,
         updated_at = now()
   where session_id = p_session_id
     and state = 'open'
  returning * into v_row;

  if not found then
    raise exception 'dispatch % is not open for confirmation', p_session_id
      using errcode = 'check_violation';
  end if;

  return v_row;
end
$$;

comment on function confirm_dispatch(uuid, integer, integer, integer, text, text) is
  'Owner or tech only. Requires a destination. Records the counts AS ASSERTED, once.';

-- The old four-argument form would silently bypass the destination rule.
drop function if exists confirm_dispatch(uuid, integer, integer, integer);
drop function if exists open_dispatch(uuid, uuid, text, integer);

grant execute on function
  open_dispatch(uuid, uuid, text, integer, text, text),
  confirm_dispatch(uuid, integer, integer, integer, text, text)
  to papa_app;

-- ---------------------------------------------------------------------------
-- whats_out — the question the owner actually asks
--
-- Deliberately includes jobless departures. A view that only showed booked
-- gear would reproduce exactly the blind spot this migration removes.
-- ---------------------------------------------------------------------------
create view whats_out with (security_invoker = true) as
select
  d.id,
  d.org_id,
  d.job_id,
  j.label            as job_label,
  d.destination,
  d.recipient,
  d.scanned_count,
  d.assumed_count,
  d.unaccounted_count,
  d.confirmed_at,
  d.confirmed_by_role,
  dispatch_evidence_strength(d.session_id) as evidence,
  (d.job_id is null)  as informal
  from dispatches d
  left join jobs j on j.id = d.job_id
 where d.direction = 'out'
   and d.state = 'confirmed';

comment on view whats_out is
  'Everything currently out, booked or not. The informal flag marks departures with no job.';

grant select on whats_out to papa_app;
