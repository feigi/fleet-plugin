import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The fleet's default review path is the controller running `review-pr.js`
// itself. Only the controller can: subagents have no `Workflow` tool, so on the
// hand-dispatch path neither `selectDimensions` nor the severity-budgeted verify
// pass runs at all — sizing falls back to the reviewer's own judgement and
// nothing budgets the adversarial refuters. Hand-dispatch also carries no
// delivery guarantee: a specialist's report surfaces to the CONTROLLER, so the
// reviewer has to retrieve it from the specialist's output file or be relayed
// it, and reports have gone missing both ways. On the workflow path `agent()`
// returns into the script, so neither problem exists.
//
// All of that rots silently. A default demoted back to a preference still reads
// as documented; relay prose left in the Phase 3 event loop reads as an
// obligation on every run, including the path where no relay can ever occur.
// Neither shows up as an error.
const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "skills", "fleet", "commands", "review-and-fix.md"), "utf8");

// Slice by named anchors, and fail loudly when one moves. SLICE SIZE is what
// does the work: a regex over a whole section is satisfied by incidental prose
// somewhere else in it, so each claim gets the smallest slice that can contain
// it. An unbounded slice is worst of all — it runs to EOF, where the red-flag
// list restates `relay` and `reconcile`, enough to keep the fallback assertions
// below green with the fallback section deleted outright.
function section(source, startAnchor, endAnchor, label) {
  const at = source.indexOf(startAnchor);
  assert.notEqual(at, -1, `${label}: '${startAnchor}' moved — update this test`);
  const end = source.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, `${label}: '${endAnchor}' moved — update this test`);
  return source.slice(at, end);
}

const FALLBACK_ANCHOR = "#### Fallback: hand-dispatched reviewer";
const PROMPT_ANCHOR = "> You are ALREADY in worktree";
const PROMPT_END = "\n**Put the standing CI facts";

const reviewersSection = () => section(RUN_TEAM, "### Reviewers", FALLBACK_ANCHOR, "run-team Reviewers");
// Sliced out of the Reviewers section, never out of the whole file: `section()`
// takes the FIRST hit, and the implementer dispatch in Phase 2 opens with the
// same sentence. Anchored file-wide this silently returns the implementer's
// prompt, and every assertion below then reports on the wrong agent.
const fixApplierPrompt = () =>
  section(reviewersSection(), PROMPT_ANCHOR, PROMPT_END, "run-team fix-applier prompt");

test("the Reviewers section names the workflow call as the default, ahead of the fallback", () => {
  const dflt = reviewersSection();
  // Loose on the example's punctuation — reordering the args object or wrapping
  // after the paren changes no instruction — tight on the call being present.
  assert.match(
    dflt,
    /Workflow\([\s\S]{0,12}name: "review-pr"/,
    "run-team no longer names the review-pr Workflow call on the default path",
  );
  // Pin the SENTENCE, not the word `default`. A bare /default/i over this slice
  // stays green through "that is one option; the fallback below is the default
  // path" — the exact demotion this test exists to catch.
  assert.match(
    dflt,
    /That is the default path/,
    "the workflow call is no longer stated to be THE default review path",
  );
});

test("the fix-applier dispatch is specified: named, apply-only-survived, push, report, exit", () => {
  // `fix-pr-<pr#>` is declared in the lead-in sentence, so it is checked against
  // the section; everything else is checked against the PROMPT ITSELF. Against
  // the whole section these all pass with the entire prompt deleted — every one
  // of these tokens also occurs in the controller prose around it.
  assert.match(reviewersSection(), /fix-pr-<pr#>/, "the fix-applier's member name is unspecified");

  const prompt = fixApplierPrompt();
  assert.match(
    prompt,
    /\*\*steps 2, 3\s*>?\s*and 5 only\*\*/,
    "the prompt no longer scopes the fix-applier to review-and-fix steps 2/3/5",
  );
  // `suggestion` gets 0 refuters by policy; `unverified` is the bucket whose
  // refuters all crashed, and at `critical` it walks straight through an
  // apply/defer split that only knows about the suggestion band. Both must be
  // named IN THE PROMPT — the controller-facing rule above it is read by the
  // controller, which is not the agent doing the applying.
  assert.match(prompt, /suggestion/, "the prompt no longer defers `suggestion` findings");
  assert.match(prompt, /unverified/, "the prompt no longer defers `unverified` findings");
  assert.match(prompt, /push/i, "the prompt no longer says to push");
  assert.match(prompt, /SHA/, "the prompt no longer says to report the SHA");
  assert.match(prompt, /exit/i, "the prompt no longer says to exit");
  // Deferring everything means no commit and no push, so no CI run fires and the
  // edge-keyed Monitor never wakes. The prompt has to make that reportable.
  assert.match(prompt, /no-op/, "the prompt no longer tells the fix-applier to report a no-op push");
});

test("the controller keeps the rules the workflow's return shape needs", () => {
  const dflt = reviewersSection();
  assert.match(
    dflt,
    /"checked and cleared"/,
    "run-team no longer warns that `unverified` is not a passed verification",
  );
  assert.match(
    dflt,
    /One review workflow at a time/,
    "run-team no longer caps concurrent review workflows — the reviewer cap counts the fix-applier, which is not dispatched until the workflow returns",
  );
  assert.match(
    dflt,
    /Retry once/,
    "run-team no longer says what to do when the workflow throws or returns no tree",
  );
});

test("relay and reconciliation live under the fallback, not in the Phase 3 event loop", () => {
  const loop = section(RUN_TEAM, "## Phase 3", "### Reviewers", "run-team Phase 3");
  // This slice's only other assertion is a doesNotMatch, which a slice that has
  // degenerated to its own heading satisfies trivially. Prove it reached the
  // bullet list first.
  assert.match(loop, /Review slot free, PR queued/, "the Phase 3 slice no longer contains the event loop");
  assert.match(
    loop,
    /no-op/,
    "the event loop lost the no-push branch — no push means no CI run, and the Monitor is edge-keyed, so the finisher is never dispatched and a clean PR is never labelled",
  );
  assert.doesNotMatch(
    loop,
    /relay/i,
    "the Phase 3 event loop still carries a relay obligation — on the default path `agent()` returns into the script and no relay ever occurs",
  );

  const fallback = section(RUN_TEAM, FALLBACK_ANCHOR, "\n### ", "run-team fallback");
  // The obligation, not the word: `/relay/i` alone has eight hits in this slice,
  // and stays green with the relay bullet deleted entirely.
  assert.match(
    fallback,
    /relay it to the reviewer that owns the PR/,
    "the fallback lost the relay duty",
  );
  assert.match(
    fallback,
    /reconcile/i,
    "the fallback lost the verdict-vs-receipts reconciliation rule",
  );
  assert.match(
    fallback,
    /or has failed/,
    "the fallback is gated on the workflow's absence alone — a workflow that is present and throwing then has no sanctioned path",
  );
});

test("review-and-fix agrees the workflow is the controller's default, not its preference", () => {
  const specialists = section(REVIEW_AND_FIX, "## Specialists", "\n## Judging findings", "review-and-fix Specialists");
  // Allow an adverb: /should prefer/ is exact-adjacency and "should generally
  // prefer" walks through it.
  assert.doesNotMatch(
    specialists,
    /should\s+\w*\s*prefer/,
    "review-and-fix still frames the workflow as a controller preference, contradicting run-team's default",
  );
  assert.match(
    specialists,
    /\bdefault\b/i,
    "review-and-fix no longer states the workflow is the fleet's default review path",
  );
  assert.match(
    specialists,
    /fallback/i,
    "review-and-fix no longer marks its hand-dispatch rules as the fallback",
  );
  assert.match(
    specialists,
    /critical\/important/,
    "review-and-fix claims the workflow verifies EVERY finding — the `suggestion` band gets 0 refuters, which is what its own step 2 defers them for",
  );
});

test("the fix-applier's step citations match review-and-fix.md's actual numbering", () => {
  // run-team's dispatch prompt hardcodes "steps 2, 3 and 5 only" and "skip step
  // 1 … and steps 4 and 6" against this file's numbering, across a file
  // boundary. One inserted step renumbers everything and the fix-applier
  // silently runs the wrong ones — no error, both files individually coherent.
  const steps = Object.fromEntries(
    [...REVIEW_AND_FIX.matchAll(/^(\d)\. (.*)$/gm)].map((m) => [m[1], m[2]]),
  );
  assert.match(steps["1"] ?? "", /pr-review-toolkit:review-pr/, "step 1 is no longer the review step the prompt skips");
  assert.match(steps["2"] ?? "", /\*\*apply now\*\*/, "step 2 is no longer the apply/defer split");
  assert.match(steps["3"] ?? "", /^Commit, push/, "step 3 is no longer commit+push");
  assert.match(steps["4"] ?? "", /do not hold this wait/, "step 4 is no longer the CI wait the prompt skips");
  assert.match(steps["5"] ?? "", /^File each deferred finding/, "step 5 is no longer deferral filing");
  assert.match(steps["6"] ?? "", /add-label ready-to-merge/, "step 6 is no longer the labelling step the prompt skips");
});
