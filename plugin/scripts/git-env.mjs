// Shared by every `.mjs` script under this directory that shells out to git —
// two exports, one per half of the same spawn. `gitEnv()` builds the env the
// git child is given; `workspaceDirFromGitCommonDir()` turns what the most
// common of those children answers with, `rev-parse --git-common-dir`, into
// the workspace directory a run's files live under. The first half is #1599's
// reasoning, below; the second is #1658's, beside its own function.
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

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

// Every fleet script that needs to know WHERE the run's files live asks git
// the same question — `rev-parse --git-common-dir` — and then resolves the
// answer the same way, because the answer is the same shape in all three:
// the common dir is shared by every worktree of one repository (git answers
// with the MAIN checkout's git dir from inside a linked worktree), so its
// PARENT is the one workspace a run has, whichever worktree asked. That is
// why a member running from `.worktrees/<n>-slug` and the controller running
// from the checkout root agree about the run's single ledger, its single
// heartbeat and its single board.
//
// Three callers hand-spelled that resolution, one apiece, before #1658:
// `ledger.mjs`'s `defaultLedgerPath()`, `fleet-state.mjs`'s `statePath()` and
// `board.mjs`'s `resolveCockpitInstance()` — and `fleet-state.mjs`'s own
// comment had already written down the trigger ("if a third file ever needs
// this, the resolution itself should move"), which #1656's addition tripped.
// What is NOT shared is the part each caller owns: the filename it joins on
// (`ledger.md`, `heartbeat.json`, `.fleet`), the wording of the warning it
// degrades with, and what its own degraded answer is. Hence the seam: this
// function answers the directory or `null`, and every caller composes the
// rest around it.

/**
 * The workspace directory a `git rev-parse --git-common-dir` answer names —
 * the directory HOLDING the common git dir — resolved against `cwd`, or
 * `null` when the answer carries nothing usable.
 *
 * `null` is the signal every caller's degrade arm branches on, and the reason
 * this returns it rather than a cwd-relative fallback of its own: what a
 * degraded answer should be is the caller's to say (a cwd-relative filename
 * for the ledger, an absolute cwd-anchored `.fleet` for the board), and so is
 * the warning that must accompany it — a degrade nobody announces is the
 * failure class all three of those warnings exist to close.
 *
 * `resolve(cwd, …)` rather than resolve()'s implicit `process.cwd()`: git
 * answers this RELATIVE — a bare `.git` — when it runs from a checkout's top
 * level, and the cwd that was relative to is an argument here, not ambient,
 * so a caller that injects the answer (board.mjs, which takes it as a
 * parameter so its worktree and resolution-failed cases stay plain test rows)
 * can inject the cwd too. `cwd` defaults to `process.cwd()`, which is what
 * the callers that spawn git themselves already resolved against.
 *
 * The `trim()` is what makes a newline-only answer the `null` case rather
 * than a path; a trailing newline riding on a real answer would be discarded
 * by `dirname()` anyway, together with the rest of the final segment.
 *
 * `canonicalise` is OPT-IN, and deliberately so (#1658). Only `board.mjs`
 * takes it: a symlinked route to one workspace derives a SECOND port and a
 * second state directory for a cockpit already being served (#1582), so the
 * cockpit's key has to be the canonical form. `ledger.mjs` and
 * `fleet-state.mjs` do not — both PRINT the path they resolve (the ledger in
 * `check`'s JSON, both in their degrade warnings), and realpath would change
 * that output without changing which file they reach, since the canonical and
 * symlinked spellings of one path are one file. Left off, this function reads
 * nothing: `canonicalise: true` is its only filesystem access.
 *
 * A path that does not resolve is not a failure when it is asked for: the
 * caller gets a usable key back, just an uncanonicalised one. A workspace
 * directory removed out from under a running cockpit must not turn resolution
 * into a throw.
 */
export function workspaceDirFromGitCommonDir(gitCommonDir, cwd = process.cwd(), { canonicalise = false } = {}) {
  const common = String(gitCommonDir ?? "").trim();
  if (!common) return null;
  const workspace = dirname(resolve(cwd, common));
  if (!canonicalise) return workspace;
  try { return realpathSync(workspace); } catch { return workspace; }
}
