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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rowWriteRefusal } from "../plugin/scripts/ledger-grammar.mjs";
import { deriveRun } from "../plugin/scripts/fleet-tick.mjs";
import { rendering } from "./support/rendered-brief.mjs";
import { writeQueueGh, closes } from "./support/queue-gh.mjs";
import { seedLabelMap } from "./support/label-map-seed.mjs";
import { viaResult } from "./support/review-result.mjs";

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
    seedLabelMap(root);
  }
  const env = { ...process.env, PATH: bin };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const scratch = join(root, "scratch");
  const spawn = (args) => spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { encoding: "utf8", env, cwd: dir });
  // `cli` hands a `reviewed=` word to the verb as the result file it names;
  // `raw` is the call exactly as typed.
  const raw = rendering(dir, (...args) => spawn(args));
  const cli = rendering(dir, (...args) => spawn(viaResult(scratch, args)));
  const bytes = () => (existsSync(file) ? readFileSync(file, "utf8") : null);
  const run = (...args) => {
    const r = cli(...args);
    assert.equal(r.status, 0, `${args.join(" ")}: got exit ${r.status}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const refusedCall = (args, whys, caller = cli) => {
    const before = bytes();
    const r = caller(...args);
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
  return { run, cli, raw, ok, refused, review, reviewRefused, refusedCall, read, rows: () => read().rows, file, rule, bin, scratch };
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
  assert.deepEqual(review("482", A, r1), { pr: 482, row: "#482", line: `#482 ${A} · ${r1}`, created: true, reviewed: r1, written: true, next: "review-pr-482-b" });
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
  const { review, rows } = fixture(t, ["#1 impl-1", "#482 fix-pr-482=killed", `#2 impl-2=PR#483`]);
  assert.equal(review("482", A).row, "#482", "an implementer that has not settled to the PR does not map it");
  assert.equal(review("483", "review=member:review-pr-483").row, "#2");
  assert.deepEqual(rows(), ["#1 impl-1", `#482 fix-pr-482=killed · ${A}`, "#2 impl-2=PR#483 · review=member:review-pr-483"]);
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
  const { ok, refused, review, rows } = fixture(t, [`#1 ${IMPL} · ${A} ${r1} ${r2}`]);
  ok("1", `${IMPL} · class=routine · ${A} ${r1} finisher-pr-482 ${r2}`);
  ok("1", `${IMPL} · ${A} class=routine ${r1} ${r2}`);
  // A result a row already carries is skipped, never written a second time.
  assert.equal(review("482", r2).line, `#1 ${IMPL} · ${A} class=routine ${r1} ${r2}`);
  refused("1", `${IMPL} · ${A} ${r1} ${r2} ${r2}`, /'reviewed=b7adf86/);
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A} class=routine ${r1} ${r2}`]);
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

test("a failed launch may be dropped, and an answered one only with the reviewed= that answers it, which a rewrite never drops", (t) => {
  const failed = fixture(t, [`#1 ${IMPL} · ${A}=failed`]);
  failed.ok("1", `${IMPL}`);
  const answered = fixture(t, [`#1 ${IMPL} · ${A} ${r1}`]);
  answered.refused("1", `${IMPL} · class=routine`, /drops Gate verdict 'reviewed=aaaaaaa/, /fleet-event\.mjs review-result/);
  answered.ok("1", `${IMPL} · class=routine · ${A} ${r1}`);
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
  reviewRefused("482", ["reviewed=aaaaaaa:1/0/0"], /'reviewed=aaaaaaa:1\/0\/0'/, /--result/);
});

// ---- every PR's stream is judged, not just the first in ledger order ----

const OTHER = "impl-4=PR#4 → PR#4 · review=member:review-pr-4 reviewed=bbbbbbb:1/0/0:run-bbbbbbb4";

test("a violation on a PR whose stream is not first in ledger order is refused", (t) => {
  const { refused, review, reviewRefused } = fixture(t, [`#4 ${OTHER}`, `#1 ${IMPL} · ${A}`]);
  // Added to the later stream: a crowded launch, a dropped open launch, then an unpaired result.
  reviewRefused("482", [B], /PR #482/, /one open launch/);
  refused("1", `${IMPL}`, /PR #482/, /removes open launch/);
  // A write on that stream that adds nothing wrong is still accepted.
  review("482", r1);
  reviewRefused("482", [r2], /PR #482/, /paired results/);
});

test("a reviewed= whose head is under seven hex digits is refused as unparseable", (t) => {
  const { reviewRefused } = fixture(t, [`#1 ${IMPL} · ${A}`]);
  reviewRefused("482", ["reviewed=abc:1/0/0:run-xxxxxxxx"], /'reviewed=abc:1\/0\/0:run-xxxxxxxx'/, /--result/);
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
  // The fix-applier's dispositions verdict, as `ledger.mjs dispositions` records
  // it: written into the file, since `row` carries a verdict and adds none.
  const [row] = f.rows();
  writeFileSync(f.file, readFileSync(f.file, "utf8").replace(row, `${row} · dispositions-ok=fix-pr-724:run-AAAAAAAA`));
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

// ---- Gate verdicts: `row` carries them exactly as the row holds them ----
//
// A dispositions verdict, an Escalation answer and a `reviewed=` are each
// written by the verb that derives it. A rewrite may carry them, none added,
// changed, dropped or reordered, which is also what refuses the whole-row wipe
// of a row holding one.
const HEAD_3724 = "7685c4674b79fad4a08a68603cefa2782ca5debe";
const RUN_3724 = "run-B7CP3bIU";
const TAIL_3724 = [
  "impl-3692=PR#3724", "tier=slow-high", "tier-ok=impl-3692:fleet-implementer-slow-high", "review=member:review-pr-3724",
  `reviewed=${HEAD_3724}:3/1/19:${RUN_3724}`, "fix-pr-3724=failed", "fix-pr-3724-b=applied:c4554f8b4411cbf4fa93dfd36c3ed48e3b428532",
  `dispositions-escalate=fix-pr-3724-b:${RUN_3724}`, "ci=39722006612:1:success",
].join(" · ");
const ESCALATE = `dispositions-escalate=fix-pr-3724-b:${RUN_3724}`;

test("row refuses to add, change, drop or reorder a Gate verdict, naming it and its writer, and writes nothing", (t) => {
  const { refused } = fixture(t, [`#3692 ${TAIL_3724}`]);
  refused("3692", `${TAIL_3724} · dispositions-ok=fix-pr-3724-z:${RUN_3724}`, /'dispositions-ok=fix-pr-3724-z:run-B7CP3bIU'/, /carries every Gate verdict exactly as the row holds it/, /ledger\.mjs dispositions fix-pr-3724-z/);
  refused("3692", `${TAIL_3724} · escalation-answer=${RUN_3724}:survived[0]:upheld`, /escalation-answer=run-B7CP3bIU:survived\[0\]:upheld/, /--uphold/);
  refused("3692", TAIL_3724.replace(ESCALATE, `dispositions-ok=fix-pr-3724-b:${RUN_3724}`), /dispositions-ok=fix-pr-3724-b:run-B7CP3bIU/, /ledger\.mjs dispositions fix-pr-3724-b/);
  refused("3692", TAIL_3724.replace(ESCALATE, `DISPOSITIONS-OK=fix-pr-3724-b:${RUN_3724}`), /DISPOSITIONS-OK=fix-pr-3724-b/);
  refused("3692", TAIL_3724.replace(` · reviewed=${HEAD_3724}:3/1/19:${RUN_3724}`, ""), /drops Gate verdict 'reviewed=7685c46/, /fleet-event\.mjs review-result/);
  refused("3692", TAIL_3724.replace(` · ${ESCALATE}`, ""), /drops Gate verdict 'dispositions-escalate=fix-pr-3724-b/);
  // The 3686-shaped wipe: a PR number given where the row's text goes.
  refused("3692", "3724", /drops Gate verdict/);
  // Reordering two verdicts is a change of what the tick reads in row order.
  const both = `${TAIL_3724} · dispositions-ok=fix-pr-3724-c:${RUN_3724}`;
  const two = fixture(t, [`#3692 ${both}`]);
  two.refused("3692", both.replace(` · ${ESCALATE}`, "").replace(` · dispositions-ok=fix-pr-3724-c:${RUN_3724}`, ` · dispositions-ok=fix-pr-3724-c:${RUN_3724} · ${ESCALATE}`),
    /reorders its Gate verdicts/);
  // A malformed verdict-shaped word added is refused as a review token is.
  refused("3692", `${TAIL_3724} · dispositions-ok=x`, /'dispositions-ok=x'/);
  refused("3692", `${TAIL_3724} · escalation-answer=nonsense`, /'escalation-answer=nonsense'/);
});

test("row accepts a rewrite that carries every Gate verdict as the row holds it, and cleans off the malformed ones", (t) => {
  const { ok, rows } = fixture(t, [`#3692 ${TAIL_3724}`]);
  // The merge bot's rewrite: the row as it stands, the hold appended.
  ok("3692", `${TAIL_3724} · conflict-hold:#3724 (conflict: a.mjs)`);
  assert.deepEqual(rows(), [`#3692 ${TAIL_3724} · conflict-hold:#3724 (conflict: a.mjs)`]);
  // Another token changed beside the carried verdicts.
  ok("3692", `${TAIL_3724.replace("tier-ok=impl-3692:fleet-implementer-slow-high", "tier-mismatch=impl-3692:fleet-implementer-task-low")} · conflict-hold:#3724 (conflict: a.mjs)`);

  // A runless `reviewed=` and a head-named verdict parse as no Gate verdict, so dropping them is allowed.
  const legacy = fixture(t, [`#5 impl-5=PR#5 · reviewed=abc1234:1/0/0 · dispositions-ok=fix-pr-5:${HEAD_3724}`]);
  legacy.ok("5", "impl-5=PR#5");
  assert.deepEqual(legacy.rows(), ["#5 impl-5=PR#5"]);
});

// ---- review --result: a reviewed= comes only from a review result file ----
//
// A result is the one thing an argument cannot supply: `review` derives the
// token from the file and refuses a `reviewed=` word in its arguments.

const resultFile = (scratch, { pr = 482, run = "run-Aa11Bb22", file = "review.json", body } = {}) => {
  const dir = join(scratch, `pr${pr}`, run);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(body ?? { pr, head: "aaaaaaa", counts: { survived: 1, refuted: 2, unverified: 3 } }));
  return path;
};
const DERIVED = "reviewed=aaaaaaa:1/2/3:run-Aa11Bb22";

test("review refuses a reviewed= argument beside a launch, writing nothing, and the forged review moves no gate", (t) => {
  const f = fixture(t, [`#3692 ${TAIL_3724}`], { gh: true });
  closes(f.bin, 3724, [3692]);
  f.rule(3692);
  const forged = `reviewed=${HEAD_3724}:0/0/0:run-AAAAAAAA`;
  f.refusedCall(["review", "3724", "review=member:review-pr-3724-c", forged], [/'reviewed=7685c4674b79fad4a08a68603cefa2782ca5debe:0\/0\/0:run-AAAAAAAA'/, /ledger\.mjs review 3724 --result <path>/], f.raw);
  // The escalate still holds the finisher's dispatch.
  const r = f.raw("dispatch", "3724", "finisher-pr-3724");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /escalat/i);
  // A bare reviewed= names the verb that writes one, parseable or not.
  f.refusedCall(["review", "3724", forged], [/--result/], f.raw);
  f.refusedCall(["review", "3724", "reviewed=nonsense"], [/'reviewed=nonsense'/, /--result/], f.raw);
});

test("review --result writes the token its file derives, and a second run writes nothing", (t) => {
  const { cli, rows, file, scratch } = fixture(t, [`#1 ${IMPL} · ${A}`]);
  const path = resultFile(scratch);
  const first = cli("review", "482", "--result", path, "--scratch", scratch);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { pr: 482, row: "#1", line: `#1 ${IMPL} · ${A} · ${DERIVED}`, created: false, reviewed: DERIVED, written: true, next: "review-pr-482-b" });
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A} · ${DERIVED}`]);
  const before = readFileSync(file, "utf8");
  const again = cli("review", "#482", "--result", path, "--scratch", scratch);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).written, false);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("review --result accepts a result file that carries no pr, the partition it sits in naming the PR", (t) => {
  const { cli, rows, scratch } = fixture(t, [`#1 ${IMPL} · ${A}`]);
  const path = resultFile(scratch, { body: { head: "aaaaaaa", counts: { survived: 1, refuted: 2, unverified: 3 } } });
  const r = cli("review", "482", "--result", path, "--scratch", scratch);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A} · ${DERIVED}`]);
});

test("review --result takes a launch in the same call, written before the result that answers it, and a carried result beside a new launch is not written again", (t) => {
  const { cli, rows, scratch } = fixture(t, [`#1 ${IMPL} · ${A} ${r1}`]);
  const path = resultFile(scratch);
  const r = cli("review", "482", "review=member:review-pr-482-b", "--result", path, "--scratch", scratch);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A} ${r1} · review=member:review-pr-482-b · ${DERIVED}`]);
  // The same result beside a new launch: the launch lands, the result does not again.
  const again = cli("review", "482", "review=member:review-pr-482-c", "--result", path, "--scratch", scratch);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).written, false);
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A} ${r1} · review=member:review-pr-482-b · ${DERIVED} · review=member:review-pr-482-c`]);
});

test("review --result refuses a path or file that is not PR <pr>'s review result, writing nothing", (t) => {
  const { refusedCall, scratch } = fixture(t, [`#1 ${IMPL} · ${A}`]);
  const call = (path, ...whys) => refusedCall(["review", "482", "--result", path, "--scratch", scratch], whys);
  call(resultFile(scratch, { pr: 483 }), /is not under PR #482's partition/);
  call(join(scratch, "pr482", "nested", "run-Aa11Bb22", "review.json"), /is not under PR #482's partition/);
  call(join(dirname(scratch), "elsewhere", "pr482", "run-Aa11Bb22", "review.json"), /is not under PR #482's partition/);
  call(`${scratch}/pr482/run-Aa11Bb22/../run-Aa11Bb22/review.json`, /has a "\.\." segment/);
  call(resultFile(scratch, { run: "not-a-run" }), /is not a review run root/);
  call(resultFile(scratch, { run: "run-Aa11Bb22c" }), /is not a review run root/);
  call(resultFile(scratch, { run: "run-Aa11Bb2" }), /is not a review run root/);
  call(resultFile(scratch, { run: "run-Aa11Bb2!" }), /is not a review run root/);
  call(join(scratch, "pr482", "run-Aa11Bb22", "missing.json"), /cannot read/);
  const garbled = resultFile(scratch, { file: "garbled.json" });
  writeFileSync(garbled, "{");
  call(garbled, /cannot read .*garbled\.json/);
  call(resultFile(scratch, { body: { pr: 483, head: "aaaaaaa", counts: { survived: 0, refuted: 0, unverified: 0 } } }), /is PR #483's review, not #482's/);
  call(resultFile(scratch, { body: { pr: 482, counts: { survived: 0, refuted: 0, unverified: 0 } } }), /carries no head and counts/);
  call(resultFile(scratch, { body: { pr: 482, head: "aaaaaaa" } }), /carries no head and counts/);
  call(resultFile(scratch, { body: { pr: 482, head: "abc", counts: { survived: 0, refuted: 0, unverified: 0 } } }), /carries no head and counts/);
});

test("review --result refuses a result that answers no open launch, and flags it cannot read", (t) => {
  const { refusedCall, scratch } = fixture(t, [`#1 ${IMPL}`]);
  const path = resultFile(scratch);
  refusedCall(["review", "482", "--result", path, "--scratch", scratch], [/answers no open launch/]);
  refusedCall(["review", "482", "--result", path], [/no --scratch, and the scratch root could not be resolved/]);
  refusedCall(["review", "482", "--result"], [/--result needs a value/]);
  refusedCall(["review", "482", "--result", path, "--result", path, "--scratch", scratch], [/--result is given twice/]);
  refusedCall(["review", "482", "--result", path, "--scratch", scratch, "--scratch", scratch], [/--scratch is given twice/]);
  refusedCall(["review", "482", `--result=${path}`], [/--result needs a space-separated value/]);
  refusedCall(["review", "482", "--result", path, `--scratch=${scratch}`], [/--scratch needs a space-separated value/]);
  refusedCall(["review", "482", "--scratch", scratch, A], [/--scratch is read only with --result/]);
});

// ---- review: never alongside a live fix-applier or finisher on the PR ----

test("review refuses a launch while a fix-applier or finisher on the PR is live, naming the member and the way out, and writes nothing", (t) => {
  for (const live of ["fix-pr-482", "fix-pr-482-b", "finisher-pr-482"]) {
    const { reviewRefused } = fixture(t, [`#1 ${IMPL} · ${live}`]);
    const stderr = reviewRefused("482", [A], new RegExp(`${live} is still live on PR #482`), new RegExp(`settle ${live} <outcome>`), /wait for its report/);
    assert.match(stderr, /nothing written/);
  }
  // A past-pin re-review is a new launch like any other.
  const { reviewRefused } = fixture(t, [`#1 ${IMPL} · ${A} · ${r1} · ${HALT} · fix-pr-482`]);
  reviewRefused("482", [B], /fix-pr-482 is still live/);
});

test("review refuses a launch that settles an open one failed in the same call while a fix-applier is live", (t) => {
  const { reviewRefused } = fixture(t, [`#1 ${IMPL} · ${A} · fix-pr-482`]);
  reviewRefused("482", [`${A}=failed`, B], /fix-pr-482 is still live/);
});

test("review refuses a launch while a fix-applier live in ## Dispatched alone is on the PR, its row token rewritten away", (t) => {
  const { run, ok, reviewRefused, review } = fixture(t, [`#1 ${IMPL}`]);
  run("dispatch", "482", "fix-pr-482");
  ok("1", IMPL);
  reviewRefused("482", [A], /fix-pr-482 is still live on PR #482/);
  run("settle", "fix-pr-482", "killed");
  assert.equal(review("482", A).row, "#1");
});

test("review writes with a fix-applier live when it opens no launch: a launch settled failed, a result, or a launch with its result", (t) => {
  const { review, rows } = fixture(t, [`#1 ${IMPL} · ${A} · fix-pr-482`]);
  review("482", `${A}=failed`);
  assert.deepEqual(rows(), [`#1 ${IMPL} · ${A}=failed · fix-pr-482`]);
  const again = fixture(t, [`#1 ${IMPL} · ${A} · fix-pr-482`]);
  assert.equal(again.review("482", r1).written, true, "a result answers the open launch");
  const together = fixture(t, [`#1 ${IMPL} · fix-pr-482`]);
  assert.equal(together.review("482", A, r1).written, true, "a launch with its own result leaves none open");
  assert.deepEqual(together.rows(), [`#1 ${IMPL} · fix-pr-482 · ${A} · ${r1}`]);
});

// A malformed review token already on the row is carried forward by a row write
// but refused by the strict fold, so the fold is observable through it: a call
// that folds refuses; a call that opens no launch never reads the fold.
const FOLD_REFUSED = [`#1 ${IMPL} · review=bogus · ${A} · fix-pr-482`];

test("review settling an open launch =failed alone never reads the fold: it writes on a ledger the tick refuses", (t) => {
  const { review, rows, reviewRefused } = fixture(t, FOLD_REFUSED);
  // The fixture really is one the fold refuses: a new launch is refused for that, not for the live member.
  reviewRefused("482", [`${A}=failed`, B], /fleet-tick\.mjs refuses this ledger/, /nothing written/);
  assert.equal(review("482", `${A}=failed`).row, "#1");
  assert.deepEqual(rows(), [`#1 ${IMPL} · review=bogus · ${A}=failed · fix-pr-482`]);
});

test("review's refusal names every live member on the PR, and its settle hint names the first in the fold's order", (t) => {
  const { reviewRefused } = fixture(t, [`#1 ${IMPL} · fix-pr-482 · finisher-pr-482`]);
  const stderr = reviewRefused("482", [A], /fix-pr-482, finisher-pr-482 is still live on PR #482/, /ledger\.mjs settle fix-pr-482 <outcome>/);
  assert.doesNotMatch(stderr, /settle finisher-pr-482/);
});

test("review launches once the fix-applier or finisher on the PR is settled, and while one is live on another PR", (t) => {
  for (const settled of ["fix-pr-482=killed", "fix-pr-482=failed", "fix-pr-482=no-op", "fix-pr-482=applied:def5678", "finisher-pr-482=labelled"]) {
    const { review } = fixture(t, [`#1 ${IMPL} · ${settled}`]);
    assert.equal(review("482", A).row, "#1", settled);
  }
  const other = fixture(t, [`#1 ${IMPL} · fix-pr-482`, "#2 impl-2=PR#483 → PR#483 · fix-pr-483=applied:def5678"]);
  assert.equal(other.review("483", A.replace("482", "483")).row, "#2", "a live member on PR 482 does not hold PR 483");
  assert.equal(other.review("484", A.replace("482", "484")).created, true);
});
