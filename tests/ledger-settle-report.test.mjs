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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { rendering } from "./support/rendered-brief.mjs";
import { scratchRoot } from "../plugin/scripts/fleet-dir.mjs";

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
  const file = join(fleet, "ledger.md");
  const reports = join(root, "reports");
  mkdirSync(reports);
  const ghDir = join(root, "gh");
  mkdirSync(ghDir);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(root, "gh.log")}'
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
  const pr = (n, body) => writeFileSync(join(ghDir, `${n}.json`), JSON.stringify(body));
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
  return { root, work, file, reports, env, git, head, stray, run, cli, ok, bytes, report, pr, settle, settled, refused };
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
  member: "merge-bot-1", merged: [{ pr: 6, sha: f.head }, { pr: 7, sha: f.head }], held: [], conflictHold: [], refused: [], branchKept: [], ...over,
});

const dispatched = (f, member) => f.ok("read").dispatched.find((e) => e.split("=")[0] === member);

// -- impl-N=PR#M --------------------------------------------------------------

test("impl-N=PR#M: a head on the branch and an OPEN PR closing N settles", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  f.pr(6, { state: "OPEN", closingIssuesReferences: [{ number: 5 }] });
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
  assert.match(readFileSync(join(f.root, "gh.log"), "utf8"), /^pr view 6 --json state,closingIssuesReferences$/m);
});

test("impl-N=PR#M: a head verify-sha.sh does not find on the branch is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f, { head: f.stray }));
  f.pr(6, { state: "OPEN", closingIssuesReferences: [{ number: 5 }] });
  f.refused("impl-5", 3, new RegExp(`failed: verify-sha\\.sh feat ${f.stray} exits 0`));
});

test("impl-N=PR#M: a PR that is not OPEN is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  f.pr(6, { state: "CLOSED", closingIssuesReferences: [{ number: 5 }] });
  f.refused("impl-5", 3, /failed: PR #6 reads OPEN/);
});

test("impl-N=PR#M: a PR that does not close ticket N is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  f.pr(6, { state: "OPEN", closingIssuesReferences: [{ number: 55 }] });
  f.refused("impl-5", 3, /failed: PR #6 closes #5/);
});

test("could not look: a gh that fails is exit 2, not a failed check", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.report("impl-5", implReport(f));
  // No answer file for PR 6: the stub exits 1, as gh does when it cannot reach GitHub.
  f.refused("impl-5", 2, /could not look — gh pr view 6 --json state,closingIssuesReferences exited 1: gh stub: no PR 6/);
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
  f.ok("dispatch", "6", "finisher-pr-6");
  f.ok("dispatch", "merge-bot");
  f.report("impl-5", implReport(f));
  f.report("finisher-pr-6", finisherReport(f));
  f.report("merge-bot-1", botReport(f, { merged: [{ pr: 7, sha: f.head }] }));
  for (const body of [{}, { closingIssuesReferences: [{ number: 5 }] }, { state: "OPEN", closingIssuesReferences: null }, { state: "OPEN" }]) {
    f.pr(6, body);
    f.refused("impl-5", 2, /could not look — gh pr view 6 --json state,closingIssuesReferences answered without a usable/);
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
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f));
  f.pr(6, { labels: [{ name: "patch" }] });
  f.refused("finisher-pr-6", 3, /failed: PR #6 carries ready-to-merge/);
});

test("finisher-pr-M=labelled: a read-back without ready-to-merge is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f, { labelsReadBack: ["patch"] }));
  f.pr(6, { labels: [{ name: "patch" }, { name: "ready-to-merge" }] });
  f.refused("finisher-pr-6", 3, /failed: labelsReadBack carries ready-to-merge/);
});

// -- finisher-pr-M=halted:<cause> ---------------------------------------------

test("finisher-pr-M=halted:<cause>: a cause and its evidence settle, and unrecorded filings reach ## Filed", () => {
  const f = fixture();
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

test("finisher-pr-M=halted:<cause>: a null cause is exit 3", () => {
  const f = fixture();
  f.ok("dispatch", "6", "finisher-pr-6");
  f.report("finisher-pr-6", finisherReport(f, { outcome: "halted", cause: null, evidence: "something", labelsReadBack: [] }));
  f.refused("finisher-pr-6", 3, /failed: cause null is in the halted:<cause> vocabulary/);
});

test("finisher-pr-M=halted:<cause>: empty evidence is exit 3", () => {
  const f = fixture();
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

test("merge-bot-n=done: a pass that merged nothing settles with no check", () => {
  const f = fixture();
  f.ok("dispatch", "merge-bot");
  f.report("merge-bot-1", botReport(f, { merged: [] }));
  assert.deepEqual(f.settled("merge-bot-1").checks, []);
});

// -- the report itself --------------------------------------------------------

test("an invalid report is exit 2 naming the violation, one family at a time", () => {
  const f = fixture();
  f.ok("dispatch", "5", "impl-5");
  f.ok("dispatch", "6", "fix-pr-6");
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
  f.ok("dispatch", "6", "finisher-pr-6");
  for (const issue of [-3, 0]) {
    f.report("finisher-pr-6", finisherReport(f, { outcome: "halted", cause: "other", evidence: "e", labelsReadBack: [], unrecorded: [{ issue, subject: "neg" }] }));
    f.refused("finisher-pr-6", 2, new RegExp(`\\$\\.unrecorded\\[0\\]\\.issue: ${issue} is below minimum 1; nothing written`));
  }
  assert.equal(existsSync(join(f.root, "gh.log")), false, "no gh call came first");
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
  f.pr(6, { state: "OPEN", closingIssuesReferences: [{ number: 5 }] });
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

test("a failed report settles =failed with no check", () => {
  const f = fixture();
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
