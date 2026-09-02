// #847. The comment introducing ci-state.mjs's expected-job derivation carried
// two figures — how many jobs "the fleet's prose" names, how many "the workflow"
// defines — and neither was true of this repo: `.github/workflows/ci.yml` here
// defines `rebase-check` and `check`. They were never measured here at all. They
// describe the agent-brain repo's workflow, recorded in
// docs/specs/2026-07-23-fleet-plugin-design.md, which lives on an internal GHE
// host and so cannot be settled from this repo either way.
//
// The durable fix is the one #348 already established for
// `.github/workflows/ci.yml` in ci-comment-rot-prose.test.mjs: prose pinning a
// measurable property of a file it does not own states the PROPERTY, never the
// measurement. This file keeps the derivation comment that way.
//
// It bans a TALLY, not a number — the distinction #348 drew and PR #554 paid
// for. A pin coupling prose to a moving figure reds on every legitimate edit and
// gets deleted or routed around, so a cardinal only offends here when it sits in
// the same sentence as "job". "read the workflow, not this one" has to stay
// green, and the accept case below is what proves it does.
//
// THE CEILING: this proves the comment carries no job tally and still claims the
// derivation. It cannot prove the surrounding argument is sound, and it never
// runs ci-state.mjs — ci-state.test.mjs owns the derivation's behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CI_STATE = readFileSync(fileURLToPath(new URL("./ci-state.mjs", import.meta.url)), "utf8");

// The comment block introducing the derivation: the contiguous `//` run directly
// above `function expectedJobs(`, and nothing else. SLICE SIZE is what anchors
// this. ci-state.mjs discusses jobs, workflows and derivation in neighbouring
// comments, so a match over the file would stay green with this block gutted —
// satisfied entirely by prose the rule does not govern. Stopping at the first
// non-comment line also means a block moved away from expectedJobs() reds here
// rather than silently widening the slice back to the file.
function derivationComment() {
  const at = CI_STATE.indexOf("function expectedJobs(");
  assert.notEqual(at, -1, "expectedJobs() moved or was renamed — update this test");
  const lines = CI_STATE.slice(0, at).split("\n");
  const block = [];
  for (let i = lines.length - 2; i >= 0 && /^\s*\/\//.test(lines[i]); i--) {
    block.unshift(lines[i].replace(/^\s*\/\/\s?/, ""));
  }
  assert.notEqual(block.length, 0, "no comment introduces expectedJobs() any more — #847 asked for one that states the property");
  return block.join(" ").replace(/\s+/g, " ");
}

const CARDINAL = String.raw`\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten`;

/**
 * The rule, as a function so the accept case can be fed prose this repo does not
 * contain. Returns null when the comment is sound, else the reason.
 */
export function derivationCommentFault(comment) {
  // An issue citation is a pointer, not a tally, so `#847` must not read as one.
  const claims = comment.replace(/#\d+/g, "");
  // A tally is a number sharing a SENTENCE with the jobs it counts, which is the
  // shape all three stale figures took ("names four jobs", "defines five",
  // "defines two"). Sentence-scoped rather than comment-scoped so an unrelated
  // cardinal elsewhere in the block is not collateral.
  for (const sentence of claims.split(/(?<=\.)\s+/)) {
    if (!/\bjobs?\b/i.test(sentence)) continue;
    const n = sentence.match(new RegExp(String.raw`\b(${CARDINAL})\b`, "i"));
    if (n) {
      return `the expected-job comment tallies jobs ("${n[1]}"), and a count is false the next commit that adds one: "${sentence.trim()}"`;
    }
  }
  if (!/\bderiv|hardcoded\b/i.test(claims)) {
    return "the expected-job comment no longer says the list is derived from the workflow rather than hardcoded — the one thing a reader checking whether an empty `missing` is vacuous needs from it";
  }
  return null;
}

test("the expected-job comment states the property, not a job count", () => {
  assert.equal(derivationCommentFault(derivationComment()), null);
});

// The other half. A guard that only ever sees the one input this tree holds pins
// nothing about what it REFUSES — and a rule this blunt can refuse a legitimate
// reword, which is how a prose pin earns its own deletion. So: prose that talks
// about jobs without counting them, and a cardinal that is not a tally, both stay
// green.
test("a tally is refused; job prose without a count, and a non-counting cardinal, are accepted", () => {
  const ok = "Never hardcoded: expectedJobs() parses the `jobs:` block of the workflow file this run resolved. Read that workflow for the current set, not this one.";
  assert.equal(derivationCommentFault(ok), null);
  assert.equal(derivationCommentFault("Derived. A job the prose never names is still expected. See #847 and #927."), null);

  assert.match(derivationCommentFault("Never hardcoded. The fleet's prose names four jobs; the workflow defines five."), /tallies jobs \("four"\)/);
  assert.match(derivationCommentFault("Derived from the workflow, which defines two jobs."), /tallies jobs \("two"\)/);
  assert.match(derivationCommentFault("The list tracks the workflow file automatically."), /no longer says the list is derived/);
});
