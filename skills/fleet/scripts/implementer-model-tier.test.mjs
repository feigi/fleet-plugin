import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Implementers dispatch at `sonnet` unless the ticket is a correction ticket.
// The rule is prose in one file and rots the expensive way: drop the phase-0
// class judgement and phase 2 has nothing to read, so every member falls to the
// default branch — no error, no crash, just the bill and a protected class
// running cheap. Nothing outside this file catches that; the fleet never reads
// back the model it dispatched at (board.mjs parses `message.usage` off the
// subagent JSONL and drops `message.model` on the same line).
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
  section(RUN_TEAM, "**Dispatch at the tier phase 0 classed", "**Guard: accumulate per PR", "run-team phase 2 dispatch rule");
const guard = () =>
  section(RUN_TEAM, "**Guard: accumulate per PR", "One named member per ticket", "run-team phase 2 tier guard");

test("phase 0 step 4 binds each ticket class to its tier, in the read it already pays for", () => {
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
  // The other half of the binding. `sonnet` appears three times in the file, so
  // a bare /sonnet/ says nothing about WHICH class gets it.
  assert.match(
    slice,
    /`class=routine`(?:(?!correction)[^.])*?`sonnet`/,
    "step 4 no longer routes the default class to `sonnet`",
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

test("phase 2 dispatches on the recorded class, and a missing class falls to the SAFE tier", () => {
  const slice = dispatch();

  // Both bindings, each excluding the competing class from the gap. Swapping the
  // two rules leaves every token present and reds both of these.
  assert.match(
    slice,
    /`class=routine` →\s*`model: "sonnet"`/,
    "phase 2 no longer dispatches `class=routine` at `model: \"sonnet\"`",
  );
  // Anchored to the omission, not the word "inherit": the correction class gets
  // top tier by NOT passing `model`, and "correction tickets run at top tier"
  // with no mechanism is exactly the instruction-names-no-mechanism defect the
  // skill's own tooling-fix triggers list calls out.
  assert.match(
    slice,
    /`class=correction` →\s*\*\*omit `model`\*\*/,
    "phase 2 no longer says HOW a correction ticket gets top tier — omitting `model` is the mechanism",
  );
  // The omission only reaches the session tier when the subagent type carries no
  // model of its own; two pr-review-toolkit agents in this repo pin `model: opus`
  // in frontmatter, so the precondition is not hypothetical.
  assert.match(
    slice,
    /no `model:` frontmatter/,
    "phase 2 states the omission mechanism without its precondition",
  );

  // THE DEFAULT DIRECTION. `sonnet` is the structural complement of "correction",
  // so absent an explicit rule a lost class dispatches cheap — stripping the tier
  // from the one class that exists to keep it. Pin that missing → omit, and pin
  // the negative separately: /omit `model`/ alone stays green if a later sentence
  // adds a sonnet fallback.
  assert.match(
    slice,
    /\*\*No class recorded → omit `model`/,
    "a missing class no longer falls back to the safe tier — it silently dispatches cheap",
  );
  assert.match(
    slice,
    /Never\s+`sonnet`/,
    "phase 2 no longer forbids the cheap tier on a missing class",
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
