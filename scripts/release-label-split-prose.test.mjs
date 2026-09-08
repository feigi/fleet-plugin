import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

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
const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");

const NEXT_TICKET = read("skills", "next-ticket", "SKILL.md");
const RUN_TEAM = read("skills", "run-team", "SKILL.md");
const REVIEW_AND_FIX = read("commands", "review-and-fix.md");

const step7 = () =>
  between(NEXT_TICKET, "## 7. When the superpowers path reports done", "## Red flags", "next-ticket/SKILL.md step 7");

// The controller carries only the `>` blocks verbatim; the same slice
// `member-prompt-prose.test.mjs` takes, for the same reason.
const memberBlocks = () =>
  between(RUN_TEAM, "and each of these verbatim:", "Each rule in the enumerate-and-declare block", "run-team phase 2");

const finisherLabelDuty = () =>
  between(RUN_TEAM, "Add `ready-to-merge`", "A halt at step 1 has exactly two causes", "run-team finisher duty 3");

test("next-ticket's step 7 writes the label with a command of its own, not a flag on the create", () => {
  const s = step7();
  // The whole command, not its first physical line: the create's body string
  // spans lines, so a line-anchored match never sees `--label` folded onto the
  // body-closing continuation — the very fold this asserts against.
  const create = between(s, "gh pr create", "\ngh pr edit", "step 7 create command");

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
    phrase("Never fold `--label` into the create"),
    "step 7 lost the instruction against folding the label into the create",
  );
  // Not a `/timeout|backgrounded/` keyword search: that is polarity-blind and
  // slice-wide — it stayed GREEN with the mechanism sentence replaced by one
  // NEGATING it, satisfied by the word "timeout" in the paragraph's tail clause.
  assert.match(
    s,
    phrase("outruns the caller's tool timeout is backgrounded with the PR already open"),
    "step 7 no longer names the timeout the split exists for, so the split reads as an arbitrary extra call",
  );
  // Not a bare `own exit status`: the command block's own trailing comment
  // carries that phrase, so the loose form stayed GREEN with the prose rationale
  // rewritten to "a tidier shape" — measured. Pin the sentence, not the words.
  assert.match(
    s,
    phrase("it has its own exit status and fails loudly"),
    "step 7 no longer says the separate command carries its own exit status — the whole reason it is separate",
  );
});

test("the split reaches the fleet member verbatim, inside the blocks the controller carries", () => {
  const blocks = memberBlocks();

  // Location, not vocabulary: a member reads only these blocks. The instruction
  // sitting in controller-facing prose reaches it by paraphrase or not at all.
  assert.match(
    blocks,
    /gh pr edit --add-label/,
    "the member is not told to write the release label as its own command — it will pass `--label` to the create, which is the bug",
  );
  assert.match(
    blocks,
    phrase("Never fold `--label` into the create"),
    "the member block lost the prohibition, leaving the split as an example a member may collapse back into one call",
  );
});

test("the finisher refuses a PR with zero or more than one release label, and says which", () => {
  const duty = finisherLabelDuty();
  assert.match(
    duty,
    phrase("exactly one"),
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
    /naming which|says which|report(s|ing)? which/,
    "the finisher may halt without naming what it found, which is the bare-SHA-mismatch failure shape this file's neighbours already record",
  );
});

test("the finisher's assertion accepts a normally-labelled PR — it counts release labels, not labels", () => {
  const duty = finisherLabelDuty();

  // The wrongly-REFUSE half. The finisher is about to add `ready-to-merge`,
  // which is itself a label, and PRs carry others; an assertion reading
  // "exactly one label" halts every correctly-created PR in the fleet.
  assert.match(
    duty,
    phrase("Count only those three"),
    "the finisher's assertion is no longer scoped to the release labels — any other label on the PR now trips it",
  );
  assert.match(
    duty,
    phrase("passes unchanged"),
    "the finisher no longer states that a PR carrying one release label beside its other labels passes",
  );
});

test("the solo labelling step gates on the release label too — the fleet finisher is not its only writer", () => {
  // `review-and-fix.md` step 6 is the other writer of `ready-to-merge`. A guard
  // on the fleet path alone leaves the standalone path labelling PRs with no
  // release label at all.
  const step6 = between(REVIEW_AND_FIX, "6. Diff-check green", "**Bind green to the *run*", "review-and-fix.md step 6");
  assert.match(
    step6,
    phrase("exactly one release label"),
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
