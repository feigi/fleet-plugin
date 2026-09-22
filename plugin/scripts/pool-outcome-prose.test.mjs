// #1591, under #1420, after #1590 (the pool that refills implementer slots with
// no completion event). #1590's own "Completion detection is unchanged"
// paragraph is exactly that — unchanged, and this file's first test re-pins it
// verbatim to prove this ticket's insertion did not touch it. What #1590 left
// open is everything BESIDES a clean completion: a pool settles once, on the
// whole pool's drain, never per item, so a worker that never reported has no
// event of its own for the controller to read — and two very different facts
// produce that same silence. A member that DIED (its job settled `failed` or
// `cancelled` — CONTEXT.md § Coordination's Settle vocabulary) never got the
// chance to bail; a member that `completed` its turn with nothing to report is
// merely quiet. Collapsing either into "the member bailed" would demote a
// ticket its member never judged, or would demote one nobody has confirmed is
// even in trouble yet. Only an explicit bail report — the member naming the
// cause itself — may reach `Implementer bails before implementing` and its
// demote-by-cause table (phase 3, unchanged by this ticket — see "Any change
// to the demotion vocabulary itself beyond using it by cause" is out of scope
// on #1591). The second half closes the loop that table opens: a bail drops
// `ready-for-agent` before the freed worker's next push, so the ticket it just
// demoted must never be the one handed back — not to the pool it bailed out
// of, and not to a later one opened while the demotion still stands.
//
// TABLE-DRIVEN OVER OUTCOME SHAPES, PER #1591'S OWN ACCEPTANCE CRITERION. The
// pool-outcome paragraph draws a three-way line — died, quiet-but-alive,
// explicitly-bailed — and a refill-safety paragraph draws a two-way one — this
// pool, a later pool. Both lines are asserted here as tables (`OUTCOME_SHAPES`,
// `REFILL_SCOPES`) rather than as one bundled regex per paragraph, so a future
// edit that quietly drops ONE shape or ONE scope reds on exactly that entry
// instead of surviving inside a still-green bundle. No live harness anywhere
// in this file: every assertion is a bounded string match over the checked-out
// prose, the same instrument every other `*-prose.test.mjs` file in this
// directory uses.
//
// SCOPE. Both new paragraphs sit inside #1590's own `section()` — the block
// scoped "the pool's own discipline and therefore omp's alone" — so this file
// reuses that same bound rather than re-deriving a second one, and adds one
// test of its own confirming the new prose stays inside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// The same pool-discipline block #1590's own test file bounds — never a
// second, looser derivation of the same span.
const section = () =>
  between(
    RUN_TEAM,
    "**Implementer slots are refilled to the cap from the staged pool",
    "One named member per ticket, up to cap, background.",
    "run-team/SKILL.md phase 2 refill block",
  );

const outcomeParagraph = () =>
  paragraph(
    section(),
    "A pool item settling with nothing is not, by itself, a bail.",
    "run-team/SKILL.md pool outcome-classification paragraph",
  );

const refillParagraph = () =>
  paragraph(
    section(),
    "Refilling a freed pool worker never re-pushes the ticket that just left it.",
    "run-team/SKILL.md pool refill-safety paragraph",
  );

test("run-team/SKILL.md: both new pool-outcome paragraphs sit inside the pool's own omp-only discipline block", () => {
  assert.match(section(), phrase("A pool item settling with nothing is not, by itself, a bail"));
  assert.match(section(), phrase("Refilling a freed pool worker never re-pushes the ticket that just left it"));
});

// #1591's acceptance: "Completion detection for successful members is
// unchanged." Re-pinned here, verbatim, byte-for-byte identical to #1590's own
// pin in pool-dispatch-dialect-prose.test.mjs — this ticket's insertion sits
// AFTER this paragraph's own blank-line close, never inside it.
test("run-team/SKILL.md: completion detection for successful members is unchanged by this ticket", () => {
  assert.match(
    section(),
    /\*\*Completion\s+detection\s+is\s+unchanged\.\*\*\s+Members\s+report\s+as\s+they\s+do\s+today\s+and\s+the\s*\n?monitor\s+edges\s+stay[\s\S]{0,260}trade\s+a\s+dead\s*\n?refill\s+edge\s+for\s+a\s+dead\s+completion\s+edge/,
  );
  assert.match(
    section(),
    /the\s+ledger\s+still\s+records\s+one\s+Dispatch\s+per\s+member,\s+so\s*\n?member-outcomes\s+scraping\s+and\s+tier\s+accounting\s+are\s+unaffected/,
  );
  assert.match(
    section(),
    /A\s+pool-dispatched\s*\n?member's\s+transcript\s+must\s+be\s+reachable\s+exactly\s+as\s+a\s+hand-dispatched\s+one's\s+is/,
  );
});

// The completion-detection paragraph's own close ("...report it if it is not.")
// is followed by nothing but a blank line and this ticket's new paragraph —
// never a rewritten completion-detection clause, never a third paragraph
// wedged in between that neither test here nor #1590's own file would catch.
// `between` returns a slice that STARTS at the `from` anchor itself (see
// prose-pin.mjs), so the anchor's own length is stripped before checking what
// comes after it.
test("run-team/SKILL.md: the pool-outcome paragraph is the very next paragraph after completion detection, not a rewrite of it", () => {
  const anchor = "first pooled wave and report it if it is not.";
  const slice = between(section(), anchor, "**A pool item settling with nothing", "run-team/SKILL.md gap between completion-detection and pool-outcome paragraphs");
  const gap = slice.slice(anchor.length);
  assert.equal(gap, "\n\n", `expected exactly one blank line between the two paragraphs, got ${JSON.stringify(gap)}`);
});

// Settle (CONTEXT.md § Coordination) is three states on omp, and the pool
// paragraph must name all three — never fewer, which is exactly how a
// `failed`/`cancelled` reading could quietly re-collapse into `completed`.
const SETTLE_STATES = ["completed", "failed", "cancelled"];
for (const state of SETTLE_STATES) {
  test(`run-team/SKILL.md: the pool-outcome paragraph names omp's \`${state}\` settle state`, () => {
    assert.match(outcomeParagraph(), new RegExp("`" + state + "`"));
  });
}

// #1591's core acceptance, table-driven: the paragraph must give each of the
// three outcome shapes its OWN reading, distinct text a reader cannot satisfy
// by pointing at either of the other two rows.
const OUTCOME_SHAPES = [
  {
    name: "died (failed/cancelled settle)",
    pin: phrase("a member that died never chose to bail"),
  },
  {
    name: "completed with nothing (alive, merely quiet)",
    pin: phrase("a died or merely-quiet member's silence never does"),
  },
  {
    name: "explicit bail report",
    pin: phrase("Only an explicit bail report — the member itself naming the cause — reaches Implementer bails before implementing"),
  },
];
for (const shape of OUTCOME_SHAPES) {
  test(`run-team/SKILL.md: the pool-outcome paragraph gives "${shape.name}" its own reading`, () => {
    assert.match(outcomeParagraph(), shape.pin);
  });
}

test("run-team/SKILL.md: a died item recovers exactly as the Member-killed row does, never as a demotion", () => {
  assert.match(outcomeParagraph(), phrase("Confirm death first, exactly as the Member-killed row does"));
  assert.match(
    outcomeParagraph(),
    phrase("A confirmed-dead item recovers exactly as the Member-killed row says — new member, new name, the SAME ticket — never a demotion"),
  );
});

// The contradiction this paragraph exists to block: reading silence itself —
// with no confirmation step — as grounds to demote. Neither literal phrase, nor
// the collapse a future "simplification" would reach for, may appear anywhere
// in the block this paragraph sits in.
test("run-team/SKILL.md: no nearby text lets silence alone stand in for a bail or a confirmed death", () => {
  assert.doesNotMatch(section(), /silence (?:is|means|counts as) (?:a |an )?(?:clean )?bail/i);
  assert.doesNotMatch(section(), /(?:always|automatically) demote/i);
});

// #1591's second acceptance, table-driven over the two scopes a demotion must
// hold across: the pool the ticket just bailed out of, and any pool opened
// later while the demotion still stands.
const REFILL_SCOPES = [
  {
    name: "the same pool it bailed out of",
    pin: phrase("excluded from its own pool's remaining pushes"),
  },
  {
    name: "a later pool opened while the demotion stands",
    pin: phrase("from every later pool's shortlist alike, for as long as the demotion stands"),
  },
];
for (const scope of REFILL_SCOPES) {
  test(`run-team/SKILL.md: the refill-safety paragraph excludes a demoted ticket from ${scope.name}`, () => {
    assert.match(refillParagraph(), scope.pin);
  });
}

test("run-team/SKILL.md: the refill-safety paragraph ties the exclusion to the SAME live label check phase 0 already runs", () => {
  assert.match(refillParagraph(), phrase("drops `ready-for-agent` before the freed worker takes its next item"));
  assert.match(refillParagraph(), phrase("the same `candidates.mjs --require-label ready-for-agent` scan phase 0 already runs for a hand-dispatch pick"));
});

// The phrase this paragraph borrows must be the REAL phase-0 invocation, not a
// copy that has drifted from it — cross-checked against the file's own text
// outside this block, the same way #1590's own dialect test cross-checks its
// pair against the tree rather than trusting a local copy.
test("run-team/SKILL.md: the borrowed candidates.mjs invocation matches phase 0's own, not a stale copy", () => {
  assert.match(RUN_TEAM, /`~\/\.fleet\/bin\/fleet-run candidates\.mjs\s+--require-label ready-for-agent`/);
});
