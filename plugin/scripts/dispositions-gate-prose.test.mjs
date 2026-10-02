// #2342. The disposition record and its gate, as the prose states them to the
// two seats that act on it: review-and-fix.md step 2 tells the fix-applier to
// write `<scratch>/dispositions-<pr>.json` and what passes, and run-team's
// gate paragraph tells the controller when `ledger.mjs dispatch` refuses a
// finisher and what each refusal asks of it. The fix-applier prompt block that
// restates the record is pinned whole by dispatch-block-golden-prose.test.mjs;
// these two paragraphs sit outside every `>` block, so nothing else holds them.
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
import { between, paragraph, phrase } from "./prose-pin.mjs";
import { ALLOWED_DEFER } from "./dispositions-check.mjs";

const REPO = join(import.meta.dirname, "..");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");
const SKILL = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Step 2's record paragraph: one line, bounded by step 3's opener.
const recordStep = () =>
  between(REVIEW_AND_FIX, "**Write every ruling to `<scratch>/dispositions-<pr>.json`", "\n3. **Run `testCmd`", "review-and-fix.md");
const gate = () => paragraph(SKILL, "That `dispatch` refuses a finisher", "run-team/SKILL.md");

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
  const listed = /An in-scope `survived` finding deferred passes only with `reason` `([^`]+)`, `([^`]+)` or `([^`]+)`\./.exec(s);
  assert.ok(listed, "step 2 no longer lists the in-scope deferral reasons in one sentence — update this test");
  assert.deepEqual(listed.slice(1), [...ALLOWED_DEFER]);
  assert.match(s, phrase(
    "Any other reason, none, or a `survived` or `unverified` finding with no entry is a mismatch: the script exits 1 naming each violating entry's bucket, index and rule, and `ledger.mjs dispatch` refuses the PR's finisher.",
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
    "`dispositions mismatch` — no finisher: post the check's output, which names each violating entry, with `gh pr comment <M>`, and flag the PR for a human",
  ));
  assert.match(s, phrase(
    "it refuses too while a fix-applier on the PR is still live, verdict or not** — `fix-pr-<M>[-x] still live`: settle it, run the check for it, then dispatch again.",
  ));
});

test("a reversed refutation reaches the ledger from the disposition record", () => {
  assert.match(paragraph(SKILL, "`refuted` comes back deliberately as well", "run-team/SKILL.md"), phrase(
    "The fix-applier may reverse one; it records each reversal as a `refuted` entry in its disposition record, the evidence in `reason`, and you copy those entries to the ledger's `ruled` line",
  ));
});
