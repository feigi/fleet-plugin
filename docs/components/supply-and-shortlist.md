# Supply & Shortlist

## What it is for

Supply is the set of tickets the fleet is willing to look at, and the
Shortlist is the ordered list the controller actually admits from. No
human curates this list — admission is fully automatic
([ADR 0013](../adr/0013-automatic-supply-relabel-by-cause.md)).

## How it works
1. **Scan.** [`shortlist.mjs`](../../plugin/scripts/shortlist.mjs)
   scans every open `ready-for-agent` issue oldest-first via
   `candidates.mjs --require-label ready-for-agent` — that scanned
   count is **supply**.
2. **Filter**, failing closed at every step: drop a ticket whose
   dependency is an open blocker, whose ledger row reads a live
   `excluded · behind-pr:#M`/`behind-issue:#M` (lifted only once that
   PR/issue is `MERGED`/`CLOSED`), or whose `inflight.sh` probe finds it
   already claimed.
3. **Write.** Survivors are written atomically to `.fleet/shortlist.json`
   as `{scanned, shortlist: [{n, t}]}`. Exit 0 = written (an empty
   Shortlist included); exit 2 = refused, previous file untouched —
   never read a refusal as "empty."
4. **Refresh.** The controller builds the Shortlist once by hand at run
   start; after that,
   [`fleet-tick.mjs`](../../plugin/scripts/fleet-tick.mjs) refreshes it
   (`REFRESHED shortlist: <n> entries; <k> lifted`) whenever unclaimed
   entries fall below the implementer cap, the file is missing/empty,
   or an exclusion's premise has lifted — a low-water-mark refresh,
   never refill-on-empty.

**Shortlist** entries (no live `impl-` row, no live `excluded` row) are
what the tick prints as `unclaimed=`. A ticket
[Pull & Claim](pull-and-claim.md) can't admit is relabelled by cause and
leaves the Shortlist without ever being deleted from GitHub's own queue.

## Opinionated choices

- **Admission is never batched.** One scan orders the whole queue
  oldest-first, but each ticket is judged and admitted one at a time as
  a slot frees — the old batched model left implementer slots idle
  87–91% of wall time
  ([ADR 0013](../adr/0013-automatic-supply-relabel-by-cause.md)).
- **`ready-for-human` work is never touched.** There is no channel back
  to a human mid-run, so a ticket that needs one is relabelled and
  left, not queued.
- **Every probe fails closed.** A guard that fails open on "could not
  look" protects nothing, so an unreadable dependency, exclusion, or
  in-flight check is always treated as the more conservative answer.
