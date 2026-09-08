// #407. PR #404 gave `candidates.mjs` a third exit code and touched no document
// outside the script. Every consumer-facing statement of the contract still
// named two, so a model consumer meeting exit 3 had no rule for it and the
// nearest rule it did have was "2 = the query broke" — the likeliest reading of
// a successful all-specs query was a failed one.
//
// The condition these pins describe is derived from the script, not from the
// ticket's paraphrase: `allFilteredOut = rawCount > 0 && rows.length === 0`
// (candidates.mjs's `allFilteredOut`), reassigned WHOLESALE in the fallback
// branch and never OR'd with pass 1's value, then `rows.length === 0 ?
// (allFilteredOut ? 3 : 1) : 0` at that script's `process.exitCode`
// assignment. So exit 3 is "the FINAL query attempt returned rows and
// dropSpecs removed every one" — a labeled pass the filter emptied that falls
// back to a genuinely empty unfiltered pass is exit 1, which candidates.test.mjs
// pins from the other side.
//
// THE CEILING, same as inflight-exit2-prose.test.mjs: these are PRESENCE pins
// over a bounded slice. Text spliced INSIDE a pinned phrase reddens them; a
// whole new sentence appended after one, carving out an exception, does not.
// A reflow (line wraps, `**bold**` moved) stays green by design. The
// declared-code scan carries a second ceiling of its own, stated at
// `declaredNonZeroCodes`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const NEXT_TICKET = read("skills", "next-ticket", "SKILL.md");
const RUN_TEAM = read("skills", "run-team", "SKILL.md");
const SPEC = read("docs", "specs", "2026-07-23-fleet-plugin-design.md");

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

// --- The script-surface contract table, and the preamble that scopes it.
const scriptSurface = () =>
  between(SPEC, "## Script surface", "| Script | In | Out |", "the fleet-plugin design spec");

const candidatesRow = () => {
  const line = SPEC.split("\n").find((l) => l.startsWith("| `candidates.mjs` |"));
  assert.ok(line, "the design spec's script-surface table no longer has a `candidates.mjs` row — update this test");
  return line;
};

test("the spec's candidates row stops reading an all-specs queue as exit 1", () => {
  const row = candidatesRow();
  // The clause as it stood absorbed the exit-3 case: "no candidate survived"
  // is true of a queue the filter emptied, which is exit 3. Narrowing it is
  // the correction — appending exit 3 while leaving this would ship two
  // clauses in one cell that contradict each other.
  assert.doesNotMatch(row, phrase("no candidate survived"));
  assert.match(row, phrase("no row came back at all"));
  assert.match(row, phrase("the to-spec filter removed every one"));
});

test("the spec's preamble states the further-code property instead of naming one carrier", () => {
  // Naming `ledger.mjs check` as THE script with an extra code made the
  // preamble false by omission the moment a second script minted one. A
  // property carries no carrier list to go stale and no tally to rot.
  const s = scriptSurface();
  assert.doesNotMatch(s, phrase("`ledger.mjs check` mints one further code"));
  assert.match(s, phrase("Where a script needs a verdict those meanings cannot carry, it mints a further code and states it in its own row"));
});

// Derived from the script's own contract rather than restating it: this is the
// check that would have caught #407 the day PR #404 landed. Add a code to the
// header in the `N = ` form every code there uses today, and each carrier the
// coverage test reads reddens until it names the code too.
//
// THE SCAN'S CEILING: `N = ` is the only spelling it reads. Declare a code in
// the same contract block as `exit 4 — ...` and this scan does not see it, so
// the coverage test stays green over a code no document names — measured, next
// to a `4 = ` control that reddens. Widening the scan to any digit next to `=`
// or an em-dash was measured too: it does catch that spelling, and it also
// mints a code out of ordinary header prose, so a bare `(#7 — see there)`
// reddens the coverage test over a code nobody declared. What holds this up
// is the contract's own wording — declare a new code `N = `, or teach this
// scan the spelling you chose.
//
// Guarded at each step and called from a test body, never run at module scope:
// an unguarded index here fails at IMPORT, taking the unrelated tests in this
// file down with it and naming nothing as the thing to look at.
function declaredNonZeroCodes() {
  const src = read("scripts", "candidates.mjs");
  const header = src.slice(0, src.indexOf("\nimport "));
  const at = header.indexOf("Exit-code contract");
  assert.notEqual(at, -1, "candidates.mjs' header no longer states an `Exit-code contract` — update this test");
  const codes = [...header.slice(at).matchAll(/\b(\d) = /g)].map((m) => m[1]);
  assert.ok(codes.includes("0"), "candidates.mjs' exit-code contract no longer declares 0 — update this test");
  const nonZero = [...new Set(codes)].filter((c) => c !== "0");
  assert.ok(nonZero.length > 0, "candidates.mjs' exit-code contract declares no non-zero code — update this test");
  return nonZero;
}

test("every non-zero code the script declares is named by the documents a consumer reads", () => {
  // run-team/SKILL.md's candidate scan step is deliberately NOT a carrier here.
  // It carries a rule for exit 3 alone — the exit that sends an all-specs queue
  // to to-tickets — and names neither exit 1 nor exit 2, reading an empty queue
  // as no work in prose instead. This loop asserts every declared code is named
  // by every carrier it reads, so listing that step reddens on exit 1 (measured).
  // Leaving it out is a decision, not an oversight.
  for (const [what, text] of [
    ["next-ticket/SKILL.md's candidate step", candidatesStep()],
    ["the design spec's candidates row", candidatesRow()],
  ]) {
    for (const code of declaredNonZeroCodes()) {
      assert.match(
        text,
        new RegExp(`exit ${code}\\b`, "i"),
        `${what} does not name exit ${code}, which candidates.mjs' own exit-code contract declares`,
      );
    }
  }
});
