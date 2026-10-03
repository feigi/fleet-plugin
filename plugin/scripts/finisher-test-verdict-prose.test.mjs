// A finisher's duty-2 `<testCmd>` run can be killed from outside — an external
// `timeout`, SIGKILL, an `eval` cell deadline — and a killed `node --test`
// still prints a summary covering only the tests it reached. Read as a verdict
// it turns a partial suite into a clean pass; read the same way in the
// mutation direction it turns cancelled files into a mutant that "reddened".
// The finisher's agent definition carries no duty text, so the rule reaches
// it only through the verbatim block the controller hands over — which is
// what this file pins, one sentence per pin so a clause deleted from inside
// the block reds its own pin rather than being satisfied by a neighbour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteBlock, sentences, stripQuoteGutter } from "./prose-pin.mjs";
import { HALT_CAUSES } from "./ledger-grammar.mjs";

const RUN_TEAM = readFileSync(join(import.meta.dirname, "..", "skills", "run-team", "SKILL.md"), "utf8");

const OPENER = "**A test run is a verdict only if it ran to completion";
const block = () =>
  stripQuoteGutter(quoteBlock(RUN_TEAM, OPENER, "the finisher's test-run verdict block")).replace(/\s+/g, " ");
const sentenceWith = (re, what) => {
  const hits = sentences(block()).filter((s) => re.test(s));
  assert.equal(hits.length, 1, `${what}: ${hits.length} sentences match ${re} in the verdict block`);
  return hits[0];
};

test("a run is a verdict only on the command's own exit 0 with tests above 0 and cancelled 0", () => {
  const s = sentenceWith(/is a verdict only when/, "verdict condition");
  assert.match(s, /exit status is 0/);
  assert.match(s, /`tests` above 0/);
  assert.match(s, /`cancelled` 0/);
  assert.match(sentenceWith(/summary line without that/, "bare summary"), /is not a verdict, whatever pass count it prints/);
});

test("124, 137 and 143 are a killed run, FAILED for green, and never a pass or a mutant reddening", () => {
  const s = sentenceWith(/124/, "kill signatures");
  assert.match(s, /137/);
  assert.match(s, /143/);
  assert.match(block(), /Any exit that is not a plain test failure of a completed run is a killed run/);
  assert.match(sentenceWith(/read for green it is FAILED/, "killed run bucket"), /same bucket as `tests 0`, however many tests had passed before the kill/);
  const mutation = sentenceWith(/not a mutant that reddened/, "mutation direction");
  assert.match(mutation, /files it cancelled are not failures/);
});

test("the halt for a killed run names cause `other` with the exit code and summary as evidence", () => {
  assert.ok(HALT_CAUSES.includes("other"), "ledger grammar no longer accepts the `other` halt cause this block names");
  const s = sentenceWith(/Halt with cause/, "halt cause");
  assert.match(s, /cause `other`/);
  assert.match(s, /exit code plus the summary line as evidence/);
  assert.match(s, /label nothing/);
});

test("the exit status is read off the test command itself, never a pipeline's", () => {
  const s = sentenceWith(/Never read the status of/, "pipeline rule");
  assert.match(s, /`<testCmd> \| tail`/);
  assert.match(s, /`<testCmd> \| grep`/);
  assert.match(s, /a pipeline's status is its last stage's, so the filter's 0 hides the run's own exit/);
  assert.match(s, /earlier stages' statuses is spelled differently per shell/);
  assert.match(sentenceWith(/Redirect the run's output to a file/, "redirect rule"), /read the command's own `\$\?` straight after it/);
});

test("testCmd is never wrapped in an external timeout, and a long suite runs in one eval cell with timeout 0", () => {
  assert.match(sentenceWith(/Do not wrap/, "no external timeout"), /external `timeout`/);
  assert.match(sentenceWith(/Run a long suite/, "eval cell"), /one `eval` cell with `timeout: 0`/);
});

// The other half: what the rule must ACCEPT. A completed red run is a plain
// failure the finisher reports as one, and `tests 0` keeps its own bucket.
test("a completed red run and a zero-test run keep their own verdicts", () => {
  const s = sentenceWith(/A completed red run/, "completed red run");
  assert.match(s, /exit 1, `cancelled` 0/);
  assert.match(s, /plain failure, not a killed run/);
  assert.match(s, /exit 0 with `tests 0` stays FAILED/);
});
