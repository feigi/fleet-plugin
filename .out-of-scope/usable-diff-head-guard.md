# usableDiff Head Guard

`review-core.mjs`'s `usableDiff(snap)` returns the captured diff's path whenever
`diffPath` and `diffLines` are present. It does not compare `head` with `refHead`:
`snapshotMissing` owns that compare, and `runReview` throws on its reason. Two
proposals to make `usableDiff` guard itself against a head/refHead-skewed snapshot
are refused:

- **A head check inside `usableDiff`.** This re-adds the second copy of the head
  compare that #1132 deleted.
- **A runtime admission token or call-order assert.** For example, `snapshotMissing`
  returns a token that `usableDiff` requires, or `runReview` asserts that
  `snapshotMissing` ran first for this snapshot.

## Why this is out of scope

The call order is not where the hazard is. `runReview` throws on
`snapshotMissing`'s reason, and that throw comes before every use of `usableDiff`:
the diff log line and both prompt renders (specialist and refuter). The snapshot
agent is the only dispatch that runs before the throw. If the `snapshotMissing`
call and the `usableDiff` call were swapped, the run would still throw before any
specialist was dispatched, and only a log line would change.

A skewed diff can reach a specialist in only two ways:

- the refusal stops being fatal, because the `throw` is removed or softened, or
  the `refHead` clause is dropped from `snapshotMissing`;
- a new caller of `usableDiff` runs outside `runReview`.

The first is covered by a behavioural test in
`review-core-snapshot-path.test.mjs`. It drives the real `runReview` with a skewed
snapshot. It asserts that the run rejects, names both shas, and dispatches no
`review:*` or `verify:*` agent. A control with matching heads dispatches the
specialist once. Deleting the throw, deleting the `refHead` clause, or replacing
the throw with a log line each turns that test red. Swapping the two calls leaves
it green, and that swap is harmless.

The second is handled by documentation: the comment in `usableDiff` states the
precondition, that the snapshot must already be admitted by `snapshotMissing`.

Each refused remedy costs more than it buys:

- A head check in `usableDiff` duplicates the compare. The two copies can then
  drift apart, which is the reason #1132 removed the second one. #1132's ruling
  already decided this point.
- An admission token changes `snapshotMissing`'s contract (it returns a reason
  string or `null`). It also couples the pure `usableDiff` to that contract.
- A call-order assert in `runReview` guards the order, and the order is harmless.
- A source-text order pin, in the style of `review-core-testcmd.test.mjs`, reds
  on a harmless reorder. It also stays green when the `throw` is deleted but the
  `snapshotMissing` call is left in place.

## What reopens it

A caller of `usableDiff` outside `runReview` that cannot route through
`snapshotMissing` first. Another reason to reopen it is a measured case of a
skewed diff reaching a specialist while the behavioural test stays green.

## Prior requests

- #1132: "delete the unreachable head-skew apparatus in `usableDiff`/`readRules`".
  Its ruling chose to collapse the duplicate head compare and rejected keeping it
  as defence in depth. The tradeoff came up again in the reviews of PR #1126 and
  PR #2199.
- #2203: "usableDiff silently accepts a diff for a head/refHead-skewed snapshot —
  depends on an unenforced snapshotMissing-first call order"
