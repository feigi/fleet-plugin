// Regression gate for the no-CI portability fix (#111): a repo with no
// workflow file must get its own `no-ci` verdict rather than sharing exit 2
// with "the question could not be answered", the workflow file must be
// discovered by the workflow's `name:` rather than assumed to be
// `.github/workflows/ci.yml`, and absence must never silently pass — only
// `--declare-no-ci` flips the gate.
//
// `gh` is stubbed on PATH and logs every call it receives, so a test can
// assert `run list`/`run view` were never reached under no-ci — the point of
// skipping them (#262's REST budget) is unverifiable without that log. `git`
// is real, and the repo fixture IS `git init`-ed: discovery anchors itself to
// `git rev-parse --show-toplevel`, so a non-repo fixture would exit 2 before
// reaching any of this. No `origin` is added, so `git remote get-url origin`
// still fails on its own and the behind-count block degrades to `null`,
// exactly the path it already has a contract for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, statSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments.mjs";

const SCRIPT = fileURLToPath(new URL("./ci-state.mjs", import.meta.url));

// A `gh` failure carries a MESSAGE, not just an exit code, and the cause a
// caller can act on lives only in that message. `$GH_FAIL_MSG` is how a test
// picks which cause this stub refuses with; empty — the default every fixture
// above already relies on — keeps the bare `exit 1` with a silent stderr.
const GH_STUB = `#!/bin/sh
echo "$*" >> "$GH_LOG"
fail() { [ -n "$GH_FAIL_MSG" ] && echo "$GH_FAIL_MSG" >&2; exit 1; }
case "$1 $2" in
  "pr view") [ -f "$PR_VIEW_FILE" ] && cat "$PR_VIEW_FILE" || fail ;;
  "run list") [ -f "$RUN_LIST_FILE" ] && cat "$RUN_LIST_FILE" || fail ;;
  "run view") [ -f "$RUN_VIEW_FILE" ] && cat "$RUN_VIEW_FILE" || fail ;;
  "repo view") [ -f "$REPO_VIEW_FILE" ] && cat "$REPO_VIEW_FILE" || fail ;;
  *) fail ;;
esac
`;

const PR_HEAD = "abc123def";
const BRANCH = "fix/1";
const PR_VIEW = JSON.stringify({
  headRefName: BRANCH,
  headRefOid: PR_HEAD,
  state: "OPEN",
  mergeStateStatus: "CLEAN",
});
const RUN_LIST = JSON.stringify([
  { databaseId: 1, headSha: PR_HEAD, status: "completed", conclusion: "success", event: "pull_request", createdAt: "2026-01-01T00:00:00Z" },
]);
const RUN_VIEW = JSON.stringify({
  jobs: [{ name: "check", status: "completed", conclusion: "success" }],
  attempt: 1,
  status: "completed",
  conclusion: "success",
  headSha: PR_HEAD,
});

// repoFiles: { "relative/path": "content" }, written under a fresh cwd.
// unreadable: repo-relative files OR directories chmod'ed 0o000 for the run and
// restored after, so a permission probe cannot leave an undeletable tmpdir.
// cwd: repo-relative directory to run from, for the repo-root anchoring test.
// git: `false` leaves the fixture outside any repo, for the routes that have to
// answer without a repo root.
// pr: the `--pr` value, defaulting to the digits every other fixture wants;
// `null` omits the flag entirely, for the tests that probe how the argument
// itself is refused rather than what it selects.
// gh responses default to the green fixtures above; pass `null` to make that gh
// subcommand fail (exit 1) if reached, so an unexpected call surfaces as a
// crash rather than silently serving the wrong fixture.
function run(args, { repoFiles = {}, unreadable = [], cwd = ".", pr = "42", prView = PR_VIEW, runList = RUN_LIST, runView = RUN_VIEW, ghFailMsg = "", tolerateUnparsedStdout = false, readOnlyStdout = false, git = true, origin = null, repoView = null, spawnEnv = {} } = {}) {
  const repoDir = mkdtempSync(join(tmpdir(), "ci-state-repo-"));
  // Discovery resolves `.github/workflows` off `git rev-parse --show-toplevel`,
  // never the cwd, so a fixture that reaches discovery has to be a real repo.
  // No remote is added by default: the behind-count block still degrades to
  // null as before. `origin` opts a fixture in, for the behind-count block's
  // own tests.
  if (git) spawnSync("git", ["init", "-q", repoDir], { stdio: "ignore" });
  if (origin !== null) spawnSync("git", ["remote", "add", "origin", origin], { cwd: repoDir, stdio: "ignore" });
  const binDir = mkdtempSync(join(tmpdir(), "ci-state-bin-"));
  for (const [rel, content] of Object.entries(repoFiles)) {
    const full = join(repoDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(join(repoDir, cwd), { recursive: true });
  const gh = join(binDir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const ghLog = join(binDir, "gh.log");
  writeFileSync(ghLog, "");

  const fixtureFile = (name, content) => {
    if (content === null) return "";
    const p = join(binDir, name);
    writeFileSync(p, content);
    return p;
  };
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    GH_LOG: ghLog,
    GH_FAIL_MSG: ghFailMsg,
    PR_VIEW_FILE: fixtureFile("pr-view.json", prView),
    RUN_LIST_FILE: fixtureFile("run-list.json", runList),
    RUN_VIEW_FILE: fixtureFile("run-view.json", runView),
    REPO_VIEW_FILE: fixtureFile("repo-view.json", repoView),
    // Last, so a test can deliberately put back a var #1599's scrub in
    // tryRun() removes — that is the whole point of the ambient GIT_DIR/
    // GIT_WORK_TREE tests below.
    ...spawnEnv,
  };
  const restore = [];
  for (const rel of unreadable) {
    const full = join(repoDir, rel);
    restore.push([full, statSync(full).mode & 0o777]);
    chmodSync(full, 0o000);
  }
  // readOnlyStdout: hand the child a stdout it cannot write to, so its first
  // write fails with EBADF rather than by racing a reader. CLOSING fd 1 does
  // not do it — libuv reopens a closed standard fd onto /dev/null and the write
  // then succeeds (measured), which is why this opens /dev/null read-only and
  // passes that fd instead. spawnSync then reports no stdout for the child at
  // all, so the eager parse below has nothing to read and skips.
  const roStdout = readOnlyStdout ? openSync("/dev/null", "r") : null;
  let r;
  try {
    // maxBuffer: spawnSync's default 1 MiB kills the child mid-write once its
    // output passes it, and the pipe-survival fixtures below write past it on
    // purpose.
    r = spawnSync(process.execPath, [SCRIPT, ...(pr === null ? [] : ["--pr", pr]), ...args], {
      cwd: join(repoDir, cwd),
      encoding: "utf8",
      env,
      maxBuffer: 8 * 1024 * 1024,
      ...(roStdout === null ? {} : { stdio: ["ignore", roStdout, "pipe"] }),
    });
  } finally {
    if (roStdout !== null) closeSync(roStdout);
    for (const [full, mode] of restore.reverse()) chmodSync(full, mode);
  }
  const log = readFileSync(ghLog, "utf8");
  // Parsing eagerly is what lets every other test assert straight off `payload`,
  // and a parse failure throwing here is the right default: it names a malformed
  // payload at the test that produced it. The pipe-survival tests are the one
  // exception — unparsed stdout is precisely their subject, so they opt out and
  // assert on the raw bytes themselves.
  let payload = null;
  if (r.stdout && r.stdout.trim()) {
    try {
      payload = JSON.parse(r.stdout.trim().split("\n").pop());
    } catch (e) {
      if (!tolerateUnparsedStdout) throw e;
    }
  }
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  return { ...r, payload, log };
}

const CI_WORKFLOW = `name: CI
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
const OTHER_WORKFLOW = `name: Release Label
on: [push]
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

test("no .github/workflows directory: no-ci verdict, exit 1, never reads run list/view", () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "no-ci");
  assert.equal(r.payload.reasons.length, 1);
  assert.match(r.payload.reasons[0], /declare-no-ci/);
  assert.doesNotMatch(r.log, /run list/);
  assert.doesNotMatch(r.log, /run view/);
});

test("no CI + --declare-no-ci: still no-ci verdict, but gate satisfied — exit 0", () => {
  const r = run(["--declare-no-ci"]);
  assert.equal(r.status, 0);
  assert.equal(r.payload.verdict, "no-ci");
  assert.match(r.payload.reasons[0], /gating on the caller's verified suite run/);
});

test("workflow file discovered by name, not the hard-coded ci.yml path — repo behaviour unchanged", () => {
  const r = run([], {
    repoFiles: {
      ".github/workflows/pipeline.yml": CI_WORKFLOW, // not named ci.yml
      ".github/workflows/release-label.yml": OTHER_WORKFLOW, // sibling, different name — must not confuse discovery
    },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
  assert.deepEqual(r.payload.reasons, []);
});

test("two workflow files share the target name: ambiguous, dies (exit 2) rather than guessing", () => {
  const r = run([], {
    repoFiles: {
      ".github/workflows/a.yml": CI_WORKFLOW,
      ".github/workflows/b.yml": CI_WORKFLOW,
    },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pass --workflow-file to pick one/);
});

// Both routes to an unreadable workflow file refuse with exit 2, and they
// refuse at different depths: discovery opens each candidate as it scans, while
// an explicit --workflow-file target is not read until expectedJobs(). Kept as
// two cases because that difference is the point — a fix that closes only the
// scan leaves the explicit route reading the file as absent, and absent is the
// one shape that can be declared away as no-ci.
//
// The explicit route also runs OUTSIDE a repo — the second discrimination these
// two cases carry. Naming the file answers the question without a repo root, so
// a root lookup made eager again refuses a caller who never asked for
// discovery, and nothing else in this file runs the script from a non-repo cwd.
// The refusal is asserted down to its errno because `cannot read` alone is also
// what a path that never existed produces: drift between the argument and the
// fixture would leave this case pinning absence, the shape above.
for (const [route, args, opts] of [
  ["the discovery scan", [], {}],
  ["an explicit --workflow-file", ["--workflow-file", ".github/workflows/ci.yml"], { git: false }],
]) {
  test(`an unreadable workflow file reached through ${route}: exit 2, never no-ci`, (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads every file");
    const r = run(args, {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      unreadable: [".github/workflows/ci.yml"],
      ...opts,
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read [^\n]*: EACCES: permission denied/);
  });
}

// --- Error policy (#111): only a genuinely absent workflow set is `no-ci` ---
// The verdict must be reachable one way only: `.github/workflows/` absent, or
// present and holding no workflow files. Every other outcome — the directory
// unreadable, the target unreadable, files present under other names — is exit
// 2, "the question could not be answered", and `--declare-no-ci` must not
// convert any of them to exit 0. The four tests below pin one branch each,
// because the first review of this file reached merge with two of them wrong.

const CI_WORKFLOW_COMMENTED = CI_WORKFLOW.replace("name: CI", `name: "CI"  # main pipeline`);

test("unreadable .github/workflows directory: exit 2, never no-ci — --declare-no-ci cannot wave it through", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  for (const args of [[], ["--declare-no-ci"]]) {
    // Same repo, same real CI: only the directory's mode differs. Reading this
    // as no-ci reported "no CI configured" for a repo whose run was `failure`.
    const r = run(args, {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      unreadable: [".github/workflows"],
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read/);
    assert.equal(r.payload, null);
  }
});

test("workflow name with a trailing YAML comment (and quotes) still matches — a configured repo never reads as no-ci", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW_COMMENTED } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
});

test("workflow files present but none named CI: exit 2 naming them, never a declarable no-ci", () => {
  for (const args of [[], ["--declare-no-ci"]]) {
    const r = run(args, {
      repoFiles: {
        ".github/workflows/release-label.yml": OTHER_WORKFLOW,
        ".github/workflows/release.yml": OTHER_WORKFLOW.replace("Release Label", "Release"),
      },
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /none named 'CI'/);
    assert.match(r.stderr, /release-label\.yml/);
    // The false statement this replaced: "no workflows configured under
    // .github/workflows/" said of a directory full of workflows.
    assert.doesNotMatch(r.stderr, /no workflows configured/);
  }
});

test("an unreadable irrelevant sibling does not blind discovery to a readable target", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  const r = run([], {
    repoFiles: {
      ".github/workflows/ci.yml": CI_WORKFLOW,
      ".github/workflows/zz-other.yml": OTHER_WORKFLOW,
    },
    unreadable: [".github/workflows/zz-other.yml"],
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
});

test("discovery is anchored to the repo root, not the cwd — a subdirectory answers the same", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    cwd: "scripts",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
});

// #1599: tryRun()'s single spawn primitive (used for both this script's git
// AND gh calls) passed no env at all before this fix, and #1020's own census
// could not see either of its two git call sites — its scan is `.sh`-only.
// Measured directly: an ambient GIT_DIR or GIT_WORK_TREE (a git hook,
// `rebase --exec`, `bisect run`) corrupts each call in its own distinct way,
// silently, at exit 0.
test("workflowsPath()'s rev-parse: an inherited GIT_WORK_TREE must not substitute a foreign toplevel for the caller's own repo root", () => {
  const other = mkdtempSync(join(tmpdir(), "ci-state-other-"));
  spawnSync("git", ["init", "-q", other], { stdio: "ignore" });
  try {
    const r = run([], {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      // A subdirectory, the realistic shape: workflowsPath() never receives
      // a repo root as an argument, it derives one from wherever the process
      // happens to be running — measured, unscrubbed, an ambient
      // GIT_WORK_TREE answers `--show-toplevel` with the AMBIENT path
      // outright regardless of the real cwd, which then sends discovery
      // looking for `.github/workflows` in a directory that is not this
      // repository at all.
      cwd: "scripts",
      spawnEnv: { GIT_WORK_TREE: other },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.payload.verdict, "green",
      "an ambient GIT_WORK_TREE must not relocate workflow discovery into a foreign directory that has no .github/workflows");
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("the behind-count probe: an inherited GIT_DIR must not bind gh's --hostname to another repository's origin", () => {
  // The real repository's own origin, and the OTHER (ambient) repository's —
  // deliberately different hosts, so the logged `--hostname` argument tells
  // the two apart unambiguously. `gh repo view` is stubbed to answer for the
  // real repository regardless (it consults no git state at all), so the
  // only way the wrong host can reach the logged `gh api` call is through
  // `git remote get-url origin` answering for the ambient repository instead
  // of the real one — measured, unscrubbed, that is exactly what an ambient
  // GIT_DIR does.
  const other = mkdtempSync(join(tmpdir(), "ci-state-other-"));
  spawnSync("git", ["init", "-q", other], { stdio: "ignore" });
  spawnSync("git", ["remote", "add", "origin", "https://ghe-other.example/other/other-repo.git"], { cwd: other, stdio: "ignore" });
  try {
    const r = run([], {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      origin: "https://ghe-real.example/acme/real-repo.git",
      repoView: JSON.stringify({ nameWithOwner: "acme/real-repo" }),
      spawnEnv: { GIT_DIR: join(other, ".git") },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.log, /api --hostname ghe-real\.example /,
      "an ambient GIT_DIR must not substitute the OTHER repository's origin host for this repository's own");
    assert.doesNotMatch(r.log, /ghe-other\.example/,
      `the ambient repository's host must never reach gh at all, and the log reads: ${r.log}`);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

// expectedJobs() refuses on the assumption its derivation rests on, and that
// refusal has to land before the run query — the answer it would otherwise
// spend a REST read on is one it has already decided it cannot give. Nothing
// else in this file reaches the derivation's die() at all, so the gh log is
// what pins the order rather than the refusal alone.
const CI_WORKFLOW_NAMED_JOB = CI_WORKFLOW.replace("  check:\n", "  check:\n    name: Check\n");

test("an invalid job derivation refuses before the run list is ever requested", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW_NAMED_JOB } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /derivation invalid/);
  assert.doesNotMatch(r.log, /run list/, `the derivation must refuse before the query, and gh was asked: ${r.log}`);
});

// --- The not-green detectors, one negative case each ------------------------
// No fixture above enters the `reasons.push` branches in the `else` arm, so
// none of them can catch one being deleted — and each such deletion is a silent
// false green reaching board.mjs's mapCi() and the merge bot's gate.

const TWO_JOB_WORKFLOW = `name: CI
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  integration:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

const notGreen = (overrides, repoFiles = { ".github/workflows/ci.yml": CI_WORKFLOW }) =>
  run([], { repoFiles, runView: JSON.stringify({ ...JSON.parse(RUN_VIEW), ...overrides }) });

test("run bound to another commit: not-green, exit 1 — the cancelled-run-on-a-superseded-SHA case", () => {
  const r = notGreen({ headSha: "0000000" });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /run headSha 0000000 != PR head abc123def/);
});

test("run still in progress: not-green, exit 1 — an incomplete run is not a pass", () => {
  const r = notGreen({ status: "in_progress" });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /run status is in_progress, not completed/);
});

test("expected job absent from the run: not-green, exit 1 — an absent job reads as pending, never as green", () => {
  const r = notGreen({}, { ".github/workflows/ci.yml": TWO_JOB_WORKFLOW });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /expected jobs absent from the run: integration/);
});

test("`skipped` is not `passed`: a skipped job is not-green, exit 1", () => {
  const r = notGreen({ jobs: [{ name: "check", status: "completed", conclusion: "skipped" }] });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /job check is skipped, not success/);
});

// gh's REAL shape for an in-progress job is conclusion:"" (empty string),
// never null — the same shape #1566 fixed in rank()'s tie-break. `??`
// only falls through on null/undefined, so `j.conclusion ?? j.status`
// would print the unreadable "job check is , not success" instead of
// naming the job's actual status.
test("in-progress job (conclusion \"\") not success: reason names the status, not an empty string", () => {
  const r = notGreen({ jobs: [{ name: "check", status: "in_progress", conclusion: "" }] });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /job check is in_progress, not success/);
});

// The fifth reasons.push site in this arm — the one the "one negative case
// each" comment above missed (#930). It fires before notGreen's override even
// applies: matching.length === 0 short-circuits past the run-view read
// entirely, so this needs the run LIST overridden, not the run VIEW —
// notGreen only overrides the latter and cannot reach this branch at all.
test("no run in the list matches the PR head at all: not-green, exit 1 — the unbound-PR case", () => {
  const [current] = JSON.parse(RUN_LIST);
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([{ ...current, headSha: "0000000" }]),
  });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /no CI run whose headSha equals the PR head abc123def/);
});

// --- #1410: two runs tied on head SHA AND createdAt to the second ----------
// A stable sort with no tie-break keeps gh's own (unspecified) API order on
// an exact createdAt tie. Measured live on PR #1402: two runs on the same
// head, started the same second, one cancelled and one completed, both 6
// jobs green — the tool bound to the cancelled duplicate. Recency (createdAt,
// truncated to the second) stays the PRIMARY key; conclusion only breaks a
// tie, so a newer in-progress run on an unrelated pair still beats an older
// completed one (see the untied-path test below) — promoting conclusion to
// primary would be a fresh regression, not a fix.
//
// Fixtures use gh's REAL run shape: a cancelled run reports
// status:"completed", conclusion:"cancelled" — its LIFECYCLE (status) is
// "completed", same as a successful run; only its OUTCOME (conclusion)
// differs. A comparator ranking on status alone (an earlier draft of this
// fix did exactly that) can never tell them apart, since both share
// status:"completed" — the original #1402 bug would stay unfixed for real
// GitHub data.

test("two runs share head SHA and createdAt to the second, one cancelled one completed: the completed run wins and a tie-break note reaches stderr — PR #1402, cancelled listed first", () => {
  const createdAt = "2026-03-01T10:00:00Z";
  const cancelled = { databaseId: 2, headSha: PR_HEAD, status: "completed", conclusion: "cancelled", event: "pull_request", createdAt };
  const completed = { databaseId: 1, headSha: PR_HEAD, status: "completed", conclusion: "success", event: "pull_request", createdAt };
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    // Cancelled listed FIRST: with no tie-break, a stable sort on an exact
    // createdAt tie keeps this API order and picks it — the exact shape
    // measured on PR #1402.
    runList: JSON.stringify([cancelled, completed]),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
  assert.equal(r.payload.runId, completed.databaseId, "must bind to the completed run, not the cancelled sibling sharing its head and createdAt");
  assert.match(r.log, new RegExp(`run view ${completed.databaseId}\\b`));
  assert.match(r.stderr, new RegExp(`run selection tie-break.*chose #${completed.databaseId} \\(completed/success\\) over #${cancelled.databaseId} \\(completed/cancelled\\)`));
});

test("two runs share head SHA and createdAt to the second, one cancelled one completed: the completed run wins regardless of array order — mirrored order", () => {
  const createdAt = "2026-03-01T10:00:00Z";
  const cancelled = { databaseId: 2, headSha: PR_HEAD, status: "completed", conclusion: "cancelled", event: "pull_request", createdAt };
  const completed = { databaseId: 1, headSha: PR_HEAD, status: "completed", conclusion: "success", event: "pull_request", createdAt };
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    // Completed listed FIRST this time. A stable sort would already pick it
    // by accident in this order alone, so this test never proves the
    // comparator does anything by itself — it only proves the reversed-order
    // test above isn't vacuously passing because of array order.
    runList: JSON.stringify([completed, cancelled]),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
  assert.equal(r.payload.runId, completed.databaseId, "must bind to the completed run regardless of gh's response order");
});

test("two runs share head SHA, createdAt to the second, and conclusion rank: the numerically higher databaseId wins, not the lexicographically greater one", () => {
  const createdAt = "2026-03-01T10:00:00Z";
  // databaseId 9 and 10: "9" sorts ahead of "10" under a STRING compare
  // (localeCompare), backwards from the numerically higher/newer id. Listed
  // with the lexicographically-winning id first so a lingering string
  // compare would pick it by accident too.
  const lowerId = { databaseId: 9, headSha: PR_HEAD, status: "completed", conclusion: "success", event: "pull_request", createdAt };
  const higherId = { databaseId: 10, headSha: PR_HEAD, status: "completed", conclusion: "success", event: "pull_request", createdAt };
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([lowerId, higherId]),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
  assert.equal(r.payload.runId, higherId.databaseId, "the numerically higher databaseId must win the final tie-break, not the lexicographically greater one");
  assert.match(r.stderr, new RegExp(`run selection tie-break.*chose #${higherId.databaseId} \\(completed/success\\) over #${lowerId.databaseId} \\(completed/success\\)`));
});

test("two runs' createdAt differs only in the fractional-second component: still treated as a tie, not two distinct instants", () => {
  // GitHub's createdAt is documented as whole-second precision, but the
  // comparator truncates via bySecond() defensively. If the comparator
  // instead compared full-precision strings, these two would never be
  // grouped as tied — the cancelled run's fractionally-LATER createdAt would
  // win on recency alone, and conclusion would never even be consulted.
  const cancelled = { databaseId: 2, headSha: PR_HEAD, status: "completed", conclusion: "cancelled", event: "pull_request", createdAt: "2026-03-01T10:00:00.900Z" };
  const completed = { databaseId: 1, headSha: PR_HEAD, status: "completed", conclusion: "success", event: "pull_request", createdAt: "2026-03-01T10:00:00.100Z" };
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([cancelled, completed]),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
  assert.equal(r.payload.runId, completed.databaseId, "sub-second createdAt drift must not hide a genuine tie; conclusion still decides");
  assert.match(r.stderr, /run selection tie-break/);
});

test("untied path: a newer non-completed run still beats an older completed one on the same head — conclusion never outranks recency", () => {
  const older = { databaseId: 5, headSha: PR_HEAD, status: "completed", conclusion: "success", event: "pull_request", createdAt: "2026-01-01T00:00:00Z" };
  const newer = { databaseId: 6, headSha: PR_HEAD, status: "in_progress", conclusion: null, event: "pull_request", createdAt: "2026-01-02T00:00:00Z" };
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([older, newer]),
    runView: JSON.stringify({ jobs: [{ name: "check", status: "in_progress", conclusion: null }], attempt: 1, status: "in_progress", conclusion: null, headSha: PR_HEAD }),
  });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.equal(r.payload.runId, newer.databaseId, "recency stays primary: a newer in-progress run must still beat an older completed one when createdAt is NOT tied");
  assert.doesNotMatch(r.stderr, /run selection tie-break/, "createdAt differs here, so no tie-break note should fire");
});

// --- #1566: rank()'s middle tier must match live gh data --------------------
// `gh run list --json conclusion` reports an empty string `""` for a
// non-completed run, never `null`. An earlier version of rank()'s middle
// tier required `r.conclusion === null`, so it silently never matched real
// data and a still-running run fell into the SAME bottom tier as a
// failed/cancelled one, losing an exact-createdAt tie it should win.
test("two runs share head SHA and createdAt to the second, one in-progress (conclusion \"\") one cancelled: the in-progress run wins the tie-break, not the cancelled one", () => {
  const createdAt = "2026-03-01T10:00:00Z";
  // In-progress listed with the LOWER databaseId: under the pre-fix bug both
  // runs fall to the bottom tier (conclusion:"" never matches `=== null`),
  // so the final databaseId tie-break picks the cancelled run (higher id) —
  // the wrong winner. Only the fixed middle tier makes the in-progress run
  // win despite its lower id.
  const inProgress = { databaseId: 1, headSha: PR_HEAD, status: "in_progress", conclusion: "", event: "pull_request", createdAt };
  const cancelled = { databaseId: 2, headSha: PR_HEAD, status: "completed", conclusion: "cancelled", event: "pull_request", createdAt };
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([cancelled, inProgress]),
    runView: JSON.stringify({ jobs: [{ name: "check", status: "in_progress", conclusion: "" }], attempt: 1, status: "in_progress", conclusion: "", headSha: PR_HEAD }),
  });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.equal(r.payload.runId, inProgress.databaseId, "still-running (conclusion \"\") must outrank a settled cancelled run in the tie-break, not lose to it on databaseId");
  assert.match(r.stderr, new RegExp(`run selection tie-break.*chose #${inProgress.databaseId} \\(in_progress/\\) over #${cancelled.databaseId} \\(completed/cancelled\\)`));
});

// --- #169: a flag given with no value must die, never read as absent -------
// `base`/`workflow`/`workflow-file` all read via `arg(name) || default`, so a
// trailing flag previously fell straight through to the DEFAULT — the caller
// asked to gate on a specific base/workflow and silently got a real verdict
// against the wrong one instead of a refusal. Pinned as the priority site
// (feigi's PR #167 review comment): `ci-state.mjs --pr 5 --base` used to
// compare against `main` with no signal anything was wrong.

test("trailing --base (no value) dies (exit 2) rather than silently comparing against the default base", () => {
  const r = run(["--base"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base needs a value/);
  assert.doesNotMatch(r.log, /pr view/, "must die before ever asking gh anything");
});

test("--workflow=CI form dies by name, not silently read as absent (indexOf cannot see it)", () => {
  const r = run(["--workflow=CI"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--workflow needs a space-separated value/);
});

// #364: has() used exact argv.includes, so a boolean flag written --name=value
// (in ANY form the value takes) silently read as absent — dropping the
// caller's declared no-CI opt-out with no signal. The wording has to say
// "boolean flag", distinct from arg()'s "needs a space-separated value" above:
// a boolean has no value to give in the first place.
for (const flag of ["declare-no-ci", "quiet"]) {
  for (const v of ["=true", "=false", "="]) {
    test(`--${flag}${v} dies as a boolean flag, never silently read as absent`, () => {
      const r = run([`--${flag}${v}`]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, new RegExp(`--${flag} is a boolean flag, not --${flag}=`));
      assert.doesNotMatch(r.log, /pr view/, "must die before ever asking gh anything");
    });
  }
}

// Position, not just spelling — and run()'s fixed `--pr 42` prepend does NOT
// supply it: a fixed prepend gives a FIXED offset, so all six cases in the
// loop above land their flag at process.argv[4] and a guard narrowed to that
// one index passes every one of them. Robustness needs the flag at DIFFERENT offsets across
// cases (#462 review); this is the only case that supplies one. --declare-no-ci
// is the flag worth spending it on: read as absent, it drops the caller's
// opt-out and the gate answers on a suite nobody ran.
test("--declare-no-ci=true dies behind another flag too, not only at the front of argv", () => {
  const r = run(["--quiet", "--declare-no-ci=true"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--declare-no-ci is a boolean flag, not --declare-no-ci=/);
  assert.doesNotMatch(r.log, /pr view/, "must die before ever asking gh anything");
});

// The control: the new `=` guard must not touch the bare spelling. --quiet's
// STDERR effect is what pins it here (--declare-no-ci's bare form is already
// pinned above, by its effect on verdict/exit code): vlog's command echoes
// vanish from stderr, though the same gh calls still ran (r.log is written by
// the stub itself, unconditionally). Its PAYLOAD effect is the next test's.
test("--quiet still reads as present in its bare spelling — the = refusal is not a blanket one", () => {
  const loud = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } });
  assert.equal(loud.status, 0, loud.stdout + loud.stderr);
  assert.match(loud.stderr, /\$ gh pr view/);

  const quiet = run(["--quiet"], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } });
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /\$ gh pr view/);
  assert.match(quiet.log, /pr view/, "gh still ran despite the quieter stderr");
});

// #677. The other half of what `--quiet` does, and the half the flag exists for:
// `jobs` and `missing` leave the JSON payload with it and are present without
// it. Same fixture both ways, so the flag is the only difference. The field
// names are spelled out rather than derived from ci-state.mjs — deriving them
// from the assignment under test would make this pass vacuously if that
// assignment changed, which is the one thing it must not do. The deriving is
// `quiet-payload-prose.test.mjs`'s job, over the prose that has to agree.
test("--quiet drops `jobs` and `missing` from the payload; without it they are there", () => {
  const opts = { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } };
  const loud = run([], opts);
  const quiet = run(["--quiet"], opts);
  assert.equal(loud.status, 0, loud.stdout + loud.stderr);
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  for (const field of ["jobs", "missing"]) {
    assert.ok(field in loud.payload, `without --quiet the payload must carry \`${field}\`, and it reads ${JSON.stringify(loud.payload)}`);
    assert.ok(!(field in quiet.payload), `--quiet must drop \`${field}\` from the payload, and it reads ${JSON.stringify(quiet.payload)}`);
  }
});

test("trailing --pr (no value, the entry flag itself) still dies naming the flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--pr"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pr needs a value/);
});

// The other two branches of the same guard: a flag eating the NEXT FLAG as its
// value, and an explicit whitespace-only value. Deleting either clause from
// arg() left this suite 18/18 green before these two existed.
test("--base followed by another flag is rejected, not read as the string \"--workflow\"", () => {
  const r = run(["--base", "--workflow", "CI"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base needs a value/);
  assert.doesNotMatch(r.log, /pr view/, "must die before ever asking gh anything");
});

// #463 fallout: `--workflow-file` is the one flag this file used to read below
// its guards, in discoverWorkflowFile()'s caller. With the read there, this
// invocation refused with `unexpected argument 'main'` — --base's innocent
// value — instead of naming the flag given wrong (measured). The read is a
// statement above sweep() for that reason; putting it back reds this.
test("trailing --workflow-file names --workflow-file, not the innocent value of the flag behind it", () => {
  const r = run(["--workflow-file", "--base", "main"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--workflow-file needs a value/);
  assert.doesNotMatch(r.log, /pr view/, "must die before ever asking gh anything");
});

test("--base given a whitespace-only value dies rather than comparing against the default base", () => {
  const r = run(["--base", "   "]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base needs a value/);
});

// --- #269: parsing a gh reply is not the same as it being the right shape --
// A reply that parses cleanly but is the wrong shape (an error object where
// an array is expected, a run view missing its jobs) previously flowed on
// unchecked until the first dereference threw — and an uncaught throw exits
// 1, this script's code for "not bound-green". Each case below pins the
// class: exit 2, naming the query and the field, before the crash site is
// ever reached. #232's caution is why the row-level cases exist too — a
// guard that checks the array but not its elements is itself a partial
// guard, and jobs/runs rows are read (`j.name`, `r.headSha`) unguarded.

// Every assertion in this section is about the REFUSAL LINE, not about stderr
// as a whole: the diagnostic stream echoes each gh command before running it,
// and that echo carries `pr view`, `run view` and every field name in the
// `--json` list — `$ gh pr view 42 --json headRefName,headRefOid,state,...`
// (measured). `assert.match(r.stderr, /headRefName/)` is therefore satisfied
// by a refusal that names nothing at all, which leaves the exit status as the
// only load-bearing half of such a case. Asserting on the line itself is what
// makes the field name — and, for #926, what the line says gh actually SENT —
// load-bearing.
const refusal = (r) => r.stderr.split("\n").find((l) => l.includes("not the expected shape")) ?? "";

// #926. Each of these guards covers three distinct faults — the key absent,
// the value an empty string, the value not a string — and "missing <field>"
// asserted absence for all of them: measured, `{"headRefName":""}`,
// `{"headRefName":42}` and the key omitted printed one identical line, so a
// reader hunted for a key gh had in fact returned as `""`, `42` or `null`.
// Each row pins its own fault's rendering AND that the line does not tell
// another fault's story: a present value is never reported as an absent key,
// and an absent key never quotes a value nothing sent.
//
// The clause-level reachability these rows also carry: an empty string
// satisfies the type check and a number satisfies the emptiness check, so
// those rows are what keep each clause from being deletable. The absent rows
// are refused by both clauses at once and so pin neither — they are here for
// what the line SAYS, which is this ticket. What a lost clause costs is the
// field flowing on: `branch` becomes the empty string or a number and
// `gh run list --branch` asks for the wrong branch, while `prHead` becomes a
// value no run's headSha can equal, which reads as the superseded-SHA case
// rather than as a reply that could not be trusted.
for (const [what, field, prFields, saw, notSaw] of [
  ["an absent branch name", "headRefName", { headRefOid: PR_HEAD }, /the key is absent/, /got /],
  ["an empty branch name", "headRefName", { headRefName: "", headRefOid: PR_HEAD }, /got ""/, /absent/],
  ["a non-string branch name", "headRefName", { headRefName: 42, headRefOid: PR_HEAD }, /got 42/, /absent/],
  ["a null branch name", "headRefName", { headRefName: null, headRefOid: PR_HEAD }, /got null/, /absent/],
  ["an absent head sha", "headRefOid", { headRefName: BRANCH }, /the key is absent/, /got /],
  ["an empty head sha", "headRefOid", { headRefName: BRANCH, headRefOid: "" }, /got ""/, /absent/],
  ["a non-string head sha", "headRefOid", { headRefName: BRANCH, headRefOid: 42 }, /got 42/, /absent/],
  ["a null head sha", "headRefOid", { headRefName: BRANCH, headRefOid: null }, /got null/, /absent/],
]) {
  test(`PR info carrying ${what}: exit 2 naming the field and what gh sent, never a verdict built on it`, () => {
    const r = run([], {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      prView: JSON.stringify({ state: "OPEN", mergeStateStatus: "CLEAN", ...prFields }),
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /pr view/);
    assert.match(refusal(r), new RegExp(field));
    assert.match(refusal(r), saw);
    assert.doesNotMatch(refusal(r), notSaw);
    assert.doesNotMatch(r.log, /run list/, "must die before ever asking gh for runs");
  });
}

test("run list returns an error object, not an array: exit 2, never the crash from runs.filter", () => {
  // The ticket's own reproduction: gh exits 0 printing an error body where
  // --json databaseId,headSha,... normally produces an array.
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify({ error: "rate limited" }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /run list/);
  assert.match(r.stderr, /expected an array of runs/);
});

test("run list row is null: exit 2, never the crash reading r.headSha off null", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([null]),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /run list row 0 is not an object/);
});

// The same #926 split at the run-view guard, whose faults are two rather than
// three: the `jobs` key absent, and a `jobs` present but not an array.
// "missing jobs array" asserted the first for both of them (measured), and the
// second is the shape an error body or a partial run view takes — the value is
// right there to be quoted. `absent` stays a row of its own because it is the
// shape this guard was added for: it is the only thing between a missing key
// and `view.jobs.map(...)`, and an uncaught throw there exits 1 — "could not
// be read" rendered as a CI verdict, the whole #269 class.
for (const [what, runFields, saw, notSaw] of [
  ["absent", {}, /the key is absent/, /got /],
  ["an error object", { jobs: { error: "rate limited" } }, /got \{"error":"rate limited"\}/, /absent/],
  ["a string", { jobs: "none" }, /got "none"/, /absent/],
  ["null", { jobs: null }, /got null/, /absent/],
]) {
  test(`run view whose jobs is ${what}: exit 2 naming the field and what gh sent, never read as zero jobs`, () => {
    const r = run([], {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      runView: JSON.stringify({ attempt: 1, status: "completed", conclusion: "success", headSha: PR_HEAD, ...runFields }),
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(refusal(r), /run view/);
    assert.match(refusal(r), /jobs/);
    assert.match(refusal(r), saw);
    assert.doesNotMatch(refusal(r), notSaw);
  });
}

// #926's own new hazard: the value a refusal quotes is gh's, so its length is
// gh's too — a `jobs` that came back as an error body carries however much
// text that body had, onto a stderr the fleet's CI monitor polls. So it is
// cut short, and says that it was: a tail dropped with no marker reads as the
// whole value, the same class of lie "missing" was. Asserted against whether
// the value's own unbroken run survives the cut, not against the cap's
// number, so tuning the cap does not red this — a smaller cap only cuts the
// run shorter, it does not make it survive.
test("a refusal quoting an unbounded value is cut short and says that it was", () => {
  const huge = "x".repeat(400);
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runView: JSON.stringify({ jobs: { error: huge }, attempt: 1, status: "completed", conclusion: "success", headSha: PR_HEAD }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(refusal(r), /jobs/);
  assert.match(refusal(r), /\(truncated\)/);
  assert.doesNotMatch(
    refusal(r),
    /x{400}/,
    `the refusal must not carry the whole value, and it reads ${refusal(r)}`,
  );
});

// The direction this guard gets wrong on its own: what it wrongly REFUSES.
// Every jobs fixture above is malformed by construction, so none of them can
// show that the legitimate empty reply still reaches a verdict — and an empty
// `jobs` is legitimate: the guard's whole question is array-ness, a run with
// no job rows answers it, and the job-presence check below is what has an
// opinion about how many. A guard tightened from "is an array" onto
// truthiness or length would refuse it, and refusing a working invocation
// costs more than any diagnostic above gains. The verdict it must reach is
// not-green, by that job-presence check rather than by the shape check —
// which is also where the word "absent" belongs: about a job expected and
// missing from the run, never about a key gh did send.
test("run view whose jobs is an empty array is accepted — a verdict, never a shape refusal", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runView: JSON.stringify({ jobs: [], attempt: 1, status: "completed", conclusion: "success", headSha: PR_HEAD }),
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "not-green");
  assert.doesNotMatch(r.stderr, /not the expected shape/);
  assert.match(r.stderr, /expected jobs absent from the run: check/);
});

test("a job entry in the run view is null: exit 2, never the crash reading j.name off null", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runView: JSON.stringify({ jobs: [null], attempt: 1, status: "completed", conclusion: "success", headSha: PR_HEAD }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /job entry 0 is not an object/);
});

// The refusal names a POSITION, and a fixture whose malformed element sits
// first is satisfied by a guard that only answers "is one of them bad". Each
// site carries a well-formed element ahead of the bad one so the reported
// index has to be derived rather than guessed. Nothing reads the index today;
// it is the diagnostic a human gets for a reply gh really sent, so being wrong
// about which element was malformed sends them to the wrong one.
test("a run list row after a well-formed one is malformed: the refusal names that row's position", () => {
  const [current] = JSON.parse(RUN_LIST);
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([current, null]),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /run list row 1 is not an object/);
});

test("a job entry after a well-formed one is malformed: the refusal names that entry's position", () => {
  const view = JSON.parse(RUN_VIEW);
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runView: JSON.stringify({ ...view, jobs: [...view.jobs, null] }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /job entry 1 is not an object/);
});

// The direction these guards get wrong on their own: what they wrongly REFUSE.
// Every fixture above is malformed by construction, so none of them can show
// that a well-formed reply carrying more than one row still reaches a verdict
// — and more than one row is the shape gh returns for any branch with a run
// history, the normal case rather than an edge one. A guard tightened past it
// refuses a working invocation, which costs more than the diagnostic above.
test("a run list whose rows are all well-formed still reaches a verdict, superseded rows included", () => {
  const [current] = JSON.parse(RUN_LIST);
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([
      { ...current, databaseId: 2, headSha: "0000000", createdAt: "2025-12-31T00:00:00Z" },
      current,
    ]),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
});

// isObject is the whole refusal at the row and job level, so each of its
// clauses is load-bearing alone — at both sites, which take the same two shapes
// here. Every other malformed row and job fixture in this file is `null`, which
// the null clause already refuses on its own; an array and a scalar are what
// separate the other two clauses from decoration. Both degrade quietly rather
// than crashing, which is why they need pinning: either one yields `undefined`
// for every field read off it, so the run reports runs and jobs it never saw
// instead of refusing the reply.
for (const [what, malformed] of [
  ["an array", []],
  ["a scalar", "check"],
]) {
  test(`a job entry that is ${what}: exit 2, never read as a job with no fields`, () => {
    const r = run([], {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      runView: JSON.stringify({ jobs: [malformed], attempt: 1, status: "completed", conclusion: "success", headSha: PR_HEAD }),
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /job entry 0 is not an object/);
  });

  test(`a run list row that is ${what}: exit 2, never read as a run with no fields`, () => {
    const r = run([], {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      runList: JSON.stringify([malformed]),
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /run list row 0 is not an object/);
  });
}

// The false-positive class the guard must NOT create: an in-progress job's
// `conclusion` is legitimately `null`, not a missing/wrong-shaped field. If
// the shape check validated field types instead of just object-ness, this
// well-formed reply would itself start being refused.
test("in-progress job with conclusion:null is accepted — not refused as malformed shape", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runView: JSON.stringify({
      jobs: [{ name: "check", status: "in_progress", conclusion: null }],
      attempt: 1,
      status: "in_progress",
      conclusion: null,
      headSha: PR_HEAD,
    }),
  });
  assert.equal(r.status, 1, r.stdout + r.stderr); // not-green (still running) — never exit 2
  assert.equal(r.payload.verdict, "not-green");
  assert.doesNotMatch(r.stderr, /not the expected shape/);
});

// #365's other half. The sweep refuses any `--` token not in this script's
// known set, so a name missing from that set refuses an invocation this script
// accepts — "worse than the bug" by the ticket's own words. Measured, dropping
// `base` or `workflow` reddens THIS test and nothing else; the other four names
// also redden tests above, which happen to pass them.
//
// So: every flag ci-state.mjs accepts, in ONE green run. --workflow-file is the
// one that would not otherwise be here, because its arg() call sits far below
// the sweep, next to discoverWorkflowFile — the sweep needs the NAME, and a set
// built by reading down to the first gh call would miss it.
//
// Relative to cwd on purpose: run() builds its repo in a fresh tmpdir this
// scope cannot name, and the script resolves an explicit --workflow-file
// against cwd, which run() sets to that repo.
test("every flag ci-state.mjs accepts survives the unknown-flag sweep in one invocation", () => {
  const r = run(["--base", "main", "--workflow", "CI", "--workflow-file", ".github/workflows/ci.yml", "--declare-no-ci", "--quiet"], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
  });
  assert.equal(r.status, 0, `a working invocation was refused: ${r.stderr}`);
  // Live, not subsumed by the status assertion above: the behind-count block
  // TOLERATES its children — tryRun() swallows the failure and returns null
  // while execFileSync has already forwarded the child's stderr — so a child
  // refusing a flag lands here at exit 0 with `behind` silently null. Matches
  // git's "unknown option" as well as the fleet's own "unknown flag", because
  // the tolerated children are git's: measured, a bogus flag on the `git
  // remote get-url` call is otherwise 35/35 green.
  assert.doesNotMatch(r.stderr, /unknown (flag|option)/);
  assert.equal(r.payload.verdict, "green");
});

// --- #262: a quota refusal is a distinguishable cause, not a generic failure -
// Every `gh` read failure landed on one arm that reported the exit code and
// nothing a caller could act on — an exhausted REST quota, a repo that cannot
// be resolved and a revoked token were one undifferentiated cause. The correct
// responses differ: a quota refusal recovers on its own and is worth re-probing
// shortly, the others need someone to look, so the cause is named in the
// PAYLOAD. That is where the fleet's gates read this script — `run-team`'s
// SKILL.md directs a merge bot to gate on the payload's own fields and warns
// that an empty payload, which is all this arm produced, "reads as a block, not
// a pass — the safe direction, but still a false one".
//
// No test reached this arm before: every other exit-2 case here dies in
// workflow discovery or in a shape check, never in the subprocess failure path.
// `$GH_FAIL_MSG` is what makes the two causes drivable, and the pair below is
// the point — either test alone passes a script that ignores the cause entirely.

// The quota refusal as `gh` actually words it, wrapping the REST body.
const RATE_LIMIT_STDERR =
  "couldn't fetch workflows for feigi/claude-config: HTTP 403: API rate limit exceeded for user ID 1234.";
// A failure that is NOT a quota refusal and never recovers by waiting.
const MISSING_REPO_STDERR = "could not resolve to a Repository with the name 'feigi/nope'";

const ghFailure = (ghFailMsg) =>
  run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW }, runList: null, ghFailMsg });

test("a rate-limited gh read names the quota as its cause in the payload, at the unchanged exit 2", () => {
  const r = ghFailure(RATE_LIMIT_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.payload, "a quota refusal must emit a payload — the cause is unreadable to a gate that only sees stderr");
  assert.equal(r.payload.verdict, "rate-limited");
  assert.match(r.payload.reasons.join("; "), /rate limit/i);
  // `pr` is the payload's only identifying field, and the fleet polls this
  // script for several PRs at once — an outage attributed to the wrong one, or
  // carrying a string where every other payload here carries a number, is
  // indistinguishable from a correct report at the point a caller reads it.
  // assert/strict, so this pins the type as well as the value.
  assert.equal(r.payload.pr, 42);
  // The refused query, not merely that a quota was mentioned: `pr view` is
  // GraphQL and `run list`/`run view` are REST, so which one was refused is
  // what separates an exhausted REST quota from a token or repo problem. The
  // fixture refuses `run list` — keep this literal in step with it.
  assert.match(r.payload.reasons.join("; "), /gh run list/);
});

// GitHub's older spelling of the same self-clearing secondary limit, still
// emitted by a GHE Server predating the rename. Without this the alternation in
// RATE_LIMITED is unpinned: dropping it leaves every test above green, because
// they all drive the current wording.
const LEGACY_ABUSE_STDERR =
  "HTTP 403: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.";

test("the pre-rename secondary-limit wording is read as a quota refusal too", () => {
  const r = ghFailure(LEGACY_ABUSE_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.payload, "the abuse-detection spelling is the same self-clearing limit under its old name");
  assert.equal(r.payload.verdict, "rate-limited");
});

// The bound on that alternation: `abuse` alone appears in refusals no wait
// clears, so matching the short form would tell a caller to re-probe a
// repository that has been disabled outright.
const DISABLED_REPO_STDERR =
  "HTTP 403: Repository access blocked. This repository has been disabled for abuse of GitHub's terms of service.";

test("a repository disabled for abuse is NOT a quota refusal", () => {
  const r = ghFailure(DISABLED_REPO_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.payload, null, "a permanent block must not be reported as an outage that clears on its own");
});

test("a gh read failing for any other reason reports exactly as it did before: exit 2, no payload", () => {
  const r = ghFailure(MISSING_REPO_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.payload, null, "only a quota refusal earns a payload; every other cause is unchanged");
  assert.match(r.stderr, /gh failed/);
});

// The outage payload must not be mistaken for a reading. A quota refusal is a
// probe that could not look, so it reports no CI state at all. Emitting these
// as nulls or empty arrays would let unobserved state read as observed: an
// empty `missing` says "nothing is missing", which is a reading, where an
// absent one refuses the `jq` gate run-team/SKILL.md sends a merge bot to write
// over "the payload's own fields — `verdict`, `behind`, `missing`, the per-job
// conclusions, and `prHead == runHeadSha`". That doc names the shape of the
// risk itself: "An empty payload reads as a block, not a pass."
test("the outage payload reports no CI state it could not observe", () => {
  const r = ghFailure(RATE_LIMIT_STDERR);
  for (const field of ["status", "conclusion", "jobs", "missing", "runId"]) {
    assert.ok(
      !(field in r.payload),
      `a probe that never read CI must not report \`${field}\`, and the payload reads ${JSON.stringify(r.payload)}`,
    );
  }
});

// #927: `jobs`/`missing` used to ship as `[]` on the no-ci arm too — module
// scope initialises `let jobs = []`/`let missing = []` and the no-ci branch
// never reaches the run-binding code that reassigns them, so every no-ci
// payload carried them empty. An empty `missing` is a READING — "nothing is
// missing" — and no-ci never took a reading: there was no workflow file to
// derive an expected-job set from, let alone a run to check it against.
// `emitRateLimited()` above already answers the identical "nothing was read"
// question by omitting `jobs`/`missing` rather than shipping them empty —
// covered by "the outage payload reports no CI state it could not observe"
// above, which this test does not duplicate — and this pins that the no-ci
// arm now answers it the same way.
test("a payload for a question never asked — no-ci — omits `jobs`/`missing` rather than shipping them empty", () => {
  const noCi = run([]);
  assert.equal(noCi.status, 1, noCi.stdout + noCi.stderr);
  assert.equal(noCi.payload.verdict, "no-ci");

  for (const field of ["jobs", "missing"]) {
    assert.ok(
      !(field in noCi.payload),
      `no-ci never binds a run, so \`${field}\` must be absent, not an empty array — and the payload reads ${JSON.stringify(noCi.payload)}`,
    );
  }
});

// The declared-away flip only moves the exit code (#111) — it must not start
// shipping `jobs`/`missing` back in, since `--declare-no-ci` still never binds
// a run for this script to read either field from.
test("no CI + --declare-no-ci: `jobs`/`missing` stay absent — the flag changes the gate, not what was read", () => {
  const r = run(["--declare-no-ci"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const field of ["jobs", "missing"]) {
    assert.ok(!(field in r.payload), `\`${field}\` must stay absent under --declare-no-ci too — got ${JSON.stringify(r.payload)}`);
  }
});

// #890: the same one-line/one-terminator contract the verdict payload is held to
// below, at the other call site that writes a payload to stdout. writeAll() appends
// no newline of its own, so each site supplies its own: supplying none runs this
// payload together with whatever the caller polling a rate-limited PR prints
// next, and supplying two ends the output early for a reader that treats a blank
// line as the end of it. Both were green here before this assertion — the
// quota-refusal tests above all read `payload`, and the harness parses that from
// a TRIMMED stdout, so every one of them is blind to the terminator by
// construction.
//
// Compared against a re-serialisation of the payload this very run emitted
// rather than against a literal copy of it, which is what keeps the assertion
// about the terminator alone: rewording a reason, or adding a field, changes
// both sides together and stays green, while any change to the trailing bytes
// reds. A literal would instead have to be re-typed every time the refusal text
// moved, and would red for the wrong reason when it was.
test("the rate-limited payload is emitted byte for byte too: one line, one trailing newline", () => {
  const r = ghFailure(RATE_LIMIT_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stdout, `${JSON.stringify(r.payload)}\n`);
});

// --- #840: a non-numeric --pr must refuse, never ship an unnamed payload -----
// `--pr` was validated for truthiness alone, so `--pr abc` reached both payload
// sites. Each builds `pr: Number(pr)`, and `JSON.stringify(NaN)` is `null` — the
// normal path shipped a payload with no identifying field at exit 0 under
// `verdict: "green"`, the verdict the fleet gates on.
//
// The gh receipt below is the load-bearing assertion, not decoration. Exit 2, an
// empty stdout and a matching stderr line are each reproducible by a LATER
// guard: downgrade this one to a warning and the script runs on, gh fails, and
// die() reproduces all three while the warning still sits in stderr. Only a
// refusal reached BEFORE the first query can show gh was never asked, so the
// receipt is what pins fatality and the other three merely describe the refusal.
//
// `prView: null` is what keeps that argument true, and is not tidiness. Under
// the green fixture the downgraded guard reaches a gh that ANSWERS, so the run
// gets further than the refusal it is being compared against and diverges on
// its exit code first — the assertion that reds is the status one, and the
// receipt is never what caught it. A gh that fails when reached is what makes
// exit 2, an empty stdout and a matching stderr line reproducible by the later
// guard too, leaving the receipt as the only assertion that separates them.
//
// The stub also keeps a regressed guard off this repo's live GitHub data —
// arg.test.mjs's own stubGhBin() gives the same two jobs, for the same shape of
// guard.
test("a non-numeric --pr refuses before any query, rather than reporting `pr: null`", () => {
  const r = run([], { pr: "abc", prView: null });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--pr needs a number/);
  assert.equal(r.stdout.trim(), "", `a refusal ships no payload, and stdout reads ${r.stdout}`);
  assert.equal(r.log, "", `the refusal must land before the first gh read, and gh was asked: ${r.log}`);
});

// Both anchors, separately. A guard that loses `$` still matches "42x" on its
// digit prefix, and one that loses `^` still matches "x42" on its digit suffix,
// so each value refuses only while its own anchor is present and neither mutant
// survives the pair. What a surviving mutant lets through is this block's whole
// defect back: Number("42x") is NaN, the payload's only identifying field
// serializes to null, and `gh pr view 42x` resolves the value as a BRANCH — the
// ambiguity the digits-only shape is chosen to forfeit against. Every other
// --pr this suite feeds the guard is all digits or none, and both mutants agree
// with the real guard on those.
for (const pr of ["42x", "x42"]) {
  test(`a --pr mixing digits with non-digits refuses as \`abc\` does: ${pr}`, () => {
    const r = run([], { pr, prView: null });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--pr needs a number/);
    assert.equal(r.stdout.trim(), "", `a refusal ships no payload, and stdout reads ${r.stdout}`);
    assert.equal(r.log, "", `the refusal must land before the first gh read, and gh was asked: ${r.log}`);
  });
}

// The direction a new guard gets wrong on its own: what it wrongly REFUSES. A
// suite that only feeds it invalid input pins nothing about the callers it must
// keep working. board.mjs's runCiState() sends `String(pr)` off a numeric board
// record, which is exactly the digits this harness defaults to — so a guard
// tightened past them refuses a working invocation, the outcome #365's own AC
// calls worse than the bug being fixed.
//
// assert/strict pins the TYPE as well as the value: `pr` reading back as the
// string "42" would satisfy a loose check while breaking every consumer that
// keys on a number, and reading back as `null` is the defect itself. Nothing
// else covers the normal-path payload's `pr` — the sibling assertion in the
// quota section covers the outage payload's.
test("the numeric shape board.mjs sends is accepted, and the payload names its PR", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
  assert.equal(r.payload.pr, 42);
});

// `--pr 0` is the row the `=== null` absence check exists for, and the one a
// later "simplification" back to `!pr` silently breaks: numArg() returns a
// NUMBER, so `!pr` is true for a zero the caller plainly GAVE, and this file's
// own usage die above would then answer it with "--pr is required" instead of
// letting gh answer as no such PR. Companion to arg.test.mjs's identical row
// for diff-stats.mjs and pr-overlap.mjs's own for `--a`/`--b` — #878's own
// comment names all three callers as sharing this contract, and only
// diff-stats.mjs had this row before.
//
// `strictEqual`, same reason as the "42" test above: a payload reading `pr`
// back as the string "0" would satisfy a loose check while breaking every
// consumer that keys on a number.
test("#878: `--pr 0` reaches gh rather than drawing the usage line for an absent flag", () => {
  const r = run([], { pr: "0", repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /usage:/, `--pr 0 was answered as an absent flag: ${r.stderr}`);
  assert.equal(r.payload.verdict, "green");
  assert.strictEqual(r.payload.pr, 0, `a zero PR must survive to the payload as 0: ${JSON.stringify(r.payload)}`);
});

// What the new guard's PLACEMENT could newly break. It sits below the usage die
// on purpose: RegExp.test coerces a null argument to the string "null", so a
// guard merged into that die — or hoisted above it — answers an omitted --pr
// with a complaint about a number and never prints the usage line at all. Both
// spellings exit 2, so the exit code cannot tell them apart.
test("--pr omitted still answers with the usage line, not the numeric complaint", () => {
  const r = run([], { pr: null, prView: null });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /usage: ci-state\.mjs --pr <number>/);
  assert.doesNotMatch(r.stderr, /needs a number/, "an omitted --pr is a different mistake from a malformed one");
  assert.equal(r.log, "", `a usage refusal must also precede any gh read, and gh was asked: ${r.log}`);
});

// --- The verdict payload has to survive a pipe ------------------------------
// `console.log` + `process.exit()` loses whatever is still queued: on a pipe the
// stdout write is asynchronous, the kernel accepts one buffer's worth
// synchronously, and process.exit() discards the remainder rather than draining
// it. The payload is then cut mid-JSON while the exit code arrives intact, so a
// caller that reads the code sees a normal verdict and a caller that parses
// stdout gets nothing it can use. emitRateLimited() already writes its payload
// with writeSync for this reason; these tests hold the verdict payload to the
// same standard.
//
// The mode under test is a stream the parent drains as the child writes, which
// a file is not: the same payload reaches a file fd whole and is cut on
// spawnSync's default stdio (measured), which is why these can reuse run() — a
// harness that captured stdout to a file would pass whether or not the script
// was ever fixed. That default stdio is not a FIFO but a Unix-domain SOCKET, on
// darwin and Linux alike (#1730, fstat: isSocket() on fds 1 and 2). It starts
// out blocking, and Node puts it in O_NONBLOCK once it opens a stream on it
// (Linux /proc/self/fdinfo): console.log does that to fd 1, and fd 2 has been
// through it by the time the verdict line is written, quiet or verbose.
//
// How far past "one buffer" a fixture has to reach is what that socket takes
// in ONE non-blocking write, and that is not 64 KiB everywhere. Measured for
// #1730 on 2026-09-24 with #1722's harness — a spawnSync child opens the fd's
// stream, then makes one writeSync of N bytes — 200 trials per N per fd, Linux
// being node:26-slim under Docker:
//
//   darwin  65,536 bytes, every time.
//   Linux   N up to 146,176 went through whole every time, on both fds. Past
//           it the first write took exactly 146,176 at the minimum and the
//           median of every N tried, up to 2 MiB — yet it also took the WHOLE
//           N some of the time, at every N: fd 2 took all of 146,177 38/200,
//           all of 200,000 4/200, all of 1 MiB 1/200.
//
// So Linux has a floor and no ceiling. The parent drains the socket while the
// write is still in the kernel, and a write that races a quick enough reader
// goes through whole at any size. #1722's 584,704 was the largest first write
// in its sample, not a bound.
//
// These tests used to size themselves past 65,536 alone, and on Linux that
// proved nothing. Against the regressions two of them exist to catch — the
// payload back on console.log + process.exit, the stderr line back on one bare
// writeSync — the 131,323-byte payload and 131,165-byte line they built went
// out whole 200/200 times, so on Linux both passed the very defect they are
// named for while their `> 65536` guards held. The green payload, 317,606
// bytes, caught it 198/200.
//
// What the guards compare against is that floor: a payload at or under it goes
// out in one write on Linux however the script writes it, so the test cannot
// fail there, and it covers darwin's 65,536 too. It is measured rather than
// derived from the fixture sizes below — a guard against the constant a fixture
// is built from can never fail (arg.test.mjs, #1722) — which is what lets it
// catch the fixture itself: the pre-#1730 one fails it, on darwin as well.
const LINUX_FIRST_WRITE_BYTES = 146_176;

// The fixture size is the other half, chosen from how often each regression
// still got through at each size on Linux — not from the floor, and not on
// "bigger is safer", which the runs refuted. Interleaved, 200 runs per size
// per regression: the bare writeSync got the stderr line through whole 15
// times at 2 MiB, against 0–1 from 292,352 to 1 MiB, with short first writes
// at 2 MiB as large as 2,046,464; console.log got the payload through twice at
// 292,352 and never from 584,704 up. 1 MiB is where both were lowest. A single
// write is still unbounded — the race above — so on Linux these tests catch a
// regression with high probability, not certainty; darwin, whose first write
// is always 65,536, catches it every time.
const SHORT_WRITE_BYTES = 1024 * 1024;

const jobId = (i) => `generated-job-${String(i).padStart(6, "0")}-padding-padding`;

// Derived rather than written as a literal number of jobs: the property that
// matters is "past SHORT_WRITE_BYTES", and a hardcoded count silently stops
// clearing it the moment the id shape or the payload's other fields change. The
// ids are shaped the way expectedJobs() derives them, and carry no job-level
// `name:`, which that derivation refuses.
function jobsClearingShortWrite() {
  const ids = [];
  for (let joined = 0; joined <= SHORT_WRITE_BYTES; ) {
    const id = jobId(ids.length);
    ids.push(id);
    joined += id.length + ", ".length; // how the absent-jobs reason joins them
  }
  return ids;
}

const workflowWithJobs = (ids) =>
  `name: CI\non: [pull_request]\njobs:\n${ids.map((id) => `  ${id}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`).join("")}`;

const succeededJob = (name) => ({ name, status: "completed", conclusion: "success" });

const runViewAllSucceeded = (ids) =>
  JSON.stringify({
    jobs: ids.map(succeededJob),
    attempt: 1,
    status: "completed",
    conclusion: "success",
    headSha: PR_HEAD,
  });

// The green fixture cannot follow the other two to SHORT_WRITE_BYTES. Its jobs
// arrive through `gh run view`, which ci-state.mjs reads with execFileSync's
// default 1 MiB maxBuffer — one job past it and the read dies ENOBUFS, and the
// script exits 2 with no verdict at all (measured: 11,397 jobs). So it carries
// as many jobs as one run-view reply holds, and since the payload echoes the
// same jobs back, that lands it at 1 MiB as well, by a different road.
const GH_READ_BYTES = 1024 * 1024;
function jobsFillingOneGhRead() {
  const ids = [];
  // One comma counted per job, one more than the reply carries: errs under.
  for (let bytes = runViewAllSucceeded([]).length; ; ) {
    const id = jobId(ids.length);
    bytes += JSON.stringify(succeededJob(id)).length + ",".length;
    if (bytes > GH_READ_BYTES) return ids;
    ids.push(id);
  }
}

// --quiet is the mode the controller's CI Monitor polls in, and it drops `jobs`
// and `missing` — so this also pins that the payload still outgrows the buffer
// on the hot path, through `reasons` alone, where the absent-job reason names
// every job it could not find.
test("a not-green verdict payload larger than one pipe buffer reaches the caller whole", () => {
  const ids = jobsClearingShortWrite();
  const r = run(["--quiet"], {
    repoFiles: { ".github/workflows/ci.yml": workflowWithJobs(ids) },
    tolerateUnparsedStdout: true,
  });
  let payload;
  try {
    payload = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`verdict payload did not survive the pipe: ${r.stdout.length} bytes, ${e.message}`);
  }
  assert.ok(
    r.stdout.length > LINUX_FIRST_WRITE_BYTES,
    `fixture no longer outgrows one write on Linux (${r.stdout.length} bytes, floor ${LINUX_FIRST_WRITE_BYTES}), so on Linux this test would pass without proving anything`,
  );
  assert.equal(payload.verdict, "not-green");
  assert.equal(r.status, 1, r.stderr);
});

// The other direction, and the one a fix for the above can newly break. writeSync
// throws where console.log swallows — on a saturated non-blocking pipe it raises
// EAGAIN — and an uncaught throw here would skip the exit call entirely, dropping
// the process to exit 1: the code this script reserves for not-green. A green PR
// would then be reported as failing CI, which is worse than the truncation being
// fixed. Green is also the only verdict that can carry a large payload without
// `reasons`, so this is what exercises the write with `jobs` doing the growing.
test("a green verdict payload larger than one pipe buffer still exits 0, gate not inverted", () => {
  const ids = jobsFillingOneGhRead();
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": workflowWithJobs(ids) },
    runView: runViewAllSucceeded(ids),
    tolerateUnparsedStdout: true,
  });
  let payload;
  try {
    payload = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`verdict payload did not survive the pipe: ${r.stdout.length} bytes, ${e.message}`);
  }
  assert.ok(
    r.stdout.length > LINUX_FIRST_WRITE_BYTES,
    `fixture no longer outgrows one write on Linux (${r.stdout.length} bytes, floor ${LINUX_FIRST_WRITE_BYTES}), so on Linux this test would pass without proving anything`,
  );
  assert.equal(payload.verdict, "green");
  assert.equal(r.status, 0, r.stderr);
});

// What the write must NOT change on every payload that was never at risk. console.log
// appends exactly one newline and writeSync appends none of its own, so the
// replacement has to supply it — supplying none concatenates the payload with
// whatever a caller prints next, and supplying two breaks a reader that treats a
// blank line as end of output. Pinned as exact bytes rather than "parses", which
// all three spellings would satisfy.
test("a payload that never reaches the buffer is emitted byte for byte as before: one line, one trailing newline", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${JSON.stringify(r.payload)}\n`);
});

// The guard writeAll() puts around its write is what arg.mjs calls not
// optional, and until here nothing in this repo EXECUTED it from this script:
// deleting the try/catch outright and running this file, and then the whole
// fleet suite, left both green (measured). The two tests above prove a
// SUCCESSFUL oversized write survives; neither makes the write fail, so the
// mechanism was pinned by prose alone. arg.test.mjs pins the same guard from
// die()'s side — and since #1549 it is literally the same code, which is why
// this test stays: it is the only one that executes it through THIS script's
// exit-code contract.
//
// The failure is forced deterministically rather than by racing a reader: the
// child's stdout is /dev/null opened READ-only, so the first writeSync raises
// EBADF. A different errno from the EAGAIN in the field, and the same and only
// thing writeAll() promises about either — the message may be lost, the exit code
// may not.
//
// Green is the discriminating verdict, and the only one that discriminates: with
// the guard, the payload is lost and exit 0 still lands; without it the EBADF
// propagates, skips the process.exit() the tail is about to make, and Node falls
// through to its default exit 1 — a green PR reported to the fleet's merge gate
// as failing CI. That is the #299/#328 inversion itself, reproduced without the
// race, so this discriminates on a machine where EAGAIN never fires. Measured
// both ways: guarded exit 0, guard removed exit 1.
test("the verdict write keeps the green exit code when it throws — the guard executed, not lifted", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW }, readOnlyStdout: true });
  assert.equal(r.status, 0, `exit ${r.status}: the verdict write threw and took the green verdict with it`);
});

// The verdict SUMMARY goes to fd 2, and fd 2 already has a Node stream open on
// it by then — vlog's console.error, or under --quiet the git stderr
// execFileSync forwards — which is what puts it in O_NONBLOCK. A
// non-blocking write to a full pipe SHORT-WRITES: it returns the count it
// managed and throws nothing, so the catch above never fires and nothing is
// logged. Measured against this same fixture before the write loop consumed that
// value: the line arrived cut at one buffer with its trailing newline gone, in
// this quiet mode and in the verbose one, while stdout and the exit code came
// through untouched — the one channel the tests above cannot speak for.
//
// Completeness is asserted by CONTENT, before the size guard rather than after.
// The absent-job reason ends with the last id it joined, so a cut line simply
// does not end with it; a truncated line is also one first write long — 65,535
// bytes on darwin, most often 146,175 on Linux (measured, #1730) — which would
// fail the size guard and blame the fixture for a defect in the script. Ordered
// this way each failure names its own cause.
test("the verdict line on stderr survives past one pipe buffer, its reasons whole", () => {
  const ids = jobsClearingShortWrite();
  const r = run(["--quiet"], {
    repoFiles: { ".github/workflows/ci.yml": workflowWithJobs(ids) },
    tolerateUnparsedStdout: true,
  });
  const line = r.stderr.split("\n").find((l) => l.includes("verdict="));
  assert.ok(line, `no verdict line on stderr at all, in ${r.stderr.length} bytes`);
  assert.ok(
    line.endsWith(ids[ids.length - 1]),
    `verdict line cut mid-reason at ${Buffer.byteLength(line)} bytes: it does not reach the last job it names`,
  );
  assert.ok(
    Buffer.byteLength(line) > LINUX_FIRST_WRITE_BYTES,
    `fixture no longer outgrows one write on Linux on stderr (${Buffer.byteLength(line)} bytes, floor ${LINUX_FIRST_WRITE_BYTES}), so on Linux this test would pass without proving anything`,
  );
  assert.equal(r.status, 1, "the exit code must survive the write it follows");
});

// #901: the verdict summary is the writeAll() call site on fd 2, and the
// terminator contract already held at the payload sites on stdout was never
// pinned here. writeAll() appends no newline of its own, so each call site
// supplies its own: supplying none runs this line together with whatever the
// caller prints next, and supplying an extra ends the output early for a
// reader that treats a blank line as the end of it.
//
// The completeness assertion covering this same line cannot stand in for that.
// It locates the line by splitting stderr on "\n", and splitting on the
// terminator is what discards it — every segment that yields is the content
// BETWEEN newlines, so no wording of an assertion over that segment can see
// whether the line was terminated at all. Measured before this test existed:
// dropping the trailing newline left this file green.
//
// fd 2 also carries the vlog trace stream and gh's own forwarded stderr, so it
// has no single expected byte string and the whole-stream equality the stdout
// pins use has no equivalent here. This isolates the line instead — it locates
// the summary by the verdict and reasons THIS run reported, then reads the
// bytes on either side of it. Deriving the expected text from the emitted
// payload rather than from a literal copy is what keeps the assertions about
// the newlines alone: rewording a reason or adding a payload field moves both
// sides together and stays green, as does rewording any trace.
//
// The LEADING newline is insurance for forwarded child stderr still draining
// through the async stream without having ended its line — arg.mjs's die()
// documents the same shape for the same reason. That RACE is what does not
// reproduce here: the text before the summary has already ended its own line,
// in this fixture a vlog trace and under --quiet git's forwarded `error: No
// such remote 'origin'`. The BYTE is another matter — against already-ended
// text the leading newline leaves a blank line and dropping it leaves none —
// so it is pinned below, doubled as well as missing. What that leaves
// untested is the mid-line landing the newline exists to prevent, not the
// newline itself.
test("the verdict summary on stderr carries exactly one newline of its own on each side", () => {
  const r = run([]);
  assert.ok(
    r.payload.reasons.length,
    "fixture no longer produces a reason, so the summary derived below would carry an em dash the script omits when reasons is empty, and this test would fail on the lookup rather than on the terminator",
  );
  const summary = `ci-state: verdict=${r.payload.verdict} — ${r.payload.reasons.join("; ")}`;
  const at = r.stderr.indexOf(summary);
  assert.ok(at >= 0, `the verdict summary is not on stderr as emitted, in ${JSON.stringify(r.stderr)}`);
  const before = r.stderr.slice(0, at);
  assert.equal(
    before.match(/\n*$/)[0].length,
    2,
    `the summary's own leading newline must leave exactly one blank line after the already-ended text before it, which runs ${JSON.stringify(before.slice(-40))}`,
  );
  const after = r.stderr.slice(at + summary.length);
  assert.ok(
    after.startsWith("\n"),
    `the verdict summary is unterminated: it runs straight into ${JSON.stringify(after.slice(0, 40))}`,
  );
  assert.ok(
    !after.startsWith("\n\n"),
    "the verdict summary's terminator is doubled, ending the stream early for a reader that stops at a blank line",
  );
});

// The shape pin. The test above executes the guard, and this one pins that the
// write still goes through the SHARED loop — the two are independent: a body
// that catches faithfully and still calls writeSync once satisfies the
// behavioural test and reintroduces the short write, because a short write
// never throws.
//
// #1549: this file used to pin its own copy of that loop, with a regex
// differing from candidates.test.mjs's and staleness.test.mjs's only in head
// line, Buffer.from argument and fd. Three near-copies pinning three
// hand-mirrored loops is exactly what that ticket removed — the loop's shape,
// its EAGAIN cap and its short-write resume are now pinned AND executed once,
// in arg.test.mjs, against arg.mjs's writeAll().
//
// What is left for this file to pin is the half arg.test.mjs cannot see: that
// ci-state.mjs still ROUTES through it. emit() was this script's own copy and
// the only one of the three that never grew #889's retry cap, so the copy
// coming BACK is the specific regression here — and it is invisible to every
// behavioural test in this file, because a freshly hand-rolled loop behaves
// identically on the day it is written and drifts only afterwards.
//
// Derived through stripComments() rather than matched against raw source: a
// /m regex over raw source is satisfied by the correct shape sitting in a
// block comment, and `^(?!\s*//)` closes neither escape (both measured, and
// strip-comments.mjs's own header records them).
test("ci-state.mjs routes every outbound write through arg.mjs's writeAll(), with no re-inlined loop of its own", () => {
  const source = stripComments(readFileSync(SCRIPT, "utf8"));
  assert.match(
    source,
    /^import \{[^}]*\bwriteAll\b[^}]*\} from "\.\/arg\.mjs";/m,
    "ci-state.mjs must import writeAll from ./arg.mjs rather than hand-rolling its own write loop",
  );
  // Measured: re-inlining an emit()-shaped loop into this file reds exactly
  // this assertion and nothing else in the suite.
  assert.equal(
    source.match(/\bwriteSync\(/g),
    null,
    "ci-state.mjs calls writeSync directly again — every write here must go through writeAll(), whose loop and EAGAIN cap are pinned once in arg.test.mjs",
  );
  // ...and the write is actually THERE: without this, deleting the verdict
  // write outright would satisfy the assertion above.
  assert.match(
    source,
    /^writeAll\(1, `\$\{JSON\.stringify\(payload\)\}\\n`\);/m,
    "the verdict payload must go out through writeAll() on fd 1 — the write every pipe-buffer test above is about",
  );
});
