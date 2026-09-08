// #93. `run-team/SKILL.md`'s in-flight step said only "any hit = taken" and
// never named `inflight.sh`'s exit 2, so a controller following it literally had
// no instruction for "the question could not be answered". In `sh`, both
// `cmd || handle` and `if cmd; then` treat 1 and 2 alike, so the natural reading
// files an unanswerable probe under "taken" by accident rather than by rule —
// the safe direction, but undocumented.
//
// The pins below are the four rules the corrected step has to carry, each
// checked against `inflight.sh` itself before being written down:
//
//   1. exit 2 from a probe failure carries the same JSON as 0 and 1 plus an
//      `unknown[]` (inflight.sh's header, and its single unconditional
//      `{"issue":%s,"taken":%s,…}` printf, which every rc reaches);
//   2. `taken` is false on that payload (its `taken=false` arms), summarizing
//      `hits` and NOT claiming the ticket is free — so a consumer reads
//      `unknown`;
//   3. a hit outranks an unknown, so a non-empty `hits[]` AND a non-empty
//      `unknown[]` is exit 1, taken (its `taken=true`/`rc=1` arm);
//   4. four causes still exit 2 with no payload at all — the `die()` inflight.sh
//      defines up top, reached by a bad argument (its usage and numeric-issue
//      guards), not being inside a git repository, `issue #$n does not exist in
//      this repository`, and `could not write the verdict` — so exit 2 is not
//      assumed to parse.
//
// Rule 4 is the one that makes the other three safe to state: without it the
// step would read as "exit 2 always carries a payload", which is false, and a
// consumer that reaches for `.unknown` on a `die()` would find no stdout at all.
//
// `next-ticket/SKILL.md` is pinned too, not corrected — it already carried the
// rule and is the wording run-team was told to match. If it drifts, the two
// documents disagree about one script and this test says so.
//
// THE CEILING, same as refuter-scratch-prose.test.mjs: these are PRESENCE pins
// over a bounded slice. Text spliced INSIDE a pinned phrase reddens them; a
// whole new sentence appended after one, carving out an exception, does not.
// A reflow (line wraps, `**bold**` moved) stays green by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("skills", "run-team", "SKILL.md");
const NEXT_TICKET = read("skills", "next-ticket", "SKILL.md");

const step = () =>
  between(RUN_TEAM, "**In-flight check**", "**Read each survivor in full", "run-team/SKILL.md");

test("the in-flight step names exit 2 and refuses to read it as free", () => {
  assert.match(step(), phrase("Exit 2 is not free"));
  assert.match(step(), phrase("treat it as taken"));
});

test("the in-flight step tells the reader to read `unknown`, not `taken` alone", () => {
  assert.match(step(), phrase("read `unknown`, never `taken` alone"));
  // The trap the payload sets: exit 2 says taken:false, which is a summary of
  // `hits` and not a claim about the ticket.
  assert.match(step(), phrase('exit 2 says `"taken": false`'));
  assert.match(step(), phrase("not a claim the ticket is free"));
});

test("the in-flight step ranks a hit above an unknown", () => {
  assert.match(step(), phrase("A hit outranks an unknown"));
  // Both arrays non-empty at exit 1 is the case the rule exists for.
  assert.match(step(), phrase("non-empty `hits[]` and a non-empty `unknown[]` at exit 1"));
});

test("the in-flight step denies that exit 2 always parses", () => {
  assert.match(step(), phrase("Four causes print nothing at all"));
  assert.match(step(), phrase("a bad argument, not inside a git repository, no such issue, a verdict that could not be written"));
  assert.match(step(), phrase("never assume exit 2 parses"));
});

test("next-ticket/SKILL.md still carries the wording run-team was made to match", () => {
  const s = between(NEXT_TICKET, "## 3. In-flight check", "## 4. Suggest", "next-ticket/SKILL.md");
  assert.match(s, phrase("0 free, 1 taken, 2 unanswerable"));
  assert.match(s, phrase("Exit 2 is not free"));
  assert.match(s, phrase("treat it as taken until you know"));
});
