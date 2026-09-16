// #1045, the residue of #503. The guidance a controller reads to judge whether
// a member has died offered the transcript as the evidence, and the transcript
// cannot answer: a member wedged on a blocked tool call emits the dead
// member's whole signature — record counts unchanged from one poll to the
// next. Settled against `origin/main` before this landed:
//
//   git show origin/main:plugin/skills/run-team/SKILL.md \
//     | grep -ciE 'mtime|blocked tool call|frozen transcript'   -> 0
//
// #503's own "Also worth pinning" item names the discriminator and the
// measurement behind it: its refuter sat forever on
// `until grep -q "^# fail" mut_a.txt` while `node --test` wrote the `ℹ`
// prefix, "record counts were unchanged across two polls while `pin.log` /
// `mut2.txt` / `base.log` all carried fresh mtimes". PR #1043 closed #503
// carrying only the refuter's observation rule, so this half survived nowhere
// but the tracker.
//
// WHERE IT GOES, and that is half the ticket. The clause sits in `## Failure
// handling`, between the table row that acts on a dead member and the
// Settle/liveness pair that says how to ask each harness — not in Phase 3's
// narrative, which is about reacting to artifacts rather than judging death.
// The killed row itself carries the gate in one clause, because a controller
// scanning the table acts off the row.
//
// THE SPAN IS ONE JOIN, not four assertions. The instruction runs from "does
// not establish" through the two verdicts, the carve-out, and the measurement
// that produced it, and a `\s+`-joined span has nowhere for a splice to land;
// split into separate matches, a sentence reinstating a transcript-only
// verdict fits between any two of them and every match stays green. The
// why-prose after it — the filenames, the cost asymmetry, the symmetry with
// #1043's own rule — is deliberately NOT pinned, so it stays rewordable.
//
// THE CEILING. A deliberate reword of the instruction reds this, and the fix
// is to re-anchor the phrase here, never to drop a half. A rewrap is a no-op
// by construction (`phrase()` joins on `\s+`). An emphasis move inside the
// span reds it too: the `**` markers around the verdict pair are matched
// literally, because moving them moves which half a reader sees as the rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase } from "./prose-pin.mjs";

const SKILL = "skills/run-team/SKILL.md";
const read = () => readFileSync(join(import.meta.dirname, "..", ...SKILL.split("/")), "utf8");

// The paragraph carrying the rule, and no more of the file than that — the
// shared bound, which also asserts the anchor occurs exactly once. This
// document says "transcript", "scratch" and "mtime" in several other places
// (`board.mjs`'s ranking is discussed nowhere near here, but the dispatch
// prompts' own scratch-partition rule is), so an unbounded match is
// satisfiable from outside the clause it guards.
const ANCHOR = "**A frozen transcript does not establish that a member is dead";
const clause = () => paragraph(read(), ANCHOR, `${SKILL}'s stalled-member liveness clause`);

// One span: the epistemic rule, the discriminator, BOTH verdicts, the
// carve-out that keeps the second verdict from licensing a false kill, and the
// #503 measurement.
const INSTRUCTION = `A frozen transcript does not establish that a member is dead — the
discriminator is its scratch dir.** A member wedged on a blocked tool call
emits the whole signature of a dead one: record counts unchanged from one poll
of its transcript to the next. So read the mtimes of the files in the scratch
subdirectory its own dispatch prompt assigned it — \`<scratch>/impl-<N>/\` for an
implementer, \`<scratch>/pr<N>/...\` on the review side — at two observations a
poll apart: **mtimes that moved between the two mean BLOCKED, a live member
still holding its claim and its worktree, so the killed row above does not
apply to it; mtimes unchanged at both are the dead signature.** Only the first
of those two verdicts is conclusive — a member wedged on a call that writes
nothing freezes its scratch dir too — so settle the dead one on the liveness
read below, never on the two listings alone. Measured on #503: a refuter
wedged forever on \`until grep -q\` for a marker \`node --test\` never writes, its
transcript's record counts unchanged across two polls while its own scratch
files carried fresh mtimes throughout — alive the entire time it read as dead.`;

test("the stalled-member guidance says a frozen transcript does not establish death, and names the mtime discriminator with both its verdicts", () => {
  assert.match(
    clause(),
    phrase(INSTRUCTION),
    `${SKILL}'s stalled-member clause no longer carries the whole instruction. One of these went, or a sentence was spliced between them: (1) a frozen transcript does not establish death; (2) the signature it shares with a blocked tool call; (3) the discriminator — the mtimes of the member's own scratch subdirectory, read at TWO observations a poll apart; (4) moved mtimes mean BLOCKED, unchanged mtimes are the dead signature; (5) only the blocked verdict is conclusive, because a call that writes nothing freezes the scratch dir too; (6) the #503 measurement it was derived from. Without (3) and (4) the controller is back to judging death off the transcript, which is #503's own residue; without (5) the clause licenses killing a live member wedged on a network read. Re-anchor this span against the reworded paragraph rather than dropping a half.`,
  );
});

// The mutation a presence pin cannot see, and the one this ticket names: the
// clause left intact with a contradiction appended BESIDE it — "a transcript
// frozen across three polls is enough", "where the scratch dir is empty, treat
// the member as dead". Nothing in the span above notices, because the span is
// still there.
//
// The ban is the paragraph's own subject vocabulary, over what is left once
// the pinned span is removed. Any carve-out of THIS rule has to name at least
// one of the things the rule is about — the transcript, the scratch dir, the
// mtimes, the record counts, or the two verdicts themselves — so banning them
// outside the span catches a carve-out at any wording, which is what the
// enumerated-idiom version could not do. The unpinned why-prose is written to
// carry none of them: it talks about filenames, listings, cost and the fleet.
// `replace` is deliberately non-global — a SECOND copy of the instruction is
// itself drift, and it lands in the residue where the ban catches it.
//
// The strip is REQUIRED to find something first, and that is not
// belt-and-braces. Measured on this pin: with the instruction deleted or
// half-deleted, an unguarded `replace` removes nothing, the whole mutated
// paragraph becomes the residue, and this test reds telling the reader a
// carve-out was appended beside a clause that is in fact missing — the wrong
// repair, pointed at the wrong sentence. A probe that could not look says so
// instead and leaves the presence pin above to name the real defect. It never
// goes green on that case: a vacuous pass here is what would let a deletion
// and a carve-out land together with only one of them reported.
const SUBJECT_VOCABULARY = /\b(?:transcripts?|mtimes?|record\s+counts?|scratch|frozen|dead|blocked)\b/i;

test("nothing beside the clause carves an exception out of it", () => {
  const whole = clause();
  const span = whole.match(phrase(INSTRUCTION));
  assert.ok(
    span,
    `${SKILL}'s stalled-member instruction does not match, so this pin cannot judge what sits beside it — read the presence pin above, which names which half of the instruction went. Nothing here is a verdict on an appended carve-out until that span is restored.`,
  );
  const residue = whole.replace(span[0], "");
  assert.doesNotMatch(
    residue,
    SUBJECT_VOCABULARY,
    `${SKILL}'s stalled-member paragraph says something about the transcript, the scratch dir, the mtimes or the verdicts OUTSIDE the pinned instruction. That is either a carve-out — the mutation this pin exists to catch, since the instruction itself survives it intact — or an unpinned restatement, which drifts from the pinned copy and becomes a contradiction. Fold the sentence into the span this file pins, or delete it.`,
  );
});

// Cross-slice, same hazard the file's other table pins name: the table is the
// controller's index, and the killed row is where it acts on a death it has
// concluded. A gate stated only two paragraphs below is a gate a row-scanner
// never reads.
//
// BOTH halves of the row in one span, for opposite reasons. Dropping the gate
// puts the row back to answering a frozen transcript. Dropping the response
// leaves the gate with nothing behind it — a controller that has confirmed a
// death and has no row authorizing the replacement, which is the direction
// this clause could wrongly REFUSE in, and the one a suite that only ever
// feeds it a live member never tests.
const failureTable = () =>
  between(read(), "## Failure handling", "A red PR never silently becomes", `${SKILL}'s failure table`);

test("the killed row gates on confirming death, not on a frozen transcript", () => {
  assert.match(
    failureTable(),
    phrase("| Member **killed** (spend limit, API error, crash) | Confirm it is dead first — a frozen transcript does not establish that; see below — then new member, new name, prompt carries inherited state |"),
    `${SKILL}'s killed row lost a half. The GATE half — confirm it is dead first, a frozen transcript does not establish that — is what keeps the row from answering a frozen transcript, where the controller replaces a member it never established was gone, discarding work in flight and colliding with its own claim and worktree. The RESPONSE half — new member, new name, prompt carries inherited state — is what a CONFIRMED death must still reach; a gate with no response behind it strands the case this clause exists to let through.`,
  );
});
