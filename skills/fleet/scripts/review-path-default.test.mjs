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
// THE CEILING EVERY PIN IN THIS FILE SHARES. These prove a phrase is PRESENT.
// None can prove it is not NEGATED — a sentence inserted inside the slice
// granting the opposite permission leaves every anchor and every pinned phrase
// intact, and the suite green (verified 2026-08-06). Tightening a regex does
// not close this; only a different mechanism would. So read the per-assertion
// comments below as "this pin is not vacuous to *rewording*", never as "this
// rule cannot be subverted" — the contradiction that shipped on this branch
// (an absolute `unverified` rule sitting above the `suggestion` exception that
// contradicted it) was exactly that, and was invisible to all of them.
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
// The lead-in is what SUBSTITUTES the prompt's `<testCmd>` placeholder, so it
// gets its own slice ending where the prompt begins — deliberately tighter than
// the Reviewers section. Section-wide, the phrase is satisfied by any mention
// inside the prompt itself, so the substitution duty could be deleted with the
// pin still green; that is the whole failure mode being pinned.
const fixApplierLeadIn = () =>
  section(reviewersSection(), "**Then dispatch a fix-applier**", PROMPT_ANCHOR, "run-team fix-applier lead-in");

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
  // `suggestion` and `unverified` are no longer one rule. An in-scope suggestion
  // is verified by one refuter and applied; an out-of-scope one is filed; an
  // `unverified` ALWAYS defers, at every severity, because at `critical` it means
  // every refuter crashed.
  //
  // Asserting on the word "suggestion" alone is vacuous — the new rule contains
  // it too. These pin the SPLIT: the in-scope branch, the refuter it requires,
  // and the fact that `unverified` did not inherit the new permission.
  //
  // A loose `/in scope[\s\S]{0,400}?refuter/i` is ALSO vacuous: "refuter" shows
  // up 400 chars later regardless of what the in-scope branch actually says, so
  // "In scope → apply it directly, and never dispatch a refuter" still matches.
  // Tying "dispatch" to sit right after "in scope", with "refuter" close behind
  // IT, pins that dispatching a refuter is the action taken, not just a word
  // that occurs somewhere downstream.
  assert.match(
    prompt,
    /in scope\b[^a-zA-Z]{1,10}dispatch\b[\s\S]{0,20}refuter/i,
    "the prompt no longer ties applying an in-scope suggestion to a refuter pass",
  );
  assert.match(
    prompt,
    /`unverified`[^.]{0,200}always defers/i,
    "the prompt no longer defers every `unverified` finding unconditionally",
  );
  assert.doesNotMatch(
    prompt,
    /Every `suggestion` and every `unverified` defers/,
    "the prompt still couples the suggestion and unverified bands as one rule",
  );
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
  assert.match(steps["3"] ?? "", /commit and push/i, "step 3 is no longer the commit+push step (now gated on a test run first)");
  assert.match(steps["4"] ?? "", /do not hold this wait/, "step 4 is no longer the CI wait the prompt skips");
  assert.match(steps["5"] ?? "", /^File each deferred finding/, "step 5 is no longer deferral filing");
  // The workflow already supplies `dimension` on every finding; only the
  // filing step dropped it. Without it the backlog cannot be attributed to a
  // specialist — measured once at 89 deferral issues, none traceable to a
  // dimension. Pinned as the literal phrase (not a wide proximity window):
  // a proximity match survives "the dimension need not be recorded in the
  // issue body" as easily as it survives the real requirement, because both
  // put the same two terms near each other — only the exact adjacency does not.
  assert.match(
    steps["5"] ?? "",
    /`dimension`\s+in the issue body/i,
    "step 5 no longer records the finding's dimension in the filed issue",
  );
  // Adjacency alone still is not enough: "the finding's `dimension` in the issue
  // body is optional and may be omitted" satisfies the match above verbatim.
  // Measured GREEN under exactly that mutation, so the permissive forms are
  // excluded explicitly — the positive pin proves the phrase is present, this
  // one proves it was not turned into a permission.
  assert.doesNotMatch(
    steps["5"] ?? "",
    /`dimension`[\s\S]{0,120}?(optional|may be omitted|need not|where available|if known)/i,
    "step 5 now makes the dimension optional — the backlog goes back to being unattributable",
  );
  assert.match(steps["6"] ?? "", /add-label ready-to-merge/, "step 6 is no longer the labelling step the prompt skips");
});

test("the in-scope-suggestion refuter carries its anti-rubber-stamp clause, in both files", () => {
  // The one new permission this branch grants is "apply an in-scope suggestion
  // if it survives one refuter". A refuter that reasons its way to agreement
  // survives everything, which degrades that into "apply everything in scope" —
  // so the RUNNING clause is the whole mechanism, not decoration. Both files
  // carry it because different agents read each: the fix-applier gets run-team's
  // prompt, a standalone reviewer gets review-and-fix's step 2 and nothing else.
  const step2 = section(REVIEW_AND_FIX, "2. Plan the actions", "\n3. **Run `testCmd`", "review-and-fix step 2");
  for (const [label, slice] of [["review-and-fix step 2", step2], ["the fix-applier prompt", fixApplierPrompt()]]) {
    // The instruction text alone does not pin that a refuter is DISPATCHED.
    // Measured GREEN on review-and-fix step 2 under "In scope → apply it
    // directly; never dispatch a refuter. Had you dispatched one, biased to
    // refuse, you would hand it this instruction verbatim:" — every clause below
    // still present, the permission inverted. run-team's copy already carried
    // this tighter form; step 2 did not. Same regex, both files now.
    assert.match(
      slice,
      /in scope\b[^a-zA-Z]{1,10}dispatch\b[\s\S]{0,20}refuter/i,
      `${label} no longer ties applying an in-scope suggestion to dispatching a refuter`,
    );
    assert.match(
      slice,
      /Verify by[\s>\n]+RUNNING something/,
      `${label} no longer tells the refuter to verify by RUNNING something`,
    );
    assert.match(
      slice,
      /(Do not|never)[\s>\n]+reason your way to agreement/i,
      `${label} no longer forbids the refuter reasoning its way to agreement`,
    );
  }
});

test("the fix commit is gated on a test run, in both files", () => {
  // The fleet runs in arbitrary host repos. The gate cannot rely on a pre-commit
  // hook existing — and must never bypass one that does.
  //
  // Every assertion below is matched against `step3`, never the whole-file
  // `REVIEW_AND_FIX` — matching file-wide is satisfied by ANY sibling mention
  // of the phrase anywhere else in the doc, so it passes even with step 3's
  // own rule gutted. Proven, not assumed: neutering step 3's testCmd clause
  // while planting an unrelated comment mentioning the same phrase at EOF left
  // the file-wide version at `pass 7 / fail 0` — green with the gate removed.
  const step3 = section(REVIEW_AND_FIX, "3. **Run `testCmd`", "\n4. **Under the fleet", "review-and-fix step 3");
  // A proximity gap (`testCmd ⟨gap⟩ before committing`) is blind to a negation
  // prepended before `testCmd` — the gap survives untouched and the loose match
  // still fires. Pin the literal contiguous phrase instead.
  assert.match(
    step3,
    /`testCmd` before you commit/i,
    "step 3 no longer runs testCmd before committing",
  );
  assert.match(step3, /never `--no-verify`/i, "step 3 no longer forbids --no-verify");
  // `tests 0` is a FAILED run, not a pass — the same rule the specialist prompt
  // already states. A glob matching nothing exits 0 reporting `tests 0`. Scoped
  // to step 3 itself, not matched file-wide: the Specialists section already
  // says `tests 0` (about the specialist test command), so a bare file-wide
  // match is satisfied by that pre-existing prose and never fails no matter
  // what step 3 says.
  assert.match(step3, /tests 0/, "step 3 no longer treats a zero-test run as a failure");
  // Acceptance criterion 10's second clause. The gate is worth nothing to the
  // controller if the result never leaves the fix-applier: a green it does not
  // report is indistinguishable from one it never ran.
  assert.match(
    step3,
    /report the test result alongside the SHA/i,
    "step 3 no longer reports the test result with the pushed SHA",
  );
  // Standalone (step 4 explicitly supports no-controller), nothing else defines
  // `testCmd` — the reader must either infer it or pick a runner the same
  // sentence forbids picking.
  assert.match(
    step3,
    /standalone[\s\S]{0,80}repo's own test command/i,
    "step 3 no longer defines `testCmd` for the standalone path, where no dispatcher hands one over",
  );

  // Bare token existence (`/testCmd/`, `/--no-verify/`) is satisfied by ANY
  // mention, including one that grants permission — "you may use --no-verify"
  // contains the literal token and would pass a bare check. Pin the actual gate
  // phrasing, same discipline as the review-and-fix.md pins above.
  const prompt = fixApplierPrompt();
  assert.match(
    prompt,
    /Report the test\s*\n?>?\s*result with your SHA/i,
    "the fix-applier prompt no longer reports the test result with its SHA",
  );
  // The prompt says `<testCmd>` — a PLACEHOLDER. Only the lead-in tells the
  // controller to substitute it. Delete that sentence and the fix-applier is
  // handed a literal `<testCmd>` against a step reading "copied verbatim — not
  // a runner you picked": no error, both files individually coherent.
  assert.match(
    fixApplierLeadIn(),
    /the same `testCmd` you\s+passed the workflow/,
    "the controller no longer carries testCmd into the fix-applier's prompt — `<testCmd>` reaches it unsubstituted",
  );
  assert.match(
    prompt,
    /`<testCmd>` from the worktree before committing/i,
    "the fix-applier prompt no longer carries testCmd",
  );
  assert.match(prompt, /never `--no-verify`/i, "the fix-applier prompt no longer forbids --no-verify");
});
