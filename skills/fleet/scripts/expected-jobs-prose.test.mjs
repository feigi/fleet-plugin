// #847. The comment introducing ci-state.mjs's expected-job derivation carried
// figures — how many jobs "the fleet's prose" names, how many "the workflow"
// defines. A figure for a file that comment does not own is false the next commit
// that changes that file.
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
// green, which the accept cases in the "a tally is refused…" test pin.
//
// THE CEILING: this reds when no comment introduces expectedJobs(), when the
// comment stops claiming the list is derived or never hardcoded, and when a digit
// or a zero–ten cardinal shares a sentence with the word "job". A tally phrased
// without that word, split across a sentence boundary from it, or spelled above
// ten walks through — the vocabulary limit is #1193, and #1194 is the converse,
// a cardinal counting something else refused anyway. It cannot prove the
// surrounding argument sound, and it never runs ci-state.mjs — ci-state.test.mjs
// owns the derivation's behavior.

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

const CARDINAL = /\b(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

/**
 * The rule, as a function so the accept case can be fed prose this repo does not
 * contain. Returns null when the comment is sound, else the reason.
 */
export function derivationCommentFault(comment) {
  // An issue citation is a pointer, not a tally, so `#847` must not read as one.
  const claims = comment.replace(/#\d+/g, "");
  // A tally is a number sharing a SENTENCE with the jobs it counts, which is the
  // shape both stale figures took ("names four jobs", "defines five").
  // Sentence-scoped rather than comment-scoped so an unrelated cardinal elsewhere
  // in the block is not collateral.
  for (const sentence of claims.split(/(?<=\.)\s+/)) {
    if (!/\bjobs?\b/i.test(sentence)) continue;
    const n = sentence.match(CARDINAL);
    if (n) {
      return `the expected-job comment tallies jobs ("${n[0]}"), and a count is false the next commit that adds one: "${sentence.trim()}"`;
    }
  }
  // The NEGATED form, not the bare word: `hardcoded` alone is polarity-blind, and
  // a comment asserting the list IS hardcoded is the exact fault this refuses.
  if (!/\bderiv|\b(?:never|not) hardcoded/i.test(claims)) {
    return "the expected-job comment no longer says the list is derived from the workflow rather than hardcoded — the one thing a reader checking whether an empty `missing` is vacuous needs from it";
  }
  return null;
}

test("the expected-job comment states the property, not a job count", () => {
  assert.equal(derivationCommentFault(derivationComment()), null);
});

// What the rule REFUSES, which the test above cannot show. A guard that only ever
// sees the one input this tree holds pins nothing about its own refusals — and a
// rule this blunt can refuse a legitimate reword, which is how a prose pin earns
// its own deletion. So: prose that talks about jobs without counting them, and a
// cardinal that is not a tally, both stay green.
test("a tally is refused; job prose without a count, and a non-counting cardinal, are accepted", () => {
  const ok = "Never hardcoded: expectedJobs() parses the `jobs:` block of the workflow file this run resolved. Read that workflow for the current set, not this one.";
  assert.equal(derivationCommentFault(ok), null);
  assert.equal(derivationCommentFault("Derived. A job the prose never names is still expected. See #847 and #927."), null);
  // An issue number beside the word "job" — the case that makes the `#\d+` strip
  // load-bearing rather than incidental.
  assert.equal(derivationCommentFault("Derived. See #847 for why job counts are not listed."), null);

  assert.match(derivationCommentFault("Never hardcoded. The fleet's prose names four jobs; the workflow defines five."), /tallies jobs \("four"\)/);
  assert.match(derivationCommentFault("Derived from the workflow, which defines two jobs."), /tallies jobs \("two"\)/);
  // The digit branch of CARDINAL, which no spelled fixture reaches.
  assert.match(derivationCommentFault("Derived from the workflow, which defines 5 jobs."), /tallies jobs \("5"\)/);
  assert.match(derivationCommentFault("The list tracks the workflow file automatically."), /no longer says the list is derived/);
  // Polarity: asserting the list IS hardcoded must refuse, not satisfy.
  assert.match(derivationCommentFault("The expected job list is hardcoded below because the workflow never changes."), /no longer says the list is derived/);
});
