// Shared by every `.mjs` script under this directory that shells out to git.
//
// GIT_DIR and GIT_WORK_TREE outrank both the child's cwd and an explicit `-C`
// argument — measured directly (#1599): a `git rev-parse`/`ls-files` call
// pointed at a repository via `cwd` or `-C` still answers for whichever
// repository an ambient GIT_DIR or GIT_WORK_TREE names, silently, often at
// exit 0. #1020 closed the identical class in every shell script under this
// directory with one line, `unset GIT_DIR GIT_WORK_TREE`; there is no shell
// to unset in here, so the child's env has to be built instead — and #1020's
// own EXEMPT reasons for net.sh/worktree.sh ("a library... unset there would
// reach back into the caller's environment") do not transfer: a spawned
// child's env object is already private to it, never the calling process's.
//
// `fleet-state.mjs`'s `statePath()` and `ledger.mjs`'s tracker-query probe
// each spell the same three lines inline — `{ ...process.env }` then two
// `delete`s — predating this module, and #1599's own body cites exactly that
// duplication as the reason a THIRD hand-spelled copy (its own measured
// hazard, `ledger.mjs`'s `defaultLedgerPath()`) should not become a fourth.
// A shared helper also turns "does this call scrub the ambient vars" back
// into a one-name grep, `gitEnv(`, the way `unset GIT_DIR GIT_WORK_TREE` is
// one for shell — see `ambient-git-vars-mjs-prose.test.mjs`.
//
// The two pre-existing inline sites are deliberately NOT migrated to call
// this. Neither is in #1599's scope — its own body excludes
// `fleet-state.mjs`'s `statePath()` by name (already fixed and covered, by
// PR #1598), and `ledger.mjs`'s tracker-query scrub is likewise already
// measured and covered (`ledger.test.mjs`, "an inherited GIT_DIR or GH_REPO
// cannot retarget the query…") — and touching either to satisfy a detector
// would be churn with no behavioural change. `ambient-git-vars-mjs-prose.test.mjs`
// carries both of them by name instead of by import.

/**
 * `base` (defaulting to `process.env`) with GIT_DIR and GIT_WORK_TREE
 * removed, so a git child spawned with the result cannot be retargeted by
 * whichever repository an ambient invocation — a git hook, `rebase --exec`,
 * `bisect run` — happened to set either to.
 *
 * `overrides` are applied AFTER the copy of `base` and BEFORE the two
 * deletes below, so a caller can add its own keys (`LC_ALL`, `GH_REPO`) in
 * the same call without a second object spread, and an override that itself
 * names GIT_DIR or GIT_WORK_TREE cannot smuggle either back in.
 */
export function gitEnv(overrides = {}, base = process.env) {
  const env = { ...base, ...overrides };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}
