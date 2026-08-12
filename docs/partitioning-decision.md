# Partitioning `scan_events`

**Status: analysed, not implemented. One decision needed before code.**

`docs/production-readiness.md` now lists `scan_events` growth as the leading
technical risk: append-only, never pruned, ~1.5bn rows/year at 10k orgs, and
partitioning after the fact is painful.

The obvious move is monthly range partitioning on `server_time`. It breaks
three things, and one of them is a correctness guarantee rather than an
inconvenience.

---

## What partitioning breaks

Postgres requires every unique constraint on a partitioned table to **include
all partitioning columns**. Verified directly rather than taken from the docs:

```
ERROR:  unique constraint on partitioned table must include all partitioning columns
DETAIL:  UNIQUE constraint on table "e" lacks column "server_time"
         which is part of the partition key.
```

Three consequences:

### 1. The idempotency constraint — the one that matters

```sql
constraint scan_events_device_seq_unique unique (device_id, client_seq)
```

It would have to become `(device_id, client_seq, server_time)`, which permits
**the same `(device_id, client_seq)` in two different months**. That is not a
technicality: it is exactly the guarantee `submit_scan_batch` relies on to make
a retry a no-op, and 0003 calls it non-negotiable because flaky mobile networks
produce that case daily.

The failure is silent and it corrupts inventory. A batch that times out at
23:59 on the 31st and retries at 00:01 on the 1st would be accepted as new,
double-applying a `check_out`.

There is a second, quieter cost. The idempotency lookup in `submit_scan_batch`
carries no time predicate:

```sql
select id into v_existing from scan_events
 where device_id = p_device_id and client_seq = v_seq;
```

Against a partitioned table with no prunable predicate that probes **every
partition** — a growing cost on the hot write path, forever.

### 2. The primary key

`id uuid primary key` becomes `(id, server_time)`. Uniqueness of `id` alone is
no longer enforced by the database, and `id` is client-generated on a phone.

### 3. The self-referencing foreign keys

`corrects_event_id` and `implied_by_event_id` both reference
`scan_events(id)`. A foreign key needs a unique constraint on exactly the
referenced columns, and after (2) there isn't one:

```
ERROR:  there is no unique constraint matching given keys for referenced table "e3"
```

Both FKs have to be dropped. A correction pointing at an event that does not
exist becomes possible, in the table whose entire purpose is being evidence.

---

## The option that looked cheapest, and why it is wrong

**Replace the unique constraint with a per-device high-water mark** —
`devices.last_client_seq`, reject anything at or below it. O(1), no second
table, no cross-partition probe, and it reads as obviously correct given that
`client_seq` is monotonic per device and `submit_scan_batch` already applies
batches in `client_seq` order.

**It is unsafe, and `packages/core/src/outbox.ts` is where that shows.**

`MAX_ATTEMPTS = 8`, after which an op is **parked** (`state = 'failed'`) rather
than retried — deliberately, because "a single bad row must never freeze a
warehouse's entire sync". `nextBatch` selects only `pending` and `inflight`
rows. So a parked op is stepped over while later sequence numbers are sent:

> seq 5 parks · seqs 6 and 7 send and are accepted · the tech later retries the
> parked op from the "needs attention" list · **seq 5 arrives after seq 7**

Under a high-water mark, seq 5 is silently discarded as a duplicate. That is
precisely the failure `outbox.ts` already warns about in another context — *"the
scans would be silently dropped and the tech would never know."*

**Gaps and out-of-order arrival are not edge cases here; they are a designed
behaviour of the queue.** Any idempotency scheme that assumes monotonic arrival
is incompatible with the outbox we deliberately built.

---

## Recommended shape

**Partition `scan_events` by month on `server_time`, and move idempotency into
its own unpartitioned table.**

```sql
create table scan_event_receipts (
  device_id  text   not null references devices(id) on delete restrict,
  client_seq bigint not null,
  event_id   uuid   not null,
  org_id     uuid   not null references orgs(id) on delete restrict,
  primary key (device_id, client_seq)
);
```

- **Idempotency stays exact and global**, independent of partition boundaries.
- **It stays exact under gaps and out-of-order arrival**, which the high-water
  mark cannot do.
- `submit_scan_batch` keeps returning the original `event_id` for a
  `duplicate`, which the device needs to retire the right outbox row.
- The lookup gets **faster than today** — a narrow two-column index instead of
  a probe across every partition.

Costs, stated plainly:

- A second row per event. Narrow (~60 bytes against the event row's hundreds),
  but it is still 1.5bn rows/year and it does not partition away. A retention
  window is possible — a retry older than 90 days is not a real scenario — but
  pruning reintroduces exactly the risk this table exists to remove, so it
  should not be pruned without a decision of its own.
- The self-FKs still have to go. Replaced with a deferred trigger check, or
  accepted as unenforced and validated in the projection.

### What must NOT be done

Partition by `effective_time`. It is the clamped **device** clock, so a phone
with a wrong date writes into the wrong partition, and a partition key that
untrusted input can steer is a partition key that will eventually route rows
somewhere nobody looks. `server_time` is assigned by the server at insert.

---

## The decision needed

1. **Confirm the receipts table**, accepting a second narrow row per event as
   the price of exact idempotency — or say that a retention window on receipts
   is acceptable, and how long.
2. **Decide the self-FK replacement**: deferred trigger check (safer, more
   machinery) or unenforced with validation in the projection (simpler, and a
   dangling `corrects_event_id` becomes possible).

Neither is reversible cheaply once 1.5bn rows exist, which is the reason this
document exists instead of a migration.
