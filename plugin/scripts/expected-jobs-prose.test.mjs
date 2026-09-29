// #847. The comment introducing ci-state.mjs's expected-job derivation carried
// figures — how many jobs "the fleet's prose" names, how many "the workflow"
// defines. What a reader checking whether an empty `missing` is vacuous needs
// from that comment is the PROPERTY: the list is derived from the workflow this
// run resolved, never hardcoded. This file pins that claim, with its polarity.
//
// It does not ban a job count. The ban it once carried refused every cardinal
// sharing a sentence with "job" — "3 workers", "job 2 of a matrix build" (#1194)
// — and still let a count spelled above ten through (#1193). The list is
// derived, so a stale count in this comment misleads a reader and changes no
// behaviour, and the comment itself says why it names no set. A pin that reds
// on legitimate prose to police a figure that moves nothing costs more than the
// figure.
//
// THE CEILING: this reds when no comment introduces expectedJobs(), and when the
// comment stops claiming the list is derived or never hardcoded. It cannot prove
// the surrounding argument sound, and it never runs ci-state.mjs —
// ci-state.test.mjs owns the derivation's behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CI_STATE = readFileSync(fileURLToPath(new URL("./ci-state.mjs", import.meta.url)), "utf8");

// The ARGUED comment introducing the derivation: the contiguous `//` run directly
// above `function expectedJobs(`, stopping below the `// --- … ---` section
// banner. ci-state.mjs discusses jobs, workflows and derivation in neighbouring
// comments, so a match over the file would stay green with this block gutted —
// satisfied entirely by prose the rule does not govern. The banner is that same
// hole one line closer: it says "derived" by itself, so including it would let
// the whole argued comment be deleted with the derivation half still satisfied.
// Stopping at the first non-comment line also means a block moved away from
// expectedJobs() reds here rather than silently widening the slice back to the
// file.
function derivationComment() {
  const at = CI_STATE.indexOf("function expectedJobs(");
  assert.notEqual(at, -1, "expectedJobs() moved or was renamed — update this test");
  const lines = CI_STATE.slice(0, at).split("\n");
  const block = [];
  for (let i = lines.length - 2; i >= 0 && /^\s*\/\//.test(lines[i]) && !/^\s*\/\/\s*---/.test(lines[i]); i--) {
    block.unshift(lines[i].replace(/^\s*\/\/\s?/, ""));
  }
  assert.notEqual(block.length, 0, "no comment introduces expectedJobs() any more — #847 asked for one that states the property");
  return block.join(" ").replace(/\s+/g, " ");
}

/**
 * The rule, as a function so the refuse cases can be fed prose this repo does
 * not contain. Returns null when the comment is sound, else the reason.
 */
export function derivationCommentFault(comment) {
  // The NEGATED form, not the bare word, on BOTH sides: `hardcoded` alone is
  // polarity-blind, and so is `deriv` alone — a comment asserting the list IS
  // hardcoded, or that it is NOT derived, is the exact fault this refuses.
  const derivedSound = /\bderiv/i.test(comment) && !/\b(?:never|not)\s+deriv/i.test(comment);
  const hardcodedSound = /\b(?:never|not)\s+hardcoded/i.test(comment);
  if (!derivedSound && !hardcodedSound) {
    return "the expected-job comment no longer says the list is derived from the workflow rather than hardcoded — the one thing a reader checking whether an empty `missing` is vacuous needs from it";
  }
  return null;
}

test("the expected-job comment says the list is derived, never hardcoded", () => {
  assert.equal(derivationCommentFault(derivationComment()), null);
});

// What the rule REFUSES, which the test above cannot show: a comment that drops
// the claim, and one that reverses it.
test("a comment that drops or reverses the derivation claim is refused", () => {
  assert.equal(derivationCommentFault("Never hardcoded: expectedJobs() parses the `jobs:` block of the workflow file this run resolved."), null);
  assert.equal(derivationCommentFault("Derived from the workflow, which defines 5 jobs."), null);
  assert.match(derivationCommentFault("The list tracks the workflow file automatically."), /no longer says the list is derived/);
  // Polarity: asserting the list IS hardcoded must refuse, not satisfy.
  assert.match(derivationCommentFault("The expected job list is hardcoded below because the workflow never changes."), /no longer says the list is derived/);
  // Polarity, the other direction: asserting the list is NOT derived must
  // refuse too, not slip through on the bare `deriv` substring match.
  assert.match(derivationCommentFault("This list is not derived from anything; it is fully hardcoded for performance."), /no longer says the list is derived/);
});
