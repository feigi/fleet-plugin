// Regression gate for verify-sha.sh, the check that says whether a member's
// reported SHA is really on the branch it claims. Zero deps:
// `node --test scripts/verify-sha.test.mjs`.
//
// A shell script that reasons about git history can only be tested against real
// git history, so every case below builds a throwaway origin+clone in a temp dir
// and runs the script for real.
//
// The load-bearing case is `a merge-base that fails rather than answers is exit
// 2, never reachable:false` (#266). Every non-zero status used to collapse into
// the definite verdict reachable:false at exit 1, so "the repository could not
// answer" and "the SHA is not on the branch" — the one distinction this script
// exists to make — were indistinguishable to the controller. Its two neighbours
// here, the reachable and the genuinely-not-reachable cases, are what keep the
// guard from over-firing: exit 1 has to survive as a real answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./verify-sha.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `pull.rebase` or hook cannot change what these repos look like. The
// GIT_* redirects would point the fixtures out of their own temp dirs.
const ENV = {
  ...process.env,
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

// Absolute path to the real sed, for the passthrough shim that controls the
// broken-escaper case. Resolved out here, where PATH is still the real one, and
// quoted at the exec, for the reasons the git shims below record at length.
const REAL_SED = execFileSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).trim();

/** Empty commit on the current branch; returns its sha. */
const commit = (w, msg) => {
  git(w, "commit", "-q", "--allow-empty", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/** Bare origin + working clone with one commit on main. Returns the clone dir. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "verify-sha-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commit(w, "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return w;
}

function verify(cwd, branch, sha, env = ENV) {
  const r = spawnSync("sh", [SCRIPT, branch, sha], { cwd, env, encoding: "utf8" });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

test("a sha on the branch is reachable — exit 0", (t) => {
  const w = repo(t);
  const head = commit(w, "work that really landed");
  git(w, "push", "-q", "origin", "main");

  const { code, json } = verify(w, "main", head);
  assert.equal(code, 0);
  assert.equal(json.reachable, true);
  assert.equal(json.sha, head);
  assert.equal(json.tip, head);
});

test("a sha on a stray branch is not reachable — exit 1, the answer the script exists to give", (t) => {
  const w = repo(t);
  // The nested-worktree scenario from the script's header: a real commit in this
  // repository that never made it onto the branch the member claims.
  git(w, "checkout", "-q", "-b", "stray");
  const stray = commit(w, "committed somewhere else");
  git(w, "checkout", "-q", "main");
  const tip = commit(w, "main moves on without it");
  git(w, "push", "-q", "origin", "main");

  const { code, json, stderr } = verify(w, "main", stray);
  assert.equal(code, 1, "a real negative stays exit 1 — it is an answer, not a failure");
  assert.equal(json.reachable, false);
  assert.equal(json.tip, tip);
  // Dropping `2>/dev/null` from the probe must not start leaking git noise onto
  // the ordinary negative path: git says nothing at all when the answer is "no".
  assert.doesNotMatch(stderr, /error:/, "a plain negative answer prints no git error");
});

test("a merge-base that fails rather than answers is exit 2, never reachable:false", (t) => {
  // The #266 defect: `git merge-base --is-ancestor` exits 128 when it cannot walk
  // the history — a corrupt or unreadable object — and every non-zero status used
  // to collapse into the definite verdict reachable:false at exit 1. Shim only
  // `merge-base`; everything else is real git, so the fetch and both preconditions
  // pass exactly as they do in the field and none of the existing exit-2 guards
  // fires. This is the same collapse #17 fixed in the sibling prove-merge.sh.
  const w = repo(t);
  const head = commit(w, "work that really landed");
  git(w, "push", "-q", "origin", "main");

  const bin = mkdtempSync(join(tmpdir(), "verify-sha-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // Ask the shell where git is, rather than deriving it from `--exec-path`: that
  // answer is `<prefix>/libexec/git-core` on macOS but `/usr/lib/git-core` on
  // Debian, where a `libexec` rewrite matches nothing and the shim execs a
  // DIRECTORY — the fetch then fails first and this test measures the wrong
  // failure. Resolved out here, where PATH is still the real one, and quoted at
  // the exec: a git under a path with a space word-splits otherwise, and the
  // fetch then dies first — which still satisfies the exit-2 and null-json
  // assertions below, so only the stderr match would catch it.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n[ "$1" = merge-base ] && { echo "error: could not parse commit deadbeef" >&2; exit 128; }\nexec "${REAL_GIT}" "$@"\n`,
    { mode: 0o755 },
  );

  const { code, json, stderr } = verify(w, "main", head, {
    ...ENV,
    PATH: `${bin}:${ENV.PATH ?? process.env.PATH}`,
  });
  assert.equal(json, null, "no verdict may be printed for a question that was never answered");
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 1 that means definitely-not-reachable");
  assert.match(stderr, /cannot tell reachable from unanswerable/);
  // The cause has to reach the operator, which is why the probe drops 2>/dev/null.
  assert.match(stderr, /could not parse commit/, "git's own diagnosis must survive to stderr");
});

test("a sha that is not a commit in this repository is exit 2, not a negative verdict", (t) => {
  // repo(t)'s root commit is enough: the 40-zero sha dies at the `cat-file -e`
  // guard before merge-base runs, so where the tip sits is unobservable here.
  const w = repo(t);
  const { code, json, stderr } = verify(w, "main", "0".repeat(40));
  assert.equal(code, 2);
  assert.equal(json, null);
  // Names the guard that fired, so this cannot pass on some other exit 2 — the
  // fetch failing is also exit 2 with no stdout, which is why the code alone
  // and an empty stdout are not enough to tell these two cases apart.
  assert.match(stderr, /cannot resolve 0{40} to a commit in this repository/);
  assert.match(stderr, /Not a valid object name/, "git's own diagnosis must survive to stderr");
});

test("a failed fetch carries git's own cause, and a bad URL no longer reads like a removed remote", (t) => {
  // #559: these two produced byte-identical output, "cannot fetch origin/main —
  // branch missing, or no network", naming neither failure. The sha is never
  // reached in any of these — the fetch guard fires first — so 40 zeros will do.
  const dead = "0".repeat(40);

  const badUrl = repo(t);
  git(badUrl, "remote", "set-url", "origin", "/nonexistent/path.git");
  const a = verify(badUrl, "main", dead);

  const noRemote = repo(t);
  git(noRemote, "remote", "remove", "origin");
  const b = verify(noRemote, "main", dead);

  for (const r of [a, b]) {
    assert.equal(r.code, 2);
    assert.equal(r.json, null, "no verdict for a question that was never answered");
    assert.match(r.stderr, /cannot fetch origin\/main/);
    assert.doesNotMatch(r.stderr, /branch missing|no network/, "the guard no longer asserts a cause it cannot know");
    assert.match(r.stderr, /does not appear to be a git repository/, "git's own diagnosis must survive to stderr");
  }
  // Only git's line tells the two apart, which is exactly what was discarded.
  assert.match(a.stderr, /'\/nonexistent\/path\.git'/);
  assert.doesNotMatch(b.stderr, /nonexistent/, "two distinct faults must not collapse into one message");

  // The one cause the old list did name is still reported — now by git, and
  // precisely, so dropping the list refuses nothing it used to explain.
  const c = verify(repo(t), "nosuchbranch", dead);
  assert.equal(c.code, 2);
  assert.match(c.stderr, /cannot fetch origin\/nosuchbranch/);
  assert.match(c.stderr, /couldn't find remote ref nosuchbranch/);
});

test("a failed fetch is fatal — the script stops rather than answering off a stale ref", (t) => {
  // #574: the case above asserts exit 2, no JSON, and git's cause on stderr, and
  // every one of those survives downgrading this guard's `die` to a warning. With
  // the guard advisory the script runs ON: `origin/main` still resolves from the
  // tracking ref the clone left behind, and the sha then dies at the `cat-file -e`
  // guard — which independently gives exit 2, no stdout, and leaves the `cannot
  // fetch` line and git's diagnosis sitting on stderr. Exit code, empty stdout and
  // a stderr substring are each reproducible by a later guard, so no conjunction
  // of them can see whether this one was fatal.
  //
  // What only fatality produces is the absence of progress: the `tip =` trace is
  // echoed on the line after this guard, so it appears if and only if execution
  // got past it. That line is pinned verbatim by "a healthy run stays quiet", so
  // it cannot be reworded out from under this assertion unseen — and unlike a
  // `doesNotMatch` on some later guard's message, it does not depend on which of
  // them happens to fire, or on how it is worded.
  const w = repo(t);
  // One fixture: a bad URL and a removed remote both take this guard's `|| die`
  // branch, differing only in git's own line — the distinction #565 pinned next
  // door. This test is about the guard's fatality, not about telling causes apart.
  git(w, "remote", "set-url", "origin", "/nonexistent/path.git");

  const { code, json, stderr } = verify(w, "main", "0".repeat(40));
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.doesNotMatch(
    stderr,
    /origin\/main tip =/,
    "a fetch that failed must stop the script, not warn and answer against an unupdated ref",
  );
});

test("a fetch that succeeds but leaves origin/<branch> unresolvable is exit 2 at the rev-parse guard", (t) => {
  const w = repo(t);
  // Real git throughout, no shim: with no fetch refspec configured, `git fetch
  // origin main` still succeeds — into FETCH_HEAD — without updating the
  // remote-tracking ref, so deleting that ref leaves the second guard to fire
  // while the first passes. A shim that killed the fetch would measure the
  // wrong failure, since that is also exit 2 with no stdout.
  git(w, "config", "--unset", "remote.origin.fetch");
  git(w, "update-ref", "-d", "refs/remotes/origin/main");

  const { code, json, stderr } = verify(w, "main", "0".repeat(40));
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /origin\/main does not resolve after fetch/);
  // #1146 added --verify to this capture, which changes git's own wording for
  // this exact failure: `fatal: Needed a single revision`, not the `ambiguous
  // argument` a bare `git rev-parse` prints for the same unresolvable ref.
  assert.match(stderr, /fatal: Needed a single revision/, "git's own diagnosis must survive to stderr");
  assert.doesNotMatch(stderr, /cannot fetch/, "the fetch passed — this is the guard after it");
});

test("a rev-parse that cannot resolve origin/<branch> is fatal — the script stops rather than answering off an empty tip", (t) => {
  // #580, the defect #574 fixed one guard up. The case above asserts exit 2, no
  // JSON, this guard's own message and git's cause — and every one of those
  // survives downgrading this guard's `die` to a warning. With it advisory `tip`
  // is empty, the script runs ON, and the `cat-file -e` guard below kills it:
  // exit 2 again, no stdout again, and this guard's own line still sitting on
  // stderr. Measured — the whole suite stayed green under that mutant, so no
  // conjunction of those three can see whether this guard was fatal.
  //
  // What only fatality produces is the absence of progress. The `tip =` trace is
  // echoed on the line after this guard, so it appears if and only if execution
  // got past it, and it is pinned verbatim by "a healthy run stays quiet", so it
  // cannot be reworded out from under this assertion unseen. git's own `Needed a
  // single revision` (#1146 added --verify, which is what produces this exact
  // wording rather than a bare rev-parse's `ambiguous argument`) is the other
  // bracket: it proves rev-parse ran and failed HERE, rather than this test
  // passing off an earlier guard that stopped the script before it. Neither
  // bracket names a `die` string, so rewording any guard's message — this one
  // included — leaves both standing.
  const w = repo(t);
  // The fixture of the case above: with no refspec configured the fetch still
  // succeeds, into FETCH_HEAD, so deleting the tracking ref leaves this guard to
  // fire while the one before it passes.
  git(w, "config", "--unset", "remote.origin.fetch");
  git(w, "update-ref", "-d", "refs/remotes/origin/main");

  const { code, json, stderr } = verify(w, "main", "0".repeat(40));
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /fatal: Needed a single revision/, "rev-parse ran and failed here, not some earlier guard");
  assert.doesNotMatch(
    stderr,
    /origin\/main tip =/,
    "a ref that does not resolve must stop the script, not warn and carry an empty tip onward",
  );
});

// #1146: the tip capture (`tip=$(git rev-parse "origin/$branch")`) had no
// `--verify`. Without it, an unresolvable "origin/<branch>" falls back to
// treating the argument as a PATH: if a file or dir of that name sits in the
// cwd, rev-parse prints it and exits 0, and this guard's own `|| die` never
// fires. This differs from the case above only in that a colliding path
// exists — same missing tracking ref, same fetch, same everything else.
test("a rev-parse that would fall back to a colliding path is still fatal, and names the tip guard as the cause", (t) => {
  const w = repo(t);
  git(w, "config", "--unset", "remote.origin.fetch");
  git(w, "update-ref", "-d", "refs/remotes/origin/main");
  // The collision: a file at the exact path "origin/main" would print, at
  // exit 0, wherever this guard let a bare `git rev-parse` fall back to it.
  mkdirSync(join(w, "origin"), { recursive: true });
  writeFileSync(join(w, "origin", "main"), "not a sha\n");

  const { code, json, stderr } = verify(w, "main", "0".repeat(40));
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /origin\/main does not resolve after fetch/, "this guard is what catches it");
  assert.match(stderr, /fatal: Needed a single revision/, "git's own --verify diagnosis must survive to stderr");
  // The discriminating pair: without --verify this guard does not catch this
  // fixture at all. Measured 2026-09-03 against a single-point mutant (this
  // capture with `--verify` removed, nothing else): the capture exits 0 with
  // the colliding PATH as the tip, and the run dies at the `git cat-file -e`
  // guard with `cannot resolve 0000… to a commit in this repository` — a
  // refusal about the sha, not about the ref. It never reaches
  // `git merge-base --is-ancestor`: an all-zero sha cannot clear `cat-file`.
  // Reaching merge-base takes a real commit for a sha, which is the mutant
  // test's fixture, not this one.
  assert.doesNotMatch(stderr, /cannot resolve .* to a commit/,
    "without --verify the colliding path is carried onward and the cat-file guard is what refuses — this guard must be the one that fires");
});

// The positive control criterion #1146 names explicitly: a real ref and a
// same-named path coexisting must still resolve the ref. Git's own
// precedence — try revision resolution before ever falling back to a path —
// makes this true for both the bare and the --verify forms; pinned here so a
// reader does not need to trust that reasoning, only this measurement.
test("a colliding path does not shadow a real remote-tracking ref", (t) => {
  const w = repo(t);
  const head = commit(w, "the ref, not the path, must win");
  git(w, "push", "-q", "origin", "main");
  mkdirSync(join(w, "origin"), { recursive: true });
  writeFileSync(join(w, "origin", "main"), "not a sha\n");

  const { code, json } = verify(w, "main", head);
  assert.equal(code, 0);
  assert.equal(json.reachable, true);
  assert.equal(json.tip, head, "the real ref's sha, never the colliding path's name");
});

// The regression control: what a fixture whose sha is a REAL commit catches
// WITHOUT --verify. Not the fixture of the colliding-path test above, whose
// all-zero sha is refused earlier, by `git cat-file -e`; the sha is what
// routes a run to one guard or the other. And not the shape a reader might
// assume from the ticket's general description of this bug class (a
// malformed-but-parseable payload at exit 0). Measured 2026-09-03: the
// `git merge-base --is-ancestor` guard re-resolves the identical
// "origin/$branch" string, and merge-base has no path fallback, so it
// independently refuses (rc 128) whenever the ref genuinely does not exist.
// That guard's own `|| die` already fires — this script was fail-closed
// before this fix too, by whichever guard the sha routed it to. What the
// mutant actually costs is the DIAGNOSIS: it dies with "cannot tell reachable
// from unanswerable" — a guard that exists to catch a broken `merge-base`,
// not an unresolvable ref — never with the tip guard's own "does not resolve
// after fetch". An operator reading the refusal is told the wrong thing
// failed.
test("mutant: without --verify, the same fixture is still caught, but by the wrong guard", (t) => {
  const w = repo(t);
  // A real commit, so the mutant's bogus tip gets past `git cat-file -e` and
  // reaches merge-base — the deepest point this bug can reach. Local existence
  // is the whole requirement: what makes merge-base refuse is the deleted
  // tracking ref, so this commit is deliberately NOT pushed.
  const head = commit(w, "a real commit, so the mutant runs all the way to merge-base");
  git(w, "config", "--unset", "remote.origin.fetch");
  git(w, "update-ref", "-d", "refs/remotes/origin/main");
  mkdirSync(join(w, "origin"), { recursive: true });
  writeFileSync(join(w, "origin", "main"), "not a sha\n");

  const scriptText = readFileSync(SCRIPT, "utf8");
  const FIXED_LINE = 'tip=$(git rev-parse --verify "origin/$branch")';
  assert.ok(scriptText.includes(FIXED_LINE), "the capture line moved — update this mutant to match");
  const scratch = mkdtempSync(join(tmpdir(), "verify-sha-mutant-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const mutant = join(scratch, "verify-sha.sh");
  writeFileSync(mutant, scriptText.replace(FIXED_LINE, 'tip=$(git rev-parse "origin/$branch")'), { mode: 0o755 });
  // The mutant sources json.sh/net.sh next to itself ("$(dirname "$0")"), so
  // both siblings have to travel with it or the run dies at the library guard
  // instead of measuring anything about this mutant.
  copyFileSync(fileURLToPath(new URL("./json.sh", import.meta.url)), join(scratch, "json.sh"));
  copyFileSync(fileURLToPath(new URL("./net.sh", import.meta.url)), join(scratch, "net.sh"));

  const r = spawnSync("sh", [mutant, "main", head], { cwd: w, env: ENV, encoding: "utf8" });
  assert.equal(r.status, 2, "still fails closed — merge-base's own guard catches it either way");
  assert.equal(r.stdout, "", "no payload either way — this bug never reaches the printf");
  assert.match(r.stderr, /cannot tell reachable from unanswerable/, "caught by the WRONG guard");
  assert.doesNotMatch(r.stderr, /origin\/main does not resolve after fetch/,
    "and never names the real cause — restoring that name is what this fix buys");
});

test("an object that is present but is not a commit is not reported as absent", (t) => {
  const w = repo(t);
  const tree = git(w, "rev-parse", "HEAD^{tree}");
  const { code, json, stderr } = verify(w, "main", tree);
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /cannot resolve .+ to a commit in this repository/);
  // The old wording asserted this object "is not a commit object in this
  // repository". It is in this repository — git reads it and reports its real
  // type, which is the half the guard was throwing away.
  assert.match(stderr, /dereferences to tree type/, "git's own diagnosis must survive to stderr");
});

test("a sha the cat-file guard rejects is fatal — the script stops rather than asking merge-base about it", (t) => {
  // #580's second site, and the one where the #574 remedy does not transcribe.
  // The guards around this one each have a progress marker on the line below
  // them; this one has none. The script emits nothing between it and the
  // merge-base status guard, and on both fixtures its two sibling cases use — 40
  // zeros, and a tree object — merge-base cannot resolve the object either, so
  // it exits 128 and that status guard kills the run. Measured: exit 2, empty
  // stdout and this guard's own line on stderr, all reproduced, and the suite
  // stayed green under the mutant. Neither `reachable` echo is ever reached, so
  // there is no marker here whose absence could be asserted.
  //
  // This fixture therefore removes the mask rather than looking for a marker
  // that is not there. `git cat-file` is shimmed to fail — standing in for the
  // unreadable object store this guard's own comment names as one of the things
  // it fires on — and every other git call is real. `$sha` is a genuinely
  // reachable commit, so with the guard downgraded merge-base answers normally
  // and the script runs to completion, printing `reachable:true` at exit 0. The
  // downgrade does not take a different route to exit 2; it returns the WRONG
  // ANSWER, which is why the exit code and the payload are pinned here too.
  const w = repo(t);
  const head = commit(w, "work that really landed");
  git(w, "push", "-q", "origin", "main");

  const bin = mkdtempSync(join(tmpdir(), "verify-sha-catfile-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // Resolved out here, where PATH is still the real one, and quoted at the exec,
  // for the reasons the merge-base shim above records at length.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n[ "$1" = cat-file ] && { echo "error: unable to read object" >&2; exit 1; }\nexec "${REAL_GIT}" "$@"\n`,
    { mode: 0o755 },
  );

  const { code, json, stderr } = verify(w, "main", head, {
    ...ENV,
    PATH: `${bin}:${ENV.PATH ?? process.env.PATH}`,
  });
  assert.equal(code, 2);
  assert.equal(json, null);
  // The positive control, and this test needs one: shimming `git` wholesale
  // could break the fetch instead, and a run that died two guards earlier gives
  // exit 2 with an empty stdout just the same — this test would pass while
  // measuring nothing. The `tip =` trace sits between the two, so it proves
  // execution reached THIS guard, and the shim's own line proves cat-file is
  // what failed. Both are pinned elsewhere: the trace verbatim by "a healthy run
  // stays quiet", the shim's line by the shim right here.
  assert.match(stderr, /origin\/main tip =/, "the fetch and the rev-parse guard both passed — this is the guard after them");
  assert.match(stderr, /unable to read object/, "cat-file ran and failed, which is the failure under test");
  assert.doesNotMatch(
    stderr,
    /IS reachable on origin\/main/,
    "a sha this guard could not resolve must stop the script, not warn and then report it as reachable",
  );
});

test("a healthy run stays quiet — the unmuted guards add nothing to stderr", (t) => {
  const w = repo(t);
  // Push from a second clone so `w`'s fetch has real objects to transfer: an
  // already-up-to-date fetch would not exercise the path that could go noisy.
  const other = join(w, "..", "other");
  execFileSync("git", ["clone", "-q", join(w, "..", "origin.git"), other], { env: ENV });
  const head = commit(other, "work that really landed");
  git(other, "push", "-q", "origin", "main");

  const { code, json, stderr } = verify(w, "main", head);
  assert.equal(code, 0);
  assert.equal(json.reachable, true);
  // Exact, not a /fatal:/ sniff. Dropping `2>/dev/null` from three guards is
  // only safe while all three stay silent when they succeed, and this script's
  // stderr is read by the fleet controller. Anything git starts printing on an
  // ordinary run shows up here as a fourth line.
  assert.deepEqual(stderr.split("\n").filter(Boolean), [
    "$ git fetch --quiet origin main",
    `    origin/main tip = ${head}`,
    `    ${head} IS reachable on origin/main`,
  ]);
});

// No git fixture: the argc guard fires before the script runs any git at all,
// so the cwd never has to be a repository.
test("a wrong argument count is exit 2", () => {
  const r = spawnSync("sh", [SCRIPT, "main"], { cwd: tmpdir(), env: ENV, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: verify-sha\.sh/);
});

// --- #119: the payload's own string fields.
//
// `git check-ref-format --branch 'evil"branch'` exits 0 — git accepts a double
// quote in a ref — so pushing a branch is all the access this needs. Spliced
// raw, the script emitted `{"branch":"evil"branch",…}` at **exit 0**: an
// unparseable payload with no signal at all that anything went wrong, while the
// contract row in `docs/specs/2026-07-23-fleet-plugin-design.md` documents the
// exit-0/1 payload as `{branch, sha, reachable, tip}`.
//
// Two of the three are reachable, not one. `$tip` is `git rev-parse`, which
// emits 40 hex characters and nothing else, and is wrapped for uniformity. But
// `$sha` is not: it is argv, and `git cat-file -e "${sha}^{commit}"` resolves
// any rev expression rather than only a hex object name — a REF name included —
// so a tag or branch holding a quote passes that gate and reaches the payload.
// The second test below is that vector, and it fails without the wrapping.
test("a branch name holding a double quote still emits parseable JSON", (t) => {
  const w = repo(t);
  const head = commit(w, "work on a hostile branch name");
  git(w, "branch", 'evil"branch');
  git(w, "push", "-q", "origin", 'evil"branch');

  const r = spawnSync("sh", [SCRIPT, 'evil"branch', head], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 0, "the sha IS on that branch — the quote must not change the verdict");
  const json = JSON.parse(r.stdout);
  assert.equal(json.branch, 'evil"branch', "and the field round-trips to the name that went in");
  assert.equal(json.reachable, true);
  assert.equal(json.tip, head);
});

// The `$sha` half of the same vector. `git cat-file -e 'evil"tag^{commit}'`
// resolves the TAG, so argv reaches the payload carrying a quote and the field
// is emitted as `"sha":"evil"tag"` — unparseable, at exit 0 — with the wrapping
// removed. Pinned separately from `$branch` because the two are independent
// operands of the same `&&` chain and either could be dropped alone.
test("a sha argument naming a quote-bearing ref still emits parseable JSON", (t) => {
  const w = repo(t);
  const head = commit(w, "work reachable by a hostile tag name");
  git(w, "tag", 'evil"tag', head);
  git(w, "push", "-q", "origin", "main");

  const r = spawnSync("sh", [SCRIPT, "main", 'evil"tag'], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 0, "the tag IS reachable on origin/main — the quote must not change the verdict");
  const json = JSON.parse(r.stdout);
  assert.equal(json.sha, 'evil"tag', "and the field round-trips to the argument that went in");
  assert.equal(json.reachable, true);
});

// No backslash case here, deliberately: measured, `git branch 'back\slash'`
// and `git check-ref-format --branch 'back\slash'` both exit 128 — git refuses
// a backslash in a ref outright. A branch name is this script's ONLY string
// input, so `\` is unreachable and a test for it would pin fiction. The
// backslash vector is real on the scripts whose input is a worktree PATH.

test("an ordinary branch name is untouched — the escaping accepts what it should", (t) => {
  // The false-positive half. A guard that mangles or refuses the names this
  // script sees on every healthy run is a different bug from the one above.
  const w = repo(t);
  const head = commit(w, "ordinary");
  git(w, "branch", "fix/119-json-sh-extract");
  git(w, "push", "-q", "origin", "fix/119-json-sh-extract");

  const r = spawnSync("sh", [SCRIPT, "fix/119-json-sh-extract", head], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 0);
  assert.equal(r.stdout, `{"branch":"fix/119-json-sh-extract","sha":"${head}","reachable":true,"tip":"${head}"}\n`,
    "byte-identical to what this script has always emitted for a name with nothing to escape");
});

// #884: the escaping guard's FATALITY, which every case above is blind to. They
// each assert what a WORKING escaper produces, so none of them reaches the
// `|| die` that covers the escaper failing — measured, downgrading it to a
// message-preserving warning left this whole suite green.
//
// The downgrade does not emit a malformed payload. `branch_j`, `sha_j` and
// `tip_j` are assigned by one `&&` chain, so the first `jstr` that fails
// short-circuits the rest and leaves those names unset; with the guard advisory
// the `printf` references one and `set -u` aborts the shell. Measured on this
// fixture, whose sha IS reachable, stdout empty in every run: unmutated,
// /bin/sh (macOS bash 3.2.57) and /bin/dash alike exit 2 with the guard's own
// line. Downgraded, /bin/sh aborts at exit 1 saying `sha_j: unbound variable`,
// and /bin/dash aborts at exit 2 saying `sha_j: parameter not set`.
//
// Exit 1 is what this script's contract reads as "the sha is NOT reachable", so
// under a bash-family `sh` the downgrade is a confident wrong verdict. An
// unparseable payload would at least fail the caller's parse; a bare exit 1
// instead has `run-team/SKILL.md` flag the member, withhold the enqueue and
// hold the ticket until a maintainer rules — spent on a SHA that was on the
// branch the whole time.
//
// Which abort it is, though, is the shell's to choose and not this script's,
// and dash's lands on 2 — the very status a firing guard returns. `verify`
// spawns a bare `sh`, and `.github/workflows/ci.yml`'s `check` job runs on
// `ubuntu-latest`, where that name resolves to dash: an exit-code assertion
// therefore pins this guard on a developer's Mac and waves the mutant through
// on the runner that gates the merge. `sha_j` is what discriminates instead.
// It reaches stderr only from that nounset abort — measured under /bin/sh and
// /bin/dash, no healthy run, no genuine `not reachable`, no ordinary `die` and
// no firing of this guard puts it there — while a shell aborting on it names
// it first and words the rest however it likes. Matching a wording pins the
// shell that uses that wording and no other.
//
// `jstr` escapes through a `sed`/`tr` pipeline, so shadowing `sed` breaks the
// escaper without touching git. The git shims elsewhere in this file cannot
// reach this guard: every failure they inject kills the run before the payload
// is built.
//
// Two brackets stand in for a progress marker this guard does not have — the
// script prints nothing between the escaping and the `printf` it protects. The
// `IS reachable` trace is echoed only once merge-base has answered, so it
// proves the run cleared every earlier guard, and the shim's own line proves
// the escaper is what failed. Between them, no other guard can produce this
// signature. The trace is pinned verbatim by "a healthy run stays quiet", so it
// cannot be reworded out from under this assertion unseen, and no assertion
// here names a `die` message — rewording any of them, this guard's own
// included, leaves the pin standing.

/** A dir holding a `sed` shim with the given body, prepended to PATH. */
function sedShim(t, body) {
  const bin = mkdtempSync(join(tmpdir(), "verify-sha-sed-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "sed"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}:${ENV.PATH ?? process.env.PATH}`;
}

test("an escaper that cannot run is exit 2, never the exit 1 that means `not reachable`", (t) => {
  const w = repo(t);
  const head = commit(w, "work that really landed");
  git(w, "push", "-q", "origin", "main");

  const { code, json, stderr } = verify(w, "main", head, {
    ...ENV,
    PATH: sedShim(t, 'echo "sed: outage" >&2\nexit 1'),
  });

  // Whether this fixture measured the guard at all is settled before its
  // verdict is read: an assertion that fails masks every one after it, and
  // "the shim broke something else" and "the guard is not fatal" are not
  // interchangeable diagnoses.
  assert.match(stderr, /sed: outage/, "the escaper ran and failed, which is the failure under test");
  assert.match(
    stderr,
    /IS reachable on origin\/main/,
    "merge-base answered — this is the guard after it, not an earlier one the shim happened to break",
  );

  assert.equal(
    code,
    2,
    "a payload that could not be escaped is `the question could not be answered`. Exit 1 would report a sha that IS on the branch as missing from it, and the controller would flag the member and hold its ticket for a maintainer's ruling.",
  );
  assert.equal(json, null, "no verdict may be printed for a payload that was never escaped");
  assert.doesNotMatch(
    stderr,
    /sha_j/,
    "the guard must stop the script, not warn and leave the payload `printf` reading names the `&&` chain never assigned. The NAME, never the wording: bash says `sha_j: unbound variable` at exit 1 and dash `sha_j: parameter not set` at exit 2, so a wording match and the exit-2 assertion each pass on the mutant under the shell CI actually runs.",
  );
});

test("a shadowed `sed` that works is answered normally — the guard refuses only a real outage", (t) => {
  // The false-positive half, and the control the case above needs: shadowing
  // `sed` on PATH is not by itself fatal to this script. Same fixture and the
  // same shadowed name, a passthrough body — so the exit 2 up there is the
  // escaper failing, not the shim's mere presence. Without this, that case
  // could be measuring a PATH it broke wholesale and still read green.
  const w = repo(t);
  const head = commit(w, "ordinary");
  git(w, "push", "-q", "origin", "main");

  const r = spawnSync("sh", [SCRIPT, "main", head], {
    cwd: w,
    env: { ...ENV, PATH: sedShim(t, `exec "${REAL_SED}" "$@"`) },
    encoding: "utf8",
  });

  assert.equal(r.status, 0, "the sha IS reachable — a working escaper must not change the verdict");
  assert.equal(
    r.stdout,
    `{"branch":"main","sha":"${head}","reachable":true,"tip":"${head}"}\n`,
    "byte-identical to the payload this script emits with no shim in the way",
  );
});

// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run — measured, /bin/sh
// (macOS bash 3.2), bash 3.2 and `bash --posix` all exit 1 with the guard
// unfired. Exit 1 out of THIS script means `the sha is not reachable`, the one
// distinction it exists to make. A missing file must never be able to say that.
test("a missing json.sh is exit 2, never the exit 1 that means `not reachable`", (t) => {
  const w = repo(t);
  const head = commit(w, "work");
  git(w, "push", "-q", "origin", "main");
  const lone = mkdtempSync(join(tmpdir(), "verify-sha-nolib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "verify-sha.sh"));

  const r = spawnSync("sh", [join(lone, "verify-sha.sh"), "main", head], { cwd: w, env: ENV, encoding: "utf8" });

  assert.equal(r.status, 2,
    "a missing library is `the question could not be answered`. Exit 1 would report a sha that IS on the branch as missing from it, and the controller would reject a PR that is exactly where it claims to be.");
  assert.match(r.stderr, /json\.sh/, "and it names the file rather than blaming the fetch or the ref");
  assert.equal(r.stdout, "", "no payload: nothing was answered");
});
