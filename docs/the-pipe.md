# The pipe — how the phone talks to the server

Until W9 every feature ran on the local demo store and the server was
proven by pgTAP; the two had never met. This page is the seam between them:
what goes over the wire, in which header, under which rules, and how the
proof runs. The code is the law; this page is the map.

| Piece | Where |
|---|---|
| Transport (fetch only) | `packages/core/src/transport/postgrest.ts` |
| Dispatcher rules: id map, re-key, reply rules | `packages/core/src/dispatch.ts` |
| The flush, segmented | `packages/core/src/sync.ts` |
| The loop: pull → apply → flush | `packages/core/src/engine.ts` (`SyncLoop`) |
| Auth on the phone | `packages/core/src/auth.ts` |
| Upload seam | `packages/core/src/upload.ts` |
| On-device migration | `packages/core/src/db/migrate.ts` |
| Server: members mirror, `replay_op` | `db/migrations/0027_members_sync.sql` |
| Server: the doors the money book and the walk-in needed, the org mirror | `db/migrations/0028_every_write_crosses.sql` |
| The chain on the phone: `lastOpNaming` / `enqueueOp` / `APP_REKEY_COLUMNS` | `apps/app/src/demo/ops.ts` |
| The proof | `db/pipe-up.sh`, `apps/app/test/pipe/pipe.pipe.mjs` |

## Headers

Every call is `POST ${baseUrl}/rpc/<name>` with a JSON body of **named**
arguments (`p_*`). Three headers:

| Header | Value | Why |
|---|---|---|
| `content-type` | `application/json` | PostgREST's RPC body |
| `x-papa-session` | the 64-hex device-session token | 0016's `auth_pre_request` reads it and sets `papa.org_id / user_id / device_id / session_id` for the transaction. **Never a JWT** — a request carrying both speaks as the JWT (auth-design, open question 1) |
| `apikey` | only when a Supabase-style gateway wants one | plain PostgREST needs none |

No header before enrolment; `complete_enrolment` is the one anonymous call
the phone makes. `request_otp` is never called from the phone — it is
`papa_auth`'s, and the Enrol screen says "ask the owner to send you a code"
(the SMS transport is hosting-specific: an edge function or a cron calling
`request_otp` as `papa_auth` and sending the SMS. Documented, not built.)

## The error rule

The flush parks an op only on a **verdict** and backs off on everything
else, so the transport's job is to tell those apart honestly:

- fetch threw, timeout, 5xx with no Postgres code, 429, 408 → **retryable**;
- a Postgres SQLSTATE in the body → its **class** decides: `08`, `53`
  (53300 is the DB's own rate limiter: "wait"), `57`, `58`, `XX` are
  retryable; everything else — `23P01` the collision, `28000` the dead
  session, `42501` the role refusal, `P0001` a raised rule, `22023` bad
  arguments — is a verdict;
- the SQLSTATE rides as `code`, the server's message as `message`, and a
  `client_seq` named in details/message as `clientSeq` so the flush parks
  exactly the op the server named.

Pinned in `packages/core/test/transport.test.mjs`.

## Two kinds of op, one order

The outbox holds **scan-kind** ops (`submit_scan_batch`, and `void_scan`)
and **everything else** (`create_booking`, `upsert_partner_house`,
`record_sub_hire_in`, `bind_tag`, …). A flush takes the next batch in seq
order and cuts it into segments:

- a run of scan-kind ops → **one** `submit_scan_batch` call, all-or-nothing,
  bisected on a verdict to park exactly the poison op (unchanged from
  before the pipe);
- each other op → **one** `replay_op` call.

Strictly in seq, because a check_out of a borrowed unit must never reach
the server before the `record_sub_hire_in` that creates the unit. A
retryable error stops the flush; later segments wait their turn behind the
backing-off head.

`void_scan` crosses as a **correction**: the voided op's own event type,
`corrects_event_id` = the voided outbox id (which *is* its server event id —
`submit_scan_batch` uses the op's `id`), `entry_method = 'manual'`. The
server's projection rebuilds without either event; CONTRIBUTING's
"corrections point forward" holds on both sides.

## Exactly once — `replay_op` (0027)

`submit_scan_batch` is idempotent per `(device, client_seq)`. Nothing else
was. A pencil placed offline, a reply lost in a tunnel, a retry — and the
same camera is booked twice with two numbers.

`replay_op(p_op_id, p_rpc, p_args)` runs the named public RPC **once per
(device, outbox id)** and files the reply in `op_receipts`. A retry is
answered from the receipt with the **original** reply and `duplicate:
true`. It is `SECURITY INVOKER`: the inner RPC runs as the caller with the
caller's `papa.*` context, so every role gate and RLS policy holds as if
the phone had called it directly, and a raised error rolls the receipt
back with everything else. Receipts are visible and writable only to the
device that made them (RLS on org + device). Arguments are bound **by
name and typed from `pg_proc`** (jsonb passes through, arrays are
unpacked, everything else is `->>` then a cast), so a new RPC needs no
wrapper. `replay_op` refuses itself, the scan and pull entry points, and
every auth function — a session cannot be minted through a receipt.

## Id mapping

The server mints its own ids. The phone cannot wait, so:

1. The write side mints a **prefixed** id (`bk-…`, `job-…`, `sh-…`,
   `asset-…`, `card-…`, `cal-…`), writes the mirror optimistically, and
   rides the id beside the RPC args as `client_*`.
2. The dispatcher strips `client_*` keys, rewrites every string in the
   args that `id_map` knows (deep — inside `p_lines` too), and sends.
3. The reply names the real id; `ID_REPLY_RULES` says which reply field
   answers which client key (`create_booking.booking_id ↔
   client_booking_id`, `convert_booking_to_job` scalar ↔ `client_job_id`,
   `record_sub_hire_in.{sub_hire_id, asset_id, expense_id}`, …).
4. In the ack's transaction the pair is recorded in `id_map` and the local
   rows are **re-keyed** to the server's name (`REKEY_COLUMNS` in core; the
   app adds its own tables through `SyncEngine`'s `rekeyColumns`). From
   then on the phone and the server call the thing by one name.
   Scan ops are rewritten too: a check_out of a borrowed unit names the
   server's asset id by the time it goes.
5. **A guess is a prefix.** Child rows the phone authored beside the op
   (a pencil's lines and claims — `bl-`, `ar-`, `sr-`; a rate — `rce-`)
   get no reply mapping. When the server's rows for that parent arrive,
   the pull deletes the prefixed rows for the same parent and keeps the
   server's (bare uuids are never touched). The loop pulls once more right
   after any mapping lands, so the window is one round trip.

`lastBookingOp` / `lastOpNaming` look under both names, so a dependency
chain queued across a rename stays one chain.

ASSUMPTION `#server-name-wins`: the phone adopts the server's id the moment
the server accepts.

## What crosses (W11)

Until W11 the money book, the walk-in job, the customer and the due date
were written to the mirror alone. Every store write was audited and
classified: (a) already queues an op, (b) local by design, (c) local by
omission — and every (c) now queues an op named after the server's RPC,
its payload the RPC's own `p_*` arguments, the phone's id beside them as
`client_*`, chained behind the op that mints what it names
(`apps/app/src/demo/ops.ts`). Four doors the server did not have are 0028's.

| Write (phone) | Op | RPC (migration) | Id the phone mints → reply field | Chained behind |
|---|---|---|---|---|
| `createCustomer` (khata.ts) | `create_customer` | `create_customer` (0028) | `cust-…` → `id` | — |
| `recordEntry` kind `payment` | `record_payment` | `record_payment` (0017) | `led-…` → `id` | the customer's op, the job's op |
| `recordEntry` charge / late_fee / damage_charge / write_off / adjustment / reversal | `record_ledger_entry` | `record_ledger_entry` (0018, with `p_reversal_of`) | `led-…` → `id` | the customer's, the job's, the line reversed |
| `recordEntry` deposit kinds | — | hold/apply/refund_deposit (0017) | — | no phone door yet (`no-deposit-door`); only the seed writes them |
| `recordExpense` (kharcha.ts) | `record_expense` | `record_expense` (0024 shape: `p_spent_at`, `p_booking_id`) | `exp-…` → `id` | the job's, the booking's, the unit's op |
| `reverseExpense` | `reverse_expense` | `reverse_expense` (0024) | `exp-…` (the reversal row) → `id` | the expense's op |
| `recordServiced` with a cost (store.ts) | `record_expense` **then** the `serviced` scan | `record_expense`, `submit_scan_batch` | the scan's `payload.expense_id` is rewritten to the server's | the scan depends on the expense op |
| `createJob` from the desk (`createJobFromLines`) | `create_job` | `create_job` (0028) | `job-…` → `id` | the customer's op |
| `createJob` inside convert / lend-out | — | `convert_booking_to_job`, `record_sub_hire_out` mint the job | reply `$` / `job_id` | (already crossed) |
| `closeJob` / `reopenJob` | `close_job` / `reopen_job` | 0018 | — | the job's last op |
| `setExpectedBack` | `set_job_expected_back` | `set_job_expected_back` (0028) | — | the job's last op |
| `noteSubRent` (the sub-rent intent) | `set_booking_note` (`p_append: true`) | `set_booking_note` (0028) | — | the booking's last op; the extension chains behind it |
| `recordSubHireIn` with a cost | `record_sub_hire_in` only | 0025 | `sh-…`, `asset-…`, `exp-…` → the reply's three ids | the local expense carries `booking_id` and queues **no** `record_expense` |
| `recordSubHireOut` | `record_sub_hire_out` only | 0025 | `sh-…`, `job-…`, `cust-…`, `led-…` | the local job, customer and charge queue **no** ops of their own |
| `ensurePartnerCustomer` | — | `ensure_partner_customer` inside 0025 | `cust-…` → `customer_id` | (the lend-out's op) |
| bookings, rates, calendar, partners, crew, scans, tags, terminal/found/swap | (W5–W9, unchanged) | | | |
| `recordTurnedAway` (demand_log) | — | **no server table** | | local by omission: noted, not built (ASSUMPTION `#local-only-writes`) |
| photo / voice note metadata | — | the upload seam (`upload.ts`) is hosting-specific; no metadata RPC | | left, noted |
| payment line / QR, language, the demo staff roster, `job_expected` (the promised set), `job_meta` | — | local by design | | |

The app's own tables re-key by the same rule as the mirrors
(`APP_REKEY_COLUMNS`): a ledger line, an expense, a customer and every
row pointing at one take the server's name in the ack's transaction.
`job_margin` on both sides (kharcha.ts; 0028's second edition of the
view) counts a bill tagged to the booking a job was born from — the
vendor borrows at the enquiry and tags the pencil; the job the pencil
becomes sees it (was the year's wall `subhire-cost-unlinkable`).

Known gap, on purpose: `record_ledger_entry` has no timestamp argument, so
a backdated ledger line is stamped with the server's clock on the server
(ASSUMPTION `#ledger-server-time`); `record_expense` takes `p_spent_at`
and is backdated faithfully.

## The poison rule

A verdict on an op parks it **and its entire `depends_on` closure**
(`Outbox.fail`, the DAG rule). The UI shows **one card** per refusal —
`DemoStore.attentionCards()` folds `blocked_by_dependency` rows under their
root — wearing the server's own message ("asset FX9-02 is already promised
to booking #7"), with the count of ops parked behind it. A network failure
never parks anything: it backs off, and the attempt count is a diagnostic.

Dismissing a card deletes the failed subtree; the server never took those
rows, so nothing on it changes.

## Auth on the phone

- `enrol` → `complete_enrolment`; the once-returned token lives in
  `sync_meta.session_token` (SQLCipher at rest is the device-driver wave;
  the browser build keeps it in memory and Settings says so). A null token
  is "bad code" — one face for wrong code and unknown phone. `22023` "more
  than one organisation" is told apart so the screen can ask which house.
- `pinSwitch` → `switch_session_user` (server-verified; the 5/min lockout
  lives there). Offline, the phone checks the **echo** — `sha256(device :
  user : pin)` kept after every server-verified PIN — and says so.
  ASSUMPTION `#pin-echo`.
- The PIN gate shows on open when a session exists and the last holder has
  a PIN (`members.has_pin`, from the 0027 mirror).
- `signOut` is refused while the outbox holds anything (principle 3), needs
  the server (`sign_out_device`), then forgets the org — mirrors, map,
  session — keeping only the device id.

## Migration versioning (on device)

`sync_meta.schema_version` names what the database has. Absent on an empty
database = fresh install: `LOCAL_SCHEMA` in one go, stamped
`LOCAL_SCHEMA_VERSION`. Absent on a database with tables = **version 1**,
the pre-0018 shape. `LOCAL_MIGRATIONS` is the ordered ladder (2: 0018
columns · 3: disposition · 4: the meters and voice notes · 5: bookings ·
6: rates · 7: the network · 8: `id_map` and `members` · 9: the `org`
mirror); each step runs in
its own transaction and stamps inside it; add-column statements are skipped
when the column exists, so an interrupted step finishes on the next open.
`packages/core/test/migrate.test.mjs` migrates a v1 snapshot with queued
rows and asserts every table's column set equals a fresh install's — the
ladder and the schema cannot drift.

## The PostgREST contract

See `docs/hosting-decision.md`, "The PostgREST contract". In one line:
`db-anon-role = papa_app`, `db-pre-request = public.auth_pre_request`,
`db-schemas = public`, no JWT secret; PostgREST connects as
`papa_authenticator` (LOGIN, `noinherit`, granted `papa_app`) and switches
role per request.

## The local proof

```
npm run test:pipe          # db/pipe-test.sh: up → ten scenarios → down
KEEP=1 npm run test:pipe   # leave the containers up
npm run pipe:up / pipe:down
```

`db/pipe-up.sh` starts `postgres:16` and `postgrest/postgrest:v12.2.3` on a
user-defined network (podman or docker), migrates with `db/migrate.sh`
**inside** the container (the deploy runner, not a parallel path), seeds
`db/pipe-fixtures.sql` (one house, four people, three units with labels,
one job, the authenticator role), and waits for PostgREST's root to answer.
Ports 55450 (Postgres) and 3050 (PostgREST); names and ports are
overridable (`PAPA_PIPE_PG`, `PAPA_PIPE_REST`, `PAPA_PIPE_NET`,
`PAPA_PIPE_PG_PORT`, `PAPA_PIPE_REST_PORT`) so two checkouts can run side
by side.

`apps/app/test/pipe/pipe.pipe.mjs` then drives two phone-side databases
(node:sqlite, the app's own tables) through the real transport:

1. enrol (the harness mints the OTP as `papa_auth` through `psql`);
   a wrong code is a null token;
2. pull the fleet — assets, tags, products, the job, the members mirror
   (and prove the mirror carries no phone column);
3. scan out offline → flush → the event row is on the server, stamped with
   the **session's** user → the projection agrees → pull → the mirror
   agrees, on both phones;
4. pencil offline → `replay_op` → the server's id replaces the phone's,
   the server's line replaces the guessed one → confirm → convert → the
   server's `jobs` row carries `booking_id`, the local job wears the
   server's id;
5. two phones confirm the same unit: the loser's `confirm_booking` parks
   with `23P01` and the server's message, its `convert` behind it as one
   card; the server holds one confirmed claim and one job;
6. the fetch stub lets the server commit then throws: five scans stay
   queued (nothing lost, nothing parked), the retry is acked as five
   duplicates, the server holds **exactly** five rows;
7. (W11) a charge and a payment recorded offline land as ledger rows
   stamped with the session's user; `customer_balances` on the server
   equals the phone's projection to the rupee; the local rows wear the
   server's ids;
8. a customer typed at the sheet and a walk-in job created offline,
   scanned out and back, closed offline → `create_customer`, `create_job`,
   two scans and `close_job` cross in seq; the server's job is closed on
   its customer and the scan rows name the **server's** job id;
9. an expense and its reversal cross; the reversal names the server's id
   for the row it voids; `job_margin` on the server equals the phone's;
10. the owner's phone borrows a body against a pencil (the bill tagged to
    the booking, no expense op of its own), confirms, converts → the
    server's `job_margin` reads the bill through `jobs.booking_id`, and
    so does the phone's under the server's name.

CI runs it as its own `pipe` job on `ubuntu-latest` with docker.
