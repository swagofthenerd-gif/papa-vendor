# Authentication — server-side design (0016)

Phone OTP once at enrolment, a long-lived hashed device-session token, and a
per-user PIN that decides whose name goes on a scan. Implemented entirely in
`db/migrations/0016_auth.sql`; no vendor identity anywhere. This page records
the decisions and the trust model; the migration header records the mechanics.

## The constraints that shaped everything

- **OTP at enrolment only.** SMS to Pakistan is ~$0.47/segment; per-login OTP
  is ~$473/mo at 100 customers and locked a competitor's users out of jobs
  (HANDOFF §5, §9). One SMS per person per device, ever, at the desk on WiFi.
- **The one-way door stays shut** (CONTRIBUTING, Staying portable). The
  `users` row is ours, `external_auth_id` is a nullable pointer *out*, and no
  policy or function reads a vendor identity function. Identity reaches SQL
  only through `current_org_id()` / `current_user_id()`, which already carry
  the `papa.*` fallback every test uses. 0016 adds the thing that *sets* those
  GUCs from a session token — it does not add a new way to read identity.
- **Offline for days is normal.** The token must outlive a bad-signal week; the
  PIN is the local gate on the shared phone. Session lifetime is therefore
  generous (60 days, sliding) and revocation is honest: *within one
  connectivity window, hard-limited by `expires_at`* (HANDOFF §12).
- **Driver gets nothing.** The vendor's rule. No enrolment, no PIN, no device
  session for `role = 'driver'`. (The 0004/0015 RLS allowance for driver scan
  *appends* is untouched — it simply has no session to ride on.)

## Enrolment

```
owner: invite_member(phone, name, role)        -- creates users row + membership
edge:  request_otp(phone)                      -- papa_auth only; returns code ONCE
       → transport sends the SMS
phone: complete_enrolment(phone, code, device_id, label, pin?, org_slug?)
       → users row bound, device upserted, device_session issued,
         token returned ONCE, papa.* set for this transaction
```

- **The transport is a pluggable seam, not a dependency.** `request_otp()` is
  executable only by the `papa_auth` role — whatever server-side thing the
  hosting choice provides (a Supabase edge function today, a VPS cron
  tomorrow). It returns the plaintext code exactly once; the database stores a
  bcrypt hash with a 10-minute expiry and a 5-attempt burn. A client never
  sees `request_otp` — an OTP you can read over the API is not an OTP.
- **If a vendor (e.g. Supabase Auth) delivers and verifies the OTP itself**,
  the transport calls `enrol_verified_device()` (also `papa_auth`-only)
  instead, which stamps `users.external_auth_id` and converges on the same
  session issuance. Either way the users/memberships/device_sessions rows are
  ours and a migration off the vendor is a config change, not a re-enrolment.
- **Enrolment binds, it does not create authority.** The membership must
  already exist (via `invite_member`, owner/manager-gated). An unknown phone
  gets no SMS (`request_otp` refuses — each one costs money) and no account.
- **Idempotent.** Re-enrolling the same phone+device finds the same users row,
  touches nothing on the membership, upserts the same device row, and issues a
  fresh session that supersedes (revokes) the previous one for that device.
  One active session per device — the device is the unit of custody.
- **Multi-org phones** (one person, two rental houses) must pass `org_slug`;
  ambiguity is refused *before* the OTP is consumed, so the code survives the
  retry.
- **Initial PIN** may be set during enrolment, but only if none is set —
  enrolment never silently overwrites a PIN. Resets go through the two
  explicit paths below.

### Failure is a value wherever failure is counted

A raised exception aborts the whole request transaction at the gateway
(PostgREST rolls back on error) — including the rate-limit increments and
attempt counters written moments earlier. An OTP/PIN gate that raises on a
wrong guess therefore never counts the guesses. This is precisely why
`verify_pin` (0015) returns `false` instead of raising, and 0016 follows the
same rule everywhere counting matters: a wrong or expired OTP code returns a
null-token result from `complete_enrolment` (and `false` from
`reset_pin_with_otp`), a wrong PIN returns `false` from
`switch_session_user`. The failed attempt **commits**; the lockout is real.
Raising is reserved for failures that need no memory — bad arguments, missing
sessions, and the limiter's own refusal (prior committed counts keep
refusing). Null-token doubles as the anti-oracle: unknown phone and wrong
code are indistinguishable to an anonymous caller.

## Session — how a request proves itself

`device_sessions` (0007) already had the right shape: hashed token, expiry,
revocation columns. 0016 adds the enforcement that was absent:

- **Token**: 32 random bytes, hex — returned once at enrolment, stored only as
  a SHA-256 hex digest. `token_hash` is column-revoked from `papa_app` the
  same way 0015 hid `pin_hash`.
- **`authenticate_device(token)`** — SECURITY DEFINER, pinned search_path —
  validates hash → live session → unexpired → membership still active → no
  matching `revocations` row since issue, then calls
  `set_config('papa.org_id'|'papa.user_id'|'papa.device_id'|'papa.session_id',
  …, is_local => true)`. **Transaction-scoped GUCs**, so a pooled connection
  carries nothing across requests. Every existing RLS policy and RPC works
  unchanged because they already read `current_org_id()` / `current_user_id()`
  — this is the payoff of the portability rule.
- **The PostgREST seam is `db-pre-request`.** Config:
  `db-pre-request = "public.auth_pre_request"`. That hook runs inside the
  request's transaction before the main statement; it reads the
  `x-papa-session` header out of `request.headers` and calls
  `authenticate_device`. No header → no-op (public endpoints like
  `resolve_tag_public` keep working). Bad token → raise → PostgREST aborts the
  transaction; no identity is ever half-set. Any other gateway can do the same
  thing: one function call at the top of the transaction.
- **All failure modes return one message** ("invalid or expired device
  session", SQLSTATE 28000) — expired, revoked, garbage and cross-org tokens
  are indistinguishable to a probe.
- **Sliding expiry**: each successful authenticate extends `expires_at` to
  now + lifetime (org-tunable via `orgs.settings.device_session_days`, default
  60 — ASSUMPTION, unvalidated). The write is throttled to once per 5 minutes
  per session so the per-request hot path stays read-only. A phone that stays
  in a basement 60 days re-enrols; one that surfaces weekly never expires.
  This *is* the fired-employee exposure window; owning it beats pretending
  (0007's own words).

### Trust model — why a client cannot set `papa.*` itself

The `papa.*` GUCs are an ambient channel, so the honest question is who can
write them. Three writers exist:

1. **The auth functions** (DEFINER, this migration) — after validating a token.
2. **Test SQL** (`set local papa.org_id = …`) — runs as roles a client never
   holds, inside the pgTAP harness. This is the documented vendor-free test
   seam, not a production path.
3. **Anyone who can execute arbitrary SQL** — which no client can. The only
   network surface is PostgREST (or an equivalent gateway), which exposes
   *whitelisted functions in the `public` schema* and maps request data only
   into `request.*` GUCs it sets itself. `set_config`/`SET` live in
   `pg_catalog` and are not exposed; there is no endpoint that executes
   client-supplied SQL. A JWT, if present, is verified by the gateway before
   its claims reach `request.jwt.*`.

Defence in depth on top of that: `authenticate_device` **overwrites** all four
`papa.*` GUCs unconditionally on success (a poisoned pool connection or a
stale value cannot survive an authenticate), and on failure it **raises**, so
the transaction — and any GUC set within it — dies. Both are pinned by tests.
The residual assumption, stated plainly: *the SQL role a client reaches the
database with must never be able to run arbitrary SQL.* That holds for
PostgREST/Supabase REST and must be re-checked if a different gateway is ever
adopted.

## PIN — user switching on the shared phone

- **`switch_session_user(user_id, pin)`** — requires an authenticated device
  session; verifies via `verify_pin()` (0015: DEFINER, hash never leaves,
  internally rate-limited **5/min per user per org** — the wrong-PIN lockout,
  riding the existing `rate_limits` table); a wrong PIN returns `false` (see
  *failure is a value*); on success repoints `device_sessions.user_id` and
  `papa.user_id`. Subsequent requests on that
  token speak as the new user until the next switch — which matches the
  physical reality that the phone is handed over, not shared concurrently.
- **PIN resets**:
  - Owner/manager reset a *member's* PIN: `set_member_pin(user_id, pin)`.
    Refused for owner targets — a manager who can reset the owner's PIN can
    become the owner on money actions. Refused for driver (gets nothing).
  - The **owner's own PIN** resets only by proving phone possession again:
    `request_otp(phone, 'pin_reset')` → `reset_pin_with_otp(phone, code,
    new_pin)`. OTP re-enrolment in exactly the HANDOFF sense.
- PINs are 4–6 digits, stored bcrypt (`crypt/gen_salt('bf')`), consistent with
  0015. Offline PIN checks on the device itself are the app wave's problem and
  are advisory there; the server-side gate is the authoritative one.

## Device binding — closing the review's open item

Review 2026-09-02, lens 1, open: *"an in-org member can burn another device's
idempotency slots"* because `submit_scan_batch(p_device_id, …)` trusted the
argument. 0016 recreates `submit_scan_batch` with one added guard: when the
transaction carries a device session (`papa.device_id` set), `p_device_id`
must equal it or the batch is refused (42501) before anything is written.
`current_device_id()` reads **only** `papa.device_id` — device identity has no
JWT channel and never will.

Residual, stated honestly: a request with *no* device session (console JWT,
legacy tests) still passes a bare device string. Production scanner traffic
always authenticates through the session path once the app wave lands, and the
console has no scan surface; if that ever changes, the guard hardens to
*require* a session rather than match one — a one-line change, noted in the
migration.

## Revocation — the lost phone

`revoke_device(device_id, reason, wipe)` (owner/manager): writes the durable
`revocations` row (scope `device`, honoured by `authenticate_device` for any
session issued before the revocation), kills all live sessions for the device,
and audits. Re-enrolment after a revocation works — the new session postdates
the revocation row — so a found phone comes back through the front door, with
an SMS, not through an admin override. `sign_out_device()` lets a device
retire its own session. Suspending a membership already de-authenticates at
next contact (membership status is checked on every authenticate). Timestamps
in this path use `clock_timestamp()`, not `now()`, so ordering is real even
inside one transaction.

## Rate limits added (all on 0007's `rate_limits`, all inside DEFINER)

| Bucket | Limit | Why |
|---|---|---|
| `otp:<phone>` | 3 / 15 min | Each code is ~$0.47 of SMS; per-phone flood is a wallet attack |
| `otp:__global__` | 100 / min | A rotating-phone flood degrades to a shared budget, the 0015 M2 lesson |
| `otpv:<phone>` | 10 / min | Code guessing, on top of the 5-attempt per-challenge burn |
| `pin:<org>:<user>` | 5 / min | Existing (0015) — reused unchanged as the PIN lockout |

## Open questions for the app-side wave

1. **Send the token, not a JWT, from the scanner.** `current_org_id()` prefers
   `request.jwt.*` over `papa.*`; a request carrying both a JWT and a session
   header would speak as the JWT. Scanner traffic should carry only
   `x-papa-session`.
2. **Per-op actor in offline batches.** `submit_scan_batch` stamps the whole
   batch with the session's current user. A shared phone that switched users
   offline mid-queue needs either per-op actor attestation (PIN-signed
   locally) or a flush-on-switch rule in the outbox. Decide before the
   Capacitor build.
3. **Ambiguous-org UX**: `complete_enrolment` refuses multi-org phones without
   `org_slug` *before* consuming the code — the client should catch 22023 and
   re-submit with the chosen org.
4. **`enrol_verified_device` vs native OTP**: pick one transport for the pilot.
   The native path costs one Twilio integration; the Supabase path costs
   nothing now and is still vendor-free at the data layer.
5. **Schedule `run_maintenance()`** (it now prunes consumed/expired OTP
   challenges too) and decide who sees `revocations.wipe_local` on the device.
6. **`docs/assumptions.md` rows** (file owned by another wave): 60-day session
   lifetime; 3/15min OTP request budget; 4–6 digit PIN space.
