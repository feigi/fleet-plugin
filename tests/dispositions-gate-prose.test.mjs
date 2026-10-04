// The disposition record and its gate, as the prose states them to the
// two seats that act on it: review-and-fix.md step 2 tells the fix-applier to
// write `<scratch>/dispositions-<pr>.json` and what passes, and run-team's
// gate paragraph tells the controller when `ledger.mjs dispatch` refuses a
// finisher and what each refusal asks of it. The fix-applier prompt block that
// restates the record is a `>` block, which the dispatch-block golden fixture
// pins whole; these two paragraphs sit outside every `>` block, so nothing
// else holds them.
//
// THE CEILING: presence pins over bounded slices, each a contiguous clause —
// the rule and its condition in one span, so an inverted verdict (`ok` →
// `mismatch`), a flipped consequence (`no finisher` → `a finisher`) or a
// renamed file reds, where a keyword pin would not. They prove the clauses are
// there, not that nothing near them contradicts them. One pin crosses into
// code: the deferral reasons the prose lists are read against ALLOWED_DEFER,
// the list the check enforces, so the two cannot drift apart silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase } from "./support/prose-pin.mjs";
import { ALLOWED_DEFER } from "../plugin/scripts/dispositions-check.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");
const SKILL = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Step 2's record paragraph: one line, bounded by step 3's opener.
const recordStep = () =>
  between(REVIEW_AND_FIX, "**Write every ruling to `<scratch>/dispositions-<pr>.json`", "\n3. **Run `testCmd`", "review-and-fix.md");
const gate = () => paragraph(SKILL, "That `dispatch` refuses a finisher", "run-team/SKILL.md", "**An unanswered question from the member");

test("step 2 names the record's file, beside the review file, and that the check judges it before any finisher", () => {
  assert.match(recordStep(), phrase(
    "**Write every ruling to `<scratch>/dispositions-<pr>.json`, beside the review result file — the disposition record `dispositions-check.mjs` judges against it before any finisher is dispatched.**",
  ));
});

test("step 2 reads scope off the diff before the declared scope", () => {
  assert.match(recordStep(), phrase(
    "a finding with no `line`, or on a line `git diff` touches from the PR's merge-base with `origin/main` to the review's `head`, is in scope whatever `scope` says, and only otherwise does the declared one stand.",
  ));
});

test("step 2's deferral reasons are exactly the ones the check accepts, and anything else refuses the finisher", () => {
  const s = recordStep();
  const listed = /An in-scope `survived` finding deferred passes only with `reason` `([^`]+)`, `([^`]+)`, `([^`]+)` or `([^`]+)`\./.exec(s);
  assert.ok(listed, "step 2 no longer lists the in-scope deferral reasons in one sentence — update this test");
  assert.deepEqual(listed.slice(1), [...ALLOWED_DEFER]);
  assert.match(s, phrase(
    "Any other reason, none, or a `survived` or `unverified` finding with no entry is a mismatch: the script exits 1 naming each violating entry's bucket, index and rule, and `ledger.mjs dispatch` refuses the PR's finisher.",
  ));
});

test("step 2 requires a remedy file absent from the PR's diff for remedy-outside-diff, and refuses none or every one inside it", () => {
  assert.match(recordStep(), phrase(
    "`remedy-outside-diff` — the remedy would edit a file the PR's diff does not touch — also needs `remedyFiles` to name at least one file absent from `git diff` from that merge-base to the review's `head`: none named, or every one in that diff, is a mismatch.",
  ));
});

test("the gate refuses a finisher unless the verdict answering the latest review's head is ok", () => {
  const s = gate();
  assert.match(s, phrase(
    "That `dispatch` refuses a finisher — exit 2, nothing written — on a PR whose latest `reviewed=` counts a survived or unverified finding, unless the dispositions verdict answering that review's head is `ok`**",
  ));
  assert.match(s, phrase("A PR whose latest review counts `0/<n>/0` is not gated."));
});

test("the gate says what each refusal asks of the controller", () => {
  const s = gate();
  assert.match(s, phrase(
    "`dispositions unchecked` — no verdict answers that head: run `dispositions-check.mjs` for the fix-applier that answered the review",
  ));
  assert.match(s, phrase(
    "`dispositions mismatch` — no finisher: the tick prints `DISPATCH fix-pr PR#<M>` for it, and the next-suffix fix-applier answers it",
  ));
  assert.match(s, phrase(
    "`dispositions escalate` — no finisher, no retry and no further fix-applier: either a `critical` or `important` finding was deferred `remedy-outside-diff`, or a second mismatch was drawn on one review, and only a human can rule on either.",
  ));
  assert.match(s, phrase(
    "Post the check's output, which names each escalated finding or violating entry, with `gh pr comment <M>`, and flag the PR for a human; re-running the check reprints it. Dispatch no fix-applier and no finisher for that review's head",
  ));
  assert.match(s, phrase(
    "it refuses too while a fix-applier on the PR is still live, verdict or not** — `fix-pr-<M>[-x] still live`: settle it, run the check for it, then dispatch again.",
  ));
});

test("a mismatch is retried once by the next suffix, whose prompt carries the violation list, and a second failure escalates", () => {
  const s = paragraph(SKILL, "`DISPATCH fix-pr PR#<M>` on a dispositions mismatch", "run-team/SKILL.md", "**A refutation resting on an injection", { emphasisTolerant: true });
  assert.match(s, phrase("is one automatic retry, a review fix-applier named the next suffix (`fix-pr-<M>-b`)"));
  assert.match(s, phrase(
    "the review file `<scratch>/review-<M>.json`, the disposition record `<scratch>/dispositions-<M>.json` it rewrites, and the check's violation list **verbatim**",
  ));
  assert.match(s, phrase(
    "A second failure on the same review is written as `dispositions-escalate=fix-pr-<M>-b:<head>` in place of a mismatch: the tick prints no `DISPATCH fix-pr` for it, `dispatch` refuses the finisher naming `dispositions escalate`",
  ));
  assert.match(s, phrase("A new review of the PR counts again from none."));
});

test("a reversed refutation reaches the ledger from the disposition record", () => {
  assert.match(paragraph(SKILL, "`refuted` comes back deliberately as well", "run-team/SKILL.md", "**`dimensionsRun` is the dispatch; `dimensionsUnrun` is"), phrase(
    "The fix-applier may reverse one; it records each reversal as a `refuted` entry in its disposition record, the evidence in `reason`, and you copy those entries to the ledger's `ruled` line",
  ));
});

// Step 6's label conditions: the check over the member's own record is the
// fourth, so a standalone run — no controller, no ledger — holds its own label.
const labelStep = () => paragraph(REVIEW_AND_FIX, "6. Diff-check green (run-bound", "review-and-fix.md", "**`verdict: \"no-ci\"` — this repo has");

test("step 6 makes the dispositions check over the member's own record a label condition", () => {
  assert.match(labelStep(), phrase(
    "**and** `dispositions-check.mjs --member fix-pr-<pr> --scratch <scratch>` run over your own record exiting 0",
  ));
});

test("step 6 halts a non-zero dispositions exit before the label and has the member report its violations", () => {
  assert.match(labelStep(), phrase(
    "A non-zero dispositions exit halts you before the label, and you report the violations it printed.",
  ));
});

test("step 6 has a standalone member pass --no-ledger: no token is written and the exit status is the verdict", () => {
  assert.match(labelStep(), phrase(
    "standalone you pass `--no-ledger`, so it writes no token and the exit status is the verdict",
  ));
  assert.match(labelStep(), phrase(
    "without the flag it exits 2 for a ledger with no row for you",
  ));
});
