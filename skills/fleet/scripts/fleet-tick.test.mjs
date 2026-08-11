// Regression gate for the reconcile tick. Zero deps:
//   ./agent-test skills/fleet/scripts/fleet-tick.test.mjs
//
// The pure half locks the queue-depth guard table — the whole point of #3 is
// that the table stops being prose the controller must remember, so a
// "simplification" that drops a row has to go red here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, formatLines } from "./fleet-tick.mjs";

// Every field named, so a test that cares about one number still states the
// rest — a defaulted field is a guard nobody is pinning.
const state = (over = {}) => ({
  implLive: 0, reviewerLive: 0, mergeBotLive: 0,
  pool: 0, supply: 0, reviewBacklog: 0, mergeQueue: 0,
  implCap: 2, reviewerCap: 5,
  ...over,
});
const row = (s, role) => reconcile(s).find((r) => r.role === role);

test("implementers: drained queue with pool and no backlog dispatches", () => {
  const r = row(state({ implLive: 0, pool: 3, reviewBacklog: 0 }), "implementers");
  assert.equal(r.actual, 0);
  assert.equal(r.target, 2);
  assert.equal(r.action, "DISPATCH 2");
});

test("implementers: dispatch is capped by the pool, not just the deficit", () => {
  const r = row(state({ implLive: 0, pool: 1, implCap: 5 }), "implementers");
  assert.equal(r.action, "DISPATCH 1");
});

test("implementers: dispatch never takes live past the cap", () => {
  for (const implCap of [1, 2, 5]) {
    for (const implLive of [0, 1, 2, 5]) {
      const r = row(state({ implLive, pool: 99, implCap }), "implementers");
      const n = Number((r.action.match(/^DISPATCH (\d+)$/) || [])[1] ?? 0);
      // Either dispatch nothing, or land at or under the cap. Stated as an
      // alternative rather than `live + n <= cap` because a controller that
      // already reports MORE live than the cap must not have its overshoot
      // read as licence to dispatch, nor the row assert its way out of it.
      assert.ok(n === 0 || implLive + n <= implCap, `cap ${implCap} live ${implLive} → ${r.action}`);
    }
  }
});

test("implementers: review backlog of 2 holds the refill even with pool left", () => {
  const r = row(state({ implLive: 0, pool: 3, reviewBacklog: 2 }), "implementers");
  assert.equal(r.action, "HOLD");
  assert.match(r.detail, /review-backlog=2/);
});

test("implementers: backlog 1 is below the gate and still dispatches", () => {
  const r = row(state({ implLive: 0, pool: 3, reviewBacklog: 1 }), "implementers");
  assert.equal(r.action, "DISPATCH 2");
});

test("implementers: the backlog hold outranks every pool-0 branch", () => {
  // Re-shortlisting to enable a dispatch that is being held buys nothing, and a
  // /triage suggestion under a hold is noise the controller would act on.
  for (const supply of [0, 1, 99]) {
    const r = row(state({ implLive: 0, pool: 0, supply, reviewBacklog: 2 }), "implementers");
    assert.equal(r.action, "HOLD", `supply ${supply}`);
  }
});

test("implementers: at cap, nothing is dispatched however deep the pool", () => {
  const r = row(state({ implLive: 2, implCap: 2, pool: 99 }), "implementers");
  assert.equal(r.action, "AT CAP");
});

test("implementers: over cap still refuses, and the row shows the overshoot", () => {
  const r = row(state({ implLive: 3, implCap: 2, pool: 99 }), "implementers");
  assert.equal(r.action, "AT CAP");
  assert.equal(r.actual, 3);
  assert.equal(r.target, 2);
});

test("implementers: pool 0, supply >= cap re-shortlists without suggesting triage", () => {
  const r = row(state({ pool: 0, supply: 2, implCap: 2 }), "implementers");
  assert.equal(r.action, "RE-SHORTLIST");
  assert.doesNotMatch(r.action, /triage/);
});

test("implementers: pool 0, 0 < supply < cap re-shortlists AND suggests triage", () => {
  const r = row(state({ pool: 0, supply: 1, implCap: 2 }), "implementers");
  assert.equal(r.action, "RE-SHORTLIST + SUGGEST /triage");
});

test("implementers: pool 0 and supply 0 suggests triage and holds idle", () => {
  const r = row(state({ pool: 0, supply: 0 }), "implementers");
  assert.equal(r.action, "SUGGEST /triage");
  assert.match(r.detail, /idle/);
});

test("implementers: detail always carries the three numbers the branch turned on", () => {
  const r = row(state({ pool: 4, supply: 57, reviewBacklog: 1 }), "implementers");
  assert.match(r.detail, /pool=4/);
  assert.match(r.detail, /supply=57/);
  assert.match(r.detail, /review-backlog=1/);
});

test("reviewers: no PRs queued for review is idle, not a deficit", () => {
  const r = row(state({ reviewerLive: 0, reviewBacklog: 0 }), "reviewers");
  assert.equal(r.actual, 0);
  assert.equal(r.target, 5);
  assert.equal(r.action, "IDLE OK");
});

test("reviewers: dispatch is the smaller of the free slots and the backlog", () => {
  assert.equal(row(state({ reviewerLive: 0, reviewBacklog: 2 }), "reviewers").action, "DISPATCH 2");
  assert.equal(row(state({ reviewerLive: 4, reviewBacklog: 9 }), "reviewers").action, "DISPATCH 1");
  assert.equal(row(state({ reviewerLive: 5, reviewBacklog: 9 }), "reviewers").action, "AT CAP");
});

test("merge-bot: a queued ready-to-merge PR with no bot live dispatches one", () => {
  const r = row(state({ mergeBotLive: 0, mergeQueue: 3 }), "merge-bot");
  assert.equal(r.actual, 0);
  assert.equal(r.target, 1);
  assert.equal(r.action, "DISPATCH merge-bot");
  assert.match(r.detail, /merge-queue=3/);
});

test("merge-bot: never a second bot, however deep the merge queue", () => {
  assert.equal(row(state({ mergeBotLive: 1, mergeQueue: 9 }), "merge-bot").action, "AT CAP");
});

test("merge-bot: an empty merge queue is idle", () => {
  assert.equal(row(state({ mergeBotLive: 0, mergeQueue: 0 }), "merge-bot").action, "IDLE OK");
});

test("merge-queue depth never gates the implementer refill", () => {
  // run-team is explicit that the refill gate is the REVIEW backlog and never
  // the merge queue; a deep ready-to-merge queue costs no extra rebases per PR.
  const shallow = row(state({ pool: 3, mergeQueue: 0 }), "implementers");
  const deep = row(state({ pool: 3, mergeQueue: 20 }), "implementers");
  assert.equal(shallow.action, deep.action);
});

test("reconcile returns exactly the three roles, in a stable order", () => {
  assert.deepEqual(reconcile(state()).map((r) => r.role), ["implementers", "reviewers", "merge-bot"]);
});

test("formatLines prints role, actual/target and the ACTION on one line each", () => {
  const lines = formatLines(reconcile(state({ implLive: 0, pool: 1, mergeQueue: 2 })));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^implementers\s+0\/2 → DISPATCH 1\b/);
  assert.match(lines[2], /^merge-bot\s+0\/1 → DISPATCH merge-bot\b/);
});

// ---------------------------------------------------------------------------
// The CLI half. What is pinned here is the CONTRACT #3 left open: live member
// counts and the pool arrive as required args (no source in the repo can be
// trusted for them), everything else the script reads for itself, and every
// failed read refuses rather than degrading into a number.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fleet-tick.mjs", import.meta.url));

// Answers both reads the tick makes: `gh pr list` for backlog/merge-queue, and
// the `gh issue list --jq …` that candidates.mjs makes on its behalf. The issue
// branch execs the real jq with the expression gh was handed, so candidates.mjs
// runs for real underneath rather than being mocked away — supply is the one
// number this script does not compute itself.
const GH_STUB = `#!/bin/sh
case "$1 $2" in
  "pr list") [ -n "$PR_FAIL" ] && { echo "boom" >&2; exit 1; }; cat "$FIXTURE_PRS" ;;
  "issue list")
    [ -n "$ISSUE_FAIL" ] && { echo "boom" >&2; exit 1; }
    expr=""
    while [ $# -gt 0 ]; do
      case "$1" in --jq) shift; expr="$1" ;; esac
      shift
    done
    exec jq -c "$expr" "$FIXTURE_ISSUES" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;

const pr = (number, labels = []) => ({ number, labels: labels.map((name) => ({ name })) });
const issue = (number) => ({
  number, title: `t${number}`, labels: [{ name: "ready-for-agent" }], body: "",
});

function runCli(args, { prs = [], issues = [], env: extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-tick-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const prFixture = join(dir, "prs.json");
  const issueFixture = join(dir, "issues.json");
  writeFileSync(prFixture, JSON.stringify(prs));
  writeFileSync(issueFixture, JSON.stringify(issues));
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`,
      FIXTURE_PRS: prFixture, FIXTURE_ISSUES: issueFixture, ...extraEnv,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

const LIVE = ["--implementers", "0", "--reviewers", "0", "--merge-bots", "0", "--pool", "1"];

test("CLI: a missing live count refuses rather than defaulting", () => {
  // The whole contract in one assertion. A default here is the bug: 0 would
  // dispatch a full cap off a forgotten flag, cap would hold forever, and
  // neither says anything on the way past.
  for (const drop of ["--implementers", "--reviewers", "--merge-bots", "--pool"]) {
    const args = LIVE.filter((a, i) => a !== drop && LIVE[i - 1] !== drop);
    const r = runCli(args, { prs: [] });
    assert.equal(r.status, 2, `dropping ${drop} should refuse`);
    assert.match(r.stderr, new RegExp(`${drop.slice(2)}.*required`, "s"));
    assert.equal(r.stdout.trim(), "", `dropping ${drop} must print no reconcile line`);
  }
});

test("CLI: a live count that is not a non-negative integer refuses", () => {
  for (const bad of ["x", "-1", "1.5", ""]) {
    const r = runCli(["--implementers", bad, "--reviewers", "0", "--merge-bots", "0", "--pool", "1"]);
    assert.equal(r.status, 2, `'${bad}' should refuse`);
  }
});

test("CLI: a flag given no value at all refuses", () => {
  const r = runCli(["--reviewers", "0", "--merge-bots", "0", "--pool", "1", "--implementers"]);
  assert.equal(r.status, 2);
});

test("CLI: an unrecognised flag refuses instead of being ignored", () => {
  const r = runCli([...LIVE, "--implementor-cap", "3"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /accepted:/);
});

test("CLI: a cap outside run-team's invariant refuses", () => {
  assert.equal(runCli([...LIVE, "--implementer-cap", "6"]).status, 2);
  assert.equal(runCli([...LIVE, "--reviewer-cap", "6"]).status, 2);
  assert.equal(runCli([...LIVE, "--implementer-cap", "0"]).status, 2);
});

test("CLI: a failed gh read refuses — it is not an empty backlog", () => {
  const r = runCli(LIVE, { env: { PR_FAIL: "1" } });
  assert.equal(r.status, 2);
  // The harm being pinned is not the exit code but the line that must NOT have
  // been printed: backlog 0 + merge-queue 0 is a perfectly plausible tick, and
  // an unread pipeline printed as an idle one is the silent stall again.
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /gh pr list/);
});

test("CLI: a failed supply read refuses — unknown supply is not zero supply", () => {
  const r = runCli(["--implementers", "0", "--reviewers", "0", "--merge-bots", "0", "--pool", "0"],
    { env: { ISSUE_FAIL: "1" } });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), "");
  assert.match(r.stderr, /supply/);
});

test("CLI: a PR list at the limit refuses rather than serving a truncated one", () => {
  const prs = Array.from({ length: 200 }, (_, i) => pr(i + 1));
  const r = runCli(LIVE, { prs });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /truncated|capped/i);
});

test("CLI: a drained implementer queue with pool and a merge queue prints all three ACTIONs", () => {
  const r = runCli(LIVE, { prs: [pr(1, ["ready-to-merge"])], issues: [issue(9)] });
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^implementers\s+0\/2 → DISPATCH 1\b/);
  assert.match(lines[1], /^reviewers\s+0\/5 → IDLE OK\b/);
  assert.match(lines[2], /^merge-bot\s+0\/1 → DISPATCH merge-bot\b/);
});

test("CLI: review backlog and merge queue are derived from open PRs by label", () => {
  const prs = [pr(1, ["ready-to-merge"]), pr(2, ["ready-to-merge"]), pr(3), pr(4)];
  const r = runCli(LIVE, { prs, issues: [issue(9)] });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /review-backlog=2/);
  assert.match(r.stdout, /merge-queue=2/);
  // Backlog 2 is the gate, so the pool must not be spent.
  assert.match(r.stdout, /^implementers\s+0\/2 → HOLD\b/m);
});

test("CLI: supply comes from candidates.mjs and drives the pool-0 branches", () => {
  const empty = ["--implementers", "0", "--reviewers", "0", "--merge-bots", "0", "--pool", "0"];
  const one = runCli(empty, { prs: [], issues: [issue(9)] });
  assert.equal(one.status, 0);
  assert.match(one.stdout, /supply=1/);
  assert.match(one.stdout, /RE-SHORTLIST \+ SUGGEST \/triage/);

  const none = runCli(empty, { prs: [], issues: [] });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /supply=0/);
  assert.match(none.stdout, /SUGGEST \/triage/);

  const many = runCli(empty, { prs: [], issues: [issue(9), issue(10), issue(11)] });
  assert.equal(many.status, 0);
  assert.match(many.stdout, /supply=3/);
  assert.match(many.stdout, /^implementers\s+0\/2 → RE-SHORTLIST\s{2}/m);
});
