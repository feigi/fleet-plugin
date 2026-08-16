import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Implementers dispatch at the SESSION's tier, whatever the ticket class. The
// `class=routine` → `sonnet` binding was reverted 2026-08-16 when the phase-2
// guard fired, so the class now selects the correction-ticket DISCIPLINE and
// partitions the metrics file — never a model.
//
// Two ways this rots, and they pull in opposite directions. (a) The binding
// creeps back: someone re-reads the guard's rationale, sees the saving argued
// for at length, and restores `model: "sonnet"` in one of the two places that
// used to carry it. The negative pins below exist for that, and there are two
// because phase 0 and phase 2 each stated the binding independently — changing
// only one is exactly the half-revert this test failed to catch when the revert
// was first written. (b) The class judgement is dropped as pointless now that
// it prices nothing, taking the correction discipline with it. Nothing outside
// this file catches either; the fleet never reads back the model it dispatched
// at (board.mjs parses `message.usage` off the subagent JSONL and drops
// `message.model` on the same line).
//
// Presence pins are not enough here. An earlier draft of these tests passed
// with the rule INVERTED end to end — corrections at `sonnet`, everything else
// at top tier — because every token it looked for was still somewhere in the
// slice. Each class is therefore pinned to its tier by ADJACENCY, with the
// competing tier token excluded from the gap.
//
// Slice by named anchors and fail loudly when one moves; slice SIZE is what
// does the work. One slice per paragraph, never per phase: the phase-2 section
// is ~90 lines and its member prompt restates enough of this vocabulary to
// satisfy every pin below with both rules deleted.
//
// `section()` is duplicated from review-path-default.test.mjs rather than
// shared — two files, seven lines. Nothing detects drift between the copies.
const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

function section(source, startAnchor, endAnchor, label) {
  const at = source.indexOf(startAnchor);
  assert.notEqual(at, -1, `${label}: '${startAnchor}' moved — update this test`);
  const end = source.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, `${label}: '${endAnchor}' moved — update this test`);
  return source.slice(at, end);
}

// These three slices are paragraph-tight. A failure here means the text was
// deleted OR relocated — check the rest of the file before assuming deletion.
const step4 = () =>
  section(RUN_TEAM, "4. **Read each survivor in full", "5. **Collision scan", "run-team phase 0 step 4");
const dispatch = () =>
  section(RUN_TEAM, "**Dispatch every implementer at the session's tier", "**Guard: accumulate per PR", "run-team phase 2 dispatch rule");
const guard = () =>
  section(RUN_TEAM, "**Guard: accumulate per PR", "One named member per ticket", "run-team phase 2 tier guard");

test("phase 0 step 4 still earns its class judgement now that the class prices nothing", () => {
  const slice = step4();

  // The criterion, not the label: what makes a ticket a correction ticket has
  // to be checkable by the controller reading the issue, or the class is a coin
  // flip. Not /docs|comments/ — this slice opens with `--json title,body,comments`,
  // so the `comments` alternative stays green with the criterion deleted.
  // Bound to the class it selects, with `routine` excluded from the gap: a bare
  // /bad citations/ survives the two classes being swapped.
  assert.match(
    slice,
    /bad citations(?:(?!routine)[^.])*?`class=correction`/,
    "step 4 no longer routes the correction criterion to `class=correction`",
  );
  // What the class is FOR after the revert. Without this the judgement reads as
  // vestigial and the next compression pass deletes it — taking the correction
  // discipline, which is the half that caught real defects, with it.
  assert.match(
    slice,
    /no longer selects a model tier/,
    "step 4 no longer says the class stopped selecting a tier — the reverted binding reads as live again",
  );
  assert.match(
    slice,
    /correction-ticket\*{0,2} discipline/,
    "step 4 no longer says what the class still selects, so the judgement reads as vestigial",
  );
  // THE NEGATIVE, half one of two. Restoring `class=routine` → `sonnet` here
  // while phase 2 stays reverted is the self-contradiction the revert shipped
  // with on its first pass: phase 0 priced the ticket, phase 2 ignored it, and
  // nothing failed. Bounded to one sentence so an unrelated later `sonnet`
  // (the file discusses the reverted rule in the past tense) cannot red it.
  assert.doesNotMatch(
    slice,
    /`class=routine`[^.]{0,120}`sonnet`/,
    "step 4 has re-bound `class=routine` to `sonnet` — the reverted rule is back in phase 0",
  );
  // Safe direction on a judgement with no tiebreak. The adjacent decided?
  // judgement says "Torn → surface"; this one is cheap enough to just default.
  assert.match(slice, /\*\*Torn → correction\*\*/, "step 4 lost its tiebreak, so a torn class dispatches on a guess");
  // The citation is a precaution, NOT evidence about tiers —
  // references/correction-tickets.md measures no tier and blames the ticket's
  // framing. An earlier draft claimed the four-for-four happened "at top tier",
  // a qualifier that reference does not carry. Pin the honesty, or it comes back.
  assert.match(
    slice,
    /precaution, not a\s+\*{0,2}measurement/,
    "step 4 states the correction exception as measured rather than as a precaution",
  );
  assert.match(
    slice,
    /measures no tier at\s+all/,
    "step 4 no longer says the cited reference measures no tier — the citation reads as evidence again",
  );
});

test("phase 2 dispatches every class at the session tier, and says so with a mechanism", () => {
  const slice = dispatch();

  // The rule, bound to "whatever the class" so a re-introduced per-class branch
  // reds here rather than silently coexisting with this sentence.
  assert.match(
    slice,
    /omit `model` on the Agent\s+call, whatever the class/,
    "phase 2 no longer dispatches every class the same way — a per-class tier branch is back",
  );
  // THE NEGATIVE, half two of two. See the step-4 companion: the binding was
  // stated independently in both places, so restoring either one alone is
  // undetectable without a pin on each.
  assert.doesNotMatch(
    slice,
    /`class=routine` →\s*`model: "sonnet"`/,
    "phase 2 has re-bound `class=routine` to `model: \"sonnet\"` — the reverted rule is back",
  );
  // The revert is dated and attributed, or the next reader takes the missing
  // tier for an omission and helpfully restores it.
  assert.match(
    slice,
    /REVERTED on 2026-08-16/,
    "phase 2 no longer records WHEN and WHY the tier binding was removed",
  );
  // Anchored to the omission, not the word "inherit": the tier is obtained by
  // NOT passing `model`, and "implementers run at the session tier" with no
  // mechanism is exactly the instruction-names-no-mechanism defect the skill's
  // own tooling-fix triggers list calls out.
  assert.match(
    slice,
    /a member\s+dispatched with `model` set does not get it back/,
    "phase 2 no longer says HOW the session tier is obtained — omitting `model` is the mechanism",
  );
  // The omission only reaches the session tier when the subagent type carries no
  // model of its own; two pr-review-toolkit agents in this repo pin `model: opus`
  // in frontmatter, so the precondition is not hypothetical.
  assert.match(
    slice,
    /no `model:` frontmatter/,
    "phase 2 states the omission mechanism without its precondition",
  );

  // A lost class no longer misprices anything, but it still costs the correction
  // discipline — so the recording rule has to survive the revert, and has to say
  // what is actually lost or it reads as bookkeeping and gets dropped.
  assert.match(
    slice,
    /\*\*No class recorded → record `class=unknown`, never a guess\.\*\*/,
    "a missing class is no longer recorded as `class=unknown` — the gap goes invisible",
  );
  assert.match(
    slice,
    /correction-ticket discipline/,
    "phase 2 no longer says what a lost class actually costs now that it prices nothing",
  );
  // Reconstructing the class from the model would resurrect the confound the
  // revert removed, and would silently break under any future tier control.
  assert.match(
    slice,
    /Never infer the class from the tier/,
    "phase 2 no longer forbids inferring class from tier",
  );

  // All three ledger literals. Only `class=correction` was ever spelled, which
  // left an absent field ambiguous between "ran routine", "never recorded" and
  // "row predates the rule" — and partitioning by class is the guard's whole job.
  for (const cls of ["routine", "correction", "unknown"]) {
    assert.match(
      slice,
      new RegExp(`ledger\\.mjs row <N> "impl-<N> · class=${cls}"`),
      `phase 2 no longer spells the ledger literal for class=${cls}`,
    );
  }
  // `row` REPLACES the line (ledger.mjs's `data.rows[i] = line`). Replaying a
  // two-token literal over a row carrying KILLED or → PR# drops those tokens with
  // only `rewrote row #N` on stderr.
  assert.match(
    slice,
    /replaces the whole line/,
    "phase 2 shows a ledger literal without saying `row` replaces rather than appends",
  );
});

test("phase 2's guard is mandatory, runnable, and scoped to one class", () => {
  const slice = guard();

  // The unit. Implementers are refilled level-triggered, one slot at a time —
  // "wave" everywhere else in this file means MERGE wave, so the original
  // "compare this wave against the prior wave" named two sets nobody can
  // enumerate.
  assert.match(slice, /unit is the PR/, "the guard's unit is no longer the PR");
  assert.match(
    slice,
    /no implementer waves/,
    "the guard no longer says why the wave is not a usable unit — it comes back otherwise",
  );

  // Runnable, not merely named. `compute-spend.mjs` is a pure module: no
  // shebang, no process.argv, no main — running it prints nothing and exits 0,
  // which reads as "no spend recorded". `board.mjs build` emits it at `.spend`
  // (compute-board.mjs's `spend: inputs.spend ?? null`). The doesNotMatch is
  // over a verified-zero baseline and needs the positive companion above it to
  // stay meaningful.
  assert.match(slice, /board\.mjs build/, "the guard no longer names a runnable way to read spend");
  assert.doesNotMatch(
    slice,
    /compute-spend\.mjs/,
    "the guard points at compute-spend.mjs, which has no CLI — it exits 0 printing nothing",
  );

  // Normative, not advisory. Rewriting the lead to "Optional, if you are curious
  // … you may compare" leaves every other assertion here green, and this repo
  // runs prose-compression passes that hedge exactly that way.
  assert.match(slice, /^\*\*Guard: /, "the guard is no longer stated as an imperative");
  assert.doesNotMatch(
    slice,
    /\bOptional\b|\byou may\b/i,
    "the guard has been downgraded to advice — an optional guard is not a guard",
  );

  // A threshold, or "either climbs" fires on the first noisy pair or never.
  assert.match(
    slice,
    /at least\s+three `class=routine` PRs/,
    "the guard no longer states a minimum sample, so one PR's findings can trigger a revert",
  );
  // Findings/fix-rounds are the counter-signal: reviews run 3-5x LONGER than
  // implementation, so an extra fix-round costs a wave slot. A guard on spend
  // alone measures the wrong side.
  assert.match(
    slice,
    /one extra fix-round costs a wave slot/,
    "the guard measures spend without the fix-round cost that would eat the saving",
  );
  // The revert UNIT. `/revert/` alone stays green through "revert the rule",
  // which is the wholesale revert this sentence exists to forbid.
  assert.match(
    slice,
    /revert \*\*`class=routine`\*\*/,
    "the guard no longer scopes the revert to the affected class",
  );
  // The first run under the rule has no top-tier PRs to compare against, so the
  // guard reads clean by construction. Unstated, that silence reads as a pass.
  assert.match(
    slice,
    /never read the guard's silence as a pass/i,
    "the guard no longer warns that its first-run silence is a missing baseline, not a pass",
  );
});

test("phase 3 owns the guard — otherwise nothing in the event loop ever runs it", () => {
  // The guard lives in phase 2, which is entered per-dispatch, BEFORE the PRs it
  // wants to measure exist. Phase 3's event table is what the controller actually
  // reacts to, so the guard needs a row there or it is unreachable by design.
  const slice = section(RUN_TEAM, "- **Pool empty**", "**Own the CI waits.", "run-team phase 3 pool-empty event");
  assert.match(
    slice,
    /tier\s+guard/,
    "no phase 3 event dispatches the tier guard — it is stated in phase 2 and never reached",
  );
});
