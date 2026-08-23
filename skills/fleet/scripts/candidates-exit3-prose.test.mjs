// #407. PR #404 gave `candidates.mjs` a third exit code and touched no document
// outside the script. Every consumer-facing statement of the contract still
// named two, so a model consumer meeting exit 3 had no rule for it and the
// nearest rule it did have was "2 = the query broke" — the likeliest reading of
// a successful all-specs query was a failed one.
//
// The condition these pins describe is derived from the script, not from the
// ticket's paraphrase: `allFilteredOut = rawCount > 0 && rows.length === 0`
// (candidates.mjs:378), reassigned WHOLESALE in the fallback branch (:390) and
// never OR'd with pass 1's value, then `rows.length === 0 ? (allFilteredOut ? 3
// : 1) : 0` (:424). So exit 3 is "the FINAL query attempt returned rows and
// dropSpecs removed every one" — a labeled pass the filter emptied that falls
// back to a genuinely empty unfiltered pass is exit 1, which candidates.test.mjs
// pins from the other side.
//
// THE CEILING, same as inflight-exit2-prose.test.mjs: these are PRESENCE pins
// over a bounded slice. Text spliced INSIDE a pinned phrase reddens them; a
// whole new sentence appended after one, carving out an exception, does not.
// A reflow (line wraps, `**bold**` moved) stays green by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const NEXT_TICKET = read("skills", "fleet", "skills", "next-ticket", "SKILL.md");
const RUN_TEAM = read("skills", "fleet", "skills", "run-team", "SKILL.md");

const candidatesStep = () =>
  between(NEXT_TICKET, "## 1. Candidates", "## 2. Dependencies", "next-ticket/SKILL.md");

test("next-ticket's exit-code line tells exit 3 from the empty queue and from the broken query", () => {
  const s = candidatesStep();
  assert.match(s, phrase("Exit 1 = query fine, queue empty"));
  assert.match(s, phrase("Exit 3 = query fine, rows came back and the to-spec filter took every one"));
  assert.match(s, phrase("Exit 2 = query broke"));
});

test("next-ticket sends exit 3 to to-tickets rather than reading it as no work", () => {
  // The distinction the code exists to make: this caller's own invocation
  // reaches exit 3, so "empty" here would send it to the wrong conclusion.
  assert.match(candidatesStep(), phrase("run to-tickets rather than reading it as no work"));
});

test("next-ticket scopes exit 3 to the final pass, so it agrees with the fallback trigger", () => {
  // `--allow-fallback` is this caller's prescribed invocation, so the
  // final-pass rule is not a footnote here — it decides whether exit 3 or
  // exit 1 comes back, and a reader who misses it connects exit 3 to the
  // "counts as empty" sentence above and concludes the two disagree.
  const s = candidatesStep();
  assert.match(s, phrase("Exit 3 judges the LAST pass alone"));
  assert.match(s, phrase("falls back to a genuinely empty one is exit 1"));
});

// The same slice candidates.test.mjs bounds for the `--require-label` rule —
// `1. **Candidate scan**` to the step after it. A match anywhere in phase 0 is
// vacuous: phase 0 discusses `inflight.sh`'s exit 2 at length a few steps down,
// so a file-wide search for "exit" finds another script's contract and reports
// this one as documented.
const scanStep = () =>
  between(RUN_TEAM, "1. **Candidate scan**", "\n2. ", "run-team/SKILL.md");

test("phase 0 denies that exit 3 is the empty queue", () => {
  const s = scanStep();
  assert.match(s, phrase("Exit 3 is not that empty queue"));
  assert.match(s, phrase("the to-spec filter took every one"));
});

test("phase 0 forbids answering exit 3 by widening the net", () => {
  // The hazard this rule exists to close, and the one a careless wording
  // opens: exit 3 proves there ARE labeled items, which reads as evidence the
  // filter is too tight. It is not — the items are specs, and the fallback
  // pass is unfiltered, so widening reaches `ready-for-human` and untriaged
  // work an unattended run still has no channel to a human for.
  const s = scanStep();
  assert.match(s, phrase("never a reason to widen the net"));
  assert.match(s, phrase("still do not pass `--allow-fallback`"));
});

test("phase 0 names what exit 3's queue actually holds, so the run reports it rather than claiming no work", () => {
  const s = scanStep();
  assert.match(s, phrase("to-tickets' input rather than claimable tickets"));
  assert.match(s, phrase("Log it as specs awaiting to-tickets"));
});
