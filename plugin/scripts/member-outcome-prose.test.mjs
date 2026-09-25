// #1591's outcome classification, retargeted by #1804 from the omp workpool
// block to the direct-dispatch Pull (spec 2026-09-24 § 2, ruled without a
// question: "#1591 outcome classification survives verbatim, keyed to the
// member's own job status … reworded per member, 'confirm death first'
// unchanged").
//
// The fact the classification rests on survives the pool: two very different
// facts produce the same silence. A member that DIED (its job settled `failed`
// or `cancelled` — CONTEXT.md § Coordination's Settle vocabulary) never got
// the chance to bail; a member that `completed` its turn with nothing to report
// is merely quiet. Collapsing either into "the member bailed" would demote a
// ticket its member never judged. Only an explicit bail report — the member
// naming the cause itself — may reach `Implementer bails before implementing`
// and its demote-by-cause table (phase 3). What changed is only where the
// status arrives from: under Pull each member's job status arrives as its own,
// where a pool settled once on its whole drain.
//
// The second half of #1591 closed a refill loop: a demotion drops
// `ready-for-agent`, and the ticket it demoted must never be the one handed
// back. Under Pull the same hazard has a new shape — the shortlist file can be
// older than a relabel (this run's own Pulls relabel by cause, ADR 0013
// Decision 4) — and phase 1 closes it by reading the ticket's labels in the
// Pull's own full read.
//
// TABLE-DRIVEN OVER OUTCOME SHAPES, per #1591's own acceptance criterion, so a
// future edit that quietly drops ONE shape reds on exactly that entry instead
// of surviving inside a still-green bundle.
//
// SELF-CHECK carried over from #1591's measurement: a presence-only check per
// settle state passed with `cancelled` stripped from the three-state
// enumeration, because a second `cancelled` occurs later in the paragraph — so
// the enumeration and the collapse sentence are each pinned by their own words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

const phase = (from, to) => between(RUN_TEAM, from, to, `run-team/SKILL.md ${from.trim()}`);

const outcomeParagraph = () =>
  paragraph(
    phase("## Phase 2", "## Phase 3"),
    "A member settling with nothing is not, by itself, a bail.",
    "run-team/SKILL.md member outcome-classification paragraph",
  );

const relabelParagraph = () =>
  paragraph(
    phase("## Phase 1", "## Phase 2"),
    "A Pull never re-admits a ticket already relabelled.",
    "run-team/SKILL.md Pull relabel-safety paragraph",
  );

test("run-team/SKILL.md: a member's outcome arrives as its own job status", () => {
  assert.match(outcomeParagraph(), phrase("Each member's outcome arrives as its own job status"));
});

// Settle (CONTEXT.md § Coordination) is three states on omp, and the paragraph
// must name all three — never fewer, which is exactly how a `failed`/
// `cancelled` reading could quietly re-collapse into `completed`.
for (const state of ["completed", "failed", "cancelled"]) {
  test(`run-team/SKILL.md: the outcome paragraph names omp's \`${state}\` settle state`, () => {
    assert.match(outcomeParagraph(), new RegExp("`" + state + "`"));
  });
}

test("run-team/SKILL.md: the outcome paragraph enumerates all three omp settle states together, in one list", () => {
  assert.match(outcomeParagraph(), phrase("Settle (CONTEXT.md § Coordination) is three states on omp — `completed`, `failed`, `cancelled` —"));
});

test("run-team/SKILL.md: the outcome paragraph names the failed/cancelled-vs-completed collapse as the exact failure it blocks", () => {
  assert.match(outcomeParagraph(), phrase("and reading `failed`/`cancelled` the same as a `completed` turn that had nothing"));
  assert.match(outcomeParagraph(), phrase("is the exact collapse this line blocks"));
});

// #1591's core acceptance, table-driven: each of the three outcome shapes gets
// its OWN reading, distinct text a reader cannot satisfy by pointing at either
// of the other two rows.
const OUTCOME_SHAPES = [
  { name: "died (failed/cancelled settle)", pin: phrase("a member that died never chose to bail") },
  { name: "completed with nothing (alive, merely quiet)", pin: phrase("a died or merely-quiet member's silence never does") },
  {
    name: "explicit bail report",
    pin: phrase("Only an explicit bail report — the member itself naming the cause — reaches Implementer bails before implementing"),
  },
];
for (const shape of OUTCOME_SHAPES) {
  test(`run-team/SKILL.md: the outcome paragraph gives "${shape.name}" its own reading`, () => {
    assert.match(outcomeParagraph(), shape.pin);
  });
}

test("run-team/SKILL.md: a dead member recovers exactly as the Member-killed row does, never as a demotion", () => {
  assert.match(outcomeParagraph(), phrase("Confirm death first, exactly as the Member-killed row does"));
  assert.match(
    outcomeParagraph(),
    phrase("A confirmed-dead member recovers exactly as the Member-killed row says — new member, new name, the SAME ticket — never a demotion"),
  );
});

// The contradiction this paragraph exists to block: reading silence itself —
// with no confirmation step — as grounds to demote. Phrase-agnostic by design
// (inherited narrow idiom-only regex previously missed a colon-phrased
// restatement of the same forbidden meaning, e.g. "Silence alone: treat it as
// a bail." — caught live against the pinned paragraph): any short clause that
// co-locates "silence" with "bail" is blocked outright, and any clause that
// equates "silence" with a demotion via a copula/colon/"treat as" construction
// is blocked too — while the paragraph's own legitimate "so demoting its
// ticket on its silence demotes a ticket" (describing the collapse the line
// BLOCKS, not endorsing it) must keep passing, which is why the demote guard
// requires an equivalence construction rather than bare proximity.
test("run-team/SKILL.md: no text in the outcome paragraph lets silence alone stand in for a bail or a confirmed death", () => {
  const p = outcomeParagraph();
  assert.doesNotMatch(p, /\bsilence\b[^.]{0,30}\bbail\b/i);
  assert.doesNotMatch(
    p,
    /\bsilence\b(?:\s+alone)?\s*[:,]?\s*(?:is|means|counts\s+as|equates?\s+to|treat(?:s|ed)?(?:\s+it)?\s+as|reads?\s+as)\s+(?:an?\s+)?(?:clean\s+)?(?:grounds?\s+(?:for|to)\s+)?demot\w*/i,
  );
  assert.doesNotMatch(p, /(?:always|automatically)\s+demote/i);
  assert.doesNotMatch(p, /\b(?:is|are)\s+demoted\b/i);
});

// #1591's second acceptance, in the Pull's shape: a relabel must hold across a
// shortlist built before it landed. Both the check (the Pull's own label read)
// and the failure it blocks are pinned — dropping either leaves a stale-list
// admission unguarded.
test("run-team/SKILL.md: a Pull reads the ticket's labels and drops one that lost `ready-for-agent`", () => {
  assert.match(relabelParagraph(), phrase("The shortlist file can be older than a relabel"));
  assert.match(relabelParagraph(), /`--json\s+title,body,comments,labels`\)\s+and\s+drop\s+it\s+when\s+`ready-for-agent`\s+is\s+gone/);
  assert.match(relabelParagraph(), phrase("A Pull that trusted a list built before the relabel landed would hand a ticket the fleet has already judged unimplementable straight to the next member"));
});

// The label the paragraph reads has to be one the Pull's full read actually
// fetches — cross-checked against step 3's own invocation, the way #1591 once
// cross-checked the pool's borrowed `candidates.mjs` call against phase 0's.
test("run-team/SKILL.md: the Pull's full read fetches the labels the relabel check reads", () => {
  const step3 = between(RUN_TEAM, "3. **Read the ticket in full, once**", "One read answers every question", "run-team/SKILL.md Pull step 3");
  assert.match(step3, /gh\s+issue\s+view\s+<N>\s+--json\s+title,body,comments,labels/, "the Pull's full read no longer fetches `labels`, so the relabel check has nothing to read");
});
