# A Liveness Guard For A Review's Kept Run Roots

`reclaim-scratch.mjs --pr <N>` evicts the installed trees in every
`pr<N>/run-*` root it keeps, however young. We don't add a grace window, a
recent-write check or a liveness marker that would let it skip a run root
whose review might still be running.

## Why this is out of scope

**The ledger already keeps a PR to one live review.** A PR has at most one
open review launch. A launch is settled `=failed` only after its runner is
confirmed dead, in the same call that launches the next review. Scratch
roots are keyed per checkout, like the ledger, so when a review's snapshot
step runs, every other run root of that PR belongs to a finished or dead
review.

**Covering a dead runner's root is the point of the pass.** A review evicts
its own run root when it ends. The `--pr` pass is what frees the root of a
runner that died before that. Any rule that skips young or recently written
roots skips exactly that root, and leaves its installed dependencies (about
1.2 GB per agent-brain tree) in place until the 7-day retention.

**Each guard is a new rule with no evidence behind it.** A grace window
needs an upper bound on how long a review runs. A pid marker fails because
the omp process outlives a killed runner. A heartbeat is a grace window
under another name.

**The one unguarded case is accepted.** A standalone `/review-and-fix`
writes no ledger token and shares the fleet's scratch root. If it runs
against the same PR at the same moment as another review, whichever review
started first loses its installed trees mid-run.

## What would reopen this

A review whose reported failures trace to an evicted install path in its
own snapshot or copy, or a second path, besides the standalone review, that
puts two live reviews in one PR's scratch directory.

## Prior requests

- #4335 — "reclaim-scratch --pr evicts the trees of a same-PR review that is still running" (deferred from the #4329 review)
