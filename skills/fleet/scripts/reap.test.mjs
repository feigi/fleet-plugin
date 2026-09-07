// Regression gate for reap.sh, the merge probe that authorizes deleting a
// [gone] branch. Zero deps: `node --test skills/fleet/scripts/reap.test.mjs`.
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

// Absolute path to the real git, for the one test that shadows `git` on PATH.
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

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

/** A PATH `git` that fails only the subcommand `match` names; everything else is real. */
function failOnlyShim(t, match, stderr, code = 1) {
  const bin = mkdtempSync(join(tmpdir(), "reap-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n` +
      `if ${match}; then\n` +
      // Shell-quoted, not `JSON.stringify`: that escapes for JSON, but the
      // splice lands in shell, where a `$` in a fixture line would expand
      // instead of reaching git's stderr as data.
      stderr.map((l) => `  printf '%s\\n' '${l.replace(/'/g, `'\\''`)}' >&2\n`).join("") +
      `  exit ${code}\n` +
      `fi\n` +
      `exec ${REAL_GIT} "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
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
const IGNORED_PROBE = `[ "$3" = status ] && { case " $* " in *" --ignored "*) : ;; *) false ;; esac; }`;

function runReap(cwd, args, envOverrides = {}) {
  const r = spawnSync("sh", [SCRIPT, ...args], {
    cwd,
    env: { ...ENV, ...envOverrides },
    encoding: "utf8",
  });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

function branchExists(w, name) {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: w, env: ENV }).status === 0;
}

function specRow() {
  const spec = readFileSync(
    fileURLToPath(new URL("../../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
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
  const bin = failOnlyShim(t, `[ "$1" = cherry ] && { printf '%s\\n' "warning: unable to access '/x/c++/lib/.gitattributes'" >&2; false; }`, []);

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

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
    `[ "$3" = status ] && [ "$4" = --porcelain ]`,
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
    `[ "$3" = status ] && [ "$4" = --porcelain ]`,
    ["warning: unrelated advice from git, not about this worktree's contents"],
    0,
  );

  const { code, json, stderr } = runReap(w, ["--apply"], withShim(bin));

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
    `[ "$3" = status ] && [ "$4" = --porcelain ]`,
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
    `[ "$3" = status ] && [ "$4" = --porcelain ]`,
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
    `[ "$3" = status ] && [ "$4" = --porcelain ]`,
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
  const bin = failOnlyShim(t, `[ "$1" = cherry ] && { printf '%s\\n' "warning: unable to access '/x/c++/lib/.gitattributes'" >&2; false; }`, []);

  const { code, json } = runReap(w, ["--apply"], withShim(bin));

  assert.equal(code, 0);
  assert.deepEqual(json.kept, [], "a `+` inside a diagnostic is not an unmerged commit");
  assert.deepEqual(json.worktreesRemoved, [wt], "noisy stderr must not strand a merged worktree");
  assert.equal(existsSync(wt), false);
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

  // Run from the bare root, not from `wt`: `--apply` removes `wt`, and a script
  // that deleted its own cwd dies in the `worktree prune` at the foot of the
  // file. That is a separate, pre-existing defect (filed) — not this test's
  // subject, and not something to reproduce inside it.
  const { code, json } = runReap(bare, ["--apply"], { BASE_REF: "main" });

  assert.equal(code, 0);
  assert.deepEqual(json.kept, [], `the bare root is not a finding: ${JSON.stringify(json.kept)}`);
  assert.deepEqual(json.worktreesRemoved, [wt], "and the detached worktree beside it is still swept");
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
