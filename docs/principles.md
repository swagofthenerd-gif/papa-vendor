# The five steadiness principles

The four principles in [`CONTRIBUTING.md`](../CONTRIBUTING.md) govern the scan
loop — the seconds. These five govern the system — the years. They exist to
keep the app *steady*: trustworthy under concurrency, under bad networks,
under staff turnover, under its own growth. Each one is stated, then grounded
in a real defect found in this codebase during the 2026-09-02 multi-lens
review. None of them is hypothetical.

---

## 1. Nothing changes state without leaving evidence

Every fact the app displays — where a camera is, whether it's healthy, who
has it — must be derivable from the append-only event log. If code can
mutate a projection without an event row existing first, the system's core
promise ("the log is the truth") is broken, even if nobody ever exploits it.

*Found violated:* `apply_scan_event` was executable directly by any app user
with a hand-built event value — projections could be forged with no log row.
The audit trail looked intact while lying. Fixed in migration 0015.

**The test:** for any state-changing path, ask "what row proves this
happened?" If the answer is "none", the path is a bug, not a feature.

## 2. The phone is a witness, not a judge

Devices report what they saw — tag codes, timestamps, sequence numbers.
The server decides what those reports *mean*: who the actor is, what time it
really is, which device is speaking, which org owns the rows. Any place the
server takes a client-supplied claim as authority (an org id, a device id, a
role, a foreign key into someone else's tenant) is a hole, whether or not
today's client is honest.

*Found violated:* `submit_scan_batch` accepted any `device_id` string, so one
org member could speak as another's device and burn its idempotency slots —
causing the *real* device's queued scans to be silently discarded as
duplicates. Cross-org foreign keys were also accepted. Fixed in 0015.

**The test:** for every RPC parameter, ask "does the server verify this, or
believe it?" Believe only what cannot matter.

## 3. A scan, once captured, is never lost — only delayed

Sync may be slow, late, retried, or degraded. It may never silently drop
data, in either direction: a queued write must survive any network weather
until the server has provably accepted it, and a committed server row must
reach every device's cursor eventually. "Parked and flagged" is acceptable;
"gone and quiet" never is. This generalises the existing photo rule
(never evict an un-uploaded photo) to every byte of evidence.

*Found violated twice:* (a) the pull cursor could permanently skip a row
committed out of sequence order — a device would simply never learn about an
asset, with no error anywhere; (b) forty minutes of captive-portal Wi-Fi
inflated retry counts until fifty good scans were permanently parked as
"needs attention". Both fixed (0015 settle-lag horizon; retry semantics in
`packages/core`).

**The test:** kill the network, kill the app, replay everything twice —
count the rows. The count must be exactly right.

## 4. Every rule has exactly one home

A business rule implemented twice will drift, and the drift will surface as
two screens disagreeing about the same camera — which is how staff stop
trusting the numbers, which is the adoption cliff. Presence/health buckets,
payload shapes, ordering rules, feedback vocabulary: each lives in one
importable place (`packages/core` for anything both surfaces need), and
everything else calls it. Deliberate exceptions (the unrolled sync blocks)
are documented at the site with the measured reason.

*Found violated:* the status-bucket rule existed in three independent copies
(`status.ts`, inline in `Gear.tsx`, and as SQL strings in the demo store) —
one future status value away from the Gear list and the Today board
disagreeing. Consolidated.

**The test:** grep for the rule. One definition, many imports.

## 5. A guarantee is only real if a machine checks it

Documentation rots; reviewers miss things; the next contributor may be an AI
with no memory of why. Every invariant this system depends on — tenant
isolation, append-only history, PII never syncing, no double-booking,
"assumed items are never dispute evidence" — must be enforced by a
structural guard (a constraint, a trigger, a revoked grant, a failing test),
not by a paragraph. When a review finds a bug, the fix ships with the test
that would have caught it; the test is the durable part.

*Found violated:* the PII guard matched exact column names only, so
`jobs.contact` — a phone number — was quietly syncing to every warehouse
phone while the guard reported clean. The guard now pattern-matches, and the
column no longer syncs. Fixed in 0015.

**The test:** for each promise in the README, point to the constraint, grant,
or test that makes it true without human vigilance. If you can only point to
prose, the promise is unguarded.

---

## How to use these

Before merging anything, walk the five: *Does state change without
evidence? Does the server believe the phone? Can data be lost rather than
delayed? Does a rule now live in two places? Is any new promise guarded only
by prose?* Five noes and the app stays steady.
