import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The board's real parser, imported rather than re-described: the doc example
// below is fed through it, so a widened/narrowed regex and a reverted example
// both surface here instead of only in compute-board.test.mjs's own fixtures.
import { parseRow } from "./compute-board.mjs";

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
const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");

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

// Keys at an object literal's OWN depth, whatever the line layout. A per-line
// regex (`/^ {2}(\w+)[,:]/gm`) read one field per line and so could not see a
// field added on a line it SHARES with an existing one — measured in #667: the
// same added field is caught when it lands on its own line and missed when it
// shares, decided by nothing but where the newline fell. Depth is tracked so a
// value's own commas and nested braces never register as fields, and `expectKey`
// is what separates `head` the key from `head` in `snap.head` — both sit at
// depth 0, only one follows a `,` or the opening brace.
// String/template literals are dropped whole before tokenizing, quote and all
// — a `//` or a bracket inside a field's VALUE (a URL, say) used to be read as
// a real comment or a real brace, which could desync `expectKey` and silently
// drop the NEXT field from the list even though that field's own line was
// never touched. Escapes (`\'`, `\"`, `` \` ``) are honored so the scan can't
// mistake an escaped quote for the closing one.
// ponytail: no regex-literal awareness, and a template literal's `${...}`
// interpolation is dropped along with the string rather than re-entering code
// mode — a brace/comma inside an interpolation would miscount. Block comments
// are not stripped either. All upgrades for the day the return grows one.
function stripStringsAndComments(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      for (i++; i < body.length && body[i] !== quote; i++) {
        if (body[i] === "\\") i++;
      }
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      for (; i < body.length && body[i] !== "\n"; i++);
      continue;
    }
    out += ch;
  }
  return out;
}

function objectKeys(body) {
  const keys = [];
  let depth = 0;
  let expectKey = true;
  for (const [tok] of stripStringsAndComments(body).matchAll(/\w+|\S/g)) {
    if ("([{".includes(tok)) {
      depth++;
    } else if (")]}".includes(tok)) {
      depth--;
    } else if (depth === 0) {
      if (tok === ",") {
        expectKey = true;
      } else {
        if (expectKey && /^\w+$/.test(tok)) keys.push(tok);
        expectKey = false;
      }
    }
  }
  assert.equal(
    depth,
    0,
    "objectKeys: brace/paren/bracket depth didn't return to 0 — a quote or comment is likely hiding one from the scanner; update this parser",
  );
  return keys;
}

test("objectKeys reads fields by depth, not by line, and ignores brackets/commas hiding in string values", () => {
  assert.deepEqual(objectKeys("a, b: f(c, d), e,"), ["a", "b", "e"]);
  // The bug this PR fixes: a nested call's own commas must not register as
  // top-level fields.
  assert.deepEqual(objectKeys("head: snap.head, snapshot: snap.path,"), ["head", "snapshot"]);
  // The SURVIVED finding this PR fixes: a `//` inside a string value used to
  // be read as a line comment, eating the rest of the line — including the
  // trailing comma — and silently dropping the NEXT field.
  assert.deepEqual(
    objectKeys('snapshot: snap.path + "//x", dimensionsRun: d,'),
    ["snapshot", "dimensionsRun"],
  );
  // A brace or comma inside a string value must not move `depth` either.
  assert.deepEqual(objectKeys('label: "a, {b}", next: 1,'), ["label", "next"]);
});

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
    /Workflow\([\s\S]{0,12}name: "fleet:review-pr"/,
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

test("the Phase 3 finisher edges gate on a ruling the controller still owes", () => {
  // The rule also lives in the narrative finisher section below, but the
  // controller ACTS from these two bullets, and that is the site that produced
  // the failure: a ruling handed over after the finisher was already dispatched
  // put a new commit under a mid-audit finisher. A pin on the narrative copy
  // alone stays green while the acting site still reads "a member is rarely
  // still waiting". One bullet each, not the whole loop — the loop slice is
  // satisfied by either bullet carrying it.
  // Unwrap first: these are wrapped prose bullets, so a pinned phrase spans a
  // newline plus indent and an exact-adjacency regex reports a rule that is
  // right there as missing.
  const flat = (s) => s.replace(/\s+/g, " ");
  const ciEdge = flat(section(RUN_TEAM, "- **Monitor: CI run completes**", "- **A fix-applier reports", "run-team CI-completes edge"));
  assert.match(
    ciEdge,
    /never dispatch off it while you do/i,
    "the CI-completes edge lost the outstanding-ruling gate — it fires on the fix-applier's own push, which is exactly when a ruling is still owed",
  );
  const noCiEdge = flat(section(RUN_TEAM, '- **`ci-state.mjs --pr <N>` reads `verdict: "no-ci"`**', "- **Pool empty**", "run-team no-ci edge"));
  assert.match(
    noCiEdge,
    /never while you still owe it a ruling/i,
    "the no-ci edge lost the outstanding-ruling gate — it dispatches off the reviewer's verdict, with the same window open",
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
  // #143's rule, in the place it is HANDED OVER rather than the place it is
  // obeyed. The section's own instruction is to carry the reading rule and not
  // the command, so the rule it carries has to be the widened one — otherwise a
  // specialist in a host repo gets the narrow `tests 0` version and a partial
  // copy of the tree reads green to it.
  assert.match(
    specialists,
    /0 passes with no failures/,
    "the rule handed to specialists no longer covers an all-skipped run (#143)",
  );
  assert.match(
    specialists,
    /materially below the full suite/,
    "the rule handed to specialists no longer covers a partial copy of the tree (#143)",
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
  // #143: `tests 0` was the whole rule, and two runs that report counts still
  // walk through it — every test skipped, and a partial tree. Both are scoped to
  // step 3 for the same reason the line above is: the Specialists section states
  // the same widened rule, so a file-wide match is satisfied by that prose no
  // matter what this step says.
  assert.match(
    step3,
    /0 passes with no failures/,
    "step 3 no longer treats an all-skipped run as a no-work run (#143)",
  );
  assert.match(
    step3,
    /materially below the whole suite/,
    "step 3 no longer treats a count below the suite's size as a partial tree (#143)",
  );
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

test("the fix-applier lead-in relays every finding, on a premise that is true", () => {
  const leadIn = fixApplierLeadIn();
  // The rule, not one phrasing of it — a faithful reword keeps at least one of
  // these tied to relaying, deleting the paragraph keeps neither. Sliced to the
  // LEAD-IN, never to the Reviewers section: section-wide, the prompt below
  // supplies enough of this vocabulary that the pin survives the paragraph's
  // deletion (the failure mode the two narrow slices above exist for).
  assert.match(
    leadIn,
    /(every one, not the ones you rank|Paste all of them)/,
    "the lead-in no longer tells the controller to relay every finding rather than a ranked selection",
  );
  // Its reason clause shipped FALSE on this branch, in a PR about not shipping
  // false claims. The review specialists' transcripts DO exist on disk —
  // measured at 101 `subagents/workflows/wf_*/agent-*.jsonl` in one session, 33
  // of them `pr-review-toolkit:*`. What is true is that a member cannot address
  // them: `review-pr.js` returns `{pr, head, snapshot, dimensionsRun,
  // dimensionsUnrun, survived, refuted, unverified}` — no transcript path — and the `.meta.json` sidecars
  // carry only agentType/model/spawnDepth, so nothing maps one back to a PR or
  // a dimension. The rule rests on unaddressability, and a member sent hunting
  // a file it was told does not exist stops at a different place than one told
  // it cannot be named. Positive pins cannot catch a re-inserted falsehood;
  // only the exclusion can.
  assert.doesNotMatch(
    leadIn,
    /(nothing is on disk|left no transcript|no transcript you can read|paths that cannot exist|no output file)/i,
    "the lead-in claims the specialists' transcripts do not exist — they do; they are merely not addressable by a member",
  );
});

test("the fix-applier's self-retrieval is scoped to its own refuters, on a premise that is true", () => {
  const prompt = fixApplierPrompt();
  // `tail -1 <output-file>` is correct ONLY for a refuter this member spawned.
  // Unscoped, the member aims it at the review's specialists, gets nothing —
  // their last record is a `tool_result`, not text, so the recipe prints an
  // empty string — and rules the dimension unrun with the report never sent.
  // Contiguous, not a proximity window: "this covers every specialist, not only
  // the refuters YOU dispatch" satisfies any gap-based match and inverts the rule.
  assert.match(
    prompt,
    /this covers the[\s\S]{0,40}refuters YOU dispatch, and only those/,
    "the prompt no longer scopes self-retrieval to the refuters the fix-applier dispatched",
  );
  // The other half: for the review's own specialists the member asks for the
  // TEXT. Asking for a path cannot work — nothing it holds names one.
  assert.match(
    prompt,
    /ask for the text/i,
    "the prompt no longer tells the fix-applier to ask for the finding text rather than a path",
  );
  // Same false premise as the lead-in pin above, in the copy the fix-applier
  // actually reads. `no output file` is excluded as a claim of absence only —
  // the prompt's own "the output file named in your spawn result" is a
  // different string and stays green.
  assert.doesNotMatch(
    prompt,
    /(left no transcript|no transcript you can read|no output file to fetch|nothing is on disk)/i,
    "the prompt claims the review's specialists left no transcript — they do leave one; the member simply holds no path to it",
  );
});

test("run-team's documented return shape is exactly review-pr.js's actual return", () => {
  // The one claim in this file pinned against `review-pr.js`'s own return
  // value — the board-parser test below holds this file's other machine. A
  // prose pin cannot catch this: the sentence stays well-formed while the
  // script's `return` grows or loses a field, nothing errors, and the
  // controller looks for a field that is not there or never reads one that is.
  // `dimensionsUnrun` is the worked example: it was added to both sides after
  // the prose settled, and the ticket asking for this pin still describes the
  // shape as seven fields. That is the drift, and it is exactly what nothing
  // was measuring.
  //
  // Cross-checked, not transcribed: a literal field list here would be one more
  // copy to drift. Reading review-pr.js's own `return` means the pin fails in
  // EITHER direction — a field added to the script and not the prose, or a name
  // dropped from the prose and not the script.
  const src = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");
  // The workflow's own result is the file's only top-level `return {` — the
  // others are inside helpers and indented. Read by brace depth, not by line,
  // so a field added on a line it shares with another is still a field (#667).
  const returned = objectKeys(section(src, "\nreturn {", "\n};", "review-pr.js return").replace("\nreturn {", ""));
  assert.ok(returned.length, "review-pr.js's top-level return no longer parses as a plain object — update this test");
  const documented = section(RUN_TEAM, "It returns `{", "}`", "run-team return shape")
    .replace("It returns `{", "")
    .split(",")
    .map((f) => f.trim());
  // Compared as SETS. Field order carries no instruction, and a pin that fires
  // on a reorder is a pin the next reflow teaches people to edit around.
  assert.deepEqual(
    [...documented].sort(),
    [...returned].sort(),
    "run-team's `It returns …` field list has drifted from review-pr.js's actual return",
  );
});

test("the member-naming rule still names the fix-applier", () => {
  // Sliced to the naming PARAGRAPH, never to the Reviewers section and never
  // file-wide: the Reviewers lead-in says `fix-pr-<pr#>` too (pinned separately
  // above, at the site that DISPATCHES it), and that hit is what a wider match
  // resolves against — leaving this list free to lose the name with the pin
  // green. The name is what carries the `Agent` tool, so a controller reading
  // only this list names the member something else and loses delegation with no
  // error.
  const naming = section(RUN_TEAM, "**Name every member.**", "**Inverts one level down", "run-team member naming");
  assert.match(
    naming,
    /fix-pr-<pr#>/,
    "the member-naming rule no longer names the fix-applier — the default path's per-PR member has no sanctioned name",
  );
});

test("the per-PR member is the fix-applier, in the Report example and through the board parser", () => {
  // `compute-board.mjs` is the machine consumer. Its `reviewer` regex was
  // widened to accept `fix-pr-<n>` because matching only the older
  // `review-pr-<n>` left every default-path row with `reviewer: null` — the
  // implementer on the card and the PR counted as review backlog forever.
  // Nothing kept the documented examples on the widened side of that.
  //
  // Sliced to the Report section, not matched file-wide. Measured: with BOTH
  // table rows reverted to `review-pr-<M>`, a file-wide /fix-pr-<M>/ still
  // matches — the refill section's `fix-pr-<M>-b` satisfies it — so the
  // file-wide form is green with the example fully wrong.
  const report = section(RUN_TEAM, "## Report", "\n## Red flags", "run-team Report");
  // Both rows, not just one. A half-revert — one row back to `review-pr-<M>` —
  // and a row deleted outright both leave one surviving row, so a bare
  // `assert.match` walks straight through either.
  //
  // A FLOOR, and neither a ban on the fallback name nor an equality. `## Report`
  // is a top-level section, not the default path's own, and the fallback member
  // is sanctioned at `#### Fallback: hand-dispatched reviewer` — so a row (or a
  // sentence) naming `review-pr-<M>` is a legitimate document state, and
  // measured, banning the name reds on both. `=== 2` reds on a fourth
  // DEFAULT-path row, which the table's three outcome shapes plainly invite.
  assert.ok(
    [...report.matchAll(/fix-pr-<M>/g)].length >= 2,
    "the Report table no longer shows BOTH default-path rows naming the fix-applier",
  );

  // The ledger rows are the ones a machine actually reads, so pin them by
  // RUNNING the parser over the doc's own example rather than re-asserting its
  // regex here. Red in both directions: revert the example to `review-pr-346`
  // and the extracted name is the fallback's; narrow the regex back to
  // `review-pr` only and nothing is extracted at all.
  const ledger = section(RUN_TEAM, "One line per ticket, rewritten in place", "\nPlus two append-only lists", "run-team ledger example");
  const reviewers = ledger.split("\n").filter((l) => /^#\d+\s/.test(l)).map((l) => parseRow(l)?.reviewer).filter(Boolean);
  assert.ok(reviewers.length, "no ledger example row names a per-PR member that `compute-board.mjs` can extract");
  assert.deepEqual(
    reviewers.filter((r) => !r.startsWith("fix-pr-")),
    [],
    "a ledger example names a per-PR member `compute-board.mjs` does not read as the default path's fix-applier",
  );
});

test("the two relay red flags stay qualified to the fallback path", () => {
  // Same defect the Phase 3 relay assertion above exists to prevent, one
  // section further down: on the default path `agent()` returns into the
  // script, so no relay ever occurs and no specialist can be pinged.
  // Unqualified, both read as obligations on every run — and on the default
  // one they can never be discharged.
  //
  // Sliced per BULLET, not over the Red flags list: over the list either
  // qualifier satisfies a match for both, so one could be stripped outright
  // with the pin still green. Measured — strip only the ping bullet's
  // qualifier and a list-wide match still fires on the relay bullet's.
  // Each bullet ends where the next one begins.
  //
  // Unwrap the slice, as :207 already does: `(fallback path)` carries a literal
  // space, so a pinned phrase that wraps splits and an exact-adjacency regex
  // reports a qualifier that is right there as missing. Measured — reflowing
  // the Red flags list at width 55 or 60, words byte-identical, reds this pin.
  // Flatten the RESULT and keep the slicing raw; the anchors need real text.
  const flat = (s) => s.replace(/\s+/g, " ");
  const ping = flat(section(RUN_TEAM, '- "Tell the reviewer to ping its specialists"', '- "I relayed it', "run-team ping red flag"));
  const relayed = flat(section(RUN_TEAM, '- "I relayed it', '- "It reported the SHA', "run-team relay red flag"));
  for (const [label, bullet] of [["the ping-your-specialists", ping], ["the I-relayed-it", relayed]]) {
    assert.match(
      bullet,
      /\(fallback path\)/,
      `${label} red flag is no longer scoped to the fallback — it reads as universal, and on the default path it is an obligation that can never be discharged`,
    );
  }
});
