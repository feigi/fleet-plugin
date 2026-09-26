// The ambient-working-tree precondition the sweep suites share, in one place.
//
// Four test files here derive their subject list by asking git what ships —
// the repository root, then the tracked `*.sh` under it. That premise is
// deliberate and unchanged: an untracked scratch script is not what ships, and
// a fleet script that moves out of its directory must not fall out of a sweep
// with it. What the premise costs is a precondition: there has to be a `.git`
// at or above the file. A checkout and a worktree both have one; a bare `git
// archive` extraction does not. Review specialists used to measure the suite in
// exactly such an extraction, which cost this repo 19 silent declines per run
// (#1056); since that ticket the review snapshot is `git init`ed and committed
// at cut time, so the declines below are no longer the review's normal path.
// They remain the answer for any OTHER repo-less tree — a hand-cut archive, a
// tarball unpacked in CI — which is why the guard stays rather than becoming
// dead weight.
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
// directory, still passed: same name, wrong tree. The second fix required the
// running script to be somewhere INSIDE the resolved root — and that review
// measured it regresses #1339's OWN shape: an installed copy under
// `~/.claude/plugins/cache/fleet-plugin/...` genuinely sits inside
// `~/.claude`, which is exactly the ambient repository the bug is about.
// Containment is not identity either. What repoRoot now insists on is
// TRACKED-NESS: the running script (this very file, realpath'd) and its own
// manifest (found self-relatively, never by guessing a depth below the root)
// must both be tracked by `root`'s OWN git (`git ls-files --error-unmatch`).
// An installed plugin's cache directory sits inside the operator's dotfiles
// checkout but is never committed there, so it fails; a real checkout, a
// worktree, a `plugin/`-nested layout after #1336, and a vendored copy inside
// a monorepo all pass, because in each of those the file genuinely IS part of
// that repository's own tracked tree. The self-relative manifest lookup is
// what survives #1336's planned re-nesting of the payload under `plugin/`: a
// hardcoded `root/.claude-plugin/plugin.json` breaks the moment the manifest
// moves a level deeper, while `dirname(thisFile)/../.claude-plugin/
// plugin.json` does not care where `root` (the git toplevel) ends up relative
// to that — it only has to still be tracked there, which `isTrackedBy` checks
// directly.
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
//   the root answers, but its      identity, not non-emptiness, not name
//   own git does not TRACK this    equality, and not mere containment either
//   file or this file's own        (#1339, then #1354 twice): a root that
//   manifest                       merely names the same plugin, contains an
//                                  untracked copy, or answers non-empty for
//                                  some other reason, is still a stranger's
//                                  tree unless its OWN git has this file (and
//                                  its manifest) committed to its index.
//                                  `repoRoot` THROWS here too, naming the
//                                  rejected root and the untracked path.
//   the root answers, and it IS    a real failure — a broken glob or path join
//   this plugin's own, but the     inside a tree that genuinely is this
//   list of tracked scripts is     plugin's own. `trackedShellScripts` and
//   empty                          `trackedNodeScripts` are therefore free to
//                                  return an empty array and say nothing about
//                                  skipping; each caller's own non-vacuity
//                                  guard is what judges it. The
//                                  wrong-repository half of this used to live
//                                  here too, before #1339 moved it up into the
//                                  identity check above, where it can throw
//                                  loudly instead of waiting on each caller's
//                                  guard to notice.
//
// Zero deps: `node --test plugin/scripts/repo-root.test.mjs`.

import { execFileSync, spawnSync } from "node:child_process";
import { gitEnv } from "./git-env.mjs";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * `path` is tracked by the git repository at `root` — `git ls-files
 * --error-unmatch` exits 0 only then. Runs with `cwd: root` (not `-C`, to
 * match this file's other spawns) because git resolves a pathspec against
 * whatever repository the WORKING DIRECTORY belongs to, not the repository
 * nearest the pathspec itself (measured: from an unrelated cwd, the same
 * absolute path is reported "outside repository at <that other repo>").
 *
 * GIT_DIR scrubbed (#1599, gitEnv()): measured, an ambient GIT_DIR answers
 * for a DIFFERENT repository regardless of `cwd` — `ls-files
 * --error-unmatch` on a path this file's OWN repository genuinely tracks
 * then exits 1 "did not match any file(s) known to git", a false negative
 * that sends `assertOwnRoot` below into refusing a root this plugin's own
 * git ACTUALLY tracks.
 *
 * GIT_WORK_TREE scrubbed too, and NOT inert here despite being inert for
 * `trackedFiles`' relative globs below — `path` here is always
 * `realpathSync`'d, i.e. absolute, and git resolves an absolute pathspec
 * against the WORK TREE. Measured: an ambient GIT_WORK_TREE naming a
 * different repository turns this call into `fatal: <path> is outside
 * repository at <ambient path>`, exit 128 — the same false-negative
 * consequence as the GIT_DIR case above, by a different route.
 */
function isTrackedBy(root, path) {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", path],
    { cwd: root, encoding: "utf8", env: gitEnv({ LC_ALL: "C" }) });
  return r.status === 0;
}

/**
 * `root` is a git working tree; this asserts it is THIS plugin's own rather
 * than an ambient repository the caller's directory happened to nest under.
 *
 * Containment (is the running script somewhere INSIDE `root`?) was tried
 * first and is not enough — it regresses #1339's own measured shape. There,
 * self is `~/.claude/plugins/cache/fleet-plugin/fleet/0.1.1/scripts/
 * repo-root.mjs`, and `root` resolves to `~/.claude`, which genuinely
 * CONTAINS self (the installed copy sits inside the operator's dotfiles
 * checkout) — but `~/.claude`'s git does not TRACK that cache directory, so
 * `~/.claude` is not the tree this file ships in. The check is therefore
 * TRACKED-NESS: does `root`'s own git know this file (`git ls-files
 * --error-unmatch`)? An untracked copy lying inside an ambient working tree
 * is exactly as much a stranger as no copy at all. This also accepts every
 * tree that legitimately IS this file's own — this checkout, a worktree, a
 * `plugin/`-nested layout after #1336, even a vendored copy inside a larger
 * monorepo — because in every one of those cases the file is actually
 * COMMITTED to that repository's index, which an ambient-but-unrelated
 * repository's cache directory never is.
 *
 * Realpath'd on both sides so a symlinked checkout is not rejected. Anything
 * that fails throws, naming the rejected root and the path it does not
 * track — a caller must never receive a foreign root as though it were a
 * usable answer.
 */
function assertOwnRoot(root) {
  const name = ownPluginName();
  const self = realpathSync(fileURLToPath(import.meta.url));
  if (!isTrackedBy(root, self)) {
    throw new Error(
      `${root} is a git working tree, but does not TRACK ${self} — an untracked copy lying inside an ambient `
      + `working tree (its own plugin.json even naming ${JSON.stringify(name)}) is not that tree's own; refusing `
      + "to answer about a stranger's tree rather than return a foreign root",
    );
  }
  const manifestPath = realpathSync(ownManifestPath());
  if (!isTrackedBy(root, manifestPath)) {
    throw new Error(
      `${root} is a git working tree that tracks ${self}, but not this plugin's own manifest (${manifestPath}) — `
      + "refusing to answer about a stranger's tree rather than return a foreign root",
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
  // GIT_DIR/GIT_WORK_TREE scrubbed (#1599, gitEnv()): measured from a
  // subdirectory of a real working tree (the realistic shape — `cwd` here is
  // wherever the calling script happens to live, rarely the root itself) —
  // an ambient GIT_DIR alone answers `--show-toplevel` with `cwd` ITSELF, not
  // the tree's real root, and an ambient GIT_WORK_TREE alone answers with
  // that ambient path outright. Both are silently wrong, at exit 0.
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"],
    { cwd, encoding: "utf8", env: gitEnv({ LC_ALL: "C" }) });
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
 * Every file tracked in the working tree at `root` that `pathspecs` match,
 * repo-relative — the one discovery rule behind both exports below, so what
 * `root` must be and which repository answers cannot drift apart between
 * them (#1751). `caller` is the export's own name, for the refusal.
 *
 * `root` must be a real root — call it only where `repoRoot` answered. A `null`
 * root is rejected rather than absorbed into an empty list: `execFileSync`
 * reads `cwd: null` as "inherit the calling process's directory", so absorbing
 * it would answer some unrelated repository's files, or nothing, with nothing
 * to say which. Deciding what an absent working tree means is the caller's, via
 * `skipWithoutRepo`.
 *
 * An empty result from a real root is a legitimate answer from a repository
 * that has nothing matching, and the caller's non-vacuity guard is what judges
 * it.
 *
 * GIT_DIR scrubbed (#1599, gitEnv()): measured, an ambient GIT_DIR silently
 * substitutes a DIFFERENT repository's tracked list for `root`'s own — the
 * caller's non-vacuity guard cannot see this, since the wrong list is
 * routinely non-empty. GIT_WORK_TREE is inert here (measured, for `*.sh` and
 * for the lone `:(exclude)*.test.mjs` alike) for a reason specific to THIS
 * call rather than transferable from `isTrackedBy` above: every pathspec here
 * is a relative glob, never `realpathSync`'d, so there is no absolute path for
 * an ambient work tree to reject as outside itself.
 */
function trackedFiles(caller, root, pathspecs) {
  if (typeof root !== "string") {
    throw new TypeError(
      `${caller}: root must come from repoRoot(), got ${String(root)} — `
      + "an absent working tree is a skip for the caller to make, not an empty list to iterate",
    );
  }
  // `-z`, split on NUL: git's default `\n`-separated form C-quotes any path
  // with a non-ASCII or otherwise "unusual" byte (for example `café.mjs`
  // becomes the literal 12-character string `"caf\303\251.mjs"`), which
  // fails a plain `.endsWith(".mjs")` and is not openable at that path
  // either — a real tracked file silently missing from every caller's
  // answer. `-z` never quotes; it is git's own NUL-terminated form for
  // "give me the exact bytes".
  return execFileSync("git", ["ls-files", "-z", ...pathspecs], { cwd: root, encoding: "utf8", env: gitEnv() })
    .split("\0").filter(Boolean);
}

/**
 * Every tracked `*.sh` in the working tree at `root`, repo-relative. `root`,
 * an empty answer and the ambient git variables all behave as `trackedFiles`
 * says.
 */
export function trackedShellScripts(root) {
  return trackedFiles("trackedShellScripts", root, ["*.sh"]);
}

// A first line that hands the file to node: `node` itself as the interpreter,
// by a direct path (`#!/usr/local/bin/node`) or through `env` with any options
// or assignments before it (`#!/usr/bin/env node`, `#!/usr/bin/env -S node
// --no-warnings`) — including `env`'s own `-u`/`--unset` and `-C`/`--chdir`,
// each of which takes a following bare argument of its own (`#!/usr/bin/env
// -u FOO node`, `--unset FOO`, `-C DIR`) that is still no part of the
// interpreter name. Only THESE two options ever consume a following word:
// every other flag (`-S`, `-i`, …) stays exactly one token, so it can never
// swallow the real command as if it were its own argument and let a
// non-node interpreter through (`#!/usr/bin/env -S bun node` runs bun, not
// node, and must still refuse) — and, since no flag but these two has more
// than one way to be parsed, a long adversarial options list can never blow
// up matching it either. `node` is the WHOLE interpreter name — `nodemon`
// and `bun` are other programs.
const NODE_SHEBANG = /^#!\s*(?:\S*\/)?(?:env(?:\s+(?:-(?:u|-unset|C|-chdir)(?:=\S*|\s+\S+)|-(?!(?:u|-unset|C|-chdir)\s)\S+|\w+=\S*))*\s+(?:\S*\/)?)?node(?:\s|$)/;

// The first read's size. A shebang is one short line, and this holds any this
// repository would write, so one read decides it; a longer line reads on.
const SHEBANG_BYTES = 256;

/**
 * Whether the first line of the file at `path` is a node shebang — the WHOLE
 * line, up to its newline or the end of the file, however long; `buf` is
 * scratch for the first read and grows past it only for a longer line. A
 * verdict on the prefix one read holds parts from the line's own both ways
 * (#1887): it misses a `node` past its end, reads `nodemon` cut after its
 * `node` as `node` at the end of the line, and decodes a character it cuts in
 * half as U+FFFD. A file that does not open with `#!` is decided on that first
 * read however long its first line, since NODE_SHEBANG is anchored there. A
 * tracked file the working tree no longer has — an `rm` not yet committed —
 * has no first line here, so it is not one; a tracked path that resolves to
 * a directory (a symlink to one, or a submodule's gitlink checked out on
 * disk) is not a readable file either, so it answers the same "not one" —
 * the pre-#1855 `.mjs`-only sweep never opened a non-.mjs path at all, so
 * neither shape could reach it before. Any other failure to read throws.
 */
function hasNodeShebang(path, buf) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  try {
    let len = readSync(fd, buf, 0, buf.length, 0);
    if (len < 2 || buf[0] !== 0x23 || buf[1] !== 0x21) return false;
    // `buf` is reused across files, so the search stops at the bytes read.
    // The buffer doubles, so rescanning from 0 each pass stays linear.
    let end;
    while ((end = buf.subarray(0, len).indexOf(0x0a)) === -1) {
      if (len === buf.length) {
        const grown = Buffer.allocUnsafe(len * 2);
        buf.copy(grown, 0, 0, len);
        buf = grown;
      }
      const n = readSync(fd, buf, len, buf.length - len, len);
      if (n === 0) {
        end = len;
        break;
      }
      len += n;
    }
    // A newline byte never falls inside a multi-byte UTF-8 character, and
    // the end of the file is the file's own, so nothing here is cut in half.
    return NODE_SHEBANG.test(buf.toString("utf8", 0, end));
  } catch (e) {
    if (e.code === "EISDIR") return false;
    throw e;
  } finally {
    closeSync(fd);
  }
}

/**
 * Every tracked file this repository ships that the consumer's own `node`
 * executes, in the working tree at `root`, repo-relative: each `*.mjs`, and
 * any other file whose first line is a node shebang — the extensionless
 * entrypoints `fleet-run`, `fleet-bootstrap` and `fleet-provenance` (#1855).
 * A shebang decides, never an extension alone: `plugin/workflows/*.js` is ESM
 * a harness runs and plain node never loads, and carries none. Test files —
 * `*.test.mjs`, the one naming this repository gives them — are not shipped,
 * so they are not in the answer, shebang or not. `root`, an empty answer and
 * the ambient git variables all behave as `trackedFiles` says.
 */
export function trackedNodeScripts(root) {
  const buf = Buffer.alloc(SHEBANG_BYTES);
  return trackedFiles("trackedNodeScripts", root, [":(exclude)*.test.mjs"])
    .filter((f) => f.endsWith(".mjs") || hasNodeShebang(join(root, f), buf));
}
