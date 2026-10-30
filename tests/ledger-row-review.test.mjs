// A PR's review record lives on the PR's row (#2288): `ledger.mjs review`
// is the only writer of `review=`/`reviewed=` tokens and appends them to the
// PR's row — the ticket row once `settle impl-<N>=PR#M` has run, else `#M` —
// so that row's token order is write order. It refuses a write that adds an
// inconsistent review record to a PR's token stream (#2889, with #3047 folded
// in). The stream is every row that maps to the PR — rowNums(), the tick's own
// mapping — in ledger row order, read as it would be after the write. Only
// violations the write ADDS are refused: a bad token already on the ledger and
// carried forward never blocks a write.
//
// `ledger.mjs row` adds no review token (one the row holds is carried), never
// drops an open launch, and refuses a write after which a PR maps to more than
// one row when it did not before.
//
// Every call is its own process against one ledger file, as in
// ledger-dispatch.test.mjs; a refusal is exit 2 with the ledger byte-identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rowWriteRefusal } from "../plugin/scripts/ledger-grammar.mjs";
import { deriveRun } from "../plugin/scripts/fleet-tick.mjs";
import { rendering } from "./support/rendered-brief.mjs";
import { writeQueueGh, closes } from "./support/queue-gh.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

function fixture(t, rows = null, { gh = false } = {}) {
  // The ledger's directory sits in `root`, as `.fleet/` sits in a main
  // checkout, so a finisher dispatch reads `root`'s tier-outcomes file.
  const root = mkdtempSync(join(tmpdir(), "ledger-row-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".fleet");
  mkdirSync(dir);
  const file = join(dir, "ledger.md");
  if (rows !== null) {
    writeFileSync(file, `# Fleet run ledger\n\n## Rows\n\n${rows.map((r) => `- ${r}\n`).join("")}\n## Filed\n\n## Ruled\n\n`);
  }
  // PATH is an empty directory: `row` and `review` are local only and may reach no gh.
  // A finisher dispatch reads the PR's closing references from gh and the
  // ledger's repository from git, so a fixture that dispatches one asks for both.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  if (gh) {
    writeQueueGh(bin);
    assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  }
  const env = { ...process.env, PATH: bin };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const cli = rendering(dir, (...args) => spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { encoding: "utf8", env, cwd: dir }));
  const bytes = () => (existsSync(file) ? readFileSync(file, "utf8") : null);
  const run = (...args) => {
    const r = cli(...args);
    assert.equal(r.status, 0, `${args.join(" ")}: got exit ${r.status}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const refusedCall = (args, whys) => {
    const before = bytes();
    const r = cli(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: got exit ${r.status}\n${r.stderr}`);
    for (const why of whys) assert.match(r.stderr, why, `${args.join(" ")}: stderr was ${r.stderr}`);
    assert.equal(r.stdout, "", "a refusal must not also emit a payload");
    assert.equal(bytes(), before, "a refusal must leave the ledger byte-identical");
    return r.stderr;
  };
  const ok = (key, text) => run("row", key, text);
  const refused = (key, text, ...whys) => refusedCall(["row", key, text], whys);
  const review = (pr, ...tokens) => run("review", pr, ...tokens);
  const reviewRefused = (pr, tokens, ...whys) => refusedCall(["review", pr, ...tokens], whys);
  const read = () => JSON.parse(cli("read").stdout);
  // PR `pr`'s ruling, the row a finisher dispatch for an implementer's PR waits on.
  const rule = (pr) => {
    mkdirSync(join(root, "docs", "metrics"), { recursive: true });
    writeFileSync(join(root, "docs", "metrics", "tier-outcomes.tsv"), `2026-10-21\t${pr}\t1\troutine\tslow-high\tyes\tno\truled\n`);
  };
  return { run, ok, refused, review, reviewRefused, refusedCall, read, rows: () => read().rows, file, rule, bin };
}

const A = "review=member:review-pr-482";
const B = "review=member:review-pr-482-b";
const C = "review=member:review-pr-482-c";
const WHILE_A_OPEN = /launch 'review=member:review-pr-482-b' on PR #482 while launch 'review=member:review-pr-482' is open/;
const r1 = "reviewed=aaaaaaa:4/5/14:run-aaaaaaa1";
const r2 = "reviewed=b7adf86:4/5/14:run-bbbbbbb2";
const r3 = "reviewed=c0ffee1:0/1/2:run-ccccccc3";
const IMPL = "impl-1=PR#482 → PR#482";
const HALT = "finisher-pr-482=halted:past-pin";

// ---- review: the PR's row ----

test("review appends each token to the ticket row that maps the PR, in write order, and prints the row key", (t) => {
  const { review, rows } = fixture(t, [`#1 ${IMPL}`]);
  assert.deepEqual(review("482", A), { pr: 482, row: "#1", line: `#1 ${IMPL} · ${A}`, created: false, next: "review-pr-482-b" });
  assert.equal(review("#482", r1).row, "#1");
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A} · ${r1}`]);
});

test("review on a PR no row maps creates its #M row, and the next call lands there", (t) => {
  const { review, rows } = fixture(t);
  assert.deepEqual(review("482", A, r1), { pr: 482, row: "#482", line: `#482 ${A} · ${r1}`, created: true, next: "review-pr-482-b" });
  review("482", "review=member:review-pr-482-b");
  assert.deepEqual(rows(), [`#482 ${A} · ${r1} · review=member:review-pr-482-b`]);
});

test("review's receipt names the next free runner as the ledger stands after the write: a workflow launch takes no name, a launch settled =failed keeps its own", (t) => {
  const { review } = fixture(t, [`#1 ${IMPL}`]);
  assert.equal(review("482", "review=wf:12345").next, "review-pr-482", "a workflow launch uses no runner name");
  assert.equal(review("482", "review=wf:12345=failed", A).next, "review-pr-482-b");
  assert.equal(review("482", `${A}=failed`).next, "review-pr-482-b", "a launch settled =failed keeps its name");
  assert.equal(review("482", B).next, "review-pr-482-c");
});

test("review's next skips a runner name the ledger's ## Retired holds", (t) => {
  const { review, file } = fixture(t, [`#1 ${IMPL}`]);
  writeFileSync(file, `${readFileSync(file, "utf8")}## Retired\n\n- review-pr-482-b\n`);
  assert.equal(review("482", A).next, "review-pr-482-c");
});

test("review refuses a runner name a ## Retired line holds with an outcome, naming the next free one", (t) => {
  const { reviewRefused, file } = fixture(t, ["#1 impl-1=PR#9 → PR#9"]);
  writeFileSync(file, `${readFileSync(file, "utf8")}## Retired\n\n- review-pr-9=failed\n`);
  reviewRefused("9", ["review=member:review-pr-9"], /names a runner an earlier run of this session already used/, /the next free reviewer name is review-pr-9-b/);
});

test("review's next skips a runner name a ## Retired line holds with an outcome", (t) => {
  const { review, file } = fixture(t, [`#1 ${IMPL}`]);
  writeFileSync(file, `${readFileSync(file, "utf8")}## Retired\n\n- review-pr-482-b=failed\n`);
  assert.equal(review("482", A).next, "review-pr-482-c");
});

test("token refuses a PR# mention that moves a launched row onto a PR whose runner name a ## Retired line holds with an outcome", (t) => {
  const { refusedCall, file } = fixture(t);
  writeFileSync(file, "# Fleet run ledger\n\n## Rows\n\n- #5 review=member:review-pr-5=failed\n\n## Filed\n\n## Ruled\n\n## Retired\n\n- review-pr-5=failed\n");
  refusedCall(["token", "5", "PR#9"], [/launch 'review=member:review-pr-5' on PR #9 names a runner an earlier run of this session already used/]);
});

test("review finds the PR's row by its PR before by its key: a ticket row settled to the PR wins over a later #M row", (t) => {
  const { review, rows } = fixture(t, ["#1 impl-1", "#482 fix-pr-482", `#2 impl-2=PR#483`]);
  assert.equal(review("482", A).row, "#482", "an implementer that has not settled to the PR does not map it");
  assert.equal(review("483", "review=member:review-pr-483").row, "#2");
  assert.deepEqual(rows(), ["#1 impl-1", `#482 fix-pr-482 · ${A}`, "#2 impl-2=PR#483 · review=member:review-pr-483"]);
});

test("review refuses any token that is not a review token, and a key that is not a PR number, writing nothing", (t) => {
  const { reviewRefused, run } = fixture(t, [`#1 ${IMPL}`]);
  reviewRefused("482", ["fix-pr-482=applied:b7adf86"], /'fix-pr-482=applied:b7adf86' is not a review token/);
  reviewRefused("482", [A, "class=routine"], /'class=routine' is not a review token/);
  reviewRefused("482", ["reviewedx"], /'reviewedx' is not a review token/);
  reviewRefused("482", [`${A} · ${r1}`], /'·' is not a review token/);
  reviewRefused("abc", [A], /'abc' is not a PR number/);
  reviewRefused("--pr", [A], /unknown flag --pr/);
  reviewRefused("482", [], /usage: ledger\.mjs review/);
  // One token per argument or several in one argument, both accepted.
  assert.equal(run("review", "482", `${A} ${r1}`).line, `#1 ${IMPL} · ${A} · ${r1}`);
});

// ---- rule: paired results ----

test("the incident: a second reviewed= with no new launch is refused, naming the token and the PR", (t) => {
  const { reviewRefused } = fixture(t, [`#1 ${IMPL} · ${A} ${r1} fix-pr-482=applied:b7adf86`]);
  reviewRefused("482", [r2], /'reviewed=b7adf86:4\/5\/14:run-bbbbbbb2'/, /PR #482/, /paired results/);
});

test("a reviewed= with no launch at all is refused", (t) => {
  const { reviewRefused } = fixture(t, [`#1 ${IMPL}`]);
  reviewRefused("482", [r1], /'reviewed=aaaaaaa/, /PR #482/);
});

test("an ordinary launch, then its result, is accepted", (t) => {
  const { review } = fixture(t, [`#1 ${IMPL}`]);
  review("482", A);
  review("482", r1);
});

test("reviewed= after a =failed launch with no later launch is refused; with a retry launch in the same call it is accepted", (t) => {
  const { review, reviewRefused, rows } = fixture(t, [`#1 ${IMPL}`]);
  review("482", A);
  reviewRefused("482", [`${A}=failed`, r1], /'reviewed=aaaaaaa/, /PR #482/);
  review("482", `${A}=failed`, B, r1);
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A}=failed · ${B} · ${r1}`], "the open launch is settled where it stands");
});

// Only a token ending `=failed` settles a launch; a runner whose name merely
// ends `-failed` is a new launch beside the answered one, never a rewrite of it.
test("a launch whose name ends -failed is a new launch, not a settle of the launch its name extends", (t) => {
  const { review, rows } = fixture(t, [`#1 ${IMPL} · ${A} ${r1}`]);
  review("482", `${A}-failed`);
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A} ${r1} · ${A}-failed`]);
});

test("a past-pin re-review under the next free letter is accepted", (t) => {
  const { review } = fixture(t, [`#1 ${IMPL} · ${A} ${r1} fix-pr-482=applied:b7adf86 ${HALT}`]);
  review("482", "review=member:review-pr-482-b");
  review("482", r2);
});

test("a PR whose retry took -b and a past-pin re-review takes -c", (t) => {
  const { review } = fixture(t, [`#1 ${IMPL} · ${A}=failed ${B} ${r1} ${HALT}`]);
  review("482", C, r3);
});

// ---- rule: unique launches ----

test("a past-pin re-review reusing the first reviewer's name is refused, naming the next free name", (t) => {
  const { reviewRefused } = fixture(t, [`#1 ${IMPL} · ${A} ${r1} ${HALT}`]);
  reviewRefused("482", [A], /'review=member:review-pr-482'/, /PR #482/, /unique launches/, /review-pr-482-b\b/);
});

test("the next free name skips every letter the PR's rows already carry", (t) => {
  const { reviewRefused } = fixture(t, [`#1 ${IMPL} · ${A}=failed ${B} ${r1} ${HALT}`]);
  reviewRefused("482", [B], /'review=member:review-pr-482-b'/, /review-pr-482-c\b/);
});

test("a repeated workflow runId is refused as a repeated launch", (t) => {
  const { reviewRefused } = fixture(t, [`#1 ${IMPL} · review=wf:r1 ${r1}`]);
  reviewRefused("482", ["review=wf:r1"], /'review=wf:r1'/, /PR #482/);
});

test("a launch rewritten in place to =failed is not a repeat", (t) => {
  const { review, rows } = fixture(t, [`#1 ${IMPL}`]);
  review("482", A);
  review("482", `${A}=failed`);
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A}=failed`]);
});

// ---- rule: unique members per row ----

test("the same member twice on one line is refused, naming the member, whatever its copies' outcomes", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL}`);
  for (const copies of [
    "fix-pr-482 fix-pr-482",
    "fix-pr-482=applied:b7adf86 fix-pr-482=applied:b7adf86",
    "fix-pr-482 fix-pr-482=applied:b7adf86",
    "fix-pr-482=applied:b7adf86 fix-pr-482=applied:c0ffee1",
  ]) {
    refused("1", `${IMPL} · ${copies}`, /'fix-pr-482'/, /unique members/);
  }
  // Two different members are not a repeat.
  ok("1", `${IMPL} · fix-pr-482=applied:b7adf86 fix-pr-482-b`);
});

// ---- rule: added only ----

test("an already-invalid row carried forward is accepted, new tokens before its bad one included; a second copy is refused", (t) => {
  const { ok, refused, reviewRefused, rows } = fixture(t, [`#1 ${IMPL} · ${A} ${r1} ${r2}`]);
  ok("1", `${IMPL} · class=routine · ${A} ${r1} finisher-pr-482 ${r2}`);
  ok("1", `${r2} ${IMPL} · ${A} ${r1}`);
  reviewRefused("482", [r2], /'reviewed=b7adf86/);
  refused("1", `${IMPL} · ${A} ${r1} ${r2} ${r2}`, /'reviewed=b7adf86/);
  assert.deepEqual(rows(), [`#1 ${r2} ${IMPL} · ${A} ${r1}`]);
});

test("a repeated member already on the row is carried; a third copy is refused", (t) => {
  const { ok, refused } = fixture(t, [`#1 ${IMPL} · fix-pr-482 fix-pr-482=applied:b7adf86`]);
  ok("1", `${IMPL} · class=routine · fix-pr-482 fix-pr-482=applied:b7adf86`);
  refused("1", `${IMPL} · fix-pr-482 fix-pr-482=applied:b7adf86 fix-pr-482`, /'fix-pr-482'/);
});

test("a repeated launch already on the PR is carried, and settling its repeat =failed in place is no new repeat", (t) => {
  const { ok, review, rows } = fixture(t, [`#1 ${IMPL} · ${A} ${r1} ${HALT} ${A}`]);
  ok("1", `${IMPL} · class=routine · ${A} ${r1} ${HALT} ${A}`);
  review("482", `${A}=failed`);
  assert.deepEqual(rows(), [`#1 ${IMPL} · class=routine · ${A} ${r1} ${HALT} ${A}=failed`], "the open copy, the last one, is settled");
});

// ---- rule: one open launch per PR ----

test("a second launch while one is open is refused, naming the PR, the open launch and both ways out", (t) => {
  const { review, reviewRefused } = fixture(t, [`#1 ${IMPL}`]);
  review("482", A);
  reviewRefused("482", [B], /PR #482/, WHILE_A_OPEN, /one open launch/, /reviewed=/, /Member-killed/, /=failed in the same `ledger\.mjs review` call/);
});

test("a new launch landing on a row BEFORE the open launch's row is still the offender, and the open launch the one the ledger held", (t) => {
  // A split already on disk: review finds the PR's row by its PR mention first.
  const { reviewRefused } = fixture(t, ["#482 PR#482 · ci=1:1:success", `#1 ${IMPL} · ${A}`]);
  reviewRefused("482", [B], WHILE_A_OPEN);
});

test("adding an already-failed launch after an open one is refused", (t) => {
  const { review, reviewRefused } = fixture(t, [`#1 ${IMPL}`]);
  review("482", A);
  reviewRefused("482", [`${B}=failed`], WHILE_A_OPEN, /one open launch/);
});

test("settling an open launch =failed in place is accepted, alone and with a new launch in the same call", (t) => {
  const alone = fixture(t, [`#1 ${IMPL} · ${A}`]);
  assert.equal(alone.review("482", `${A}=failed`).line, `#1 ${IMPL} · ${A}=failed`);
  const withNew = fixture(t, [`#1 ${IMPL} · ${A}`]);
  assert.equal(withNew.review("482", `${A}=failed`, B).line, `#1 ${IMPL} · ${A}=failed · ${B}`);
});

test("a ledger already holding two open launches on one PR accepts a rewrite carrying them, and one settling either =failed", (t) => {
  const seed = [`#1 ${IMPL} · ${A} ${B}`];
  fixture(t, seed).ok("1", `${IMPL} · class=routine · ${A} ${B}`);
  fixture(t, seed).review("482", `${A}=failed`);
  fixture(t, seed).review("482", `${B}=failed`);
});

// ---- rule: an open launch is never removed ----

test("row dropping an open launch is refused; review only appends or settles in place, so it never drops one", (t) => {
  const { refused, review, rows } = fixture(t, [`#1 ${IMPL} · ${A}`]);
  refused("1", `${IMPL}`, /'review=member:review-pr-482'/, /PR #482/, /open launch/, /Member-killed/);
  refused("1", `${IMPL} · class=routine`, /removes open launch 'review=member:review-pr-482'/);
  review("482", r1);
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A} · ${r1}`]);
});

test("an answered or failed launch may be dropped", (t) => {
  const answered = fixture(t, [`#1 ${IMPL} · ${A} ${r1}`]);
  answered.ok("1", `${IMPL} · class=routine`);
  const failed = fixture(t, [`#1 ${IMPL} · ${A}=failed`]);
  failed.ok("1", `${IMPL}`);
});

test("moving an open launch to another row of its PR is accepted", () => {
  const before = [`#1 ${IMPL} · ${A}`, "#482 PR#482 · ci=1:1:success"];
  const after = [`#1 ${IMPL}`, `#482 PR#482 · ci=1:1:success ${A}`];
  assert.equal(rowWriteRefusal(before, after, before[0], after[0]), null);
  // The same write with the launch gone from both rows is refused.
  assert.match(rowWriteRefusal(before, [`#1 ${IMPL}`, before[1]], before[0], `#1 ${IMPL}`), /review=member:review-pr-482/);
});

test("a write through the CLI that leaves the open launch on another row of its PR is accepted", (t) => {
  const { ok } = fixture(t, [`#1 ${IMPL} · ${A}`, `#482 PR#482 · ${A}`]);
  ok("1", `${IMPL}`);
});

// ---- rule: unparseable review tokens ----

test("an added unparseable review= or reviewed= is refused; one carried forward is accepted", (t) => {
  const { ok, reviewRefused } = fixture(t, [`#1 ${IMPL} · review=garbage reviewed=nothead`]);
  ok("1", `${IMPL} · class=routine · review=garbage reviewed=nothead`);
  reviewRefused("482", ["review=wf:"], /'review=wf:'/, /PR #482/, /unparseable review token/);
  reviewRefused("482", ["review=garbage"], /'review=garbage'/);
  reviewRefused("482", ["reviewed=aaaaaaa:1/0/0"], /'reviewed=aaaaaaa:1\/0\/0'/);
});

// ---- every PR's stream is judged, not just the first in ledger order ----

const OTHER = "impl-4=PR#4 → PR#4 · review=member:review-pr-4 reviewed=bbbbbbb:1/0/0:run-bbbbbbb4";

test("a violation on a PR whose stream is not first in ledger order is refused", (t) => {
  const { refused, review, reviewRefused } = fixture(t, [`#4 ${OTHER}`, `#1 ${IMPL} · ${A}`]);
  // Added to the later stream: an unpaired result, a crowded launch, a dropped open launch.
  reviewRefused("482", [r1, r2], /PR #482/, /paired results/);
  reviewRefused("482", [B], /PR #482/, /one open launch/);
  refused("1", `${IMPL}`, /PR #482/, /removes open launch/);
  // A write on that stream that adds nothing wrong is still accepted.
  review("482", r1);
});

test("a reviewed= whose head is under seven hex digits is refused as unparseable", (t) => {
  const { reviewRefused } = fixture(t, [`#1 ${IMPL} · ${A}`]);
  reviewRefused("482", ["reviewed=abc:1/0/0:run-xxxxxxxx"], /'reviewed=abc:1\/0\/0:run-xxxxxxxx'/, /PR #482/);
});

test("rows that map to no PR and carry no key are streams of their own, not one shared stream", () => {
  const first = "alpha · review=member:review-pr-1";
  const second = "beta · review=member:review-pr-2";
  assert.equal(rowWriteRefusal([first], [first, second], null, second), null);
  const answer = "beta · reviewed=aaaaaaa:1/0/0:run-aaaaaaa1";
  assert.match(rowWriteRefusal([first], [first, answer], null, answer), /answers no open launch/);
});

// ---- row: no review token of its own ----

test("row refuses a write that adds a review token, naming it and review; one the row already holds is carried", (t) => {
  const { ok, refused, rows } = fixture(t, [`#1 ${IMPL}`, `#2 impl-2=PR#483 → PR#483 · ${A} ${r1}`]);
  refused("1", `${IMPL} · ${A}`, /row #1: adds review token 'review=member:review-pr-482'/, /ledger\.mjs review/);
  refused("3", `impl-3 · ${r1}`, /adds review token 'reviewed=aaaaaaa/);
  refused("1", `${IMPL} · review=garbage`, /adds review token 'review=garbage'/);
  // Carried, with the rest of the line rewritten around them, never re-judged.
  ok("2", `impl-2=PR#483 → PR#483 · class=routine · ${A} ${r1}`);
  // Settling a launch =failed is a review write too, and a second copy is an addition.
  refused("2", `impl-2=PR#483 → PR#483 · ${A}=failed ${r1}`, /adds review token 'review=member:review-pr-482=failed'/);
  refused("2", `impl-2=PR#483 → PR#483 · ${A} ${r1} ${r1}`, /adds review token 'reviewed=aaaaaaa/);
  // Several added: the first, in line order, is the one named.
  refused("1", `${IMPL} · ${A} ${B}`, /adds review token 'review=member:review-pr-482'/);
  assert.deepEqual(rows(), [`#1 ${IMPL}`, `#2 impl-2=PR#483 → PR#483 · class=routine · ${A} ${r1}`]);
});

// ---- row: one row per PR ----

test("row refuses a write after which a PR maps to a second row, naming the PR's row", (t) => {
  const { refused } = fixture(t, [`#1 ${IMPL}`, "#900 impl-900 · class=routine"]);
  // `row <M>` creating `#M` for a PR a ticket row already maps.
  refused("482", "PR#482 · ci=1:1:success", /row #482: PR #482 would map to more than one row/, /PR's row is #1\b/);
  refused("482", "ci=1:1:success", /PR #482/, /#1\b/);
  // A rewrite adding a `PR#M` mention to another row.
  refused("900", "impl-900=PR#482 · class=routine", /row #900: PR #482/, /PR's row is #1\b/);
  refused("900", "notes about PR#482", /PR #482/, /#1\b/);
});

// The PR's row is the one `before` holds, wherever it sits in the rows: a
// row ahead of it that a write newly maps to the PR is not the PR's row.
test("row names the PR's row as the ledger held it when that row is not the first to map the PR", (t) => {
  const { refused } = fixture(t, ["#900 impl-900 · class=routine", `#1 ${IMPL}`]);
  refused("900", "impl-900=PR#482 · class=routine", /row #900: PR #482 would map to more than one row/, /PR's row is #1\b/);
});

test("row accepts the PR's own row, rows of other PRs, and a split already on disk", (t) => {
  const { ok } = fixture(t, [`#1 ${IMPL}`, "#2 impl-2=PR#483 → PR#483", "#484 fix-pr-484", "#485 PR#485 · ci=1:1:success"]);
  ok("1", `${IMPL} · class=routine`);
  ok("486", "PR#486 · ci=1:1:success");
  ok("3", "impl-3 · class=correction · tier=task-high");
  // A row whose ticket settles to a PR keyed by its own `#M` row is settle's
  // fold to converge, not `row`'s to refuse twice — and the ledger already
  // splitting 485 carries.
  const split = fixture(t, [`#5 impl-5=PR#485`, "#485 PR#485 · ci=1:1:success"]);
  split.ok("485", "PR#485 · ci=2:1:success");
  split.ok("5", "impl-5=PR#485 · class=routine");
});

// ---- rows that carry no review record are untouched ----

test("rows with no review tokens, and rows of other PRs, are accepted as before", (t) => {
  const { ok } = fixture(t, [`#2 impl-2=PR#483 → PR#483 · ${A} ${r1} ${r2}`]);
  ok("1", `${IMPL} · class=routine`);
  ok("1", `${IMPL} · fix-pr-482=applied:b7adf86`);
  ok("3", "impl-3 · class=correction · tier=task-high");
  // A word that only begins `reviewed` is no review token, so it adds none.
  ok("4", "impl-4 · reviewedx");
});

// ---- end to end: the writers in SKILL.md order leave PR M on one row ----

const HEAD_REVIEWED = "abc1234";
const HEAD_FIXED = "def5678";
const PR = (head) => [{ number: 724, labels: [], closingIssuesReferences: [{ number: 658 }], headRefOid: `${head}${"0".repeat(33)}`, mergeable: "MERGEABLE", owned: true }];
const tick = (read, head = HEAD_FIXED) => {
  const l = read();
  return deriveRun({ rows: l.rows, dispatched: l.dispatched, drain: null }, PR(head), "ready-to-merge");
};

// dispatch → settle impl → review launch → review result with survivors →
// dispatch fix-pr → settle fix-pr applied.
function reviewedAndFixed(f) {
  f.run("dispatch", "658", "impl-658");
  f.run("settle", "impl-658", "PR#724");
  assert.equal(f.review("724", "review=member:review-pr-724").row, "#658");
  f.review("724", `reviewed=${HEAD_REVIEWED}:2/1/0:run-AAAAAAAA`);
  f.run("dispatch", "724", "fix-pr-724");
  f.run("settle", "fix-pr-724", `applied:${HEAD_FIXED}`);
}

test("#2288: a fix applied after the review it answers ends fixDue, and a newer review with survivors restores it", (t) => {
  const f = fixture(t);
  reviewedAndFixed(f);
  assert.deepEqual(f.rows(), [
    `#658 impl-658=PR#724 · review=member:review-pr-724 · reviewed=${HEAD_REVIEWED}:2/1/0:run-AAAAAAAA · fix-pr-724=applied:${HEAD_FIXED}`,
  ], "PR 724 lives on one row, its tokens in write order");
  assert.deepEqual(tick(f.read).fixDue, []);
  f.review("724", "review=member:review-pr-724-b");
  f.review("724", `reviewed=${HEAD_FIXED}:1/0/0:run-BBBBBBBB`);
  assert.equal(f.rows().length, 1);
  assert.deepEqual(tick(f.read).fixDue, [724]);
});

test("#2288: a finisher halted past-pin after the fix re-queues the review", (t) => {
  const f = fixture(t, null, { gh: true });
  f.rule(724);
  closes(f.bin, 724, [658]);
  reviewedAndFixed(f);
  // The fix-applier's dispositions verdict, as dispositions-check.mjs records it.
  const [row] = f.rows();
  f.ok("658", `${row.slice("#658 ".length)} · dispositions-ok=fix-pr-724:run-AAAAAAAA`);
  f.run("dispatch", "724", "finisher-pr-724");
  f.run("settle", "finisher-pr-724", "halted:past-pin");
  assert.equal(f.rows().length, 1);
  assert.deepEqual(tick(f.read).reviewDue, [724]);
  assert.deepEqual(tick(f.read, HEAD_REVIEWED).reviewDue, [], "a head the review read is not past the pin");
});

test("#2288: a review recorded before the implementer settles is folded into the ticket row, in write order", (t) => {
  const f = fixture(t);
  f.run("dispatch", "658", "impl-658");
  assert.equal(f.review("724", "review=member:review-pr-724").row, "#724");
  f.review("724", `reviewed=${HEAD_REVIEWED}:2/1/0:run-AAAAAAAA`);
  f.run("settle", "impl-658", "PR#724");
  assert.deepEqual(f.rows(), [
    `#658 impl-658=PR#724 · review=member:review-pr-724 · reviewed=${HEAD_REVIEWED}:2/1/0:run-AAAAAAAA`,
  ]);
  f.run("dispatch", "724", "fix-pr-724");
  f.run("settle", "fix-pr-724", `applied:${HEAD_FIXED}`);
  assert.equal(f.rows().length, 1);
  assert.deepEqual(tick(f.read).fixDue, []);
});
