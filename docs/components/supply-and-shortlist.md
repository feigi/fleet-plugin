# Supply & Shortlist

## What it is for

Supply is the set of tickets the fleet is willing to look at, and the
Shortlist is the ordered list the controller actually admits from.
Together they answer one question before anything else runs: which
open issue does the next free implementer slot get? No human curates
this list — admission is fully automatic
([ADR 0013](../adr/0013-automatic-supply-relabel-by-cause.md)).

## How it works

`~/.fleet/bin/fleet-run shortlist.mjs`
([`plugin/scripts/shortlist.mjs`](../../plugin/scripts/shortlist.mjs))
scans every open issue labelled `ready-for-agent` oldest-first via
`candidates.mjs --require-label ready-for-agent` — that scanned count is
**supply** — then drops a ticket whose declared dependency (its `d`
array) is still an open blocker, whose ledger row still reads a live
`excluded · behind-pr:#M`/`behind-issue:#M` (lifted only once that
PR/issue is `MERGED`/`CLOSED`), or whose `inflight.sh` probe finds it
already claimed. Every probe fails closed: an unreadable blocker reads as
open, an unanswerable exclusion stands, an unanswerable in-flight check
reads as taken. The survivors are written atomically to
`.fleet/shortlist.json` as `{scanned, shortlist: [{n, t}]}`; exit 0 means
the file was written (an empty Shortlist included), exit 2 means the
write was refused and the previous file is untouched — never read a
refusal as "empty." The controller builds the Shortlist once by hand at
run start (a dead run's file is stale by definition); after that,
[`fleet-tick.mjs`](../../plugin/scripts/fleet-tick.mjs) refreshes it
itself, printing `REFRESHED shortlist: <n> entries; <k> lifted`, whenever
unclaimed entries fall below the implementer cap, the file is missing or
empty, or an exclusion's premise has lifted — a low-water-mark refresh,
never a refill-on-empty one. **Shortlist** entries (no live `impl-` row,
no live `excluded` row) are what the tick prints as `unclaimed=`; a
shortlist entry a Pull hasn't yet judged still counts as supply. A ticket
[Pull & Claim](pull-and-claim.md) can't admit is relabelled by cause and
leaves the Shortlist without ever being deleted from GitHub's own queue.

## Opinionated choices

Batching is confined to *scanning*; admission is never batched. One scan
orders the whole queue oldest-first, but each ticket is judged and
admitted (or not) one at a time as a slot frees — the old model staged a
whole batch behind one maintainer decision, and measurement showed that
decision, not a lack of supply, was what left implementer slots idle
87–91% of wall time ([ADR 0013](../adr/0013-automatic-supply-relabel-by-cause.md),
[`docs/specs/2026-09-24-slot-based-fleet-loop-design.md`](../specs/2026-09-24-slot-based-fleet-loop-design.md)).
The fleet never touches `ready-for-human` work — there is no channel back
to a human mid-run, so a ticket that needs one is relabelled and left,
not queued. Every probe here fails closed on principle: a guard that
fails open on "could not look" protects nothing, so an unreadable
dependency, exclusion, or in-flight check is always treated as the more
conservative answer rather than skipped.
