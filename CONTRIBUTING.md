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

## Assumptions

The research is explicit that several things are unsourceable and only answerable in the field: deposit norms, the pencil/challenge hold convention, cash-vs-digital split, whether COI-equivalent insurance exists in this market at all.

Where you build to a guess, mark it in code:

```ts
// ASSUMPTION: 24h default hold TTL. Unvalidated — no primary source found for
// Lahore pencil/challenge conventions. See docs/assumptions.md#hold-ttl
```

…and add a row to `docs/assumptions.md`. The vendor review at the end should be a checklist, not a scavenger hunt.
