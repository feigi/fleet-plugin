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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

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

// Resolved once, and resolved through a shell so it is the same awk the script
// would have found. The `awkFailWhenProgramHas` shim shadows `awk` on PATH and
// hands off to the real one for every invocation it is not breaking; calling
// `awk` from inside the shim would find the shim.
const REAL_AWK = execFileSync("/bin/sh", ["-c", "command -v awk"], { encoding: "utf8" }).trim();
const REAL_TR = execFileSync("/bin/sh", ["-c", "command -v tr"], { encoding: "utf8" }).trim();

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
                         detachedWorktreeUnder = null, awkFailWhenProgramHas = null,
                         trFailWhenArgsHave = null }) {
  const root = mkdtempSync(join(tmpdir(), "inflight-"));
  t.after(() => execFileSync("rm", ["-rf", root]));

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB);
  chmodSync(join(bin, "gh"), 0o755);

  // A filter that could not run at all. Written only when a case asks for it,
  // so every other case forks the real awk directly.
  //
  // Selected by a substring of the awk program, never by counting invocations:
  // a count cannot address one filter. The worktree filter used to be two awks
  // in one pipeline, and a pipeline starts its stages concurrently, so both
  // read the same counter before either wrote it — measured, they were both
  // "the second awk" and no invocation was ever the third. A case built on that
  // count broke nothing and passed the script a clean bill of health.
  //
  // Exits 1, deliberately, rather than some louder status: 1 is precisely what
  // the removed `grep … | paste -sd, - || true` shape existed to swallow. A lone
  // awk never returns 1 for "matched nothing" — these programs contain no
  // `exit`, so they return 0 whether or not anything matched, which is what
  // makes any non-zero status readable as a failure.
  if (awkFailWhenProgramHas !== null) {
    writeFileSync(join(bin, "awk"), `#!/bin/sh
case "$*" in *'${awkFailWhenProgramHas}'*) exit 1 ;; esac
exec '${REAL_AWK}' "$@"
`);
    chmodSync(join(bin, "awk"), 0o755);
  }

  // The same shim shape for `tr`, selected by flag rather than by program text.
  // `-d` addresses jrewritten and nothing else: the two other `tr` calls in the
  // script are `tr '\n' ' '` inside die messages, and jstr's own is a
  // translation with no flags at all.
  if (trFailWhenArgsHave !== null) {
    writeFileSync(join(bin, "tr"), `#!/bin/sh
case "$*" in *'${trFailWhenArgsHave}'*) exit 1 ;; esac
exec '${REAL_TR}' "$@"
`);
    chmodSync(join(bin, "tr"), 0o755);
  }

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
  return { repo, env, bin };
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
// else. release-ticket.sh:78 already reads this field as substr($0,10).

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
// and `taken` are already right — next-ticket/SKILL.md reads the exit code as
// the decision, and run-team/SKILL.md states "any hit = taken", which is the
// same call by way of the hits rather than the code. So a red here is a
// consumer that cannot read the evidence, not a ticket claimed twice.
//
// The first two are built by hand rather than through `fixture`'s options, the
// way release-ticket.test.mjs:729 builds its own: the names are the fixture.

// Takes the fixture's `env`, not `process.env`: that is the copy with GIT_DIR
// and GIT_WORK_TREE deleted. Inherited, they outrank `-C`, so a suite run from
// inside a git hook would create these deliberately hostile names in whatever
// repo they name — and `git worktree prune` does not reclaim a stray branch.
const git = (repo, env, ...args) => execFileSync("git", ["-C", repo, ...args],
  { encoding: "utf8", env: { ...env, ...IDENT } });

test("a quote in a local branch cannot produce a payload the caller fails to parse", (t) => {
  // Measured on the pre-fix script: exit 1 with stdout breaking at char 100,
  // `"localBranch":"fix-42-say"hi"`.
  const { repo, env } = fixture(t, 42, {});
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "branch", 'fix-42-say"hi');

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
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "worktree", "add", "-q", "--detach", join(repo, ".worktrees", name), "HEAD");

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
  // release-ticket.test.mjs:743.
  //
  // \001 specifically, not \n: awk's record separator ends the line, so a
  // newline cannot reach `jstr` and would pin nothing here — it is lost one
  // stage earlier, splitting the record, which is #185 and still open. \t once
  // could not either, but that was the `-F'\t'` split and the `read -r` loop
  // eating it, and both are gone — measured, a worktree named `fix-88-a<TAB>b`
  // used to arrive as the bare string `b`, its path cut at the tab it was
  // joined on, and now arrives whole with the tab neutralised like any other
  // C0 byte. \001 is the case that held before that change and after it.
  //
  // Neutralised to a space rather than escaped — the byte does not round-trip,
  // and the assertion says so rather than pretending otherwise.
  const { repo, env } = fixture(t, 99, {});
  const name = "fix-99-c\u0001x";
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "worktree", "add", "-q", "--detach", join(repo, ".worktrees", name), "HEAD");

  const r = spawnSync("sh", [SCRIPT, "99"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  assert.ok(json.evidence.worktree.endsWith(join(".worktrees", "fix-99-c x")),
    `the C0 byte must be neutralised, not passed through, got ${json.evidence.worktree}`);
  assert.equal(r.status, 1);
  assert.deepEqual(json.hits, ["local"]);
});

test("a BS, a tab, a FF, a CR and a DEL in a worktree path round-trip rather than being scrubbed", (t) => {
  // Same vector as the \001 case above, but the bytes #146 gives a different
  // treatment to: BS, tab, FF and CR have JSON short forms (RFC 8259 \b \t \f
  // \r) and DEL (\177) is not a C0 byte at all, so — unlike \001 — none of the
  // five may reach the space-scrub, and the field must not be marked rewritten.
  // BS and FF are the two the first version of this fix scrubbed anyway, under
  // a comment claiming they had no short form.
  const { repo, env } = fixture(t, 88, {});
  const name = "fix-88-a\tb\rc\x7fd\be\ff";
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "worktree", "add", "-q", "--detach", join(repo, ".worktrees", name), "HEAD");

  const r = spawnSync("sh", [SCRIPT, "88"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  assert.ok(json.evidence.worktree.endsWith(join(".worktrees", name)),
    `BS, tab, FF, CR and DEL must all survive intact, got ${json.evidence.worktree}`);
  assert.equal(json.evidence.worktreeRewritten, false, "escaped or preserved, not replaced");
  assert.equal(r.status, 1);
  assert.deepEqual(json.hits, ["local"]);
});

test("a byte with no JSON short form in a worktree path is replaced and flagged rewritten", (t) => {
  // The \001 case above already pins the neutralising itself; this pins the
  // other half of #146 — that the payload discloses it, so a consumer reading
  // `evidence.worktree` back cannot mistake the neutralised string for the real
  // name on disk.
  // \013 (VT) rides along: it is the C0 byte that looks like it has a short
  // form and does not — RFC 8259 lists no \v — so narrowing the scrub set to
  // make room for \b and \f must not take VT out with them.
  const { repo, env } = fixture(t, 66, {});
  const name = "fix-66-c\x02x\x0by";
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "worktree", "add", "-q", "--detach", join(repo, ".worktrees", name), "HEAD");

  const r = spawnSync("sh", [SCRIPT, "66"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  assert.ok(json.evidence.worktree.endsWith(join(".worktrees", name.replace("\x02", " ").replace("\x0b", " "))),
    `no short form for \\002 or \\013 — both still neutralised to a space, got ${json.evidence.worktree}`);
  assert.equal(json.evidence.worktreeRewritten, true, "and the payload must disclose that it was");
  assert.equal(r.status, 1);
  assert.deepEqual(json.hits, ["local"]);
});

test("an escape that cannot run aborts rather than printing a receipt with an empty slot", (t) => {
  // `$(jrewritten …)` used to sit directly in printf's ARGUMENT list, where the
  // `|| die` on the printf structurally cannot reach it: a command substitution
  // that fails contributes an EMPTY argument and printf still exits 0, so an
  // UNQUOTED `%s` slot emits `"prRewritten":,` — malformed JSON on the happy
  // exit path, which is the one failure mode this receipt exists to rule out.
  // The `%s` slots inside quotes fail more quietly still, as a `""` that reads
  // as a real empty value. Assigning first is what lets a status be read at
  // all. Failing `tr -d` is the narrowest way in: it is jrewritten's own flag
  // and no other call in the script passes it.
  const { repo, env } = fixture(t, 55, { trFailWhenArgsHave: "-d" });

  const r = spawnSync("sh", [SCRIPT, "55"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 2, `unanswerable, never a verdict; stderr: ${r.stderr}`);
  assert.equal(r.stdout, "", "and no payload at all — half a receipt is worse than none");
  assert.match(r.stderr, /could not escape the evidence/);
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

// --- a filter stage that could not run at all.
//
// The lookups are guarded; the filtering of what they returned was not. Each
// filter was a pipeline ending in `paste -sd, - || true`, and a pipeline
// reports only its LAST command's status — which the `|| true` then discarded
// too. So a stage that could not run produced an empty result, and an empty
// result is exactly what a genuinely free ticket produces. The realistic
// trigger is not a shimmed binary but a fork failure under process-table
// pressure, which a parallel fleet approaches by construction — the argument
// the script already makes for the `|| die` on its PR-counting call.
//
// Each case names its filter by a substring the filter's own awk program must
// contain to do its job — the prefix the remote filter strips, the whole-line
// match a short refname needs, the raw-path read the worktree filter takes. A
// key that stops matching stops breaking anything, and the case reddens on the
// exit code; it cannot pass green over an untouched filter. Nothing else can
// emit the message each case asserts, so exit 2 plus that message is what
// proves the intended filter is the one that failed.
//
// Each case keeps a real hit present, so "exit 2" is a fact about the filter
// and not about there being nothing to find. The pre-fix numbers below were
// measured per filter by breaking the stage that filter actually had, since no
// filter then had an awk a substring could address on its own: the branch
// filter had none, the worktree filter had two in one pipeline, and the remote
// filter's lone `{print $2}` is also the worktree filter's second awk. So `sed`
// for the remote filter, `grep` for the branch filter, `basename` for the
// worktree one. Each was checked against the same fixture with that stage
// intact, which answers taken, exit 1.

test("probe 2: a remote-branch filter that could not run is unknown, never free", (t) => {
  // Measured pre-fix with its `sed` broken: "no remote branch for #42",
  // taken=false, exit 0 — the wrong "free", with the branch on the remote.
  const r = inflight(42, {
    remoteBranches: ["main", "fix/42-thing"], awkFailWhenProgramHas: "refs/heads/",
  }, t);
  assert.equal(r.code, 2, "unanswerable is exit 2, not the exit 0 that means free");
  assert.match(r.stderr, /could not filter the remote branches for #42/);
  assert.doesNotMatch(r.stderr, /no remote branch/, "a stage that could not run never reports 'no'");
  assert.equal(r.json, null, "an unanswered probe emits no verdict to parse");
});

test("probe 3: a local-branch filter that could not run is unknown, never free", (t) => {
  // Built by hand rather than through a `fixture` option: probe 3 reads the
  // repo it is run in, so the branch in that repo is the fixture.
  const { repo, env } = fixture(t, 42, { awkFailWhenProgramHas: "$0 ~" });
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "branch", "fix/42-thing");

  // Measured pre-fix with its `grep` broken: "no local branch or worktree",
  // taken=false, exit 0 — the wrong "free", with the branch checked out.
  const r = spawnSync("sh", [SCRIPT, "42"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 2, "unanswerable is exit 2, not the exit 0 that means free");
  assert.match(r.stderr, /could not filter the local branches for #42/);
  assert.doesNotMatch(r.stderr, /no local branch or worktree/,
    "a stage that could not run never reports 'no'");
  assert.equal(r.stdout.trim(), "", "an unanswered probe emits no verdict to parse");
});

test("probe 3: a worktree filter that could not run is unknown, never free", (t) => {
  // Detached for the reason `fixture` is: a branch carrying the same number
  // would let probe 3's branch half answer for its worktree half, and this
  // case is about the worktree half alone.
  const { repo, env } = fixture(t, 77, { awkFailWhenProgramHas: "substr($0,10)" });
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "worktree", "add", "-q", "--detach", join(repo, ".worktrees", "fix-77-slug"), "HEAD");

  // Measured pre-fix with its per-line `basename` broken — the same defect one
  // level down, and the one that needs no shimmed binary to reach: "no local
  // branch or worktree for #77", taken=false, exit 0, worktree checked out.
  const r = spawnSync("sh", [SCRIPT, "77"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 2, "unanswerable is exit 2, not the exit 0 that means free");
  assert.match(r.stderr, /could not filter the worktree list for #77/);
  assert.doesNotMatch(r.stderr, /no local branch or worktree/,
    "a stage that could not run never reports 'no'");
  assert.equal(r.stdout.trim(), "", "an unanswered probe emits no verdict to parse");
});

// --- the substring guard, across all three filters at once.
//
// Green before the rewrite as well as after: it exists to stay green through
// it. The matching is a path-segment regex, not a substring search, and a
// rewrite that reaches for `index`, a bare `~ n`, or a dropped anchor turns
// every ticket whose digits appear inside a longer number into a false hit —
// which reads as taken and silently drops real work on the floor.
//
// Both anchors, because they guard opposite collisions and one fixture cannot
// catch the other's loss: 341 is a SUFFIX collision, held off by the leading
// `(^|[/-])`, and 410 is a PREFIX collision, held off by the trailing
// `([-/]|$)`. Measured — with only 341 here, dropping the trailing anchor left
// the whole suite green while 41 read as taken off 410 on all three probes.
// Neither number is hypothetical in this repo: 17 vs 174, 13 vs 132, 4 vs 48.
test("41 is not claimed by a remote branch, a local branch or a worktree named for 341 or 410", (t) => {
  const { repo, env } = fixture(t, 41, {
    remoteBranches: ["main", "fix/341-thing", "fix/410-thing"],
  });
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  for (const other of ["341", "410"]) {
    git(repo, env, "branch", `fix/${other}-thing`);
    git(repo, env, "worktree", "add", "-q", "--detach",
      join(repo, ".worktrees", `fix-${other}-slug`), "HEAD");
  }

  const r = spawnSync("sh", [SCRIPT, "41"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  assert.equal(r.status, 0);
  assert.equal(json.taken, false);
  assert.equal(json.evidence.remote, "", "341 or 410 on the remote is not 41");
  assert.equal(json.evidence.localBranch, "", "341 or 410 on a local branch is not 41");
  assert.equal(json.evidence.worktree, "", "341 or 410 in a worktree name is not 41");
});

// --- a ref byte that is not valid UTF-8.
//
// Refs and paths are byte strings; nothing guarantees they decode as UTF-8. A
// BWK awk in a UTF-8 locale aborts on a record it cannot convert to wide
// characters — even a record it is only scanning past — so one such ref
// anywhere on the remote takes EVERY ticket to exit 2, permanently, until
// somebody deletes it. The collapse to a lone awk is what introduced that:
// `grep` matched bytes and was unbothered. `LC_ALL=C` restores byte matching,
// which is what a ref and a path are, and the regex is pure ASCII so nothing
// is lost. Without it this case reports "could not filter the remote branches"
// for a ticket that is plainly free.
//
// Written straight into `packed-refs`, a plain text file: no such filename is
// ever created, so the filesystem never has to accept one, and the bytes still
// reach probe 2 through `git ls-remote`.
test("a ref that is not valid UTF-8 leaves an answerable ticket answerable", (t) => {
  const { repo, env } = fixture(t, 41, { remoteBranches: ["main"] });
  const bare = join(repo, "..", "remote.git");
  const main = execFileSync("git", ["-C", bare, "rev-parse", "refs/heads/main"],
    { encoding: "utf8" }).trim();
  appendFileSync(join(bare, "packed-refs"), Buffer.concat([
    Buffer.from(`${main} refs/heads/feat/caf`), Buffer.from([0xff]), Buffer.from("-nine\n")]));

  const r = spawnSync("sh", [SCRIPT, "41"],
    { cwd: repo, env: { ...env, LC_ALL: "en_US.UTF-8" }, encoding: "utf8" });
  assert.equal(r.status, 0, `a free ticket stays free, got: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).taken, false);
});

// --- #92: probe 2 must never prompt and must not block indefinitely.
//
// Prompt suppression alone does not bound a hang: measured in the issue, a
// stalled ssh transport blocks identically with and without
// GIT_TERMINAL_PROMPT=0 (killed at 8s, rc 142 either way). So the case that
// actually exercises the fix is a listener that accepts the TCP connection
// and then says nothing back — the ssh banner exchange never completes.
//
// A real listener, not a shimmed binary: the fix bounds the CONNECTION, and
// only a genuine stall proves that. It carries its own spawnSync timeout as a
// backstop so a regression here reddens loudly instead of hanging the suite.
test("probe 2: a transport that connects and then never answers still terminates, exit 2", async (t) => {
  const server = createServer(); // accept, hold open, send nothing back
  t.after(() => new Promise((res) => server.close(res)));
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;

  const { repo, env } = fixture(t, 8, { origin: "none" });
  git(repo, env, "remote", "add", "origin", `ssh://git@127.0.0.1:${port}/x/y.git`);

  const started = Date.now();
  // 45s: comfortably above the ~10s ConnectTimeout the fix sets (measured
  // locally: "Connection timed out during banner exchange" at ~10.0s against
  // this exact fixture), but far short of leaving the suite to hang on a
  // regression that drops the bound entirely.
  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8", timeout: 45_000 });

  assert.notEqual(r.signal, "SIGTERM",
    `spawnSync's own 45s backstop fired — the script's bound is gone: ${JSON.stringify(r)}`);
  assert.equal(r.status, 2, "unanswerable is exit 2, not the exit 0 that means free");
  assert.match(r.stderr, /whether #8 has a remote branch is unknown/);
  assert.ok(Date.now() - started < 45_000, "must terminate on its own bound, not the test's backstop");
});

// The stub the next three tests share: it logs its own argv and exits, so the
// cases are deterministic and touch no network at all — what git actually
// invokes is the assertion.
// Named `ssh` and dropped into the fixture's `bin` when the tier under test is
// one where the script picks the program itself — `bin` is first on PATH.
const sshStub = (dir, name = "user-ssh-stub.sh") => {
  const log = join(dir, `${name}.log`);
  const stub = join(dir, name);
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`);
  chmodSync(stub, 0o755);
  return { stub, log };
};

// Whole words, never a substring. `"ServerAliveCountMax=25".includes("ServerAliveCountMax=2")`
// is true, so the `.includes` form this replaced passed a bound weakened 12.5x
// — measured, with the whole file still green, the live-hang test included
// (that one terminates on ConnectTimeout, so it never sees the ServerAlive
// pair either). Splitting on whitespace is exactly right for the stub's
// `printf '%s\n' "$*"`, which is argv joined by single spaces.
const assertBoundOptions = (log) => {
  const words = readFileSync(log, "utf8").split(/\s+/);
  for (const opt of ["BatchMode=yes", "ConnectTimeout=10", "ServerAliveInterval=5", "ServerAliveCountMax=2"]) {
    assert.ok(words.includes(opt),
      `bound option missing from the invoked command: ${opt} — invoked as: ${words.join(" ")}`);
  }
  return words;
};

// The other half: a user's own configured ssh command is honoured, not
// replaced. Three tests, one per tier of the fallback, because git's own
// precedence is GIT_SSH_COMMAND > core.sshCommand > GIT_SSH and each tier is
// reached only when the ones above it are unset — so one test can only ever
// exercise one of them.
//
// `GIT_SSH_COMMAND` here stands in for a command a user already set (a custom
// identity file, a proxy).
test("probe 2: an existing GIT_SSH_COMMAND is honoured, with the bound options added on top", (t) => {
  const { repo, env } = fixture(t, 8, { origin: "none" });
  git(repo, env, "remote", "add", "origin", "ssh://git@example.invalid/x/y.git");

  const { stub, log } = sshStub(repo);

  // A marker option stands in for whatever the user's own command carries —
  // its presence in the log proves the script appended rather than replaced.
  const r = spawnSync("sh", [SCRIPT, "8"],
    { cwd: repo, env: { ...env, GIT_SSH_COMMAND: `${stub} -o UserMarker=1` }, encoding: "utf8" });
  assert.equal(r.status, 2, "the stub always fails, so this is 'could not look', never free");

  const words = assertBoundOptions(log);
  assert.ok(words.includes("UserMarker=1"), "the user's own configured command must survive, not be replaced");
});

// The middle tier of the same fallback. Unlike GIT_SSH_COMMAND it is a git
// config read, so a wrong key or a wrong scope would break it without breaking
// the test above — and would ship silently, since setting GIT_SSH_COMMAND in
// that test short-circuits `${GIT_SSH_COMMAND:-…}` before this tier is ever
// consulted. Measured: deleting the `git config --get core.sshCommand` line
// outright left the whole file green before this test existed.
test("probe 2: a core.sshCommand is honoured, with the bound options added on top", (t) => {
  const { repo, env } = fixture(t, 8, { origin: "none" });
  git(repo, env, "remote", "add", "origin", "ssh://git@example.invalid/x/y.git");

  const { stub, log } = sshStub(repo);
  git(repo, env, "config", "core.sshCommand", `${stub} -o UserMarker=1`);

  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 2, "the stub always fails, so this is 'could not look', never free");

  const words = assertBoundOptions(log);
  assert.ok(words.includes("UserMarker=1"), "the configured command must survive, not be replaced");
});

// The last tier, and the one this probe regressed: git's precedence is
// GIT_SSH_COMMAND > core.sshCommand > GIT_SSH, so setting GIT_SSH_COMMAND
// unconditionally dropped a user's GIT_SSH wrapper — measured against the
// pre-fix shape, the stub was invoked twice; with GIT_SSH_COMMAND set, never.
// GIT_SSH names a program rather than a command line, so it carries no marker
// option of its own: being invoked at all is the assertion.
test("probe 2: a legacy GIT_SSH wrapper is honoured, with the bound options added on top", (t) => {
  const { repo, env } = fixture(t, 8, { origin: "none" });
  git(repo, env, "remote", "add", "origin", "ssh://git@example.invalid/x/y.git");

  const { stub, log } = sshStub(repo);

  const r = spawnSync("sh", [SCRIPT, "8"],
    { cwd: repo, env: { ...env, GIT_SSH: stub }, encoding: "utf8" });
  assert.equal(r.status, 2, "the stub always fails, so this is 'could not look', never free");

  assertBoundOptions(log);
});

// The two tiers where the script names the program itself rather than
// inheriting one. Every test above supplies its own ssh command, so none of
// them can see a regression that leaves the program EMPTY — git would then get
// a command line starting with `-o` and die with "-o: command not found", and
// the suite would stay green because "could not look" is exit 2 either way.
//
// Nothing configured at all: the last tier of the fallback.
test("probe 2: with no ssh command configured, plain ssh carries the bound options", (t) => {
  const { repo, env, bin } = fixture(t, 8, { origin: "none" });
  git(repo, env, "remote", "add", "origin", "ssh://git@example.invalid/x/y.git");

  const { log } = sshStub(bin, "ssh");

  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 2, "the stub always fails, so this is 'could not look', never free");

  assertBoundOptions(log);
});

// core.sshCommand SET BUT EMPTY — the case the `-n` guard exists for, and the
// one that makes this tier irreducible to a single `$(… || echo ssh)`
// substitution: `git config --get` exits 0 with empty output for an empty
// value, so an exit-status test reads "configured" and hands git no program.
// Measured, that broken form passed the whole suite before this test existed.
test("probe 2: an empty core.sshCommand falls back to plain ssh, not to an empty program", (t) => {
  const { repo, env, bin } = fixture(t, 8, { origin: "none" });
  git(repo, env, "remote", "add", "origin", "ssh://git@example.invalid/x/y.git");
  git(repo, env, "config", "core.sshCommand", "");

  const { log } = sshStub(bin, "ssh");

  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 2, "the stub always fails, so this is 'could not look', never free");

  assertBoundOptions(log);
});
