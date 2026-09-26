// Regression gate for reap.sh, the merge probe that authorizes deleting a
// [gone] branch. Zero deps: `node --test plugin/scripts/reap.test.mjs`.
//
// The load-bearing case is the failed-probe one: a `git cherry` that dies
// (issue #264) must KEEP the branch, never reap it. `cmd | grep -q` takes
// grep's exit status, never cmd's, so a dead cherry read as "nothing
// unmerged" and `--apply` force-deleted a branch whose commits existed
// nowhere else, at exit 0. The two control cases pin the other direction —
// a fix that keeps everything is as broken as one that deletes everything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { slowTransport, SSH_URL, warmStub } from "./slow-transport.mjs";

const SCRIPT = fileURLToPath(new URL("./reap.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `pull.rebase` or hook cannot change what these repos look like.
const ENV = {
  ...process.env,
  // reap.sh reads BASE_REF and defaults to origin/main; the fleet harness is
  // exactly the caller that would have it set, and inheriting it here would
  // point every fixture at local `main` instead.
  BASE_REF: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_TEMPLATE_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

// Absolute path to the real git, for any test that shadows `git` on PATH.
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// Absolute paths to the real `awk`, `paste` and `grep`, for the sites this
// file's own fault-injection fixtures shadow on PATH — the same reason
// REAL_GIT exists above. `grep` joined them for #1419: it is the last tool in
// both merged-commit checks and both registry re-reads, and the only one whose
// own failure used to read as a clean verdict about what it had not scanned.
const REAL_AWK = execFileSync("sh", ["-c", "command -v awk"], { encoding: "utf8" }).trim();
const REAL_PASTE = execFileSync("sh", ["-c", "command -v paste"], { encoding: "utf8" }).trim();
const REAL_GREP = execFileSync("sh", ["-c", "command -v grep"], { encoding: "utf8" }).trim();

/** Empty commit on the current branch; returns its sha. */
const commit = (w, msg) => {
  git(w, "commit", "-q", "--allow-empty", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/** Bare origin + working clone with one commit on main. Returns the clone dir. */
function repo(t, dir = "w") {
  // realpathSync: macOS resolves /var through /private, so a path built from
  // the raw mkdtemp result would never string-equal what git itself reports
  // in `worktree list --porcelain` (git canonicalises). Resolved once here,
  // before any worktree path is derived from it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "reap-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, dir);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commit(w, "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return w;
}

/**
 * Like `mergedGoneBranch`, but the commit lands in a LINKED worktree under
 * `.worktrees/` instead of the main checkout — reap.sh's worktree-removal
 * path had no fixture at all before this file (a dry run and `--apply` could
 * each mispredict the other and nothing here would notice). Returns the
 * worktree's absolute path.
 *
 * `wt` overrides that home. reap.sh exempts `.worktrees/` from the
 * `--ignored` keep, so a test that exercises that keep has to put its
 * worktree somewhere else and pass the path in.
 */
function mergedGoneBranchWithWorktree(w, name, msg, wt = join(w, ".worktrees", name)) {
  git(w, "worktree", "add", "-q", wt, "-b", name, "main");
  commit(wt, msg);
  git(wt, "push", "-q", "-u", "origin", name);
  git(w, "merge", "-q", "--no-ff", "-m", `merge ${name}`, name);
  git(w, "push", "-q", "origin", "main");
  git(w, "push", "-q", "origin", "--delete", name);
  git(w, "fetch", "-q", "--prune", "origin");
  return wt;
}

/**
 * Re-point the registration for `wt` at `dest` and take the real directory away.
 *
 * `git worktree list --porcelain` derives the worktree path from the entry's
 * `gitdir` file, so rewriting that file is how a fixture gets git to name a
 * path whose FIRST component under `/` does not exist — the one shape
 * `git worktree add` cannot produce, since it has to create the directory. In
 * production this is the hand-added worktree outside the checkout whose
 * ancestor chain was removed (`git worktree add /scratch/wt`, then
 * `rm -rf /scratch`). The registry entry itself survives, so any
 * listed-vs-registered count stays balanced.
 */
/**
 * The `<git-common-dir>/worktrees/<id>` directory git keeps `$wt`'s admin
 * files in — its `gitdir` pointer, its `HEAD`, and the sequencer state of any
 * operation running inside it.
 *
 * Found by reading the `gitdir` pointers rather than by guessing the id from
 * the directory name: git derives that id from the basename and disambiguates
 * collisions, so a fixture that spelled it by hand would silently address the
 * wrong entry the first time two worktrees shared a basename.
 */
function adminEntry(w, wt) {
  const admin = join(w, ".git", "worktrees");
  // realpathSync: git canonicalises what it writes into `gitdir`, and on macOS
  // a tmpdir path reaches this suite as /var/... while git recorded
  // /private/var/... — the scan matches nothing without resolving first.
  const target = join(realpathSync(wt), ".git");
  const name = readdirSync(admin).find(
    (n) => readFileSync(join(admin, n, "gitdir"), "utf8").trim() === target,
  );
  assert.ok(name, `fixture: no registry entry points at ${wt}`);
  return join(admin, name);
}

// `latin1`, not the default utf8: `dest` may carry a byte above 127 as its own
// code unit (a #614 fixture's registry path, e.g. `bÿad`), and utf8 would
// re-encode that to two bytes instead of writing the one the fixture means.
// No behaviour change for an ASCII `dest` — latin1 and utf8 agree below 128.
function relocate(w, wt, dest) {
  writeFileSync(join(adminEntry(w, wt), "gitdir"), Buffer.from(`${dest}/.git\n`, "latin1"));
  rmSync(wt, { recursive: true, force: true });
  return dest;
}

/**
 * Branch `name` off main, merged back into main with a real merge commit,
 * then given an upstream and dropped on the remote so `%(upstream:track)`
 * reads `[gone]` — the exact state reap.sh's for-each-ref filter selects.
 * git cherry sees no unique commits: the merge already carries them.
 */
function mergedGoneBranch(w, name, msg) {
  git(w, "checkout", "-q", "-b", name, "main");
  commit(w, msg);
  git(w, "push", "-q", "-u", "origin", name);
  git(w, "checkout", "-q", "main");
  git(w, "merge", "-q", "--no-ff", "-m", `merge ${name}`, name);
  git(w, "push", "-q", "origin", "main");
  git(w, "push", "-q", "origin", "--delete", name);
  git(w, "fetch", "-q", "--prune", "origin");
}

/**
 * Branch `name` off main with one commit, never merged, given an upstream
 * and then dropped on the remote — `[gone]`, but its commit exists nowhere
 * else. Returns the commit's sha.
 */
function unmergedGoneBranch(w, name, msg) {
  git(w, "checkout", "-q", "-b", name, "main");
  const sha = commit(w, msg);
  git(w, "push", "-q", "-u", "origin", name);
  git(w, "checkout", "-q", "main");
  git(w, "push", "-q", "origin", "--delete", name);
  git(w, "fetch", "-q", "--prune", "origin");
  return sha;
}

/**
 * Shell leaving proof, beside the shim itself, that the injected fault fired.
 *
 * A fixture whose verdict is the SAME with and without the fault — every
 * "noise on stderr must not change this negative verdict" arm in this file —
 * stays green when the shim never runs at all: a PATH order slip, or a match
 * that drifted off its argv slot the way #730's did. The arm then pins
 * nothing, and nothing in it can say so. Spliced into `failOnlyShim`'s body
 * automatically; a fall-through `match` (one ending in `false`, so the real
 * git still answers) has to splice it in by hand — no body ever runs. #759
 *
 * Records `$*`, not just presence: `reap.sh` calls `git cherry $base $target`
 * from two sweeps with the same `match`, so a bare touch is satisfied by
 * EITHER sweep's probe — an arm testing one sweep's own cherry call reads as
 * pinned when only the other sweep's ever fired. `assertShimFired`'s `expect`
 * regex matches this file's contents to require the argv this arm names.
 */
const SHIM_FIRED = `printf '%s\\n' "$*" >> "$0.fired"`;

/**
 * Asserts the fault `failOnlyShim` injects actually reached the script under
 * test — and, with `expect`, that it reached THIS call's own argv rather than
 * a same-named git call elsewhere in the run. Delegates to
 * `assertToolShimFired`, fixed to the `git` tool.
 */
function assertShimFired(bin, why, expect) {
  return assertToolShimFired(bin, "git", why, expect);
}

/**
 * A PATH `git` that fails only the subcommand `match` names; everything else
 * is real. A `toolFailShim` fixed to the `git` tool and `REAL_GIT`.
 */
function failOnlyShim(t, match, stderr, code = 1) {
  return toolFailShim(t, "git", REAL_GIT, match, stderr, code);
}

/**
 * A PATH `<tool>` (awk or paste, for #789's four fault-injection fixtures)
 * that fails only when `match` — a shell test against its own argv — holds;
 * every other invocation execs the real one. `realTool` must be the absolute
 * path `command -v <tool>` resolved, so the fall-through never re-enters this
 * same shimmed PATH.
 */
function toolFailShim(t, tool, realTool, match, stderr, code = 1) {
  const bin = mkdtempSync(join(tmpdir(), `reap-${tool}-shim-`));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    join(bin, tool),
    `#!/bin/sh\n` +
      `if ${match}; then\n` +
      `  ${SHIM_FIRED}\n` +
      // Shell-quoted, not `JSON.stringify`: that escapes for JSON, but the
      // splice lands in shell, where a `$` in a fixture line would expand
      // instead of reaching git's stderr as data.
      stderr.map((l) => `  printf '%s\\n' '${l.replace(/'/g, `'\\''`)}' >&2\n`).join("") +
      `  exit ${code}\n` +
      `fi\n` +
      `exec ${realTool} "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

/**
 * Asserts the fault `toolFailShim(t, tool, …)` injects actually reached the
 * script under test, and — with `expect` — that it reached THIS call's own
 * argv rather than a same-named call elsewhere in the run.
 */
function assertToolShimFired(bin, tool, why, expect) {
  const path = join(bin, `${tool}.fired`);
  assert.equal(existsSync(path), true, why);
  if (expect) assert.match(readFileSync(path, "utf8"), expect, why);
}

/**
 * A PATH dir whose `git` fails only `cherry`, matching the ticket's real repro:
 * multi-line stderr, exit 128 (one unreadable loose object suffices in the
 * wild). Everything else execs the real git, unshimmed.
 */
function cherryShim(t) {
  return failOnlyShim(
    t,
    `[ "$1" = cherry ]`,
    ["error: unable to open loose object deadbeefcafe: Permission denied", "fatal: revision walk setup failed"],
    128,
  );
}

/**
 * A `failOnlyShim` match selecting the `--ignored` probe and nothing else.
 *
 * Selected on CONTENT, never on argv POSITION. It was `[ "$5" = --ignored ]`,
 * which #730 broke by inserting `-uall` ahead of the flag: two of the three
 * tests using it went red, and the third — the one asserting a REAP — went
 * green vacuously, its shim silently matching nothing while the assertions it
 * makes about a probe that never ran still held. A positional match is a
 * false-green generator the next flag re-arms, so the position is gone.
 *
 * `$3` stays positional deliberately: it is `git -C <wt> status …`, the
 * subcommand slot, and pinning it is what keeps this shim off the OTHER git
 * calls in the sweep.
 */
const IGNORED_PROBE = `[ "$3" = status ] && case " $* " in *" --ignored "*) : ;; *) false ;; esac`;

/**
 * A `failOnlyShim` match selecting the PLAIN status probe (`git -C <wt>
 * status --porcelain …`, no `--ignored`) and nothing else.
 *
 * Positional on `$4`, deliberately, not content-based like `IGNORED_PROBE`'s
 * `case`: a content match for `--porcelain` alone would also catch the
 * `--ignored` probe, which carries that flag too — the two have to stay
 * distinguishable, not accidentally merged into one shim.
 */
const STATUS_PROBE = `[ "$3" = status ] && [ "$4" = --porcelain ]`;

/**
 * `timeout` is a wall-clock ceiling for the bounded-fetch pair at the end of
 * this file and nothing else: those two runs are the only ones whose transport
 * can hang, and without a ceiling a watchdog that never fired would hang the
 * suite instead of failing the case. `error` is returned for the same pair — a
 * run killed by that ceiling has a null status, which would otherwise read as
 * a verdict rather than as a test that never got an answer.
 */
function runReap(cwd, args, envOverrides = {}, timeout = undefined) {
  const r = spawnSync("sh", [SCRIPT, ...args], {
    cwd,
    env: { ...ENV, ...envOverrides },
    encoding: "utf8",
    timeout,
  });
  return {
    code: r.status,
    json: r.stdout.trim() ? JSON.parse(r.stdout) : null,
    stderr: r.stderr,
    error: r.error,
  };
}

function branchExists(w, name) {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: w, env: ENV }).status === 0;
}

function specRow() {
  const spec = readFileSync(
    fileURLToPath(new URL("../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `reap.sh` |"));
  assert.ok(row, "the script-surface table must still carry a reap.sh row");
  return row;
}

test("an uncorrupted repo still reaps a genuinely merged [gone] branch", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(stderr, /KEEP/);
  assert.equal(branchExists(w, "feature/merged"), false, "a genuinely merged branch must still be deleted");
});

test("an uncorrupted repo keeps an unmerged [gone] branch for unmerged commits", (t) => {
  const w = repo(t);
  unmergedGoneBranch(w, "feature/unmerged", "solo work");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/unmerged");
  assert.equal(json.kept[0].reason, "unmerged commits");
  assert.match(stderr, /KEEP feature\/unmerged — unmerged commits/);
  assert.equal(branchExists(w, "feature/unmerged"), true, "unmerged commits keep the branch alive");
});

// The two tests below share one fixture move: giving a branch a TAG of the
// same name, pointed at `main`. Both halves of that are load-bearing.
//
// The name collision is what breaks the enumeration. `%(refname:short)` is
// ambiguity-aware — with both refs present it stops shortening to the bare name
// and emits `heads/<name>` (measured here on git 2.50.1, Apple Git-155). That
// string is not a branch `git branch -D` can find, and it does not match the
// `refs/heads/$b` key the worktree lookup builds either, so every worktree
// guard silently stands down for it (#634).
//
// Pointing the tag at `main` — a merged commit — is what makes the pair
// DISCRIMINATING rather than merely representative. Git resolves a bare
// ambiguous name as a rev by preferring `refs/tags/` over `refs/heads/`, so
// anything that hands the bare name to a rev-taking command reaches the tag's
// merged commit instead of the branch's. A merge probe that does so reports
// clean for a branch that is not merged at all. That is why the unmerged case
// below is the one that has to stay red for a fix that only changes the
// enumeration: correcting the name without qualifying the rev converts a
// branch that is currently kept into one that is deleted.
test("a merged [gone] branch sharing its name with a tag is reaped, and reported under its bare branch name (#634)", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  const tagged = git(w, "rev-parse", "main");
  git(w, "tag", "feature/merged", "main");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(
    json.reaped,
    ["feature/merged"],
    "the payload names the branch that was deleted; `heads/feature/merged` is a string git would not accept back",
  );
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(stderr, /heads\/feature\/merged/, "no operator-facing line may name the unusable prefixed form");
  assert.equal(branchExists(w, "feature/merged"), false, "a same-named tag must not strand a genuinely merged branch");
  assert.equal(git(w, "rev-parse", "refs/tags/feature/merged"), tagged, "reaping a branch must leave the tag alone");
});

test("a same-named tag on a merged commit must not authorize reaping an UNMERGED [gone] branch (#634)", (t) => {
  const w = repo(t);
  const sha = unmergedGoneBranch(w, "feature/unmerged", "solo work");
  // Merged, and reachable under the branch's own name as a rev — the two
  // properties that together let a tag answer a question asked about a branch.
  git(w, "tag", "feature/unmerged", "main");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(
    json.reaped,
    [],
    "the merge probe must read the branch it is about to delete, never a same-named tag that happens to be merged",
  );
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/unmerged");
  assert.equal(json.kept[0].reason, "unmerged commits");
  assert.match(stderr, /KEEP feature\/unmerged — unmerged commits/);
  assert.equal(branchExists(w, "feature/unmerged"), true, "the branch — and its only copy of the commit — must survive");
  assert.equal(git(w, "rev-parse", "refs/heads/feature/unmerged"), sha, "the commit itself is untouched");
});

// #924, the BASE side of the same family, and the third member of it: #634
// established that in this script the enumeration fix and the rev-consumption
// fix are separate, PR #914 qualified the BRANCH side (`refs/heads/$b`), and
// the base side reached `git cherry` exactly as BASE_REF spelled it. The
// fixture move below is one `git tag origin/main <rev>` — a tag carrying the
// full remote-tracking SPELLING of the default base, which git's own
// disambiguation order (refs/tags/<name> before refs/remotes/<name>) then
// prefers when the shorthand is resolved as a rev.
//
// Both halves of that move are load-bearing, and for a different reason than
// the #634 pair above. There a tag at ANY merged commit triggers it; here the
// tag has to actually CONTAIN the branch's commits, because a tag named
// `origin/main` at an unrelated commit yields `+` lines and correctly keeps —
// which is exactly what makes the control below a control rather than a second
// copy of the same case.
//
// Real content, never `commit()`'s empty commits, is NOT required here and
// deliberately not used: `unmergedGoneBranch` leaves `main` where it was, so
// the upstream-only set is empty and there is no patch-id for an empty commit
// to collide with. A fixture that advances `main` by an empty commit instead
// reads `-` (already upstream) under BOTH spellings and pins nothing — measured
// while building this, and the reason the control tags an EXISTING commit
// rather than making a new one.
test("a local tag named `origin/main` must not authorize reaping an unmerged [gone] branch (#924)", (t) => {
  const w = repo(t);
  const sha = unmergedGoneBranch(w, "feature/solo", "sole copy, nowhere else");
  git(w, "tag", "origin/main", "refs/heads/feature/solo");
  // `--quiet` for the reason the ticket recorded: it suppresses git's own
  // `warning: refname 'origin/main' is ambiguous.`, which is the one signal
  // this whole class produced and the reason a run was silent. Here it keeps
  // the fixture's own probe from printing it into the suite's output.
  assert.equal(
    git(w, "rev-parse", "--verify", "--quiet", "origin/main"),
    sha,
    "fixture: the shorthand must resolve to the TAG, i.e. the branch's own tip",
  );
  assert.notEqual(
    git(w, "rev-parse", "--verify", "refs/remotes/origin/main"),
    sha,
    "fixture: and the real base must be a different commit, or the shadowing changes no answer",
  );

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(
    json.reaped,
    [],
    "the merge probe must measure against refs/remotes/origin/main, never a tag that spells it",
  );
  assert.deepEqual(json.kept, [{ branch: "feature/solo", reason: "unmerged commits" }]);
  assert.match(stderr, /KEEP feature\/solo — unmerged commits/);
  assert.equal(branchExists(w, "feature/solo"), true, "the branch — and its only copy of the commit — must survive");
  assert.equal(git(w, "rev-parse", "refs/heads/feature/solo"), sha, "the commit itself is untouched");
});

test("that same tag, not covering the branch's commits, still reaps a genuinely merged one (#924)", (t) => {
  // The control, and the direction a fix that simply keeps everything fails:
  // the tag is present and still outranks the remote-tracking ref, but it sits
  // at the commit `main` was on before the branch existed, so the branch's work
  // is not in it. Measured against the pre-fix script this fixture is a false
  // KEEP — `git cherry <that old commit> refs/heads/feature/merged` prints `+`
  // for a branch that is fully merged — so the qualification is what restores
  // the reap, not just what blocks one.
  const w = repo(t);
  const before = git(w, "rev-parse", "main");
  mergedGoneBranch(w, "feature/merged", "merged work");
  git(w, "tag", "origin/main", before);

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(stderr, /KEEP/);
  assert.equal(branchExists(w, "feature/merged"), false, "a shadowing tag must not strand a genuinely merged branch either");
  assert.equal(git(w, "rev-parse", "refs/tags/origin/main"), before, "reaping a branch must leave the tag alone");
});

test("a local tag named `origin/main` must not authorize REMOVING a detached worktree's only copy (#924)", (t) => {
  // The second measurement site, and the one where the misread costs the FILES:
  // this sweep removes directories. A fix applied to the branch sweep alone
  // leaves it blind — the same split #730 pinned for the status probe — so it
  // is pinned separately here.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const sole = commit(wt, "sole copy, nowhere else");
  git(w, "tag", "origin/main", sole);

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, [], "the probe must not read the worktree's own tip as the base");
  assert.equal(existsSync(wt), true);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].reason, `worktree ${wt} holds commits that exist nowhere else`);
  assert.equal(git(wt, "rev-parse", "HEAD"), sole, "the commit is still reachable from the worktree");
});

test("a BASE_REF that only resolves as a TAG is refused, never measured against (#924)", (t) => {
  // The guard site, and the fail-closed half of the same edit. `rev-parse
  // --verify` used to ask about the shorthand, which a tag answers at exit 0 —
  // so a BASE_REF with no remote-tracking ref behind it at all passed the guard
  // and every sweep then measured against the tag. Measured on the pre-fix
  // script: `REAPED feature/solo` at exit 0, the branch's sole commit gone.
  // Asking about the qualified spelling turns that into a refusal naming the
  // spelling the caller passed.
  const w = repo(t);
  const sha = unmergedGoneBranch(w, "feature/solo", "sole copy, nowhere else");
  git(w, "tag", "origin/gone-upstream", "refs/heads/feature/solo");

  const { code, json, stderr } = runReap(w, ["--apply"], { BASE_REF: "origin/gone-upstream" });

  assert.equal(code, 2);
  assert.equal(json, null, "a refusal emits no payload");
  assert.match(stderr, /^reap: origin\/gone-upstream does not resolve$/m,
    "the message names what the caller passed, not the qualified spelling it cannot act on");
  assert.equal(branchExists(w, "feature/solo"), true, "and nothing is deleted on the way out");
  assert.equal(git(w, "rev-parse", "refs/heads/feature/solo"), sha);
});

test("BASE_REF must be a remote-tracking ref (#924)", (t) => {
  // The accept-list this script had none of, and the precondition that makes
  // the qualification above sound: with the input restricted to the one
  // namespace that can answer "has this landed upstream", prefixing
  // `refs/remotes/` is always correct. Unrestricted, `refs/heads/main` was
  // taken at face value — a local main never fast-forwarded strands every
  // merged branch, and `refs/heads/<a branch in the sweep>` reads that branch's
  // own commits as upstream and authorizes `-D` on them.
  const w = repo(t);
  unmergedGoneBranch(w, "feature/solo", "sole copy, nowhere else");

  const { code, json, stderr } = runReap(w, ["--apply"], { BASE_REF: "refs/heads/main" });

  assert.equal(code, 2);
  assert.equal(json, null, "a refusal emits no payload");
  assert.match(stderr, /^reap: BASE_REF must be a remote-tracking ref, got 'refs\/heads\/main'$/m);
  assert.equal(branchExists(w, "feature/solo"), true, "a refused invocation reads nothing and deletes nothing");

  // Fourth pin on the design spec's script-surface row, same reason as the
  // three others: the row states this script's exit-2 contract in prose, and a
  // reader trusting it draws safety conclusions about a script settings.json's
  // autoMode allowlist lets run unattended. Taken from the real refusal rather
  // than typed here — a hand-copied phrase drifts.
  const label = /^reap: (.+?), got '/m.exec(stderr);
  assert.ok(label, `fixture must reach the accept-list refusal: ${stderr}`);
  const row = specRow();
  assert.ok(
    row.includes(label[1]),
    `the spec row must state this refusal, and does not carry "${label[1]}".\nrow: ${row}`,
  );
});

test("an already-qualified BASE_REF is measured with as given, never prefixed twice (#924)", (t) => {
  // The `refs/remotes/*` arm of the qualification. Dropping it — prefixing
  // unconditionally — builds `refs/remotes/refs/remotes/origin/main`, which
  // resolves to nothing, so the accepted spelling this very accept-list admits
  // would refuse at the guard below it.
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const { code, json, stderr } = runReap(w, ["--apply"], { BASE_REF: "refs/remotes/origin/main" });

  assert.equal(code, 0, `the qualified spelling must resolve: ${stderr}`);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
});

test("a git cherry that dies is KEPT, never reaped — an unanswerable probe authorizes nothing (#264)", (t) => {
  const w = repo(t);
  const sha = unmergedGoneBranch(w, "feature/onlyhere", "sole copy, nowhere else");

  const bin = cherryShim(t);

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "an unanswerable probe is not a script failure");
  assert.deepEqual(json.reaped, [], "the sole-copy commit must not be deleted on a probe that could not answer");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/onlyhere");
  assert.match(json.kept[0].reason, /cherry probe failed/, "the reason must name the probe failure, not read as a clean merge");
  assert.match(json.kept[0].reason, /revision walk setup failed/, "git's own message must reach the reason, not just a generic label");
  assert.doesNotMatch(
    json.kept[0].reason,
    /\n/,
    "git's stderr is multi-line; an embedded newline would break the JSON payload — the reason must be flattened",
  );
  assert.match(stderr, /cherry probe failed/);

  assert.equal(branchExists(w, "feature/onlyhere"), true, "the branch — and its only copy of the commit — must survive");
  assert.equal(git(w, "rev-parse", "feature/onlyhere"), sha, "the commit itself is untouched");
});

test("a `+` inside git's stderr is not a commit line — a merged branch is still reaped", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  // The warning goes in the `match`, not the stderr array: a false match falls
  // THROUGH to `exec ${REAL_GIT}`, so the shim warns and the merge check still
  // reads a genuine `git cherry` run's stdout rather than an empty one.
  // `git cherry` SUCCEEDS here — rc 0, no commit lines on stdout — but writes a
  // diagnostic containing a `+` to stderr, which the capture's 2>&1 folds into
  // the value the merge check matches. Only the line-start `+` is a commit, so
  // this branch must still be reaped. An unanchored match keeps it forever.
  const bin = failOnlyShim(t, `[ "$1" = cherry ] && { printf '%s\\n' "warning: unable to access '/x/c++/lib/.gitattributes'" >&2; ${SHIM_FIRED}; false; }`, []);

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  // The fixture branch is genuinely merged, so every assertion below also held
  // with the shim argument replaced by `{}` (measured, #759): the arm could not
  // tell an absent anchoring bug from an absent fault. This is what makes it a
  // test of the anchoring rather than of the fixture.
  assertShimFired(
    bin,
    "no `+` ever reached the merge check — the rest of this arm passes on any fixture",
    /^cherry \S+ refs\/heads\//m,
  );
  assert.equal(code, 0);
  assert.deepEqual(json.kept, [], "a `+` inside a diagnostic is not an unmerged commit");
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.equal(branchExists(w, "feature/merged"), false, "noisy stderr must not strand a merged branch");
});

/**
 * A PATH dir whose `git` fails only `worktree prune`, standing in for the
 * repo-level faults that do exit non-zero — an unreadable `.git/config`, a
 * `GIT_DIR` off the repo — never a filesystem one: an unwritable
 * `.git/worktrees` prints `error: failed to delete …` and still exits 0, and
 * prune skips a locked entry at 0. Everything else, including
 * `git worktree remove`, execs the real git, unshimmed.
 */
function pruneShim(t) {
  return failOnlyShim(t, `[ "$1" = worktree ] && [ "$2" = prune ]`, ["fatal: unable to prune worktrees: permission denied"]);
}

// #265: `git worktree prune` used to be the last command of an AND-OR list
// after the branch loop, so under `set -eu` its own failure — not just a
// false `[ apply = true ]` — reached -e and aborted the script before the
// payload printed, after the branches above were already deleted. The
// caller lost the only record of what had happened, at exit 1: the code the
// fleet's script contract reserves for a verdict, from a script with none.
test("a failing `git worktree prune` still prints the payload and refuses on 2, never 1 (#265)", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const bin = pruneShim(t);

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 2, "a failing prune must refuse loudly on 2, never fall through to the -e default of 1");
  assert.ok(json, "the payload must still print even though the prune below it failed");
  assert.deepEqual(json.reaped, ["feature/merged"], "branches already deleted must still be recorded");
  assert.deepEqual(json.kept, []);
  assert.match(stderr, /git worktree prune/, "the refusal must name the command that failed");
});

// The other half of #992, and the one the cwd refusal below cannot cover: a
// prune that fails for a reason nobody here caused still has to say what git
// said. `die "git worktree prune failed"` named the step and dropped git's
// stdout and stderr on the floor — the class #578 catalogues at this script's
// other sites — so an operator read a step name, and in the deleted-cwd case
// git's own `fatal: Unable to read current working directory` reached the
// terminal on a line of its own with nothing tying the two together.
//
// Its own two-line shim rather than `pruneShim`: the realism argument is that
// helper's (a repo-level fault that really does exit non-zero), and the second
// line is what pins the `tr '\n' ' '` fold every other reason in this script
// applies — a message that kept its newline would split one refusal across two
// stderr lines and read as two failures.
test("a failing `git worktree prune` refusal carries git's own message, folded to one line (#992)", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const bin = failOnlyShim(t, `[ "$1" = worktree ] && [ "$2" = prune ]`, [
    "error: could not lock config file .git/config: Permission denied",
    "fatal: unable to prune worktrees: permission denied",
  ]);

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 2, "a genuinely failing prune must still refuse");
  assert.deepEqual(json.reaped, ["feature/merged"], "the payload still precedes the prune (#265)");
  assertShimFired(bin, "the fixture must actually reach the prune", /worktree prune/);
  assert.match(
    stderr,
    /reap: git worktree prune failed: error: could not lock config file \.git\/config: Permission denied fatal: unable to prune worktrees: permission denied/,
    `the refusal must quote git, not just name the step: ${stderr}`,
  );
});

// Accept-side control for the fix above: a run where nothing fails must be
// completely unchanged — same payload shape, exit 0, and the prune must
// still actually run (not just get skipped to dodge the -e trap).
test("a successful --apply run still reaps, still prunes, and exits 0 unchanged", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  // A worktree whose directory is gone but whose registration survives until
  // `git worktree prune` runs — proof the prune still executes post-fix.
  const wtDir = join(w, "..", "stale-wt");
  git(w, "worktree", "add", "-q", "-b", "scratch/stale", wtDir, "main");
  rmSync(wtDir, { recursive: true, force: true });
  assert.match(git(w, "worktree", "list"), /stale-wt/, "fixture must start with a prunable registration");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(git(w, "worktree", "list"), /stale-wt/, "the prune must still run and clear the stale registration");
});

// The other half of the same guard, and the half no test had: the default
// mode runs no prune at all, but the guard is the script's last statement, so
// the guard's SHAPE decides the dry run's exit status. Every other test here
// passes --apply, which is exactly how an AND-OR form regressed this path from
// 0 to a bare 1 under a fully green suite (#265).
test("the default dry run reports its verdict and exits 0, never a bare 1 (#265)", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const { code, json } = runReap(w, []);

  assert.equal(code, 0, "a dry run with nothing to report must exit 0, not the -e default of 1");
  assert.equal(json.applied, false);
  assert.deepEqual(json.reaped, ["feature/merged"], "a dry run still reports what it would reap");
  assert.equal(branchExists(w, "feature/merged"), true, "a dry run must not delete anything");
});

// #250. The usage guard was arity-only — it rejected a second argument and
// nothing looked at what a single one SAID, while the `--apply` test beside it
// demoted anything that was not exactly `--apply` to "not --apply". A mistyped
// flag therefore ran the dry run and reported it as one. Measured against the
// pre-fix script, `reap.sh --aply` exited 0 and printed
// `{"applied":false,"reaped":[],"kept":[]}` — the exit code and the payload of
// a deliberate dry run, with nothing anywhere saying the flag was not
// understood. The direction of the silence is the mild one (a typo'd `--apply`
// under-deletes), which is why it is a refusal rather than a data-loss bug.
//
// Exit 2 and an empty stdout do not on their own pin THIS guard: every later
// refusal in this script produces both, so a downstream one would satisfy the
// pair while the prologue let the argument through. What discriminates is what
// the run never reached — the fetch it echoes before running, and the dry-run
// banner — plus the branch still standing.
test("a mistyped --apply refuses instead of quietly running a dry run (#250)", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");

  const { code, json, stderr } = runReap(w, ["--aply"]);

  assert.equal(code, 2, "an unrecognised argument must refuse, not be demoted to 'not --apply'");
  assert.equal(json, null, "a refused invocation reports nothing — a payload here would read as a clean no-op");
  assert.match(stderr, /unrecognised argument '--aply'/, "the refusal must name the argument it did not understand");
  assert.doesNotMatch(stderr, /git fetch --prune origin/, "the guard is fatal and fires above the fetch");
  assert.doesNotMatch(stderr, /DRY RUN/, "a refusal must not also announce the dry run it used to become");
  assert.equal(branchExists(w, "feature/merged"), true, "a refused invocation deletes nothing");
});

// The other direction, and the one a new guard gets wrong: what it must still
// ACCEPT. Both accepted forms, against a fixture with a branch to act on, so a
// guard that refused either would be visible here rather than as a fleet run
// that stopped reaping.
test("the invocations reap.sh accepts are unchanged — bare and --apply (#250)", (t) => {
  for (const [args, applied] of [[[], false], [["--apply"], true]]) {
    const w = repo(t, `w-${applied}`);
    mergedGoneBranch(w, "feature/merged", "merged work");

    const { code, json, stderr } = runReap(w, args);

    assert.equal(code, 0, `\`reap.sh ${args.join(" ")}\` must still run: ${stderr}`);
    assert.equal(json.applied, applied);
    assert.deepEqual(json.reaped, ["feature/merged"], "the accepted forms still report what they reap");
    assert.doesNotMatch(stderr, /unrecognised argument/, "an accepted invocation must not be refused");
  }
});

// Arity is a separate arm from value, and the value guard's own message also
// carries the usage line — so `doesNotMatch` is what says two arguments took
// the arity path rather than falling through it into the new one.
test("two arguments still refuse via the arity path (#250)", (t) => {
  const w = repo(t);

  const { code, json, stderr } = runReap(w, ["a", "b"]);

  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /usage: reap\.sh \[--apply\]/);
  assert.doesNotMatch(stderr, /unrecognised argument/, "an arity refusal is not a value refusal");
});

// Third pin on the same table row, for the same reason as the two below: the
// row states this script's exit-2 contract in prose, #114 audited it while the
// guard was arity-only, and a reader trusting it draws a conclusion about a
// script that settings.json's autoMode allowlist lets run unattended. Taken
// from a real refusal rather than typed here — a hand-copied phrase drifts
// exactly the way the row did.
test("the design spec's script-surface row carries the argument refusal this script emits (#250)", (t) => {
  const w = repo(t);

  const { stderr } = runReap(w, ["--aply"]);

  // The label only: the argument itself is the caller's to vary and no doc can
  // carry it.
  const label = /^reap: (.+?) '/m.exec(stderr);
  assert.ok(label, `fixture must reach the argument refusal: ${stderr}`);

  const row = specRow();
  assert.ok(
    row.includes(label[1]),
    `the spec row must state this refusal, and does not carry "${label[1]}".\nrow: ${row}`,
  );
});

// The design spec's script-surface table states this script's exit-0 contract in
// prose, and it spent the whole life of #264 asserting the bug as the behaviour:
// "the merged check reads a `git cherry` that failed as 'no unmerged commits'
// and reaps the branch". Fixing that is one edited row; this is the part that
// keeps the next one from rotting silently — a reader trusting the table would
// draw the opposite safety conclusion about a script that settings.json's
// autoMode allowlist lets run unattended. Derived from a real run, never from a
// phrase typed here: a hand-copied phrase drifts from the script exactly the way
// the row did.
// Sibling pin, same table, same reason: no-undo-audit.test.mjs.
test("the design spec's script-surface row carries the keep reason this script actually emits", (t) => {
  const w = repo(t);
  unmergedGoneBranch(w, "feature/onlyhere", "sole copy, nowhere else");
  const bin = cherryShim(t);

  const { json } = runReap(w, ["--apply"], withShim(bin));

  // Everything up to the first colon: the label reap.sh chose, without git's
  // own message, which is the machine's to vary and no doc can carry.
  const label = json.kept[0].reason.split(":")[0].trim();
  assert.match(label, /^cherry probe failed/, "fixture must reach the failed-probe keep, not some other one");

  const row = specRow();
  assert.ok(
    row.includes(label),
    `the spec row must quote the keep reason verbatim, and does not carry "${label}".\nrow: ${row}`,
  );
});

// Worktree-removal coverage (#83, #128). Before this file, reap.sh's
// worktree-removal path had NO fixture at all: a merged [gone] branch was
// always tested without a worktree, so the dirty check, the linkage guard and
// the absent-directory path never ran under test.

test("a healthy clean worktree on a merged [gone] branch is reaped, directory and all", (t) => {
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  assert.ok(existsSync(wt), "fixture");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(stderr, /KEEP/);
  assert.equal(branchExists(w, "feature/merged"), false);
  assert.equal(existsSync(wt), false, "the worktree directory itself must be removed");
});

test("a dirty worktree on an otherwise-mergeable [gone] branch is kept, not reaped", (t) => {
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /^dirty worktree /);
  assert.match(stderr, /KEEP feature\/merged — dirty worktree/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(wt), true, "a dirty worktree must survive untouched");
});

// #730, and the reason the probe above carries `-uall`. The untracked mode is
// CONFIG: `git status --porcelain` honours `status.showUntrackedFiles`, so with
// it set to `no` the probe exits 0 with EMPTY output over a worktree holding
// untracked work. The `if !` idiom fails closed only on a NON-ZERO exit, so it
// never fires; `gp_cut_short` has no stderr to match; `[ -n "$gp_out" ]` reads
// clean. Measured on the unmodified script before the fix, with a control on
// the identical fixture: config set -> `REAPED feature/merged` at exit 0, the
// worktree directory and the untracked file gone, no KEEP and nothing on
// stderr; config unset -> `KEEP feature/merged — dirty worktree …`, file alive.
//
// A FLEET worktree deliberately, under `.worktrees/`: that home is exempt from
// the `--ignored` probe below, so this gate is the only thing between the file
// and `git worktree remove` — and `remove` without `--force` is no backstop,
// being the same machinery the same config silences.
//
// The config goes in the repo's own config, not GIT_CONFIG_GLOBAL: ENV already
// pins that to /dev/null, and the repo config is what a linked worktree shares
// — which is the point, since it is set from the main checkout and silences the
// worktree's probe.
test("a worktree holding untracked work is kept under status.showUntrackedFiles=no (#730)", (t) => {
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "precious.txt"), "untracked, and it exists nowhere else\n");
  git(w, "config", "status.showUntrackedFiles", "no");
  // The fixture's own positive control. Without it a git that stopped honouring
  // the config would leave this test green while pinning nothing at all.
  assert.equal(git(wt, "status", "--porcelain"), "",
    "fixture: the config must really silence the unpinned probe, or this test measures nothing");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  // The reason, not merely the keep: several other guards also leave `reaped`
  // empty, so the pair alone does not say which one answered.
  assert.equal(json.kept[0].reason, `dirty worktree ${wt}`);
  assert.match(stderr, /KEEP feature\/merged — dirty worktree/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(readFileSync(join(wt, "precious.txt"), "utf8"), "untracked, and it exists nowhere else\n",
    "the untracked file must survive the run — this is the data loss the ticket measured");
});

test("an ignored file is still seen under status.showUntrackedFiles=no (#730)", (t) => {
  // The backstop, and it is the SAME machinery as the gate above — so one
  // config silences both and the defence in depth is only apparent. Measured on
  // this fixture: under `showUntrackedFiles = no`, `--porcelain --ignored`
  // answers 0 bytes at rc 0, the `!!` lines suppressed along with the `??`
  // ones, so a precious ignored file reads as absent. Outside `.worktrees/`
  // this probe is the only thing left between a merged, linked, tracked-clean
  // worktree and a `git worktree remove` that deletes ignored files silently
  // under every config.
  //
  // No untracked file in this fixture, only an ignored one: the plain scan
  // above answers empty either way, so the verdict here is the `--ignored`
  // probe's alone and a fix applied to only the first site fails this test.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "outside"));
  writeFileSync(join(wt, ".env"), "SECRET=exists nowhere else\n");
  git(w, "config", "status.showUntrackedFiles", "no");
  assert.equal(git(wt, "status", "--porcelain", "--ignored"), "",
    "fixture: the config must silence the unpinned --ignored probe, or this test measures nothing");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /^ignored files present in .*: \.env$/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(readFileSync(join(wt, ".env"), "utf8"), "SECRET=exists nowhere else\n",
    "the precious ignored file must survive the run");
});

// #614: the BEHAVIOURAL twin of locale-pin-prose.test.mjs' source assertion for
// this script — that file checks `export LC_ALL=C` is PRESENT, this one checks
// it is load-bearing.
//
// The ambient locale must reach the child genuinely, not merely differ from
// `C`: a POSIX shell keeps a variable's export attribute once it is already in
// the environment, so seeding `LC_ALL: "en_US.UTF-8"` here would leave a mutant
// that drops only the `export` keyword still propagating `C` downstream. `LANG`
// with `LC_ALL` and `LC_CTYPE` absent is what an unset `LC_ALL` really looks
// like — the shape #599's own regression test got wrong.
const AMBIENT_UTF8 = { LANG: "en_US.UTF-8", LC_ALL: undefined, LC_CTYPE: undefined };

// CEILING: this kills its mutant on macOS only. BWK awk aborts (rc 2,
// `towc: multibyte conversion failure`) on a record it must scan past and
// cannot convert to wide characters; gawk 5.4.1 and mawk 1.3.4 both answer
// rc 0 on the same input, so on `ubuntu-latest` — the one platform ci.yml runs
// — the unpinned script already gives the right answer and this test is
// vacuous. It asserts the CORRECT answer, so it is green on both. #790.
//
// The byte reaches the sweep through the registry, never the filesystem: APFS
// refuses the name outright, but `git worktree list --porcelain` derives the
// path it prints from the entry's `gitdir` file and emits it raw and unquoted.
// One such SIBLING entry is enough — awk tests every rule against every record,
// so the `/^branch /` rule scans the bad `worktree` record and dies there,
// taking the lookup for the branch actually under sweep with it.
//
// Measured with the pin deleted: awk itself dies (`towc: multibyte conversion
// failure`), and because this script runs under `set -eu` that failing command
// substitution (line ~347) TERMINATES the whole script at exit 2 — nothing is
// reaped, `feature/merged`'s branch and its uncommitted work both survive.
// This test still catches the mutant (`assert.equal(code, 0)` fails, `2 !== 0`)
// — only the narrative below used to be wrong, not the test. What this pins is
// that the sweep must not silently ABORT mid-run on a sibling's bad path,
// leaving the caller to guess whether anything was mutated before the crash —
// not a data-loss-prevented story, since data loss was never actually
// reachable here.
test("an invalid UTF-8 byte in a SIBLING worktree's registered path does not cost a dirty worktree its keep (#614)", (t) => {
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const other = join(w, ".worktrees", "other");
  git(w, "worktree", "add", "-q", other, "-b", "feature/other", "main");
  relocate(w, other, `${w}/.worktrees/bÿad`);

  const { code, json, stderr } = runReap(w, ["--apply"], AMBIENT_UTF8);

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.deepEqual(json.reaped, []);
  const kept = json.kept.find((k) => k.branch === "feature/merged");
  assert.ok(kept, `feature/merged must still be kept, got ${JSON.stringify(json.kept)}`);
  assert.match(kept.reason, /^dirty worktree /);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(join(wt, "scratch.txt")), true, "the uncommitted work must survive untouched");
});

test("a status probe that dies (rc 128) is kept with git's own message, not just a label (#625)", (t) => {
  // Before #625, this probe's stderr went to /dev/null and the reason named
  // only the step ("could not be read"), never the fault. Git's own message —
  // here the admin path it names — is the whole remedy signal, and it used to
  // reach nobody but the terminal that ran this by hand.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");

  const bin = failOnlyShim(
    t,
    STATUS_PROBE,
    ["fatal: not a git repository: /some/admin/path"],
    128,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "an unanswerable probe is not a script failure");
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /^worktree .* could not be read: /);
  assert.match(json.kept[0].reason, /fatal: not a git repository: \/some\/admin\/path/, "git's own message must reach the reason");
  assert.match(stderr, /KEEP feature\/merged/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(wt), true);
});

test("a clean worktree with a warning on the plain status probe's stderr is still reaped, never misread as dirty (#625)", (t) => {
  // The control that proves the fix keeps the two streams apart rather than
  // folding them with `2>&1`. Folded, this warning would land IN the value
  // the dirty-check tests with `[ -n ]`, and a clean worktree would read as
  // dirty and never be reaped again — silently, and looking like correct,
  // conservative behavior. Left at the old `2>/dev/null`, this test would
  // still pass; it exists to catch a REGRESSION to the merged-stream mistake,
  // not to distinguish the fix from the original bug.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");

  const bin = failOnlyShim(
    t,
    STATUS_PROBE,
    ["warning: unrelated advice from git, not about this worktree's contents"],
    0,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assertShimFired(bin, "the warning never reached the dirty check — the rest of this arm passes on any fixture");
  assert.equal(code, 0);
  assert.deepEqual(json.kept, [], "a warning unrelated to dirtiness must not keep this branch");
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.doesNotMatch(stderr, /dirty worktree/, "the warning must never be read as dirty content");
  assert.equal(branchExists(w, "feature/merged"), false);
  assert.equal(existsSync(wt), false);
});

test("an `--ignored` probe that warns at rc 0 is kept, listing incomplete, never read as an empty answer (#625)", (t) => {
  // Measured, PR #726 review: a `chmod 000` ignored directory made exactly
  // this probe print a permission warning and exit 0 — not a failure this
  // script's rc check ever saw, and not a keep either, so the run proceeded to
  // reap a worktree it had provably not finished reading. `--ignored` OPENS
  // every ignored path to list what's inside, unlike the plain scan above,
  // which is what makes this probe (and only this one) able to reach that
  // warning at all.
  const w = repo(t);
  // Outside .worktrees/: that home exempts the ignored-file probe entirely, so
  // this fixture has to sit elsewhere for the probe to run at all.
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "outside"));
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so only the --ignored probe can decide");

  const bin = failOnlyShim(
    t,
    IGNORED_PROBE,
    ["warning: could not open directory 'secret/': Permission denied"],
    0,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /^worktree .* status --ignored warned, listing may be incomplete: /);
  assert.match(json.kept[0].reason, /Permission denied/, "git's own warning must reach the reason");
  assert.match(stderr, /KEEP feature\/merged/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(wt), true);
});

test("a plain status probe that warns its walk was cut short keeps the branch, never reads the empty answer as clean (#625)", (t) => {
  // The other half of the same asymmetry. `git status --porcelain` opens
  // UNTRACKED directories, so an unreadable one makes it warn at rc 0 and
  // answer EMPTY — measured, git 2.50.1 (Apple Git-155). The rc check above
  // never fires, `[ -n "$gp_out" ]` reads the empty answer as clean, and
  // `--apply` deletes a worktree holding work git had provably not finished
  // listing. This is the fleet-worktree path: `.worktrees/` is exempt from the
  // `--ignored` probe, so the plain scan is the ONLY probe that can catch it.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");

  const bin = failOnlyShim(
    t,
    STATUS_PROBE,
    ["warning: could not open directory 'wip/': Permission denied"],
    0,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /^worktree .* status warned, listing may be incomplete: /);
  assert.match(json.kept[0].reason, /could not open directory 'wip\/': Permission denied$/, "git's own warning must reach the reason, and end it");
  assert.match(stderr, /KEEP feature\/merged/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(wt), true, "a worktree git could not finish reading must survive");
});

test("ambient git noise on the `--ignored` probe's stderr does not strand a clean worktree (#625)", (t) => {
  // The gate's other failure direction, and the one a plain `[ -n "$gp_err" ]`
  // walks straight into: a global gitconfig with a key outside any section
  // makes EVERY git command print this at rc 0 — the same fault this file's
  // rev-parse probe is redirected for — while leaving the listing COMPLETE.
  // Gated on stderr merely existing, every worktree outside `.worktrees/` is
  // kept for as long as the operator's config stays broken, with a reason
  // blaming the worktree for a fault in ~/.gitconfig.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "noisy"));

  const bin = failOnlyShim(
    t,
    IGNORED_PROBE,
    ["error: key does not contain a section: stray"],
    0,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assertShimFired(bin, "the noise never reached the `--ignored` gate — the rest of this arm passes on any fixture");
  assert.equal(code, 0);
  assert.deepEqual(json.kept, [], "noise that left the listing whole must not keep this branch");
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.doesNotMatch(stderr, /listing may be incomplete/, "a complete listing must never be reported as incomplete");
  assert.equal(branchExists(w, "feature/merged"), false);
  assert.equal(existsSync(wt), false);
});

test("an `--ignored` probe that DIES is kept with git's own message, not just a label (#625)", (t) => {
  // Sibling of the plain probe's rc-128 test above, for the branch this file
  // had no coverage of at all: the rc check on the `--ignored` probe. The keep
  // is unconditional either way, so what is at stake is only the diagnostic
  // text — which is the entire thing #625 exists to preserve.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "outside-dead"));

  const bin = failOnlyShim(
    t,
    IGNORED_PROBE,
    ["fatal: unable to read index file .git/index"],
    128,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "an unanswerable probe is not a script failure");
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.equal(
    json.kept[0].reason,
    `worktree ${wt} unreadable (git status --ignored failed): fatal: unable to read index file .git/index`,
    "git's message must reach the reason whole — and the reason must not trail a separator or a space",
  );
  assert.match(stderr, /KEEP feature\/merged/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(wt), true);
});

test("the branchless sweep's status probe reports git's own message when it dies, too (#625)", (t) => {
  // The third call site. The branch sweep's two probes got #625 coverage; this
  // copy — the one the detached/branchless sweep runs, and the only probe a
  // worktree that wandered off its branch is ever measured by — got none, so a
  // regression here reverted silently under a green suite.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");

  const bin = failOnlyShim(
    t,
    STATUS_PROBE,
    ["fatal: not a git repository: /some/admin/path"],
    128,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "an unanswerable probe is not a script failure");
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, null, "the branchless sweep has no branch to name");
  assert.equal(
    json.kept[0].reason,
    `worktree ${wt} could not be read: fatal: not a git repository: /some/admin/path`,
    "git's message must reach the reason whole — and the reason must not trail a separator or a space",
  );
  assert.match(stderr, /KEEP \(no branch\)/);
  assert.equal(existsSync(wt), true, "a worktree that could not be read must survive");
});

test("the branchless sweep keeps a worktree whose status walk was cut short, too (#625)", (t) => {
  // The third call site's copy of the gate, on the same rc-0 shape the branch
  // sweep's copy is pinned against above. Without it a detached worktree whose
  // walk git could not finish reads as clean here as well, and this sweep
  // removes the directory outright — there is no branch left to keep as a
  // second chance.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");

  const bin = failOnlyShim(
    t,
    STATUS_PROBE,
    ["warning: could not open directory 'wip/': Permission denied"],
    0,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, [], "a walk git could not finish is not grounds to remove");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, null);
  assert.equal(
    json.kept[0].reason,
    `worktree ${wt} status warned, listing may be incomplete: warning: could not open directory 'wip/': Permission denied`,
  );
  assert.match(stderr, /KEEP \(no branch\)/);
  assert.equal(existsSync(wt), true);
});

test("a [gone] branch whose worktree directory was deleted by hand is reaped, never kept as dirty (#83)", (t) => {
  // The bug: `|| echo dirty` folds ANY failed status — including one that
  // failed because the directory is not there at all — into "dirty", pinning
  // the branch forever. A deleted worktree holds nothing to protect.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  rmSync(wt, { recursive: true, force: true });
  assert.match(git(w, "worktree", "list"), /feature\/merged/, "fixture: the stale registration must still be listed");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"], "a directory that is not there holds no work to protect");
  assert.deepEqual(json.kept, []);
  assert.equal(branchExists(w, "feature/merged"), false);
  assert.doesNotMatch(git(w, "worktree", "list"), /feature\/merged/, "the stale registration must not survive the run");
});

test("a dry run and --apply agree about a deleted worktree directory (#128)", (t) => {
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  rmSync(wt, { recursive: true, force: true });

  const dry = runReap(w, []);
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.json.reaped, ["feature/merged"], "a dry run must predict the same outcome --apply produces");
  assert.deepEqual(dry.json.kept, []);

  const applied = runReap(w, ["--apply"]);
  assert.deepEqual(applied.json.reaped, ["feature/merged"]);
});

test("a [gone] branch checked out in the MAIN checkout is kept, with the reason that is true", (t) => {
  // The enumeration does not exclude the main worktree: `worktree list
  // --porcelain` emits a `branch refs/heads/...` line for it, so a [gone]
  // branch checked out there binds $wt to the main checkout. Its `.git` is a
  // DIRECTORY, so the `-f` linkage guard read it as "no .git linkage" — false;
  // git answers about that repo correctly through it. Both halves matter and
  // are asserted separately: the reason must be true, and the dry run must not
  // promise a reap that `git worktree remove` and `git branch -D` both refuse.
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  git(w, "checkout", "-q", "feature/merged");

  const dry = runReap(w, []);
  const applied = runReap(w, ["--apply"]);

  for (const { json } of [dry, applied]) {
    assert.deepEqual(json.reaped, []);
    assert.equal(json.kept.length, 1);
    assert.equal(json.kept[0].branch, "feature/merged");
    assert.match(json.kept[0].reason, /is the main checkout/);
    assert.doesNotMatch(json.kept[0].reason, /no \.git linkage/, "git answers correctly through a .git directory");
  }
  assert.deepEqual(dry.json.kept, applied.json.kept, "a dry run must predict what --apply produces");
  assert.equal(branchExists(w, "feature/merged"), true);
});

test("a worktree behind an unreadable parent is kept, never reaped as clean", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "precious.txt"), "work that exists nowhere else\n");
  const parent = join(w, ".worktrees");

  chmodSync(parent, 0o000);
  const { code, json, stderr } = runReap(w, ["--apply"]);
  chmodSync(parent, 0o755);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /cannot tell whether worktree/);
  assert.doesNotMatch(json.kept[0].reason, /dirty/, "an unanswerable probe must not be misreported as a dirty one");
  assert.match(stderr, /KEEP feature\/merged — cannot tell whether worktree/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(readFileSync(join(wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});


test("a worktree with no surviving ancestor below / is reaped, never kept as unanswerable (#178)", (t) => {
  // The escalation of the case above: there the parent could not be SEARCHED,
  // which is genuinely unknown and must keep. Here every ancestor below `/` is
  // absent — but `${p%/*}` on `/x` yields the empty string rather than `/`, so
  // the walk fell out on "" and `[ -x "" ]` answered unknown for a path that is
  // provably absent with a searchable root. That kept a merged branch forever
  // on a directory holding nothing, which is the refusal `gone` exists to end.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  const dest = relocate(w, wt, "/nonexistent-top-level-178/wt");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, [], `an absent path with a searchable root is not an unknown one: ${JSON.stringify(json.kept)}`);
  // The keep's own wording, not just an empty `kept`: any other keep reason
  // would also leave `reaped` short, so the pair alone does not say which
  // question was answered wrong.
  assert.doesNotMatch(stderr, /cannot tell whether worktree/);
  assert.ok(!stderr.includes(`dirty worktree ${dest}`), "and it is never guessed dirty either");
  assert.equal(branchExists(w, "feature/merged"), false);
});

test("a worktree whose .git file is gone is kept, never reaped as clean (#128)", (t) => {
  // The directory EXISTS (so a bare `[ -e ]` says present) and `git -C` does
  // not fail on a missing `.git` — it walks UP to the enclosing repo and
  // answers about THAT at rc 0. `.worktrees/` gitignored and the parent clean
  // makes the leaked answer empty: a positive "clean" produced without ever
  // looking at the worktree, which the old code would have reaped on.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n");
  git(w, "add", ".gitignore");
  git(w, "commit", "-q", "-m", "ignore the worktrees dir");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "precious.txt"), "work that exists nowhere else\n");
  rmSync(join(wt, ".git"));
  assert.equal(git(w, "status", "--porcelain"), "", "fixture: the leaked answer really is an empty one");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /no \.git linkage/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(wt), true, "the worktree directory and its work must survive untouched");
  assert.equal(readFileSync(join(wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});

test("a worktree whose .git is a dangling symlink is kept, never reaped as clean (#128)", (t) => {
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n");
  git(w, "add", ".gitignore");
  git(w, "commit", "-q", "-m", "ignore the worktrees dir");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  rmSync(join(wt, ".git"));
  symlinkSync(join(wt, "nowhere"), join(wt, ".git"));

  const { json } = runReap(w, ["--apply"]);

  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /no \.git linkage/);
  assert.equal(branchExists(w, "feature/merged"), true);
});

test("a non-fleet worktree holding an ignored file is kept, never reaped", (t) => {
  // The one keep the worktree-present branch owns that nothing else here
  // reaches. `git worktree remove` refuses on modified and untracked files but
  // deletes IGNORED ones silently, so outside `.worktrees/` — where an ignored
  // file is a .env or a scratch note that exists nowhere else — the
  // `--ignored` probe is the only thing left between a merged, linked,
  // tracked-clean worktree and `git branch -D`. Every earlier guard passes by
  // construction, which is what makes this test see that probe and only it.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  // Deliberately NOT under `.worktrees/`: that home is what the case statement
  // keys the fleet exemption on, and a fleet worktree is reaped WITH its
  // machine-generated ignored files.
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "outside"));
  writeFileSync(join(wt, ".env"), "SECRET=exists nowhere else\n");
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so only the --ignored probe can keep it");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  // The reason, not just the keep: every other guard in this branch also
  // leaves `reaped` empty, so the pair alone does not say which one answered.
  assert.match(json.kept[0].reason, /^ignored files present in .*: \.env$/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(readFileSync(join(wt, ".env"), "utf8"), "SECRET=exists nowhere else\n", "the precious file must survive the run");
});

test("a non-fleet worktree with NO ignored file is reaped — the control for the case above", (t) => {
  // Without this, the test above passes on a reap.sh that keeps every
  // non-fleet worktree unconditionally: it would be pinning the `.worktrees/`
  // arm of the case, not the `--ignored` probe inside it. Same fixture, one
  // difference — the ignored file — and the opposite verdict.
  //
  // It is also the exit-status control for this branch. Reached with
  // `$ignored` empty, the `if [ -n "$ignored" ]` is the last command of the
  // worktree-present branch, and a condition that tests false leaves an `if`
  // with no `else` at status 0. Under `set -eu` any other answer would abort
  // the sweep here, after the earlier branches were already deleted.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  // Deliberately NOT under `.worktrees/`, same as the case above.
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "outside"));
  // and NO .env written this time

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0, "the sweep must not abort under set -eu on the branch's own last command");
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.equal(branchExists(w, "feature/merged"), false);
  assert.equal(existsSync(wt), false, "the worktree directory goes with it");
});

test("a FLEET worktree under `.worktrees/` is reaped, ignored file and all", (t) => {
  // The other arm of `case "$wt" in */.worktrees/*) : ;; *) ...ignored-check... ;; esac`.
  // The pair above reaches the `--ignored` keep from OUTSIDE that home, so both
  // pin the `*)` arm; nothing pinned the exemption itself. Measured BEFORE this
  // test existed: mutating the pattern to one that never matches — routing every
  // fleet worktree through the keep and stranding all of them, the regression the
  // comment at reap.sh's case statement warns about — left this file 37/37 green.
  // It now fails here, and only here.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  // The home is the ONLY difference from the pair above: same ignored file, same
  // tracked-clean worktree, opposite verdict.
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, ".env"), "AGENT_TEST=machine-generated\n");
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so only the --ignored probe could keep it");
  assert.match(git(wt, "status", "--porcelain", "--ignored"), /^!! \.env$/m, "fixture: the file really is ignored, or the exemption is untested");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.equal(existsSync(wt), false, "the exemption reaps a fleet worktree WITH its machine-generated ignored files");
});

test("a repo path containing a space still finds and reaps the branch's worktree", (t) => {
  const w = repo(t, "my repos");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"]);
  assert.deepEqual(json.kept, []);
  assert.equal(existsSync(wt), false);
});

test("a repo path containing a space still finds a dirty worktree and keeps it", (t) => {
  const w = repo(t, "my repos");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /^dirty worktree /);
  assert.ok(json.kept[0].reason.includes("/my repos/.worktrees/feature/merged"), json.kept[0].reason);
});

// --- #119: the payload's own string fields.
//
// `keep()` splices its two arguments raw, and five call sites reach it: the
// branch name, `dirty worktree $wt`, `ignored files present in $wt: $ignored`,
// the `reaped` accumulator, and `cherry probe failed …: $cherry`, which routes
// arbitrary git stderr. The branch name is the demonstrated trigger — measured
// on the pre-fix script, an unmerged `[gone]` branch named `feat/has"quote`
// produced `{"branch":"feat/has"quote",…}` at exit 0 and `JSON.parse` failed at
// position 56. The script's decision was correct throughout; what broke was the
// sole machine-readable record of it.
test("a quote in a [gone] branch name still emits parseable JSON", (t) => {
  const w = repo(t);
  unmergedGoneBranch(w, 'feat/has"quote', "work nobody merged");

  const { code, json, stderr } = runReap(w, []);

  assert.equal(code, 0, "a kept branch is a finding at exit 0, quote or no quote");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, 'feat/has"quote',
    "the field round-trips to the name that went in — `runReap` JSON.parses stdout, so an unescaped splice fails here before this assert runs");
  assert.equal(json.kept[0].reason, "unmerged commits");
  assert.ok(branchExists(w, 'feat/has"quote'), "and it is still there: escaping must not change what gets deleted");
  assert.match(stderr, /KEEP feat\/has"quote/, "the human line stays raw — it is prose, not JSON");
});

test("git's own stderr reaches the payload escaped, not raw", (t) => {
  // The fifth interpolation, and the only one that carries text neither this
  // repo nor its operator chose. Real `git cherry` corruption output happens to
  // carry no quote, which makes this the least likely of the five to fire —
  // and the one with the least control over what it splices when it does.
  const w = repo(t);
  unmergedGoneBranch(w, "feature/onlyhere", "work");
  // `failOnlyShim` emits each line through `printf '%s\n'`, so the `"` this test
  // exists to chase reaches git's stderr as data — the payload has something
  // real to escape.
  const bin = failOnlyShim(t, `[ "$1" = cherry ]`, ['error: unable to open loose object "deadbeef cafe": Permission denied'], 128);

  const { code, json } = runReap(w, [], withShim(bin));

  assert.equal(code, 0);
  assert.match(json.kept[0].reason, /cherry probe failed/);
  assert.match(json.kept[0].reason, /"deadbeef cafe"/,
    "the quotes survive as data rather than terminating the JSON string");
});

test("an ordinary branch name is untouched — the escaping accepts what it should", (t) => {
  // The false-positive half. Nothing here has anything to escape, so the
  // payload must be exactly what this script has always emitted.
  const w = repo(t);
  unmergedGoneBranch(w, "fix/119-json-sh-extract", "work");

  const { code, json } = runReap(w, []);

  assert.equal(code, 0);
  assert.deepEqual(json, {
    applied: false,
    reaped: [],
    worktreesRemoved: [],
    kept: [{ branch: "fix/119-json-sh-extract", reason: "unmerged commits" }],
  });
});

test("a reaped branch name is escaped too — the other accumulator", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, 'chore/re"aped', "work that landed");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ['chore/re"aped'],
    "`reaped` is built by its own accumulator, not by keep() — escaping one and not the other leaves half the payload broken");
  assert.equal(branchExists(w, 'chore/re"aped'), false, "and it really was deleted");
});

// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run. This script's
// contract is exit 0 or exit 2 with no exit 1 at all (#265), and the guard sits
// ahead of the fetch, so a missing library refuses before anything is deleted.
test("a missing json.sh is exit 2, before any branch is deleted", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "chore/landed", "work that landed");
  const lone = mkdtempSync(join(tmpdir(), "reap-nolib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "reap.sh"));

  const r = spawnSync("sh", [join(lone, "reap.sh"), "--apply"], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 2, "a missing library is a refusal — this script has no exit 1 to be confused with");
  assert.match(r.stderr, /json\.sh/, "and it names the file rather than blaming the fetch or the base ref");
  assert.equal(r.stdout, "", "no payload: nothing happened");
  assert.ok(branchExists(w, "chore/landed"),
    "and the branch is still there — the guard fires ahead of every deletion, so this is a clean refusal");
});

// --- #391: the reason a keep carries, on the three calls that derived it from
// an exit code and sent git's own diagnosis to /dev/null.
//
// Measured before this suite existed, by mutating each arm and re-running the
// file: garbling the `worktree remove` reason and garbling the `branch -D`
// reason each left all 24 tests green. Both arms were invisible.

/**
 * Put a symlink where the worktree directory was, keeping the registration
 * pointed at the symlink's path — the shape that makes `git worktree remove`
 * fail AFTER it has already cleared the admin entry.
 *
 * Measured, git 2.50.1 (Apple Git-155): rc 255,
 * `error: failed to delete '<wt>': Not a directory`, the porcelain no longer
 * lists the entry, and both the symlink and its target survive on disk.
 *
 * Chosen over a `chmod 555` parent, which produces the same deregistered state
 * by a different route: this one reproduces as any user, needs no permission
 * bits, and so carries none of the euid-0 vacuity the `0o000` fixtures in this
 * file already have to skip around (#184). Every guard ahead of the removal
 * still passes through it — `.git` is a regular file and `git -C` follows the
 * link, so the linkage guard and the status probe both answer about the real
 * worktree.
 */
function symlinkStandIn(wt) {
  const real = `${wt}-real`;
  renameSync(wt, real);
  symlinkSync(real, wt);
  return real;
}

const withShim = (bin) => ({ PATH: `${bin}:${ENV.PATH}` });

// Every shim test above and below routes through this helper, and gross damage
// here fails LOUDLY: drop the tail and every one of them goes red, reverse the
// order and all but one does — the shim stops shadowing `git`, or the real
// toolchain stops resolving. What none of them can see is a tail that stays
// PLAUSIBLE. An empty entry (`::` — that is the CWD) or a duplicated one leaves
// the shim first and every tool still findable, so the whole file stays green
// while reap.sh runs on a PATH nobody meant; the PATH equality below is the
// only thing in this file that catches that class. The Object.keys line covers
// the other invisible one: runReap spreads this over ENV, so a second key here
// would clobber one of ENV's git-scrubbing entries and the fixtures would
// quietly start reading the developer's ~/.gitconfig. The tail asserts against
// `process.env.PATH`, not `ENV.PATH`: ENV spreads process.env and never sets
// PATH, and that identity is exactly what lets this helper spell the tail
// without the `?? process.env.PATH` fallback its call sites used to.
test("withShim prepends the shim dir, keeps the real PATH, and sets nothing else", () => {
  assert.equal(withShim("/x/bin").PATH, `/x/bin:${process.env.PATH}`);
  assert.deepEqual(Object.keys(withShim("/x/bin")), ["PATH"]);
});

test("a refusal that CLEARED the registration is reported as a partial removal, not as a no-op (#391)", (t) => {
  // The worst of the two: git unregistered the worktree and then failed to
  // delete it, so the run reported `worktree remove refused` — indistinguishable
  // from "nothing happened" — while leaving an orphaned directory behind and
  // the branch standing as though it had been deliberately retained.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  const real = symlinkStandIn(wt);

  // A second registration whose path merely BEGINS with the refused one. The
  // probe has to match a whole porcelain line, not a substring: without the
  // anchor this entry keeps matching after the refused one is gone, and the
  // run reports "registration intact" for a registration that was cleared —
  // measured, an unanchored grep survived every other test here. Its branch
  // has no upstream, so it is not [gone] and reap never touches it.
  git(w, "worktree", "add", "-q", `${wt}-sibling`, "-b", "scratch/sibling", "main");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0, "a refusal is a finding, not a script failure");
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(
    json.kept[0].reason,
    /registration cleared/,
    `a refusal that unregistered the worktree must not read as a no-op: ${json.kept[0].reason}`,
  );
  assert.match(json.kept[0].reason, /Not a directory/, "git's own diagnosis must reach the payload");
  assert.doesNotMatch(json.kept[0].reason, /\n/, "git's stderr is multi-line; the reason must be flattened");
  assert.match(stderr, /KEEP feature\/merged — worktree remove refused/);

  // The registration really is gone — the state the reason claims, measured.
  // Compared whole-line, for the reason the script's own probe is: a substring
  // test against this porcelain matches the sibling entry below and would call
  // a cleared registration intact. (This assertion was written unanchored
  // first, and the sibling caught it.)
  const reg = git(w, "worktree", "list", "--porcelain").split("\n");
  assert.ok(!reg.includes(`worktree ${wt}`), `the refused worktree's registration must be gone: ${reg.join(" | ")}`);
  assert.ok(reg.includes(`worktree ${wt}-sibling`), "fixture: the prefix-sharing sibling must still be registered");
  // ...and nothing on disk was removed by this script, under any path.
  assert.ok(lstatSync(wt).isSymbolicLink(), "the stand-in symlink must survive");
  assert.equal(existsSync(real), true, "the orphaned directory is not this script's to delete");
  assert.equal(branchExists(w, "feature/merged"), true, "and the branch is still kept");
});

test("a refusal that LEFT the registration in place is reported as such, distinctly (#391)", (t) => {
  // The other half, and the half the old message happened to describe
  // correctly — asserted so the two outcomes cannot collapse back into one
  // string. A locked worktree exits 128 with the admin entry untouched
  // (measured, git 2.50.1). Per the brief this needs no dedicated arm: once
  // git's stderr is quoted, the lock names itself and its own remedy.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  git(w, "worktree", "lock", wt);

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(
    json.kept[0].reason,
    /registration intact/,
    `a refusal that changed nothing must say so: ${json.kept[0].reason}`,
  );
  assert.doesNotMatch(json.kept[0].reason, /registration cleared/, "the two outcomes must not collapse into one reason");
  assert.match(json.kept[0].reason, /locked working tree/, "git's message names the fault and the remedy");
  assert.match(json.kept[0].reason, /remove -f -f/, "including the remedy, which only git can supply");
  assert.doesNotMatch(json.kept[0].reason, /\n/, "git's message here really is two lines — it must arrive flattened");
  assert.match(stderr, /KEEP feature\/merged/);

  assert.match(git(w, "worktree", "list", "--porcelain"), /feature\/merged/, "the registration really did survive");
  assert.equal(existsSync(wt), true);
  assert.equal(branchExists(w, "feature/merged"), true);
});

test("a refusal whose registration a PEER cleared claims nothing about the directory (#391)", (t) => {
  // The registry and the directory are INDEPENDENT facts, and the reason may
  // only carry the one that was read. Shape: a concurrent session finishes the
  // same removal between this run's lookup and its own `git worktree remove`
  // — the concurrency reap.sh's own header documents — so the registration is
  // cleared, our removal fails, and NOTHING is left behind. A reason that
  // hard-codes "removal was partial — $wt is still on disk" reports an orphan
  // that does not exist, and this ticket exists because a reason that names
  // something other than what was measured is the defect.
  //
  // Neither arm above can catch that: in the symlink shape the directory
  // happens to survive, so both stay green with the false clause in place —
  // measured, 907/907, which is why this arm is here at all.
  //
  // The shim runs the PEER's removal with the real git and then returns false,
  // so the `exec` below it runs OUR removal for real and it fails in git's own
  // words. No permission bits, hence none of the euid-0 vacuity the `0o000`
  // fixtures in this file have to skip around (#184).
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  const bin = failOnlyShim(
    t,
    `[ "$1" = worktree ] && [ "$2" = remove ] && { ${REAL_GIT} worktree remove "$3" >/dev/null 2>&1; false; }`,
    [],
  );

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  // Both halves of the fixture, asserted before the reason is read: the peer
  // really did finish the job, so "still on disk" would be false and
  // "registration cleared" true.
  assert.equal(existsSync(wt), false, "fixture: the peer's removal must leave nothing on disk");
  assert.ok(
    !git(w, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${wt}`),
    "fixture: the peer's removal must clear the registration",
  );

  assert.equal(code, 0, "a refusal is a finding, not a script failure");
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.match(
    json.kept[0].reason,
    /registration cleared/,
    `the registry is what was read, and it says cleared: ${json.kept[0].reason}`,
  );
  assert.doesNotMatch(
    json.kept[0].reason,
    /on disk|orphan|removal was partial/,
    `nothing stat'd the directory, so the reason must claim nothing about it: ${json.kept[0].reason}`,
  );
  assert.match(json.kept[0].reason, /is not a working tree/, "git's own diagnosis still reaches the payload");
  assert.equal(branchExists(w, "feature/merged"), true);
});

test("the sweep continues past a worktree-removal refusal and still reaps the branches AFTER it (#391)", (t) => {
  // The constraint that separates this ticket's ruling from #208's: reap.sh
  // sweeps every [gone] branch unattended in one pass, so one orphan must not
  // strand the rest. The new registry re-read runs inside that loop, which is
  // exactly where an added git call could introduce a bail.
  //
  // The `a-`/`b-` names are load-bearing, not decoration. `git for-each-ref`
  // sorts by refname, so a healthy branch named to sort FIRST is already
  // reaped before the refusal happens and the test passes under a `break`
  // just as happily as under a `continue`. Measured both ways on this branch,
  // rather than carrying a count that drifts every time a test is added: under
  // the alternative spelling the whole file stays green with the mutant in
  // place, and under the shipped one exactly this test reds.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/a-locked", "work behind a lock");
  git(w, "worktree", "lock", wt);
  mergedGoneBranch(w, "feature/b-healthy", "work that landed");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/b-healthy"], "the refusal must not strand the branches after it");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/a-locked");
  assert.equal(branchExists(w, "feature/b-healthy"), false, "reached only by continuing past the refusal");
  assert.equal(branchExists(w, "feature/a-locked"), true);
});

test("a `git branch -D` failure carries git's own message, not just the label (#391)", (t) => {
  // `>/dev/null 2>&1` sent the cause to the void and reported "branch delete
  // failed". The real message names the fault outright — the shim reproduces
  // the one measured in the wild, plus a second line, since the reason has to
  // survive as a single JSON string.
  //
  // The shim is scoped to one branch, and a healthy branch sorts after it, so
  // this also pins the other half of "the sweep continues past EITHER failure".
  const w = repo(t);
  mergedGoneBranch(w, "feature/a-broken", "merged work");
  mergedGoneBranch(w, "feature/b-healthy", "work that landed");
  const bin = failOnlyShim(
    t,
    `[ "$1" = branch ] && [ "$2" = -D ] && [ "$3" = feature/a-broken ]`,
    [`error: cannot delete branch 'feature/a-broken' used by worktree at '/some/where'`, "fatal: could not update ref"],
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/b-healthy"], "a branch that was not deleted must not be reported as reaped, and the sweep goes on");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/a-broken");
  assert.match(json.kept[0].reason, /^branch delete failed: /, "the label stays — it is the reason that gains a cause");
  assert.match(json.kept[0].reason, /used by worktree at/, "git's diagnosis must reach the payload");
  assert.match(json.kept[0].reason, /could not update ref/, "both lines, not just the first");
  assert.doesNotMatch(json.kept[0].reason, /\n/, "flattened into one JSON string");
  assert.match(stderr, /KEEP feature\/a-broken — branch delete failed/);
  assert.equal(branchExists(w, "feature/a-broken"), true);
  assert.equal(branchExists(w, "feature/b-healthy"), false, "reached only by continuing past the failure");
});

test("a dying `git worktree list` still reaps what it can, and quotes git for what it cannot (#391)", (t) => {
  // The pipeline into awk takes awk's status, never git's, so a dying list
  // leaves $wt empty: every check under `[ -n "$wt" ]` is skipped and flow
  // falls through to `git branch -D`. That was #391's visible symptom — the
  // payload blamed the branch delete for a failure two steps earlier, under a
  // bare label, while git's own `fatal:` reached the terminal and never the
  // JSON the caller parses.
  //
  // Fixed here as the MESSAGE change #391 asked for: the branch git refuses
  // now carries git's reason, which names the worktree still holding it — the
  // only thing that tells an operator which remedy applies.
  //
  // What is deliberately NOT changed is which branches get reaped. Measured:
  // `git branch -D` needs no answer from the registry to delete a branch that
  // has no worktree, so `feature/b-merged` goes exactly as it did before.
  // Making the lookup fail closed would keep the whole sweep instead — a
  // control-flow ruling #391 reserved for the maintainer, filed as
  // #622. This test is the pin that a fix for it would have to move
  // deliberately.
  const w = repo(t);
  mergedGoneBranchWithWorktree(w, "feature/a-merged", "merged work");
  mergedGoneBranch(w, "feature/b-merged", "more merged work");
  const bin = failOnlyShim(
    t,
    `[ "$1" = worktree ] && [ "$2" = list ]`,
    ["fatal: worktree list exploded"],
    128,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "a branch git refuses to delete is a finding, not a script failure");
  assert.deepEqual(
    json.reaped,
    ["feature/b-merged"],
    "a lookup nobody could answer must not change what gets reaped — that ruling is not this ticket's",
  );
  assert.equal(json.kept.length, 2);
  assert.equal(json.kept[0].branch, "feature/a-merged");
  assert.match(json.kept[0].reason, /^branch delete failed: /, "the label stays — it is the reason that gains a cause");
  // The worktree sweep reads the same dead registry, and says so rather than
  // reporting an empty enumeration as "no branchless worktrees" — the silence
  // #381 exists to end, reachable here by a different route (the sweep is the
  // one place in this script that takes `git worktree list`'s own status).
  assert.equal(json.kept[1].branch, null, "a sweep that never named a worktree has no branch to blame");
  assert.match(json.kept[1].reason, /^cannot enumerate worktrees/);
  assert.match(json.kept[1].reason, /worktree list exploded/, "git's own words, not just the label");
  assert.match(json.kept[0].reason, /used by worktree at/, "git's diagnosis must reach the payload, not just the terminal");
  assert.doesNotMatch(json.kept[0].reason, /\n/, "flattened into one JSON string");
  assert.match(stderr, /KEEP feature\/a-merged — branch delete failed: /);
  assert.equal(branchExists(w, "feature/a-merged"), true, "the branch git refused to delete survives");
  assert.equal(branchExists(w, "feature/b-merged"), false);
});

test("quotes and backslashes in git's stderr still round-trip through the new reasons (#391, #119)", (t) => {
  // These three reasons now carry text neither this repo nor its operator
  // chose. `keep()` escapes through json.sh, which landed in #119 — before it,
  // routing git's stderr here would have emitted a payload no parser accepts.
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  const bin = failOnlyShim(
    t,
    `[ "$1" = branch ] && [ "$2" = -D ]`,
    [`error: cannot delete branch "feat" used by worktree at 'C:\\path\\to\\wt'`],
  );

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.equal(
    json.kept[0].reason,
    `branch delete failed: error: cannot delete branch "feat" used by worktree at 'C:\\path\\to\\wt'`,
    "the quotes and backslashes survive as data — runReap JSON.parses stdout, so a raw splice fails before this assert",
  );
});

test("an ordinary run's payload is byte-for-byte what it has always been (#391)", (t) => {
  // The false-positive half. Nothing here fails, so nothing has a cause to
  // quote and the payload must carry no reason at all — a fix that starts
  // decorating healthy reasons is as wrong as one that reports none.
  //
  // `worktreesRemoved` is the one field this healthy run does gain (#381), and
  // it is a statement of fact rather than a decoration: the branch sweep really
  // did remove that directory, and a key that named only the removals no branch
  // accounted for would leave a reader unable to tell an absent removal from an
  // unreported one.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json, { applied: true, reaped: ["feature/merged"], worktreesRemoved: [wt], kept: [] });
  assert.doesNotMatch(stderr, /KEEP/);
  assert.doesNotMatch(stderr, /registration/, "a successful removal says nothing about registrations");
  assert.equal(existsSync(wt), false);
});

test("the dry run removes nothing, and still cannot predict a refusal (#391)", (t) => {
  // The brief keeps this asymmetry deliberately: a dry run prints
  // `would remove worktree $wt` WITHOUT attempting the removal, so it cannot
  // foresee a refusal — performing it is the only way to know. This resembles
  // the dry/apply mismatch class of #86, #385 and #386 but is not an instance
  // of it, and the fix above must not have quietly turned it into one by
  // teaching the dry run to probe.
  //
  // BOTH fixtures are load-bearing. The locked one pins the unpredicted
  // refusal; the healthy one pins that no removal was attempted at all, and
  // only it can. Measured: with the locked worktree alone, a dry run taught to
  // call `git worktree remove` left this test green — the lock made the
  // attempt fail, so the fixture could not tell an attempt from an abstention.
  const w = repo(t);
  const healthy = mergedGoneBranchWithWorktree(w, "feature/a-healthy", "work that landed");
  const locked = mergedGoneBranchWithWorktree(w, "feature/b-locked", "work behind a lock");
  git(w, "worktree", "lock", locked);

  const { code, json, stderr } = runReap(w, []);

  assert.equal(code, 0);
  assert.deepEqual(
    json,
    {
      applied: false,
      reaped: ["feature/a-healthy", "feature/b-locked"],
      worktreesRemoved: [healthy, locked],
      kept: [],
    },
    "the dry run still promises the reap it cannot know will be refused",
  );
  assert.ok(stderr.includes(`    would remove worktree ${healthy}`), `the dry run's own line is unchanged: ${stderr}`);
  assert.ok(stderr.includes(`    would remove worktree ${locked}`));
  assert.ok(stderr.includes("    would reap feature/a-healthy"));
  assert.doesNotMatch(stderr, /KEEP/, "a dry run predicts no refusal — it never ran the removal");
  assert.doesNotMatch(stderr, /registration/, "and it probes no registry either");

  // Nothing was touched: directories, registrations and branches all intact.
  assert.equal(existsSync(healthy), true, "a dry run must not remove the worktree it COULD have removed");
  assert.equal(existsSync(locked), true);
  const reg = git(w, "worktree", "list", "--porcelain");
  assert.match(reg, /feature\/a-healthy/);
  assert.match(reg, /feature\/b-locked/);
  assert.equal(branchExists(w, "feature/a-healthy"), true);
  assert.equal(branchExists(w, "feature/b-locked"), true);
});

test("a registry probe that itself fails is reported as unknown, never as 'cleared' (#391)", (t) => {
  // The registration probe this fix adds is a git call of its own, and it can
  // fail. Spelling it `git worktree list … | grep -q` would take GREP's exit
  // status, never git's, and report a registry it never managed to read as
  // CLEARED — this ticket's own defect, reintroduced inside its own fix, and
  // pointed at the more alarming of the two states. Measured: that spelling
  // survived every other test in this file.
  //
  // The shim starves `worktree list` only from its SECOND call onward, so the
  // lookup at the top of the loop still finds the worktree and reaches the
  // removal; only the post-refusal probe is denied an answer. The lock makes
  // the removal refuse without disturbing anything, so the registration really
  // is intact — and the point is that the script must NOT claim to know that.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  git(w, "worktree", "lock", wt);

  // The counter needs its own tmpdir: `failOnlyShim` creates the shim dir
  // itself, so the path has to exist before the match string that writes to it
  // can be built. Putting the count in the match is what lets this reuse the
  // helper — the match runs exactly once per `git`, ahead of the shim's single
  // `exec`.
  const countDir = mkdtempSync(join(tmpdir(), "reap-count-"));
  t.after(() => rmSync(countDir, { recursive: true, force: true }));
  const counter = join(countDir, "n");
  const bin = failOnlyShim(
    t,
    `[ "$1" = worktree ] && [ "$2" = list ] && ` +
      `{ n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); printf '%s' "$n" > "${counter}"; [ "$n" -ge 2 ]; }`,
    ["fatal: worktree list exploded"],
    128,
  );

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  // The worktree sweep below runs the starved `worktree list` again and reports
  // that it could not enumerate; the entry under test is still the registry
  // probe's, and the sweep's must not be mistaken for it.
  assert.equal(json.kept.length, 2);
  assert.match(json.kept[1].reason, /^cannot enumerate worktrees/);
  assert.match(
    json.kept[0].reason,
    /cannot tell whether the registration survived/,
    `an unread registry is unknown, not a measurement: ${json.kept[0].reason}`,
  );
  assert.doesNotMatch(json.kept[0].reason, /registration cleared/, "the alarming state must never be guessed");
  assert.doesNotMatch(json.kept[0].reason, /registration intact/, "nor the reassuring one");
  assert.match(json.kept[0].reason, /locked working tree/, "git's reason for the refusal still reaches the payload");
  assert.equal(branchExists(w, "feature/merged"), true);
  // The probe was reached and starved, which is what this fixture has to
  // establish. Not an exact figure: the worktree sweep at the foot of the
  // script runs `worktree list` again, so a pinned total would fail whenever a
  // part of the script unrelated to this refusal gains or loses a call.
  assert.ok(
    Number(readFileSync(counter, "utf8")) >= 2,
    "fixture: the probe really was a call that got starved, not the lookup that preceded it",
  );
});

// Same reason as the cherry-probe pin above, and the same derivation: the
// script-surface table is what a reader trusts about a script that
// settings.json's autoMode allowlist lets run unattended, and #264 spent its
// whole life with that table asserting the bug as the behaviour. The two state
// phrases are the part a reader would otherwise have to guess at, so they are
// taken from real runs rather than typed here — a hand-copied phrase drifts
// exactly the way the row did.
test("the design spec's script-surface row carries both refusal states this script emits (#391)", (t) => {
  const states = ["locked", "symlink"].map((shape) => {
    const w = repo(t, `w-${shape}`);
    const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
    if (shape === "locked") git(w, "worktree", "lock", wt);
    else symlinkStandIn(wt);

    const { json } = runReap(w, ["--apply"]);
    assert.equal(json.kept.length, 1, `fixture (${shape}) must reach the removal refusal`);
    // The parenthesised state only — the path and git's message are the
    // machine's to vary and no document can carry them.
    const m = /^worktree remove refused \(([^)]*?)(?: —.*)?\)/.exec(json.kept[0].reason);
    assert.ok(m, `fixture (${shape}) must produce the refusal reason: ${json.kept[0].reason}`);
    return m[1];
  });

  assert.notEqual(states[0], states[1], "the two refusals must not report the same state");

  const row = specRow();
  for (const state of states) {
    assert.ok(row.includes(state), `the spec row must quote the refusal state verbatim, and does not carry "${state}".\nrow: ${row}`);
  }
});

// Detached-worktree coverage (#381). The [gone]-branch sweep above locates a
// worktree by the `branch refs/heads/<name>` line `git worktree list
// --porcelain` prints for it. A worktree at detached HEAD has no such line
// (measured, git 2.50.1 Apple Git-155: it prints `worktree`, `HEAD <sha>` and
// `detached`), so it was not refused — it was not considered, and the sweep
// reaped the branch and walked past the directory with no `would remove
// worktree` line and no `kept` entry to say so. What ROUTE leaves a fleet
// worktree in that shape is not asserted here: the merge bot's server-side
// rebase was blamed in an earlier draft and measured not to detach (see
// reap.sh's comment on the same point). The shape is what these fixtures build,
// and the shape is all the sweep decides on.

/**
 * A merged `[gone]` branch whose linked worktree has been moved off it onto a
 * bare sha. Returns the worktree's absolute path.
 *
 * `wt` overrides the `.worktrees/` home so a test can put a worktree OUTSIDE
 * it: that home is the sweep's ownership bound, and refusing everything beyond
 * it needs a fixture beyond it.
 */
function detachedMergedWorktree(w, name, msg, wt = join(w, ".worktrees", name)) {
  const dir = mergedGoneBranchWithWorktree(w, name, msg, wt);
  git(dir, "checkout", "-q", "--detach", "HEAD");
  return dir;
}

test("a detached worktree whose HEAD is merged is removed, not walked past (#381)", (t) => {
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  assert.ok(existsSync(wt), "fixture");
  assert.match(git(w, "worktree", "list"), /\(detached HEAD\)/, "fixture: the worktree must really be detached");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.equal(existsSync(wt), false, "the directory the branch sweep cannot see must still be removed");
  assert.deepEqual(json.worktreesRemoved, [wt]);
  assert.deepEqual(json.kept, [], "a removal is not a keep");
  assert.ok(stderr.includes(`    REMOVED worktree ${wt}`), `the removal must be reported: ${stderr}`);
  // The registration goes with it, or the in-flight probe still reads the
  // ticket as taken — the whole cost this ticket exists to stop.
  assert.doesNotMatch(git(w, "worktree", "list", "--porcelain"), /79-brief/);
});

test("a branchless sweep whose awk cannot read the listing declines, never sweeps silently (#993)", (t) => {
  // The enumeration's OTHER half. `git worktree list` dying is pinned by the
  // #391 test above ("cannot enumerate worktrees"); the awk that parses what it
  // printed was not, and the script's own comment at that arm calls it "this
  // ticket's own defect, committed inside its fix" — an awk that cannot run
  // leaves `$detached` empty, which is byte-identical to a repo holding no
  // branchless worktree at all. That is the silence #381 exists to end,
  // reachable by a route no test held. The fixture above is this one's control:
  // same repo, same detached worktree, and with a working awk it is REMOVED, so
  // the decline here is the awk's doing and not a fixture that was never
  // sweepable.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");

  // Selected on the `/^bare$/` rule, which no other awk program in this script
  // carries — CONTENT, never argv position, the discipline IGNORED_PROBE states
  // the reason for. `/^worktree /` and `substr($0,10)` would not do: the branch
  // sweep's own worktree lookup carries both, so a match on either shims two
  // call sites at once and this arm stops being what answered. The shim reaches
  // the script under test only — `withShim` puts it on the PATH `runReap`
  // passes, while this file's fixtures run `git` at its own absolute path
  // through `ENV`.
  const bin = toolFailShim(
    t,
    "awk",
    REAL_AWK,
    `case "$1" in *'/^bare$/'*) : ;; *) false ;; esac`,
    ["awk: multibyte conversion failure"],
    2,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "a listing that could not be parsed is a finding, not a script failure");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, null, "no worktree was ever named, so none can be blamed");
  assert.equal(
    json.kept[0].reason,
    "could not read the worktrees git listed — a branchless one would go unreported",
  );
  // The decline must be the WHOLE of the sweep: a removal alongside it would
  // mean the script acted on a listing it had just said it could not read.
  assert.deepEqual(json.worktreesRemoved, [], "a decline is not grounds for a partial sweep");
  assert.equal(existsSync(wt), true, "the worktree the control above removes must survive here");
  assert.match(stderr, /KEEP \(no branch\) — could not read the worktrees git listed/);
  assertToolShimFired(bin, "awk", "the awk shim must actually have fired for this fixture");
});

test("a DIRTY detached worktree is kept with a reason, never removed (#381)", (t) => {
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted, exists nowhere else\n");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(existsSync(join(wt, "scratch.txt")), true, "the uncommitted file must survive the run");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, null, "there is no branch to name, and `` would claim there were one");
  assert.equal(json.kept[0].reason, `dirty worktree ${wt}`);
  assert.ok(stderr.includes("KEEP"), "silently skipping it is the defect, not the fix");
});

test("a DIRTY detached worktree is kept under status.showUntrackedFiles=no (#730)", (t) => {
  // The third gate, and the one where the misread costs the FILES rather than
  // just a branch: this sweep's whole job is removing directories. The branch
  // sweep never reaches a detached worktree, so its own `-uall` does not cover
  // this arm — a fix applied to the two sites the ticket named leaves this one
  // blind, which is why it is pinned separately.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  writeFileSync(join(wt, "precious.txt"), "uncommitted, exists nowhere else\n");
  git(w, "config", "status.showUntrackedFiles", "no");
  assert.equal(git(wt, "status", "--porcelain"), "",
    "fixture: the config must really silence the unpinned probe, or this test measures nothing");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].reason, `dirty worktree ${wt}`);
  assert.equal(readFileSync(join(wt, "precious.txt"), "utf8"), "uncommitted, exists nowhere else\n",
    "the uncommitted file must survive the run");
});

test("a detached worktree holding commits that exist nowhere else is kept (#381)", (t) => {
  // The safety this sweep turns on. `git cherry`, not `merge-base
  // --is-ancestor`: the branch this worktree came from was rebased before it
  // merged, so a tip that is fully upstream is patch-equivalent rather than an
  // ancestor, and ancestry would keep every one of them. Here the commit
  // really is unique, and the probe has to say so.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const sole = commit(wt, "sole copy, nowhere else");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(existsSync(wt), true);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].reason, `worktree ${wt} holds commits that exist nowhere else`);
  assert.equal(git(wt, "rev-parse", "HEAD"), sole, "the commit is still reachable from the worktree");
});

test("a detached worktree whose HEAD git cannot resolve is kept, never swept (#381, #179)", (t) => {
  // An absent `branch` line is what this sweep enumerates on, and a worktree
  // whose admin `HEAD` is unreadable has none either — git reports the null
  // object id instead (measured on four corruption routes for #179). Nothing
  // about such a worktree can be decided, so it is reported and left.
  //
  // Garbage content, not a `chmod`: identical signature in the porcelain, and
  // it reproduces as any user, so the fixture neither leaks a permission bit
  // on failure nor goes vacuous under euid 0.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  writeFileSync(join(adminEntry(w, wt), "HEAD"), "not an object id\n");
  assert.match(
    git(w, "worktree", "list", "--porcelain"),
    /HEAD 0{40}/,
    "fixture: git must report the null object id for this worktree",
  );

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(existsSync(wt), true);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].reason, `worktree ${wt} has an unresolvable HEAD — git cannot say what it holds`);
});

test("a detached worktree with a BISECT in progress is kept — git is no backstop here (#381)", (t) => {
  // Measured, git 2.50.1 (Apple Git-155): `git worktree remove` WITHOUT
  // `--force` removes this at exit 0. A bisect detaches and leaves the tree
  // clean, so the enumeration, the merged probe and the dirty check all pass it
  // through, and only the in-progress guard stands between it and a removal
  // that discards the bisect's state.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  git(wt, "bisect", "start", "HEAD", "HEAD~1");
  assert.ok(existsSync(join(adminEntry(w, wt), "BISECT_LOG")), "fixture: the bisect must really be running");
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so only the in-progress guard can keep it");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(existsSync(wt), true);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /has a git operation in progress \(BISECT_LOG\)/);
});

test("a detached worktree with an INTERRUPTED REBASE is kept — the shape that reaches this sweep (#381)", (t) => {
  // release-ticket.sh's prose already names the interrupted rebase as the way
  // a fleet worktree wanders off its branch, and this is where it lands. The
  // exec fails without moving HEAD, so the merged probe still reads clean and
  // the guard is what answers — the same discrimination the bisect case makes,
  // through the other sequencer directory.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  spawnSync("git", ["rebase", "-q", "-i", "--exec", "false", "HEAD~1"], {
    cwd: wt,
    env: { ...ENV, GIT_SEQUENCE_EDITOR: "true" },
  });
  assert.ok(existsSync(join(adminEntry(w, wt), "rebase-merge")), "fixture: the rebase must really be stopped");
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so only the in-progress guard can keep it");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(existsSync(wt), true);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /has a git operation in progress \(rebase-merge\)/);
});

test("a detached MAIN checkout is kept, with the reason that is true on this path (#381)", (t) => {
  // The main checkout has no `branch` line either once it is detached, so this
  // sweep enumerates it. Removing it is impossible and there is no branch of
  // ours checked out in it to delete, so the reason says only the first — and
  // it must be answered before the linkage guard below it, whose `-f` test
  // would call the main checkout's `.git` DIRECTORY a broken linkage (#82).
  const w = repo(t);
  git(w, "checkout", "-q", "--detach", "HEAD");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].reason, `worktree ${w} is the main checkout — cannot remove it`);
  assert.doesNotMatch(json.kept[0].reason, /linkage/, "the linkage guard must not get to misdescribe it");
  assert.equal(existsSync(join(w, ".git")), true);
});

test("a detached worktree whose .git file is gone is kept, never removed as clean (#381, #128)", (t) => {
  // Delete a worktree's `.git` and `git -C` does not fail: it walks UP to the
  // enclosing repo and answers about THAT at rc 0, which the status call would
  // otherwise believe is this worktree's own clean status.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  writeFileSync(join(wt, "precious.txt"), "untracked, and git can no longer see it\n");
  rmSync(join(wt, ".git"));

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /^worktree .* has no \.git linkage — /);
  assert.equal(readFileSync(join(wt, "precious.txt"), "utf8"), "untracked, and git can no longer see it\n");
});

test("a NON-FLEET detached worktree is kept, however removable it looks (#381)", (t) => {
  // The ownership bound, and the reason this sweep needs one. The branch sweep
  // deletes on evidence the PR merged — `%(upstream:track)` reads `[gone]`.
  // Here there is no such evidence to read: this fixture is branchless, clean
  // and patch-equivalent to origin/main, and so is a human's `git worktree add
  // --detach` scratch checkout that was never a ticket. Unbounded, `--apply`
  // DELETED it (measured, PR #985 review), ignored files and all — inside a
  // `.worktrees/` path the `--ignored` probe is skipped too.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed", join(w, "..", "outside"));
  writeFileSync(join(wt, ".env"), "SECRET=exists nowhere else\n");
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so nothing but the bound can keep it");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /^worktree .* is not a fleet worktree — outside \.worktrees\/, /, json.kept[0].reason);
  assert.ok(json.kept[0].reason.includes(wt), `the decline must name which worktree it left: ${json.kept[0].reason}`);
  assert.ok(existsSync(wt), "the directory must survive");
  assert.equal(readFileSync(join(wt, ".env"), "utf8"), "SECRET=exists nowhere else\n", "the precious file must survive");
});

test("the same fixture INSIDE .worktrees/ is removed — the control for the bound above (#381)", (t) => {
  // Without this, the test above passes on a sweep that keeps every detached
  // worktree: it would pin nothing but a blanket refusal. Byte-identical
  // fixture, one difference — the path — so the bound is ownership and only
  // ownership.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  writeFileSync(join(wt, ".env"), "machine-generated, and a fleet worktree's ignored files are all like this\n");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, [wt]);
  assert.deepEqual(json.kept, []);
  assert.equal(existsSync(wt), false);
});

test("a detached worktree whose directory was deleted by hand still has its registration cleared (#381)", (t) => {
  // The registration is what inflight.sh reads as a live claim, and it outlives
  // the directory: `worktree list --porcelain` keeps the entry, annotated
  // prunable, after an `rm -rf`. `git worktree remove` accepts such an entry at
  // rc 0, so the established-absent case needs no branch of its own.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  rmSync(wt, { recursive: true, force: true });
  assert.match(git(w, "worktree", "list", "--porcelain"), /prunable/, "fixture: the stale registration must still be listed");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, [wt]);
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(git(w, "worktree", "list", "--porcelain"), /79-brief/);
});

test("a detached worktree behind an unreadable parent is kept, never removed as absent (#381, #83)", (t) => {
  // `-e` is false both for a directory that is gone and for one inside a prefix
  // this script may not search, and only the first is nothing to protect. The
  // walk up to the nearest existing ancestor is what makes "not there" a
  // measurement — reused here, not re-answered, so the two sweeps cannot drift.
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  writeFileSync(join(wt, "unpushed.txt"), "work behind the wall\n");
  const parent = join(w, ".worktrees");

  // Restored inline, not in a teardown hook: `repo`'s own cleanup is
  // registered first and would run against a directory it still cannot enter.
  chmodSync(parent, 0o000);
  const { code, json } = runReap(w, ["--apply"]);
  chmodSync(parent, 0o755);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].reason, `cannot tell whether worktree ${wt} exists`);
});

test("a detached worktree under a path containing a space is found and removed whole (#381)", (t) => {
  // The porcelain prints the path raw, so the enumeration reads the whole rest
  // of the line and the shell splits the pair on the object id's single space
  // — never on the path's. Read any other way, this worktree is a different,
  // nonexistent path and every guard above runs against it.
  const w = repo(t, "work dir");
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  assert.ok(wt.includes(" "), "fixture");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, [wt], "the path must arrive whole, not truncated at the space");
  assert.equal(existsSync(wt), false);
  assert.ok(stderr.includes(`    REMOVED worktree ${wt}`));
});

test("a detached worktree under a path containing a space is found DIRTY and kept (#381)", (t) => {
  // The other half of the pair above: truncation is not visible from the
  // removal alone, because a guard that ran against a nonexistent path passes
  // it. Here the guard has to see the real directory to answer at all.
  const w = repo(t, "work dir");
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].reason, `dirty worktree ${wt}`);
  assert.equal(existsSync(wt), true);
});

test("the dry run reports the detached worktree it would remove, removes nothing, and exits 0 (#381, #265)", (t) => {
  // The exit-status control for everything this ticket added. #265's own
  // criterion is that no path in this script exits 1, and its fix works by
  // keeping the `apply` guard the LAST command of the file; a sweep spliced in
  // ahead of the payload is exactly the kind of edit that relocates that
  // defect onto the default mode nobody runs under test. Both fixtures are
  // load-bearing: the removable one pins that a dry run still promises the
  // removal, the kept one that a keep on this path is not what makes it exit 0.
  const w = repo(t);
  const removable = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const dirty = detachedMergedWorktree(w, "docs/80-other", "more work that landed");
  writeFileSync(join(dirty, "scratch.txt"), "uncommitted\n");

  const { code, json, stderr } = runReap(w, []);

  assert.equal(code, 0, "the default dry run reports its verdict at 0, never a bare 1");
  assert.equal(json.applied, false);
  assert.deepEqual(json.worktreesRemoved, [removable], "the dry run still promises the removal");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].reason, `dirty worktree ${dirty}`);
  assert.ok(stderr.includes(`    would remove worktree ${removable}`));
  assert.doesNotMatch(stderr, /REMOVED worktree/, "a dry run removes nothing");
  assert.equal(existsSync(removable), true, "a dry run must not remove the worktree it COULD have removed");
  assert.equal(existsSync(dirty), true);
});

test("an attached worktree is never touched by the branchless sweep (#381)", (t) => {
  // The accept side of the enumeration itself. A worktree on a branch carries a
  // `branch` line, so the sweep must not see it at all — including one on a
  // live branch that is not `[gone]`, which nothing in this script may remove.
  const w = repo(t);
  git(w, "worktree", "add", "-q", join(w, ".worktrees", "live"), "-b", "feature/live", "main");
  const live = join(w, ".worktrees", "live");

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json, { applied: true, reaped: [], worktreesRemoved: [], kept: [] });
  assert.doesNotMatch(stderr, /KEEP/, "a worktree on a live branch is not a finding");
  assert.equal(existsSync(live), true);
  assert.equal(branchExists(w, "feature/live"), true);
});

test("a locked detached worktree is kept, its registration reported intact and its path named (#381)", (t) => {
  // The branch sweep's refusal handling has this coverage; its structurally
  // duplicated copy in this sweep had NONE — swapping the two state strings, or
  // replacing the whole reason literal, left the suite at 62/62 (measured,
  // PR #985 review). A locked worktree exits 128 with the admin entry
  // untouched, so this is the `registration intact` arm.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  git(w, "worktree", "lock", wt);

  const { code, json, stderr } = runReap(w, ["--apply"]);

  assert.equal(code, 0, "a refusal is a finding, not a script failure");
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, null, "there is no branch on this path to name");
  assert.match(
    json.kept[0].reason,
    /^worktree .* remove refused \(registration intact\): /,
    `a refusal that changed nothing must say so, and say which worktree: ${json.kept[0].reason}`,
  );
  assert.ok(json.kept[0].reason.includes(wt), `the reason must name the worktree: ${json.kept[0].reason}`);
  assert.doesNotMatch(json.kept[0].reason, /registration cleared/, "the two outcomes must not collapse into one reason");
  assert.match(json.kept[0].reason, /locked working tree/, "git's message names the fault");
  assert.match(json.kept[0].reason, /remove -f -f/, "and the remedy, which only git can supply");
  assert.doesNotMatch(json.kept[0].reason, /\n/, "git's stderr is multi-line; the reason must be flattened");
  assert.match(stderr, /KEEP \(no branch\) — worktree .* remove refused/);
  assert.equal(existsSync(wt), true, "a refused removal removes nothing");
});

test("a refusal that DID clear the registration says cleared, on the branchless path too (#381)", (t) => {
  // The other arm of the same three-way state, and the reason it exists: a
  // non-zero exit is no proof the removal had no effect. A directory replaced
  // by a symlink to itself passes every guard ahead of the removal — `.git` is
  // a regular file and `git -C` follows the link — and git then deregisters the
  // entry before failing.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const real = symlinkStandIn(wt);

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.match(
    json.kept[0].reason,
    /^worktree .* remove refused \(registration cleared\): /,
    `a refusal that unregistered the worktree must not read as a no-op: ${json.kept[0].reason}`,
  );
  assert.ok(json.kept[0].reason.includes(wt), `the reason must name the worktree: ${json.kept[0].reason}`);
  const reg = git(w, "worktree", "list", "--porcelain").split("\n");
  assert.ok(!reg.includes(`worktree ${wt}`), `the refused worktree's registration really is gone: ${reg.join(" | ")}`);
  assert.ok(lstatSync(wt).isSymbolicLink(), "the stand-in symlink must survive");
  assert.equal(existsSync(real), true, "the orphaned directory is not this script's to delete");
});

test("TWO refused worktrees produce two distinguishable declines (#381)", (t) => {
  // One refusal cannot catch this, which is why 1316 green tests did not: the
  // branch field is `null` on this path and git's message for a locked worktree
  // carries no path, so before the reason interpolated `$wt` the two entries
  // were byte-identical and an operator could not tell which was which
  // (measured, PR #985 review).
  const w = repo(t);
  const alpha = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const beta = detachedMergedWorktree(w, "docs/80-other", "more work that landed");
  git(w, "worktree", "lock", alpha);
  git(w, "worktree", "lock", beta);

  const { code, json } = runReap(w, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 2);
  assert.notEqual(json.kept[0].reason, json.kept[1].reason, "two refusals must not read as one");
  const reasons = json.kept.map((k) => k.reason).join("\n");
  assert.ok(reasons.includes(alpha), `the declines must name alpha: ${reasons}`);
  assert.ok(reasons.includes(beta), `the declines must name beta: ${reasons}`);
});

test("a `+` inside a cherry diagnostic does not strand a detached worktree (#381)", (t) => {
  // The anchor, pinned for this sweep's own separately-duplicated copy of the
  // check. Dropping the `^` from `grep -q '^+'` at the branchless cherry probe
  // left the suite at 62/62 (measured, PR #985 review) — none of the #381
  // fixtures put a `+` anywhere the capture could see one.
  //
  // The `+` has to come from STDERR, not from a commit subject: `git cherry`
  // without `-v` prints `+ <sha>` / `- <sha>` and no subject at all, so a
  // fixture message containing a `+` never reaches the value being matched
  // (measured). Same shim shape as the branch sweep's twin above — the warning
  // rides in the `match`, which then falls through to the real git, so the
  // check still reads a genuine cherry run's stdout.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const bin = failOnlyShim(t, `[ "$1" = cherry ] && { printf '%s\\n' "warning: unable to access '/x/c++/lib/.gitattributes'" >&2; ${SHIM_FIRED}; false; }`, []);

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  // `mergedGoneBranchWithWorktree` leaves `refs/heads/docs/79-brief` behind —
  // detaching the worktree's HEAD un-checks-out the branch, it doesn't delete
  // it — so the BRANCH sweep also sees this same name as `[gone]` and runs its
  // own `git cherry`, which the bare match above fires on too. A regex on the
  // recorded argv, not just presence, is what proves THIS sweep's own probe
  // (target a full SHA, never a `refs/heads/...` name) is what fired. #759
  assertShimFired(
    bin,
    "no `+` ever reached this sweep's cherry probe — the rest of this arm passes on any fixture",
    /^cherry \S+ [0-9a-f]{40}$/m,
  );
  assert.equal(code, 0);
  assert.deepEqual(json.kept, [], "a `+` inside a diagnostic is not an unmerged commit");
  assert.deepEqual(json.worktreesRemoved, [wt], "noisy stderr must not strand a merged worktree");
  assert.equal(existsSync(wt), false);
});

// #1419. `grep -q` answers three ways and every call site in reap.sh read two:
// rc 0 a line matched, rc 1 none did, rc 2+ grep could not finish the scan at
// all. Under `-q` both POSIX and GNU reserve 0 for a match even when an error
// also occurred, so an rc 2 means specifically "no match AND the scan broke" —
// and a bare `if … | grep -q …; then` files that 2 under no-match, which at the
// two merged-commit checks is the arm that authorizes `git branch -D` and
// `git worktree remove`.
//
// Measured on `origin/main` with the shims below, all four sites: the branch
// was REAPED, the worktree DIRECTORY removed, and both registry re-reads
// reported `registration cleared` about a listing nothing had read — every one
// at exit 0 with the fault plainly on stderr. Same misattribution as #789 and
// #1413, one tool further down the same pipelines.
//
// The shims select on the PATTERN, never on a flag spelling or an argv
// position. This fix respelled `-qxF` as `-q -xF -e …`, and a shim matching
// `-xF` stopped firing on the new spelling and went green vacuously —
// measured while writing these, on the `origin/main` comparison runs, which is
// #730's lesson arriving in a third place.

/**
 * A PATH `grep` that exits `code` having matched nothing, whenever `match`
 * holds against its argv. `code` defaults to 2, the status a grep that could
 * not finish scanning leaves under `-q`; pass 1 for a scan that COMPLETED and
 * merely warned.
 */
function grepFailShim(t, match, code = 2) {
  return toolFailShim(t, "grep", REAL_GREP, match, ["grep: illegal byte sequence"], code);
}

// The two merged-commit checks. Both sweeps pass the same `^+`, so unlike the
// `git cherry` shims above the recorded argv cannot say WHICH one fired — the
// REASONS discriminate instead, and each test below asserts its own sweep's
// wording rather than settling for presence.
const CHERRY_SCAN = `case " $* " in *" ^+ "*) : ;; *) false ;; esac`;

// The two registry re-reads: the only greps in a run whose pattern begins
// `worktree `.
const REGISTRY_SCAN = `case " $* " in *" worktree "*) : ;; *) false ;; esac`;

test("a cherry scan that could not scan does not authorize `git branch -D` (#1419)", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  const bin = grepFailShim(t, CHERRY_SCAN);

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assertToolShimFired(bin, "grep", "the cherry scan never ran — this arm passes on any fixture", /\^\+/);
  assert.equal(code, 0);
  assert.deepEqual(json.reaped, [], "a scan that never looked is not a clean merge verdict");
  assert.equal(branchExists(w, "feature/merged"), true,
    "the branch whose merge status no tool established must survive");
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /cannot tell if merged/,
    `an unscanned cherry is unknown, not merged: ${json.kept[0].reason}`);
  assert.match(json.kept[0].reason, /illegal byte sequence/,
    "and the scan's own cause reaches the payload, per #625 at git_probe");
  assert.doesNotMatch(json.kept[0].reason, /unmerged commits/,
    "nor is it a positive unmerged verdict — nothing was read in either direction");
});

test("a cherry scan that could not scan does not authorize removing the DIRECTORY (#1419)", (t) => {
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const bin = grepFailShim(t, CHERRY_SCAN);

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assertToolShimFired(bin, "grep", "this sweep's cherry scan never ran", /\^\+/);
  assert.equal(code, 0);
  assert.deepEqual(json.worktreesRemoved, [], "a directory is not deleted on a scan that never completed");
  assert.equal(existsSync(wt), true, "the only copy of that commit is still on disk");
  assert.deepEqual(json.reaped, []);
  // `detachedMergedWorktree` leaves refs/heads/docs/79-brief behind, so the
  // BRANCH sweep meets the same name as [gone] and its own scan fails too.
  // Two entries, and #985's ruling is that two refusals must not read as one.
  assert.equal(json.kept.length, 2);
  const wtEntry = json.kept.find((k) => k.branch === null);
  assert.ok(wtEntry, `the branchless sweep's own refusal must be present: ${JSON.stringify(json.kept)}`);
  assert.ok(wtEntry.reason.includes(`cannot tell if worktree ${wt} is merged`),
    `and must name the worktree it declined to remove: ${wtEntry.reason}`);
  assert.notEqual(json.kept[0].reason, json.kept[1].reason,
    "the two sweeps' refusals must stay distinguishable");
});

test("a registry re-read whose scan fails is unknown, never 'registration cleared' (#1419)", (t) => {
  // The git-side half of this sentence is already pinned above (#391): a
  // `worktree list` that dies must not read as cleared. This is the GREP-side
  // half the same fix left open. The lock is what makes the fixture decisive —
  // the registration is provably INTACT, and `origin/main` reported it
  // `cleared`: the more alarming of the two states, asserted as a measurement,
  // about a listing nothing managed to read.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  git(w, "worktree", "lock", wt);
  const bin = grepFailShim(t, REGISTRY_SCAN);

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assertToolShimFired(bin, "grep", "the registry scan never ran — this arm passes on any fixture", /worktree /);
  assert.equal(code, 0);
  assert.equal(json.kept.length, 1);
  assert.match(json.kept[0].reason, /cannot tell whether the registration survived/,
    `an unscanned registry is unknown, not a measurement: ${json.kept[0].reason}`);
  assert.doesNotMatch(json.kept[0].reason, /registration cleared/, "the alarming state must never be guessed");
  assert.doesNotMatch(json.kept[0].reason, /registration intact/, "nor the reassuring one");
  assert.match(json.kept[0].reason, /illegal byte sequence/, "and the scan's own cause reaches the operator");
  assert.match(json.kept[0].reason, /locked working tree/, "git's reason for the refusal still reaches the payload");
});

test("the branchless sweep's OWN registry re-read is unknown too when its scan fails (#1419)", (t) => {
  // The fourth of four sites, and the one the ticket did not name: this sweep
  // carries its own copy of the registry re-read, byte-identical to the branch
  // sweep's. A fix that lands in one copy and not its twin is the shape this
  // file is full of second tickets for (#622, #985, #1441), so the twin gets a
  // fixture rather than a comment claiming the first one covers it.
  //
  // The leftover branch is deleted so ONLY this sweep sees the worktree:
  // `detachedMergedWorktree` leaves refs/heads behind, and the branch sweep
  // would otherwise reach the removal first and produce the entry the test
  // above already pins.
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  git(w, "branch", "-D", "docs/79-brief");
  git(w, "worktree", "lock", wt);
  const bin = grepFailShim(t, REGISTRY_SCAN);

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assertToolShimFired(bin, "grep", "this sweep's registry scan never ran", /worktree /);
  assert.equal(code, 0);
  assert.deepEqual(json.reaped, []);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, null, "this sweep's entry names no branch");
  assert.match(json.kept[0].reason, /cannot tell whether the registration survived/,
    `the twin must answer the same way: ${json.kept[0].reason}`);
  assert.doesNotMatch(json.kept[0].reason, /registration cleared/, "the alarming state must never be guessed here either");
  assert.doesNotMatch(json.kept[0].reason, /registration intact/, "nor the reassuring one");
});

test("a cherry scan that COMPLETES and merely warns still reaps (#1419)", (t) => {
  // What the new guard must not refuse, and the reason it reads grep's rc
  // rather than grep's stderr. `gp_cut_short`'s comment in reap.sh records the
  // measured cost of gating on "anything on stderr": an operator's broken
  // gitconfig makes tools warn at a SUCCESS status with their output complete,
  // and a stderr gate then strands every branch it guards for as long as the
  // config stays broken, blaming the branch for the fault. That wrong gate is
  // available one tool further down, so the rc-1 arm is pinned with a scan
  // that answers "no match" AND writes to stderr: the verdict is real, the
  // branch is merged, and the reap has to proceed.
  //
  // The fail-closed tests above cannot catch that mutation — they assert a
  // KEEP, which a stderr gate also produces. Only an ACCEPT can.
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  const bin = grepFailShim(t, CHERRY_SCAN, 1);

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assertToolShimFired(bin, "grep", "the warning never reached a scan — this arm reaps on any fixture", /\^\+/);
  assert.equal(code, 0);
  assert.deepEqual(json.reaped, ["feature/merged"],
    "rc 1 is a verdict: no `+` line, so the branch is merged and reapable");
  assert.deepEqual(json.kept, [], "a warning is not a failure to scan");
  assert.equal(branchExists(w, "feature/merged"), false);
});

test("a bare repo in the registry is not diagnosed as an unresolvable HEAD (#381)", (t) => {
  // `git worktree list --porcelain` prints `worktree <path>` then `bare` and
  // NOTHING else for a bare repo used as a worktree root — no HEAD line, no
  // branch line (measured, git 2.50.1 Apple Git-155). Without a case of its own
  // the parser emitted it with an empty object id, which the null-object-id arm
  // then reported as "has an unresolvable HEAD — git cannot say what it holds":
  // a false diagnosis, since git says exactly what it holds, no working tree at
  // all. The detached worktree alongside it is the positive control — the run
  // still does its job.
  const w = repo(t);
  const bare = join(w, "..", "origin.git");
  const wt = join(w, "..", ".worktrees", "off-bare");
  // reap.sh fetches before it reads anything, so the bare repo needs an
  // `origin` to fetch — itself, which is enough to make `origin/main` and keep
  // the fixture to one repo.
  git(bare, "remote", "add", "origin", ".");
  git(bare, "worktree", "add", "-q", "--detach", wt, "main");
  assert.match(git(wt, "worktree", "list", "--porcelain"), /^bare$/m, "fixture: the registry must carry a bare entry");

  // Run from the bare root, not from `wt`: `--apply` removes `wt`, and from
  // inside it this sweep now refuses that removal as the working directory the
  // run itself was started in (#992) — a different subject, and one that would
  // leave this fixture's removal unasserted.
  //
  // No `BASE_REF` override: this arm passed `main` before #924's accept-list,
  // which refuses a local branch. The fetch above populates
  // `refs/remotes/origin/main` in the bare repo too — the comment on the
  // `remote add` says as much — so the default base is what this fixture always
  // had available, and the subject here is the registry's bare entry, not the
  // base.
  const { code, json } = runReap(bare, ["--apply"]);

  assert.equal(code, 0);
  assert.deepEqual(json.kept, [], `the bare root is not a finding: ${JSON.stringify(json.kept)}`);
  assert.deepEqual(json.worktreesRemoved, [wt], "and the detached worktree beside it is still swept");
});

// #992. `--apply` removes worktrees, and the fleet's `.worktrees/` home is
// exactly where a member stands when it runs this — so the worktree the script
// is running FROM was itself eligible for removal. Removing it deletes the
// script's own cwd, and every git call after that dies with
// `fatal: Unable to read current working directory`: measured (git 2.50.1,
// Apple Git-155) as `REMOVED worktree …` followed by a failed
// `git worktree prune` at exit 2, from a run whose every removal SUCCEEDED.
//
// Refusing that one directory, rather than chdir-ing somewhere durable before
// the prune: the prune is the LAST call that needs a cwd, not the only one —
// the removals of the worktrees enumerated after this one, and the branch
// sweep's own `git branch -D`, need one too, and a chdir at the foot of the
// file leaves all of those still broken. Both fixtures below therefore carry a
// SECOND subject the run must still act on, so a blanket stand-down cannot
// pass them.
test("the branchless sweep refuses the worktree the run is standing in, and still exits 0 (#992)", (t) => {
  const w = repo(t);
  const here = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const other = detachedMergedWorktree(w, "docs/80-other", "more work that landed");

  const { code, json, stderr } = runReap(here, ["--apply"]);

  assert.equal(code, 0, `every removal succeeded, so the run must exit 0: ${stderr}`);
  assert.equal(existsSync(here), true, "the directory this run was started in must survive");
  assert.deepEqual(json.worktreesRemoved, [other], "the refusal covers one directory, not the sweep");
  assert.equal(existsSync(other), false, "and the worktree beside it is still removed");
  assert.equal(json.kept.length, 1, `exactly one finding: ${JSON.stringify(json.kept)}`);
  assert.equal(json.kept[0].branch, null, "this sweep has no branch to name");
  assert.equal(
    json.kept[0].reason,
    `worktree ${here} holds the working directory this run was started in — removing it would delete the cwd every git call after it needs; rerun from outside it`,
  );
  assert.ok(stderr.includes("KEEP"), "silently walking past it is the defect, not the fix");
  assert.doesNotMatch(stderr, /Unable to read current working directory/, "the defect's own signature");
  assert.doesNotMatch(stderr, /prune failed/, "housekeeping that can run must not report a failure");
});

// The same subject on the other sweep, and the shape the refuting vote in the
// PR review measured against the pre-#381 script: a branch-carrying merged
// `[gone]` worktree, which the branch sweep removes on its own. Here the branch
// is checked out in that worktree, so keeping the directory keeps the branch
// with it — the same pairing the main-checkout decline already states, and the
// reason `git branch -D` would refuse it anyway.
test("the branch sweep refuses the worktree the run is standing in, and keeps its branch with it (#992)", (t) => {
  const w = repo(t);
  const here = mergedGoneBranchWithWorktree(w, "feature/here", "work that landed");
  mergedGoneBranch(w, "feature/elsewhere", "also landed");

  const { code, json, stderr } = runReap(here, ["--apply"]);

  assert.equal(code, 0, `every removal succeeded, so the run must exit 0: ${stderr}`);
  assert.equal(existsSync(here), true, "the directory this run was started in must survive");
  assert.deepEqual(json.worktreesRemoved, []);
  assert.deepEqual(json.reaped, ["feature/elsewhere"], "the rest of the sweep still runs");
  assert.equal(branchExists(w, "feature/here"), true, "the branch checked out in that worktree is kept with it");
  assert.equal(json.kept.length, 1, `exactly one finding: ${JSON.stringify(json.kept)}`);
  assert.equal(json.kept[0].branch, "feature/here", "this sweep has a branch to name, and kept it");
  assert.match(json.kept[0].reason, /holds the working directory this run was started in/);
  assert.doesNotMatch(stderr, /Unable to read current working directory/, "the defect's own signature");
  assert.doesNotMatch(stderr, /prune failed/, "housekeeping that can run must not report a failure");
});

// The dry run has to predict the refusal, for the reason #82 records for the
// main-checkout decline: a `would remove worktree` line the following
// `--apply` refuses is a promise this script cannot keep, and the two modes
// disagreeing about a fixed structural fact is the defect that guard exists to
// stop. Deterministic here in a way #391's refusals are not — the cwd is known
// before anything is removed, so unlike git's own decline it CAN be predicted.
test("the dry run predicts that refusal instead of promising a removal (#992)", (t) => {
  const w = repo(t);
  const here = detachedMergedWorktree(w, "docs/79-brief", "work that landed");

  const { code, json, stderr } = runReap(here, []);

  assert.equal(code, 0);
  assert.equal(json.applied, false);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1, `exactly one finding: ${JSON.stringify(json.kept)}`);
  assert.match(json.kept[0].reason, /holds the working directory this run was started in/);
  assert.doesNotMatch(stderr, /would remove worktree/, "a dry run must not promise a removal --apply refuses (#82)");
});

test("the design spec's script-surface row carries the two declines only this sweep emits (#381)", (t) => {
  // Same derivation as the pins above: read the label off a live run, then
  // require the document to carry it. These two are the ones a reader cannot
  // infer from the branch sweep — the ownership bound has no counterpart there
  // at all, and the refusal decline is the only one on this path where the
  // worktree path IS the identifier, since `branch` is null.
  const w = repo(t);
  const foreign = detachedMergedWorktree(w, "docs/79-brief", "work that landed", join(w, "..", "outside"));
  const locked = detachedMergedWorktree(w, "docs/80-other", "more work that landed");
  git(w, "worktree", "lock", locked);

  const { json } = runReap(w, ["--apply"]);

  const reasons = json.kept.map((k) => k.reason);
  const bound = /(is not a fleet worktree — outside \.worktrees\/)/.exec(reasons.join("\n"));
  const refused = /(remove refused) \(/.exec(reasons.join("\n"));
  assert.ok(bound, `fixture must reach the ownership decline: ${reasons.join(" | ")}`);
  assert.ok(refused, `fixture must reach the refusal decline: ${reasons.join(" | ")}`);
  assert.ok(reasons.some((r) => r.includes(foreign)) && reasons.some((r) => r.includes(locked)), reasons.join(" | "));

  const row = specRow();
  for (const label of [bound[1], refused[1]]) {
    assert.ok(row.includes(label), `the spec row must quote this decline verbatim, and does not carry "${label}".\nrow: ${row}`);
  }
});

// Same reason and the same derivation as the cherry-probe and refusal-state
// pins above. This one guards the safety claim a reader is most likely to draw
// wrong: git refuses a removal on modified and untracked files, so a reader who
// knows that would assume it also refuses one mid-operation. It does not, and
// the row has to say which decline covers that.
test("the design spec's script-surface row carries the in-progress decline this sweep emits (#381)", (t) => {
  const w = repo(t);
  const wt = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  git(wt, "bisect", "start", "HEAD", "HEAD~1");

  const { json } = runReap(w, ["--apply"]);

  // Everything from the label up to the state git named: the path is the
  // caller's to vary and the state is one of several, so neither can be carried
  // by a document.
  const label = /(has a git operation in progress) \(/.exec(json.kept[0]?.reason ?? "");
  assert.ok(label, `fixture must reach the in-progress decline: ${json.kept[0]?.reason}`);

  const row = specRow();
  assert.ok(
    row.includes(label[1]),
    `the spec row must quote this decline verbatim, and does not carry "${label[1]}".\nrow: ${row}`,
  );
  // The payload shape a reader parses against, stated where the reasons are.
  assert.ok(row.includes("worktreesRemoved[]"), `the row must state the key this sweep writes.\nrow: ${row}`);
});

// Same derivation as the pins above, for the one decline in this script that
// is not about its subject at all: it names where the run was INVOKED from,
// and its remedy is to invoke it somewhere else. A reader who knows every
// worktree guard above still cannot infer that a removable worktree survives a
// run started inside it, so the row has to say so. #992
test("the design spec's script-surface row carries the standing-in-it decline both sweeps emit (#992)", (t) => {
  const w = repo(t);
  const here = detachedMergedWorktree(w, "docs/79-brief", "work that landed");

  const { json } = runReap(here, ["--apply"]);

  // Up to the path only: the path is the caller's to vary, the label is what a
  // document can carry.
  const label = /(holds the working directory this run was started in)/.exec(json.kept[0]?.reason ?? "");
  assert.ok(label, `fixture must reach the standing-in-it decline: ${json.kept[0]?.reason}`);

  const row = specRow();
  assert.ok(
    row.includes(label[1]),
    `the spec row must quote this decline verbatim, and does not carry "${label[1]}".\nrow: ${row}`,
  );
});

// #1441 (finding 1). `self_wt` used to fold EVERY failure of this probe into
// the same empty-string case as a genuine "not in a worktree" answer, via
// `|| self_wt=`. That silently disabled both cwd-delete guards above whenever
// the probe failed for any reason other than the two documented ones. This
// shim fails ONLY `rev-parse --show-toplevel` — every other git call,
// including `rev-parse --git-dir` at the top of the script, is real — with a
// message that is neither known "not in a worktree" answer, reproducing the
// exact defect #992 fixed: run from a worktree slated for removal, `--apply`
// used to remove it.
test("an unrecognised git rev-parse --show-toplevel failure fails the whole run closed, rather than disabling the cwd-delete guard (#1441)", (t) => {
  const w = repo(t);
  const here = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const bin = failOnlyShim(
    t,
    `[ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]`,
    ["fatal: unable to read current working directory: No such file or directory"],
    128,
  );

  const { code, json, stderr } = runReap(here, ["--apply"], withShim(bin));

  assertShimFired(bin, "the probe never reached the script under test");
  assert.equal(code, 2, "an unrecognised probe failure must refuse loudly, not fall through to a silent pass");
  assert.equal(json, null, "a run that dies before the sweep must not also print a payload claiming one ran");
  assert.equal(existsSync(here), true, "the worktree this run is standing in must survive an unverified cwd guard");
  assert.match(stderr, /rev-parse --show-toplevel/, "the message must name the probe that broke, not just a downstream symptom");
});

// #1441 (finding 2). Both cwd-delete guards compared `$wt` to `$self_wt` by
// EXACT equality, so they missed the ANCESTOR case: cwd nested inside a
// worktree slated for removal (SKILL.md:2407 — "a member can commit in a
// nested worktree" — is the same real shape). `--apply` used to remove the
// outer worktree, deleting the cwd, taking the nested worktree's uncommitted
// file with it. `.gitignore` excludes the nested path so the outer worktree's
// own dirty check (line 649/1004 above) does not see it — mirroring the
// fleet's real layout, where a linked worktree's home is itself gitignored by
// the enclosing checkout.
function ignoreNestedWorktrees(w) {
  writeFileSync(join(w, ".gitignore"), "nested/\n");
  git(w, "add", ".gitignore");
  git(w, "commit", "-q", "-m", "ignore nested worktrees");
}

test("the branch sweep keeps the outer worktree when cwd is a worktree NESTED inside it, not only when cwd equals it exactly (#1441)", (t) => {
  const w = repo(t);
  ignoreNestedWorktrees(w);
  const outer = mergedGoneBranchWithWorktree(w, "feature/outer", "work that landed");
  const inner = join(outer, "nested");
  git(w, "worktree", "add", "-q", "--detach", inner, "main");
  writeFileSync(join(inner, "wip.txt"), "work that exists nowhere else\n");

  const { code, json, stderr } = runReap(inner, ["--apply"]);

  assert.equal(code, 0, `every removal must still succeed: ${stderr}`);
  assert.equal(existsSync(outer), true, "the ancestor worktree holding cwd must survive, not only an exact-path match");
  assert.equal(existsSync(inner), true, "and the nested worktree, and its uncommitted file, along with it");
  assert.equal(readFileSync(join(inner, "wip.txt"), "utf8"), "work that exists nowhere else\n");
  assert.equal(branchExists(w, "feature/outer"), true, "the branch checked out in the surviving outer worktree is kept with it");
  assert.deepEqual(json.worktreesRemoved, [], "the ancestor guard must stop this removal before it starts");
  // Two independent findings, not one: the ancestor guard keeps `outer`
  // (this test's subject), and `inner` is separately kept by its OWN dirty
  // check — it holds the uncommitted `wip.txt` this fixture put there. That
  // second finding is orthogonal to the fix under test: it would fire even
  // with cwd elsewhere, and does not by itself stop `outer`'s removal from
  // deleting `inner` right along with it — only the ancestor guard does.
  const outerFinding = json.kept.find((k) => k.reason.startsWith(`worktree ${outer} `));
  assert.ok(outerFinding, `the outer worktree must be its own reported finding: ${JSON.stringify(json.kept)}`);
  assert.equal(outerFinding.branch, "feature/outer");
  assert.match(outerFinding.reason, /holds the working directory this run was started in/);
});

test("the branchless sweep keeps the outer worktree when cwd is a worktree NESTED inside it, not only when cwd equals it exactly (#1441)", (t) => {
  const w = repo(t);
  ignoreNestedWorktrees(w);
  const outer = detachedMergedWorktree(w, "docs/79-brief", "work that landed");
  const inner = join(outer, "nested");
  git(w, "worktree", "add", "-q", "--detach", inner, "main");
  writeFileSync(join(inner, "wip.txt"), "work that exists nowhere else\n");

  const { code, json, stderr } = runReap(inner, ["--apply"]);

  assert.equal(code, 0, `every removal must still succeed: ${stderr}`);
  assert.equal(existsSync(outer), true, "the ancestor worktree holding cwd must survive, not only an exact-path match");
  assert.equal(existsSync(inner), true, "and the nested worktree, and its uncommitted file, along with it");
  assert.equal(readFileSync(join(inner, "wip.txt"), "utf8"), "work that exists nowhere else\n");
  assert.deepEqual(json.worktreesRemoved, [], "the ancestor guard must stop this removal before it starts");
  // See the branch sweep's copy of this test for why two findings, not one:
  // `inner`'s own dirty check keeps it independently of the ancestor guard,
  // which is what protects `outer` — the actual subject here.
  const outerFinding = json.kept.find((k) => k.reason.startsWith(`worktree ${outer} `));
  assert.ok(outerFinding, `the outer worktree must be its own reported finding: ${JSON.stringify(json.kept)}`);
  assert.equal(outerFinding.branch, null, "this sweep has no branch to name");
  assert.match(outerFinding.reason, /holds the working directory this run was started in/);
});

test("a [gone] branch whose worktree path holds a newline is kept, never reaped (#551)", (t) => {
  // The branch sweep matched on the `branch` line, so the MATCH was never
  // affected — only the path it reported and acted on, which the plain
  // porcelain cut at the newline. Measured before the fix on this shape: the
  // dry run printed `would remove worktree …/33-slug`, a path not on disk, and
  // `reaped:["…"]` with it.
  const w = repo(t);
  mergedGoneBranchWithWorktree(w, "feature/newline", "merged work", join(w, ".worktrees", "33-slug\ntail"));
  // ACCEPT, in the SAME run and the same listing: an ordinary [gone] branch
  // must still be reaped. Without it a `nl_path` hard-wired true passes every
  // assertion below while stranding the whole sweep.
  const ok = mergedGoneBranchWithWorktree(w, "feature/ordinary", "merged work");

  const { json } = runReap(w, []);
  assert.deepEqual(json.reaped, ["feature/ordinary"], "the ordinary branch is untouched by the refusal");
  assert.deepEqual(json.worktreesRemoved, [ok], "and its worktree is still the one predicted for removal");
  const kept = json.kept.find((k) => k.branch === "feature/newline");
  assert.ok(kept, `the newline branch must be reported, never silently walked past: ${JSON.stringify(json.kept)}`);
  assert.match(kept.reason, /holds a newline in its path/);
  assert.ok(branchExists(w, "feature/newline"), "and nothing about it may be deleted");
});

test("a [gone] branch whose worktree is a dangling symlink is kept, never reaped (#725)", (t) => {
  // `gone()` followed the link, called the path established-absent, and this
  // sweep's own comment says an absent directory "holds no work" and falls
  // through to the removal. Measured before the fix: `would remove worktree`
  // and `reaped:["feature/dangling"]`. A dangling worktree link is also what
  // release-ticket.sh's rc-255 halt path leaves behind, with the branch and the
  // in-progress label still live — so this is a live claim, not residue (#728).
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/dangling", "merged work");
  rmSync(wt, { recursive: true, force: true });
  symlinkSync(join(w, "nowhere"), wt);

  const { json } = runReap(w, []);
  assert.deepEqual(json.reaped, [], "nothing may be reaped over a path that is occupied");
  assert.deepEqual(json.worktreesRemoved, []);
  assert.match(json.kept.find((k) => k.branch === "feature/dangling").reason, /cannot tell whether worktree/);
  assert.ok(branchExists(w, "feature/dangling"));
  assert.equal(lstatSync(wt).isSymbolicLink(), true, "and the link itself is untouched");
});

// --- #789: three `awk` substitutions that used to end the run in awk's own
// voice (or, at the ignored-files site, in a masked one) instead of a
// `reap:`-prefixed refusal, plus the git stage in front of the first of them.
// Four of the six tests below inject those `awk`/`paste` faults by shimming
// `awk` or `paste` on PATH, distinguished by the ARGUMENT this file's own awk
// programs carry, never by position — the same discipline IGNORED_PROBE above
// states the reason for. The other two shim `git` itself instead, at the
// enumeration's own git_probe call: one proves that stage's failure is now
// read on its own rather than masked by awk finishing an empty scan at rc 0,
// the other proves an rc-0 warning that stage still captures is forwarded to
// the operator rather than dropped.

test("an unenumerable [gone] sweep is kept, not silently read as a clean no-op (#789)", (t) => {
  // Before this fix, a command substitution used as a `for … in` word list
  // swallowed the failure completely: the loop ran zero iterations and the
  // run reported `{"reaped":[],"kept":[]}`, byte-identical to a sweep that
  // genuinely found nothing to reap.
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  const bin = toolFailShim(
    t,
    "awk",
    REAL_AWK,
    `case "$1" in *'[gone]'*) : ;; *) false ;; esac`,
    ["awk: multibyte conversion failure"],
    2,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "an unanswerable enumeration is a finding, not a script failure");
  assert.deepEqual(json.reaped, [], "nothing can be reaped from a sweep that never enumerated anything");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, null, "no branch was ever named, so none can be blamed");
  assert.match(json.kept[0].reason, /^could not enumerate \[gone\] branches/);
  assert.match(stderr, /KEEP \(no branch\) — could not enumerate \[gone\] branches/);
  assert.equal(branchExists(w, "feature/merged"), true, "a genuinely merged branch survives an enumeration that could not see it");
  assertToolShimFired(bin, "awk", "the awk shim must actually have fired for this fixture");
});

test("a `git for-each-ref` that dies is kept, never read as a clean no-op that just found nothing (#789)", (t) => {
  // The awk-only guard above catches awk's own failure, but the pipeline has
  // a first stage too: `git for-each-ref | awk …`, under `set -eu` with no
  // `pipefail`. Before this fix only awk's exit status reached the `if !`,
  // so a `git for-each-ref` that died still left awk scanning EMPTY input —
  // and awk finishes that scan at rc 0, the identical exit a genuinely
  // branchless repo produces. The run reported `{"reaped":[],"kept":[]}`,
  // silently indistinguishable from a clean sweep. Shimming `git` itself,
  // not `awk`, is what proves the git-side status is now read on its own.
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  const bin = failOnlyShim(
    t,
    `[ "$1" = for-each-ref ]`,
    ["fatal: for-each-ref: unable to read refs (simulated)"],
    129,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "an unanswerable enumeration is a finding, not a script failure");
  assert.deepEqual(json.reaped, [], "nothing can be reaped from a sweep whose git stage never ran");
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, null, "no branch was ever named, so none can be blamed");
  assert.match(json.kept[0].reason, /^could not enumerate \[gone\] branches/);
  assert.match(json.kept[0].reason, /for-each-ref: unable to read refs/, "git's own diagnosis must reach the reason, not just a label");
  assert.match(stderr, /KEEP \(no branch\) — could not enumerate \[gone\] branches/);
  assert.equal(branchExists(w, "feature/merged"), true, "a genuinely merged branch survives an enumeration that could not see it");
  assertShimFired(bin, "the git shim must actually have fired for this fixture", /^for-each-ref\b/);
});

test("git_probe's captured stderr on a successful `for-each-ref` still reaches the operator (#789)", (t) => {
  // git_probe (above) captures git's stderr into $gp_err instead of leaving
  // it on the real fd — #625, the whole reason it exists — and every OTHER
  // git_probe call site in reap.sh reads $gp_err back out through a targeted
  // check (gp_cut_short, gp_why) before falling through. This enumeration's
  // SUCCESS path did neither until this fix (PR #1413 review): an rc-0
  // `for-each-ref` that still warns used to reach the operator directly,
  // back when this was a plain `git … | awk …` pipeline with git's stderr
  // inherited, and reached no one once captured through git_probe unguarded.
  // Shimmed to warn but still exec the real git afterward, so the sweep
  // completes exactly as it would unshimmed — only the warning's presence on
  // stderr is under test here.
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  const bin = mkdtempSync(join(tmpdir(), "reap-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n` +
      `if [ "$1" = for-each-ref ]; then\n` +
      `  echo "warning: unable to access '/some/broken/config': Permission denied" >&2\n` +
      `fi\n` +
      `exec ${REAL_GIT} "$@"\n`,
    { mode: 0o755 },
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.equal(json.reaped.length, 1, "a genuinely gone branch is still reaped — the warning does not fail the enumeration");
  assert.match(
    stderr,
    /warning: unable to access '\/some\/broken\/config': Permission denied/,
    "git's own rc-0 warning must still reach the operator, not be silently captured and dropped by git_probe",
  );
});

test("a worktree lookup whose awk stage fails is kept, never treated as having no worktree (#789)", (t) => {
  // Before this fix this was a bare assignment: an awk that could not finish
  // scanning `$wt_list` failed the whole substitution, and because it is a
  // plain `wt=$(...)` command, `set -e` ended the ENTIRE script right there,
  // on awk's own diagnostic — never reaching `git branch -D` for this branch
  // at all, let alone any later one in the sweep.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "scratch.txt"), "would be lost if the worktree were removed blind\n");
  const bin = toolFailShim(
    t,
    "awk",
    REAL_AWK,
    `[ "$1" = "-v" ] && case "$3" in *'$2==b'*) : ;; *) false ;; esac`,
    ["awk: multibyte conversion failure"],
    2,
  );

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "an unanswerable worktree lookup is a finding, not a script failure");
  assert.deepEqual(json.reaped, []);
  assert.deepEqual(json.worktreesRemoved, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /^could not scan the worktree listing for feature\/merged/);
  assert.equal(branchExists(w, "feature/merged"), true, "the branch must survive an unanswerable worktree lookup");
  assert.equal(existsSync(wt), true, "the worktree and its uncommitted work must survive untouched");
  assert.equal(
    readFileSync(join(wt, "scratch.txt"), "utf8"),
    "would be lost if the worktree were removed blind\n",
  );
  assertToolShimFired(bin, "awk", "the awk shim must actually have fired for this fixture");
});

test("an ignored-files scan whose awk stage fails is kept, not silently read as clean (#789)", (t) => {
  // Before this fix `paste`, not `awk`, was this substitution's last stage,
  // so an awk that could not finish scanning `$gp_out` was masked completely:
  // the captured pipeline still succeeded (paste has nothing to fail on) and
  // the worktree was reaped as though it held no ignored files at all.
  // Injecting the fault at `awk` alone is only meaningful because the two are
  // now captured separately — proved by the sibling test below, which shows
  // the un-restructured pipeline's failure mode still exists at `paste`.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "outside"));
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so only the ignored-files scan is on the critical path");
  const bin = toolFailShim(
    t,
    "awk",
    REAL_AWK,
    `case "$1" in *'/^!! /'*) : ;; *) false ;; esac`,
    ["awk: multibyte conversion failure"],
    2,
  );

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "an unanswerable ignored-files scan is a finding, not a script failure");
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /^worktree .* ignored-files scan failed/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(existsSync(wt), true, "the worktree must survive untouched");
  assertToolShimFired(bin, "awk", "the awk shim must actually have fired for this fixture");
});

test("an ignored-files list whose paste stage fails is kept, never silently read as clean (#789)", (t) => {
  // The other half of the restructure: awk succeeds and reports a real
  // ignored file, and it is `paste`'s own join that cannot finish. Injecting
  // this fault at `awk` would prove nothing — the un-restructured pipeline
  // reported only `paste`'s status, which is exactly the masking #789 filed.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".env\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore .env");
  git(w, "push", "-q", "origin", "main");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work", join(w, "..", "outside"));
  writeFileSync(join(wt, ".env"), "SECRET=exists nowhere else\n");
  assert.equal(git(wt, "status", "--porcelain"), "", "fixture: tracked-clean, so only the ignored-files probe is on the critical path");
  const bin = toolFailShim(
    t,
    "paste",
    REAL_PASTE,
    `case "$*" in *'-sd,'*) : ;; *) false ;; esac`,
    ["paste: cannot allocate memory"],
    1,
  );

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0, "an unanswerable ignored-files join is a finding, not a script failure");
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.match(json.kept[0].reason, /^worktree .* ignored-files list could not be joined/);
  assert.equal(branchExists(w, "feature/merged"), true);
  assert.equal(
    readFileSync(join(wt, ".env"), "utf8"),
    "SECRET=exists nowhere else\n",
    "the precious file must survive the run",
  );
  assertToolShimFired(bin, "paste", "the paste shim must actually have fired for this fixture");
});

// --- #1020: the ambient git variables, one fixture each.
//
// Deliberately NOT one fixture setting both. PR #1015 measured the cost of
// that shortcut on release-ticket.sh: a case overriding only one of the pair
// leaves the other half of `unset GIT_DIR GIT_WORK_TREE` unpinned and green.
// Here the two halves are not even the same severity — GIT_WORK_TREE costs a
// `kept` reason, GIT_DIR moves the deletions into another repository — so one
// detector could not speak for both even if it caught both.

test("an ambient GIT_WORK_TREE does not make a dirty worktree reapable (#1020)", (t) => {
  // The silent-failure half. GIT_WORK_TREE outranks `-C`, so the worktree
  // sweep's `git -C "$wt" status --porcelain` reads the ambient tree against
  // $wt's index and answers EMPTY at rc 0 — the same false clean #730's
  // `showUntrackedFiles=no` produced, reached through the environment.
  //
  // Blast radius is bounded and that bound is deliberate, not luck: the
  // downstream `git worktree remove` runs without `--force`, so it refuses on
  // the real dirt and nothing is lost. What IS lost is the `kept` reason the
  // operator acts on, and a DRY RUN — where no `worktree remove` ever runs to
  // refuse — promising a removal that `--apply` cannot deliver. So this case
  // asserts the verdict, which is the part that actually breaks.
  //
  // `.gitignore` naming `.worktrees/` is load-bearing, not scenery: it is the
  // fleet's own layout, and it is what makes the leaked answer an EMPTY one
  // rather than a noisy `?? .worktrees/`. Committed before the worktree
  // branches off main, so $wt's index carries it too — otherwise the poisoned
  // status reports `?? .gitignore`, no false clean forms, and this fixture
  // would pass pre-fix while pinning nothing.
  const w = repo(t);
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n");
  git(w, "add", ".gitignore");
  commit(w, "ignore worktrees");
  git(w, "push", "-q", "origin", "main");
  const wt = mergedGoneBranchWithWorktree(w, "feature/merged", "merged work");
  writeFileSync(join(wt, "scratch.txt"), "work that exists nowhere else\n");

  // The fixture's own positive control, both directions. Without the first, a
  // case where the worktree was never dirty passes while measuring nothing;
  // without the second, a git that stopped honouring GIT_WORK_TREE leaves this
  // green over a leak that no longer exists.
  assert.equal(git(wt, "status", "--porcelain"), "?? scratch.txt",
    "fixture: the worktree must really be dirty, or this case measures nothing");
  assert.equal(
    execFileSync("git", ["-C", wt, "status", "--porcelain"], {
      cwd: w, env: { ...ENV, GIT_WORK_TREE: w }, encoding: "utf8",
    }),
    "",
    "fixture: the ambient GIT_WORK_TREE must really silence that answer, or the leak this pins no longer exists",
  );

  const { code, json, stderr } = runReap(w, [], { GIT_WORK_TREE: w });

  assert.equal(code, 0, stderr);
  assert.deepEqual(json.worktreesRemoved, [],
    "a dry run must not promise to remove a worktree `--apply` would be refused on");
  assert.deepEqual(json.reaped, []);
  assert.equal(json.kept.length, 1, `expected exactly the dirty-worktree keep: ${JSON.stringify(json.kept)}`);
  assert.equal(json.kept[0].branch, "feature/merged");
  assert.equal(json.kept[0].reason, `dirty worktree ${wt}`,
    "an ambient GIT_WORK_TREE must not turn the dirty-worktree keep into a reap");
});

test("an ambient GIT_DIR does not move the deletions into another repository (#1020)", (t) => {
  // The correctness half, and the destructive one. Not one git call in either
  // sweep carries a `-C`, so an ambient GIT_DIR does not merely misreport —
  // `git worktree remove` and `git branch -D` both land over there. Measured
  // pre-fix: rc 0, a receipt naming the other repository's worktree and
  // branch, and this checkout's own [gone] branch never looked at.
  const w = repo(t);
  const wt = mergedGoneBranchWithWorktree(w, "feature/here", "work here");
  const other = repo(t, "other");
  const otherWt = mergedGoneBranchWithWorktree(other, "feature/there", "work there");

  const { code, json, stderr } = runReap(w, ["--apply"], { GIT_DIR: join(other, ".git") });

  assert.equal(code, 0, stderr);
  // Three assertions, three distinct failures, and no two are redundant: the
  // first says the run did its own job, the second and third say it did not do
  // it somewhere else. A merely truncated sweep reds only the first; a
  // retargeted one reds all three.
  assert.deepEqual(json.reaped, ["feature/here"],
    "an ambient GIT_DIR must not stop this checkout's own [gone] branch being reaped");
  assert.equal(branchExists(other, "feature/there"), true,
    "an ambient GIT_DIR must not reach into another repository's branches");
  assert.equal(existsSync(otherWt), true,
    "and must not remove another repository's worktree");
  assert.equal(existsSync(wt), false, "this checkout's own worktree is the one that was due for removal");
});

// --- #1108: the exit-2 cause census.
//
// The five pins above each ask "does the row mention THIS cause?", every one of
// them taking its label off a real refusal. None asked "does the row mention
// EVERY cause?", so a PR that gave a script a new refusal left the row's
// `exit 2 only` list asserting an enumeration the script had outgrown with the
// suite green — measured twice in one fleet run (#1104/#525, #1105/#482). On `main`
// this row was silent about three refusals reap.sh reaches: the
// worktree-readers library guard, any of the three libraries failing to load,
// and the #1441 cwd-delete-guard probe refusing to proceed unverified.
//
// Two pins, closing opposite directions:
//
//   TOO NARROW — the script grows a refusal the row does not carry. `CAUSES`
//   binds every `die` site to the phrase that represents it, and the census
//   test asserts that binding is EXACTLY the set of sites the script has. Add
//   a `die` and it reds on an unbound site; delete one and it reds on a
//   binding whose cause the script can no longer produce. The set is derived
//   from the script, so the binding cannot rot silently the way the row did.
//
//   TOO BROAD — the row grows a cause no `die` produces. The census cannot see
//   that; a phrase added to the cell binds to nothing and no assert notices.
//   `EXIT2_ENUMERATION` is the pin that does: the whole closed list, byte for
//   byte, in the `UNKNOWN_LINE`/`ORPHAN_LINE` verbatim-constant discipline
//   no-undo-audit.test.mjs already uses on this same table.
//
// The span pin's cost is deliberate, and it was #1108's ruling: it reds on
// EVERY edit to the enumeration, a legitimate rewording included. A structural
// assertion loose enough to survive rewording cannot red on a rewrite that
// quietly drops a real cause, which is the defect that was measured twice.
//
// Scoped to this script's own suite beside the five pins above rather than
// lifted into one shared table over every row: `.out-of-scope/cli-guard-test-
// consolidation.md` refuses that consolidation for the CLI-guard pins, and its
// reason holds unchanged here — a file no single script's suite runs recreates
// the blind spot these pins exist to close.

/** The `Non-zero when` cell of this script's row, and no more of the row. */
const exit2Cell = () => specRow().split("|")[4];

/**
 * The row's exit-2 enumeration, verbatim: from `exit 2 only` to the end of the
 * sentence that closes the list. Everything after it in the cell states the
 * exit-0 findings — the kept-branch reasons the pins above read — so the span
 * stops where the closed list does. The slice is the size of the claim.
 */
const EXIT2_ENUMERATION =
  "exit 2 only — more than one argument, an unrecognised argument (#250), not a repository, `json.sh`, `net.sh` or `worktree.sh` missing, unreadable or failed to load (all three guards sit above the fetch, so nothing is deleted first), `git rev-parse --show-toplevel` failed with an error that is neither of the two known “not in a worktree” answers, so the cwd-delete guard could not be verified (#1441), the fetch failed or did not finish inside its budget and was killed (#347), `BASE_REF must be a remote-tracking ref` — the accept-list this script had none of, and the precondition that makes qualifying the base to its `refs/remotes/` spelling sound rather than a guess (#924) — the qualified `${BASE_REF:-origin/main}` does not resolve, which is also how a base that resolves only as a local TAG named `origin/main` refuses here instead of answering the merge probe with the wrong commit (#924), or, under `--apply`, `git worktree prune` failed, quoting git's own captured message (#992) — that last one prints the record before the prune runs, so it says the branches were reaped and the housekeeping failed, never that nothing happened.";

/**
 * The clause that collapses this script's six library refusals into one cause.
 * Named because six bindings below share it and a phrase typed six times
 * drifts five ways.
 */
const LIBRARY_CLAUSE = "`json.sh`, `net.sh` or `worktree.sh` missing, unreadable or failed to load";

/**
 * Every `die` site in reap.sh, bound to the phrase in the row that represents
 * it.
 *
 * The KEY is the message as the script spells it, interpolations and all.
 * `die` is this script's only exit-2 path — `dieSites` asserts that of the
 * definition itself — so the message set IS the cause set, and keying on it is
 * what makes this derived rather than a third hand-written copy of the
 * contract sitting beside the script and the row.
 *
 * Sites share a phrase where the ROW collapses them, which is the row's
 * editorial call and not a looseness here: a reader who meets any of the six
 * library refusals, or either fetch refusal, does the same thing about it. The
 * phrases are the short load-bearing labels; their exact wording is
 * `EXIT2_ENUMERATION`'s job.
 */
const CAUSES = new Map([
  ["cannot read $json_lib — refusing to reap without the JSON escaping helpers", LIBRARY_CLAUSE],
  ["$json_lib failed to load", LIBRARY_CLAUSE],
  ["cannot read $net_lib — refusing to reap without the bounded git transport", LIBRARY_CLAUSE],
  ["$net_lib failed to load", LIBRARY_CLAUSE],
  ["cannot read $wt_lib — refusing to reap without the worktree readers", LIBRARY_CLAUSE],
  ["$wt_lib failed to load", LIBRARY_CLAUSE],
  ["usage: reap.sh [--apply]", "more than one argument"],
  ["unrecognised argument '$1' — usage: reap.sh [--apply]", "an unrecognised argument (#250)"],
  ["BASE_REF must be a remote-tracking ref, got '$base'", "`BASE_REF must be a remote-tracking ref`"],
  ["not inside a git repository", "not a repository"],
  [
    "cannot tell whether this run is standing in a worktree slated for removal — 'git rev-parse --show-toplevel' failed with an unrecognised error (${self_wt_err:-exit $self_wt_rc}) instead of one of the two known 'not in a worktree' messages; refusing to reap with the cwd-delete guard unverified",
    "so the cwd-delete guard could not be verified (#1441)",
  ],
  ["git fetch did not finish within ${fetch_budget}s and was killed — refusing to reap on stale refs", "the fetch failed or did not finish inside its budget and was killed (#347)"],
  ["fetch failed — refusing to reap on stale refs", "the fetch failed or did not finish inside its budget and was killed (#347)"],
  ["$base does not resolve", "the qualified `${BASE_REF:-origin/main}` does not resolve"],
  ["git worktree prune failed: $(printf '%s' \"$prune_err\" | tr '\\n' ' ')", "`git worktree prune` failed"],
]);

/**
 * The message of every `die` call in the script, read off the script.
 *
 * Comment lines are dropped: prose quoting a `die "…"` is not a call site, and
 * minting a cause out of one would red this suite over a comment. Greedy to
 * the last quote on the line, so the `prune` message's own nested `"$…"`
 * substitution arrives whole rather than truncated at its first inner quote.
 */
function dieSites() {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(
    src,
    /^die\(\) \{ printf '%s: %s\\n' "\$NAME" "\$1" >&2; exit 2; \}$/m,
    "the census derives its cause set from one `die` that exits 2 — that definition has changed, so re-derive before trusting this file",
  );
  const sites = src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .flatMap((l) => [...l.matchAll(/(?:^|[;&|(\s])die "(.*)"/g)].map((m) => m[1]));
  assert.ok(sites.length > 1, `the scan found ${sites.length} die sites, so its spelling has drifted off the script`);
  assert.equal(new Set(sites).size, sites.length, `two die sites share a message, so one of them cannot be bound: ${sites.join(" / ")}`);
  return sites;
}

test("the design spec's row represents every exit-2 cause this script can reach, and none it cannot (#1108)", () => {
  // Both directions in one equality: an unbound site is a cause the row may be
  // silent about, and a binding with no site is a cause the row claims while
  // the script can no longer produce it.
  assert.deepEqual([...dieSites()].sort(), [...CAUSES.keys()].sort());

  const cell = exit2Cell();
  for (const phrase of new Set(CAUSES.values())) {
    assert.equal(
      cell.split(phrase).length - 1,
      1,
      `the \`Non-zero when\` cell must carry "${phrase}" exactly once.\ncell: ${cell}`,
    );
  }
});

test("the design spec's row states this script's exit-2 causes as a closed list, byte for byte (#1108)", () => {
  // A prefix, not a search: a cause smuggled in ahead of the list would sit
  // outside an `includes`, and this cell opens on the list.
  assert.equal(exit2Cell().trim().slice(0, EXIT2_ENUMERATION.length), EXIT2_ENUMERATION);
});

// The worktree-readers guard had no fixture at all before #1108, which is how
// its absence from the row survived: the missing-json.sh case above reaches the
// json guard, which fires first, so a lone copy of this script can never reach
// this one. json.sh and net.sh travel with the copy; worktree.sh does not.
test("a missing worktree.sh is exit 2, and the design spec's row names the library it blames (#1108)", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "chore/landed", "work that landed");
  const lone = mkdtempSync(join(tmpdir(), "reap-nowtlib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "reap.sh"));
  for (const lib of ["json.sh", "net.sh"]) {
    copyFileSync(fileURLToPath(new URL(`./${lib}`, import.meta.url)), join(lone, lib));
  }

  const r = spawnSync("sh", [join(lone, "reap.sh"), "--apply"], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 2, `a missing library is a refusal — this script has no exit 1 to be confused with: ${r.stderr}`);
  assert.equal(r.stdout, "", "no payload: nothing happened");
  assert.match(r.stderr, /refusing to reap without the worktree readers/,
    "the fixture must reach the worktree-readers guard rather than either guard above it");
  assert.ok(branchExists(w, "chore/landed"),
    "and the branch is still there — this guard sits above the fetch, so it is a clean refusal");

  // The library NAME off the real refusal, never typed here: the path around it
  // is the machine's to vary and no document can carry it. Pre-#1108 this row
  // named json.sh and net.sh alone, so this assert is what demonstrates the
  // omission by running the script rather than by reading it.
  const blamed = /^reap: cannot read \S*\/([^/ ]+) —/m.exec(r.stderr);
  assert.ok(blamed, `the refusal must name the library it could not read: ${r.stderr}`);
  assert.ok(
    exit2Cell().includes(`\`${blamed[1]}\``),
    `the spec row must name the library this refusal blames, and does not carry \`${blamed[1]}\`.\ncell: ${exit2Cell()}`,
  );
});

// #1039. The bounded-fetch pattern's coverage used to stop at the shared
// helper: net.sh's budget, its stalled-signal arm and its kill-tree walk are
// each pinned, and unattended-git-sweep.test.mjs pins that this script still
// sources net.sh and still reaches net_git — but nothing ever ran this
// script's OWN stalled-versus-failed wrapper. Measured on #1030's head:
// replacing `${fetch_budget}` in the stalled branch with an unbound variable,
// so `set -eu` aborts where `die` was meant to render, left this suite and
// unattended-git-sweep.test.mjs at their baseline pass counts, byte-identical.
//
// One pair, the shape net.test.mjs uses for verify-sha.sh and
// inflight.test.mjs for probe 2: one real slow transport, a budget above its
// delay and a budget under it. The WORDING is the assertion target, because
// `die` gives a killed fetch and a refused one the same exit 2 — the status
// alone cannot tell them apart, which is the whole reason the branch exists.
test("a slow but working fetch still reaps the merged [gone] branch — the budget is not a stopwatch on success", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  // mergedGoneBranch's own `git push --delete` above already left this
  // clone's local `refs/remotes/origin/feature/merged` gone — `[gone]` would
  // already be true before the bounded fetch below ever runs. Planting the
  // tracking ref back makes the verdict below reachable only through a fetch
  // that genuinely lands, not through the fixture's own prior pushes (#1039
  // review, finding 3).
  git(w, "update-ref", "refs/remotes/origin/feature/merged", git(w, "rev-parse", "feature/merged"));
  // Rewired only now: every push this fixture makes needs `receive-pack`, and
  // the stub serves `upload-pack` alone.
  const origin = git(w, "remote", "get-url", "origin");
  const stub = slowTransport(origin);
  git(w, "remote", "set-url", "origin", SSH_URL);
  warmStub(stub, ENV);

  const { code, json, stderr, error } = runReap(
    w,
    ["--apply"],
    { GIT_SSH_COMMAND: stub, FLEET_NET_TIMEOUT: "20" },
    60_000,
  );

  assert.equal(error, undefined, `the run did not come back: ${stderr}`);
  assert.equal(code, 0, `a budget above the delay must leave the verdict alone: ${stderr}`);
  assert.deepEqual(json.reaped, ["feature/merged"],
    "the refs really came back, so the delete is the one an unbounded fetch authorizes");
  assert.deepEqual(json.kept, []);
  assert.doesNotMatch(stderr, /did not finish within/,
    "and nothing claims a budget elapsed, which is the wording the failure path owns");
});

test("a fetch killed by its budget refuses to reap on stale refs, in this script's own words", (t) => {
  const w = repo(t);
  mergedGoneBranch(w, "feature/merged", "merged work");
  const origin = git(w, "remote", "get-url", "origin");
  const stub = slowTransport(origin);
  git(w, "remote", "set-url", "origin", SSH_URL);

  const { code, json, stderr, error } = runReap(
    w,
    ["--apply"],
    { GIT_SSH_COMMAND: stub, FLEET_NET_TIMEOUT: "1" },
    60_000,
  );

  assert.equal(error, undefined, `the run did not come back: ${stderr}`);
  assert.equal(code, 2, `a refusal — this script has no exit 1 to be confused with: ${stderr}`);
  assert.match(
    stderr,
    /reap: git fetch did not finish within 1s and was killed — refusing to reap on stale refs/,
    "this script's own decline, rendered, with the budget named in it: collapsing the stalled arm into the generic `fetch failed` decline keeps the same exit 2, so only this wording — not the status check — catches it",
  );
  assert.doesNotMatch(stderr, /fetch failed — refusing to reap/,
    "and not the refused-fetch wording, which names a cause this run never observed");
  assert.equal(json, null, "no payload: nothing was decided");
  assert.ok(branchExists(w, "feature/merged"),
    "and the branch a working fetch would have reaped is still there — a refusal that deleted anything would be reaping on exactly the stale refs it declined to trust");
});
