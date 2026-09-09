// #1341, ruled on #1316: the controller-to-member coordination prose is one
// harness-neutral contract (dispatch/send/wake/settle/consume) plus five
// per-harness mechanics stated as adjacent CLAUDE:/OMP: marked lines — the
// first prose in this tree to use that shape (#1299/ADR 0004). This file pins
// each pair, in both `references/member-lifecycle.md` and the SKILL.md
// passages that restate a subset of them.
//
// SHAPE. Two things do the work, per the marker grammar CONTEXT.md's §
// Dialect fixed and the vacuous-pin history this repo already has (22 of 33
// mutations once survived a fat-slice pin): each pair is bounded to its own
// two-line region, never a section, and every marked line's own pin carries a
// `doesNotMatch` for the OTHER harness's tool token — a pin loose enough to
// match both dialect wordings is thereby rejected here, not discovered later
// by mutation. `markedLine` (prose-pin.mjs) extracts the line by its literal
// first token (`CLAUDE: `/`OMP: `), never a keyword search over the region.
//
// MUTATION RECORD (#1299's four-run procedure, actually run on a scratch
// copy per the established method — copy the tree preserving the path depth
// `REPO` is computed from into a tmp dir, mutate there with a small Python
// script, run `node --test` against the scratch copy, read the pass/fail
// count, revert, diff against a saved original to confirm a clean revert).
// Two pairs run in full, 4/4 both:
//
// Pair A (Fresh context per member / Wake mechanism), member-lifecycle.md:
//   1. Claude line inverted ("does not resume its transcript ... drags no old
//      ticket in") — the Wake-pair test failed (its own content pin, on the
//      CLAUDE line's phrase). 9/10 pass.
//   2. OMP line inverted ("does not wake it into its old transcript") — the
//      same test failed the same way, this time on the OMP line's phrase.
//      9/10 pass.
//   3. Benign reword of the shared sentence above the pair ("One member, one
//      unit of work, gone." -> "One member, one piece of work, then gone.")
//      — 10/10 pass; the region is bounded by the section headings, which the
//      reword does not touch.
//   4. Token swap (CLAUDE line renamed to say `hub send`, OMP line renamed to
//      say `SendMessage`) — the Wake-pair test failed: the CLAUDE line's own
//      content pin no longer matches once it names the omp verb. 9/10 pass.
//
// Pair D (Result consumption, a does-not-apply pair), member-lifecycle.md:
//   1. Claude line inverted ("never lost even if unconsumed") — the
//      Result-consumption test failed on the `/lost if unconsumed/` pin.
//      9/10 pass.
//   2. OMP line inverted ("the lost-if-unconsumed hazard DOES apply") — the
//      same test failed on the "does not apply" phrase pin. 9/10 pass.
//   3. Benign reword of the shared sentence above the pair ("consumed
//      deliberately" -> "consumed on purpose") — first attempt falsely
//      reddened the whole test, because the region's `between()` anchor was
//      the exact sentence being reworded: mutating it made the anchor itself
//      unfindable, which is a vacuous-anchor bug in the pin, not evidence the
//      pin discriminates. Fixed by shortening the anchor to a stable prefix
//      ("A completed member's result is consumed", ending before the word
//      the control rewords) that does not overlap the reworded span.
//      Re-run: 10/10 pass.
//   4. Token swap (CLAUDE line's clause swapped for the OMP does-not-apply
//      wording and vice versa) — the Result-consumption test failed on the
//      CLAUDE line's own content pin (`a completed agent's final text is a
//      return value`, no longer present once the line says omp's). 9/10 pass.
//
// The other three pairs (Settle/liveness state machine, Grandchild
// reachability, Receipts) carry the same two assertions per line
// (content match + `doesNotMatch` on the other harness's token) but were not
// separately run through all four mutations; the shape is identical to
// Pair A/D and the vacuity class those two runs rule out — a fat slice or an
// anchor that doubles as reworded content — is structural, not per-pair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, stripQuoteGutter, markedLine } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

const LIFECYCLE = read("skills", "run-team", "references", "member-lifecycle.md");
const SKILL = read("skills", "run-team", "SKILL.md");

// ---------------------------------------------------------------------------
// member-lifecycle.md
// ---------------------------------------------------------------------------

test("contract: dispatch/send/wake/settle/consume are defined once, and SendMessage/hub name only marked lines", () => {
  const contract = between(
    LIFECYCLE,
    "## The coordination contract",
    "## Fresh context per member",
    "member-lifecycle.md's coordination contract section",
  );
  for (const word of ["dispatch", "send", "wake", "settle", "consume"]) {
    assert.match(contract, phrase(word), `contract section no longer names "${word}"`);
  }
  // The contract states the RULE that SendMessage/hub are marked-line-only —
  // it must not itself use either term outside that one sentence naming them.
  const bodyBeforeTheRule = contract.slice(0, contract.indexOf("`SendMessage` and `hub` are harness terms"));
  assert.doesNotMatch(bodyBeforeTheRule, /SendMessage|\bhub\b/, "the contract uses a harness term before stating the rule that confines them to marked lines");
});

test("Wake pair (Fresh context per member): CLAUDE names SendMessage, OMP names hub send, neither in the other's line", () => {
  const region = between(
    LIFECYCLE,
    "## Fresh context per member",
    "## Grandchildren surface to you",
    "member-lifecycle.md's Fresh-context-per-member section",
  );
  const claude = markedLine(region, "CLAUDE", "Fresh-context-per-member CLAUDE line");
  const omp = markedLine(region, "OMP", "Fresh-context-per-member OMP line");
  assert.match(claude, phrase("`SendMessage` to a finished agent resumes its transcript"));
  assert.doesNotMatch(claude, /\bhub send\b/i, "the CLAUDE wake line must not also carry omp's send verb");
  assert.match(omp, phrase("`hub send` to an idle peer wakes it into its old transcript"));
  assert.doesNotMatch(omp, /SendMessage/, "the OMP wake line must not also carry Claude's send verb");
});

test("Grandchild-reachability pair: CLAUDE keeps the tail/jq recipe, OMP states the depth cap and the measured reachability answer", () => {
  const region = between(
    LIFECYCLE,
    "A specialist's report routes to *you*",
    "Reviewer retrieves first, relay is the backup",
    "member-lifecycle.md's grandchild-reachability pair",
  );
  const claude = markedLine(region, "CLAUDE", "Grandchild-reachability CLAUDE line");
  const omp = markedLine(region, "OMP", "Grandchild-reachability OMP line");
  assert.match(claude, phrase("a grandchild is unreachable by"));
  assert.match(claude, phrase("tail -1 <output-file> | jq -r"));
  assert.doesNotMatch(claude, /task\.maxRecursionDepth|hub send/i, "the CLAUDE recipe line must not also carry omp's depth-cap vocabulary");
  assert.match(omp, phrase("the tail/jq recipe does not apply"));
  assert.match(omp, phrase("hub send`-reachable directly by its dotted id"));
  assert.doesNotMatch(omp, /`SendMessage`|tail -1/, "the OMP line must not also carry Claude's recipe");
});

test("Result-consumption pair (does-not-apply): CLAUDE states lost-if-unconsumed, OMP states the hazard does not apply", () => {
  const region = between(
    LIFECYCLE,
    "A completed member's result is consumed",
    "So relay each:",
    "member-lifecycle.md's result-consumption pair",
  );
  const claude = markedLine(region, "CLAUDE", "Result-consumption CLAUDE line");
  const omp = markedLine(region, "OMP", "Result-consumption OMP line");
  assert.match(claude, phrase("a completed agent's final text is a return value"));
  assert.match(claude, /lost if unconsumed/);
  assert.doesNotMatch(claude, /does not apply|auto-deliver/i, "the CLAUDE line must not also carry omp's does-not-apply wording");
  assert.match(omp, phrase("the lost-if-unconsumed hazard does not apply"));
  assert.doesNotMatch(omp, /lost if unconsumed\*\*\.$|is a return value/, "the OMP line must not restate the Claude hazard as its own");
});

test("no sentence states the lost-if-unconsumed hazard without a CLAUDE marker", () => {
  // Scoped to the coordination prose tree, per #1299's ruling that a
  // whole-repo scan would cross into unrelated uses of shared words. `lost if
  // unconsumed` (and its lowercase/asterisk variants) is checked line-by-line
  // against the gutter-stripped source: every line that carries it must begin
  // with the CLAUDE token.
  for (const [label, doc] of [
    ["references/member-lifecycle.md", LIFECYCLE],
    ["run-team/SKILL.md", SKILL],
  ]) {
    const lines = stripQuoteGutter(doc).split("\n").filter((l) => /lost if unconsumed/i.test(l));
    for (const line of lines) {
      assert.match(line.trimStart(), /^CLAUDE: /, `${label}: a line states "lost if unconsumed" without the CLAUDE marker: ${JSON.stringify(line)}`);
    }
  }
});

test("Receipts pair: CLAUDE hand-rolls reconciliation, OMP returns a native delivered/failed receipt", () => {
  const region = between(
    LIFECYCLE,
    "So relay each:",
    "Measured on Claude Code",
    "member-lifecycle.md's receipts pair",
  );
  const claude = markedLine(region, "CLAUDE", "Receipts CLAUDE line");
  const omp = markedLine(region, "OMP", "Receipts OMP line");
  assert.match(claude, phrase("only the controller holds the message id"));
  assert.match(claude, /hand-rolled/);
  assert.doesNotMatch(claude, /`hub send` returns|16-hex/, "the CLAUDE line must not also carry omp's native-receipt wording");
  assert.match(omp, phrase("hub send` returns a structured `delivered`/`failed` receipt inline"));
  assert.match(omp, /16-hex message id/);
  assert.doesNotMatch(omp, /hand-rolled|only the controller holds the message id/, "the OMP line must not also carry Claude's hand-rolled wording");
});

test("Settle/liveness state-machine pair: two different machines, each named, neither borrowing the other's vocabulary", () => {
  const region = between(
    LIFECYCLE,
    "## Settle and liveness: two different state machines",
    "Recovery = fresh member",
    "member-lifecycle.md's Settle-and-liveness section",
  );
  const claude = markedLine(region, "CLAUDE", "Settle/liveness CLAUDE line");
  const omp = markedLine(region, "OMP", "Settle/liveness OMP line");
  assert.match(claude, phrase("three states on one axis — killed, idle, truncated"));
  assert.doesNotMatch(claude, /`hub cancel`|running.\/.failed.\/.cancelled/i, "the CLAUDE state-machine line must not also carry omp's outcome/liveness axes");
  assert.match(omp, phrase("two axes — job outcome"));
  assert.match(omp, /failed.{0,10}job.{0,10}s peer can stay .idle. and resumable/);
  assert.doesNotMatch(omp, /`SendMessage` works on idle or truncated/, "the OMP line must not also carry Claude's triad wording");
});

// ---------------------------------------------------------------------------
// run-team/SKILL.md — the three restated passages
// ---------------------------------------------------------------------------

test("SKILL.md Fresh-context-per-member passage carries the same Wake pair as the reference", () => {
  const region = between(
    SKILL,
    "**Fresh context per member.**",
    "See references/member-lifecycle.md.",
    "SKILL.md's Fresh-context-per-member passage",
  );
  const claude = markedLine(region, "CLAUDE", "SKILL.md Fresh-context-per-member CLAUDE line");
  const omp = markedLine(region, "OMP", "SKILL.md Fresh-context-per-member OMP line");
  assert.match(claude, phrase("`SendMessage` to a finished agent resumes its transcript"));
  assert.doesNotMatch(claude, /\bhub send\b/i);
  assert.match(omp, phrase("`hub send` to an idle peer wakes it into its old transcript"));
  assert.doesNotMatch(omp, /SendMessage/);
});

test("SKILL.md fix-applier prompt's grandchild-recipe blockquote carries the marked pair, gutter stripped", () => {
  const raw = between(
    SKILL,
    "named in your spawn result, and its report is the last record:",
    "steps that point at it are the ones you skip.",
    "SKILL.md's fix-applier grandchild-recipe blockquote",
  );
  const region = stripQuoteGutter(raw);
  const claude = markedLine(region, "CLAUDE", "SKILL.md grandchild-recipe CLAUDE line");
  const omp = markedLine(region, "OMP", "SKILL.md grandchild-recipe OMP line");
  assert.match(claude, phrase("retrieve via"));
  assert.match(claude, phrase("tail -1 <output-file> | jq -r"));
  assert.doesNotMatch(claude, /task\.maxRecursionDepth|hub send/i);
  assert.match(omp, phrase("the tail/jq recipe does not apply"));
  assert.doesNotMatch(omp, /`SendMessage`|tail -1/);
});

test("SKILL.md Failure-handling section carries the Settle/liveness pair and the table row no longer names SendMessage", () => {
  const tableRegion = between(
    SKILL,
    "## Failure handling",
    "A red PR never silently becomes",
    "SKILL.md's Failure-handling table",
  );
  assert.doesNotMatch(
    flat(tableRegion),
    /SendMessage/,
    "the Failure-handling table restates a harness-specific verb outside a marked line",
  );

  const pairRegion = between(
    SKILL,
    "Settle outcome and liveness are different axes",
    "Reviewers that went idle on CI recover",
    "SKILL.md's Settle/liveness pair below the Failure-handling table",
  );
  const claude = markedLine(pairRegion, "CLAUDE", "SKILL.md Settle/liveness CLAUDE line");
  const omp = markedLine(pairRegion, "OMP", "SKILL.md Settle/liveness OMP line");
  assert.match(claude, phrase("idle or truncated still answers"));
  assert.doesNotMatch(claude, /`hub cancel`/);
  assert.match(omp, phrase("hub cancel` leaves a peer hard-aborted"));
  assert.doesNotMatch(omp, /`SendMessage`/);
});
