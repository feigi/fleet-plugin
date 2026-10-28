// #239. `decided?` is a correct test that was running in the wrong seat.
// `review-and-fix.md` step 5 sent the FILER to `run-team/SKILL.md` phase 0's
// criterion, importing phase 0's cost model — where implementer divergence
// costs a claim, a worktree and a dispatch — into a seat where divergence costs
// one PR review the maintainer already runs. Same test, two seats, opposite
// correct answers. The ruling and its reasoning are ADR 0001.
//
// #3171 (ADR 0032) superseded ADR 0001's filing bar: every issue the plugin
// creates is filed `needs-triage`, and only triage sets `ready-for-agent`. The
// seat split stands — step 5 still never applies phase 0's `decided?` test —
// but the filing-time side of it is now that rule, not "is the defect
// confirmed", and the step-5 and phase-0 pins below hold the new rule. ADR
// 0001's own guard pins further down hold the record as ruled.
//
// What this pins is the SPLIT, which lives in the join between two documents
// read by two different agents. Neither file is wrong on its own after a
// revert: step 5 can go back to delegating and phase 0 will still be a
// perfectly good consumption gate, and nothing else in the tree notices. That
// is why the pin is here rather than inside either file's existing suite.
//
// Slices are flattened. `run-team/SKILL.md` hard-wraps at ~80 columns, so every
// literal space in these phrases may be a newline plus indent; `review-and-fix.md`
// authors one long line per step today, which makes `flat()` a no-op there
// until the day someone wraps it. Reflow-brittleness is a class defect in this
// repo's prose pins, so both are flattened whether or not a width reds today.
//
// CEILING: presence and adjacency over bounded slices. These prove the rule is
// stated and that its inverse is not; they cannot prove a later sentence in the
// same slice does not carve out an exception.
//
// Measured as of this commit, on an isolated copy of the four files: 12 semantic
// mutations — both label branches inverted, the torn tie-break deleted and
// exception-spliced, the delegation restored, the gate sentence deleted and
// stripped of its seat pricing, the ADR pointer renamed on one side, the guard
// floor and trigger each retuned, complements swapped to supersedes, and the
// apply/label roles swapped — each reddened its own pin and no other. Nine
// controls stayed green: the gate paragraph rewrapped at 70/100/140 and by
// `fmt(1)`, the guard bullets and step 5 rewrapped, an unpinned step-5 sentence
// reworded, and an ADR heading reworded. Re-derive after any edit to these
// slices; a rationale indexed to wording rots with the wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const read = (...p) => Pin.file(join(REPO, ...p));
const RUN_TEAM = read("skills", "run-team", "SKILL.md");
const REVIEW_AND_FIX = read("commands", "review-and-fix.md");
const ROOT = join(import.meta.dirname, "..");
const readRoot = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const flat = (s) => s.replace(/\s+/g, " ");

const step5 = () => flat(REVIEW_AND_FIX.between("5. File each deferred finding", "\n6. Diff-check green", "review-and-fix step 5").text);
// Bounded by the two markers that bracket the note, never by the note itself:
// anchoring on the sentence under test turns its deletion into a slicing error
// rather than a failed assertion. The note moved with the rest of phase 1's
// step paragraphs into references/pull.md.
const PULL_MD = read("skills", "run-team", "references", "pull.md");
const decidedNote = () => flat(PULL_MD.between("It does not run a reproduction.", "4. **Collision scan", "references/pull.md decided? note").text);

test("step 5 files every issue needs-triage, a confirmed defect with an open remedy included, with the evidence triage needs", () => {
  const s = step5();
  assert.match(s, Pin.phrase('`gh issue create --label "<needs-triage string>"`'), "step 5's filing command no longer files `needs-triage`");
  assert.match(
    s,
    Pin.phrase("**Every issue you create is labelled `needs-triage`; only triage sets `ready-for-agent`**"),
    "step 5 no longer states that every issue it creates is `needs-triage` and only triage sets `ready-for-agent`",
  );
  // The MAPPING, not the label. Both label strings occur in this slice, so a
  // pin on `needs-triage` alone stays green with the branch pointed back at
  // `ready-for-agent`. `ready-for-agent` is excluded from the gap and `[^.]`
  // keeps the match inside one sentence.
  assert.match(
    s,
    /a confirmed defect with the remedy still open(?:(?!ready-for-agent)[^.])*?files `needs-triage`/,
    "step 5 no longer files a confirmed defect with an open remedy `needs-triage`",
  );
  // The superseded mapping, ADR 0001's bar, and any relabel up to it.
  assert.doesNotMatch(s, /confirmed defect with the remedy still open(?:(?!needs-triage)[^.])*?ready-for-agent/i, "step 5 sends a confirmed defect with an open remedy to `ready-for-agent` again");
  assert.doesNotMatch(s, /--label <?ready-for-agent|--add-label ready-for-agent/, "step 5 files or relabels an issue to `ready-for-agent` again");
  // What triage reads to decide, required in the body.
  assert.match(
    s,
    Pin.phrase("**The body also carries the evidence triage needs: the refuter's verdict — the `verdictPath` reason, or the review's votes — and the candidate remedy.**"),
    "step 5 no longer requires the refuter's verdict and the candidate remedy in the filed issue's body",
  );
  // The rule's pre-chosen guard: floor and trigger as one span, so neither is
  // retuned alone.
  assert.match(
    s,
    Pin.phrase("open `needs-triage` issues citing `Deferred from PR` above 40 on 3 consecutive run dates send the filing rule back to the maintainer"),
    "step 5 lost the guard on its filing rule, or its floor or trigger moved",
  );
});

// Duty 2's paragraph moved, with its war story, to references/finisher.md; the
// finisher's agent body states the rule, and run-team's SKILL.md no longer
// restates it.
const FINISHER_MD = read("skills", "run-team", "references", "finisher.md");
test("finisher duty 2 files the way step 5 does, needs-triage, and lands a duplicate as a comment", () => {
  assert.match(
    read("agents", "fleet-finisher.agent.md").text,
    Pin.phrase("**Confirm every deferral — and every claimed APPLY — has a home that outlives the merge.**"),
  );
  const d = flat(FINISHER_MD.section("## Duty 2: every deferral, and every claimed APPLY, has a home that outlives the merge", "references/finisher.md duty 2").text);
  assert.match(d, Pin.phrase("labelled `needs-triage` as every issue the plugin creates is"), "finisher duty 2 no longer files `needs-triage`");
  assert.match(d, Pin.phrase("A duplicate is a comment citing that verdict on the existing issue, never a relabel"), "finisher duty 2 no longer lands a duplicate as a comment");
  assert.match(d, Pin.phrase("Only triage sets `ready-for-agent`"), "finisher duty 2 no longer reserves `ready-for-agent` to triage");
  assert.doesNotMatch(d, /--add-label ready-for-agent|--label ready-for-agent/, "finisher duty 2 files or relabels an issue to `ready-for-agent`");
});

test("step 5 states its own bar instead of delegating to phase 0's criterion", () => {
  const s = step5();
  // The positive companion. A bare negative on `decided?` would be vacuous here
  // by construction — step 5 names the test deliberately, in order to rule it
  // out — so what is pinned is the sentence that rules it out.
  assert.match(
    s,
    Pin.phrase("Do **not** reach for phase 0's **decided?** test here."),
    "step 5 no longer tells the filer to leave phase 0's `decided?` test alone",
  );
  // The superseded delegation, verbatim from the text 6d0c1f6 replaced.
  // Verified zero occurrences in the current file.
  assert.doesNotMatch(
    s,
    Pin.phrase("read the criterion there rather than re-deriving it here"),
    "step 5 delegates the label choice back to phase 0 — the two seats have re-collided",
  );
});

test("phase 0 marks decided? as a consumption gate and states the filing-time rule inline", () => {
  const s = decidedNote();
  // Contiguous span again: "consumption gate" and the filing-time rule pin
  // nothing apart. The gate label is only meaningful bound to
  // the seat it is priced for and to the counterpart that is priced differently.
  assert.match(
    s,
    Pin.phrase(
      "**This is a consumption gate**, priced for the seat where implementer divergence costs a claim, a worktree and a dispatch; at filing time every issue the plugin creates is filed `needs-triage`, and only triage sets `ready-for-agent`.",
    ),
    "phase 0's `decided?` note no longer marks it a consumption gate whose filing-time counterpart files every issue `needs-triage`",
  );
  // The shipped skill states the bar inline and does not point into `docs/adr/`,
  // which is not shipped to the plugin's consumers (ADR 0019).
  assert.doesNotMatch(s, /docs\/adr\//, "phase 0's `decided?` note points into `docs/adr/`, which the plugin does not ship");
});

test("the ADR keeps its pre-chosen guard and its #211 relationship", () => {
  const adr = flat(readRoot("docs", "adr", "0001-filing-label-bar-is-defect-confirmed.md"));
  // Floor and trigger as one span. Chosen before any data, on the tier guard's
  // precedent, so that a later run cannot derive a threshold that happens to
  // clear the number in front of it. Separate pins would let either be retuned
  // alone.
  assert.match(
    adr,
    Pin.phrase(
      "**Floor:** 20 deferrals filed across at least 3 distinct run dates after this decision lands. - **Trigger:** `needs-triage` still taking more than half of them.",
    ),
    "the ADR's guard floor or trigger moved — a pre-chosen guard that is retuned later is not a guard",
  );
  // The conflation this ADR exists to stop, pinned in both halves: the verdict
  // and the division of labour it rests on. Swapping `applied` and `labelled`
  // reds the second while the first stays green, so both are asserted.
  assert.match(
    adr,
    Pin.phrase("This decision **complements #211 and does not supersede it.**"),
    "the ADR no longer states that it complements #211 rather than superseding it",
  );
  assert.match(
    adr,
    Pin.phrase("#211 governs what gets **applied**; this governs what gets **labelled**"),
    "the ADR no longer separates #211's apply policy from this decision's label policy",
  );
});

test("ADR 0032 supersedes ADR 0001 and keeps its pre-chosen guard", () => {
  const adr = flat(readRoot("docs", "adr", "0032-every-issue-files-needs-triage.md"));
  assert.match(adr, Pin.phrase("Supersedes ADR 0001."), "ADR 0032 no longer records that it supersedes ADR 0001");
  assert.match(adr, Pin.phrase("**Every issue the plugin creates is filed `needs-triage`. Only triage sets `ready-for-agent`.**"), "ADR 0032 lost its decision");
  // Floor and trigger as one span, chosen before any data: separate pins would
  // let either be retuned alone.
  assert.match(
    adr,
    Pin.phrase("- **Floor:** more than **40** open `needs-triage` issues citing `Deferred from PR` in the body. - **Trigger:** above the floor on **3 consecutive** run dates."),
    "ADR 0032's guard floor or trigger moved — a pre-chosen guard that is retuned later is not a guard",
  );
  const adr1 = flat(readRoot("docs", "adr", "0001-filing-label-bar-is-defect-confirmed.md"));
  assert.match(adr1.slice(0, adr1.indexOf("## Context")), Pin.phrase("Superseded by ADR 0032"), "ADR 0001's Status line no longer names ADR 0032 as superseding it");
});

// #839. ADR 0001's guard pre-chose a floor and a trigger but never said WHICH
// POPULATION the trigger measures — open issues only, or open and closed
// together. Both readings are available from the same text and they do not
// agree: a refuted deferral filed as `needs-triage` and later closed is in the
// denominator under one and absent under the other. An undefined input surface
// hands back exactly the discretion a pre-chosen guard exists to remove — the
// evaluator picks the population and the population picks the verdict.
//
// Ruled open AND closed on #839. The reason is pinned WITH the ruling, in one
// contiguous span, because a bare ruling is re-derivable against itself: a later
// reader who finds open-only more convenient can restore it from a text that
// never says why it was rejected. Same reason the pre-chosen-guard test pins
// the floor and the trigger as one span rather than two.
//
// CEILING: presence and contiguity over one bounded section. This proves the
// clause is stated and that its reason travels with it; it cannot prove a
// sentence elsewhere in the ADR does not carve out an exception.

// The ruling and its reason as ONE phrase, wrap-tolerant. Reworded on purpose →
// update this string. Do not delete the pin to clear the red.
const POPULATION = Pin.phrase(
  "**Population:** open **and** closed issues together, never open alone. The trigger measures filing behaviour, and a refuted deferral filed as `needs-triage` and later closed counts under one reading and vanishes under the other — so under open-only any triage pass that reads the backlog improves the ratio without one filing having changed. A guard on the filing bar must not be satisfiable by triaging the queue.",
);
// The population made operational. A prose ruling the evaluator's own command
// contradicts is not a ruling, and `--state all` is the single token that
// carries it.
const STATE_ALL = Pin.phrase("--state all");
// The as-of duty. Per this ADR's own rule, a count off an append-only tracker
// rots on the next filing, so the date the count was taken is part of the count.
const AS_OF = Pin.phrase("record the date taken with the verdict");

// Presence alone doesn't defend a pin: a mutant can wrap the matched span in
// markdown strikethrough or drop a negating sentence right after it, and a
// bare `.test()` still finds every pinned word in order. Bound the match's own
// surroundings too, not just its content.
const notNeutralized = (s) => {
  const m = s.match(POPULATION);
  if (!m) return true; // population pin already reports the clause missing; don't double-fire
  const before = s.slice(Math.max(0, m.index - 5), m.index);
  const after = s.slice(m.index + m[0].length, m.index + m[0].length + 200);
  return !/~~/.test(before + after) && !/Superseded/i.test(after);
};

const guardPins = {
  population: (s) => !POPULATION.test(s),
  stateAll: (s) => !STATE_ALL.test(s),
  asOf: (s) => !AS_OF.test(s),
  notNeutralized: (s) => !notNeutralized(s),
};
const guardFiring = (s) => Object.keys(guardPins).filter((n) => guardPins[n](s));

test("the guard names the population its trigger measures, and why", () => {
  const s = flat(Pin.of(readRoot("docs", "adr", "0001-filing-label-bar-is-defect-confirmed.md"), "ADR 0001").section("## The guard — floor and trigger, chosen before any data", "ADR 0001 guard section").text);
  // Positive control against a vacuous slice: a stale anchor matching almost
  // nothing would still satisfy a doesNotMatch and assert nothing.
  assert.ok(s.length > 200, "the guard slice is shorter than its own heading and bullets — the extractor is broken, not the ADR wrong");
  assert.deepEqual(guardFiring(s), [], "the guard's population clause, its `--state all` count, or its as-of duty is gone");
});

// The refuse direction: each fixture asserts it changed the document before it
// is scored, because a fixture that applies nothing is green in exactly the way
// a pin that does not bite is green.
const guardMutants = [
  ["the population is flipped to open-only", ["population"],
    (t) => t.replace(Pin.phrase("open **and** closed issues together, never open alone"), "open issues only, never the closed ones")],
  ["the ruling survives but its reason is stripped", ["population"],
    (t) => t.replace(Pin.phrase("The trigger measures filing behaviour, and a refuted deferral filed as `needs-triage` and later closed counts under one reading and vanishes under the other — so under open-only any triage pass that reads the backlog improves the ratio without one filing having changed. A guard on the filing bar must not be satisfiable by triaging the queue."), "Count them all.")],
  ["the count command is narrowed to open issues", ["stateAll"],
    (t) => t.replace(Pin.phrase("--state all"), "--state open")],
  ["the as-of duty is dropped", ["asOf"],
    (t) => t.replace(Pin.phrase("and record the date taken with the verdict"), "and read it off the tracker")],
  ["the population clause is struck through and marked superseded", ["notNeutralized"],
    (t) => t.replace(POPULATION, (m) => `~~${m}~~ Superseded: use open issues only, it is simpler to compute.`)],
];

for (const [what, expected, mutate] of guardMutants) {
  test(`the guard pins redden when ${what}`, () => {
    const adr = readRoot("docs", "adr", "0001-filing-label-bar-is-defect-confirmed.md");
    const mutated = mutate(adr);
    assert.notEqual(mutated, adr, `the "${what}" fixture no longer matches the guard section and applied nothing — update the fixture, do not delete it`);
    assert.deepEqual(guardFiring(flat(Pin.of(mutated, "mutated").section("## The guard — floor and trigger, chosen before any data", "ADR 0001 guard section").text)), expected, `the "${what}" fixture did not fire exactly the pins it is here to exercise`);
  });
}

test("rewrapping the guard section and editing it elsewhere stays green", () => {
  // The accept direction. A pin that reds on any edit to the section has
  // discriminated nothing and gets deleted by whoever next reflows this file.
  const adr = readRoot("docs", "adr", "0001-filing-label-bar-is-defect-confirmed.md");
  const section = Pin.of(adr, "adr").between("## The guard — floor and trigger, chosen before any data", "\n## Relationship to #211", "ADR 0001 guard section").text;
  const benign = adr.replace(section, () =>
    section
      .replace(/\n(?! *[-*] )(?! *```)/g, " ")
      .replace("When the guard fires, its verdict lands on `main`.", "When the guard fires, its verdict lands on `main` before the next run starts."));
  assert.notEqual(benign, adr, "the benign-edit fixture no longer matches the guard section — update it");
  assert.deepEqual(guardFiring(flat(Pin.of(benign, "benign").between("## The guard — floor and trigger, chosen before any data", "\n## Relationship to #211", "ADR 0001 guard section").text)), [], "a reflow plus an unrelated edit reddened a guard pin — the pins are over-tight, not the ADR wrong");
});
