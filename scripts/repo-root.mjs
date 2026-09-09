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
// #1339 found the second way "there has to be a `.git`" is not the same
// question as "there has to be THIS repository": git's discovery walk answers
// with whatever working tree it finds first, and nothing about that answer
// says it is fleet-plugin's own tree rather than an ambient repository the
// caller's directory happens to nest under (an installed plugin copy under
// `~/.claude/plugins/cache/...` has no `.git` of its own; the walk keeps going
// and can land on the operator's dotfiles repo). The old guard against that was
// non-vacuity — an empty tracked-script list is suspicious — and a wrong root
// that is non-empty sailed straight through it.
//
// The first fix here compared the resolved root's OWN `.claude-plugin/
// plugin.json` name against this file's — and #1354's review measured that a
// DIFFERENT checkout of this same plugin, sitting above some unrelated caller
// directory, still passed: same name, wrong tree. Name equality is not
// identity. What repoRoot now insists on is CONTAINMENT: the running script
// (this very file, realpath'd) and its own manifest (found self-relatively,
// never by guessing a depth below the root) must both resolve INSIDE the
// answered root. A root that does not contain the script asking the question
// cannot be that script's own tree, whatever a manifest somewhere else on disk
// happens to be named — so repoRoot never reads any manifest but its own.
// That self-relative lookup is also what survives #1336's planned re-nesting
// of the payload under `plugin/`: a hardcoded `root/.claude-plugin/
// plugin.json` breaks the moment the manifest moves a level deeper, while
// `dirname(thisFile)/../.claude-plugin/plugin.json` does not care where `root`
// (the git toplevel) ends up relative to that — it only has to still contain
// it, which containment checks directly.
//
// THE CONDITIONS BELOW MUST NOT MERGE. `repoRoot` answers `null` for exactly
// one of them, THROWS for two more, and only ever returns a path for the last:
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
//   the root answers, but it       identity, not non-emptiness, and not name
//   does not CONTAIN this file     equality either (#1339, then #1354): a
//   or this file's own manifest    root that merely names the same plugin, or
//                                  answers non-empty for some other reason, is
//                                  still a stranger's tree unless the running
//                                  script is actually inside it. `repoRoot`
//                                  THROWS here too, naming the rejected root
//                                  and the script or manifest path it failed to
//                                  contain.
//   the root answers, and it IS    a real failure — a broken glob or path join
//   this plugin's own, but the     inside a tree that genuinely is this
//   list of tracked scripts is     plugin's own. `trackedShellScripts` is
//   empty                          therefore free to return an empty array and
//                                  says nothing about skipping; each caller's
//                                  own non-vacuity guard is what judges it. The
//                                  wrong-repository half of this used to live
//                                  here too, before #1339 moved it up into the
//                                  identity check above, where it can throw
//                                  loudly instead of waiting on each caller's
//                                  guard to notice.
//
// Zero deps: `node --test scripts/repo-root.test.mjs`.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
 * This plugin's own manifest path: `../.claude-plugin/plugin.json`, relative
 * to repo-root.mjs's own location, not to `cwd` and not to a `root` some
 * caller resolved. Relative to `cwd` would ask the wrong question, since
 * `cwd` is exactly the thing under test; relative to a resolved `root` would
 * have to guess how many levels separate the manifest from the git toplevel,
 * and #1336 is about to change that answer. This guesses nothing — wherever
 * this file is copied (a checkout, a worktree, an installed plugin cache, and
 * after #1336 a `plugin/` subdirectory), its own manifest is always exactly
 * one directory up from it.
 */
function ownManifestPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
}

/**
 * This plugin's own `name`, read from `ownManifestPath()`.
 *
 * Guarded rather than a bare `JSON.parse(readFileSync(...))`: a missing or
 * malformed manifest here is the same class of environment fault the rest of
 * this module goes to lengths to make legible, and every caller of `repoRoot`
 * reaches this at module scope — an unguarded throw would read as an
 * `ENOENT` or a `SyntaxError` at line 1 of whichever sweep imported it, with
 * nothing to say the failure was about identity verification.
 *
 * Exported so the regression tests can build a fixture that matches without
 * duplicating (or hardcoding) the name themselves.
 */
export function ownPluginName() {
  const manifestPath = ownManifestPath();
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(
      `${manifestPath} (this plugin's own manifest) could not be read (${e.message}) — `
      + "repoRoot cannot verify identity without it",
    );
  }
  if (typeof manifest.name !== "string" || manifest.name === "") {
    throw new Error(
      `${manifestPath} (this plugin's own manifest) has no usable "name" — repoRoot cannot verify identity against it`,
    );
  }
  return manifest.name;
}

/**
 * `root` is a git working tree; this asserts it is THIS plugin's own rather
 * than an ambient repository the caller's directory happened to nest under
 * (#1339 — an installed plugin copy has no `.git` of its own, so the walk that
 * finds one can land on an unrelated repository above it), OR a different
 * checkout of this same plugin sitting above some unrelated caller directory
 * (#1354's review of #1339's first attempt, which compared `root`'s own
 * manifest name against this file's and missed exactly that: same name,
 * wrong tree).
 *
 * The check is CONTAINMENT, realpath'd on both sides so a symlinked checkout
 * is not rejected: this running script, and its own manifest, must both
 * resolve inside `root`. Nothing here ever reads a manifest other than this
 * file's own — there is no "their name" to compare, which is what keeps this
 * free of the depth assumption `#1336`'s planned re-nesting would otherwise
 * break. Anything that fails containment throws, naming the rejected root and
 * the path it failed to contain — a caller must never receive a foreign root
 * as though it were a usable answer.
 */
function assertOwnRoot(root) {
  const name = ownPluginName();
  const realRoot = realpathSync(root);
  const self = realpathSync(fileURLToPath(import.meta.url));
  if (!self.startsWith(realRoot + sep)) {
    throw new Error(
      `${root} is a git working tree, but it does not contain ${self} — a tree that merely names the same `
      + `plugin (${JSON.stringify(name)}) is another checkout, not this one; refusing to answer about a `
      + "stranger's tree rather than return a foreign root",
    );
  }
  const manifestPath = realpathSync(ownManifestPath());
  if (!manifestPath.startsWith(realRoot + sep)) {
    throw new Error(
      `${root} is a git working tree containing ${self}, but not this plugin's own manifest (${manifestPath} `
      + "lies outside it) — refusing to answer about a stranger's tree rather than return a foreign root",
    );
  }
}

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
 * The ambient git working tree at or above `cwd` — verified to be THIS
 * plugin's own — or `null` where there is no working tree at all.
 *
 * `null` rather than a throw, because "there is no repository here" is an
 * answer this codebase acts on, not an error to propagate — and at module scope
 * a propagated one costs the whole file its tests. That licence is spent on
 * that one answer and no other: every other way `git rev-parse` can fail leaves
 * the question unanswered rather than answering it "no", and those throw. git's
 * stderr is captured rather than discarded precisely so the two can be told
 * apart, and it travels in the error.
 *
 * A working tree that IS found is not returned on the strength of being
 * found — `assertOwnRoot` checks it is this plugin's own before it ever
 * reaches a caller (#1339). A non-empty wrong root throws exactly as loudly as
 * an unanswerable one; the old guard against it lived only in each caller's
 * non-vacuity check on `trackedShellScripts`, which a non-empty foreign
 * answer sailed straight through.
 */
export function repoRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"],
    { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (r.status === 0) {
    const root = r.stdout.trim();
    assertOwnRoot(root);
    return root;
  }

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
