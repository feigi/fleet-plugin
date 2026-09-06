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
// does the work. One slice per paragraph, never per phase: widen a slice to its
// phase and a neighbouring paragraph satisfies the pin on its own. Measured on
// phase 0 — delete step 4's `**correction-ticket discipline**` sentence and the
// pin on that phrase below stays green regardless, on step 6's "which tickets
// carry the correction-ticket discipline" alone.
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
  section(RUN_TEAM, "**Dispatch every implementer", "**Guard: accumulate per PR", "run-team phase 2 dispatch rule");
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
  // nothing failed. The window spans sentences rather than one, because the
  // stated reason for the one-sentence bound is false OF THIS SLICE: step 4
  // holds ZERO `sonnet` occurrences, and every past-tense mention the bound was
  // guarding against (L224, L235, L303, L304, L314) lives in the `dispatch` and
  // `guard` slices, which this pin does not cover. Measured: under the old
  // bound a restoration split across two sentences escaped the whole suite at
  // 725/725; [\s\S]{0,400} reds it and leaves the clean tree green. Neither is
  // the ORDER assumed — a restoration reading "`sonnet` is what `class=routine`
  // tickets dispatch at" binds the class just as squarely and walks straight
  // through the forward-only form, so both directions are scanned.
  assert.doesNotMatch(
    slice,
    /`class=routine`[\s\S]{0,400}`sonnet`|`sonnet`[\s\S]{0,400}`class=routine`/,
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

// The slicing rationale at the top of this file is measured on step 6's copy of
// this phrase. Nothing else pins that copy, so losing it would leave the
// rationale asserting a reason the tree no longer carries — which is exactly how
// the line count it replaced went stale. Fail here instead.
test("phase 0 step 6 still carries the phrase the slicing rationale is measured on", () => {
  const slice = section(RUN_TEAM, "6. Present survivors as a multi-select", "Never put two sequenced tickets", "run-team phase 0 step 6");
  assert.match(
    slice,
    /which tickets carry the\s+\*{0,2}correction-ticket\*{0,2}\s+discipline/,
    "step 6 dropped the phrase the slicing rationale cites — re-measure and update the comment at the top of this file",
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
  // The revert is dated and attributed, or the next reader takes the missing
  // tier for an omission and helpfully restores it. Pinned BEFORE the scan
  // below, whose exemption is the SPAN this note occupies: a reworded note has
  // to be diagnosed as a reworded note, or the scan reports it as a restored
  // binding and sends the reader hunting a rebinding nobody made.
  assert.match(
    slice,
    /REVERTED on 2026-08-16/,
    "phase 2 no longer records WHEN and WHY the tier binding was removed",
  );
  // THE POSITIVE SHAPE PIN (#553). The pin above only checks the phrase is
  // PRESENT somewhere in the slice, so a restoration clause written INSIDE
  // the note — keeping "was REVERTED on 2026-08-16" intact — still satisfies
  // it, then rides the scan's note exemption below to green: that exemption
  // drops every hit starting inside the note's span, whatever else the hit
  // says. Pin the note's own shape instead of slicing the note out before the
  // scan (the rejected remedy — a larger change, not needed once the shape
  // itself is pinned). Isolated to the bold span itself, not the whole slice,
  // so a present-tense rebinding written anywhere else in THIS DISPATCH SLICE
  // stays the rebindings scan's job below. Not "anywhere in phase 2": the
  // `## Phase 2` heading is far wider than this paragraph, and the guard
  // paragraph inside it has no rebindings scan of its own — this file holds
  // exactly one.
  //
  // This doc's own convention grounds the shape: a dated note states one
  // action on one date (comment above — "dated and attributed"), so a
  // restoration smuggled inside it either introduces a further date (when the
  // restoration happened) or names the state the binding is restored TO.
  // Settled against a single edit to this note — appending "and is RESTORED
  // on 2026-08-18, so routine members dispatch at `sonnet` again." — both
  // checks below fire and name the note, not the scan; a reflow or a
  // past-tense-only reword of the same note trips neither.
  const revertNote = /\*\*`class=routine` → `sonnet` was REVERTED on [\s\S]*?\*\*/.exec(slice)?.[0];
  assert.ok(
    revertNote,
    "the revert note's opening clause changed shape enough that this pin can no longer find it — read the slice and update the anchor",
  );
  assert.equal(
    (revertNote.match(/\d{4}-\d{2}-\d{2}/g) ?? []).length,
    1,
    "the revert note now names more than one date — a restoration is hiding inside the note whose span the rebindings scan exempts",
  );
  // ponytail: catches the measured restoration and any dated repeat of it,
  // plus the specific verb this doc's own restorations are written with; a
  // same-day, dateless restoration phrased without "restored" is a narrower
  // gap in the same family the guard test's hedge-word list already accepts
  // (#476) — widen only on a second measured miss.
  assert.doesNotMatch(
    revertNote,
    /\bRESTORED\b/i,
    "the revert note now says the binding is RESTORED — a restoration is hiding inside the note whose span the rebindings scan exempts",
  );
  // THE NEGATIVE, half two of two. See the step-4 companion: the binding was
  // stated independently in both places, so restoring either one alone is
  // undetectable without a pin on each. Nothing is assumed between the two
  // tokens — not the arrow, not a verb, not the backticks around `sonnet` —
  // because the `class=routine` → `model: "sonnet"` literal this used to require
  // is only one spelling of the restoration. Measured: `→ `sonnet``, "now
  // resolves to", and `model:'sonnet'` each re-bind the class in the file's own
  // vocabulary and each walked straight through the literal form. The one
  // legitimate statement of the binding in this slice is the past-tense revert
  // note, exempted by the SPAN it occupies rather than by narrowing the pattern
  // back to a literal — a narrower pattern is what let the half-revert through.
  // Exempting on the phrase "was REVERTED" instead was measured to swallow a
  // live restoration written AFTER the note that quoted that phrase in its own
  // sentence: the hit began past the note's end and was dropped anyway, because
  // the filter read the hit's words rather than where it sat. A span cannot be
  // quoted. The ORDER is not assumed either, for the same reason the arrow is
  // not: the mirrored sentence states the same binding and matched nothing at
  // all.
  const noteAt = slice.indexOf(revertNote);
  const rebindings = [
    ...slice.matchAll(/`class=routine`[^.]{0,120}sonnet[^.]{0,40}|sonnet[^.]{0,120}`class=routine`[^.]{0,40}/g),
  ];
  assert.deepEqual(
    rebindings.filter((hit) => hit.index < noteAt || hit.index >= noteAt + revertNote.length).map((hit) => hit[0]),
    [],
    "phase 2 states a `class=routine` → `sonnet` binding outside the past-tense revert note — the reverted rule is back",
  );
  // Anchored to the omission, not the word "inherit": the tier is obtained by
  // NOT passing `model`, and "implementers run at the session tier" with no
  // mechanism is exactly the instruction-names-no-mechanism defect the skill's
  // own tooling-fix triggers list calls out.
  assert.match(
    slice,
    /dispatched with `model` set does not get the declared\s+tier back/,
    "phase 2 no longer says HOW the declared tier is obtained — omitting `model` is still the mechanism",
  );
  // The omission resolves to the DEFINITION's tier first and the session's only
  // after. Stated without that ordering, "omit `model`" reads as "inherit the
  // session", which is what the declaration was written to stop being true.
  assert.match(
    slice,
    /session's tier applies only when the definition\s+names none/,
    "phase 2 states the omission mechanism without saying the definition's tier wins first",
  );
  // The dispatch rule has to NAME the definition, or the tier is declared
  // somewhere the reader of this phase can neither find nor audit.
  assert.match(
    slice,
    /subagent_type: "fleet-implementer"/,
    "phase 2 no longer dispatches the declared subagent type",
  );
  assert.match(
    slice,
    /agents\/fleet-implementer\.agent\.md/,
    "phase 2 no longer says WHERE the declared tier lives",
  );
  // `name` is orthogonal to `subagent_type` and is what confers team membership
  // and the Agent tool; both the spend classifier and member-outcomes.mjs read
  // it. A rewrite that swaps the name for the type silently unmakes the member.
  assert.match(
    slice,
    /Keep `name: impl-<N>`/,
    "phase 2 no longer keeps the impl-<N> name alongside the subagent type",
  );

  // A lost class no longer misprices anything, but it still costs the correction
  // discipline — so the recording rule has to survive the revert, and has to say
  // what is actually lost or it reads as bookkeeping and gets dropped.
  assert.match(
    slice,
    /\*\*No class recorded → record `class=unknown`, never a guess\.\*\*/,
    "a missing class is no longer recorded as `class=unknown` — the gap goes invisible",
  );
  // Anchored to "still costs the", not bare: the phrase occurs TWICE in this
  // slice — here, and incidentally in the REVERTED paragraph above ("it still
  // governs the correction-ticket discipline"). Measured: an unanchored
  // /correction-ticket discipline/ stayed green with this sentence's cost
  // clause gutted, because the other copy satisfied it on its own. It pinned
  // the phrase's existence somewhere in the slice, never the recording rule.
  assert.match(
    slice,
    /still costs the \*\*correction-ticket discipline\*\*/,
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
  // stay meaningful. Case-sensitive on purpose, and ruled so twice (#529): the
  // file on disk is lowercase and so is every reference to it, so an `i` flag
  // would pin a spelling nothing in the repo can write. Settled with
  // `grep -rio compute-spend --exclude-dir=.git . | grep -v ':compute-spend$'`,
  // which is empty.
  assert.match(slice, /board\.mjs build/, "the guard no longer names a runnable way to read spend");
  assert.doesNotMatch(
    slice,
    /compute-spend\.mjs/,
    "the guard points at compute-spend.mjs, which has no CLI — it exits 0 printing nothing",
  );

  // Normative, not advisory. This repo runs prose-compression passes that hedge
  // exactly that way.
  //
  // A `/^\*\*Guard: /` pin sat here and was DELETED as a tautology (#529) — do
  // not restore it on finding the guard heading unpinned. `section()` returns
  // `source.slice(indexOf(startAnchor), end)`, so the slice opens with this
  // block's start anchor whatever the end anchor is, and that regex carried no
  // `m` flag: the start anchor alone satisfied it. A lead that breaks it breaks
  // the anchor too, so `section()` reds first, under its own message.
  //
  // Settled by mutation, not argument. Replace the guard lead's
  // `never conclude inside one run.**` with `never conclude inside one run —
  // advisory, at your discretion, skip when time is short.**` in
  // run-team/SKILL.md — the start anchor survives — then run
  // `node --test skills/fleet/scripts/*.test.mjs`: the suite stays green and
  // the deleted pin's message appears nowhere in the output. Quote that whole
  // span, not the `one run.**` tail: the tail is not unique in that SKILL, and
  // its other hit is the `**Why not decide inside one run.**` heading that
  // member-outcomes-prose.test.mjs uses as a `section()` end anchor — a global
  // replace on the tail reds THAT suite, which reads as the deleted pin
  // catching the hedge. Restore with `cp`, never `git checkout --`.
  //
  // That green is the gap tracked on #1111. The hedges below are enumerated by
  // word and the reworded lead uses none of them; widening the list is ruled
  // out there, because that instrument was measured failing (#476).
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

// ---------------------------------------------------------------------------
// THE DECLARATION ITSELF. Every pin above reads SKILL.md, so a tier changed in
// `agents/fleet-implementer.agent.md` leaves all of them green while the
// dispatched tier flips — the same silent drift they exist to catch, routed
// around the document they read. That hazard is why the declaration arrived
// with these three.
const frontmatterOf = (name) =>
  readFileSync(join(REPO, "agents", `${name}.agent.md`), "utf8").split("---")[1] ?? "";

test("the implementer definition declares BOTH a model and an effort", () => {
  // Declaring one leaves the other inherited from whatever session dispatched
  // the member, which is the ambiguity the declaration exists to remove — and
  // frontmatter is the ONLY place the pair can be stated, because the Agent tool
  // takes `model` and has no effort parameter at all.
  const fm = frontmatterOf("fleet-implementer");
  assert.match(fm, /^model:\s*\S+$/m, "the implementer definition declares no model");
  assert.match(fm, /^effort:\s*\S+$/m, "the implementer definition declares no effort");
});

test("the declared model is a bare alias, never a pinned version", () => {
  // A pinned id rots into a superseded generation that is weaker AND dearer:
  // pricing falls with each generation, so an older Opus is not the cheap
  // option it looks like. The alias tracks the newest.
  const model = /^model:\s*(\S+)$/m.exec(frontmatterOf("fleet-implementer"))?.[1];
  assert.ok(["opus", "sonnet", "haiku"].includes(model), `pinned version: ${model}`);
});

test("the definition lists no tools — a list would drop the Agent tool", () => {
  // references/member-lifecycle.md's "The name is what carries the `Agent`
  // tool" — a `tools:` list that omits `Agent` costs
  // the member its delegation, silently and with no error. Omit the key.
  assert.doesNotMatch(frontmatterOf("fleet-implementer"), /^tools:/m);
});
