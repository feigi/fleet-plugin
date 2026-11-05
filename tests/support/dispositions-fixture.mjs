// The fixture dispositions-check.test.mjs and ledger-dispositions.test.mjs
// share: a real git repository built in a temp dir — `origin/main` a ref, the
// PR head one commit past it — so the touched lines are git's own answer, not
// a fixture's restatement of one; a fleet run's ledger that PR 40's fix-applier
// was dispatched on; and the tracker, a `gh` stub first on PATH answering
// `issue view` and `pr view` from JSON files the fixture writes, so no case
// reaches the network. Each test file adds its own runner: the standalone CLI
// there, the `ledger.mjs dispositions` verb here.

import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDispositions, formatViolation } from "../../plugin/scripts/dispositions-check.mjs";
import { rendering } from "./rendered-brief.mjs";
import { ref, prUrl } from "./queue-gh.mjs";
import { seedLabelMap } from "./label-map-seed.mjs";
import { LABEL_ROLES } from "../../plugin/scripts/label-map.mjs";

export const LEDGER = fileURLToPath(new URL("../../plugin/scripts/ledger.mjs", import.meta.url));

// The `gh` stub: `issue view <n> --json labels,state,title` (or `--json
// title,labels`)
// answered from FAKE_GH_ISSUES, an issue it does not hold answered the way gh
// answers one that does not exist. `pr view <n> --json
// closingIssuesReferences,url,headRefName` answered from FAKE_GH_PRS, a PR it
// does not hold with no references, in queue-gh.mjs's own repository, headed
// by a branch that is no claim's; `pr view <n> --json labels` answered from
// FAKE_GH_PRS too, a PR it does not hold carrying `patch`.
// FAKE_GH_DOWN answers every call as an unreachable API. FAKE_GH_LOG, when set,
// gets one line per call: its argv, cwd and GIT_DIR.
const GH_STUB = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const { FAKE_GH_ISSUES, FAKE_GH_DOWN, FAKE_GH_LOG, FAKE_GH_PRS } = process.env;
if (FAKE_GH_LOG) fs.appendFileSync(FAKE_GH_LOG, JSON.stringify({ argv, cwd: process.cwd(), GIT_DIR: process.env.GIT_DIR ?? null }) + "\\n");
if (FAKE_GH_DOWN) { process.stderr.write("error connecting to api.github.com\\n"); process.exit(1); }
const [cmd, sub, n, flag, fields] = argv;
if (argv.length === 5 && cmd === "pr" && sub === "view" && flag === "--json" && fields === "closingIssuesReferences,url,headRefName") {
  const prs = JSON.parse(fs.readFileSync(FAKE_GH_PRS, "utf8"));
  process.stdout.write(JSON.stringify({ closingIssuesReferences: prs[n]?.closingIssuesReferences ?? [], url: ${JSON.stringify(prUrl(""))} + n, headRefName: "feature/topic" }));
  process.exit(0);
}
if (argv.length === 5 && cmd === "pr" && sub === "view" && flag === "--json" && fields === "labels") {
  const prs = JSON.parse(fs.readFileSync(FAKE_GH_PRS, "utf8"));
  process.stdout.write(JSON.stringify({ labels: (prs[n]?.labels ?? ["patch"]).map((name) => ({ name })) }));
  process.exit(0);
}
// FAKE_GH_HOOK, a JSON argv, is run on each issue view before it is answered: another writer acting while the tracker is read.
if (process.env.FAKE_GH_HOOK && cmd === "issue") {
  const [bin, ...args] = JSON.parse(process.env.FAKE_GH_HOOK);
  require("node:child_process").execFileSync(bin, args, { stdio: ["ignore", "ignore", "inherit"] });
}
if (argv.length !== 5 || cmd !== "issue" || sub !== "view" || flag !== "--json" || (fields !== "labels,state,title" && fields !== "title,labels")) {
  process.stderr.write("gh stub: unexpected call " + JSON.stringify(argv) + "\\n");
  process.exit(2);
}
const issue = JSON.parse(fs.readFileSync(FAKE_GH_ISSUES, "utf8"))[n];
if (!issue) {
  process.stderr.write("GraphQL: Could not resolve to an issue or pull request with the number of " + n + ". (repository.issue)\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ labels: issue.labels.map((name) => ({ name })), state: issue.state, title: issue.title }));
`;
export const openIssue = (label) => ({ state: "OPEN", title: "a deferred finding", labels: [label] });
// The identity Label map as the pure core takes it: every role its own name.
export const IDENTITY = Object.fromEntries(LABEL_ROLES.map((role) => [role, role]));
// The three roles this check reads, remapped: no mapped string is a role name.
export const REMAP = { "needs-triage": "triage", "ready-for-agent": "agent-ready", wontfix: "wont-fix" };

export const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
};

export function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: cleanEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }),
  }).trim();
}

export const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

// A repository whose `origin/main` holds src/a.js (20 lines) and src/b.js,
// and whose PR head rewrites src/a.js lines 5-6 and appends line 21. Lines
// 1-4 and 7-20 are untouched; src/b.js is not in the diff at all.
// `labelMap` is seedLabelMap's overrides for the repository's `.fleet/labels.json`;
// null seeds none.
export function fixture(t, { labelMap = {} } = {}) {
  // `dir` sits in `root` as a run's `.fleet/` sits in its main checkout, so
  // the ledger in `dir` reads `root`'s tier-outcomes file, which holds PR 40's
  // ruling: every finisher dispatched here turns on its dispositions verdict.
  const root = mkdtempSync(join(tmpdir(), "dispositions-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "run");
  mkdirSync(dir);
  git(dir, "init", "-q");
  // The ledger in `dir` is a fleet run's, dispatched against: a finisher
  // dispatch reads this repository's Label map. No standalone check looks at
  // a ledger at that path, so one must leave it byte-identical.
  if (labelMap !== null) seedLabelMap(dir);
  mkdirSync(join(root, "docs", "metrics"), { recursive: true });
  writeFileSync(join(root, "docs", "metrics", "tier-outcomes.tsv"), "2026-10-21\t40\t10\troutine\tslow-high\tyes\tno\truled\n");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.js"), lines(20, "a"));
  writeFileSync(join(repo, "src", "b.js"), lines(10, "b"));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const a = lines(20, "a").split("\n");
  a[4] = "a 5 changed";
  a[5] = "a 6 changed";
  a.splice(20, 0, "a 21 added");
  writeFileSync(join(repo, "src", "a.js"), a.join("\n"));
  git(repo, "commit", "-qam", "pr");
  const head = git(repo, "rev-parse", "HEAD");
  // After the commits: the cache is no part of the PR's diff or its base.
  if (labelMap !== null) seedLabelMap(repo, labelMap);

  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  const ledger = join(dir, "ledger.md");
  const bin = join(dir, "bin");
  const issuesFile = join(dir, "issues.json");
  const prsFile = join(dir, "prs.json");
  // The `gh` stub first on PATH, and the tracker files it answers from.
  const stubEnv = (base) => ({ ...base, PATH: `${bin}:${base.PATH ?? ""}`, FAKE_GH_ISSUES: issuesFile, FAKE_GH_PRS: prsFile });
  const ledgerCli = rendering(dir, (...args) => spawnSync(process.execPath, [LEDGER, "--file", ledger, ...args], { encoding: "utf8", env: stubEnv(cleanEnv()) }));
  const okLedger = (...args) => {
    const r = ledgerCli(...args);
    assert.equal(r.status, 0, `ledger ${args.join(" ")}: exit ${r.status}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  // The review's own run root, as review-core.mjs's snapshot step makes it
  // and the latest `reviewed=` names it.
  const run = "run-Rv40Aa01";
  okLedger("row", "10", "impl-10=PR#40 → PR#40");
  okLedger("review", "40", "review=member:review-pr-40", `reviewed=${head}:2/1/1:${run}`);
  okLedger("dispatch", "40", "fix-pr-40");
  okLedger("settle", "fix-pr-40", `applied:${head.slice(0, 7)}`);

  const finding = (file, line, severity = "important") => ({ severity, file, line, claim: "c", evidence: "e" });
  const review = {
    pr: 40, head, snapshot: join(dir, "snap"),
    counts: { survived: 2, refuted: 1, unverified: 1, crashed: 0 },
    // survived[0] on a touched line; survived[1] on an untouched one.
    survived: [finding("src/a.js", 5), finding("src/a.js", 12)],
    refuted: [finding("src/b.js", 3)],
    unverified: [finding("src/a.js", 15, "suggestion")],
  };
  const reviewPath = join(scratch, "pr40", run, "review.json");
  mkdirSync(join(scratch, "pr40", run), { recursive: true });
  const writeReview = (r = review) => writeFileSync(reviewPath, JSON.stringify(r));
  writeReview();
  // The review above is PR 40's first review, so its record carries a Charge
  // on every standing entry: a survived or refuted one is charged none, for a
  // reason, unless a case says otherwise. An unverified one carries none.
  const CHARGED = { charge: "none", chargeReason: "defect-outside-acceptance" };
  const entry = (bucket, index, more = {}) => ({
    bucket, index, scope: "in", claimKind: "behavior", disposition: "apply", ...(bucket === "unverified" ? {} : CHARGED), ...more,
  });
  // Every finding answered, every in-scope survivor applied, the out-of-scope
  // suggestion checked by its refuter, which let it survive, and filed open
  // `needs-triage` (row 6b): an ok record.
  const baseEntries = () => [entry("survived", 0), entry("survived", 1),
    entry("unverified", 0, { scope: "out", disposition: "defer", issue: 77, verdictPath: writeVerdict({ refuted: false, reason: "the claim held" }, "0") })];
  // One record per fix-applier, named by the member that wrote it.
  const recordPath = (member = "fix-pr-40") => join(scratch, `dispositions-${member}.json`);
  const writeRecord = (entries, recHead = head, member = "fix-pr-40", recRun = run) =>
    writeFileSync(recordPath(member), JSON.stringify({ head: recHead, run: recRun, entries }));

  // The tracker the `gh` stub answers from, issue number → {state, title, labels}.
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB, { mode: 0o755 });
  // 77 is the base record's row-6b home; 81 the row-1 home a deferred survivor
  // in these cases is filed to.
  const issues = { 10: openIssue("ready-for-agent"), 77: openIssue("needs-triage"), 81: openIssue("ready-for-agent") };
  // PR 40 closes its ticket 10 by default; a test that needs otherwise rewrites this file.
  writeFileSync(prsFile, JSON.stringify({ 40: { closingIssuesReferences: [ref(10)] } }));
  const setIssues = (more) => {
    Object.assign(issues, more);
    writeFileSync(issuesFile, JSON.stringify(issues));
  };
  setIssues({});
  // Any env, with the stub first on PATH.
  const env = (base = cleanEnv(), extra = {}) => ({ ...stubEnv(base), ...extra });
  // A refuter verdict under the fix-applier's run root, as step 2 writes it;
  // `value` an object written as JSON, or a string written as it stands.
  const writeVerdict = (value, finding = "1", runRoot = join(scratch, "pr40", "fix-Ab12Cd34")) => {
    const path = join(runRoot, finding, "verdict.json");
    mkdirSync(join(runRoot, finding), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };

  return {
    dir, repo, head, run, scratch, ledger, review, reviewPath, writeReview, entry, baseEntries, recordPath, writeRecord, ledgerCli, okLedger,
    env, setIssues, writeVerdict,
  };
}

export const mismatch = (r, re) => {
  assert.equal(r.status, 1, `expected a mismatch, got exit ${r.status}\n${r.stderr}`);
  assert.equal(r.json.verdict, "mismatch");
  if (re) assert.match(r.stderr, re);
};
export const okVerdict = (r) => {
  assert.equal(r.status, 0, `expected ok, got exit ${r.status}\n${r.stderr}`);
  assert.equal(r.json.verdict, "ok");
};

// The pure core, on one review: survived[0] on touched src/a.js:5, one refuted finding.
export const H40 = "abc1234abc1234abc1234abc1234abc1234abcde";
// `issues` the tracker by number — an issue it does not hold is an open
// `ready-for-agent` one — and `verdicts` the refuter verdicts by path.
export const coreRun = (entries, {
  head = H40, reviewHead = H40, survived = [{ file: "src/a.js", line: 5 }], unverified = [], record, diffFiles = ["src/a.js"],
  issues = {}, verdicts = {}, charges = false, roles = IDENTITY, answers = new Map(),
} = {}) => checkDispositions({
  review: { head: reviewHead, survived, unverified, refuted: [{ file: "src/b.js", line: 1 }] },
  record: record === undefined ? { head, entries } : record,
  touched: new Map([["src/a.js", new Set([5])]]),
  diffFiles,
  roots: ["/snap"],
  filing: {
    pr: 40, roles,
    issue: (n) => issues[n] ?? { state: "OPEN", title: "a deferred finding", labels: ["ready-for-agent"] },
    verdict: (p) => verdicts[p] ?? { problem: "names no file that exists" },
  },
  charges, answers,
});
export const core = (entries, opts) => coreRun(entries, opts).violations.map(formatViolation);
export const applied = { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "apply" };

export const escalated = (r) => {
  assert.equal(r.status, 1, `expected an escalation, got exit ${r.status}\n${r.stderr}`);
  assert.equal(r.json.verdict, "escalate");
};
// survived[0], on touched line 5, deferred remedy-outside-diff.
export const deferOutside = (f, remedyFiles, recHead) => {
  const entries = f.baseEntries();
  entries[0] = f.entry("survived", 0, { disposition: "defer", reason: "remedy-outside-diff", issue: 81, remedyFiles });
  f.writeRecord(entries, recHead);
};
export const withSeverity = (f, severity) => f.writeReview({ ...f.review, survived: [{ ...f.review.survived[0], severity }, f.review.survived[1]] });
