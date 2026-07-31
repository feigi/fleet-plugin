// Regression gate for release-ticket.sh, which deletes a claim's worktree and
// branch. Zero deps: `node --test skills/fleet/scripts/release-ticket.test.mjs`.
//
// It is guarded by four preconditions and every one of them is the only thing
// standing between a member's work and a delete, so each has a case here that
// proves it blocks ON ITS OWN — asserting the blocker it emits, not merely that
// the script exited non-zero, since any other precondition firing would satisfy
// that. Deleting a check must fail the case named after it.
//
// Real git throughout: a shell script that reasons about git history can only be
// tested against real git history. `gh` is the one thing stubbed, on PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./release-ticket.sh", import.meta.url));
const INFLIGHT = fileURLToPath(new URL("./inflight.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixtures, so a
// local pull.rebase or hook cannot change what these repos look like. BASE_REF
// is unset for the reason prove-merge.test.mjs unsets it: the fleet harness is
// exactly the caller that has it set, and inheriting it would point every
// fixture at a local main while the suite stayed green.
const ENV = {
  ...process.env,
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

/** Commit `content` as f.txt on the current branch; returns its sha. */
const commit = (w, msg, content) => {
  writeFileSync(join(w, "f.txt"), content);
  git(w, "add", "f.txt");
  git(w, "commit", "-q", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/**
 * Bare origin + working clone with one commit on main, plus a `gh` stub on
 * PATH. Returns the clone dir, the stub's call log path, and an env builder.
 */
function repo(t, dir = "w") {
  const root = mkdtempSync(join(tmpdir(), "release-ticket-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, dir);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commit(w, "root", "root\n");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");

  // The stub answers the two calls release-ticket.sh makes and the two
  // inflight.sh makes, keyed on the whole argument line because both scripts
  // reach GitHub through `gh issue view`. GH_RC turns any call into a failure.
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const log = join(root, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
[ "\${GH_RC:-0}" = 0 ] || { echo "gh: simulated failure" >&2; exit "\$GH_RC"; }
# GH_RC fails the label READ, which aborts before any delete. This one fails only
# the write, the single call that lands after both artefacts are already gone.
case "$*" in
  *"issue edit"*) [ "\${GH_EDIT_RC:-0}" = 0 ] || { echo "gh: HTTP 502" >&2; exit "\$GH_EDIT_RC"; } ;;
esac
[ -z "\${GH_STDERR:-}" ] || echo "\$GH_STDERR" >&2
# The check-then-act window: this call sits between the last precondition and
# the first delete, so writing here is a member committing during the round trip.
[ -z "\${GH_DIRTY:-}" ] || echo late > "\$GH_DIRTY"
case "$*" in
  *closedByPullRequestsReferences*) ;;
  *"--json labels"*) printf '%s\\n' "\${GH_LABELS-in-progress}" ;;
  *"pr list"*) printf '[]\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(log, "");

  return {
    w,
    log,
    env: (extra = {}) => ({ ...ENV, PATH: `${bin}:${ENV.PATH ?? process.env.PATH}`, ...extra }),
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
  };
}

/** What claim-ticket.sh leaves behind: a worktree on a fresh branch off origin/main. */
function claim(w, issue, slug, type = "fix") {
  const branch = `${type}/${issue}-${slug}`;
  const wt = join(w, ".worktrees", `${issue}-${slug}`);
  git(w, "worktree", "add", "-q", wt, "-b", branch, "origin/main");
  return { branch, wt, args: [String(issue), slug, type] };
}

function release(r, c, { apply = true, env = {} } = {}) {
  const argv = apply ? [...c.args, "--apply"] : c.args;
  const res = spawnSync("sh", [SCRIPT, ...argv], {
    cwd: r.w,
    env: r.env(env),
    encoding: "utf8",
  });
  return {
    code: res.status,
    json: res.stdout.trim() ? JSON.parse(res.stdout) : null,
    stderr: res.stderr,
  };
}

/** Does the claim still exist on disk and in git? */
const artefacts = (r, c) => ({
  dir: existsSync(c.wt),
  worktree: git(r.w, "worktree", "list", "--porcelain").includes(`branch refs/heads/${c.branch}`),
  branch: git(r.w, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").includes(c.branch),
});

test("a clean undispatched claim releases all three artefacts", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "fixture");

  const { code, json } = release(r, c);
  assert.equal(json.released, true);
  assert.deepEqual(json.blockers, []);
  assert.equal(code, 0);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
  assert.ok(
    r.calls().includes(`issue edit 9 --remove-label in-progress`),
    `the label is the half that hides the ticket from candidates.mjs: ${r.calls()}`,
  );
});

test("after a release the in-flight probe no longer reads the ticket as taken", (t) => {
  // The acceptance criterion, measured against the real consumer rather than
  // against this test's idea of one: inflight.sh, the script phase 0 runs.
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("inflight.sh needs python3");
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const probe = () => spawnSync("sh", [INFLIGHT, "9"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  assert.equal(probe().status, 1, "fixture: the claim really does read as taken first");

  assert.equal(release(r, c).code, 0);
  assert.equal(probe().status, 0, "a released ticket must go back into the pool");
});

test("a commit already upstream-equivalent still blocks: `ahead` catches what `git cherry` cannot", (t) => {
  // The case that proves the two commit checks are not one check written twice.
  // The branch's patch has been cherry-picked onto main, so `git cherry` calls it
  // equivalent and emits `-`; only the ahead count still sees the local commit.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const sha = commit(c.wt, "the member's work", "work\n");
  // -x, so the upstream copy is a distinct commit. A plain cherry-pick here
  // reproduces the branch commit byte for byte — same tree, parent, message and
  // second — and lands on the same sha, which is a different fixture entirely.
  git(r.w, "cherry-pick", "-x", sha);
  git(r.w, "push", "-q", "origin", "main");
  git(r.w, "fetch", "-q", "origin");
  assert.equal(
    git(r.w, "cherry", "origin/main", `refs/heads/${c.branch}`).charAt(0),
    "-",
    "fixture: git cherry really does read this commit as upstream-equivalent",
  );

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `only the ahead check can fire here: ${json.blockers}`);
  assert.match(json.blockers[0], /1 commit\(s\) ahead of/);
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a commit that exists nowhere else blocks, and `git cherry` says so", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  commit(c.wt, "the member's work", "work\n");

  const { code, json } = release(r, c);
  assert.ok(
    json.blockers.some((b) => /unique to .* \(git cherry\)/.test(b)),
    `the cherry check must report the commit as its own finding: ${json.blockers}`,
  );
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a dirty worktree blocks on its own", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `no commit exists, so only the dirty check can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /1 uncommitted change\(s\)/);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a pushed branch blocks on its own", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "push", "-q", "origin", c.branch);

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `the tree is clean and empty, so only the remote check can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /exists on origin/);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a blocked claim reports its blocker without asking GitHub", (t) => {
  // Measured in a fresh clone whose origin is not a GitHub remote: reaching for
  // the tracker first turns every offline blocked claim into an unanswerable
  // one and buries the finding. The blockers already decided the answer.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const { code, json } = release(r, c, { env: { GH_RC: "1" } });
  assert.equal(code, 1, "blocked, not unanswerable");
  assert.equal(json.blockers.length, 1);
  assert.equal(json.label, null, "the label was never read, and must not be reported as if it were");
  assert.deepEqual(r.calls(), [], "no tracker call is needed to know this claim is blocked");
});

test("the main checkout is never mistaken for the claim's worktree", (t) => {
  // Found in a fresh clone, where the claim branch is what HEAD points at. Match
  // the main worktree and `git worktree remove` refuses — but only after the
  // label has been dropped, leaving the ticket hidden from candidates.mjs with
  // both artefacts still on disk.
  const r = repo(t);
  git(r.w, "checkout", "-q", "-b", "fix/9-release-ticket", "origin/main");

  const { code, json } = release(r, { args: ["9", "release-ticket", "fix"] });
  assert.equal(json.worktree, "", "the main checkout is not a worktree this script may remove");
  assert.match(json.blockers.join(" "), /checked out in the main checkout/);
  assert.equal(code, 1);
  assert.deepEqual(r.calls(), [], "and the label is never touched");
  assert.ok(
    git(r.w, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").includes("fix/9-release-ticket"),
    "the branch survives",
  );
});

test("a worktree that is no longer on the branch blocks instead of releasing around it", (t) => {
  // `worktree list` locates the claim by its branch, and the worktree does not
  // stay on it: an interrupted rebase leaves it detached, a member can switch it.
  // Find nothing and the dirty check is skipped, so a claim whose worktree still
  // holds uncommitted work reports released — and the in-flight probe below still
  // reads the ticket as taken, which is the failure this script exists to fix.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(c.wt, "checkout", "-q", "--detach", "HEAD");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /is this claim's but is not on fix\/9-release-ticket/);
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(r.calls(), [], "and the label is never touched");
  assert.equal(existsSync(join(c.wt, "scratch.txt")), true, "the member's work stays put");
  assert.ok(
    git(r.w, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").includes(c.branch),
    "the branch survives",
  );
});

test("a repo path containing a space does not truncate the worktree it reads", (t) => {
  // `worktree list --porcelain` prints the path raw, so taking awk's $2 stops at
  // the first space — and every worktree under a directory like "My Repos", which
  // is ordinary on macOS, then reads as a different path. The dirty check either
  // dies on it or, if the truncation happens to name a clean directory, passes.
  const r = repo(t, "my repos");
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const { code, json } = release(r, c);
  // endsWith, not equal: macOS resolves the tmpdir through /private, so the
  // prefix legitimately differs. The part after the space is the whole point.
  assert.ok(
    json.worktree.endsWith("/my repos/.worktrees/9-release-ticket"),
    `the whole path, not the part before the space: ${json.worktree}`,
  );
  assert.equal(json.blockers.length, 1, `only the dirty check can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /1 uncommitted change\(s\)/);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a clean claim under a path with a space still releases", (t) => {
  // The other half: the space must not turn every release into a refusal either.
  const r = repo(t, "my repos");
  const c = claim(r.w, 9, "release-ticket");

  const { code, json } = release(r, c);
  assert.deepEqual([json.released, json.blockers, code], [true, [], 0]);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("an unreachable remote is an unknown answer, never a 'not pushed'", (t) => {
  // Swallowing this failure reads as "no remote branch" and releases a claim
  // whose work is already on the server.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "remote", "set-url", "origin", join(r.w, "..", "definitely-not-a-repo"));

  const { code, json, stderr } = release(r, c);
  assert.equal(json, null);
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 1 that means blocked");
  assert.match(stderr, /whether .* was pushed is unknown/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a gh failure aborts before anything is deleted", (t) => {
  // The label is read first on purpose: a release that removes the worktree and
  // branch but leaves in-progress hides the ticket from candidates.mjs entirely.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, stderr } = release(r, c, { env: { GH_RC: "1" } });
  assert.equal(code, 2);
  assert.match(stderr, /in-progress label cannot be released/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("the agent-test runner claim-ticket.sh writes is not dirt", (t) => {
  // Every fleet worktree carries it, and it is gitignored. Treating an ignored
  // file as dirt would block every release the drain step exists to make.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  appendFileSync(join(r.w, ".git", "info", "exclude"), "agent-test\n");
  writeFileSync(join(c.wt, "agent-test"), "#!/bin/sh\nexec npm test -- \"$@\"\n", { mode: 0o755 });

  const { code, json } = release(r, c);
  assert.deepEqual(json.blockers, []);
  assert.equal(code, 0);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("a dry run reports the release without performing it", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json, stderr } = release(r, c, { apply: false });
  assert.deepEqual([json.released, json.applied, code], [true, false, 0]);
  assert.match(stderr, /DRY RUN/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true });
  assert.ok(!r.calls().some((l) => l.startsWith("issue edit")), `dry run must not write: ${r.calls()}`);
});

test("a mistyped slug refuses instead of dropping the label off a live claim", (t) => {
  const r = repo(t);
  claim(r.w, 9, "release-ticket");

  const res = spawnSync("sh", [SCRIPT, "9", "relase-tikcet", "fix", "--apply"], {
    cwd: r.w, env: r.env(), encoding: "utf8",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /check the <slug> and <type> arguments/);
  assert.deepEqual(r.calls(), [], "not even a read, let alone the label edit");
});

test("an already-dropped label still releases the worktree and branch", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json } = release(r, c, { env: { GH_LABELS: "" } });
  assert.deepEqual([json.label, json.released, code], [false, true, 0]);
  assert.ok(!r.calls().some((l) => l.startsWith("issue edit")), "nothing to remove, so no write");
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("the script carries no escape hatch", () => {
  // `git worktree remove --force` discards uncommitted work and `git branch -D`
  // deletes commits that exist nowhere else — the two calls that make
  // commit-commands:clean_gone unusable here, and the two a future edit would
  // reach for the first time a precondition refuses.
  const src = readFileSync(fileURLToPath(new URL("./release-ticket.sh", import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(src, /--force/);
  assert.doesNotMatch(src, /branch\s+-D/);
});

test("usage errors exit 2", (t) => {
  const r = repo(t);
  // Assert the message, not just the code: a non-numeric issue falls through to
  // the mistyped-slug guard, which also exits 2, so deleting the numeric check
  // left this case green.
  const bad = (...a) => spawnSync("sh", [SCRIPT, ...a], { cwd: r.w, env: r.env(), encoding: "utf8" });
  assert.equal(bad("9").status, 2, "too few arguments");
  const nine = bad("nine", "slug", "fix");
  assert.equal(nine.status, 2);
  assert.match(nine.stderr, /issue must be a number/);
});

test("a chatty but successful gh does not fake an already-dropped label", (t) => {
  // The label was read with 2>&1 and substring-matched, so gh's own upgrade
  // notice on a SUCCESSFUL call broke the match: the script deleted the worktree
  // and branch and left in-progress on the ticket — invisible to candidates.mjs
  // with no artefact left to explain it, and exit 0 identical to a real release.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json } = release(r, c, {
    env: { GH_STDERR: "A new release of gh is available: 2.62.0 → 2.63.2" },
  });
  assert.equal(json.label, true, "the label is there and must be reported as there");
  assert.equal(code, 0);
  assert.ok(
    r.calls().includes("issue edit 9 --remove-label in-progress"),
    `the label must actually be dropped: ${r.calls()}`,
  );
});

test("a refused worktree removal leaves the label on the issue", (t) => {
  // The two local deletes run before the label edit, so a refusal — which is the
  // dirty check recomputed by git at delete time — leaves the claim exactly as
  // it was. Dropping the label first made every such refusal leave the ticket
  // reading free while re-claiming failed on the branch that was still there.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  // Clean at check time, dirty by delete time: the stub runs in between.
  const { code, json, stderr } = release(r, c, { env: { GH_DIRTY: join(c.wt, "late.txt") } });

  assert.equal(code, 2);
  assert.match(stderr, /PARTIALLY RELEASED|contains modified or untracked/);
  assert.equal(json.released, false, "a receipt is still printed — die used to exit before any printf");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
  assert.ok(
    !r.calls().some((l) => l.startsWith("issue edit")),
    `in-progress must survive so the ticket keeps reading as taken: ${r.calls()}`,
  );
});

test("a tracker that fails after both deletes still emits a receipt", (t) => {
  // The label edit runs last, so it is the one failure that ends with both
  // artefacts gone and in-progress still on the ticket — the single state a
  // caller cannot reconstruct by looking, and the one it must not guess at.
  // `die` printed prose and exited before every printf, so stdout was empty
  // exactly there. The other two halt() sites are reached with nothing deleted.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json, stderr } = release(r, c, { env: { GH_EDIT_RC: "1" } });
  assert.equal(code, 2);
  assert.notEqual(json, null, "a receipt is still printed — die exited before any printf");
  assert.equal(json.released, false);
  assert.equal(json.applied, true, "the mutations were attempted, unlike a blocked run");
  assert.equal(json.label, true, "in-progress survives, so the ticket keeps reading as taken");
  assert.match(stderr, /PARTIALLY RELEASED/);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false }, "both deletes landed");
});

test("a successful release survives a failing `git worktree prune`", (t) => {
  // prune ran unchecked as the last statement under `set -e`, so its failure
  // exited 1 — this script's code for "NOT released, nothing was touched" — out
  // of a release that had already dropped the label and deleted both artefacts.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  // A `git` shim on PATH that fails only on prune, and defers everything else.
  const shim = join(r.w, "..", "bin", "git");
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(shim, `#!/bin/sh\n[ "$1" = worktree ] && [ "$2" = prune ] && exit 3\nexec ${real} "$@"\n`, { mode: 0o755 });

  const { code, json } = release(r, c);
  assert.equal(code, 0, "the release succeeded; prune is housekeeping");
  assert.equal(json.released, true);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("BASE_REF must be a remote-tracking ref", (t) => {
  // The fleet harness is exactly the caller that sets it. Pointed at the claim's
  // own branch, ahead is 0 and cherry is empty on a branch carrying unpushed
  // work, so both commit guards pass and the release proceeds.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  commit(c.wt, "unpushed work", "work\n");

  const { code, json, stderr } = release(r, c, { env: { BASE_REF: `refs/heads/${c.branch}` } });
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /BASE_REF must be a remote-tracking ref/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a mistyped --apply is refused, never silently downgraded to a dry run", (t) => {
  // `--aply` matched nothing, so the run reported "released":true having deleted
  // nothing. A caller keying on that field marks the claim released while every
  // artefact survives: the silent queue shrink this script exists to undo.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  for (const arg of ["--aply", "--apply=true", "-n"]) {
    const res = spawnSync("sh", [SCRIPT, ...c.args, arg], { cwd: r.w, env: r.env(), encoding: "utf8" });
    assert.equal(res.status, 2, `${arg} must be refused`);
    assert.match(res.stderr, /unknown argument/);
    assert.equal(res.stdout.trim(), "", `${arg} must not report a release: ${res.stdout}`);
  }
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true });
});

test("an unreadable worktree is an unknown answer, never a clean one", (t) => {
  // A worktree whose .git file points nowhere: the directory is there, still
  // registered and still on the branch, and its status cannot be read.
  // Swallowed, that reads as no uncommitted changes and the release proceeds.
  // The directory has to still exist for this to be the unknown case — a gone
  // one is answerable, and the case below is what proves it.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, ".git"), `gitdir: ${join(r.w, ".git", "worktrees", "nope")}\n`);

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /whether it holds uncommitted work is unknown/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a worktree whose .git file is gone is unknown, never clean", (t) => {
  // Disjoint from both cases around it: the directory EXISTS, so -d is true, and
  // the .git file is not broken but absent — so `git -C` does not fail either. It
  // walks UP and reports the PARENT repository at rc 0, and the guard that exists
  // to answer "does THIS worktree hold uncommitted work?" answers about a
  // different repo. With `.worktrees/` gitignored — the fleet's own layout — the
  // worktree never appears in that parent status, so a clean parent makes the
  // leaked answer EMPTY: a positive assertion of clean, produced without ever
  // having looked at the worktree.
  const r = repo(t);
  writeFileSync(join(r.w, ".gitignore"), ".worktrees/\n");
  git(r.w, "add", ".gitignore");
  git(r.w, "commit", "-q", "-m", "ignore the worktrees dir");
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "precious.txt"), "work that exists nowhere else\n");
  rmSync(join(c.wt, ".git"));
  assert.equal(git(r.w, "status", "--porcelain"), "", "fixture: the leaked answer really is an empty one");

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2);
  // `git worktree remove` refuses this on its own, so a run that believed the
  // leaked answer still reaches exit 2 — by `halt`, announcing a partial release
  // and having asked the tracker. Pinning the die is what separates the guard
  // being right from a second, unrelated guard catching it downstream.
  assert.equal(json, null, "refused before any mutation, not halted after the delete refused");
  assert.match(stderr, /whether it holds uncommitted work is unknown/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
  assert.equal(readFileSync(join(c.wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});

test("a worktree directory deleted by hand releases instead of blocking forever", (t) => {
  // `worktree list --porcelain` keeps listing an entry whose directory is gone
  // (it marks it `prunable`), so the dirty check ran `git -C` against a path
  // that is not there and died at exit 2 — every run, permanently, leaving the
  // label and the branch behind for the in-flight probe to keep reading as
  // taken. That is the state this script exists to clear.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  rmSync(c.wt, { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(code, 0, "a directory that does not exist holds no work to protect");
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false }, "including the stale entry");
  assert.ok(
    r.calls().includes("issue edit 9 --remove-label in-progress"),
    `the label is what had to come off: ${r.calls()}`,
  );
});

test("a worktree deleted by hand while its branch carries work still blocks", (t) => {
  // The gone directory is the only thing the case above makes answerable. Every
  // other refusal is measured on the branch ref or on the worktree LIST, never
  // on the directory, and none of them may weaken because it went missing.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  commit(c.wt, "work", "work that exists nowhere else\n");
  rmSync(c.wt, { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(code, 1);
  assert.match(json.blockers.join(" "), /1 commit\(s\) ahead/);
  assert.deepEqual(
    artefacts(r, c),
    { dir: false, worktree: true, branch: true },
    "the branch, and the commit on it, survive",
  );
});

test("a worktree the script may not look at is unknown, never a release", (t) => {
  // -d is false for a directory we are not permitted to stat as surely as for
  // one that is gone, and git cannot separate them either: it marks both
  // `prunable` and `worktree remove` ACCEPTS a prunable entry, so the delete
  // cannot recompute what this guard gets wrong. Read as "gone", this released
  // the claim outright — branch deleted, label dropped, exit 0 — with the
  // member's uncommitted work still sitting on disk, unregistered and with no
  // branch left pointing at it.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "precious.txt"), "work that exists nowhere else\n");
  const parent = join(r.w, ".worktrees");

  chmodSync(parent, 0o000);
  const { code } = release(r, c);
  // Restored before the first assert, or a failure here leaves a fixture the
  // suite's own cleanup cannot remove.
  chmodSync(parent, 0o755);

  // The property, not this script's wording for it: the pre-fix code refused
  // here too, by a different route, and a case that pins the message would
  // call that safe version broken.
  assert.equal(code, 2);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
  assert.equal(readFileSync(join(c.wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("the whole .worktrees directory deleted by hand still releases", (t) => {
  // `rm -rf .worktrees` is how this usually happens, and it takes the parent
  // along with the child. Establishing absence one level up finds no parent
  // either and calls that unknown — which puts the case above straight back on
  // the permanent exit 2 this script was fixed to stop producing.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  rmSync(join(r.w, ".worktrees"), { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(code, 0, "the parent going too does not make the child unanswerable");
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
});

test("a quote in the slug cannot produce a payload the caller fails to parse", (t) => {
  // <slug> and <type> reach the JSON, as does git's own stderr, so a single `"`
  // used to emit output that JSON.parse rejects — after the delete, with the
  // exit code still reporting success.
  // A backslash is not a legal ref character, so the quote is the reachable half.
  const r = repo(t);
  const slug = 'a"b';
  git(r.w, "worktree", "add", "-q", join(r.w, ".worktrees", `9-${slug}`), "-b", `fix/9-${slug}`, "origin/main");

  const res = spawnSync("sh", [SCRIPT, "9", slug, "fix"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.branch, `fix/9-${slug}`, "and it round-trips, rather than being stripped");
});

test("a control character in the worktree name cannot produce an unparseable payload", (t) => {
  // git rejects a control character in a ref, so the quote above is the only way
  // in through <slug>-as-branch — but `stray` matches on the DIRECTORY name, and
  // a detached worktree can be called anything the filesystem allows. JSON
  // forbids every character below \040 unescaped, so escaping only `"` and `\`
  // left this emitting output the caller cannot parse.
  const r = repo(t);
  const slug = "ab";
  git(r.w, "worktree", "add", "-q", "--detach", join(r.w, ".worktrees", `9-${slug}`), "origin/main");

  const res = spawnSync("sh", [SCRIPT, "9", slug, "fix"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.branch, "fix/9-a b", "the control character is neutralised, not emitted raw");
  // The blockers carry an em-dash, so the scrub must be byte-safe for UTF-8.
  assert.match(parsed.blockers[0], /—/, "multibyte text must survive the scrub");
});
