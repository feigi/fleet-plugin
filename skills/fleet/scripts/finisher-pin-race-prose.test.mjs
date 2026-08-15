import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #144. The finisher is dispatched pinned to a SHA the reviewer already left
// behind: the reviewer composes a verdict once it has enough, then keeps
// applying late-arriving specialist relays and pushes again. The pin going
// stale isn't the defect — the halt-on-moved-head rule already catches it,
// correctly, every time. The defect is that (a) the controller dispatches
// before every specialist report is relayed, when it holds the receipts to
// know better, and (b) a halt reads only "SHA differs from pin" and gives
// the controller nothing to act on without a fresh audit.
//
// Slice-scoped, not whole-file: a bare presence check anywhere in this
// 1200+ line SKILL.md would stay green even if the text moved somewhere
// that never reaches its reader (measured before, in this same file —
// member-prompt-prose.test.mjs #172). Two different readers here: the
// dispatch gate is controller-facing and lives in the Fallback section, the
// two-cause evidence is finisher-facing and must sit inside a `>` block the
// controller carries verbatim.
const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

const FALLBACK_START = "#### Fallback: hand-dispatched reviewer member";
const FALLBACK_END = "### Merge bot";

function fallbackSection() {
  const at = RUN_TEAM.indexOf(FALLBACK_START);
  assert.notEqual(at, -1, `fallback section header ('${FALLBACK_START}') moved — update this test`);
  const end = RUN_TEAM.indexOf(FALLBACK_END, at);
  assert.notEqual(end, -1, `the next section header ('${FALLBACK_END}') moved — update this test`);
  return RUN_TEAM.slice(at, end);
}

const CAUSE_BLOCK_START = "instead of asking anyone:";
const CAUSE_BLOCK_END = "Gate on the `check` job";

// Raw slice: keeps the `>` prefixes, needed by the structural (every-line-quoted)
// test below.
function causeBlock() {
  const at = RUN_TEAM.indexOf(CAUSE_BLOCK_START);
  assert.notEqual(at, -1, `two-cause anchor ('${CAUSE_BLOCK_START}') moved — update this test`);
  const end = RUN_TEAM.indexOf(CAUSE_BLOCK_END, at);
  assert.notEqual(end, -1, `the CI-gate paragraph that follows ('${CAUSE_BLOCK_END}') moved — update this test`);
  return RUN_TEAM.slice(at + CAUSE_BLOCK_START.length, end);
}

// Flattened: markdown hard-wraps a `>` block at ~80 columns, so a phrase can
// split across a line with a literal `>` re-injected at the wrap point. A
// phrase match needs the wrap invisible; the structural test needs it intact,
// hence two helpers instead of one.
function causeText() {
  return causeBlock().replace(/\n>?[ \t]*/g, " ");
}

test("finisher dispatch is gated on outstanding specialist relays, in the section that owns relay receipts", () => {
  const section = fallbackSection();
  assert.match(
    section,
    /receipts gate the finisher dispatch/i,
    "the fallback section no longer gates finisher dispatch on relay receipts — a late relay can again land after dispatch with nothing checking for it",
  );
  assert.match(
    section,
    /unrelayed/,
    "the gate no longer names an unrelayed report as the blocking condition",
  );
  // The scope boundary matters as much as the rule: the workflow path has no
  // async relay at all (`agent()` returns synchronously), so a gate that reads
  // as universal would strand controllers into believing a wait is needed
  // where none exists.
  assert.match(
    section,
    /workflow path/i,
    "the gate doesn't say it's a no-op on the workflow path — a controller reading only this rule may wait on a relay that can never arrive there",
  );
});

test("the two-cause evidence sits inside a quote block, not only in controller narrative", () => {
  const block = causeBlock();
  const lines = block.split("\n").filter((l) => l.trim() !== "");
  assert.ok(lines.length > 0, "the two-cause block is empty");
  const stray = lines.filter((l) => !l.startsWith(">"));
  assert.deepEqual(
    stray,
    [],
    "two-cause text sits outside the `>` block — a finisher only receives this if the controller paraphrases it, same failure #172 already fixed once in this file for the implementer",
  );
});

test("both causes are named, with evidence a finisher can gather without asking anyone", () => {
  const text = causeText();

  assert.match(text, /\*\*Live editor\.\*\*/, "the live-editor cause is no longer named");
  assert.match(
    text,
    /git status --porcelain.*dirty/,
    "live editor is no longer tied to a dirty worktree, checkable with a plain git command",
  );
  assert.match(
    text,
    /git diff --stat.*\bapart\b/,
    "the growth check (two samples apart) is missing — a single dirty read can't distinguish a live editor from a one-off leftover",
  );

  assert.match(text, /\*\*Rebase\.\*\*/, "the rebase cause is no longer named");
  assert.match(
    text,
    /git reflog/,
    "the rebase cause no longer points at git reflog — without it a finisher has no self-checkable way to tell a rebase from a live edit on a clean tree",
  );
});

test("a moved head still halts, always — the two causes decide what the report says, never whether it halts", () => {
  const text = causeText();
  // ONE exact contiguous span, not two independent phrase matches. The
  // invariant lives in the join: splicing an exception clause between
  // "halts, always" and "you never verify the dirt is harmless" reverses the
  // rule while leaving both phrases intact, and two separate `assert.match`
  // calls stayed green through exactly that mutation (measured, #488 review).
  // The tail is the explicit rejection of issue option 3 ("accept a
  // fast-forward") — the controller ruling took options 2+4, not 3, and a
  // finisher that treats a clean rebase as auto-approved is what triage
  // rejected. Whitespace is already normalised by causeText(), so this is
  // literal text, not a shape.
  assert.match(
    text,
    /Either cause halts, always — you never verify the dirt is harmless and label over it, and a rebase is not a fast-forward you get to accept\./,
    "the always-halts invariant no longer reads verbatim in the block the finisher reads — either it's gone, or a clause was inserted into it that makes the halt conditional, or the ban on labelling over a moved head was dropped",
  );
});

test("the pre-existing ruling-owed gate for the fix-applier is untouched", () => {
  // ACCEPT side: this run's edit sits right next to the fix-applier dispatch
  // paragraph. This pins that the older, unrelated rule wasn't clipped or
  // reworded by mistake while adding the new one beside it.
  assert.match(
    RUN_TEAM,
    /Never dispatch\s*\n?one while you still owe the fix-applier a ruling/,
    "the fix-applier ruling-owed gate no longer reads as before — check it wasn't altered while adding the specialist-relay gate nearby",
  );
});
