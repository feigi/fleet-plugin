// `ledger.mjs row` refuses a write that adds an inconsistent review record
// to a PR's token stream (#2889, with #3047 folded in). The stream is every
// row that maps to the PR — rowNums(), the tick's own mapping — in ledger
// row order, read as it would be after the write. Only violations the write
// ADDS are refused: a bad token already on the ledger and carried forward
// never blocks a write.
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

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

function fixture(t, rows = null) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-row-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ledger.md");
  if (rows !== null) {
    writeFileSync(file, `# Fleet run ledger\n\n## Rows\n\n${rows.map((r) => `- ${r}\n`).join("")}\n## Filed\n\n## Ruled\n\n`);
  }
  // PATH is an empty directory: `row` is local only and may reach no gh.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env = { ...process.env, PATH: bin };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { encoding: "utf8", env, cwd: dir });
  const bytes = () => (existsSync(file) ? readFileSync(file, "utf8") : null);
  const ok = (key, text) => {
    const r = cli("row", key, text);
    assert.equal(r.status, 0, `row ${key} ${text}: got exit ${r.status}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const refused = (key, text, ...whys) => {
    const before = bytes();
    const r = cli("row", key, text);
    assert.equal(r.status, 2, `row ${key} ${text}: got exit ${r.status}\n${r.stderr}`);
    for (const why of whys) assert.match(r.stderr, why, `row ${key} ${text}: stderr was ${r.stderr}`);
    assert.equal(r.stdout, "", "a refusal must not also emit a payload");
    assert.equal(bytes(), before, "a refusal must leave the ledger byte-identical");
    return r.stderr;
  };
  const rows_ = () => JSON.parse(cli("read").stdout).rows;
  return { ok, refused, rows: rows_ };
}

const A = "review=member:review-pr-482";
const B = "review=fallback:review-pr-482-b";
const C = "review=member:review-pr-482-c";
const WHILE_A_OPEN = /launch 'review=fallback:review-pr-482-b' on PR #482 while launch 'review=member:review-pr-482' is open/;
const r1 = "reviewed=aaaaaaa:4/5/14:run-aaaaaaa1";
const r2 = "reviewed=b7adf86:4/5/14:run-bbbbbbb2";
const r3 = "reviewed=c0ffee1:0/1/2:run-ccccccc3";
const IMPL = "impl-1=PR#482 → PR#482";
const HALT = "finisher-pr-482=halted:past-pin";

// ---- rule: paired results ----

test("the incident: a second reviewed= with no new launch is refused, naming the token and the PR", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · ${A} ${r1}`);
  refused("1", `${IMPL} · ${A} ${r1} fix-pr-482=applied:b7adf86 ${r2}`, /'reviewed=b7adf86:4\/5\/14:run-bbbbbbb2'/, /PR #482/, /paired results/);
});

test("a reviewed= with no launch at all is refused", (t) => {
  const { refused } = fixture(t);
  refused("1", `${IMPL} · ${r1}`, /'reviewed=aaaaaaa/, /PR #482/);
});

test("an ordinary launch, then its result, is accepted", (t) => {
  const { ok } = fixture(t);
  ok("1", `${IMPL} · ${A}`);
  ok("1", `${IMPL} · ${A} ${r1}`);
});

test("reviewed= after a =failed launch with no later launch is refused; with a fallback launch in the same rewrite it is accepted", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · ${A}`);
  refused("1", `${IMPL} · ${A}=failed ${r1}`, /'reviewed=aaaaaaa/, /PR #482/);
  ok("1", `${IMPL} · ${A}=failed ${B} ${r1}`);
});

test("a past-pin re-review under the next free letter is accepted", (t) => {
  const { ok } = fixture(t);
  ok("1", `${IMPL} · ${A} ${r1} fix-pr-482=applied:b7adf86 ${HALT}`);
  ok("1", `${IMPL} · ${A} ${r1} fix-pr-482=applied:b7adf86 ${HALT} review=member:review-pr-482-b`);
  ok("1", `${IMPL} · ${A} ${r1} fix-pr-482=applied:b7adf86 ${HALT} review=member:review-pr-482-b ${r2}`);
});

test("the review-and-fix self-apply fallback, reviewed at the head it pushed, is accepted", (t) => {
  const { ok } = fixture(t);
  ok("1", `${IMPL} · ${A}`);
  ok("1", `${IMPL} · ${A}=failed ${B}`);
  ok("1", `${IMPL} · ${A}=failed ${B} reviewed=c0ffee1:0/1/2:run-ccccccc3`);
});

test("a PR with a fallback and a past-pin re-review takes -b and then -c", (t) => {
  const { ok } = fixture(t);
  ok("1", `${IMPL} · ${A}=failed ${B} ${r1}`);
  ok("1", `${IMPL} · ${A}=failed ${B} ${r1} ${HALT} ${C} ${r3}`);
});

test("launch and result on two rows of one PR: accepted when the launch's row comes first, refused when the result's does", (t) => {
  const first = fixture(t, [`#482 PR#482 · ${A}`, "#1 impl-1=PR#482 → PR#482"]);
  first.ok("1", `${IMPL} · ${r1}`);
  const second = fixture(t, ["#1 impl-1=PR#482 → PR#482", `#482 PR#482 · ${A}`]);
  second.refused("1", `${IMPL} · ${r1}`, /'reviewed=aaaaaaa/, /PR #482/);
});

// ---- rule: unique launches ----

test("a past-pin re-review reusing the first reviewer's name is refused, naming the next free name", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · ${A} ${r1} ${HALT}`);
  refused("1", `${IMPL} · ${A} ${r1} ${HALT} ${A}`, /'review=member:review-pr-482'/, /PR #482/, /unique launches/, /review-pr-482-b\b/);
});

test("the next free name skips every letter the PR's rows already carry, whatever the launch's kind", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · ${A}=failed ${B} ${r1} ${HALT}`);
  refused("1", `${IMPL} · ${A}=failed ${B} ${r1} ${HALT} ${B}`, /'review=fallback:review-pr-482-b'/, /review-pr-482-c\b/);
});

test("a runner name a launch of the other kind already used is refused as a repeated launch", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · review=fallback:review-pr-482 ${r1}`);
  refused("1", `${IMPL} · review=fallback:review-pr-482 ${r1} ${A}`, /'review=member:review-pr-482'/, /PR #482/, /unique launches/, /review-pr-482-b\b/);
});

test("a repeated workflow runId is refused as a repeated launch", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · review=wf:r1 ${r1}`);
  refused("1", `${IMPL} · review=wf:r1 ${r1} review=wf:r1`, /'review=wf:r1'/, /PR #482/);
});

test("a launch rewritten in place to =failed is not a repeat", (t) => {
  const { ok } = fixture(t);
  ok("1", `${IMPL} · ${A}`);
  ok("1", `${IMPL} · ${A}=failed`);
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
  const { ok, refused, rows } = fixture(t, [`#1 ${IMPL} · ${A} ${r1} ${r2}`]);
  ok("1", `${IMPL} · class=routine · ${A} ${r1} finisher-pr-482 ${r2}`);
  ok("1", `${r2} ${IMPL} · ${A} ${r1}`);
  refused("1", `${IMPL} · ${A} ${r1} ${r2} ${r2}`, /'reviewed=b7adf86/);
  assert.deepEqual(rows(), [`#1 ${r2} ${IMPL} · ${A} ${r1}`]);
});

test("a repeated member already on the row is carried; a third copy is refused", (t) => {
  const { ok, refused } = fixture(t, [`#1 ${IMPL} · fix-pr-482 fix-pr-482=applied:b7adf86`]);
  ok("1", `${IMPL} · class=routine · fix-pr-482 fix-pr-482=applied:b7adf86`);
  refused("1", `${IMPL} · fix-pr-482 fix-pr-482=applied:b7adf86 fix-pr-482`, /'fix-pr-482'/);
});

test("a repeated launch already on the PR is carried, and settling its repeat =failed in place is no new repeat", (t) => {
  const { ok } = fixture(t, [`#1 ${IMPL} · ${A} ${r1} ${HALT} ${A}`]);
  ok("1", `${IMPL} · class=routine · ${A} ${r1} ${HALT} ${A}`);
  ok("1", `${IMPL} · ${A} ${r1} ${HALT} ${A}=failed`);
});

// ---- rule: one open launch per PR ----

test("a second launch while one is open is refused on the same row, naming the PR, the open launch and both ways out", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · ${A}`);
  refused("1", `${IMPL} · ${A} ${B}`, /PR #482/, WHILE_A_OPEN, /one open launch/, /reviewed=/, /Member-killed/, /=failed in the same rewrite/);
});

test("a second launch while one is open is refused on another row that maps to the PR", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · ${A}`);
  refused("482", `PR#482 · ${B}`, /PR #482/, WHILE_A_OPEN);
});

test("a new launch written on a row BEFORE the open launch's row is still the offender, and the open launch the one the ledger held", (t) => {
  const { refused } = fixture(t, ["#482 PR#482 · ci=1:1:success", `#1 ${IMPL} · ${A}`]);
  refused("482", `PR#482 · ci=1:1:success ${B}`, WHILE_A_OPEN);
});

test("adding an already-failed launch after an open one is refused", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · ${A}`);
  refused("1", `${IMPL} · ${A} ${B}=failed`, WHILE_A_OPEN, /one open launch/);
});

test("settling an open launch =failed in place is accepted, alone and with a new launch in the same rewrite", (t) => {
  const alone = fixture(t);
  alone.ok("1", `${IMPL} · ${A}`);
  alone.ok("1", `${IMPL} · ${A}=failed`);
  const withNew = fixture(t);
  withNew.ok("1", `${IMPL} · ${A}`);
  withNew.ok("1", `${IMPL} · ${A}=failed ${B}`);
});

test("a ledger already holding two open launches on one PR accepts a rewrite carrying them, and one settling either =failed", (t) => {
  const seed = [`#1 ${IMPL} · ${A} ${B}`];
  fixture(t, seed).ok("1", `${IMPL} · class=routine · ${A} ${B}`);
  fixture(t, seed).ok("1", `${IMPL} · ${A}=failed ${B}`);
  fixture(t, seed).ok("1", `${IMPL} · ${A} ${B}=failed`);
});

// ---- rule: an open launch is never removed ----

test("dropping an open launch, or rewriting it to another identity, is refused", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · ${A}`);
  refused("1", `${IMPL}`, /'review=member:review-pr-482'/, /PR #482/, /open launch/, /Member-killed/);
  refused("1", `${IMPL} · ${B}`, /'review=member:review-pr-482'/, /PR #482/);
  refused("1", `${IMPL} · review=wf:r9`, /'review=member:review-pr-482'/);
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
  const { ok, refused } = fixture(t, [`#1 ${IMPL} · review=garbage reviewed=nothead`]);
  ok("1", `${IMPL} · class=routine · review=garbage reviewed=nothead`);
  refused("1", `${IMPL} · review=garbage reviewed=nothead review=wf:`, /'review=wf:'/, /PR #482/);
  refused("1", `${IMPL} · review=garbage reviewed=nothead review=garbage`, /'review=garbage'/);
  refused("1", `${IMPL} · review=garbage reviewed=nothead reviewed=aaaaaaa:1/0/0`, /'reviewed=aaaaaaa:1\/0\/0'/);
});

// ---- every PR's stream is judged, not just the first in ledger order ----

const OTHER = "impl-4=PR#4 → PR#4 · review=member:review-pr-4 reviewed=bbbbbbb:1/0/0:run-bbbbbbb4";

test("a violation on a PR whose stream is not first in ledger order is refused", (t) => {
  const { ok, refused } = fixture(t, [`#4 ${OTHER}`, `#1 ${IMPL} · ${A}`]);
  // Added to the later stream: an unpaired result, a crowded launch, a dropped open launch.
  refused("1", `${IMPL} · ${A} ${r1} ${r2}`, /PR #482/, /paired results/);
  refused("1", `${IMPL} · ${A} ${B}`, /PR #482/, /one open launch/);
  refused("1", `${IMPL}`, /PR #482/, /removes open launch/);
  // A write on that stream that adds nothing wrong is still accepted.
  ok("1", `${IMPL} · ${A} ${r1}`);
});

test("a reviewed= whose head is under seven hex digits is refused as unparseable", (t) => {
  const { ok, refused } = fixture(t);
  ok("1", `${IMPL} · ${A}`);
  refused("1", `${IMPL} · ${A} reviewed=abc:1/0/0:run-xxxxxxxx`, /'reviewed=abc:1\/0\/0:run-xxxxxxxx'/, /PR #482/);
});

test("rows that map to no PR and carry no key are streams of their own, not one shared stream", () => {
  const first = "alpha · review=member:review-pr-1";
  const second = "beta · review=member:review-pr-2";
  assert.equal(rowWriteRefusal([first], [first, second], null, second), null);
  const answer = "beta · reviewed=aaaaaaa:1/0/0:run-aaaaaaa1";
  assert.match(rowWriteRefusal([first], [first, answer], null, answer), /answers no open launch/);
});

// ---- rows that carry no review record are untouched ----

test("rows with no review tokens, and rows of other PRs, are accepted as before", (t) => {
  const { ok } = fixture(t, [`#2 impl-2=PR#483 → PR#483 · ${A} ${r1} ${r2}`]);
  ok("1", `${IMPL} · class=routine`);
  ok("1", `${IMPL} · ${A}`);
  ok("3", "impl-3 · class=correction · tier=task-high");
});
