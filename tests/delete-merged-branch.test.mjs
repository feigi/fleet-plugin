// Regression gate for delete-merged-branch.sh — the merge bot's own branch
// deletion (#2196), replacing the repo setting "Automatically delete head
// branches" the fleet used to lean on.
//
// Zero deps: `node --test tests/delete-merged-branch.test.mjs`.
//
// Every fixture is a REAL bare origin and a real clone; only `gh` is stubbed.
// The assertion that matters is always read off the bare origin itself
// (`ls-remote`), never off the script's exit status or payload: #2196's trap
// is a merge step that reports success while the branch survives underneath
// it, so a test that only checked "exit 0" or "the delete was issued" would
// pass on exactly the broken implementation the ticket describes.
//
// The headline case puts the branch where every fleet-claimed ticket's branch
// lives — checked out in a linked worktree at `.worktrees/<issue>-<slug>` —
// which is where `gh pr merge --delete-branch`'s local cleanup dies with
// `fatal: 'main' is already used by worktree`. It then runs reap.sh over the
// result, so the whole post-merge chain is proved to leave no branch behind,
// remote or local.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/delete-merged-branch.sh", import.meta.url));
const REAP = fileURLToPath(new URL("../plugin/scripts/reap.sh", import.meta.url));
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// The gh stub's `pr list` pipes through the real jq (the script itself needs
// none: `gh --jq` is embedded). Without it every lookup would fail and the
// suite would read exit 2 everywhere — fail loudly instead of vacuously.
try {
  execFileSync("jq", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("jq is required to stub `gh pr list --jq`; install it before running this suite");
}

// Pinned identity, no developer config, no inherited repo pointers.
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

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

const commit = (w, msg) => {
  git(w, "commit", "-q", "--allow-empty", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/** Bare origin + clone with one commit on main, `.worktrees/` ignored as §2.5 requires. */
function repo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delete-merged-branch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV, stdio: "pipe" });
  writeFileSync(join(w, ".gitignore"), ".worktrees/\n.fleet/\n");
  git(w, "add", ".gitignore");
  commit(w, "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return { root, origin, w };
}

/** Whether refs/heads/<name> exists on the bare origin — the ground truth. */
const onOrigin = (origin, name) =>
  spawnSync("git", ["ls-remote", "--exit-code", "--heads", origin, `refs/heads/${name}`], { env: ENV }).status === 0;
const originTip = (origin, name) => git(origin, "rev-parse", `refs/heads/${name}`);

/**
 * A fleet-claimed ticket, merged: branch `name` checked out in the linked
 * worktree `.worktrees/<wtName>`, pushed, merged `--no-ff` into main on origin
 * the way `gh pr merge --merge` does, and the remote branch LEFT IN PLACE — the
 * state a repo with auto-delete off is in after the merge. Returns the head
 * GitHub would report as `headRefOid`, and the worktree path.
 */
function mergedInWorktree(w, name, wtName) {
  const wt = join(w, ".worktrees", wtName);
  git(w, "worktree", "add", "-q", wt, "-b", name, "main");
  const oid = commit(wt, `work on ${name}`);
  git(wt, "push", "-q", "-u", "origin", name);
  git(w, "merge", "-q", "--no-ff", "-m", `Merge ${name}`, name);
  git(w, "push", "-q", "origin", "main");
  return { oid, wt };
}

/**
 * A `gh` stub answering the script's `pr view` call and its two `pr list`
 * lookups, from env vars. Returns a call log reader and an env builder.
 *
 * `pr list` is a faithful fake rather than canned output: it filters
 * PR_LIST_JSON — every PR in the repo, `[{number,state,headRefName,
 * baseRefName,isCrossRepository}]` — by `--head`/`--base`/`--state` the way
 * GitHub does (`--head` matches a fork PR whose branch shares the name), then
 * pipes the result through the real `jq` with the script's own `--jq`
 * expression, so the selection the script asks for is under test rather than
 * hard-coded into the fixture. PR_LIST_FAIL=head|base makes that lookup exit
 * 1; PR_LIST_RAW_HEAD/PR_LIST_RAW_BASE replace its output verbatim at exit 0.
 * ISSUE_EDIT_FAIL is a space-separated list of issue numbers whose
 * `issue edit` exits 1; ISSUE_VIEW_FAIL names the one issue whose `issue view`
 * does.
 */
function ghStub(t, root) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "gh.log");
  const labels = join(root, "labels");
  mkdirSync(labels, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  "pr view "*" --json state,isCrossRepository,headRefName,headRefOid,baseRefName --jq "*)
    [ "\${GH_FAIL:-0}" = 0 ] || { echo "gh: simulated failure" >&2; exit 1; }
    printf '%s\\037%s\\037%s\\037%s\\037%s\\n' "\${PR_STATE:-MERGED}" "\${PR_CROSS:-false}" "\$PR_HEAD" "\$PR_OID" "\${PR_BASE:-main}"
    exit 0
    ;;
  "pr view "*" --json state --jq .state")
    printf '%s\\n' "\${PR_STATE:-MERGED}"
    exit 0
    ;;
  "pr view "*" --json closingIssuesReferences "*)
    [ "\${CLOSES_FAIL:-0}" = 0 ] || { echo "gh: simulated closing-issues failure" >&2; exit 1; }
    [ -z "\${PR_CLOSES:-}" ] || printf '%s\\n' "$PR_CLOSES"
    exit 0
    ;;
  "pr view "*" --json commits "*)
    [ "\${COMMITS_FAIL:-0}" = 0 ] || { echo "gh: simulated commits failure" >&2; exit 1; }
    [ -z "\${PR_COMMITS:-}" ] || printf '%s\\n' "$PR_COMMITS"
    exit 0
    ;;
  "issue view "*" --json labels "*)
    [ "\${ISSUE_VIEW_FAIL:-}" != "$3" ] || { echo "gh: simulated issue view failure" >&2; exit 1; }
    [ -f "${labels}/$3" ] || { echo "gh: no such issue $3" >&2; exit 1; }
    cat "${labels}/$3"
    exit 0
    ;;
  "issue edit "*" --remove-label in-progress")
    case " \${ISSUE_EDIT_FAIL:-} " in *" $3 "*) echo "gh: simulated issue edit failure" >&2; exit 1 ;; esac
    grep -vx in-progress "${labels}/$3" > "${labels}/$3.tmp" || true
    mv "${labels}/$3.tmp" "${labels}/$3"
    exit 0
    ;;
  "pr list "*) ;;
  *) echo "gh: unstubbed call: $*" >&2; exit 1 ;;
esac
shift 2
head= base= state= expr=. which= limit=30
while [ $# -gt 0 ]; do
  case "$1" in
    --head) head=$2; which=head; shift 2 ;;
    --base) base=$2; which=base; shift 2 ;;
    --state) state=$2; shift 2 ;;
    --limit) limit=$2; shift 2 ;;
    --jq) expr=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ "\${PR_LIST_FAIL:-}" = "$which" ] && { echo "gh: simulated pr list --$which failure" >&2; exit 1; }
if [ "$which" = head ] && [ -n "\${PR_LIST_RAW_HEAD+set}" ]; then printf '%s\\n' "$PR_LIST_RAW_HEAD"; exit 0; fi
if [ "$which" = base ] && [ -n "\${PR_LIST_RAW_BASE+set}" ]; then printf '%s\\n' "$PR_LIST_RAW_BASE"; exit 0; fi
printf '%s' "\${PR_LIST_JSON:-[]}" |
  jq --arg head "$head" --arg base "$base" --arg state "$state" --argjson limit "$limit" \\
    '[.[] | select(($head == "" or .headRefName == $head) and ($base == "" or .baseRefName == $base) and ($state == "" or $state == "all" or (.state | ascii_downcase) == $state))] | .[:$limit]' |
  jq -r "$expr"
`,
    { mode: 0o755 },
  );
  return {
    bin,
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    edits: () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("issue edit ")),
    /** Give issue `n` its labels, one per line — the state `issue view`/`issue edit` read and write. */
    setLabels: (n, ...names) => writeFileSync(join(labels, String(n)), names.map((l) => `${l}\n`).join("")),
    labelsOf: (n) => readFileSync(join(labels, String(n)), "utf8").split("\n").filter(Boolean),
    env: (extra = {}) => ({ ...ENV, PATH: `${bin}:${ENV.PATH}`, ...extra }),
  };
}

/** One PR as GitHub's `gh pr list --json` would describe it. */
const pr = (number, headRefName, baseRefName, state = "OPEN", isCrossRepository = false) => ({
  number,
  state,
  headRefName,
  baseRefName,
  isCrossRepository,
});

/**
 * `json` is the branch half's one-line payload, read off the LAST stdout line
 * that starts with `{` — label-failure tokens print before it. Exit 3 prints
 * `branch-kept-#<n>` lines instead; `tokens` is every stdout line that is a
 * `label-*` token, in order.
 */
function run(cwd, args, env, script = SCRIPT) {
  const r = spawnSync("sh", [script, ...args], { cwd, env, encoding: "utf8" });
  const lines = r.stdout.split("\n").filter(Boolean);
  const payload = lines.filter((l) => l.startsWith("{")).pop();
  return {
    code: r.status,
    stdout: r.stdout,
    json: payload ? JSON.parse(payload) : null,
    tokens: lines.filter((l) => l.startsWith("label-")),
    stderr: r.stderr,
  };
}

test("a merged branch checked out in a .worktrees/<issue>-<slug> worktree is deleted from origin, and reap.sh then reaps it locally", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/2196-delete-branch";
  const { oid, wt } = mergedInWorktree(w, branch, "2196-delete-branch");
  assert.ok(onOrigin(origin, branch), "fixture: the branch must still be on origin after the merge");
  const gh = ghStub(t, root);

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 7, branch, deleted: true });
  assert.equal(onOrigin(origin, branch), false, "the branch must actually be gone from origin, not merely reported deleted");
  // Remote-only: the worktree and its local branch are untouched, so a held
  // worktree can neither make this step fail nor lose anything to it.
  assert.ok(existsSync(wt), "the worktree must survive this step — it is reap.sh's to remove");
  assert.equal(git(wt, "rev-parse", "HEAD"), oid);
  assert.doesNotMatch(r.stderr, /already used by worktree/);

  // The rest of the chain: the controller reaps on the merge bot's report.
  const reap = spawnSync("sh", [REAP, "--apply"], { cwd: w, env: ENV, encoding: "utf8" });
  assert.equal(reap.status, 0, reap.stderr);
  assert.deepEqual(JSON.parse(reap.stdout).reaped, [branch]);
  assert.equal(
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: w, env: ENV }).status,
    1,
    "the local branch must be gone once reap.sh has run",
  );
  assert.equal(existsSync(wt), false, "the worktree must be gone once reap.sh has run");
});

test("a merged branch that was never checked out locally is deleted the same way — a hand-opened PR or the controller's own chore PR", (t) => {
  const { root, origin, w } = repo(t);
  // Pushed from a second clone, so this checkout has no worktree and no local
  // branch for it at all. The quote is legal in a refname and must survive
  // into the JSON payload escaped.
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", origin, other], { env: ENV });
  const branch = 'chore/run-artifacts-"x"';
  git(other, "switch", "-q", "-c", branch);
  const oid = commit(other, "artifacts");
  git(other, "push", "-q", "origin", branch);
  git(other, "switch", "-q", "main");
  git(other, "merge", "-q", "--no-ff", "-m", "merge", branch);
  git(other, "push", "-q", "origin", "main");
  const gh = ghStub(t, root);

  const r = run(w, ["8"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 8, branch, deleted: true });
  assert.equal(onOrigin(origin, branch), false);
});

// What this change must ACCEPT: a repo that still has auto-delete on (GitHub
// removed the branch at the merge instant) must not turn every merge into a
// failure report.
test("a branch already gone from origin is success, and no delete is pushed", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "feat/9-gone";
  const { oid } = mergedInWorktree(w, branch, "9-gone");
  git(w, "push", "-q", "origin", "--delete", branch);
  const gh = ghStub(t, root);

  const r = run(w, ["9"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 9, branch, deleted: false, alreadyGone: true });
  assert.doesNotMatch(r.stderr, /git push/);
  assert.equal(onOrigin(origin, branch), false);
});

test("a branch whose tip moved after the merge is NOT deleted — the lease refuses, exit 1", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/10-moved";
  const { oid, wt } = mergedInWorktree(w, branch, "10-moved");
  const later = commit(wt, "pushed after the merge");
  git(wt, "push", "-q", "origin", branch);
  const gh = ghStub(t, root);

  const r = run(w, ["10"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.deleted, false);
  assert.equal(r.json.tip, later);
  assert.match(r.json.reason, /a push landed after the merge/);
  assert.equal(originTip(origin, branch), later, "commits main never received must survive");
});

// The trap #2196 names: the delete is issued, reports success, and the
// branch is still there. A `git` that swallows `push` at exit 0 is exactly
// that, and only the read-back can catch it.
test("a delete that exits 0 but leaves the branch on origin is a failure, never a success", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/11-silent";
  const { oid } = mergedInWorktree(w, branch, "11-silent");
  const gh = ghStub(t, root);
  writeFileSync(
    join(gh.bin, "git"),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = push ] && exit 0; done\nexec "${REAL_GIT}" "$@"\n`,
    { mode: 0o755 },
  );

  const r = run(w, ["11"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.deleted, false);
  assert.match(r.json.reason, /exited 0 and the branch is still on origin/);
  assert.ok(onOrigin(origin, branch));
});

test("a delete the remote refuses is exit 1 with the branch still reported", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/12-refused";
  const { oid } = mergedInWorktree(w, branch, "12-refused");
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'deletes are protected' >&2\nexit 1\n", { mode: 0o755 });
  const gh = ghStub(t, root);

  const r = run(w, ["12"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.tip, oid);
  assert.match(r.json.reason, /git push --delete exited [1-9]/);
  assert.ok(onOrigin(origin, branch));
});

// A push the script's own net budget kills is not a server's refusal: the
// reason must say it was killed, the way remote_tip says it for ls-remote.
test("a delete killed by the net budget says so, exit 1 with the branch still reported", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/19-stalled";
  const { oid } = mergedInWorktree(w, branch, "19-stalled");
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\nsleep 20\nexit 1\n", { mode: 0o755 });
  const gh = ghStub(t, root);

  const r = run(w, ["19"], gh.env({ PR_HEAD: branch, PR_OID: oid, FLEET_NET_TIMEOUT: "1" }));

  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.json.tip, oid);
  assert.match(r.json.reason, /git push --delete did not finish within 1s and was killed/);
  assert.ok(onOrigin(origin, branch));
});

// The race the script's last branch exists for: the push fails, yet something
// else (a repo still auto-deleting) removed the branch between the two reads.
// The outcome this step exists for holds, so it is not a failure — but nor is
// it this run's delete.
test("a failed push whose branch is gone on the read-back is already gone, not deleted", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/20-raced";
  const { oid } = mergedInWorktree(w, branch, "20-raced");
  const gh = ghStub(t, root);
  writeFileSync(
    join(gh.bin, "git"),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = push ] && { "${REAL_GIT}" "$@"; exit 1; }; done\nexec "${REAL_GIT}" "$@"\n`,
    { mode: 0o755 },
  );

  const r = run(w, ["20"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 20, branch, deleted: false, alreadyGone: true });
  assert.equal(onOrigin(origin, branch), false);
});

test("a PR that is not merged is refused before any git call, branch untouched", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/13-open";
  const { oid } = mergedInWorktree(w, branch, "13-open");
  const gh = ghStub(t, root);

  for (const state of ["OPEN", "CLOSED"]) {
    const r = run(w, ["13"], gh.env({ PR_STATE: state, PR_HEAD: branch, PR_OID: oid }));
    assert.equal(r.code, 2, state);
    assert.match(r.stderr, new RegExp(`not merged \\(state=${state}\\)`));
    assert.doesNotMatch(r.stderr, /ls-remote|git push/);
    assert.equal(r.json, null);
  }
  assert.ok(onOrigin(origin, branch));
});

test("a fork PR is skipped — a same-named branch on our origin is not its head", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/14-fork";
  const { oid } = mergedInWorktree(w, branch, "14-fork");
  const gh = ghStub(t, root);

  const r = run(w, ["14"], gh.env({ PR_CROSS: "true", PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 14, branch, deleted: false, skipped: "cross-repository" });
  assert.ok(onOrigin(origin, branch));
});

test("a head that names the base branch is refused, base untouched", (t) => {
  const { root, origin, w } = repo(t);
  const gh = ghStub(t, root);
  const main = originTip(origin, "main");

  const r = run(w, ["15"], gh.env({ PR_HEAD: "main", PR_OID: main }));

  assert.equal(r.code, 2);
  assert.match(r.stderr, /is its base branch 'main'/);
  assert.equal(originTip(origin, "main"), main);
});

test("usage errors refuse before calling gh", (t) => {
  const { root, w } = repo(t);
  const gh = ghStub(t, root);
  for (const args of [[], ["abc"], ["007"], ["01"], ["1", "2"]]) {
    const r = run(w, args, gh.env());
    assert.equal(r.code, 2, JSON.stringify(args));
  }
  assert.deepEqual(gh.calls(), []);
});

test("a failed gh read is exit 2, not a verdict", (t) => {
  const { root, w } = repo(t);
  const gh = ghStub(t, root);
  const r = run(w, ["16"], gh.env({ GH_FAIL: "1" }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /gh pr view 16 failed/);
  assert.equal(r.json, null);
});

// A tab is IFS whitespace, so a tab-joined read collapses an empty field and
// shifts the rest left — the base branch then reads as the head commit.
test("an empty head branch from gh is refused as missing, not misread as a later field", (t) => {
  const { root, w } = repo(t);
  const gh = ghStub(t, root);
  const r = run(w, ["21"], gh.env({ PR_HEAD: "", PR_OID: "a".repeat(40) }));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /returned no head branch or head commit/);
  assert.equal(r.json, null);
});

test("an unreachable origin is exit 2, never read as an already-gone branch", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/17-unreachable";
  const { oid } = mergedInWorktree(w, branch, "17-unreachable");
  git(w, "remote", "set-url", "origin", join(root, "nowhere.git"));
  const gh = ghStub(t, root);

  const r = run(w, ["17"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 2);
  assert.match(r.stderr, /git ls-remote failed/);
  assert.equal(r.json, null);
  assert.ok(onOrigin(origin, branch));
});

// An ambient GIT_DIR naming another repository would point `ls-remote origin`
// at THAT repository's origin, where the branch does not exist — read as
// already gone, exit 0, with the real branch still on the real origin.
test("an ambient GIT_DIR naming another repository does not redirect the delete", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "fix/18-ambient";
  const { oid } = mergedInWorktree(w, branch, "18-ambient");
  const decoy = join(root, "decoy");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", decoy], { env: ENV });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", join(root, "decoy-origin.git")], { env: ENV });
  git(decoy, "remote", "add", "origin", join(root, "decoy-origin.git"));
  const gh = ghStub(t, root);

  const r = run(w, ["18"], gh.env({ PR_HEAD: branch, PR_OID: oid, GIT_DIR: join(decoy, ".git") }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 18, branch, deleted: true });
  assert.equal(onOrigin(origin, branch), false);
});

// #2295: deleting a branch closes every open PR headed by it, and may close
// rather than retarget every open PR based on it. Either one keeps the branch:
// no push, one `branch-kept-#<pr>` line per such PR, exit 3. The proof that no
// delete went out is read off the bare origin — the tip is still the merged head.
function keptFixture(t, branch, wtName) {
  const { root, origin, w } = repo(t);
  const { oid } = mergedInWorktree(w, branch, wtName);
  return { origin, w, oid, gh: ghStub(t, root) };
}

test("an open PR headed by the branch keeps it — no push, branch-kept-#<that PR>, exit 3", (t) => {
  const branch = "fix/22-head";
  const { origin, w, oid, gh } = keptFixture(t, branch, "22-head");
  const list = [pr(22, branch, "main", "MERGED"), pr(31, branch, "release")];

  const r = run(w, ["22"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_LIST_JSON: JSON.stringify(list) }));

  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.stdout, "branch-kept-#31\n");
  assert.match(r.stderr, /open PR #31 uses fix\/22-head as its head/);
  assert.doesNotMatch(r.stderr, /git push/);
  assert.equal(originTip(origin, branch), oid);
});

test("an open PR based on the branch keeps it — no push, branch-kept-#<that PR>, exit 3", (t) => {
  const branch = "fix/23-base";
  const { origin, w, oid, gh } = keptFixture(t, branch, "23-base");
  const list = [pr(23, branch, "main", "MERGED"), pr(40, "feat/40-stacked", branch)];

  const r = run(w, ["23"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_LIST_JSON: JSON.stringify(list) }));

  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.stdout, "branch-kept-#40\n");
  assert.match(r.stderr, /open PR #40 uses fix\/23-base as its base/);
  assert.doesNotMatch(r.stderr, /git push/);
  assert.equal(originTip(origin, branch), oid);
});

test("open PRs of both kinds print one branch-kept-# line per PR, exit 3", (t) => {
  const branch = "fix/24-both";
  const { origin, w, oid, gh } = keptFixture(t, branch, "24-both");
  const list = [
    pr(24, branch, "main", "MERGED"),
    pr(51, branch, "release"),
    pr(9, "feat/9-stacked", branch),
    pr(60, "feat/60-stacked", branch),
    pr(70, "feat/70-old", branch, "CLOSED"),
  ];

  const r = run(w, ["24"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_LIST_JSON: JSON.stringify(list) }));

  assert.equal(r.code, 3, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").sort(), ["branch-kept-#51", "branch-kept-#60", "branch-kept-#9"]);
  assert.doesNotMatch(r.stderr, /git push/);
  assert.equal(originTip(origin, branch), oid);
});

test("every open PR on the branch gets its branch-kept-# line, however many there are — gh lists 30 unless asked for more", (t) => {
  const branch = "fix/25-many";
  const { origin, w, oid, gh } = keptFixture(t, branch, "25-many");
  const list = [pr(25, branch, "main", "MERGED")];
  for (let n = 100; n < 140; n++) list.push(pr(n, `feat/${n}-stacked`, branch));

  const r = run(w, ["25"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_LIST_JSON: JSON.stringify(list) }));

  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 40);
  assert.equal(originTip(origin, branch), oid);
});

test("a failed or unparsable open-PR lookup is exit 2, names the lookup, and pushes nothing", (t) => {
  const branch = "fix/25-unknown";
  const { origin, w, oid, gh } = keptFixture(t, branch, "25-unknown");
  const cases = [
    [{ PR_LIST_FAIL: "head" }, /lookup `gh pr list --head fix\/25-unknown` failed/],
    [{ PR_LIST_FAIL: "base" }, /lookup `gh pr list --base fix\/25-unknown` failed/],
    [{ PR_LIST_RAW_HEAD: "[]" }, /lookup `gh pr list --head fix\/25-unknown` answered with something that is not a list of PR numbers/],
    [{ PR_LIST_RAW_BASE: "40\nnull" }, /lookup `gh pr list --base fix\/25-unknown` answered with something that is not a list of PR numbers/],
  ];
  for (const [extra, named] of cases) {
    const r = run(w, ["25"], gh.env({ PR_HEAD: branch, PR_OID: oid, ...extra }));
    const label = JSON.stringify(extra);
    assert.equal(r.code, 2, `${label}: ${r.stderr}`);
    assert.match(r.stderr, named, label);
    assert.doesNotMatch(r.stderr, /git push/, label);
    assert.equal(r.stdout, "", label);
  }
  assert.equal(originTip(origin, branch), oid);
});

// What the guard must ACCEPT: none of these PRs is affected by the delete —
// the merged PR itself, closed PRs, a merged PR based on the branch, a fork PR
// whose own branch merely shares the name (`--head` matches it; it lives in the
// fork), and an open PR on an unrelated branch. A guard that kept on any of them
// would stop every delete.
test("PRs the delete cannot affect do not keep the branch — it is deleted, exit 0", (t) => {
  const branch = "fix/26-clear";
  const { origin, w, oid, gh } = keptFixture(t, branch, "26-clear");
  const list = [
    pr(26, branch, "main", "MERGED"),
    pr(27, branch, "main", "CLOSED"),
    pr(28, "feat/28-old", branch, "MERGED"),
    pr(29, branch, "main", "OPEN", true),
    pr(30, "feat/30-other", "main"),
  ];

  const r = run(w, ["26"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_LIST_JSON: JSON.stringify(list) }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 26, branch, deleted: true });
  assert.equal(onOrigin(origin, branch), false);
});

// The lookups guard a delete; a branch already gone has none left to guard,
// so a lookup that would fail cannot turn the outcome this step exists for
// into "can't tell", and nothing is kept to report.
test("a branch already gone is success even when an open-PR lookup would fail", (t) => {
  const { root, origin, w } = repo(t);
  const branch = "feat/32-gone";
  const { oid } = mergedInWorktree(w, branch, "32-gone");
  git(w, "push", "-q", "origin", "--delete", branch);
  const gh = ghStub(t, root);

  const r = run(w, ["32"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_LIST_FAIL: "head" }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 32, branch, deleted: false, alreadyGone: true });
});

// The label half. Running this step on a merged PR also drops `in-progress`
// from every issue the PR closes, so a bot that runs it cannot skip the drop.
// The label state lives in the gh stub's per-issue files, so "the label is
// gone" is read off what `issue edit` actually did, never off a canned answer.

const LABEL_SCRIPT = fileURLToPath(new URL("../plugin/scripts/drop-merged-label.sh", import.meta.url));
const LABEL_EDIT = (n) => `issue edit ${n} --remove-label in-progress`;

/** A merged PR whose branch is checked out in a worktree and still on origin, with a gh stub. */
function mergedFixture(t, branch, wtName) {
  const { root, origin, w } = repo(t);
  const { oid } = mergedInWorktree(w, branch, wtName);
  return { root, origin, w, oid, gh: ghStub(t, root) };
}

/**
 * The host scripts copied beside a label script of the caller's choosing (or
 * none), so a sibling that is missing, unreadable or misbehaving is under
 * test. The host resolves the sibling from its own location.
 */
function hostCopy(t, labelBody) {
  const dir = mkdtempSync(join(tmpdir(), "delete-merged-branch-copy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of ["delete-merged-branch.sh", "json.sh", "net.sh"]) {
    writeFileSync(join(dir, f), readFileSync(fileURLToPath(new URL(`../plugin/scripts/${f}`, import.meta.url))));
  }
  if (labelBody !== null) writeFileSync(join(dir, "drop-merged-label.sh"), labelBody);
  return join(dir, "delete-merged-branch.sh");
}

test("end to end: a bot that runs only this step leaves no in-progress on the issue the PR closes", (t) => {
  const branch = "fix/2751-label";
  const { origin, w, oid, gh } = mergedFixture(t, branch, "2751-label");
  gh.setLabels(41, "in-progress", "bug");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41" }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { pr: 7, branch, deleted: true });
  assert.equal(r.stdout.trim(), JSON.stringify({ pr: 7, branch, deleted: true }), "stdout carries only the branch half's payload");
  assert.equal(onOrigin(origin, branch), false, "the branch is deleted exactly as before");
  assert.deepEqual(gh.labelsOf(41), ["bug"], "in-progress is gone, the other label is untouched");
  assert.deepEqual(gh.edits(), [LABEL_EDIT(41)]);
  assert.match(r.stderr, /dropped in-progress/, "the label half's own output is on stderr");
});

test("an issue named only in a commit message loses the label too", (t) => {
  const branch = "fix/2751-commit";
  const { origin, w, oid, gh } = mergedFixture(t, branch, "2751-commit");
  gh.setLabels(42, "in-progress");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_COMMITS: "Do the thing\n\nCloses #42" }));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(onOrigin(origin, branch), false);
  assert.deepEqual(gh.labelsOf(42), []);
  assert.deepEqual(gh.edits(), [LABEL_EDIT(42)]);
});

test("every closing issue is released, from both signals at once", (t) => {
  const branch = "fix/2751-both";
  const { w, oid, gh } = mergedFixture(t, branch, "2751-both");
  gh.setLabels(41, "in-progress");
  gh.setLabels(42, "in-progress");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41", PR_COMMITS: "Fixes #42" }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(gh.edits(), [LABEL_EDIT(41), LABEL_EDIT(42)]);
});

// The label half runs right after the MERGED gate, so every later exit path
// already carries its outcome.
const OTHER_EXITS = [
  {
    name: "the branch is kept for another open PR (exit 3)",
    code: 3,
    arrange: (f) => ({
      PR_LIST_JSON: JSON.stringify([pr(31, f.branch, "main")]),
    }),
    check: (r) => assert.equal(r.stdout, "branch-kept-#31\n"),
  },
  {
    name: "the branch is already gone",
    code: 0,
    arrange: (f) => {
      git(f.w, "push", "-q", "origin", "--delete", f.branch);
      return {};
    },
    check: (r) => assert.equal(r.json.alreadyGone, true),
  },
  {
    name: "the PR is cross-repository",
    code: 0,
    arrange: () => ({ PR_CROSS: "true" }),
    check: (r) => assert.equal(r.json.skipped, "cross-repository"),
  },
  {
    name: "the delete fails (exit 1)",
    code: 1,
    arrange: (f) => {
      writeFileSync(join(f.origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'deletes are protected' >&2\nexit 1\n", { mode: 0o755 });
      return {};
    },
    check: (r) => assert.equal(r.json.deleted, false),
  },
  {
    name: "a later read fails (exit 2)",
    code: 2,
    arrange: (f) => {
      git(f.w, "remote", "set-url", "origin", join(f.root, "nowhere.git"));
      return {};
    },
    check: (r) => assert.match(r.stderr, /git ls-remote failed/),
  },
  {
    name: "the head commit is not a hex SHA (exit 2)",
    code: 2,
    arrange: () => ({ PR_OID: "not-a-sha" }),
    check: (r) => assert.match(r.stderr, /not a hex SHA/),
  },
];

for (const [i, c] of OTHER_EXITS.entries()) {
  test(`the label is dropped when ${c.name}`, (t) => {
    const branch = `fix/2751-exit-${i}`;
    const f = { ...mergedFixture(t, branch, `2751-exit-${i}`), branch };
    f.gh.setLabels(41, "in-progress");
    const extra = c.arrange(f);

    const r = run(f.w, ["7"], f.gh.env({ PR_HEAD: branch, PR_OID: f.oid, PR_CLOSES: "41", ...extra }));

    assert.equal(r.code, c.code, r.stderr);
    c.check(r);
    assert.deepEqual(r.tokens, []);
    assert.deepEqual(f.gh.labelsOf(41), []);
    assert.deepEqual(f.gh.edits(), [LABEL_EDIT(41)]);
  });
}

test("a PR that is not merged is refused with no issue edit", (t) => {
  const branch = "fix/2751-open";
  const { origin, w, oid, gh } = mergedFixture(t, branch, "2751-open");
  gh.setLabels(41, "in-progress");

  for (const state of ["OPEN", "CLOSED"]) {
    const r = run(w, ["7"], gh.env({ PR_STATE: state, PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41" }));

    assert.equal(r.code, 2, state);
    assert.match(r.stderr, /not merged/);
    assert.deepEqual(r.tokens, []);
  }
  assert.deepEqual(gh.edits(), []);
  assert.deepEqual(gh.labelsOf(41), ["in-progress"]);
  assert.ok(onOrigin(origin, branch));
});

test("a missing label script refuses with exit 2 before any gh call or push", (t) => {
  const branch = "fix/2751-missing";
  const { origin, w, oid, gh } = mergedFixture(t, branch, "2751-missing");
  gh.setLabels(41, "in-progress");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41" }), hostCopy(t, null));

  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot read .*drop-merged-label\.sh/);
  assert.deepEqual(gh.calls(), []);
  assert.ok(onOrigin(origin, branch), "nothing was pushed");
  assert.deepEqual(gh.labelsOf(41), ["in-progress"]);
});

test("an unreadable label script refuses the same way", { skip: process.getuid?.() === 0 }, (t) => {
  const branch = "fix/2751-unreadable";
  const { origin, w, oid, gh } = mergedFixture(t, branch, "2751-unreadable");
  const host = hostCopy(t, "exit 0\n");
  chmodSync(join(dirname(host), "drop-merged-label.sh"), 0o000);

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid }), host);

  assert.equal(r.code, 2);
  assert.deepEqual(gh.calls(), []);
  assert.ok(onOrigin(origin, branch));
});

test("a label script resolves beside the host, whatever the caller's cwd or PATH", (t) => {
  const branch = "fix/2751-sibling";
  const { w, oid, gh } = mergedFixture(t, branch, "2751-sibling");
  gh.setLabels(41, "in-progress");
  // A decoy on PATH under the sibling's name must never run in its place.
  writeFileSync(join(gh.bin, "drop-merged-label.sh"), "#!/bin/sh\necho decoy >&2\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(w, "drop-merged-label.sh"), "echo cwd-decoy >&2\nexit 0\n");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41" }));

  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /decoy/);
  assert.deepEqual(gh.labelsOf(41), []);
});

test("a failed removal alone exits 4 and names the issue on stdout, before the branch output", (t) => {
  const branch = "fix/2751-drop-failed";
  const { origin, w, oid, gh } = mergedFixture(t, branch, "2751-drop-failed");
  gh.setLabels(41, "in-progress");
  gh.setLabels(43, "in-progress");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41\n43", ISSUE_EDIT_FAIL: "41" }));

  assert.equal(r.code, 4, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter(Boolean), ["label-drop-failed-#41", JSON.stringify({ pr: 7, branch, deleted: true })]);
  assert.equal(onOrigin(origin, branch), false, "a label failure never stops the branch delete");
  assert.deepEqual(gh.labelsOf(41), ["in-progress"]);
  assert.deepEqual(gh.labelsOf(43), [], "the other issue is still released");
});

test("two issues whose removals both fail print one token each, in order, and exit 4", (t) => {
  const branch = "fix/2751-drop-failed-two";
  const { origin, w, oid, gh } = mergedFixture(t, branch, "2751-drop-failed-two");
  gh.setLabels(41, "in-progress");
  gh.setLabels(43, "in-progress");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41\n43", ISSUE_EDIT_FAIL: "41 43" }));

  assert.equal(r.code, 4, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter(Boolean), ["label-drop-failed-#41", "label-drop-failed-#43", JSON.stringify({ pr: 7, branch, deleted: true })]);
  assert.equal(onOrigin(origin, branch), false, "a label failure never stops the delete");
  assert.deepEqual(gh.labelsOf(41), ["in-progress"]);
  assert.deepEqual(gh.labelsOf(43), ["in-progress"]);
});

test("a failed removal together with a failed branch delete exits 1 and prints both", (t) => {
  const branch = "fix/2751-both-failed";
  const { origin, w, oid, gh } = mergedFixture(t, branch, "2751-both-failed");
  gh.setLabels(41, "in-progress");
  writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41", ISSUE_EDIT_FAIL: "41" }));

  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(r.tokens, ["label-drop-failed-#41"]);
  assert.equal(r.json.deleted, false);
  assert.ok(onOrigin(origin, branch));
});

test("a failed removal with a kept branch exits 3 and prints the token and the keep lines", (t) => {
  const branch = "fix/2751-kept-failed";
  const { w, oid, gh } = mergedFixture(t, branch, "2751-kept-failed");
  gh.setLabels(41, "in-progress");

  const r = run(
    w,
    ["7"],
    gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41", ISSUE_EDIT_FAIL: "41", PR_LIST_JSON: JSON.stringify([pr(31, branch, "main")]) }),
  );

  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.stdout, "label-drop-failed-#41\nbranch-kept-#31\n");
});

test("a failed removal with an unanswerable branch half exits 2 and still prints the token", (t) => {
  const branch = "fix/2751-exit2-failed";
  const { w, oid, gh } = mergedFixture(t, branch, "2751-exit2-failed");
  gh.setLabels(41, "in-progress");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41", ISSUE_EDIT_FAIL: "41", PR_LIST_FAIL: "head" }));

  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(r.tokens, ["label-drop-failed-#41"]);
});

test("an issue whose labels cannot be read is a failed drop, never a clear one", (t) => {
  const branch = "fix/2751-view-failed";
  const { w, oid, gh } = mergedFixture(t, branch, "2751-view-failed");
  gh.setLabels(41, "in-progress");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41", ISSUE_VIEW_FAIL: "41" }));

  assert.equal(r.code, 4, r.stderr);
  assert.deepEqual(r.tokens, ["label-drop-failed-#41"]);
});

for (const [name, extra] of [
  ["closing-issues", { CLOSES_FAIL: "1" }],
  ["commits", { COMMITS_FAIL: "1" }],
]) {
  test(`a failed ${name} read after the merge is confirmed prints label-read-failed-#<pr>, never "nothing to drop"`, (t) => {
    const branch = `fix/2751-read-${name}`;
    const { origin, w, oid, gh } = mergedFixture(t, branch, `2751-read-${name}`);
    gh.setLabels(41, "in-progress");

    const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41", ...extra }));

    assert.equal(r.code, 4, r.stderr);
    assert.deepEqual(r.tokens, ["label-read-failed-#7"]);
    assert.match(r.stderr, /exited 2/, "stderr names the raw exit code");
    assert.equal(onOrigin(origin, branch), false, "the branch delete still runs");
    assert.deepEqual(gh.edits(), []);
  });
}

for (const [name, body, rawCode] of [
  ["exit 1 naming no issue", "echo '{}'\nexit 1\n", "1"],
  ["an unknown exit code", "exit 7\n", "7"],
  ["death by signal", "kill -TERM $$\nsleep 5\n", "143"],
]) {
  test(`a label script that ends with ${name} is label-read-failed-#<pr>`, (t) => {
    const branch = "fix/2751-odd-label";
    const { origin, w, oid, gh } = mergedFixture(t, branch, "2751-odd-label");

    const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid }), hostCopy(t, body));

    assert.equal(r.code, 4, r.stderr);
    assert.deepEqual(r.tokens, ["label-read-failed-#7"]);
    assert.match(r.stderr, new RegExp(`exited ${rawCode}`));
    assert.equal(onOrigin(origin, branch), false);
  });
}

test("an issue that no longer carries the label is left alone", (t) => {
  const branch = "fix/2751-clear";
  const { w, oid, gh } = mergedFixture(t, branch, "2751-clear");
  gh.setLabels(41, "bug");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41" }));

  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(gh.edits(), []);
});

test("running the host twice edits once and exits by the branch half alone", (t) => {
  const branch = "fix/2751-twice";
  const { w, oid, gh } = mergedFixture(t, branch, "2751-twice");
  gh.setLabels(41, "in-progress");
  const env = gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41" });

  const first = run(w, ["7"], env);
  const second = run(w, ["7"], env);

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(second.json, { pr: 7, branch, deleted: false, alreadyGone: true });
  assert.deepEqual(gh.edits(), [LABEL_EDIT(41)]);
});

test("the standalone label script before or after the host leaves one edit and no error", (t) => {
  for (const order of ["before", "after"]) {
    const branch = `fix/2751-standalone-${order}`;
    const { w, oid, gh } = mergedFixture(t, branch, `2751-standalone-${order}`);
    gh.setLabels(41, "in-progress");
    const env = gh.env({ PR_HEAD: branch, PR_OID: oid, PR_CLOSES: "41" });
    const standalone = () => spawnSync("sh", [LABEL_SCRIPT, "7", "--apply"], { cwd: w, env, encoding: "utf8" });

    if (order === "before") assert.equal(standalone().status, 0);
    const r = run(w, ["7"], env);
    if (order === "after") assert.equal(standalone().status, 0);

    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.tokens, []);
    assert.deepEqual(gh.edits(), [LABEL_EDIT(41)], order);
  }
});

test("a merged PR that closes no issues leaves the host's exit and stdout unchanged", (t) => {
  const branch = "fix/2751-none";
  const { w, oid, gh } = mergedFixture(t, branch, "2751-none");

  const r = run(w, ["7"], gh.env({ PR_HEAD: branch, PR_OID: oid }));

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, JSON.stringify({ pr: 7, branch, deleted: true }) + "\n");
  assert.deepEqual(gh.edits(), []);
});
