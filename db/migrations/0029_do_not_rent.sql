-- ============================================================================
-- 0029 — The one money door with no server RPC: "do not rent to this client"
--
-- W13 built the eight screens the simulated year asked for, and seven of
-- them sat on RPCs that already existed (hold/apply/refund_deposit and
-- record_ledger_entry from 0017/0018, the scan-event health verbs from
-- 0003/0020, the month and utilisation reads from the projections). One
-- did not. `customers.blacklisted` has existed since 0017 and
-- `confirm_booking` has refused a blacklisted customer BY NAME since
-- 0022 D9 — but nothing could ever set the flag. It was a gate with no
-- switch: the year's FEB scene lost Rs 2.6M to an absconded client and
-- the day-14 escalation rung has told the desk to "consider a blacklist"
-- since W5, with no way to record the decision (year finding
-- `no-blacklist`).
--
--   D1  set_customer_blacklisted(p_customer_id, p_on, p_reason) →
--       customers. OWNER/MANAGER ONLY, like the refund (override 17) and
--       unlike the ordinary money write: refusing a client future
--       business is the most consequential thing a desk can say about a
--       person, and a warehouse phone must not be able to say it. A
--       REASON IS REQUIRED when switching the flag ON — override 18, the
--       same rule that makes the ledger refuse a note-less write-off:
--       the owner's judgement is never fought and always recorded. It is
--       audited both ways (`customer_blacklisted` / `customer_unblacklisted`)
--       because the audit log is where the WHY lives: the customers row
--       carries a boolean, and a boolean cannot be asked why.
--
--       Idempotent by nature: setting the flag to what it already is
--       writes no audit row and returns the row unchanged, so a replayed
--       op (replay_op's receipt answers a retry, but a desk may also
--       simply tap twice) cannot fill the audit log with noise.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. It does not make
-- `customers` syncable. The phone's customers mirror is the desk's own
-- (name and phone typed at the sheet), the table carries the contact
-- details 0009/0015 keep off warehouse phones, and giving it a pull
-- projection is a PII decision with a role predicate to design — not a
-- rider on a one-function migration. So the blacklist, like
-- `credentials_verified` before it (ASSUMPTION #local-credential-flag),
-- is a flag each phone sets and sends: the SERVER's flag is the law at
-- confirm, and a second phone learns the decision when customers sync.
-- ASSUMPTION: see docs/assumptions.md#local-blacklist-flag
--
-- No new table: db/test-migrate.sh's count stays 48. No new pull table:
-- pull_changes stays at its ELEVENTH edition (0028) and the key-count
-- assertions in the 0023/0026/0027 tests do not move. Idempotent: OR
-- REPLACE throughout. 0001–0028 stay untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- D1: set_customer_blacklisted
-- ---------------------------------------------------------------------------
create or replace function set_customer_blacklisted(
  p_customer_id uuid,
  p_on          boolean,
  p_reason      text default null
)
returns customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid := current_org_id();
  v_user   uuid := current_user_id();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_was    boolean;
  v_row    customers%rowtype;
begin
  if v_org is null or v_user is null then
    raise exception 'no org context' using errcode = 'insufficient_privilege';
  end if;

  -- Override 17's tier. A blacklist is not a bookkeeping entry; it is a
  -- standing refusal of business, and it is the owner's or the manager's.
  perform require_role('owner', 'manager');

  if p_on is null then
    raise exception 'say whether the client is blacklisted or not'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Override 18: the judgement is never fought and always recorded. The
  -- boolean cannot hold a reason, so the audit row does — which means a
  -- reason-less switch-on would leave the WHY nowhere at all. Checked
  -- BEFORE the budget: a malformed call is not an attempt at work, and
  -- spending the desk's allowance on its own validation errors would let
  -- a buggy client lock a real decision out for a minute.
  if p_on and v_reason is null then
    raise exception 'say why this client is being refused; the reason is the record'
      using errcode = 'check_violation';
  end if;

  -- Its own budget, tighter than the money one: nobody blacklists six
  -- clients a minute, and a runaway loop here is a business outage.
  if not rate_limit_check('blacklist:' || v_org::text || ':' || v_user::text, 6, '1 minute') then
    raise exception 'too many blacklist changes; wait a moment'
      using errcode = 'too_many_connections';
  end if;

  -- DEFINER sees every org's customers; the org predicate is by hand (0004).
  select c.blacklisted into v_was
    from customers c
   where c.id = p_customer_id and c.org_id = v_org and c.deleted_at is null
     for update;
  if not found then
    raise exception 'customer % does not belong to this org', p_customer_id
      using errcode = 'foreign_key_violation';
  end if;

  update customers
     set blacklisted = p_on,
         updated_at = now()
   where id = p_customer_id
  returning * into v_row;

  -- Nothing changed, nothing to say. A second tap is not a second decision.
  if v_was is distinct from p_on then
    perform write_audit(
      case when p_on then 'customer_blacklisted' else 'customer_unblacklisted' end,
      'customer', p_customer_id, v_reason,
      jsonb_build_object('blacklisted', p_on, 'reason', v_reason));
  end if;

  return v_row;
end
$$;

comment on function set_customer_blacklisted(uuid, boolean, text) is
  'The do-not-rent decision (0029 D1): owner/manager only, a reason required to switch it ON (override 18 — the audit row is where the why lives, since the column is a boolean), tenancy checked by hand, its own 6/min budget, audited both ways and silent when nothing changed. 0022 D9''s confirm gate is what enforces it.';

revoke all on function set_customer_blacklisted(uuid, boolean, text) from public;
grant execute on function set_customer_blacklisted(uuid, boolean, text) to papa_app;
