import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { memberPrompt } from "./support/render-brief.mjs";

// #375. A `gh pr create --label patch` that exceeds the caller's tool timeout is
// backgrounded with the PR ALREADY OPEN and the label unapplied, and a timeout
// carries no exit status for anything downstream to react to. Measured live: the
// member noticed only because it happened to re-read the labels afterwards.
//
// Two independent guards, because they fail at different points. Splitting the
// create gives the label write its own exit status, so it fails loudly at
// creation; the finisher's assertion catches the loss wherever it happened,
// including on a hand-created PR. Neither subsumes the other, so each is pinned
// separately here.
//
// Known ceiling: these are presence pins over bounded slices, so they hold the
// wording and its location, not the absence of a later carve-out — the same
// ceiling `member-prompt-prose.test.mjs` records for its own slice.
const REPO = join(import.meta.dirname, "..", "plugin");
const read = (...p) => Pin.file(join(REPO, ...p));

const NEXT_TICKET = read("skills", "next-ticket", "SKILL.md");
const RUN_TEAM = read("skills", "run-team", "SKILL.md");
const REVIEW_AND_FIX = read("commands", "review-and-fix.md");

const step7 = () =>
  NEXT_TICKET.section("## 7. When the sizing-a-ticket path reports done — open the PR", "next-ticket/SKILL.md step 7").text;

// The member reads the implementer agent body verbatim — its system prompt
// since #1804 moved the blocks there out of run-team's phase 2
// (spec 2026-09-24 § 2 Decision 2); the same slice `member-prompt-prose.test.mjs`
// takes, for the same reason.
const memberBlocks = () => read("agents", "fleet-implementer-slow-high.agent.md").text.split("---").slice(2).join("---");

// Duty 3 is stated in the finisher's agent body, which the harness injects as
// its system prompt; run-team's SKILL.md no longer restates it.
const finisherLabelDuty = () =>
  Pin.of(memberPrompt("finisher", "fresh"), "the finisher's member prompt").between("**Duty 3 is one script, and its exit code is your verdict.**", "Report to the controller in the report file your brief names", "finisher duty-3 block").text;

test("next-ticket's step 7 writes the label with a command of its own, not a flag on the create", () => {
  const s = step7();
  // The whole command, not its first physical line: the create's body string
  // spans lines, so a line-anchored match never sees `--label` folded onto the
  // body-closing continuation — the very fold this asserts against.
  const create = Pin.of(s, "s").between("gh pr create", "\ngh pr edit", "step 7 create command").text;

  // The defect in one assertion: a flag on the create shares the create's fate,
  // and that fate is a timeout with no exit status.
  assert.doesNotMatch(
    create,
    /--label/,
    "step 7 folds `--label` back into `gh pr create` — a timed-out create then opens the PR with the label silently unapplied",
  );
  assert.match(
    s,
    /^gh pr edit .*--add-label/m,
    "step 7 no longer writes the release label with its own command, so the write has no exit status of its own",
  );
});

test("next-ticket says why the label write stands alone, so it is not folded back in as a tidy-up", () => {
  const s = step7();
  assert.match(
    s,
    Pin.phrase("Never fold `--label` into the create"),
    "step 7 lost the instruction against folding the label into the create",
  );
  // Not a `/timeout|backgrounded/` keyword search: that is polarity-blind and
  // slice-wide — it stayed GREEN with the mechanism sentence replaced by one
  // NEGATING it, satisfied by the word "timeout" in the paragraph's tail clause.
  assert.match(
    s,
    Pin.phrase("outruns the caller's tool timeout is backgrounded with the PR already open"),
    "step 7 no longer names the timeout the split exists for, so the split reads as an arbitrary extra call",
  );
  // Not a bare `own exit status`: the command block's own trailing comment
  // carries that phrase, so the loose form stayed GREEN with the prose rationale
  // rewritten to "a tidier shape" — measured. Pin the sentence, not the words.
  assert.match(
    s,
    Pin.phrase("it has its own exit status and fails loudly"),
    "step 7 no longer says the separate command carries its own exit status — the whole reason it is separate",
  );
});

test("the split reaches the fleet member verbatim, inside the agent body it is dispatched with", () => {
  const blocks = memberBlocks();

  // Location, not vocabulary: a member reads only its agent body and its prompt.
  // The instruction sitting in controller-facing prose reaches it by paraphrase
  // or not at all.
  assert.match(
    blocks,
    /gh pr edit --add-label/,
    "the member is not told to write the release label as its own command — it will pass `--label` to the create, which is the bug",
  );
  assert.match(
    blocks,
    Pin.phrase("Never fold `--label` into the create"),
    "the member block lost the prohibition, leaving the split as an example a member may collapse back into one call",
  );
});

test("the finisher refuses a PR with zero or more than one release label, and says which", () => {
  const duty = finisherLabelDuty();
  assert.match(
    duty,
    Pin.phrase("exactly one"),
    "the finisher no longer asserts a release-label count before labelling",
  );
  assert.match(
    duty,
    /`patch`\/`minor`\/`major`/,
    "the finisher's assertion no longer names the release labels it counts",
  );
  assert.match(
    duty,
    /[Zz]ero or more than one/,
    "the finisher's assertion covers only one of the two failures — a PR wearing two release labels passes, or a bare PR does",
  );
  assert.match(
    duty,
    /naming which|names which|says which|report(s|ing)? which/,
    "the finisher may halt without naming what it found, which is the bare-SHA-mismatch failure shape this file's neighbours already record",
  );
});

// The wrongly-REFUSE half — a PR carrying one release label beside its other
// labels passes — is the script's own: finisher-label.test.mjs's "other labels
// beside the one release label do not trip the count" is its check.

// #2331: duty 3 read as one item let two finishers stop at the release-label
// check and report `labelled` with no `ready-to-merge` on the PR. The check and
// the add are now one script the finisher runs, whose exit code is its
// verdict, so neither can be run alone — and the finisher's prose no longer
// spells the commands that were each read as the whole duty. The duty is
// stated in the finisher's member prompt, where its agent body carries the
// block the member reads.
test("duty 3 is one script — named in the member prompt, with no gh commands spelled", () => {
  const block = finisherLabelDuty();
  assert.match(block, Pin.phrase("finisher-label.mjs --pr"), "the member prompt's duty 3 block no longer runs the script");
  assert.match(block, Pin.phrase("fleet-run finisher-label.mjs"), "the member prompt's duty 3 block reaches the script by something other than the Resolver");
  assert.doesNotMatch(block, /gh pr (view|comment|edit)/, "the member prompt's duty 3 block spells a gh command again — the steps are separable by hand once more");
  assert.match(block, Pin.phrase("exit code"), "the member prompt's duty 3 block does not say the exit code is the verdict");
  assert.match(block, Pin.phrase("Exit 0 is the only code that means the label is on"), "the block no longer says only exit 0 is a label");
  assert.match(block, Pin.phrase("Every non-zero exit halts you"), "the block lets a non-zero exit go on");
  assert.match(block, Pin.phrase("its steps by hand to get past it"), "the block no longer forbids replaying the steps by hand");
  assert.match(block, Pin.phrase("Put the receipt, the JSON line it printed, in your report as printed"),
    "the block no longer reports the script's receipt");
});

test("the solo labelling step gates on the release label too — the fleet finisher is not its only writer", () => {
  // `review-and-fix.md` step 6 is the other writer of `ready-to-merge`. A guard
  // on the fleet path alone leaves the standalone path labelling PRs with no
  // release label at all.
  const step6 = REVIEW_AND_FIX.between("6. Diff-check green", "**Bind green to the *run*", "review-and-fix.md step 6").text;
  assert.match(
    step6,
    Pin.phrase("exactly one release label"),
    "step 6 labels `ready-to-merge` without asserting a release label, so the standalone path still ships PRs with none",
  );
  // The same two halves test 4 pins on the fleet path. A count with no halt
  // reads the labels back and labels anyway; a halt with no naming is the
  // bare-SHA-mismatch failure shape this file's neighbours already record.
  assert.match(
    step6,
    /[Zz]ero or more than one/,
    "step 6 covers only one of the two failures — a PR wearing two release labels gets `ready-to-merge`, or a bare PR does",
  );
  assert.match(
    step6,
    /naming which|says which|report(s|ing)? which/,
    "step 6 may halt without naming what it found, leaving the standalone path's halt unactionable",
  );
});
