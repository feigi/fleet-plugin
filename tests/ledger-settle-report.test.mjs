// `ledger.mjs settle <member> --from-report`: the outcome read off the
// member's report file and checked against git and GitHub before anything is
// written. Every case runs against a throwaway origin + clone, with the
// ledger inside the clone, the real verify-sha.sh and git, and a `gh` stub on
// PATH answering `gh pr view <n>` from a per-PR JSON file.
//
// Each row of the check table has a passing case and at least one refusal:
// exit 3 naming the failed check, nothing on stdout, the ledger untouched. A
// check that cannot look is exit 2, nothing written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { seedLabelMap } from "./support/label-map-seed.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { rendering, renderBrief } from "./support/rendered-brief.mjs";
import { ref, prUrl } from "./support/queue-gh.mjs";
import { scratchRoot } from "../plugin/scripts/fleet-dir.mjs";
import { computeBoard } from "../plugin/scripts/compute-board.mjs";
import { identityRoles } from "./support/label-map-seed.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

// Identity pinned and the developer's git config cut out, so the fixture's
// commits and pushes are the same on every machine.
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function fixture() {
  const root = tempDir("ledger-settle-report-");
  const env = { ...process.env, ...GIT_ENV };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GH_REPO"]) delete env[k];
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "-c", "init.defaultBranch=main", "init", "-q", "--bare", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "commit", "-q", "--allow-empty", "-m", "root");
  git(work, "branch", "-M", "main");
  git(work, "push", "-q", "-u", "origin", "main");
  // A PR branch on origin, and a commit that is in the clone but on no
  // branch origin has.
  git(work, "checkout", "-q", "-b", "feat");
  git(work, "commit", "-q", "--allow-empty", "-m", "the PR's work");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", "feat");
  git(work, "checkout", "-q", "-b", "stray");
  git(work, "commit", "-q", "--allow-empty", "-m", "never pushed");
  const stray = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "main");

  const fleet = join(work, ".fleet");
  mkdirSync(fleet);
  // The identity Label map, which a finisher's or a merge bot's settle reads.
  seedLabelMap(work);
  const file = join(fleet, "ledger.md");
  const reports = join(root, "reports");
  mkdirSync(reports);
  const ghDir = join(root, "gh");
  mkdirSync(ghDir);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // `gh pr list` is `dispatch merge-bot` reading the queue it records:
  // `queue.json` when a case wrote one, else an empty queue.
  writeExecStub(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(root, "gh.log")}'
if [ "$1 $2" = "pr list" ]; then
  if [ -r '${join(ghDir, "queue.json")}' ]; then cat '${join(ghDir, "queue.json")}'; else echo '[]'; fi
  exit 0
fi
[ "$1 $2" = "pr view" ] || { echo "gh stub: unexpected gh $*" >&2; exit 64; }
f='${ghDir}'/"$3.json"
[ -r "$f" ] || { echo "gh stub: no PR $3" >&2; exit 1; }
cat "$f"
`);
  env.PATH = `${bin}:${process.env.PATH}`;

  const run = (...args) => spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { cwd: work, env, encoding: "utf8" });
  const cli = rendering(fleet, run);
  const ok = (...args) => {
    const r = cli(...args);
    assert.equal(r.status, 0, `${args.join(" ")}: got exit ${r.status}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const bytes = () => (existsSync(file) ? readFileSync(file, "utf8") : null);
  const report = (member, body) => writeFileSync(join(reports, `${member}.json`), JSON.stringify(body));
  // PR `n`'s `gh pr view` answer: `body`, with the PR's url in its own
  // repository unless `body` names one — `url: undefined` for none.
  const pr = (n, body) => writeFileSync(join(ghDir, `${n}.json`), JSON.stringify({ url: prUrl(n), ...body }));
  // The open ready-to-merge PRs the next `dispatch merge-bot` records.
  const queue = (...prs) => writeFileSync(join(ghDir, "queue.json"), JSON.stringify(prs.map((number) => ({ number }))));
  const settle = (member, more = []) => run("settle", member, "--from-report", "--reports", reports, ...more);
  // A settle that must pass: its receipt.
  const settled = (member) => {
    const r = settle(member);
    assert.equal(r.status, 0, `settle ${member} --from-report: got exit ${r.status}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  // A settle that must refuse with `code`, naming `why`, writing nothing.
  const refused = (member, code, why) => {
    const before = bytes();
    const r = settle(member);
    assert.equal(r.status, code, `settle ${member} --from-report: got exit ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, why);
    assert.equal(r.stdout, "", "a refusal emits no receipt");
    assert.equal(bytes(), before, "a refusal must not touch the ledger");
    return r;
  };
  return { root, work, fleet, file, reports, env, git, head, stray, run, cli, ok, bytes, report, pr, queue, settle, settled, refused };
}

const implReport = (f, over = {}) => ({
  member: "impl-5", outcome: "pr", pr: 6, head: f.head, branch: "feat",
  sizing: { verdict: "light", signal: "one file", ranBeforePr: true },
  bailCause: null, bailDetail: null, confirmation: [], ...over,
});
const fixReport = (f, over = {}) => ({
  member: "fix-pr-6", outcome: "applied", head: f.head, branch: "feat",
  applied: [], deferred: [], filed: [], unrecorded: [], dispositionsRecord: join(f.root, "dispositions-fix-pr-6.json"),
  testRun: { cmd: "./agent-test", exit: 0, tests: 3, cancelled: 0 }, confirmation: [], ...over,
});
const finisherReport = (f, over = {}) => ({
  member: "finisher-pr-6", outcome: "labelled", cause: null, evidence: null, pin: f.head,
  labelsReadBack: ["patch", "ready-to-merge"], kill: null, filed: [], unrecorded: [], confirmation: [], ...over,
});
const botReport = (f, over = {}) => ({
  member: "merge-bot-1", merged: [{ pr: 6, sha: f.head }, { pr: 7, sha: f.head }], conflictHold: [], refused: [], branchKept: [], ...over,
});

const dispatched = (f, member) => f.ok("read").dispatched.find((e) => e.split("=")[0] === member);

// -- impl-N=PR#M --------------------------------------------------------------

test("impl-N=PR#M: a head on the branch and an OPEN PR closing N settles", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  f.pr(6, { state: "OPEN", closingIssuesReferences: [ref(5)] });
  const receipt = f.settled("impl-5");
  assert.deepEqual(receipt, {
    member: "impl-5", outcome: "PR#6", filed: [], ruled: [],
    checks: [
      { name: `verify-sha.sh feat ${f.head} exits 0`, ok: true },
      { name: "PR #6 reads OPEN", ok: true },
      { name: "PR #6 closes #5", ok: true },
    ],
  });
  assert.equal(dispatched(f, "impl-5"), "impl-5=PR#6");
  assert.match(readFileSync(join(f.root, "gh.log"), "utf8"), /^pr view 6 --json state,closingIssuesReferences,url$/m);
});

test("impl-N=PR#M: a head verify-sha.sh does not find on the branch is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f, { head: f.stray }));
  f.pr(6, { state: "OPEN", closingIssuesReferences: [ref(5)] });
  f.refused("impl-5", 3, new RegExp(`failed: verify-sha\\.sh feat ${f.stray} exits 0`));
});

test("impl-N=PR#M: a PR that is not OPEN is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  f.pr(6, { state: "CLOSED", closingIssuesReferences: [ref(5)] });
  f.refused("impl-5", 3, /failed: PR #6 reads OPEN/);
});

test("impl-N=PR#M: a PR that does not close ticket N is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  f.pr(6, { state: "OPEN", closingIssuesReferences: [ref(55)] });
  f.refused("impl-5", 3, /failed: PR #6 closes #5/);
});

test("impl-N=PR#M: a PR whose only reference to #N is another repository's is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  f.pr(6, { state: "OPEN", closingIssuesReferences: [ref(5, "other-org/other-repo")] });
  f.refused("impl-5", 3, /failed: PR #6 closes #5/);
});

test("could not look: a closing reference with neither a url nor a repository is exit 2", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  const { url: _url, repository: _repository, ...unplaced } = ref(5);
  f.pr(6, { state: "OPEN", closingIssuesReferences: [unplaced] });
  f.refused("impl-5", 2, /could not look — gh pr view 6 --json state,closingIssuesReferences,url answered a reference to #5 with neither a url nor a repository; nothing written/);
});

test("could not look: a gh that fails is exit 2, not a failed check", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  // No answer file for PR 6: the stub exits 1, as gh does when it cannot reach GitHub.
  f.refused("impl-5", 2, /could not look — gh pr view 6 --json state,closingIssuesReferences,url exited 1: gh stub: no PR 6/);
});

test("could not look: a gh that answers something other than JSON is exit 2", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  writeFileSync(join(f.root, "gh", "6.json"), "<html>rate limited</html>");
  f.refused("impl-5", 2, /could not look — gh pr view 6 .* printed no JSON object/);
});

test("could not look: a gh answer lacking a field it was asked for is exit 2, not a failed check", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.ok("dispatch", "merge-bot");
  f.report("impl-5", implReport(f));
  f.report("finisher-pr-6", finisherReport(f));
  f.report("merge-bot-1", botReport(f, { merged: [{ pr: 7, sha: f.head }] }));
  for (const body of [{}, { closingIssuesReferences: [ref(5)] }, { state: "OPEN", closingIssuesReferences: null }, { state: "OPEN" }, { state: "OPEN", closingIssuesReferences: [ref(5)], url: undefined }]) {
    f.pr(6, body);
    f.refused("impl-5", 2, /could not look — gh pr view 6 --json state,closingIssuesReferences,url answered without a usable/);
  }
  f.pr(6, {});
  f.refused("finisher-pr-6", 2, /could not look — gh pr view 6 --json labels answered without a usable labels/);
  f.pr(7, {});
  f.refused("merge-bot-1", 2, /could not look — gh pr view 7 --json state answered without a usable state/);
});

// -- impl-N=bailed ------------------------------------------------------------

test("impl-N=bailed: a bail cause settles, and the receipt names it", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f, { outcome: "bailed", pr: null, head: null, bailCause: "hands", bailDetail: "needs a token" }));
  const receipt = f.settled("impl-5");
  assert.equal(receipt.outcome, "bailed");
  assert.deepEqual(receipt.checks, [{ name: "bailCause: hands", ok: true }]);
  assert.equal(dispatched(f, "impl-5"), "impl-5=bailed");
});

test("impl-N=bailed: a null bailCause is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f, { outcome: "bailed", pr: null, head: null }));
  f.refused("impl-5", 3, /failed: bailCause: null/);
});

test("impl-N=bailed: a bail that names a PR or a head is not a report — exit 2, nothing settled bailed", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  const bailed = (over) => implReport(f, { outcome: "bailed", pr: null, head: null, bailCause: "hands", bailDetail: "needs a token", ...over });
  f.report("impl-5", bailed({ pr: 6 }));
  f.refused("impl-5", 2, /is not a impl report — \$\.pr: 6 is not null, with outcome "bailed" — a bail reports no PR/);
  f.report("impl-5", bailed({ head: f.head }));
  f.refused("impl-5", 2, /\$\.head: "[0-9a-f]{40}" is not null, with outcome "bailed" — a bail reports no PR/);
});

// -- impl-N=blocked -----------------------------------------------------------

const blockedReport = (f, over = {}) => implReport(f, {
  outcome: "blocked", pr: null, head: null, bailCause: null, bailDetail: "the migration needs a schema ruling", ...over,
});

test("impl-N=blocked: a block with its reason settles blocked, unchecked", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", blockedReport(f));
  const receipt = f.settled("impl-5");
  assert.equal(receipt.outcome, "blocked");
  assert.deepEqual(receipt.checks, []);
  assert.equal(dispatched(f, "impl-5"), "impl-5=blocked");
});

test("impl-N=blocked: a block with no bailDetail, or with a bailCause, is not a report — exit 2 naming why", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", blockedReport(f, { bailDetail: null }));
  f.refused("impl-5", 2, /is not a impl report — \$\.bailDetail: null is not a reason, with outcome "blocked"/);
  f.report("impl-5", blockedReport(f, { bailDetail: " \n" }));
  f.refused("impl-5", 2, /\$\.bailDetail: " \\n" is not a reason, with outcome "blocked"/);
  f.report("impl-5", blockedReport(f, { bailCause: "fork" }));
  f.refused("impl-5", 2, /\$\.bailCause: "fork" is not null, with outcome "blocked" — a block is no bail/);
});

test("impl-N=blocked: a block that names a PR or a head is not a report — exit 2, nothing settled unchecked", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", blockedReport(f, { pr: 6 }));
  f.refused("impl-5", 2, /\$\.pr: 6 is not null, with outcome "blocked" — a block reports no PR/);
  f.report("impl-5", blockedReport(f, { head: f.head }));
  f.refused("impl-5", 2, /\$\.head: "[0-9a-f]{40}" is not null, with outcome "blocked" — a block reports no PR/);
});

// -- fix-pr-M=applied:<head> --------------------------------------------------

test("fix-pr-M=applied:<head>: origin's branch at the reported head settles", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f));
  const receipt = f.settled("fix-pr-6");
  assert.equal(receipt.outcome, `applied:${f.head}`);
  assert.deepEqual(receipt.checks, [{ name: `origin refs/heads/feat is ${f.head}`, ok: true }]);
  assert.equal(dispatched(f, "fix-pr-6"), `fix-pr-6=applied:${f.head}`);
});

test("fix-pr-M=applied:<head>: origin's branch elsewhere is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f, { head: f.stray }));
  f.refused("fix-pr-6", 3, new RegExp(`failed: origin refs/heads/feat is ${f.stray}`));
});

test("fix-pr-M=applied:<head>: a branch origin does not have is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f, { branch: "gone" }));
  f.refused("fix-pr-6", 3, new RegExp(`failed: origin refs/heads/gone is ${f.head}`));
});

test("could not look: a git ls-remote that fails is exit 2", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f));
  f.git(f.work, "remote", "set-url", "origin", join(f.root, "no-such-origin.git"));
  f.refused("fix-pr-6", 2, /could not look — git ls-remote origin refs\/heads\/feat exited 128/);
});

// -- fix-pr-M=no-op -----------------------------------------------------------

test("fix-pr-M=no-op: origin's branch at the latest reviewed= head settles", () => {
  const f = fixture();
  f.ok("review", "6", "review=member:review-pr-6", `reviewed=${f.head.slice(0, 12)}:0/0/0:run-abcd1234`);
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f, { outcome: "no-op" }));
  const receipt = f.settled("fix-pr-6");
  assert.equal(receipt.outcome, "no-op");
  assert.deepEqual(receipt.checks, [
    { name: `origin refs/heads/feat is ${f.head.slice(0, 12)}, the head PR #6's latest reviewed= names`, ok: true },
  ]);
  assert.equal(dispatched(f, "fix-pr-6"), "fix-pr-6=no-op");
});

test("fix-pr-M=no-op: a report with no dispositions record and no test run settles the same", () => {
  const f = fixture();
  f.ok("review", "6", "review=member:review-pr-6", `reviewed=${f.head.slice(0, 12)}:0/0/0:run-abcd1234`);
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f, { outcome: "no-op", dispositionsRecord: null, testRun: null }));
  assert.equal(f.settled("fix-pr-6").outcome, "no-op");
  assert.equal(dispatched(f, "fix-pr-6"), "fix-pr-6=no-op");
});

test("fix-pr-M=no-op: origin's branch moved past the reviewed= head is exit 3", () => {
  const f = fixture();
  f.ok("review", "6", "review=member:review-pr-6", `reviewed=${f.stray}:0/0/0:run-abcd1234`);
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f, { outcome: "no-op" }));
  f.refused("fix-pr-6", 3, new RegExp(`failed: origin refs/heads/feat is ${f.stray}, the head PR #6's latest reviewed= names`));
});

test("fix-pr-M=no-op: a branch origin does not have is exit 3", () => {
  const f = fixture();
  f.ok("review", "6", "review=member:review-pr-6", `reviewed=${f.head.slice(0, 12)}:0/0/0:run-abcd1234`);
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f, { outcome: "no-op", branch: "gone" }));
  f.refused("fix-pr-6", 3, /failed: origin refs\/heads\/gone is /);
});

test("fix-pr-M=no-op: a PR with no reviewed= is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f, { outcome: "no-op" }));
  f.refused("fix-pr-6", 3, /failed: PR #6's row names a reviewed= head/);
});

// -- finisher-pr-M=labelled ---------------------------------------------------

test("finisher-pr-M=labelled: the label on the PR and in the read-back settles", () => {
  const f = fixture();
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f));
  f.pr(6, { labels: [{ name: "patch" }, { name: "ready-to-merge" }] });
  const receipt = f.settled("finisher-pr-6");
  assert.equal(receipt.outcome, "labelled");
  assert.deepEqual(receipt.checks, [
    { name: "PR #6 carries ready-to-merge", ok: true },
    { name: "labelsReadBack carries ready-to-merge", ok: true },
  ]);
  assert.equal(dispatched(f, "finisher-pr-6"), "finisher-pr-6=labelled");
});

test("finisher-pr-M=labelled: a PR without ready-to-merge is exit 3", () => {
  const f = fixture();
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f));
  f.pr(6, { labels: [{ name: "patch" }] });
  f.refused("finisher-pr-6", 3, /failed: PR #6 carries ready-to-merge/);
});

test("finisher-pr-M=labelled: a read-back without ready-to-merge is exit 3", () => {
  const f = fixture();
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f, { labelsReadBack: ["patch"] }));
  f.pr(6, { labels: [{ name: "patch" }, { name: "ready-to-merge" }] });
  f.refused("finisher-pr-6", 3, /failed: labelsReadBack carries ready-to-merge/);
});

// #3869: the label checked is the Label map's string for `ready-to-merge`.
const QUEUE_OK = { roles: { "ready-to-merge": "queue-ok" } };

test("finisher-pr-M=labelled: a remapped ready-to-merge is checked as its mapped string, on the PR and in the read-back", () => {
  const f = fixture();
  seedLabelMap(f.work, QUEUE_OK);
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f, { labelsReadBack: ["patch", "queue-ok"] }));
  f.pr(6, { labels: [{ name: "patch" }, { name: "queue-ok" }] });
  assert.deepEqual(f.settled("finisher-pr-6").checks, [
    { name: "PR #6 carries queue-ok", ok: true },
    { name: "labelsReadBack carries queue-ok", ok: true },
  ]);
});

test("finisher-pr-M=labelled: with ready-to-merge remapped, the role's own name on the PR and in the read-back is exit 3 naming both", () => {
  const f = fixture();
  seedLabelMap(f.work, QUEUE_OK);
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f));
  f.pr(6, { labels: [{ name: "patch" }, { name: "ready-to-merge" }] });
  f.refused("finisher-pr-6", 3, /failed: PR #6 carries queue-ok; failed: labelsReadBack carries queue-ok; nothing written/);
});

// -- finisher-pr-M=halted:<cause> ---------------------------------------------

test("finisher-pr-M=halted:<cause>: a cause and its evidence settle, and unrecorded filings reach ## Filed", () => {
  const f = fixture();
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f, {
    outcome: "halted", cause: "rebase", evidence: "+ abc123 a commit main lacks", labelsReadBack: [],
    unrecorded: [{ issue: 70, subject: "a deferral whose filed failed twice" }],
  }));
  const receipt = f.settled("finisher-pr-6");
  assert.equal(receipt.outcome, "halted:rebase");
  assert.deepEqual(receipt.filed, ["#70 a deferral whose filed failed twice"]);
  assert.equal(dispatched(f, "finisher-pr-6"), "finisher-pr-6=halted:rebase");
  assert.deepEqual(f.ok("read").filed, ["#70 a deferral whose filed failed twice"]);
});

test("finisher-pr-M=halted:stray: the cause the audit's stray names settles, with the cherry and remote read as its evidence", () => {
  const f = fixture();
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f, {
    outcome: "halted", cause: "stray", evidence: `{"cherry":{"listing":"+ abc123","merges":0},"remote":{"ref":"refs/heads/feat","sha":null,"carries":false}}`, labelsReadBack: [],
  }));
  assert.equal(f.settled("finisher-pr-6").outcome, "halted:stray");
  assert.equal(dispatched(f, "finisher-pr-6"), "finisher-pr-6=halted:stray");
});

test("finisher-pr-M=halted:<cause>: a null cause is exit 3", () => {
  const f = fixture();
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f, { outcome: "halted", cause: null, evidence: "something", labelsReadBack: [] }));
  f.refused("finisher-pr-6", 3, /failed: cause null is in the halted:<cause> vocabulary/);
});

test("finisher-pr-M=halted:<cause>: empty evidence is exit 3", () => {
  const f = fixture();
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f, { outcome: "halted", cause: "other", evidence: "  ", labelsReadBack: [] }));
  f.refused("finisher-pr-6", 3, /failed: evidence is not empty/);
});

// -- merge-bot-n=done ---------------------------------------------------------

test("merge-bot-n=done: every merged PR reading MERGED settles", () => {
  const f = fixture();
  f.ok("dispatch", "merge-bot");
  f.report("merge-bot-1", botReport(f));
  f.pr(6, { state: "MERGED" });
  f.pr(7, { state: "MERGED" });
  const receipt = f.settled("merge-bot-1");
  assert.equal(receipt.outcome, "done");
  assert.deepEqual(receipt.checks, [{ name: "PR #6 reads MERGED", ok: true }, { name: "PR #7 reads MERGED", ok: true }]);
  assert.equal(dispatched(f, "merge-bot-1"), "merge-bot-1=done");
});

test("merge-bot-n=done: a merged PR that does not read MERGED is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "merge-bot");
  f.report("merge-bot-1", botReport(f));
  f.pr(6, { state: "MERGED" });
  f.pr(7, { state: "OPEN" });
  f.refused("merge-bot-1", 3, /failed: PR #7 reads MERGED/);
});

test("merge-bot-n=done: a pass dispatched with nothing queued and giving no verdict settles with no check and rules nothing", () => {
  const f = fixture();
  assert.deepEqual(f.ok("dispatch", "merge-bot").queued, []);
  f.report("merge-bot-1", botReport(f, { merged: [] }));
  const receipt = f.settled("merge-bot-1");
  assert.deepEqual(receipt.checks, []);
  assert.deepEqual(receipt.ruled, []);
  assert.deepEqual(f.ok("read").ruled, []);
});

// The queue a report is judged against is the one `dispatch merge-bot`
// recorded, so the PR a bot leaves out of its report is still in it.
test("merge-bot-n=done: a report giving every queued PR one verdict settles, each refused entry ruled with its reason and nothing else written", () => {
  const f = fixture();
  f.queue(6, 7, 8, 9, 10);
  assert.deepEqual(f.ok("dispatch", "merge-bot").queued, [6, 7, 8, 9, 10]);
  f.ok("row", "10", "PR#10 · patch");
  f.ok("ruled", "10", "kept: reviewer finding 3 rejected");
  const rows = f.ok("read").rows;
  f.report("merge-bot-1", botReport(f, {
    conflictHold: [8, 9], refused: [{ pr: 10, reason: "main-gain-removed:plugin/a.md" }],
  }));
  f.pr(6, { state: "MERGED" });
  f.pr(7, { state: "MERGED" });
  const receipt = f.settled("merge-bot-1");
  assert.deepEqual(receipt.checks, [{ name: "PR #6 reads MERGED", ok: true }, { name: "PR #7 reads MERGED", ok: true }]);
  assert.deepEqual(receipt.ruled, ["merge-bot-1 refused #10: main-gain-removed:plugin/a.md"]);
  const l = f.ok("read");
  assert.deepEqual(l.ruled, ["#10 kept: reviewer finding 3 rejected", "merge-bot-1 refused #10: main-gain-removed:plugin/a.md"]);
  assert.deepEqual(l.rows, rows, "a refusal writes no row token");
  const calls = readFileSync(join(f.root, "gh.log"), "utf8");
  assert.doesNotMatch(calls, /^pr (edit|view (8|9|10)) /m, "a PR given a verdict is not looked up, and no label moves");
  // The board takes a `## Ruled` line led by `#<n>` as the controller's
  // ruling on PR n, the last one winning: the refusal leaves that ruling
  // on the PR's card.
  const board = computeBoard({ ledger: l, issues: [], prs: [{ number: 10, state: "OPEN", labels: [] }], ci: {}, prev: null, now: 0, roles: identityRoles() });
  assert.equal(board.tickets.find((t) => t.pr === 10).ruling, "kept: reviewer finding 3 rejected");
});

// The reason is ruled trimmed, so the line a reload reads back is the line a
// second settle would write: it is not written twice.
test("merge-bot-n=done: a refused reason padded with whitespace is ruled trimmed, and a second settle writes nothing", () => {
  const f = fixture();
  f.queue(6, 7, 10);
  f.ok("dispatch", "merge-bot");
  f.report("merge-bot-1", botReport(f, { refused: [{ pr: 10, reason: "  ci-wait-timeout \t" }] }));
  f.pr(6, { state: "MERGED" });
  f.pr(7, { state: "MERGED" });
  assert.deepEqual(f.settled("merge-bot-1").ruled, ["merge-bot-1 refused #10: ci-wait-timeout"]);
  const before = f.bytes();
  assert.deepEqual(f.settled("merge-bot-1").ruled, []);
  assert.equal(f.bytes(), before, "a second run of the same settle writes nothing");
});

test("merge-bot-n=done: a refusal with no reason, empty or only whitespace, is exit 2 and gives its PR no verdict", () => {
  const f = fixture();
  f.queue(6, 7, 10);
  f.ok("dispatch", "merge-bot");
  for (const reason of ["", "  "]) {
    f.report("merge-bot-1", botReport(f, { refused: [{ pr: 10, reason }] }));
    f.refused("merge-bot-1", 2, /is not a merge-bot report — \$\.refused\[0\]\.reason: .* does not match \\S; nothing written/);
  }
});

test("merge-bot-n=done: a queued PR still queued with no verdict is exit 3 naming it, however the report leaves it out", () => {
  const f = fixture();
  f.queue(6, 7, 8, 9);
  f.ok("dispatch", "merge-bot");
  f.pr(6, { state: "MERGED" });
  f.pr(7, { state: "MERGED" });
  f.pr(8, { state: "OPEN", labels: [{ name: "patch" }, { name: "ready-to-merge" }] });
  f.pr(9, { state: "OPEN", labels: [{ name: "ready-to-merge" }] });
  f.report("merge-bot-1", botReport(f, { conflictHold: [9] }));
  f.refused("merge-bot-1", 3, /failed: PR #8, queued at dispatch, has a verdict in merged, conflictHold or refused, or has left the queue; nothing written/);
  // A report cannot carry a queue of its own to be judged against instead.
  f.report("merge-bot-1", { ...botReport(f, { conflictHold: [9] }), queued: [6, 7, 9] });
  f.refused("merge-bot-1", 2, /is not a merge-bot report — \$: unexpected field "queued"; nothing written/);
  // Nor does a later queue count: the one dispatch recorded is the one judged.
  f.queue(6, 7, 9);
  f.report("merge-bot-1", botReport(f, { conflictHold: [9] }));
  f.refused("merge-bot-1", 3, /failed: PR #8, queued at dispatch/);
  f.report("merge-bot-1", botReport(f, { conflictHold: [9], refused: [{ pr: 8, reason: "ci-wait-timeout" }] }));
  assert.deepEqual(f.settled("merge-bot-1").ruled, ["merge-bot-1 refused #8: ci-wait-timeout"]);
});

test("merge-bot-n=done: a queued PR that left the queue before the settle, or a PR labelled after dispatch, fails nothing", () => {
  const f = fixture();
  f.queue(6, 7, 8, 9);
  f.ok("dispatch", "merge-bot");
  f.pr(6, { state: "MERGED" });
  f.pr(7, { state: "MERGED" });
  f.pr(8, { state: "MERGED", labels: [{ name: "ready-to-merge" }] });
  f.pr(9, { state: "OPEN", labels: [{ name: "patch" }] });
  f.queue(6, 7, 11);
  f.report("merge-bot-1", botReport(f));
  const receipt = f.settled("merge-bot-1");
  assert.deepEqual(receipt.checks.slice(2), [
    { name: "PR #8, queued at dispatch, has a verdict in merged, conflictHold or refused, or has left the queue", ok: true },
    { name: "PR #9, queued at dispatch, has a verdict in merged, conflictHold or refused, or has left the queue", ok: true },
  ]);
  assert.doesNotMatch(readFileSync(join(f.root, "gh.log"), "utf8"), /^pr view 11 /m, "a PR labelled after dispatch is never looked up");
});

test("merge-bot-n=done: with ready-to-merge remapped, the queue is recorded and judged by the mapped string", () => {
  const f = fixture();
  seedLabelMap(f.work, QUEUE_OK);
  f.queue(6, 7, 8, 9);
  f.ok("dispatch", "merge-bot");
  assert.match(readFileSync(join(f.root, "gh.log"), "utf8"), /^pr list --state open --label queue-ok --limit 1000 --json number$/m);
  f.pr(6, { state: "MERGED" });
  f.pr(7, { state: "MERGED" });
  // PR 8 still carries the mapped label, so it is still queued; PR 9 carries
  // only the role's own name, which is not the queue's label.
  f.pr(8, { state: "OPEN", labels: [{ name: "queue-ok" }] });
  f.pr(9, { state: "OPEN", labels: [{ name: "ready-to-merge" }] });
  f.report("merge-bot-1", botReport(f));
  const r = f.refused("merge-bot-1", 3, /failed: PR #8, queued at dispatch, has a verdict/);
  assert.doesNotMatch(r.stderr, /PR #9/);
});

// Only a label check reads the map: a settle that makes none runs without one.
test("settle --from-report with no Label map: a label check is exit 2 naming ensure, and a settle making none still settles", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.ok("dispatch", "merge-bot");
  rmSync(join(f.fleet, "labels.json"));
  f.report("finisher-pr-6", finisherReport(f));
  f.pr(6, { closingIssuesReferences: [ref(5)], state: "OPEN", labels: [{ name: "patch" }, { name: "ready-to-merge" }] });
  f.refused("finisher-pr-6", 2, /settle finisher-pr-6 --from-report: no Label map at .*label-map\.mjs ensure.*; nothing written/);
  f.report("finisher-pr-6", finisherReport(f, { outcome: "halted", cause: "rebase", evidence: "+ abc123 a commit main lacks", labelsReadBack: [] }));
  assert.equal(f.settled("finisher-pr-6").outcome, "halted:rebase");
  f.report("impl-5", implReport(f));
  assert.equal(f.settled("impl-5").outcome, "PR#6");
  f.pr(7, { state: "MERGED" });
  f.pr(6, { state: "MERGED" });
  f.report("merge-bot-1", botReport(f));
  assert.equal(f.settled("merge-bot-1").outcome, "done");
});

// The map is read only when a queued PR's labels are to be looked at: a queue
// whose every PR has a verdict needs no label check, so it settles with none.
test("merge-bot-n=done with no Label map: a queue whose PRs all have verdicts settles without reading it", () => {
  const f = fixture();
  f.queue(6, 7);
  f.ok("dispatch", "merge-bot");
  rmSync(join(f.fleet, "labels.json"));
  f.pr(6, { state: "MERGED" });
  f.pr(7, { state: "MERGED" });
  f.report("merge-bot-1", botReport(f));
  assert.equal(f.settled("merge-bot-1").outcome, "done");
});

test("merge-bot-n=done: a PR given two verdicts, in two lists or in one, is exit 2 naming both entries", () => {
  const f = fixture();
  f.ok("dispatch", "merge-bot");
  f.report("merge-bot-1", botReport(f, { refused: [{ pr: 7, reason: "behind:3" }] }));
  f.refused("merge-bot-1", 2, /is not a merge-bot report — \$\.refused\[0\]\.pr: PR #7 already has a verdict at \$\.merged\[1\]\.pr; nothing written/);
  f.report("merge-bot-1", botReport(f, { merged: [], conflictHold: [9, 9] }));
  f.refused("merge-bot-1", 2, /\$\.conflictHold\[1\]: PR #9 already has a verdict at \$\.conflictHold\[0\]/);
});

test("merge-bot-n=done: a bot whose ## Dispatched entry records no queued= is exit 2, since its report cannot be judged", () => {
  const f = fixture();
  f.ok("dispatch", "merge-bot");
  writeFileSync(f.file, f.bytes().replace(/ queued=none$/m, ""));
  f.report("merge-bot-1", botReport(f, { merged: [] }));
  f.refused("merge-bot-1", 2, /## Dispatched records no queued= for merge-bot-1, so whether its report gives every PR queued at dispatch a verdict cannot be judged — settle it by hand; nothing written/);
});

// -- the report itself --------------------------------------------------------

test("an invalid report is exit 2 naming the violation, one family at a time", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.ok("dispatch", "6", "fix-pr-6");
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.ok("dispatch", "merge-bot");
  const { sizing: _, ...noSizing } = implReport(f);
  f.report("impl-5", noSizing);
  f.refused("impl-5", 2, /impl-5\.json is not a impl report — \$: missing required field "sizing"; nothing written/);
  f.report("fix-pr-6", fixReport(f, { outcome: "done" }));
  f.refused("fix-pr-6", 2, /is not a fix-pr report — \$\.outcome: "done" is not one of "applied", "no-op", "failed"/);
  f.report("finisher-pr-6", { ...finisherReport(f), label: "ready-to-merge" });
  f.refused("finisher-pr-6", 2, /is not a finisher report — \$: unexpected field "label"/);
  f.report("merge-bot-1", botReport(f, { merged: [{ pr: 6, sha: "abc" }] }));
  f.refused("merge-bot-1", 2, /is not a merge-bot report — \$\.merged\[0\]\.sha: "abc" does not match/);
});

test("an unrecorded filing with no issue number is exit 2 before anything is looked up", () => {
  const f = fixture();
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  const ghBefore = readFileSync(join(f.root, "gh.log"), "utf8");
  for (const issue of [-3, 0]) {
    f.report("finisher-pr-6", finisherReport(f, { outcome: "halted", cause: "other", evidence: "e", labelsReadBack: [], unrecorded: [{ issue, subject: "neg" }] }));
    f.refused("finisher-pr-6", 2, new RegExp(`\\$\\.unrecorded\\[0\\]\\.issue: ${issue} is below minimum 1; nothing written`));
  }
  assert.equal(readFileSync(join(f.root, "gh.log"), "utf8"), ghBefore, "no gh call came after the dispatch");
});

test("a report that is absent, not JSON, or names another member is exit 2", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.refused("impl-5", 2, new RegExp(`no report at ${join(f.reports, "impl-5.json")}`));
  writeFileSync(join(f.reports, "impl-5.json"), "PR 6, head abc");
  f.refused("impl-5", 2, /\$: not JSON/);
  f.report("impl-5", implReport(f, { member: "impl-55" }));
  f.refused("impl-5", 2, /\$\.member: "impl-55" is not impl-5/);
  f.report("impl-5", implReport(f, { pr: null }));
  f.refused("impl-5", 2, /\$\.pr: null is not a PR number, with outcome "pr"/);
});

// -- side effects -------------------------------------------------------------

test("unrecorded filings reach ## Filed and refuted deferrals reach ## Ruled, once however often the settle runs", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  // Already on file: the settle leaves its row as it is.
  f.ok("filed", "41", "filed by the member itself");
  const record = join(f.root, "dispositions-fix-pr-6.json");
  writeFileSync(record, JSON.stringify({
    head: f.head, run: "run-abcd1234", entries: [
      { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "defer", reason: "false-rationale", issue: 42 },
      { bucket: "refuted", index: 2, scope: "in", claimKind: "behavior", disposition: "defer", reason: "the red run reproduces it", issue: 43 },
    ],
  }));
  f.report("fix-pr-6", fixReport(f, {
    deferred: [{ bucket: "survived", index: 0, issue: 42 }, { bucket: "refuted", index: 2, issue: 43 }],
    filed: [{ issue: 41, subject: "filed by the member itself" }],
    unrecorded: [{ issue: 40, subject: "a deferral whose filed failed twice" }, { issue: 41, subject: "a retry reworded" }],
  }));
  const receipt = f.settled("fix-pr-6");
  assert.deepEqual(receipt.filed, ["#40 a deferral whose filed failed twice"]);
  assert.deepEqual(receipt.ruled, ["#6 reversed refutation 2: the red run reproduces it"]);
  assert.deepEqual(receipt.checks.at(-1), { name: `${record} gives refuted[2] a reason`, ok: true });
  const ledger = f.ok("read");
  assert.deepEqual(ledger.filed, ["#41 filed by the member itself", "#40 a deferral whose filed failed twice"]);
  assert.deepEqual(ledger.ruled, ["#6 reversed refutation 2: the red run reproduces it"]);

  const before = f.bytes();
  const again = f.settled("fix-pr-6");
  assert.deepEqual([again.filed, again.ruled], [[], []]);
  assert.equal(f.bytes(), before, "a second run of the same settle writes nothing");
});

test("a refuted deferral the disposition record gives no reason, or only whitespace, is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  const record = join(f.root, "dispositions-fix-pr-6.json");
  f.report("fix-pr-6", fixReport(f, { deferred: [{ bucket: "refuted", index: 2, issue: 43 }] }));
  for (const reason of ["", "  "]) {
    writeFileSync(record, JSON.stringify({ head: f.head, run: "run-abcd1234", entries: [{ bucket: "refuted", index: 2, reason }] }));
    f.refused("fix-pr-6", 3, new RegExp(`failed: ${record} gives refuted\\[2\\] a reason`));
  }
});

test("a member already settled by hand still has its report's new filings and rulings recorded", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  const hand = f.run("settle", `fix-pr-6=applied:${f.head}`);
  assert.equal(hand.status, 0, hand.stderr);
  const record = join(f.root, "dispositions-fix-pr-6.json");
  writeFileSync(record, JSON.stringify({
    head: f.head, run: "run-abcd1234", entries: [{ bucket: "refuted", index: 2, reason: "the red run reproduces it" }],
  }));
  f.report("fix-pr-6", fixReport(f, {
    deferred: [{ bucket: "refuted", index: 2, issue: 43 }],
    unrecorded: [{ issue: 40, subject: "a late filing" }],
  }));
  const receipt = f.settled("fix-pr-6");
  assert.deepEqual([receipt.filed, receipt.ruled], [["#40 a late filing"], ["#6 reversed refutation 2: the red run reproduces it"]]);
  const ledger = f.ok("read");
  assert.deepEqual(ledger.filed, ["#40 a late filing"]);
  assert.deepEqual(ledger.ruled, ["#6 reversed refutation 2: the red run reproduces it"]);
});

test("the settle is written against the ledger as it stands under the lock, not as the checks read it", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  f.pr(6, { state: "OPEN", closingIssuesReferences: [ref(5)] });
  // The first gh call, which the settle makes after it read the ledger and
  // before it takes the lock, is when another writer files an issue.
  const raced = join(f.root, "raced");
  writeExecStub(join(f.root, "bin", "gh"), `#!/bin/sh
if [ ! -e '${raced}' ]; then
  : > '${raced}'
  '${process.execPath}' '${SCRIPT}' --file '${f.file}' filed 77 racer >/dev/null || exit 70
fi
cat '${join(f.root, "gh")}'/"$3.json"
`);
  f.settled("impl-5");
  assert.equal(existsSync(raced), true, "the other writer ran");
  assert.deepEqual(f.ok("read").filed, ["#77 racer"]);
  assert.equal(dispatched(f, "impl-5"), "impl-5=PR#6");
});

test("a refuted deferral whose disposition record cannot be read is exit 2", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f, { deferred: [{ bucket: "refuted", index: 2, issue: 43 }] }));
  f.refused("fix-pr-6", 2, /could not look — the disposition record .* could not be read as JSON: ENOENT/);
});

// The report check refuses a refuted deferral naming no record before settle
// reads any path, so it is an invalid report, never a crash on a null path.
test("a refuted deferral with a null dispositionsRecord is an invalid report, exit 2", () => {
  const f = fixture();
  f.ok("dispatch", "6", "fix-pr-6");
  f.report("fix-pr-6", fixReport(f, { dispositionsRecord: null, deferred: [{ bucket: "refuted", index: 2, issue: 43 }] }));
  f.refused("fix-pr-6", 2, /is not a fix-pr report — \$\.dispositionsRecord: null, with a refuted deferral at \$\.deferred\[0\]/);
});

test("a failed report settles =failed with no check", () => {
  const f = fixture();
  f.pr(6, { closingIssuesReferences: [], labels: [{ name: "patch" }] });
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f, { outcome: "failed", labelsReadBack: [] }));
  assert.deepEqual(f.settled("finisher-pr-6"), { member: "finisher-pr-6", outcome: "failed", checks: [], filed: [], ruled: [] });
  assert.equal(dispatched(f, "finisher-pr-6"), "finisher-pr-6=failed");
});

// -- the command line ---------------------------------------------------------

test("--reports defaults to <scratch>/reports, the root scratch-root.mjs prints", () => {
  const f = fixture();
  const home = join(f.root, "home");
  mkdirSync(home);
  f.ok("dispatch", "5", "impl-5");
  const dir = join(scratchRoot({ cwd: f.work, home }), "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "impl-5.json"), JSON.stringify(implReport(f, { outcome: "bailed", pr: null, head: null, bailCause: "fork" })));
  const r = spawnSync(process.execPath, [SCRIPT, "--file", f.file, "settle", "impl-5", "--from-report"], {
    cwd: f.work, env: { ...f.env, HOME: home }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, "bailed");
});

test("--from-report takes a member name, not a token, and refuses a stray flag", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  for (const [args, why] of [
    [["settle", "impl-5=PR#6", "--from-report"], /takes a member name, not 'impl-5=PR#6'/],
    [["settle", "impl-5", "--from-report", "--reports"], /--reports needs a directory/],
    [["settle", "impl-5", "--from-report", "--report", f.reports], /unknown flag '--report'/],
    [["settle", "impl-5", "--reports", f.reports], /--reports is read only with --from-report/],
  ]) {
    const before = f.bytes();
    const r = f.run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, why);
    assert.equal(f.bytes(), before);
  }
});

test("the bare form still settles, and warns only for an outcome a report would carry", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.ok("dispatch", "7", "impl-7");
  const hand = f.run("settle", "impl-5", "PR#6");
  assert.equal(hand.status, 0, hand.stderr);
  assert.match(hand.stderr, /WARNING impl-5=PR#6 settled without --from-report/);
  assert.equal(dispatched(f, "impl-5"), "impl-5=PR#6");
  const killed = f.run("settle", "impl-7", "killed");
  assert.equal(killed.status, 0, killed.stderr);
  assert.doesNotMatch(killed.stderr, /without --from-report/);
});

// A prior run's report is cleared by the dispatch that starts the member's new
// run: `settle --from-report` refuses it, and the new run's own report settles.
test("dispatch clears a prior run's report, so settle refuses it, and the new run's report settles", () => {
  const f = fixture();
  f.report("impl-5", implReport(f));
  f.pr(6, { state: "OPEN", closingIssuesReferences: [ref(5)] });
  renderBrief(f.fleet, "impl-5", { sidecar: { args: { scratch: f.root } } });
  f.ok("dispatch", "5", "impl-5");
  assert.equal(existsSync(join(f.reports, "impl-5.json")), false);
  f.refused("impl-5", 2, /no report at/);
  f.report("impl-5", implReport(f));
  assert.equal(f.settled("impl-5").member, "impl-5");
});
