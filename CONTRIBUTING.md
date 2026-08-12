# Contributing to Papa Vendor

Read this before writing any code. These are not style preferences — each one exists because breaking it produces wrong inventory, lost gear, or an app people stop using.

## The four principles

**1. Smooth means never blocking a human on a network round-trip during physical work.**
There is no `await` in the scan handler. Ever. Decode → local SQLite → optimistic insert → render. The network is a background process the user never waits on. Any architecture where a scan waits on HTTP has already failed, regardless of how fast the server is.

**2. If an operation asserts a fact about the physical past, it works offline. If it promises the future or allocates a scarce resource, it needs the server.**
This single rule settles almost every offline question. Check-out is a past fact — offline. Confirming a booking allocates a scarce camera to a customer in writing — server. When you're unsure whether something can work offline, ask which of the two it is.

**3. Physical-reality events never fail; they raise alerts.**
The scanner has no rejections, only annotations. The truck is already leaving; reality outranks the schedule. Schedule-intent events (confirming a future booking) *do* fail, loudly.

**4. Zero *network* in the scan handler — but never zero *local* checks.**
The device already knows this camera is checked out to a different job. Warn instantly from local data, require a reason, and still record the scan. Telling only the desk is not enough: at 06:14 the desk is closed and two trucks leave.

## Hard rules

- **All writes go through server RPC functions.** Never direct table writes from a client, even where the client library makes it easy. This is what keeps the phone from being trusted, and it is what makes the read-sync layer a contained swap later.
- **`scan_events` is INSERT-only.** No UPDATE, no DELETE, no exceptions, no "just for the manager role". Corrections point **forward** — the new row carries `corrects_event_id`; supersession is derived at read time. Anything that requires updating an existing event row is a design error, not a grant to add.
- **The outbox is a DAG. Failure poisons the subtree, never just the node.** Marking an op failed marks its entire `depends_on` descendant closure failed, surfaced as *one* "needs attention" card.
- **Any state transition triggered by the passage of time must be derivable locally from stored timestamps**, never only from a server cron job. Hold expiry and overdue are computed client-side at render. Otherwise an offline device confidently displays lies.
- **Never evict an un-uploaded photo.** When the cache fills, block new capture with an explicit message. A blocked capture is recoverable; a deleted photo is evidence destroyed.
- **Every alert type declares an owner role, a severity, and a delivery channel in the same migration that creates it.** An alert with no delivery channel is a log line.
- **Every tenant table carries `org_id` as the first column of every index**, with an RLS policy and a matching sync rule. A table without both fails the build.
- **No emoji in the DOM.** Inherited from Papa Rentals, with a test that enforces it. Use the icon package.
- **No destructive action is adjacent to a frequent action on the scanner.** Glove mis-taps are adjacency failures, not size failures. Destructive actions live behind a swipe or a hold, never a tap.

## Document precedence

1. **`docs/PLAN.md`** — authoritative. Its "What overrides the architecture document" section supersedes anything below it.
2. **`docs/architecture.md`** — the detailed technical reference (schema DDL, sync design, the full conflict enumeration). **Twenty of its decisions are overridden by PLAN.md.** Read PLAN.md's override table before implementing anything from here.
3. **`docs/research-pain-points.md`** — the sourced evidence base. When a design decision is questioned, the answer is usually already in here with a URL.
4. **`docs/assumptions.md`** — every guess made in the absence of field data, to be walked with the pilot vendor at the end.
5. **`docs/hosting-decision.md`** — where this runs and why, with the decision triggers that should cause a change. Backed by `docs/research/`.
6. **`docs/production-readiness.md`** — the honest gap list between here and running a business.


## Staying portable

The database layer is **plain Postgres**, not Supabase — one extension, a
hand-written UUIDv7, identity read from `current_setting()` with a vendor-free
fallback. Moving to RDS, Aurora, Cloud SQL or Neon is **1–2 days** of work.

That is worth real money: it means the hosting decision is reversible, so it can
be made cheaply now and revisited with evidence later, instead of being agonised
over before there is a single customer. **These rules are what keep it true.**

- **Never write a foreign key from `users.id` to an auth provider's table.**
  Own the `users` row; keep a nullable `external_auth_id` if you need the link.
- **Never let a vendor SDK become the data layer.** No `supabase-js` (or
  equivalent) issuing queries. All writes go through RPCs; reads go through the
  sync path.
- **Never call `auth.uid()` — or any vendor identity function — in a policy or
  function body.** Read identity only from `current_org_id()` /
  `current_user_id()`, which already carry the `papa.*` fallback that every test
  uses.
- **CI stays on stock `postgres:16`.** A test that requires a hosted vendor to
  pass is a failing build. `db/run-tests.sh` is a continuous portability
  regression test and it is the most valuable thing protecting this.
- **Store opaque storage keys, never vendor-signed URLs.** A signed URL embeds
  the vendor in your data.
- **Keep any scheduled-job body to a single `SELECT some_function();`** so the
  scheduler is replaceable.
- **No new extensions without a written decision** recording what it buys and
  which hosts support it.

> **The one-way door: letting the identity model live in the vendor.** Do that
> and migration stops being a data move and becomes re-authenticating every user
> and every device in the field — on offline phones, in warehouses, at 6am.
> Nothing else in this codebase comes close to that cost.

### RLS policies: wrap function calls

Write `using (org_id = (select current_org_id()))`, never
`using (org_id = current_org_id())`. The wrapped form is hoisted into an
InitPlan and evaluated **once per query**; the inline form runs **once per
row**. Measured on a single org with 200k assets: **90ms → 13ms**. Enforced by
`db/tests/0008_rls_initplan_test.sql`.

## Assumptions

The research is explicit that several things are unsourceable and only answerable in the field: deposit norms, the pencil/challenge hold convention, cash-vs-digital split, whether COI-equivalent insurance exists in this market at all.

Where you build to a guess, mark it in code:

```ts
// ASSUMPTION: 24h default hold TTL. Unvalidated — no primary source found for
// Lahore pencil/challenge conventions. See docs/assumptions.md#hold-ttl
```

…and add a row to `docs/assumptions.md`. The vendor review at the end should be a checklist, not a scavenger hunt.
