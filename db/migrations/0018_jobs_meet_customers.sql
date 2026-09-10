-- ============================================================================
-- 0018 — Jobs meet customers: close/reopen, the reversal link, honest
--        asset earnings, and the sync lane for the two job columns
--
-- Phase B0 of docs/vendor-dream-plan.md, ordered by the year simulation
-- (docs/year-in-the-life.md): the #1 lived finding was that app-created jobs
-- could not link a customer and could not be closed, so the money book only
-- ever worked for seeded customers — the adoption cliff, falling in week one
-- of any real pilot. The server half of the fix:
--
--   D1  jobs.customer_id ALREADY EXISTS — 0017 added it, with the same-org
--       tenancy trigger (jobs_check_customer_org) firing on every write path.
--       This migration does not touch that column; it gives devices a way to
--       SEE it (D5) and gives jobs the other thing the year demanded: an end.
--
--   D2  A JOB ENDS WITH closed_at, AND THE PAIR CANNOT DISAGREE. status was
--       always allowed to say 'closed' (0002) but nothing recorded WHEN, and
--       no API said it at all. closed_at now rides beside status under a
--       CHECK: closed ⟺ closed_at is set. The guard trigger (D4) stamps and
--       clears it so no write path has to remember.
--
--   D3  THE CLOSE RULE, exactly: a job may close only when NO ASSET STILL
--       PROJECTS ONTO IT — `assets.current_job_id = job` is empty. That is
--       the projection's own definition of "still out": a confirmed check_in
--       (0003) sets presence='here' AND current_job_id=null in one update,
--       so a row still pointing at the job is a row that has not come home.
--       Deliberately the same predicate job_money_shortfalls (0017) calls
--       gear_still_out — the refund gate and the close gate must never
--       disagree about whether a job is finished. Closing is desk work
--       (owner/manager/desk); REOPENING rewrites the story a board tells
--       and is owner/manager only, audited (override 18's posture: record
--       the judgement, don't fight it).
--
--   D4  THE RULE HOLDS ON EVERY PATH, not just the polite one. jobs is
--       direct-DML under RLS (0002 grants + 0015 role gates) and stays that
--       way — label/date/customer edits are not evidence. But a bare
--       `update jobs set status='closed'` would walk straight past the RPC,
--       so a BEFORE trigger enforces D3 and the closed_at pairing for every
--       insert and update. The RPCs add roles, rate limits, audit and a
--       nameable error; the trigger makes the invariant true even for a
--       careless future DEFINER function. (Same shape as validate_ledger_
--       entry: FKs check existence, triggers check the business truth.)
--
--   D5  DEVICES LEARN customer_id AND closed_at. 0017 D2 kept the money
--       TABLES off phones, and they stay off — but these two columns live on
--       `jobs`, which has synced since 0005, and the client needs them for
--       the customer chip and for boards that stop accumulating every job
--       ever made. customer_id is an opaque uuid and closed_at a timestamp:
--       neither trips a sync_sensitive_columns pattern, and the excluded
--       phone-number column stays projected out (sync_exclusion_violations
--       still returns zero rows). pull_changes below is the fourth edition:
--       0015's text verbatim plus exactly these two columns in the jobs
--       block.
--
--   D6  THE LEDGER LEARNS 'reversal' — the second correction verb, the one
--       the client already speaks (the year's debt-clock and bounced-cheque
--       findings). corrects_entry_id is SUPERSESSION: the old row leaves the
--       sums and the new row replaces it. reversal_of is CANCELLATION: both
--       rows stay in the sums and cancel to zero, so the statement shows the
--       bounced cheque AND its reversal, and the debt clock can skip the
--       pair in time as well as in money. Rules, mirroring corrects_entry_id
--       where they rhyme:
--         * kind 'reversal' ⟺ reversal_of is set;
--         * the target is same-org, same-customer, never a deposit line
--           (the state machine is their only door), never itself a reversal
--           (a double negative is a new entry, not a chain);
--         * the amount is EXACTLY the negation of the target's — a partial
--           void is an adjustment wearing a costume;
--         * once only (unique partial index, like ledger_corrects_once_idx),
--           and the two mechanisms exclude each other per target: an entry
--           voided twice — once by each verb — would double-cancel in every
--           balance.
--       Reversals are audited like corrections: both rewrite the story a
--       customer may be told.
--
--   D7  asset_earnings TELLS THE CLIENT'S TRUTH: rental money only. The 0017
--       view summed damage_charge — a camera that gets broken often read as
--       the fleet's best performer — and knew nothing of reversals. Now:
--       charge + late_fee, minus anything corrected OR reversed, exactly the
--       client's assetEarnings (apps/app/src/demo/khata.ts). POLICY (owner
--       may overrule): a reversed charge keeps no phantom earnings.
--
-- Everything here is idempotent: IF NOT EXISTS / OR REPLACE / drop-and-
-- recreate pairs, the 0015/0016/0017 discipline. 0001–0017 stay untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- jobs.closed_at — when the job ended (D2)
-- ---------------------------------------------------------------------------
alter table jobs add column if not exists closed_at timestamptz;

-- Rows closed before this migration get their best-known instant. updated_at
-- moved when status did, which is honest to the minute; null would violate
-- the pairing constraint below and 'now()' would be a lie.
update jobs set closed_at = updated_at
 where status = 'closed' and closed_at is null;

-- The pair cannot disagree: closed ⟺ closed_at. (cancelled carries no
-- closed_at — it never ran, so it never ended.)
alter table jobs drop constraint if exists jobs_closed_at_pairs_status;
alter table jobs add constraint jobs_closed_at_pairs_status
  check ((status = 'closed') = (closed_at is not null));

create index if not exists jobs_org_closed_idx
  on jobs (org_id, closed_at desc) where status = 'closed';

comment on column jobs.closed_at is
  'When the job ended. Paired with status by jobs_closed_at_pairs_status and stamped/cleared by jobs_guard_close — no write path has to remember. Close rule (D3): no asset may still project onto the job.';

-- ---------------------------------------------------------------------------
-- The guard (D3 + D4): every path that closes a job obeys the close rule,
-- and closed_at is stamped/cleared so the constraint can never fire on an
-- honest writer.
-- ---------------------------------------------------------------------------
create or replace function jobs_guard_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out int;
begin
  if new.status = 'closed'
     and (tg_op = 'INSERT' or old.status is distinct from 'closed') then
    -- D3, the exact rule: an asset whose projection still points at the job
    -- has not come home (a confirmed check_in nulls current_job_id, 0003).
    -- Same predicate as job_money_shortfalls' gear_still_out.
    select count(*) into v_out from assets a where a.current_job_id = new.id;
    if v_out > 0 then
      raise exception 'job cannot close: % asset(s) still out on it', v_out
        using errcode = 'check_violation';
    end if;
    new.closed_at := coalesce(new.closed_at, now());
  end if;

  if new.status <> 'closed' then
    new.closed_at := null;
  end if;

  return new;
end
$$;

drop trigger if exists jobs_guard_close on jobs;
create trigger jobs_guard_close
  before insert or update of status, closed_at on jobs
  for each row execute function jobs_guard_close();

comment on function jobs_guard_close() is
  'D3/D4: a job closes only when no assets.current_job_id row points at it, on EVERY write path — the RPCs add roles/audit, this makes the invariant true. Stamps closed_at on close, clears it on reopen.';

-- ---------------------------------------------------------------------------
-- close_job / reopen_job — the app's doors (D3)
--
-- SECURITY DEFINER for uniform errors and audit, which means every statement
-- carries its own org predicate — the 0004 trap, handled the 0004 way.
-- ---------------------------------------------------------------------------
create or replace function close_job(
  p_job_id uuid,
  p_note   text default null
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
  v_out  int;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- Closing is desk work, like writing money (0017 D7).
  perform require_role('owner', 'manager', 'desk');

  -- One shared budget for job-state flips; fast fingers are ~1 per few
  -- seconds, so 60/min only stops a runaway loop (the 0016/0017 shape).
  if not rate_limit_check('jobstate:' || v_org::text || ':' || v_user::text, 60, '1 minute') then
    raise exception 'too many job changes; wait a moment'
      using errcode = 'too_many_connections';
  end if;

  select * into v_job from jobs j
   where j.id = p_job_id and j.org_id = v_org and j.deleted_at is null
   for update;
  if not found then
    raise exception 'job % does not belong to this org', p_job_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_job.status <> 'open' then
    raise exception 'job % is % and cannot be closed', p_job_id, v_job.status
      using errcode = 'check_violation';
  end if;

  -- D3, said here so the desk hears the count BEFORE the trigger's backstop.
  select count(*) into v_out from assets a
   where a.org_id = v_org and a.current_job_id = p_job_id;
  if v_out > 0 then
    raise exception 'job cannot close: % asset(s) still out on it', v_out
      using errcode = 'check_violation';
  end if;

  update jobs
     set status = 'closed', closed_at = now()
   where id = p_job_id and org_id = v_org
  returning * into v_job;

  perform write_audit(
    'job_closed', 'job', p_job_id, v_job.label,
    jsonb_build_object('customer_id', v_job.customer_id,
                       'note', nullif(trim(coalesce(p_note, '')), '')));

  return v_job;
end
$$;

comment on function close_job(uuid, text) is
  'End a job: owner/manager/desk, refused while any asset still projects onto it (D3 — the same gear_still_out predicate as the refund gate). Stamps closed_at; audited.';

/**
 * reopen_job — the undo, owner/manager only (D3): reopening resurrects the
 * job on every board and in every availability answer, which is a judgement
 * call about the world, not data entry. Always audited, note and all.
 */
create or replace function reopen_job(
  p_job_id uuid,
  p_note   text default null
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

  perform require_role('owner', 'manager');

  if not rate_limit_check('jobstate:' || v_org::text || ':' || v_user::text, 60, '1 minute') then
    raise exception 'too many job changes; wait a moment'
      using errcode = 'too_many_connections';
  end if;

  select * into v_job from jobs j
   where j.id = p_job_id and j.org_id = v_org and j.deleted_at is null
   for update;
  if not found then
    raise exception 'job % does not belong to this org', p_job_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_job.status <> 'closed' then
    raise exception 'job % is % — only a closed job can reopen', p_job_id, v_job.status
      using errcode = 'check_violation';
  end if;

  update jobs
     set status = 'open', closed_at = null
   where id = p_job_id and org_id = v_org
  returning * into v_job;

  perform write_audit(
    'job_reopened', 'job', p_job_id, v_job.label,
    jsonb_build_object('customer_id', v_job.customer_id,
                       'note', nullif(trim(coalesce(p_note, '')), '')));

  return v_job;
end
$$;

comment on function reopen_job(uuid, text) is
  'Owner/manager only: a reopened job re-claims gear in every availability answer, so it is a recorded judgement, not an edit. Clears closed_at; audited with the reason.';

-- ---------------------------------------------------------------------------
-- The reversal link (D6): customer_ledger_entries.reversal_of
-- ---------------------------------------------------------------------------
alter table customer_ledger_entries
  add column if not exists reversal_of uuid
    references customer_ledger_entries(id) on delete restrict;

comment on column customer_ledger_entries.reversal_of is
  'For entry_kind ''reversal'': the entry this line voids. CANCELLATION, not supersession — both rows stay in every sum and cancel exactly (amount is the negation, enforced by validate_ledger_entry). Once per target (ledger_reversal_once_idx); mutually exclusive with corrects_entry_id on the same target.';

-- The kind list and the sign rule learn 'reversal'. Its sign is the negation
-- of its target's, so the column constraint can only pin non-zero — the
-- exact-negation rule needs the target row and lives in the trigger.
alter table customer_ledger_entries drop constraint if exists ledger_kind_check;
alter table customer_ledger_entries add constraint ledger_kind_check
  check (entry_kind in (
    'charge', 'payment', 'deposit_hold', 'deposit_apply', 'deposit_refund',
    'late_fee', 'damage_charge', 'write_off', 'adjustment', 'reversal'
  ));

alter table customer_ledger_entries drop constraint if exists ledger_sign_per_kind;
alter table customer_ledger_entries add constraint ledger_sign_per_kind
  check (
    (entry_kind in ('charge', 'late_fee', 'damage_charge', 'deposit_hold')
       and amount_minor > 0)
    or (entry_kind in ('payment', 'write_off', 'deposit_apply', 'deposit_refund')
       and amount_minor < 0)
    or (entry_kind in ('adjustment', 'reversal') and amount_minor <> 0)
  );

-- A reversal and only a reversal names its target (the ledger_deposit_link
-- shape), and never itself.
alter table customer_ledger_entries drop constraint if exists ledger_reversal_link;
alter table customer_ledger_entries add constraint ledger_reversal_link
  check ((entry_kind = 'reversal') = (reversal_of is not null));
alter table customer_ledger_entries drop constraint if exists ledger_no_self_reversal;
alter table customer_ledger_entries add constraint ledger_no_self_reversal
  check (reversal_of is null or reversal_of <> id);

-- Once only, enforced under concurrency where a trigger check cannot — the
-- ledger_corrects_once_idx reasoning verbatim: two live reversals of one
-- target would BOTH cancel it and the balance would double-credit.
create unique index if not exists ledger_reversal_once_idx
  on customer_ledger_entries (reversal_of) where reversal_of is not null;

-- validate_ledger_entry, second edition: everything 0017 checked, plus the
-- reversal rules (D6) and the two verbs excluding each other per target.
create or replace function validate_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t customer_ledger_entries%rowtype;
  r customer_ledger_entries%rowtype;
begin
  if not exists (
    select 1 from customers c
     where c.id = new.customer_id and c.org_id = new.org_id and c.deleted_at is null
  ) then
    raise exception 'customer % does not belong to this org', new.customer_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.job_id is not null and not exists (
    select 1 from jobs j where j.id = new.job_id and j.org_id = new.org_id
  ) then
    raise exception 'job % does not belong to this org', new.job_id
      using errcode = 'foreign_key_violation';
  end if;

  -- A money line against someone ELSE's job would put this row on the wrong
  -- statement — the same bookkeeping lie hold_deposit refuses, enforced here
  -- so it holds for EVERY insert path. A job with no customer stays legal
  -- (the nephew case, 0014).
  if new.job_id is not null and exists (
    select 1 from jobs j
     where j.id = new.job_id
       and j.customer_id is not null
       and j.customer_id <> new.customer_id
  ) then
    raise exception 'job % belongs to a different customer', new.job_id
      using errcode = 'check_violation';
  end if;

  if new.asset_id is not null and not exists (
    select 1 from assets a where a.id = new.asset_id and a.org_id = new.org_id
  ) then
    raise exception 'asset % does not belong to this org', new.asset_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.deposit_id is not null and not exists (
    select 1 from deposits d where d.id = new.deposit_id and d.org_id = new.org_id
  ) then
    raise exception 'deposit % does not belong to this org', new.deposit_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.corrects_entry_id is not null then
    select * into t from customer_ledger_entries e where e.id = new.corrects_entry_id;

    if not found or t.org_id <> new.org_id then
      raise exception 'correction target does not exist in this org'
        using errcode = 'foreign_key_violation';
    end if;
    if t.customer_id <> new.customer_id then
      raise exception 'a correction must stay on the same customer'
        using errcode = 'check_violation';
    end if;
    if t.entry_kind <> new.entry_kind then
      raise exception 'a correction must keep the kind of the entry it corrects (% -> %)',
        t.entry_kind, new.entry_kind
        using errcode = 'check_violation';
    end if;
    -- Deposit lines move only through the state machine; correcting one
    -- would let the ledger and the deposits row tell different stories.
    if new.entry_kind in ('deposit_hold', 'deposit_apply', 'deposit_refund') then
      raise exception 'deposit entries cannot be corrected; use the deposit RPCs'
        using errcode = 'check_violation';
    end if;
    -- D6: the two verbs exclude each other. A reversed entry is already
    -- cancelled in the sums; superseding it too would cancel it twice.
    if exists (
      select 1 from customer_ledger_entries v
       where v.reversal_of = new.corrects_entry_id
    ) then
      raise exception 'entry % is already reversed and cannot also be corrected',
        new.corrects_entry_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.reversal_of is not null then
    select * into r from customer_ledger_entries e where e.id = new.reversal_of;

    if not found or r.org_id <> new.org_id then
      raise exception 'reversal target does not exist in this org'
        using errcode = 'foreign_key_violation';
    end if;
    if r.customer_id <> new.customer_id then
      raise exception 'a reversal must stay on the same customer'
        using errcode = 'check_violation';
    end if;
    if r.entry_kind in ('deposit_hold', 'deposit_apply', 'deposit_refund') then
      raise exception 'deposit entries cannot be reversed; use the deposit RPCs'
        using errcode = 'check_violation';
    end if;
    if r.entry_kind = 'reversal' then
      raise exception 'a reversal cannot reverse a reversal; record a fresh entry'
        using errcode = 'check_violation';
    end if;
    -- Exact cancellation: both lines stay on the page and sum to zero. A
    -- partial void is an adjustment and must say so.
    if new.amount_minor <> -r.amount_minor then
      raise exception 'a reversal must negate its target exactly (target %, got %)',
        r.amount_minor, new.amount_minor
        using errcode = 'check_violation';
    end if;
    -- The other half of the mutual exclusion: a superseded entry already
    -- left the sums; reversing it too would credit money that is not there.
    if exists (
      select 1 from customer_ledger_entries c
       where c.corrects_entry_id = new.reversal_of
    ) then
      raise exception 'entry % is already corrected and cannot also be reversed',
        new.reversal_of
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- record_ledger_entry, second edition: the door learns 'reversal' (D6)
--
-- The 7-argument 0017 signature is dropped first — CREATE OR REPLACE with an
-- extra argument would OVERLOAD, leaving two doors where one is unaudited.
-- ---------------------------------------------------------------------------
drop function if exists record_ledger_entry(uuid, text, bigint, uuid, uuid, text, uuid);

create or replace function record_ledger_entry(
  p_customer_id       uuid,
  p_entry_kind        text,
  p_amount_minor      bigint,
  p_job_id            uuid default null,
  p_asset_id          uuid default null,
  p_note              text default null,
  p_corrects_entry_id uuid default null,
  p_reversal_of       uuid default null
)
returns customer_ledger_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org  uuid;
  v_user uuid;
  v_row  customer_ledger_entries%rowtype;
begin
  select o_org, o_user into v_org, v_user
    from money_write_context(array['owner', 'manager', 'desk']);

  if p_entry_kind is null or p_entry_kind not in
     ('charge', 'payment', 'late_fee', 'damage_charge', 'write_off',
      'adjustment', 'reversal') then
    raise exception 'unknown or deposit-reserved entry kind %; deposits move through hold/apply/refund_deposit',
      coalesce(p_entry_kind, '(null)')
      using errcode = 'invalid_parameter_value';
  end if;

  if p_amount_minor is null or p_amount_minor = 0 then
    raise exception 'a money entry must carry a non-zero amount'
      using errcode = 'check_violation';
  end if;
  if p_entry_kind in ('charge', 'late_fee', 'damage_charge') and p_amount_minor < 0 then
    raise exception '% is money the customer owes; the amount must be positive', p_entry_kind
      using errcode = 'check_violation';
  end if;
  if p_entry_kind in ('payment', 'write_off') and p_amount_minor > 0 then
    raise exception '% reduces what the customer owes; the amount must be negative', p_entry_kind
      using errcode = 'check_violation';
  end if;
  -- The link and the kind travel together both ways (the trigger re-checks;
  -- refusing here names the mistake for the desk instead of the schema).
  if (p_entry_kind = 'reversal') <> (p_reversal_of is not null) then
    raise exception 'a reversal names the entry it voids, and only a reversal does'
      using errcode = 'invalid_parameter_value';
  end if;

  -- DEFINER sees every org's customers; the org predicate is by hand (0004).
  if not exists (
    select 1 from customers c
     where c.id = p_customer_id and c.org_id = v_org and c.deleted_at is null
  ) then
    raise exception 'customer % does not belong to this org', p_customer_id
      using errcode = 'foreign_key_violation';
  end if;

  insert into customer_ledger_entries
    (org_id, customer_id, entry_kind, amount_minor, currency,
     job_id, asset_id, note, corrects_entry_id, reversal_of,
     created_by, device_id, session_id)
  values
    (v_org, p_customer_id, p_entry_kind, p_amount_minor,
     coalesce((select o.currency from orgs o where o.id = v_org), 'PKR'),
     p_job_id, p_asset_id, nullif(trim(coalesce(p_note, '')), ''),
     p_corrects_entry_id, p_reversal_of,
     -- Attribution from the GUCs, never from arguments (0017 D3).
     v_user, current_device_id(), current_session_id())
  returning * into v_row;

  -- A correction rewrites the story a customer may be told; that is an
  -- administrative act, audited like role changes and tag binding (0007).
  if p_corrects_entry_id is not null then
    perform write_audit(
      'ledger_correction', 'customer_ledger_entry', p_corrects_entry_id,
      p_entry_kind,
      jsonb_build_object('correcting_entry_id', v_row.id,
                         'amount_minor', p_amount_minor));
  end if;

  -- So does a reversal — same act, other verb (D6).
  if p_reversal_of is not null then
    perform write_audit(
      'ledger_reversal', 'customer_ledger_entry', p_reversal_of,
      p_entry_kind,
      jsonb_build_object('reversing_entry_id', v_row.id,
                         'amount_minor', p_amount_minor));
  end if;

  return v_row;
end
$$;

comment on function record_ledger_entry(uuid, text, bigint, uuid, uuid, text, uuid, uuid) is
  'The general money write: owner/manager/desk, signed amount validated per kind, tenancy checked by hand, attribution from papa.* GUCs. Deposit kinds refused — the state machine is their only door. ''reversal'' names its target via p_reversal_of and negates it exactly (D6).';

-- ---------------------------------------------------------------------------
-- customer_balances, second edition: a reversal is money on the book (D6) —
-- it sums beside its target and cancels it to the paisa. Only the kind list
-- changed; everything else is 0017 verbatim.
-- ---------------------------------------------------------------------------
drop view if exists customer_balances;
create view customer_balances with (security_invoker = true) as
with live as (
  select e.*
    from customer_ledger_entries e
   where not exists (
     select 1 from customer_ledger_entries c
      where c.corrects_entry_id = e.id
   )
)
select
  c.org_id,
  c.id            as customer_id,
  c.name,
  c.blacklisted,
  -- ::bigint — sum(bigint) widens to numeric; the client mirror expects the
  -- same integer minor units the rows carry.
  coalesce(sum(l.amount_minor) filter (where l.entry_kind in
    ('charge', 'late_fee', 'damage_charge', 'adjustment',
     'payment', 'write_off', 'deposit_apply', 'reversal')), 0)::bigint as balance_minor,
  coalesce(sum(l.amount_minor) filter (where l.entry_kind in
    ('deposit_hold', 'deposit_apply', 'deposit_refund')), 0)::bigint as deposit_held_minor,
  count(l.id)::int     as entry_count,
  max(l.server_time)   as last_entry_at
  from customers c
  left join live l on l.customer_id = c.id and l.org_id = c.org_id
 where c.deleted_at is null
   -- The ledger's RLS already hides the ROWS from non-money roles, but the
   -- customers rows are org-visible to everyone — without this predicate a
   -- warehouse phone would see every customer with balance 0, which is a lie
   -- rather than a refusal. Zero rows is honest; zero rupees is not.
   and (select coalesce(current_member_role(), '')) in ('owner', 'manager', 'desk')
 group by c.org_id, c.id, c.name, c.blacklisted;

comment on view customer_balances is
  'THE balance (override 14): a sum over live (un-superseded) ledger rows, never a stored total. A reversal and its target both stay in the sum and cancel exactly (0018 D6). balance_minor is what the customer owes; deposit_held_minor is their money we hold. security_invoker + an explicit role predicate: non-money roles get zero rows, never zero balances.';

grant select on customer_balances to papa_app;

-- ---------------------------------------------------------------------------
-- asset_earnings, second edition: the client's rental-money-only truth (D7).
-- Mirrors apps/app/src/demo/khata.ts assetEarnings exactly: charge + late_fee
-- only, minus anything a correction superseded or a reversal cancelled.
-- ---------------------------------------------------------------------------
drop view if exists asset_earnings;
create view asset_earnings with (security_invoker = true) as
select
  e.org_id,
  e.asset_id,
  coalesce(sum(e.amount_minor) filter (where e.entry_kind in
    ('charge', 'late_fee')), 0)::bigint as earned_minor,
  count(*) filter (where e.entry_kind in
    ('charge', 'late_fee'))::int as earning_entry_count,
  max(e.server_time) as last_earned_at
  from customer_ledger_entries e
 where e.asset_id is not null
   and not exists (
     select 1 from customer_ledger_entries c
      where c.corrects_entry_id = e.id
   )
   and not exists (
     select 1 from customer_ledger_entries v
      where v.reversal_of = e.id
   )
 group by e.org_id, e.asset_id;

comment on view asset_earnings is
  'Per-asset revenue (vendor-dream-plan B6), RENTAL MONEY ONLY (0018 D7): live, un-reversed charge + late_fee lines that name the asset. damage_charge stays on the khata but a repair bill is not a celebration — the client''s payback bar and this view must name one figure. The bar divides by assets.purchase_price_minor.';

grant select on asset_earnings to papa_app;

-- ---------------------------------------------------------------------------
-- pull_changes, fourth edition (D5)
--
-- 0015's third edition verbatim — static SQL, the watermark early-out, THE
-- CURSOR IS THE MINIMUM SAFE ADVANCE, the C1 settle holdback, explicit
-- projections everywhere — with exactly one change: the jobs block now
-- carries customer_id and closed_at, the two columns the client boards need.
-- The excluded phone-number column stays projected out (the M6 rule; the
-- guard greps this function's source, so it is not named here).
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
        'kit_template_items', '[]'::jsonb, 'asset_containment', '[]'::jsonb));
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
                 rentable, presence, health, ownership, current_location_id,
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
    from (select id, org_id, label, expected_back, status, customer_id, closed_at,
                 created_by, created_at, updated_at, deleted_at,
                 change_seq, changed_xid8, changed_at
            from jobs where change_seq > p_since order by change_seq limit p_limit) x;
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
  'Cursor-pull sync, fourth edition (0018): the 0015 third edition plus jobs.customer_id and jobs.closed_at in the jobs projection (D5). The cursor is the minimum safe advance; explicit projections everywhere; the excluded jobs column stays out.';

grant execute on function pull_changes(bigint, int) to papa_app;

-- ---------------------------------------------------------------------------
-- Grants — every function is born with PUBLIC execute (the 0015 M1 lesson):
-- revoke first, then the explicit door list.
-- ---------------------------------------------------------------------------
revoke all on function jobs_guard_close()                                              from public;
revoke all on function close_job(uuid, text)                                           from public;
revoke all on function reopen_job(uuid, text)                                          from public;
revoke all on function validate_ledger_entry()                                         from public;
revoke all on function record_ledger_entry(uuid, text, bigint, uuid, uuid, text, uuid, uuid) from public;

grant execute on function
  close_job(uuid, text),
  reopen_job(uuid, text),
  record_ledger_entry(uuid, text, bigint, uuid, uuid, text, uuid, uuid)
  to papa_app;
