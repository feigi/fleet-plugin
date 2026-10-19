// `stranded.mjs`: phase 0's stranded-claim step. It lists the open issues
// labelled in-progress with no open PR and classifies each off the `prior`
// verdict `ledger.mjs rotate` recorded — resume, report, or no claim listed —
// and acts on none of them.
//
// Every case runs the real script against a throwaway repository with real
// worktrees and a `gh` stub that logs every call. The process tree is a
// FLEET_PROC_TABLE fixture in which the recorded controller is the test
// runner itself — the script's parent, alive, with the recorded start time —
// so a script that judged the record instead of reading `prior` would answer
// `ancestor` and list no claim.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeExecStub } from "./support/exec-stub.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/stranded.mjs", import.meta.url));
const REPO_URL = "https://github.com/o/r";
const OMP = 2_000_000_001;
const TABLE = {
  [process.pid]: { ppid: OMP, argv: [process.execPath, "--test"], lstart: "runner-start" },
  [OMP]: { ppid: 1, argv: ["bun", "/home/u/.bun/bin/omp"], lstart: "omp-start" },
};
// This runner: a live ancestor of the script whose start time matches.
const RECORD = (prior) => ({ pid: process.pid, lstart: "runner-start", prior, at: Date.now() });

const GH_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
[ -z "$GH_ENV_LOG" ] || printf 'GIT_DIR=%s GH_REPO=%s\\n' "\${GIT_DIR-}" "\${GH_REPO-}" >> "$GH_ENV_LOG"
case "$1 $2" in
  "issue list") [ -z "$GH_ISSUE_FAIL" ] || { echo "issue list boom" >&2; exit 1; }; cat "$FIXTURE_ISSUES" ;;
  "pr list")
    head=""; prev=""
    for a in "$@"; do [ "$prev" = "--head" ] && head="$a"; prev="$a"; done
    if [ -n "$head" ]; then
      [ -z "$GH_HEAD_FAIL" ] || { echo "head list boom" >&2; exit 1; }
      jq -c --arg b "$head" '.[$b] // []' "$FIXTURE_HEADS"; exit 0
    fi
    [ -z "$GH_PR_FAIL" ] || { echo "pr list boom" >&2; exit 1; }; cat "$FIXTURE_PRS" ;;
  *) echo "unexpected gh $*" >&2; exit 3 ;;
esac
`;

const GIT_ENV = { ...process.env };
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

const issue = (n, prs = []) => ({
  number: n, title: `ticket ${n}`, url: `${REPO_URL}/issues/${n}`,
  closedByPullRequestsReferences: prs.map((url) => ({ number: Number(url.split("/").at(-1)), url })),
});
const pr = (number, headRefName) => ({ number, headRefName, url: `${REPO_URL}/pull/${number}` });

// A main checkout with one commit, a worktree per claim it names under
// `.worktrees/`, and the heartbeat file holding `controller` (omitted when
// null, the raw `heartbeat` text when given).
function fixture(t, { controller = null, heartbeat, worktrees = [] } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "stranded-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "root");
  for (const name of worktrees) git(repo, "worktree", "add", "-q", "-b", `implementer/${name}`, join(repo, ".worktrees", name));
  mkdirSync(join(repo, ".fleet"), { recursive: true });
  const beatFile = join(repo, ".fleet", "heartbeat.json");
  if (heartbeat !== undefined) writeFileSync(beatFile, heartbeat);
  else if (controller !== null) writeFileSync(beatFile, JSON.stringify({ quiet: 0, elapsed: 0, digest: "", controller }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "gh"), GH_STUB);
  const tableFile = join(dir, "proc-table.json");
  writeFileSync(tableFile, JSON.stringify(TABLE));
  const ghLog = join(dir, "gh.log");
  writeFileSync(ghLog, "");
  // `heads` maps a branch to what `gh pr list --state all --head <branch>`
  // answers for it: `[{number, state}]`, none for a branch not named.
  const run = ({ issues = [], prs = [], heads = {}, env = {}, cwd = repo, script = SCRIPT } = {}) => {
    writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
    writeFileSync(join(dir, "prs.json"), JSON.stringify(prs));
    writeFileSync(join(dir, "heads.json"), JSON.stringify(heads));
    const r = spawnSync(process.execPath, [script], {
      cwd, encoding: "utf8",
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, FLEET_PROC_TABLE: tableFile, GH_LOG: ghLog,
        FIXTURE_ISSUES: join(dir, "issues.json"), FIXTURE_PRS: join(dir, "prs.json"), FIXTURE_HEADS: join(dir, "heads.json"), ...env,
      },
    });
    r.gh = readFileSync(ghLog, "utf8").split("\n").filter(Boolean);
    r.out = r.status === 0 ? JSON.parse(r.stdout) : null;
    return r;
  };
  return { dir, repo, run };
}

const wt = (f, name) => join(f.repo, ".worktrees", name);

test("prior dead + an in-progress issue with no PR + its worktree in this checkout → resume, naming the worktree and branch", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12"] });
  const r = f.run({ issues: [issue(12)] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, {
    prior: "dead",
    claims: [{ n: 12, t: "ticket 12", action: "resume", worktree: wt(f, "12-impl-12"), branch: "implementer/12-impl-12", why: "its worktree is in this checkout" }],
    carried: [],
  });
  // The same answer from inside a worktree: the checkout is the main one.
  const inside = f.run({ issues: [issue(12)], cwd: wt(f, "12-impl-12") });
  assert.equal(inside.status, 0, inside.stderr);
  assert.deepEqual(inside.out, r.out);
});

test("the classification reads prior, never the record: a record naming a live ancestor with prior dead still resumes", (t) => {
  // RECORD names this runner, the script's parent: judged through the
  // FLEET_PROC_TABLE it would read `ancestor`, and `ancestor` lists no claim.
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12"] });
  const r = f.run({ issues: [issue(12)] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.prior, "dead");
  assert.deepEqual(r.out.claims.map((c) => [c.n, c.action]), [[12, "resume"]]);
});

test("prior dead + no worktree for the claim in this checkout → report; nothing dispatched, no label touched", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["129-impl-129", "16-impl-16", "16-retry", "15-impl-15"] });
  // A worktree registered here but placed outside `.worktrees/`, and one whose
  // directory is gone.
  git(f.repo, "worktree", "add", "-q", "-b", "implementer/14-impl-14", join(f.dir, "elsewhere", "14-impl-14"));
  rmSync(wt(f, "15-impl-15"), { recursive: true, force: true });
  const r = f.run({ issues: [issue(12), issue(14), issue(15), issue(16)] });
  assert.equal(r.status, 0, r.stderr);
  const by = Object.fromEntries(r.out.claims.map((c) => [c.n, c]));
  // #129's worktree is not #12's: the number is matched as a whole segment.
  assert.deepEqual(by[12], { n: 12, t: "ticket 12", action: "report", worktree: null, branch: null, why: "no worktree for it in this checkout" });
  assert.equal(by[14].action, "report");
  assert.match(by[14].why, /outside this checkout's \.worktrees\//);
  assert.equal(by[15].action, "report");
  assert.equal(by[15].why, "no worktree for it in this checkout");
  assert.equal(by[16].action, "report");
  assert.match(by[16].why, /several worktrees/);
  assert.ok(r.out.claims.every((c) => c.action === "report"));
  // Listing is all it does: two reads, no write — and the whole argv is the
  // query, so a widened --state, another --label, a trimmed --json field list
  // or a smaller --limit each changes which claims are classified.
  assert.deepEqual(r.gh, [
    "issue list --label in-progress --state open --json number,title,url,closedByPullRequestsReferences --limit 1000",
    "pr list --state open --json number,headRefName,url --limit 1000",
  ]);
});

test("a number is a whole segment on both sides, whichever separator bounds it — in a worktree name and in a PR branch", (t) => {
  // `12` is not in `112-impl-112` (the leading boundary), and each branch below
  // holds its own issue through a different separator: `/`-then-`-`, `/`-then-`/`,
  // and the name's own start. A boundary dropped on either side fails here.
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["112-impl-112", "16-x"] });
  const r = f.run({
    issues: [issue(12), issue(13), issue(14), issue(15), issue(16)],
    prs: [pr(91, "implementer/13/x"), pr(92, "implementer/14-x"), pr(93, "15-x")],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.claims.map((c) => [c.n, c.action, c.worktree]), [[12, "report", null], [16, "resume", wt(f, "16-x")]]);
  assert.match(r.stderr, /#13 .*open PR #91/);
  assert.match(r.stderr, /#14 .*open PR #92/);
  assert.match(r.stderr, /#15 .*open PR #93/);
});

test("a worktree git calls prunable and one whose directory is gone are each left out, whichever way the other check would answer", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["17-impl-17", "18-impl-18", "19-impl-19"] });
  // #17: the directory is there but its `.git` link is not — git lists it
  // `prunable` though the path exists, so only `prunable` leaves it out.
  rmSync(join(wt(f, "17-impl-17"), ".git"));
  // #18: the directory is gone but the worktree is locked — git withholds
  // `prunable` from a locked one, so only the directory check leaves it out.
  git(f.repo, "worktree", "lock", wt(f, "18-impl-18"));
  rmSync(wt(f, "18-impl-18"), { recursive: true, force: true });
  // #19: whole, the control: the same fixture still finds a worktree.
  const r = f.run({ issues: [issue(17), issue(18), issue(19)] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.claims.map((c) => [c.n, c.action, c.worktree]), [
    [17, "report", null], [18, "report", null], [19, "resume", wt(f, "19-impl-19")],
  ]);
});

test("a locked worktree whose path cannot be stat'd is a refusal — exit 2 — never a claim with no worktree", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads past a directory it has no permission on");
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12"] });
  // Locked, so git does not call it prunable once it cannot reach it, and
  // lists it as live: the one path to the directory check's non-ENOENT case.
  git(f.repo, "worktree", "lock", wt(f, "12-impl-12"));
  const home = join(f.repo, ".worktrees");
  chmodSync(home, 0o000);
  let r;
  try {
    r = f.run({ issues: [issue(12)] });
  } finally {
    chmodSync(home, 0o755);
  }
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /cannot tell whether .*12-impl-12 exists \(EACCES\)/);
});

test("prior ancestor → nothing listed, nothing asked of gh", (t) => {
  const f = fixture(t, { controller: RECORD("ancestor"), worktrees: ["12-impl-12"] });
  const r = f.run({ issues: [issue(12)] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { prior: "ancestor", claims: [], carried: [] });
  assert.deepEqual(r.gh, []);
});

test("prior ancestor → every live token the carried ledger holds, once each, with its row — and nothing settled", (t) => {
  const f = fixture(t, { controller: RECORD("ancestor") });
  writeFileSync(join(f.repo, ".fleet", "ledger.md"), [
    "# Fleet run ledger", "", "## Rows", "",
    "- #3 impl-3=PR#5 → PR#5 · review=member:review-pr-5",
    "- #4 impl-4=PR#6 → PR#6 · review=wf:r1 · reviewed=abc1234:1/0/0:run-abcdefgh · fix-pr-6",
    "- #7 impl-7=PR#8 → PR#8 · review=wf:r2 · reviewed=abc1234:0/0/0:run-bcdefghi · finisher-pr-8 · review=wf:r9",
    "- #12 impl-12 · tier-ok=impl-12:fleet-implementer-slow-high",
    "", "## Dispatched", "",
    "- impl-3=PR#5", "- impl-4=PR#6", "- fix-pr-6", "- impl-7=PR#8", "- finisher-pr-8", "- impl-12", "- merge-bot-1",
    "", "## Filed", "", "", "## Ruled", "", "",
  ].join("\n"));
  const r = f.run({ issues: [issue(12)] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, {
    prior: "ancestor", claims: [],
    carried: [
      { name: "review-pr-5", token: "review=member:review-pr-5", row: "#3" },
      { name: "fix-pr-6", token: "fix-pr-6", row: "#4" },
      { name: "finisher-pr-8", token: "finisher-pr-8", row: "#7" },
      { name: "r9", token: "review=wf:r9", row: "#7" },
      { name: "impl-12", token: "impl-12", row: "#12" },
      { name: "merge-bot-1", token: "merge-bot-1", row: null },
    ],
  });
  assert.deepEqual(r.gh, []);
});

test("prior ancestor with a ledger that cannot be read exits 2 — never nothing carried", (t) => {
  const f = fixture(t, { controller: RECORD("ancestor") });
  mkdirSync(join(f.repo, ".fleet", "ledger.md"));
  const r = f.run();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /ledger\.mjs read failed .* which tokens rotate carried is unknown/);
  assert.equal(r.stdout, "");
});

test("prior none, no record, or a heartbeat file that cannot be read → every claim reported, none resumed", (t) => {
  for (const setup of [
    { controller: RECORD("none") },
    {},
    { heartbeat: JSON.stringify({ quiet: 0 }) },
    { heartbeat: "{ not json" },
  ]) {
    const f = fixture(t, { ...setup, worktrees: ["12-impl-12"] });
    const r = f.run({ issues: [issue(12), issue(13)] });
    assert.equal(r.status, 0, `${JSON.stringify(setup)}: ${r.stderr}`);
    assert.equal(r.out.prior, "none");
    assert.deepEqual(r.out.claims.map((c) => [c.n, c.action]), [[12, "report"], [13, "report"]], JSON.stringify(setup));
    assert.equal(r.out.claims[0].worktree, wt(f, "12-impl-12"), "a report still names the worktree it found");
    assert.match(r.out.claims[0].why, /no record proves the previous run dead/);
  }
});

test("an in-progress issue with an open PR is never listed — linked, branch-named, or linked from another repository", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["20-impl-20", "21-impl-21", "22-impl-22", "23-impl-23"] });
  const r = f.run({
    issues: [
      issue(20, [`${REPO_URL}/pull/90`]),
      issue(21),
      issue(22, ["https://github.com/other/fork/pull/5"]),
      // Its only linked PR is closed or merged: it is stranded, and listed.
      issue(23, [`${REPO_URL}/pull/93`]),
    ],
    prs: [pr(90, "fix/something"), pr(91, "implementer/21-impl-21")],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.claims.map((c) => [c.n, c.action]), [[23, "resume"]]);
  assert.match(r.stderr, /#20 .*open PR #90/);
  assert.match(r.stderr, /#21 .*open PR #91/);
  assert.match(r.stderr, /#22 .*other\/fork#5/);
});

test("a PR branch that merely ends in an issue's number does not own it: the claim is reported with that PR named, never dropped or resumed", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["20-impl-20"] });
  const r = f.run({ issues: [issue(20)], prs: [pr(901, "implementer/1799-bump-node-20")] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.claims.map((c) => [c.n, c.action, c.worktree]), [[20, "report", wt(f, "20-impl-20")]]);
  assert.match(r.out.claims[0].why, /open PR #901 \(branch implementer\/1799-bump-node-20\)/);
});

test("a list that did not answer, or came back at its cap, is a refusal — exit 2 — never nothing stranded", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12"] });
  for (const env of [{ GH_ISSUE_FAIL: "1" }, { GH_PR_FAIL: "1" }]) {
    const r = f.run({ issues: [issue(12)], env });
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /boom/);
  }
  const many = Array.from({ length: 1000 }, (_, i) => i + 1);
  const issuesAtCap = f.run({ issues: many.map((n) => issue(n)) });
  assert.equal(issuesAtCap.status, 2);
  assert.match(issuesAtCap.stderr, /cap/);
  const prsAtCap = f.run({ issues: [issue(12)], prs: many.map((n) => pr(5000 + n, `x/${n}`)) });
  assert.equal(prsAtCap.status, 2);
  assert.match(prsAtCap.stderr, /cap/);
});

test("prior dead + a claim whose branch's PR closed unmerged, none open → report naming the PR, in place of the resume", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12", "13-impl-13", "14-impl-14"] });
  const r = f.run({
    issues: [issue(12), issue(13), issue(14)],
    heads: {
      "implementer/12-impl-12": [{ number: 40, state: "CLOSED" }],
      "implementer/13-impl-13": [{ number: 41, state: "CLOSED" }, { number: 44, state: "CLOSED" }],
      "implementer/14-impl-14": [{ number: 42, state: "MERGED" }],
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.claims, [
    { n: 12, t: "ticket 12", action: "report", worktree: wt(f, "12-impl-12"), branch: "implementer/12-impl-12", why: "PR #40 closed unmerged" },
    { n: 13, t: "ticket 13", action: "report", worktree: wt(f, "13-impl-13"), branch: "implementer/13-impl-13", why: "PR #44 closed unmerged" },
    { n: 14, t: "ticket 14", action: "resume", worktree: wt(f, "14-impl-14"), branch: "implementer/14-impl-14", why: "its worktree is in this checkout" },
  ]);
  // One probe per claim with a branch, every state, after the two lists.
  assert.deepEqual(r.gh.slice(2), [12, 13, 14].map((n) => `pr list --state all --head implementer/${n}-impl-${n} --json number,state --limit 1000`));
});

test("prior dead + a claim whose branch never opened a PR still resumes; one whose closed PR has an open or a merged sibling is not a closed-PR report", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12", "13-impl-13", "14-impl-14"] });
  const r = f.run({
    issues: [issue(12), issue(13), issue(14)],
    heads: {
      "implementer/13-impl-13": [{ number: 41, state: "CLOSED" }, { number: 45, state: "OPEN" }],
      "implementer/14-impl-14": [{ number: 43, state: "CLOSED" }, { number: 46, state: "MERGED" }],
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.claims.map((c) => [c.n, c.action, c.why]), [
    [12, "resume", "its worktree is in this checkout"],
    [13, "resume", "its worktree is in this checkout"],
    [14, "resume", "its worktree is in this checkout"],
  ]);
});

test("prior dead + a claim whose worktree is detached → report, never resume: its branch cannot be asked about", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12"] });
  git(wt(f, "12-impl-12"), "checkout", "-q", "--detach");
  const r = f.run({ issues: [issue(12)] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.claims, [{
    n: 12, t: "ticket 12", action: "report", worktree: wt(f, "12-impl-12"), branch: null,
    why: "its worktree is detached, so whether its branch opened a PR cannot be told — nothing is resumed",
  }]);
  // No branch, so no head probe: only the two lists.
  assert.equal(r.gh.length, 2);
});

test("prior dead + a branch probe that does not answer → report, never resume — and never a refusal of the step", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12"] });
  const failed = f.run({ issues: [issue(12)], env: { GH_HEAD_FAIL: "1" } });
  assert.equal(failed.status, 0, failed.stderr);
  assert.deepEqual(failed.out.claims.map((c) => [c.n, c.action, c.worktree]), [[12, "report", wt(f, "12-impl-12")]]);
  assert.match(failed.out.claims[0].why, /^gh pr list --head implementer\/12-impl-12 did not answer \(exit 1: head list boom\) — whether its branch opened a PR is unknown, so nothing is resumed$/);
  for (const [what, answer] of [
    ["a PR with no state", [{ number: 40 }]],
    ["a PR with no number", [{ state: "CLOSED" }]],
    ["a PR whose number is a string", [{ number: "40", state: "CLOSED" }]],
    ["not a list", { number: 40, state: "CLOSED" }],
  ]) {
    const r = f.run({ issues: [issue(12)], heads: { "implementer/12-impl-12": answer } });
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.deepEqual(r.out.claims.map((c) => [c.n, c.action]), [[12, "report"]], what);
    assert.match(r.out.claims[0].why, /did not answer \(not a list of \{number, state\}\)/, what);
  }
  // A list at its cap may hold an OPEN PR it did not show; one short of it is
  // a whole answer.
  const closedRows = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, state: "CLOSED" }));
  const atCap = f.run({ issues: [issue(12)], heads: { "implementer/12-impl-12": closedRows(1000) } });
  assert.equal(atCap.status, 0, atCap.stderr);
  assert.deepEqual(atCap.out.claims.map((c) => [c.n, c.action]), [[12, "report"]]);
  assert.match(atCap.out.claims[0].why, /did not answer \(at its cap of 1000\)/);
  const underCap = f.run({ issues: [issue(12)], heads: { "implementer/12-impl-12": closedRows(999) } });
  assert.equal(underCap.status, 0, underCap.stderr);
  assert.deepEqual(underCap.out.claims.map((c) => [c.n, c.action, c.why]), [[12, "report", "PR #999 closed unmerged"]]);
});

test("prior none never probes a branch: nothing resumes, so there is nothing to tell apart", (t) => {
  const f = fixture(t, { controller: RECORD("none"), worktrees: ["12-impl-12"] });
  const r = f.run({ issues: [issue(12)], heads: { "implementer/12-impl-12": [{ number: 40, state: "CLOSED" }] } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.claims.map((c) => [c.n, c.action, c.why]), [[12, "report", "no record proves the previous run dead, so nothing is resumed"]]);
  assert.equal(r.gh.length, 2);
});

test("stranded.mjs takes no stray argument", (t) => {
  const f = fixture(t, { controller: RECORD("dead") });
  const r = spawnSync(process.execPath, [SCRIPT, "--resume"], { cwd: f.repo, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
});

test("an ambient GIT_DIR naming another repository does not change the answer", (t) => {
  // The worktree listing is what this pins: with GIT_DIR reaching it, git
  // lists the other repository's worktrees, which hold none of this claim's.
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12"] });
  const other = join(f.dir, "other");
  mkdirSync(other);
  git(other, "init", "-q");
  const r = f.run({ issues: [issue(12)], env: { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.claims.map((c) => [c.n, c.action, c.worktree]), [[12, "resume", wt(f, "12-impl-12")]]);
});

test("gh is run with no ambient GIT_DIR or GH_REPO, which would answer for another repository's tracker", (t) => {
  const f = fixture(t, { controller: RECORD("dead"), worktrees: ["12-impl-12"] });
  const envLog = join(f.dir, "gh-env.log");
  const r = f.run({ issues: [issue(12)], env: { GIT_DIR: join(f.dir, "nowhere", ".git"), GH_REPO: "other/repo", GH_ENV_LOG: envLog } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(envLog, "utf8").trim().split("\n"), ["GIT_DIR= GH_REPO=", "GIT_DIR= GH_REPO=", "GIT_DIR= GH_REPO="],
    "the issue list, the open-PR list and the claim's branch probe");
});

// `ledger.mjs read` is the ledger's own parser, so its stdout is only wrong
// when the two scripts drift apart. Run a copy of the scripts directory whose
// ledger.mjs prints `stdout`, so the answer carriedTokens must refuse can be
// fed to it.
for (const [name, stdout] of [
  ["output that is not JSON", "not json"],
  ["JSON with no rows", JSON.stringify({ filed: [], ruled: [], dispatched: [] })],
  ["rows that are not strings", JSON.stringify({ rows: [1], filed: [], ruled: [], dispatched: [] })],
  ["no dispatched list", JSON.stringify({ rows: [] })],
  ["null", "null"],
]) {
  test(`prior ancestor with a ledger read that answers ${name} exits 2 — never nothing carried`, (t) => {
    const f = fixture(t, { controller: RECORD("ancestor") });
    const scripts = join(f.dir, "scripts");
    cpSync(dirname(SCRIPT), scripts, { recursive: true });
    writeFileSync(join(scripts, "ledger.mjs"), `process.stdout.write(${JSON.stringify(stdout)});\n`);
    const r = f.run({ script: join(scripts, "stranded.mjs") });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /could not parse ledger\.mjs read output|ledger\.mjs read returned no \{rows, dispatched\}/);
    assert.equal(r.stdout, "");
  });
}
