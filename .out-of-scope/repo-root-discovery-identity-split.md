# Splitting `repo-root.mjs` Into `discoverGitRoot` and `isOwnTree`

`repo-root.mjs` exports one `repoRoot(cwd)` that finds the git root and then
asserts the tree is this repo's own (`assertOwnRoot`, `isTrackedBy`, both
private). We don't accept a proposal to split it into a thin
`discoverGitRoot` plus a deep `isOwnTree`, composed by `ownRepoRoot`, until a
named trigger below appears. The spec for the split said so itself: filed
rather than built.

## Why this is out of scope

**The split has no second consumer.** Ten call sites use `repoRoot`, and every
one of them wants discovery and the identity check together, including the
two test files added since the spec was written
(`tests/shipped-surface-prose.test.mjs`, `tests/test-location.test.mjs`). The
callers that want only a root do not reach for the shared function at all:
`staleness.mjs`, `ledger.mjs` and `dispositions-check.mjs` each run their own
one-line `git rev-parse`. Nothing in the repo needs `discoverGitRoot` alone.

**It is locality only.** Two exports instead of one buy a smaller interface
per function, with no behaviour gained and ten callers that all end up calling
the composed form anyway.

## What would reopen this

Either of these:

- A caller needs `discoverGitRoot`'s three-way answer (a root, null, or a
  thrown refusal) without the identity check. The looser wording "a caller
  needs discovery without the identity check" has arguably already been met by
  the `rev-parse` callers above, and nobody needed the shared function, so it
  is not the trigger.
- A second identity rule appears, so `isOwnTree` would have two bodies to keep
  apart.

If this is reopened, refresh the caller list first: it was eight in the spec
and ten when this record was written.

## Prior requests

- #2150 — "Split repo-root.mjs: `discoverGitRoot` (thin) + `isOwnTree` (deep), composed by `ownRepoRoot` (speculative)"
