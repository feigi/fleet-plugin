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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, appendFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
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
    # Set-ness, not non-emptiness, so ONE dial covers the whole range: an empty
    # GH_ISSUE_ERR is a failure with NOTHING on stderr, which is also what the
    # redirect itself failing looks like (unwritable /tmp, a full filesystem) —
    # gh never got to print anything, and #91's fix is what stands between that
    # and a blank tail on the message add_unknown builds.
    if [ -n "\${GH_ISSUE_ERR+set}" ]; then printf '%s' "$GH_ISSUE_ERR" >&2; exit 1; fi
    printf '%s' "$GH_ISSUE_JSON" | jq -r "$expr" ;;
  "pr list")
    # The same dial for probe 1's SECOND gh call. This branch had no failure
    # mode at all, so nothing in this file could drive \`gh pr list\` to fail
    # and the half of #91's fix landing here was unpinned — deleting it left
    # the whole suite green (measured).
    if [ -n "\${GH_PR_ERR+set}" ]; then printf '%s' "$GH_PR_ERR" >&2; exit 1; fi
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
// Same reason again, for probe 1's two python3 calls. They are addressed apart
// by program text the way the awk shim addresses its three filters: the filter
// call and the counting call parse the same `$pr_json` in the same probe, and
// which one breaks is the whole difference between "the PR answer is unknown"
// and "the diagnostic tally is unknown".
const REAL_PYTHON3 = execFileSync("/bin/sh", ["-c", "command -v python3"], { encoding: "utf8" }).trim();
// Same reason, for the one case that shims `git` itself: the shim has to hand
// off to the real binary, and calling `git` from inside it would find the shim.
const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

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
function fixture(t, n, { linked = [], prs = [], issueErr = null, prErr = null, origin = "bare",
                         remoteBranches = [], detachedWorktreeUnder = null, awkFailWhenProgramHas = null,
                         trFailWhenArgsHave = null, python3FailWhenProgramHas = null }) {
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

  // The same shim shape for `tr`. `-d` addresses jrewritten and nothing else:
  // the two other `tr` calls in the script are `tr '\n' ' '` inside
  // `add_unknown` messages — which deliberately do NOT die, that is the whole
  // point of that helper — and jstr's own is a translation with no flags at
  // all. But jstr's does share jrewritten's character class, `\013\016-\037`,
  // so THAT substring reaches both at once: it is the selector for "neither
  // escaper can run", while `-d` is the selector for "only jrewritten cannot".
  //
  // Both selectors surface as the escaper's own exit status, but not for the
  // same reason, and only one of the two is free. jstr's `tr` is the last
  // stage of its own `sed | tr` pipe, so the pipeline status IS tr's. jrewritten's
  // is not: its last command is an always-0 AND-OR list, and the failure
  // reaches the caller only because `inflight.sh` returns explicitly on it
  // (`|| return 1`). Without that, bash and zsh hand back a confident `true`
  // — see the both-shells test below, which is what pins it.
  // (The remaining masking flaw, in jstr's `sed` stage, is #119's, not this
  // file's.)
  if (trFailWhenArgsHave !== null) {
    writeFileSync(join(bin, "tr"), `#!/bin/sh
case "$*" in *'${trFailWhenArgsHave}'*) exit 1 ;; esac
exec '${REAL_TR}' "$@"
`);
    chmodSync(join(bin, "tr"), 0o755);
  }

  // The same shim shape for `python3`, selected by program text. Probe 1 forks
  // it twice over the same `$pr_json` — once to filter the PRs into the answer,
  // once to count the raw window for a diagnostic — and only a substring can
  // tell those two apart. A count of invocations cannot: the two calls are the
  // reason the fork-failure guard exists at all, and addressing "the second
  // python3" pins a case to an ordering rather than to a stage.
  //
  // Exits 1 for the reason the awk shim does: it stands in for a fork that
  // could not happen, not for a program that ran and disagreed.
  if (python3FailWhenProgramHas !== null) {
    writeFileSync(join(bin, "python3"), `#!/bin/sh
case "$*" in *'${python3FailWhenProgramHas}'*) exit 1 ;; esac
exec '${REAL_PYTHON3}' "$@"
`);
    chmodSync(join(bin, "python3"), 0o755);
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
    // release-ticket.test.mjs's GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM already shut
    // it out. Probe 2 only became a
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
  delete env.GH_PR_ERR;
  // `!== null`, not truthiness: "" is a case in its own right — gh failed and
  // said nothing — not the absence of one.
  if (issueErr !== null) env.GH_ISSUE_ERR = issueErr;
  if (prErr !== null) env.GH_PR_ERR = prErr;
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
  // #96: exit 2 from a probe failure now carries a payload — "unanswered"
  // stopped meaning "no verdict to parse" once probes stopped aborting the run.
  assert.deepEqual(r.json.hits, [], "nothing else ran that could have found a hit here");
  assert.deepEqual(r.json.unknown, ["remote"]);
});

// Not a synthetic non-zero exit: this is the plain "no origin configured" a
// fresh clone-less checkout has, and it took the same silent path.
test("probe 2: an origin that is not configured at all is unknown, not free", (t) => {
  const r = inflight(8, { origin: "none" }, t);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /whether #8 has a remote branch is unknown/);
  assert.deepEqual(r.json.hits, []);
  assert.deepEqual(r.json.unknown, ["remote"]);
});

// The opposite direction. This one passed before the fix too, which is the
// point — it fails only if the fix over-reaches and turns `grep`'s no-match
// exit 1 into a death, making every clean ticket unanswerable.
test("probe 2: a reachable origin with no matching branch still reports free", (t) => {
  const r = inflight(8, { remoteBranches: ["main", "fix/other-thing"] }, t);
  assert.equal(r.code, 0);
  assert.equal(r.json.taken, false);
  assert.equal(r.json.evidence.remote, "");
  // The disclosure bit for a field that legitimately found nothing. jrewritten
  // short-circuits on empty input without forking `tr`, and the value it
  // returns for that case is asserted nowhere else: every other *Rewritten
  // assertion in this file sits on a non-empty field. So flipping the
  // short-circuit's own `printf false` to `printf true` passes all 61 other
  // tests — measured — and ships `"remoteRewritten":true` about a string no
  // escaper ever looked at, which is #120's lie in a different slot.
  assert.equal(r.json.evidence.remoteRewritten, false);
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
// else. release-ticket.sh's own awks already read this field as substr($0,10).

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

// --- probe 3, degraded reads (#95).
//
// `for-each-ref` and `worktree list --porcelain` both exit 0 while silently
// dropping what they cannot read, so an exit-status guard never sees it. A
// live branch or worktree then reads as "no local branch or worktree" — the
// wrong "free" #76 exists to rule out, one probe down. Real chmod throughout;
// no way to fake a degraded git read other than triggering the real one.

test("probe 3: an unreadable refs directory is unknown, never a free ticket", (t) => {
  // The issue's own repro: a live branch, `chmod 000 .git/refs/heads`, and the
  // pre-fix script answers `taken=false`.
  const { repo, env } = fixture(t, 55, {});
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "branch", "fix-55-real");
  const refsdir = join(repo, ".git", "refs", "heads");

  // 0o400 (read, no execute) is what tells the guard's `&&` from an `||`: with
  // `||` a readable-but-not-searchable directory would satisfy `-r` alone and
  // pass. 0o000 zeroes both bits at once and cannot make that distinction, but
  // it is the realistic fault the issue measured, so both are checked.
  for (const mode of [0o000, 0o400]) {
    chmodSync(refsdir, mode);
    const r = spawnSync("sh", [SCRIPT, "55"], { cwd: repo, env, encoding: "utf8" });
    // Restored before the first assert, or a failure here leaves a fixture the
    // suite's own cleanup cannot remove.
    chmodSync(refsdir, 0o755);

    const at = `mode 0o${mode.toString(8).padStart(3, "0")}`;
    assert.equal(r.status, 2, at);
    const json = JSON.parse(r.stdout);
    assert.deepEqual(json.hits, [], `no probe found a hit, ${at}`);
    assert.deepEqual(json.unknown, ["local"], `#96: exit 2 now carries a payload naming the probe, ${at}`);
    assert.match(r.stderr, /refs directory .* could not be read/, at);
    assert.doesNotMatch(r.stderr, /no local branch or worktree/, at);
  }
});

test("probe 3: an unreadable refs SUBdirectory is unknown too — every fleet branch is in one", (t) => {
  // The case above chmods the top of `refs/heads`, and no fleet branch lives
  // there: `claim-ticket.sh` builds `branch="$type/$issue-$slug"`, so the real
  // ref is `refs/heads/fix/95-…`, one level down. A guard that tests only the
  // top directory leaves the entire realistic class open — `for-each-ref` then
  // drops the branch at rc 0 with nothing on stderr, and #95's own wrong "free"
  // survives its own fix.
  const { repo, env } = fixture(t, 95, {});
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "branch", "fix/95-inflight-degraded-reads");
  const typedir = join(repo, ".git", "refs", "heads", "fix");

  // Both modes, for the reason the case above checks both: 0o000 is the
  // realistic fault, 0o400 is the one that tells an `&&` from an `||`.
  for (const mode of [0o000, 0o400]) {
    chmodSync(typedir, mode);
    const r = spawnSync("sh", [SCRIPT, "95"], { cwd: repo, env, encoding: "utf8" });
    // Restored before the first assert, or a failure here leaves a fixture the
    // suite's own cleanup cannot remove.
    chmodSync(typedir, 0o755);

    const at = `mode 0o${mode.toString(8).padStart(3, "0")}`;
    assert.equal(r.status, 2, at);
    const json = JSON.parse(r.stdout);
    assert.deepEqual(json.hits, [], `no probe found a hit, ${at}`);
    assert.deepEqual(json.unknown, ["local"], `#96: exit 2 now carries a payload naming the probe, ${at}`);
    assert.match(r.stderr, /refs directory .* could not be read/, at);
    assert.doesNotMatch(r.stderr, /no local branch or worktree/, at);
  }

  // The control, and it is not optional: without it a fixture that never had a
  // findable branch would produce the same exit 2 and the case above would pass
  // while pinning nothing. Readable, the branch IS found — so the refusal above
  // is git being unable to look, not there being nothing to see.
  const ok = spawnSync("sh", [SCRIPT, "95"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(ok.status, 1, "readable: the branch is found and the ticket is taken");
  assert.match(ok.stderr, /local branches: fix\/95-inflight-degraded-reads/);
});

test("probe 3: an unreadable worktree registry is unknown, never a free ticket", (t) => {
  // Same repro shape, aimed at `.git/worktrees` (git's own admin dir) instead
  // of refs/heads — matches release-ticket.sh's worktree-registry check (#84).
  const { repo, env } = fixture(t, 77, { detachedWorktreeUnder: "nospace" }, );
  const wtroot = join(repo, ".git", "worktrees");

  for (const mode of [0o000, 0o400]) {
    chmodSync(wtroot, mode);
    const r = spawnSync("sh", [SCRIPT, "77"], { cwd: repo, env, encoding: "utf8" });
    chmodSync(wtroot, 0o755);

    const at = `mode 0o${mode.toString(8).padStart(3, "0")}`;
    assert.equal(r.status, 2, at);
    const json = JSON.parse(r.stdout);
    assert.deepEqual(json.hits, [], `no probe found a hit, ${at}`);
    assert.deepEqual(json.unknown, ["local"], `#96: exit 2 now carries a payload naming the probe, ${at}`);
    assert.match(r.stderr, /worktree registry .* could not be read/, at);
  }
});

test("probe 3: an entry git cannot read INSIDE is unknown too, not just an unreadable entry", (t) => {
  // #84 itself: naming a registry entry needs read+execute on the PARENT
  // only, so the entry directory stays readable while the `gitdir` file git
  // opens inside it does not. `worktree list --porcelain` drops it anyway, at
  // rc 0 — caught here by the count, not by a permission test on the entry.
  const { repo, env } = fixture(t, 77, { detachedWorktreeUnder: "nospace" });
  const entries = readdirSync(join(repo, ".git", "worktrees"));
  assert.equal(entries.length, 1, "fixture: exactly one linked worktree registered");
  const gitdir = join(repo, ".git", "worktrees", entries[0], "gitdir");

  chmodSync(gitdir, 0o000);
  const r = spawnSync("sh", [SCRIPT, "77"], { cwd: repo, env, encoding: "utf8" });
  // Restored before the first assert — a later `worktree list` (including the
  // suite's own cleanup) would otherwise still see this claim's worktree as
  // dropped.
  chmodSync(gitdir, 0o644);

  assert.equal(r.status, 2);
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.hits, []);
  assert.deepEqual(json.unknown, ["local"], "#96: exit 2 now carries a payload naming the probe");
  assert.match(r.stderr, /git listed 0 worktrees for 1 registry entries/);
});

test("probe 3: a repo that never had a linked worktree is still answerable and free", (t) => {
  // The trap a naive fix falls into: refusing whenever `.git/worktrees` is
  // simply missing, conflating "never existed" with "exists but unreadable".
  // A vanilla repo has no such directory at all, and that absence must stay
  // free, not become a permanent exit 2 (#95).
  const { repo, env } = fixture(t, 8, {});
  assert.equal(existsSync(join(repo, ".git", "worktrees")), false,
    "fixture: no worktree has ever been linked");

  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).taken, false);
});

test("probe 3: something that is not a registry entry is not counted as a dropped worktree", (t) => {
  // The count above globs the registry directory, so it sees whatever is in
  // there — and anything that is not a directory is not a worktree
  // registration, matching release-ticket.sh's own fix for the same trap.
  const { repo, env } = fixture(t, 8, {});
  mkdirSync(join(repo, ".git", "worktrees"), { recursive: true });
  writeFileSync(join(repo, ".git", "worktrees", "stray-note"), "not a worktree\n");

  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).taken, false);
});

test("probe 3: a stray DIRECTORY in the registry is not a worktree git failed to report", (t) => {
  // The case above covers a stray *file*, which the `-d` test skipped anyway.
  // A stray *directory* is the one that bites: git ignores it, a `-d`-only
  // count sees it (measured: git lists 2 worktrees where the count said 3),
  // and the mismatch then turns EVERY ticket in that repo into exit 2 until a
  // human notices. One `mkdir` under `.git/worktrees` is all it takes.
  const { repo, env } = fixture(t, 8, {});
  mkdirSync(join(repo, ".git", "worktrees", "stray-dir"), { recursive: true });

  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).taken, false);
});

test("probe 3: a registry entry git cannot even open is unknown, not a stray to skip", (t) => {
  // The other half of that skip, and why it tests `-x` before `gitdir`: an
  // entry chmod'd 000 answers "no gitdir file" to precisely the same test a
  // stray directory does. But git DROPS this one (measured: 2 listed, then 1),
  // so skipping it as "not git's" would reinstate the silent free — the same
  // defect one layer in from the one this whole change removes.
  const { repo, env } = fixture(t, 77, { detachedWorktreeUnder: "nospace" });
  const entries = readdirSync(join(repo, ".git", "worktrees"));
  assert.equal(entries.length, 1, "fixture: exactly one linked worktree registered");
  const entry = join(repo, ".git", "worktrees", entries[0]);

  chmodSync(entry, 0o000);
  const r = spawnSync("sh", [SCRIPT, "77"], { cwd: repo, env, encoding: "utf8" });
  // Restored before the first assert, or the suite's own cleanup inherits it.
  chmodSync(entry, 0o755);

  assert.equal(r.status, 2);
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.hits, []);
  assert.deepEqual(json.unknown, ["local"], "#96: exit 2 now carries a payload naming the probe");
  assert.match(r.stderr, /git listed 0 worktrees for 1 registry entries/);
});

test("probe 3: a registry entry whose gitdir is GONE is unknown, not a stray to skip", (t) => {
  // Why the skip tests EMPTINESS and not the absence of `gitdir`. Git drops an
  // entry whose `gitdir` file was deleted, so keying the skip on that file
  // waves a corrupt entry through as "not git's" and the ticket reads FREE
  // while its checkout may still be on disk — the wrong "free" this probe
  // exists to rule out, reintroduced one layer in. An operator's stray `mkdir`
  // is empty; even a corrupt entry still holds git's own files (commondir,
  // HEAD, index, logs, refs), and that is the difference the count can see.
  const { repo, env } = fixture(t, 77, { detachedWorktreeUnder: "nospace" });
  const entries = readdirSync(join(repo, ".git", "worktrees"));
  assert.equal(entries.length, 1, "fixture: exactly one linked worktree registered");
  execFileSync("rm", [join(repo, ".git", "worktrees", entries[0], "gitdir")]);

  const r = spawnSync("sh", [SCRIPT, "77"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 2, "a dropped entry is unknown, never the exit 0 that means free");
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.hits, []);
  assert.deepEqual(json.unknown, ["local"], "#96: exit 2 now carries a payload naming the probe");
  assert.match(r.stderr, /git listed 0 worktrees for 1 registry entries/);
});

test("probe 3: git listing MORE than the registry reports THAT, not an incomplete listing", (t) => {
  // The mismatch has two directions with opposite causes, and one message
  // cannot serve both. Fewer listed than registered is git dropping an entry
  // it could not read. More listed than registered is the reverse — the
  // on-disk count is the stale read, which is what a sibling agent's
  // `git worktree add` landing between the two produces, routine in a parallel
  // fleet. Reporting that as "the listing is incomplete" sends the operator
  // after a permissions fault that does not exist.
  //
  // Shimmed rather than raced: git derives its listing FROM the registry, so
  // the only way it outruns the count is that interleaving, and a shim pins
  // the resulting message deterministically instead of hoping to hit a window.
  const { repo, env, bin } = fixture(t, 8, {});
  writeFileSync(join(bin, "git"), `#!/bin/sh
case "$*" in
  "worktree list --porcelain")
    '${REAL_GIT}' "$@"
    printf 'worktree /tmp/phantom-worktree\\nHEAD ${"0".repeat(40)}\\ndetached\\n\\n'
    exit 0 ;;
esac
exec '${REAL_GIT}' "$@"
`);
  chmodSync(join(bin, "git"), 0o755);

  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 2);
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.hits, []);
  assert.deepEqual(json.unknown, ["local"], "#96: exit 2 now carries a payload naming the probe");
  assert.match(r.stderr, /git listed 1 worktrees but only 0 registry entries were counted/);
  assert.doesNotMatch(r.stderr, /the listing is incomplete/);
});

/**
 * Shims `git` so that `mutation` runs on the ONE call that reads the worktree
 * registry, then hands off to the real binary.
 *
 * Shimmed rather than slept: this is the window between inflight.sh's own
 * on-disk count and git's read of the same registry, measured at ~10ms, and a
 * test that tries to hit it with a sleep is a flake generator. Firing on the
 * call itself lands the mutation inside the window every time.
 *
 * The sentinel keeps it to one shot — the suite's own cleanup shells out to
 * git too, and a shim that mutated on every listing would never converge.
 * Returned so a case can assert it actually fired: a shim that silently stops
 * matching turns this into a test of nothing.
 */
function registryRaceShim(bin, mutation) {
  const fired = join(bin, "race-fired");
  writeFileSync(join(bin, "git"), `#!/bin/sh
case "$*" in
  "worktree list --porcelain")
    if [ ! -e '${fired}' ]; then
      : > '${fired}'
      ${mutation}
    fi ;;
esac
exec '${REAL_GIT}' "$@"
`);
  chmodSync(join(bin, "git"), 0o755);
  return fired;
}

test("probe 3: a sibling worktree ADD between the two reads is absorbed, not an abort", (t) => {
  // The count and the listing are two reads at two instants, and a sibling
  // agent's `git worktree add` landing between them makes them disagree with
  // nothing wrong. Measured on this fleet's own shape: 1.99% of probes abort
  // spuriously at 2 mutations/s, 56.6% under saturation. Only a disagreement
  // that survives a re-read is evidence of a dropped entry, so one recount
  // absorbs this while leaving the real fault (pinned above) still refusing.
  const { repo, env, bin } = fixture(t, 8, {});
  // A basename with no digits in it: probe 3 matches worktrees on basename, and
  // a sibling that happened to carry the ticket number would answer "taken"
  // here for a reason that has nothing to do with the race.
  const sibling = join(repo, "..", "sibling-work");
  const fired = registryRaceShim(bin,
    `'${REAL_GIT}' worktree add -q --detach '${sibling}' HEAD >/dev/null 2>&1`);
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");

  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.ok(existsSync(fired), "the shim fired: the mutation really landed in the window");
  assert.equal(r.status, 0, `a concurrent add is not an unanswerable probe: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /registry entries/, "no mismatch is reported at all");
  assert.equal(JSON.parse(r.stdout).taken, false);
});

test("probe 3: a sibling worktree REMOVE between the two reads is absorbed, not an abort", (t) => {
  // The other direction, and it is the one that looks like the real fault:
  // git lists FEWER than the count, which is exactly the shape of an entry git
  // dropped because it could not read it. The recount is what tells a worktree
  // that is gone from one that is merely unreadable — the former stops being
  // registered, the latter stays.
  const { repo, env, bin } = fixture(t, 8, { detachedWorktreeUnder: "nospace" });
  const wt = join(repo, "..", "nospace", "fix-8-slug");
  const fired = registryRaceShim(bin,
    `'${REAL_GIT}' worktree remove --force '${wt}' >/dev/null 2>&1`);

  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.ok(existsSync(fired), "the shim fired: the mutation really landed in the window");
  assert.equal(r.status, 0, `a concurrent remove is not an unanswerable probe: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /registry entries/, "no mismatch is reported at all");
  assert.equal(JSON.parse(r.stdout).taken, false);
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
// way release-ticket.test.mjs's hostile-name payload cases build their own —
// "a quote in the slug cannot produce a payload the caller fails to parse" and
// the three below it: the names are the fixture.

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
  // release-ticket.test.mjs's "a control character in the worktree name cannot
  // produce an unparseable payload".
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

// A failed escaper must not retract an already-correct verdict (#120). The
// bug it replaces: `$(jstr …)`/`$(jrewritten …)` sat in one long `&&` chain
// ending `|| die`, so ANY of the eight calls failing threw the whole payload
// away and reported exit 2 — turning a correctly-decided "taken" or "free"
// into "unanswerable" over a formatter, not a decision.
test("an escaper that cannot run nulls only its own field — the verdict and exit code are unchanged", (t) => {
  // Ticket 66 has a real local branch, so jstr and jrewritten are actually
  // invoked on non-empty content for `localBranch` — breaking `tr` on the
  // character class both share is a fork failure neither can mask (`tr` is
  // jrewritten's only command and the LAST stage of jstr's own `sed | tr`, so
  // its status is the pipeline's own). A field with nothing to say never
  // reaches `tr` at all (jstr/jrewritten short-circuit on empty input), so
  // `pr`/`remote`/`worktree` — all legitimately empty here — must stay `""`,
  // not `null`, while `localBranch` alone goes `null`.
  const bad = fixture(t, 66, { trFailWhenArgsHave: "\\013\\016-\\037" });
  git(bad.repo, bad.env, "commit", "-q", "--allow-empty", "-m", "x");
  git(bad.repo, bad.env, "branch", "fix-66-thing");
  const r = spawnSync("sh", [SCRIPT, "66"], { cwd: bad.repo, env: bad.env, encoding: "utf8" });

  // Same ticket, same branch, no shim — the answer the run above must not
  // diverge from once the formatter is subtracted out.
  const good = fixture(t, 66, {});
  git(good.repo, good.env, "commit", "-q", "--allow-empty", "-m", "x");
  git(good.repo, good.env, "branch", "fix-66-thing");
  const rGood = spawnSync("sh", [SCRIPT, "66"], { cwd: good.repo, env: good.env, encoding: "utf8" });

  assert.equal(r.status, rGood.status, "same exit code as the run where the escaper works");
  const json = JSON.parse(r.stdout);
  const jsonGood = JSON.parse(rGood.stdout);
  assert.equal(json.taken, jsonGood.taken);
  assert.deepEqual(json.hits, jsonGood.hits);
  assert.equal(json.evidence.localBranch, null, "the one field that actually needed escaping");
  assert.equal(json.evidence.localBranchRewritten, null);
  assert.equal(json.evidence.pr, "", "never touched the broken tr — stays the empty-probe value");
  assert.equal(json.evidence.remote, "");
  assert.equal(json.evidence.worktree, "");
  assert.match(r.stderr, /could not render the localBranch evidence.*as JSON/);
});

// The positive counterpart: valid, unremarkable evidence — nothing for the
// escaper to choke on — must still be accepted once the failure clears. Pins
// that the null-on-failure path introduced above has no false-positive
// twin that nulls a field the escaper never had trouble with.
test("with a working escaper, ordinary evidence renders as a plain string, never null", (t) => {
  const { repo, env } = fixture(t, 66, {});
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "branch", "fix-66-thing");

  const r = spawnSync("sh", [SCRIPT, "66"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.equal(json.evidence.localBranch, "fix-66-thing");
  assert.equal(json.evidence.localBranchRewritten, false);
});

// The asymmetric half of the case above, and the only one that addresses
// jrewritten ALONE: `-d` is a substring of `tr -d '\001-…'` and of nothing
// else in the script, so jstr renders `fix-66-thing` perfectly and only the
// rewritten-check breaks. Without this, the `if ev=$(jstr …) && rw=$(jrewritten …)`
// conjunction is pinned on one operand only — measured, a mutant that drops
// jrewritten out of the guard passed every test in this file as it stood
// before these cases were added.
//
// Run under BOTH shells on purpose, and that is the load-bearing part, not
// belt-and-braces. jrewritten's `tr` failure becomes its exit status only
// because of its explicit `|| return 1` (see the comment on it); strip that
// and the answer depends on which shell runs the script. `sh` cannot see the
// difference on either platform this suite runs on — it is Apple's `/bin/sh`
// on macOS and `dash` on CI's ubuntu, and both abort the function via `set -e`
// whether or not the guard is there. `bash` is the one that can: measured,
// bash 3.2.57 (macOS `/bin/bash`) and bash 5.3 both run past the failed `tr`
// to the always-0 last line and report `localBranchRewritten: true` — a "bytes
// were replaced" claim about a branch name holding no control bytes, with no
// null and no stderr line at all. So a case that only ever spawns `sh` would
// pin nothing here.
for (const shell of ["sh", "bash"]) {
  test(`under ${shell}, an escaper that cannot test for rewritten bytes nulls its field rather than guessing`, (t) => {
    const { repo, env } = fixture(t, 66, { trFailWhenArgsHave: "-d" });
    git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
    git(repo, env, "branch", "fix-66-thing");

    const r = spawnSync(shell, [SCRIPT, "66"], { cwd: repo, env, encoding: "utf8" });
    const json = JSON.parse(r.stdout);
    assert.equal(r.status, 1, "the verdict the three probes established, unchanged");
    assert.equal(json.taken, true);
    assert.deepEqual(json.hits, ["local"]);
    assert.equal(json.evidence.localBranchRewritten, null,
      "never `true`: nothing examined the bytes, so nothing may claim they were replaced");
    assert.equal(json.evidence.localBranch, null,
      "nulled with its own rewritten flag — a string whose rewritten status is unknown is not the original bytes");
    // Names the escaper, not just the field: jstr rendered `fix-66-thing`
    // perfectly here, so a message pointing at it would send a debugger to the
    // half that worked.
    assert.match(r.stderr, /could not render the localBranch evidence for #66 as JSON \(jrewritten\)/);
  });
}

// The mirror: jstr's own `tr` broken while jrewritten's still runs. The two
// invocations are distinguishable in `$*` even though they share a character
// class — jstr's passes a second argument, so its argv ends `\037` + space,
// while jrewritten's ends at `\037` (measured, via a tr that echoes `$*`):
//   jstr        -> [\001-\007\013\016-\037  ]
//   jrewritten  -> [-d \001-\007\013\016-\037]
// so `\037 ` with the trailing space is a jstr-only selector, as `-d` is a
// jrewritten-only one. Together the two pin the `&&`'s operands independently
// — neither mutant that drops one call out of the guard survives both.
//
// One shell is enough here, unlike above: jstr's `tr` is the last stage of its
// own pipe, so its failure IS the pipeline's status on every shell. (Its `sed`
// stage is the one that stays masked — #119's, not this file's.)
test("under sh, an escaper that cannot escape at all nulls its field rather than emitting a half-escaped string", (t) => {
  const { repo, env } = fixture(t, 66, { trFailWhenArgsHave: "\\037 " });
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "branch", "fix-66-thing");

  const r = spawnSync("sh", [SCRIPT, "66"], { cwd: repo, env, encoding: "utf8" });
  const json = JSON.parse(r.stdout);
  assert.equal(r.status, 1, "the verdict the three probes established, unchanged");
  assert.equal(json.taken, true);
  assert.deepEqual(json.hits, ["local"]);
  assert.equal(json.evidence.localBranch, null);
  assert.equal(json.evidence.localBranchRewritten, null,
    "nulled alongside its string: a rewritten flag about bytes no escaper could render says nothing");
  assert.equal(json.evidence.pr, "", "empty fields never reach the broken tr at all");
  // The other escaper named — the mirror of the case above, and the pair is
  // what makes the name worth printing at all.
  assert.match(r.stderr, /could not render the localBranch evidence for #66 as JSON \(jstr\)/);
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
  // The third payload-less exit 2, and the only one that fires from INSIDE a
  // probe — probe 1's own `gh issue view` has already run when this die is
  // reached. A missing issue is the premise all three probes rest on rather
  // than one probe's failure, so it abandons the run instead of recording an
  // unknown. Pinned here because the script's header enumerates the
  // payload-less causes, and nothing else in this file notices if this one
  // starts emitting a payload (measured: converting the die to
  // `add_unknown "pr"; return 1` left the whole suite green without this line).
  assert.equal(r.json, null, "no payload — nothing was established for one to hold");
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
  assert.deepEqual(r.json.hits, []);
  assert.deepEqual(r.json.unknown, ["remote"], "#96: exit 2 now carries a payload naming the probe");
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
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.hits, []);
  assert.deepEqual(json.unknown, ["local"], "#96: exit 2 now carries a payload naming the probe");
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
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.hits, []);
  assert.deepEqual(json.unknown, ["local"], "#96: exit 2 now carries a payload naming the probe");
});

test("probe 3: a worktree COUNT that could not run is unknown, never a bogus tally", (t) => {
  // The registry cross-check counts git's own listing, and that counter is a
  // stage like any other. It used to be `grep -c '^worktree ' || true`, and
  // that `|| true` was not optional: `grep -c` exits 1 on zero matches, which
  // is legitimate. But it absorbed a grep that could not RUN just as happily,
  // leaving the count empty, `$((listed - 1))` at -1, and the die blaming
  // `git worktree list` for a tally no listing can produce. One awk, whose
  // program contains no `exit`, needs no such case absorbed — so the status is
  // the counter's own and reads as the failure it is.
  const { repo, env } = fixture(t, 77, { awkFailWhenProgramHas: "{c++}",
                                         detachedWorktreeUnder: "nospace" });

  const r = spawnSync("sh", [SCRIPT, "77"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 2, "unanswerable is exit 2, not the exit 0 that means free");
  assert.match(r.stderr, /could not count the worktrees git listed for #77/);
  assert.doesNotMatch(r.stderr, /-1 worktrees/,
    "a counter that could not run never reports a count at all");
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.hits, []);
  assert.deepEqual(json.unknown, ["local"], "#96: exit 2 now carries a payload naming the probe");
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

// --- #96: accumulate rather than abort. A probe that cannot answer used to
// `die` immediately, discarding a sufficient hit any other probe had already
// found (or would still find) — the whole point of the three probes being a
// monotone disjunction. Now each records itself unknown and the run
// continues; hits still win outright, and exit 2 carries a payload naming
// which probes could not look, so "exit 2" stops meaning "no stdout at all".
//
// Both directions of the hit-survives-a-later-failure pair are pinned below,
// with probe 2 (remote, via the already-supported `origin: "unreachable"`)
// as the probe that fails in each: probe 1 finding a hit before probe 2 dies,
// and probe 3 finding one after. The other four orderings ((pr, local),
// (remote, pr), (remote, local), (local, pr) as hit/fail pairs) are left
// unpinned here on purpose — the fix is probe-agnostic by construction, the
// same `probe_X || :` shape for all three with no branching on which probe is
// which, so a fault that broke one ordering and not its symmetric twin would
// have to live inside one probe's own body.
//
// Which is NOT the same as those bodies being covered, and an earlier version
// of this comment claimed it was. Measured by mutation during #406's review:
// replacing `add_unknown …; return 1` with a silent `return 0` at six internal
// branches — probe 1's `gh pr list failed`, `could not filter PR search
// results` and `could not count the PR search results`, probe 3's `cannot
// resolve the git common directory`, `could not test the refs directories
// under` and `git worktree list failed` — left this whole file green, six
// mutants surviving. What the tests above pin is each probe's OUTWARD answer
// on the failures they can drive through the fixture (an unreachable GitHub, an
// unreachable origin, an unreadable refs directory or worktree registry, a
// filter that cannot run): the exit code, `hits` and `unknown`. Which internal
// branch produced that answer is mostly not pinned, and per-branch coverage is
// still open — see the issue filed from #406's review.
//
// The gap that mattered is closed here rather than left to that issue: #406
// found accumulation was per-PROBE, not per-SIGNAL, so a hit already computed
// inside a probe was still discarded when a LATER stage of that same probe
// failed. The two same-probe cases below pin both halves of that fix, and the
// probe-1 filter case pins one of the six branches above.

test("accumulate: an open linked PR survives an unreachable origin — probe 1's hit outlives probe 2's failure", (t) => {
  const r = inflight(7, { linked: [12], prs: [pr(12, "OPEN", "fix/other-thing")], origin: "unreachable" }, t);
  assert.equal(r.code, 1, "the PR hit alone is sufficient — taken, not unanswerable");
  assert.equal(r.json.taken, true);
  assert.equal(r.json.evidence.pr, "#12 OPEN (linked)", "the hit found before the failure is not discarded");
  assert.deepEqual(r.json.hits, ["pr"]);
  assert.deepEqual(r.json.unknown, ["remote"], "the probe that could not look is named, not silently dropped");
});

test("accumulate: a local worktree survives an unreachable origin — probe 3's hit outlives probe 2's failure", (t) => {
  const r = inflight(77, { detachedWorktreeUnder: "nospace", origin: "unreachable" }, t);
  assert.equal(r.code, 1, "the worktree hit alone is sufficient — taken, not unanswerable");
  assert.equal(r.json.taken, true);
  assert.match(r.json.evidence.worktree, /nospace\/fix-77-slug$/, "the hit found after the failure is not discarded either");
  assert.deepEqual(r.json.hits, ["local"]);
  assert.deepEqual(r.json.unknown, ["remote"]);
});

// --- #406: the same discard, one level down. A hit is committed where it is
// established, not at the end of the probe that established it.

test("accumulate: a PR hit outlives a later failure in its OWN probe — the diagnostic count cannot retract it", (t) => {
  // The counting python3 only fills in the "(N full-text match(es))" tally on
  // stderr; `$pr` is the answer and the filter call above it already produced
  // one. Measured with this shim before the fix: exit 2, `hits:[]`,
  // `unknown:["pr"]`, while `evidence.pr` in the same payload read
  // "#12 OPEN (linked)" — the proof the ticket was taken, thrown away over a
  // number nothing decides on.
  const r = inflight(7, {
    linked: [12], prs: [pr(12, "OPEN", "fix/other-thing")],
    python3FailWhenProgramHas: "len(json.load",
  }, t);
  assert.equal(r.code, 1, "the PR answer was established, so this is taken — not unanswerable");
  assert.equal(r.json.taken, true);
  assert.equal(r.json.evidence.pr, "#12 OPEN (linked)");
  assert.deepEqual(r.json.hits, ["pr"], "the hit survives a later stage of its own probe");
  assert.deepEqual(r.json.unknown, [], "a stage that cannot change the answer records no unknown");
  assert.match(r.stderr, /\(\? full-text match\(es\) considered\)/,
    "and the tally that could not run says so rather than printing a number it does not have");
});

test("accumulate: a local-branch hit outlives a later failure in its OWN probe — the worktree half", (t) => {
  // Built by hand, and NOT `detachedWorktreeUnder`: that option is detached
  // precisely so no local branch exists, which is the reason every registry-
  // failure test above asserts `hits: []` and none of them could catch this.
  // Here the branch is the hit and the worktree filter is the later failure.
  const { repo, env } = fixture(t, 77, { awkFailWhenProgramHas: "substr($0,10)" });
  git(repo, env, "commit", "-q", "--allow-empty", "-m", "x");
  git(repo, env, "branch", "fix/77-slug");

  // Measured before the fix: exit 2, `hits:[]`, `unknown:["local"]`, with
  // `evidence.localBranch` naming `fix/77-slug` in the same payload.
  const r = spawnSync("sh", [SCRIPT, "77"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 1, "the branch alone is sufficient — taken, not unanswerable");
  const json = JSON.parse(r.stdout);
  assert.equal(json.taken, true);
  assert.equal(json.evidence.localBranch, "fix/77-slug");
  assert.deepEqual(json.hits, ["local"], "recorded once, at the half that answered");
  assert.deepEqual(json.unknown, ["local"],
    "and the half that could not look is still named — a hit outranks it, it is not erased by it");
  assert.doesNotMatch(r.stderr, /no local branch or worktree/,
    "the probe found one, so it never reports finding none");
});

test("probe 1: a PR filter that could not run is unknown, never free", (t) => {
  // The filter is the stage the count above is not: it produces `$pr`, the PR
  // answer itself, so its failure genuinely leaves the question unanswered.
  // One of the six branches the preamble above names as unpinned — a silent
  // `return 0` here reads as "no PR is about #7" and frees a taken ticket.
  const r = inflight(7, {
    linked: [12], prs: [pr(12, "OPEN", "fix/other-thing")],
    python3FailWhenProgramHas: "seg = re.compile",
  }, t);
  assert.equal(r.code, 2, "unanswerable is exit 2, not the exit 0 that means free");
  assert.match(r.stderr, /could not filter PR search results for #7/);
  assert.doesNotMatch(r.stderr, /no PR is about/, "a stage that could not run never reports 'no'");
  assert.deepEqual(r.json.hits, []);
  assert.deepEqual(r.json.unknown, ["pr"]);
});

test("accumulate: all three probes unanswerable is exit 2 WITH a payload naming all three", (t) => {
  const { repo, env } = fixture(t, 999, {
    issueErr: "dial tcp: lookup api.github.com: no such host", origin: "unreachable",
  });
  const refsdir = join(repo, ".git", "refs", "heads");
  chmodSync(refsdir, 0o000);
  const r = spawnSync("sh", [SCRIPT, "999"], { cwd: repo, env, encoding: "utf8" });
  // Restored before the first assert, or a failure here leaves a fixture the
  // suite's own cleanup cannot remove.
  chmodSync(refsdir, 0o755);

  assert.equal(r.status, 2);
  assert.notEqual(r.stdout.trim(), "", "exit 2 from a probe failure now carries a payload");
  const json = JSON.parse(r.stdout);
  assert.equal(json.taken, false);
  assert.deepEqual(json.hits, []);
  assert.deepEqual(json.unknown.slice().sort(), ["local", "pr", "remote"],
    "every probe that could not answer is named, not just the first one to fail");
});

test("accumulate: a genuinely free ticket still exits 0, with an empty unknown list", (t) => {
  const r = inflight(8, {}, t);
  assert.equal(r.code, 0);
  assert.equal(r.json.taken, false);
  assert.deepEqual(r.json.hits, []);
  assert.deepEqual(r.json.unknown, [], "nothing failed, so nothing is unknown");
});

// --- #96: the accumulate change must not manufacture a payload where none
// existed before. Nothing has been established yet for either of these —
// no probe has run — so both stay a hard, payload-less exit 2 exactly as
// before.

test("accumulate: a bad argument is still refused before any probe runs, with no payload", (t) => {
  const r = spawnSync("sh", [SCRIPT, "abc"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "", "nothing has been established yet — this is not a probe failure");
  assert.match(r.stderr, /issue must be a number/);
});

test("accumulate: a zero-padded issue is refused before any probe runs, with no payload", (t) => {
  // All-digits is not a JSON number — RFC 8259 forbids a leading zero — so
  // `007` used to clear the guard, reach the verdict printf and emit
  // `{"issue":007,…}` at exit 0: unparseable, with an exit code that gave the
  // caller no hint (#121). The guard's `0?*` arm refuses it at the same
  // boundary as a non-numeric argument. Normalising with `n=$((n))` instead
  // would be worse than the bug: /bin/sh reads `007` as octal 7 and `010` as
  // 8, silently answering about a different ticket.
  const r = spawnSync("sh", [SCRIPT, "007"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "", "nothing has been established yet — this is not a probe failure");
  assert.match(r.stderr, /issue must be a number/);
});

test("accumulate: an unpadded issue number still reaches a parseable verdict", (t) => {
  // The other half of #121's guard, and the half that would strand the fleet if
  // it were wrong: `gh` never zero-pads, so every legitimate caller passes a
  // bare number and must still be answered. A guard that over-refused would
  // turn every real claim check into exit 2, and only this direction catches it.
  const r = inflight(7, {}, t);
  assert.equal(r.code, 0);
  assert.equal(r.json.issue, 7, "emitted as a JSON number, and the payload parses");
});

test("accumulate: outside a git repository is still refused before any probe runs, with no payload", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "inflight-not-a-repo-"));
  t.after(() => execFileSync("rm", ["-rf", outside]));
  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: outside, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "", "nothing has been established yet — this is not a probe failure");
  assert.match(r.stderr, /not inside a git repository/);
});

// --- #91: the temp file `gh`'s stderr is captured to. Two problems, one fix:
// a fixed /tmp/.inflight.$$ was guessable and symlink-truncatable, and a
// capture that failed for its own reasons (unwritable /tmp, a full
// filesystem) read back as an empty cause, indistinguishable from gh itself
// having said nothing.

test("probe 1: gh failing with nothing on stderr still names a cause, not a blank tail", (t) => {
  // An empty `issueErr`, not a second knob — gh failed and printed nothing,
  // which is also what a capture that could not even write looks like, and is
  // distinct from every other failure case in this file, all of which have
  // real text to report.
  const r = inflight(8, { issueErr: "" }, t);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /PR links are unknown: cause unavailable/,
    "an empty capture says so instead of trailing off after the colon");
});

// The same fix lands on probe 1's SECOND gh call, and both call sites now read
// the capture back through one `gh_cause`. These two are what prove the helper
// is wired at BOTH sites rather than only at the first: hardcoding the fallback
// here kills the text case, dropping the fallback from the helper kills the
// silent case (and its `gh issue view` twin above).
test("probe 1: gh pr list failing carries its own cause into the unknown it records", (t) => {
  const r = inflight(8, { prErr: "HTTP 403: API rate limit exceeded" }, t);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /whether #8 is taken is unknown: HTTP 403: API rate limit exceeded/,
    "the cause is read back from the capture, not substituted for");
  assert.deepEqual(r.json.unknown, ["pr"]);
});

test("probe 2's call: gh pr list failing with nothing on stderr still names a cause", (t) => {
  const r = inflight(8, { prErr: "" }, t);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /whether #8 is taken is unknown: cause unavailable/,
    "the second capture site inherits the fallback instead of re-deriving it");
});

test("probe 1: mktemp failing leaves probes 2 and 3 to answer, rather than abandoning the run", (t) => {
  // The capture file is probe 1's own resource, so losing it is "probe 1 could
  // not look" — not "the question cannot be answered". Probes 2 and 3 need
  // neither gh nor the file. Measured with the `|| die` this replaces, on this
  // very fixture: exit 2, empty stdout, both hits discarded.
  //
  // Still kills the mutant the die killed: reverting to the old fixed
  // /tmp/.inflight.$$ path calls no mktemp at all, so this stub goes untouched,
  // probe 1 succeeds and `unknown` comes back empty.
  const { repo, env, bin } = fixture(t, 8, {
    remoteBranches: ["fix/8-thing"], detachedWorktreeUnder: "nospace",
  });
  writeFileSync(join(bin, "mktemp"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "mktemp"), 0o755);
  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 1, "two probes still found the ticket taken");
  const json = JSON.parse(r.stdout);
  assert.equal(json.taken, true);
  assert.deepEqual(json.hits, ["remote-branch", "local"],
    "neither hit is discarded by probe 1's local resource failure");
  assert.deepEqual(json.unknown, ["pr"], "and the probe that could not look is named");
  assert.match(r.stderr, /could not create a temporary file to capture gh's stderr/);
});

test("cleanup that cannot remove the capture file never rewrites the verdict", (t) => {
  // The EXIT trap runs OUTSIDE the probe bodies, where `set -e` is live, so a
  // bare `rm -f` that fails aborts the shell with status 1 — and 1 is this
  // script's code for "taken". Measured on the unguarded trap: this free
  // ticket exited 1 while its own payload still said `taken:false`, and a run
  // that should have exited 2 came back 1 as well. The verdict is computed and
  // announced on stderr first, then overwritten by cleanup.
  const { repo, env, bin } = fixture(t, 8, {});
  const cap = join(bin, "..", "cap");
  // mktemp still hands back a real 0600 file; only its DIRECTORY is made
  // unremovable, which is what `rm -f` fails on (a read-only mount, perms
  // changed under the run). Writing the capture is unaffected: `2>` needs
  // permission on the file, not on the directory.
  writeFileSync(join(bin, "mktemp"), `#!/bin/sh
mkdir -p '${cap}' && chmod 755 '${cap}'
f='${cap}'/cap.$$
(umask 077; : > "$f") || exit 1
chmod 555 '${cap}'
printf '%s\\n' "$f"
`);
  chmodSync(join(bin, "mktemp"), 0o755);
  const r = spawnSync("sh", [SCRIPT, "8"], { cwd: repo, env, encoding: "utf8" });
  // Restored before the first assert, or a failure here leaves a fixture the
  // suite's own cleanup cannot remove.
  chmodSync(cap, 0o755);

  assert.equal(r.status, 0, "a free ticket stays free — cleanup does not get to speak for the verdict");
  assert.equal(JSON.parse(r.stdout).taken, false, "and the payload the caller reads agrees with the code");
  assert.match(r.stderr, /could not remove .*\/cap\./,
    "the removal that failed is said out loud rather than swallowed");
});
