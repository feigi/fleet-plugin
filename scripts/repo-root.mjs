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
// THE CONDITIONS BELOW MUST NOT MERGE. `repoRoot` answers `null` for exactly
// one of them:
//
//   there is no working tree at    no `.git` at or above the file, and git
//   or above the file              agrees. The environment fails the file's
//                                  precondition, and this is the ONLY condition
//                                  that may skip.
//   git cannot answer the          a `.git` git refuses to read, a stale
//   question                       worktree pointer, a bare repository, no git
//                                  binary at all. A repository may well be
//                                  present; what is missing is an answer. A
//                                  probe that could not look must never read as
//                                  an answer — that is #1149's own defect, and
//                                  buying a skip with it would reproduce it
//                                  inside its own fix. `repoRoot` THROWS here,
//                                  which is the loud module-load failure the
//                                  pre-#1149 code produced for these.
//   the root answers, and the      the wrong repository, or a broken glob or
//   list of tracked scripts is     path join. That is a real failure and each
//   empty                          file's own non-vacuity guard must keep
//                                  catching it. `trackedShellScripts` is
//                                  therefore free to return an empty array and
//                                  says nothing about skipping — a skip that
//                                  also fired on an empty list would turn the
//                                  nested-under-an-unrelated-repo failure into
//                                  a silent green, which is the opposite of
//                                  what this exists for.
//
// Zero deps: `node --test scripts/repo-root.test.mjs`.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// git's message for a discovery walk that reached the top without finding a
// repository. Measured, git 2.50.1 (Apple Git-155): `fatal: not a git
// repository (or any of the parent directories): .git`. git carries a second
// wording for the walk that stops at a filesystem boundary — read out of the
// binary, `strings -a "$(git --exec-path)/git-rev-parse" | grep 'not a git
// repository (or any'` returns that one alongside it (the `git` on `PATH` is a
// shim here and carries neither) — so the match is anchored on the prefix the
// two share rather than on the form this machine happens to print.
//
// It deliberately does NOT match `fatal: not a git repository: <path>`, which
// is a `.git` naming a gitdir that is not there — a broken pointer, not an
// absent tree, and one of the conditions that must be loud.
//
// `LC_ALL=C` on the spawn is what keeps this English. Apple's git ships no
// message catalogues, so it reads the same under any locale here (measured
// under `de_DE.UTF-8` and `fr_FR.UTF-8`); a git built with NLS does not, and an
// unmatched message would turn the extraction case from a skip into a throw.
// Same pin, and same reason, as the `LC_ALL=C` in json.sh.
const NO_REPOSITORY_ANYWHERE = /not a git repository \(or any /;

/**
 * The `.git` at or above `cwd`, or `null` where the walk finds none.
 *
 * The one fault git cannot report distinctly: an unreadable `.git` (`chmod
 * 000`) makes the discovery walk step over it and print the SAME
 * no-repository-anywhere message as a genuinely empty walk (measured). So the
 * absence has to be established from the filesystem rather than from what git
 * said about it.
 *
 * `GIT_CEILING_DIRECTORIES` is honoured with git's own semantics — the walk
 * starts in the working directory and declines to step UP into a ceiling entry
 * — so a fixture that scopes git's search scopes this too, instead of the
 * answer depending on whatever lies above `$TMPDIR`.
 */
function dotGitAtOrAbove(cwd) {
  const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? "").split(":").filter(Boolean);
  for (let dir = cwd; ;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) return dotGit;
    const up = dirname(dir);
    if (up === dir || ceilings.includes(up)) return null;
    dir = up;
  }
}

/**
 * The ambient git working tree at or above `cwd`, or `null` where there is none.
 *
 * `null` rather than a throw, because "there is no repository here" is an
 * answer this codebase acts on, not an error to propagate — and at module scope
 * a propagated one costs the whole file its tests. That licence is spent on
 * that one answer and no other: every other way `git rev-parse` can fail leaves
 * the question unanswered rather than answering it "no", and those throw. git's
 * stderr is captured rather than discarded precisely so the two can be told
 * apart, and it travels in the error.
 */
export function repoRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"],
    { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (r.status === 0) return r.stdout.trim();

  const dotGit = r.error ? null : dotGitAtOrAbove(cwd);
  if (!r.error && dotGit === null && NO_REPOSITORY_ANYWHERE.test(r.stderr ?? "")) return null;

  throw new Error(
    `git could not answer whether ${cwd} is inside a working tree, which is not the same as there being none: `
    + (r.error ? `git could not be run at all (${r.error.code ?? r.error.message})`
      : dotGit !== null ? `${dotGit} is there and git reports no repository (status ${r.status}: ${(r.stderr ?? "").trim()})`
        : `status ${r.status}: ${(r.stderr ?? "").trim()}`),
  );
}

/**
 * A node:test `skip` value for a file that cannot run without an ambient
 * working tree: the reason where `root` is `null`, and `false` — run it —
 * otherwise.
 *
 * `subject` names what did not run, in that file's own words. The reason has to
 * be exact in BOTH directions: a reader of the run must not read the absence of
 * coverage as coverage, and must not read a file-wide "nothing here was
 * checked" over a file where most of the tests ran either.
 */
export function skipWithoutRepo(root, subject) {
  return root === null
    ? `no ambient git working tree at or above this file, so ${subject} did not run and nothing about it was checked`
      + " — a `git archive` extraction has no `.git`. Run it against a real checkout or worktree."
    : false;
}

/**
 * Every tracked `*.sh` in the working tree at `root`, repo-relative.
 *
 * `root` must be a real root — call it only where `repoRoot` answered. A `null`
 * root is rejected rather than absorbed into an empty list: `execFileSync`
 * reads `cwd: null` as "inherit the calling process's directory", so absorbing
 * it would answer some unrelated repository's scripts, or nothing, with nothing
 * to say which. Deciding what an absent working tree means is the caller's, via
 * `skipWithoutRepo`.
 *
 * An empty result from a real root is a legitimate answer from a repository
 * that has no shell scripts, and the caller's non-vacuity guard is what judges
 * it.
 */
export function trackedShellScripts(root) {
  if (typeof root !== "string") {
    throw new TypeError(
      `trackedShellScripts: root must come from repoRoot(), got ${String(root)} — `
      + "an absent working tree is a skip for the caller to make, not an empty list to iterate",
    );
  }
  return execFileSync("git", ["ls-files", "*.sh"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean);
}
