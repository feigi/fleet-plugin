// Regression gate for inflight.sh, the probe that decides whether a ticket is
// already being worked on:
// `./agent-test skills/fleet/scripts/inflight.test.mjs`.
//
// The load-bearing cases are the `linked:` rows. `linked` comes from
// `gh issue view --json closedByPullRequestsReferences`, which projects only
// `{id, number, repository, url}` — measured. (The underlying GraphQL nodes are
// PullRequest and do carry `state`; reaching it costs a third round-trip, so the
// script reads state off the `gh pr list` window it already fetches.) A state
// the window cannot supply has to stay a hit rather than silently free a ticket.
//
// `gh` is stubbed on PATH; `git`, `python3` and `jq` are real. The stub pipes
// canned JSON through the real `jq` so the script's own `--jq` expression is
// under test rather than hard-coded into the fixture. Note that this makes the
// suite need one binary the script does not: `gh --jq` is an embedded engine, so
// inflight.sh shells out to no `jq` at all, and a host without it fails this
// suite while the script itself works fine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "inflight.sh");

// The stub shells out to jq. Without it every `gh issue view` would fail and
// the suite would report exit 2 everywhere — which reads as a real red but
// proves nothing. Fail loudly instead of passing vacuously.
try {
  execFileSync("jq", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("jq is required to stub `gh --jq`; install it before running this suite");
}

const GH_STUB = `#!/bin/sh
# Stands in for the two \`gh\` calls inflight.sh makes. Anything else is a bug
# in the test, not a case to absorb quietly.
sub="$1 $2"; shift 2
expr=
while [ $# -gt 0 ]; do
  case "$1" in --jq) expr=$2; shift 2 ;; *) shift ;; esac
done
case "$sub" in
  "issue view")
    if [ -n "\${GH_ISSUE_ERR:-}" ]; then printf '%s\\n' "$GH_ISSUE_ERR" >&2; exit 1; fi
    printf '%s' "$GH_ISSUE_JSON" | jq -r "$expr" ;;
  "pr list")
    printf '%s' "$GH_PR_JSON" ;;
  *)
    echo "stub gh: unexpected invocation: $sub" >&2; exit 127 ;;
esac
`;

const IDENT = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/**
 * A branch in the bare origin, built from an empty tree straight in that repo.
 *
 * Deliberately not `push`ed from the local clone: pushing would leave a local
 * branch of the same name behind, probe 3 would hit it too, and a probe-2 case
 * would pass on probe 3's evidence.
 */
function remoteBranch(bare, name) {
  const g = (args, input) => execFileSync("git", ["-C", bare, ...args],
    { input, encoding: "utf8", env: { ...process.env, ...IDENT } }).trim();
  const commit = g(["commit-tree", g(["hash-object", "-t", "tree", "-w", "--stdin"], ""), "-m", "x"]);
  g(["update-ref", `refs/heads/${name}`, commit]);
}

/**
 * A git repo with `gh` stubbed on PATH.
 *
 * The repo lives in a fixed-name subdirectory, never in the mkdtemp dir itself:
 * probe 3 matches worktrees on basename, and a random mkdtemp suffix that
 * happened to be the ticket number would make every case read as taken.
 *
 * `origin` defaults to a real bare repo because probe 2 now exits 2 when it
 * cannot read one — so a case that means to exercise anything else has to be
 * able to answer probe 2 first. "unreachable" and "none" opt into the two
 * failures that used to be reported as "no remote branch".
 */
function fixture(t, n, { linked = [], prs = [], issueErr = null, origin = "bare", remoteBranches = [],
                         detachedWorktreeUnder = null }) {
  const root = mkdtempSync(join(tmpdir(), "inflight-"));
  t.after(() => execFileSync("rm", ["-rf", root]));

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);

  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);

  if (origin === "bare") {
    const bare = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", bare]);
    for (const b of remoteBranches) remoteBranch(bare, b);
  } else if (origin === "unreachable") {
    execFileSync("git", ["-C", repo, "remote", "add", "origin", join(root, "definitely-not-a-repo")]);
  } // "none": no origin configured at all.

  // Detached on purpose. `worktree add -b` would leave a local branch carrying
  // the same number, and probe 3's branch half would answer for its worktree
  // half — the same "passing for the wrong reason" the bare origin above avoids.
  if (detachedWorktreeUnder !== null) {
    const g = (...args) => execFileSync("git", ["-C", repo, ...args],
      { env: { ...process.env, ...IDENT } });
    g("commit", "-q", "--allow-empty", "-m", "x");
    mkdirSync(join(root, detachedWorktreeUnder), { recursive: true });
    g("worktree", "add", "-q", "--detach", join(root, detachedWorktreeUnder, `fix-${n}-slug`), "HEAD");
  }

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    // A local path can still prompt (a stale credential helper, a host key on
    // an inherited insteadOf rule). An unattended probe that blocks forever is
    // worse than either answer, and a suite that hangs reports nothing at all.
    GIT_TERMINAL_PROMPT: "0",
    // The developer's own git config must not reach these cases, the way
    // release-ticket.test.mjs:30 already shuts it out. Probe 2 only became a
    // hard dependency of this file with the fail-closed guard — before it, a
    // broken origin was swallowed and no config could reach it. Now
    // `protocol.file.allow=never` (documented hardening after CVE-2022-39253)
    // reddens most of the file, and a global `[remote "origin"] url` is worse
    // than red: `remote.<name>.url` is multi-valued, the global entry wins, and
    // "no matching branch" passes while pointed at somebody else's repository.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GH_ISSUE_JSON: JSON.stringify({
      url: `https://github.com/${REPO}/issues/${n}`,
      closedByPullRequestsReferences: linked.map((l) =>
        typeof l === "number"
          ? { number: l, url: prUrl(l) }
          : { number: l.number, url: prUrl(l.number, l.repo) }),
    }),
    GH_PR_JSON: JSON.stringify(prs),
  };
  // Inherited git vars outrank `cwd`, so an ambient GIT_DIR silently retargets
  // probe 3 at whatever repo it names — and if that directory is named for the
  // ticket, the reds are shape-identical to the real bug. GH_ISSUE_ERR leaks the
  // same way. Plausible here: a git hook, `rebase --exec`, `bisect run`.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GH_ISSUE_ERR;
  if (issueErr) env.GH_ISSUE_ERR = issueErr;
  return { repo, env };
}

function inflight(n, opts, t) {
  const { repo, env } = fixture(t, n, opts);
  const r = spawnSync("sh", [SCRIPT, String(n)], { cwd: repo, env, encoding: "utf8" });
  return {
    code: r.status,
    stderr: r.stderr,
    json: r.stdout.trim() ? JSON.parse(r.stdout) : null,
  };
}

const REPO = "feigi/claude-config";
const prUrl = (number, repo = REPO) => `https://github.com/${repo}/pull/${number}`;
const pr = (number, state, headRefName, repo = REPO) =>
  ({ number, state, headRefName, url: prUrl(number, repo) });

// --- linked: every state this script can end up attributing to an entry.
// GitHub's PullRequestState has three (OPEN, CLOSED, MERGED); "?" is this
// script's own marker for a state the search window could not supply.

// The reported bug, in the shape it was measured in: issue #8 is closed by
// MERGED #20, and read as taken=true forever.
test("linked: a MERGED PR is finished work, not in-flight", (t) => {
  const r = inflight(8, { linked: [20], prs: [pr(20, "MERGED", "fix/other-thing")] }, t);
  assert.equal(r.code, 0);
  assert.equal(r.json.taken, false);
  assert.equal(r.json.evidence.pr, "");
});

test("linked: a CLOSED, unmerged PR is abandoned work, not in-flight", (t) => {
  const r = inflight(8, { linked: [20], prs: [pr(20, "CLOSED", "fix/other-thing")] }, t);
  assert.equal(r.code, 0);
  assert.equal(r.json.taken, false);
  assert.equal(r.json.evidence.pr, "");
});

test("linked: an OPEN PR is in-flight, and the evidence names its state", (t) => {
  const r = inflight(7, { linked: [12], prs: [pr(12, "OPEN", "fix/other-thing")] }, t);
  assert.equal(r.code, 1);
  assert.equal(r.json.taken, true);
  assert.equal(r.json.evidence.pr, "#12 OPEN (linked)");
});

// A PR linked through the Development sidebar carries no `#N` text, so the
// full-text window can miss it — as can a repo with more than 100 matches.
// Unknown must stay a hit: a false "taken" costs a skipped ticket, a false
// "free" costs two agents on one ticket.
test("linked: a PR outside the search window stays a hit, with the state marked unknown", (t) => {
  const r = inflight(7, { linked: [12], prs: [] }, t);
  assert.equal(r.code, 1);
  assert.equal(r.json.taken, true);
  assert.equal(r.json.evidence.pr, "#12 ? (linked)");
});

// A present-but-null state is as unknown as an absent one. `.get(url, "?")`
// would return None here and print it, contradicting the promise of "?".
test("linked: a null state reads as unknown, not as the literal None", (t) => {
  const r = inflight(8, { linked: [20], prs: [pr(20, null, "unrelated")] }, t);
  assert.equal(r.code, 1);
  assert.equal(r.json.evidence.pr, "#20 ? (linked)");
});

// More than one closing reference is ordinary — two PRs, one ticket — and every
// other case here passes 0 or 1, so this is the only one that iterates. It does
// not pin the `join(",")`/`split(",")` contract: a wrong separator collapses the
// list to a single element and yields the same exit 0 this asserts. The rows
// above cover that, because the issue's own URL is field 0 and losing it takes
// every linked row with it.
test("linked: two MERGED PRs are both finished, not in-flight", (t) => {
  const r = inflight(7, { linked: [12, 13], prs: [pr(12, "MERGED", "a"), pr(13, "MERGED", "b")] }, t);
  assert.equal(r.code, 0);
  assert.equal(r.json.evidence.pr, "");
});

// `Closes owner/repo#N` from a fork is legal, which is why the node carries
// `repository`. Its number is meaningless here: keyed by number it would inherit
// the state of the unrelated local #5 and be filtered out, freeing a taken
// ticket. Keyed by URL it cannot collide, so it stays an unknown-state hit.
test("linked: a PR in another repo does not inherit a local PR's state", (t) => {
  const r = inflight(77, {
    linked: [{ number: 5, repo: "other/fork" }],
    prs: [pr(5, "MERGED", "unrelated")],
  }, t);
  assert.equal(r.code, 1);
  assert.equal(r.json.taken, true);
  assert.equal(r.json.evidence.pr, "other/fork#5 ? (linked)");
});

// --- both signals, and the branch half that already worked.

test("both probes hitting the same PR still report both, each with its state", (t) => {
  const r = inflight(33, { linked: [40], prs: [pr(40, "OPEN", "fix/33-probe")] }, t);
  assert.equal(r.code, 1);
  assert.equal(r.json.evidence.pr, "#40 OPEN (linked), #40 OPEN (branch)");
});

test("branch: a MERGED branch-matched PR is still filtered out", (t) => {
  const r = inflight(33, { linked: [], prs: [pr(40, "MERGED", "fix/33-probe")] }, t);
  assert.equal(r.code, 0);
  assert.equal(r.json.taken, false);
});

test("branch: an OPEN branch-matched PR is still a hit", (t) => {
  const r = inflight(33, { linked: [], prs: [pr(40, "OPEN", "fix/33-probe")] }, t);
  assert.equal(r.code, 1);
  assert.equal(r.json.evidence.pr, "#40 OPEN (branch)");
});

// The count is the unfiltered size of the search window, not the hit count —
// it is what tells a reader the search was noisy rather than the ticket busy.
test("the considered-count reports every full-text match, filtered or not", (t) => {
  const r = inflight(8, { linked: [], prs: [pr(1, "MERGED", "a"), pr(2, "OPEN", "b"), pr(3, "CLOSED", "c")] }, t);
  assert.match(r.stderr, /\(3 full-text match\(es\) were all incidental\)/);
});

// --- probe 2, the remote-branch lookup.
//
// `git ls-remote` used to run inside the filtering pipeline, and a pipeline
// reports its LAST command's status — `paste`, which always succeeds. So the
// lookup's exit 128 never reached the script at all, and `2>/dev/null` dropped
// the reason with it. What arrived was zero matching lines, which is exactly
// what a clean ticket produces. Dropping the trailing `|| true` alone would not
// have changed that: `|| true` was never the thing swallowing it.
//
// The two directions are separate answers and both are pinned below: `grep`
// exiting 1 is "looked, found nothing" and must stay a free ticket; a failed
// `ls-remote` is "could not look" and must reach exit 2. A fix that collapses
// them the other way makes every clean ticket unanswerable.

test("probe 2: an unreachable origin is an unknown answer, never a 'no remote branch'", (t) => {
  // The direction that matters: a wrong "taken" costs one skipped ticket, a
  // wrong "free" puts two agents on the same one.
  const r = inflight(8, { origin: "unreachable" }, t);
  assert.equal(r.code, 2, "unanswerable is exit 2, not the exit 0 that means free");
  assert.match(r.stderr, /whether #8 has a remote branch is unknown/);
  assert.doesNotMatch(r.stderr, /no remote branch/);
  assert.equal(r.json, null, "an unanswered probe emits no verdict to parse");
});

// Not a synthetic non-zero exit: this is the plain "no origin configured" a
// fresh clone-less checkout has, and it took the same silent path.
test("probe 2: an origin that is not configured at all is unknown, not free", (t) => {
  const r = inflight(8, { origin: "none" }, t);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /whether #8 has a remote branch is unknown/);
  assert.equal(r.json, null);
});

// The opposite direction. This one passed before the fix too, which is the
// point — it fails only if the fix over-reaches and turns `grep`'s no-match
// exit 1 into a death, making every clean ticket unanswerable.
test("probe 2: a reachable origin with no matching branch still reports free", (t) => {
  const r = inflight(8, { remoteBranches: ["main", "fix/other-thing"] }, t);
  assert.equal(r.code, 0);
  assert.equal(r.json.taken, false);
  assert.equal(r.json.evidence.remote, "");
  assert.match(r.stderr, /no remote branch for #8/);
});

test("probe 2: a reachable origin with a matching branch still reports taken", (t) => {
  const r = inflight(33, { remoteBranches: ["main", "fix/33-probe"] }, t);
  assert.equal(r.code, 1);
  assert.equal(r.json.taken, true);
  assert.equal(r.json.evidence.remote, "fix/33-probe");
  assert.deepEqual(r.json.hits, ["remote-branch"], "probe 2 alone, not probe 3 answering for it");
});

// --- probe 3, the worktree lookup.
//
// `worktree list --porcelain` prints the path raw, so reading it as awk's $2
// truncates at the first space and the ticket stops matching — a wrong "free",
// the same answer probe 2 was just stopped from inventing. The pair below is
// one fixture differing in one character, so a red names the space and nothing
// else. release-ticket.sh:70 already reads this field as substr($0,10).

test("probe 3: a worktree under a path with a space is still found", (t) => {
  const r = inflight(77, { detachedWorktreeUnder: "some dir" }, t);
  assert.equal(r.code, 1, "a worktree that exists must never read as free");
  assert.equal(r.json.taken, true);
  assert.match(r.json.evidence.worktree, /some dir\/fix-77-slug$/);
  assert.deepEqual(r.json.hits, ["local"]);
});

test("probe 3: the same worktree without a space in the path, as the control", (t) => {
  const r = inflight(77, { detachedWorktreeUnder: "nospace" }, t);
  assert.equal(r.code, 1);
  assert.match(r.json.evidence.worktree, /nospace\/fix-77-slug$/);
});

// --- the evidence payload as JSON.
//
// Every probe copies a name somebody else chose straight into a JSON string
// position, so the characters those names may legally carry decide whether the
// payload parses. The three cases below are the three reachable vectors, one
// per wrapped field that a name can reach: a local branch, a worktree path and
// a remote branch. They are not one case written three times — git's ref rules
// reject `\` but allow `"`, while a worktree path is a filename and allows
// both, and the three arrive through different probes into different fields,
// so dropping the escape from any one of them is caught by exactly one.
// (`evidence.pr` is the fourth wrapped field and has no case, because it is
// built only from a URL-derived owner/repo, a PR number and a state — none of
// which can carry a quote.) None of them changes the verdict — the exit code
// and `taken` are already right, and next-ticket/SKILL.md and run-team/SKILL.md
// both read the EXIT CODE as the decision — so a red here is a consumer that
// cannot read the evidence, not a ticket claimed twice.
//
// The first two are built by hand rather than through `fixture`'s options, the
// way release-ticket.test.mjs:628 builds its own: the names are the fixture.

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args],
  { encoding: "utf8", env: { ...process.env, ...IDENT } });

test("a quote in a local branch cannot produce a payload the caller fails to parse", (t) => {
  // Measured on the pre-fix script: exit 1 with stdout breaking at char 100,
  // `"localBranch":"fix-42-say"hi"`.
  const { repo, env } = fixture(t, 42, {});
  git(repo, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, "branch", 'fix-42-say"hi');

  const r = spawnSync("sh", [SCRIPT, "42"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  assert.equal(json.evidence.localBranch, 'fix-42-say"hi', "and it round-trips, rather than being stripped");
  assert.equal(r.status, 1, "the verdict is unchanged — this was only ever the evidence");
  assert.equal(json.taken, true);
});

test("a quote and a backslash in a worktree path cannot produce an unparseable payload", (t) => {
  // A path is not a ref: `\` is illegal in a branch name but fine in a
  // filename, and it is the character the escape has to double rather than
  // pass through. Detached for the reason `fixture` is — a branch carrying the
  // same number would let probe 3's branch half answer for its worktree half.
  const { repo, env } = fixture(t, 77, {});
  const name = 'fix-77-sa"y\\b';
  git(repo, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, "worktree", "add", "-q", "--detach", join(repo, ".worktrees", name), "HEAD");

  const r = spawnSync("sh", [SCRIPT, "77"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  // The tail, not the whole path: git reports a worktree by its resolved path,
  // and on macOS the temp dir arrives back as /private/var for a /var fixture —
  // which is why the probe-3 pair above anchors on the suffix too.
  assert.ok(json.evidence.worktree.endsWith(join(".worktrees", name)),
    `both characters must survive intact, got ${json.evidence.worktree}`);
  assert.equal(r.status, 1);
  assert.deepEqual(json.hits, ["local"]);
});

test("a control character in a worktree path cannot produce an unparseable payload", (t) => {
  // What pins the `tr` stage; without it the two cases above stay green and a
  // raw C0 byte reaches the payload, which JSON forbids unescaped. Mirrors
  // release-ticket.test.mjs:642.
  //
  // \001 specifically, not \t or \n: those two are eaten upstream by probe 3's
  // own `awk -F'\t'` and `read -r` before `jstr` ever sees them (#122), so they
  // would pin nothing here. \001 is neither, so it survives to the payload.
  //
  // Neutralised to a space rather than escaped — the byte does not round-trip,
  // and the assertion says so rather than pretending otherwise.
  const { repo, env } = fixture(t, 99, {});
  const name = "fix-99-c\u0001x";
  git(repo, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, "worktree", "add", "-q", "--detach", join(repo, ".worktrees", name), "HEAD");

  const r = spawnSync("sh", [SCRIPT, "99"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  assert.ok(json.evidence.worktree.endsWith(join(".worktrees", "fix-99-c x")),
    `the C0 byte must be neutralised, not passed through, got ${json.evidence.worktree}`);
  assert.equal(r.status, 1);
  assert.deepEqual(json.hits, ["local"]);
});

test("a quote in a remote branch cannot produce an unparseable payload", (t) => {
  // The third reachable vector, and the one the two cases above cannot reach:
  // the name is a ref like the local-branch case, but it arrives through probe
  // 2 and lands in a different field. Without this, dropping `jstr` from
  // `$remote` alone leaves the whole suite green — measured. This one goes
  // through `fixture`'s own `remoteBranches`, since a bare origin is exactly
  // what it builds and probe 2 has no path a hand-built name would exercise.
  const { repo, env } = fixture(t, 55, { remoteBranches: ['fix-55-re"mote'] });

  const r = spawnSync("sh", [SCRIPT, "55"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  assert.equal(json.evidence.remote, 'fix-55-re"mote', "and it round-trips, rather than being stripped");
  assert.equal(r.status, 1, "the verdict is unchanged — this was only ever the evidence");
  assert.deepEqual(json.hits, ["remote-branch"]);
});

// --- error paths. These do not reach the jq expression at all: the stub exits on
// GH_ISSUE_ERR before piping through it. What they pin is the `if ! linked=$(...)`
// classifier, which this change edits to stop reporting repository-level failures
// as a missing issue.

test("a nonexistent issue dies 2, distinctly from a network failure", (t) => {
  const err = "GraphQL: Could not resolve to an issue or pull request with the number of 999.";
  const r = inflight(999, { issueErr: err }, t);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /issue #999 does not exist in this repository/);
});

test("an unreachable GitHub dies 2 without claiming the issue is missing", (t) => {
  const r = inflight(8, { issueErr: "dial tcp: lookup api.github.com: no such host" }, t);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /PR links are unknown/);
  assert.doesNotMatch(r.stderr, /does not exist/);
});

// A renamed or deleted repo, revoked access and a token that lost `repo` scope
// all open with "Could not resolve", so matching that alone sends the reader
// after a missing ticket that is really a missing repository.
test("a repository-level failure is not reported as a missing issue", (t) => {
  const err = "GraphQL: Could not resolve to a Repository with the name 'feigi/claude-config'.";
  const r = inflight(8, { issueErr: err }, t);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /PR links are unknown/);
  assert.doesNotMatch(r.stderr, /does not exist/);
});
