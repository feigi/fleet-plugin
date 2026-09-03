// The ambient-working-tree precondition the sweep suites share, in one place.
//
// Three test files here derive their subject list by asking git what ships —
// the repository root, then the tracked `*.sh` under it. That premise is
// deliberate and unchanged: an untracked scratch script is not what ships, and
// a fleet script that moves out of its directory must not fall out of a sweep
// with it. What the premise costs is a precondition: there has to be a `.git`
// at or above the file. A checkout and a worktree both have one; a `git
// archive` extraction does not, and that is how review specialists measure the
// suite (#1056).
//
// Before #1149 each file paid that cost as a bare module-scope `execFileSync`
// whose failure escaped. Node cannot attribute a throw during module
// evaluation to any test, so it synthesised one entry at line 1 of the file and
// the run showed a single failure in place of the file's real tests — a
// diagnostic that reads like a regression in the tree under test rather than an
// environment missing a repository.
//
// TWO CONDITIONS, AND THEY MUST NOT MERGE. `repoRoot` answers `null` for
// exactly one of them:
//
//   the root lookup cannot answer   no ambient working tree. The environment
//                                   fails the file's precondition, and this is
//                                   the ONLY condition that may skip.
//   the root answers, and the list   the wrong repository, or a broken glob or
//   of tracked scripts is empty      path join. That is a real failure and each
//                                   file's own non-vacuity guard must keep
//                                   catching it. `trackedShellScripts` is
//                                   therefore free to return an empty array and
//                                   says nothing about skipping — a skip that
//                                   also fired on an empty list would turn the
//                                   nested-under-an-unrelated-repo failure into
//                                   a silent green, which is the opposite of
//                                   what this exists for.
//
// Zero deps: `node --test skills/fleet/scripts/repo-root.test.mjs`.

import { execFileSync } from "node:child_process";

/**
 * The ambient git working tree at or above `cwd`, or `null` where there is none.
 *
 * `null` rather than a throw, because "there is no repository here" is an
 * answer this codebase acts on, not an error to propagate — and at module scope
 * a propagated one costs the whole file its tests. stderr is discarded: the
 * `fatal: not a git repository` git prints on the way out is the expected
 * answer here, and printing it would leave the confusing noise this replaces.
 */
export function repoRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * A node:test `skip` value for a file that cannot run without an ambient
 * working tree: the reason where `root` is `null`, and `false` — run it —
 * otherwise.
 *
 * The reason names the missing precondition and what to do instead, so a
 * reader of the run cannot read the absence of coverage as coverage.
 */
export function skipWithoutRepo(root) {
  return root === null
    ? "no ambient git working tree at or above this file, so NOTHING here was checked — this sweep asks git what ships and a `git archive` extraction has no `.git`. Run it against a real checkout or worktree."
    : false;
}

/**
 * Every tracked `*.sh` in the working tree at `root`, repo-relative.
 *
 * `root` must be a real root — call it only where `repoRoot` answered. An empty
 * result is a legitimate answer from a repository that has no shell scripts,
 * and the caller's non-vacuity guard is what judges it.
 */
export function trackedShellScripts(root) {
  return execFileSync("git", ["ls-files", "*.sh"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean);
}
