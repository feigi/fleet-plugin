import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between as section } from "./prose-pin.mjs";

// #864's finding is that tier is entangled with calendar date and therefore
// with prompt evolution — 8 of 9 sonnet rows in one week, 23 of 24 opus rows in
// the next. Dispatching one implementer per wave at the alternate tier makes
// tier orthogonal to date BY CONSTRUCTION, which is the only thing that lets
// the accumulated rows ever answer the question they are collected for.
//
// This is the one part of the change that costs something on every run, so it
// is also the part a compression pass is likeliest to quietly drop. These pins
// are what notices.
const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Paragraph-tight, and deliberately NARROWER than the dispatch slice in
// implementer-model-tier.test.mjs: widened to the phase, the tier-guard
// paragraphs below would satisfy half of these pins on their own.
const dispatch = () =>
  section(RUN_TEAM, "**Dispatch every implementer", "**`class=routine`", "run-team phase 2 dispatch rule");

test("phase 2 dispatches exactly one alternate-tier implementer per wave", () => {
  const slice = dispatch();
  assert.match(slice, /fleet-implementer-alt/, "phase 2 no longer dispatches the alternate tier at all");
  // The RATE, not just the existence. "Dispatch some at the alternate tier"
  // reproduces the block design the pairing exists to replace.
  //
  // Bound to `alternate tier` inside one sentence, and measured: the unbound
  // /one .{0,80} wave/ this replaces stayed GREEN through exactly that
  // mutation, because the "**Why one per wave and not a week…**" rationale
  // below satisfied it on its own. The rate has to be pinned where the rate is
  // ORDERED, not wherever the two words co-occur. Order is not assumed — the
  // mirrored phrasing binds the same rate.
  assert.match(
    slice,
    /\bone\b[^.]{0,60}\bwave\b[^.]{0,60}alternate tier|alternate tier[^.]{0,60}\bone\b[^.]{0,60}\bwave\b/i,
    "phase 2 no longer orders the rate — one per wave is what makes the pair within-run",
  );
});

test("phase 2 does not tell the alternate member it is a control", () => {
  // A member that knows it is being measured is not measuring the same thing.
  assert.match(
    dispatch(),
    /do not tell the member it is a control/i,
    "phase 2 no longer withholds the control status from the member",
  );
});

test("phase 2 does NOT ask the controller to label the control", () => {
  // A hand-set control column would not survive the metrics file's
  // regeneration, and one derived against today's declared tiers would
  // mislabel every historical row. The pairing is a QUERY over
  // member-outcomes.tsv: a session+role carrying more than one distinct model.
  const slice = dispatch();
  assert.doesNotMatch(
    slice,
    /control=yes|mark .{0,20}control/i,
    "phase 2 asks for a hand-set control label — it cannot survive a regeneration",
  );
  assert.match(
    slice,
    /member-outcomes\.tsv/,
    "phase 2 no longer says where the pairing is recovered from, so the label comes back",
  );
});

test("phase 2 says why the pairing is within-run and not week-by-week", () => {
  // Without the reason, "one per wave" reads as arbitrary overhead and the next
  // cost-trimming pass converts it back into a block design — which is the
  // state #864 documents.
  assert.match(
    dispatch(),
    /confounded with calendar date|confounded with the calendar/i,
    "phase 2 no longer says what within-run pairing buys — the rate reads as arbitrary cost",
  );
});

test("the alternate definition differs from the default in MODEL ONLY", () => {
  // Varying model and effort at once yields a pair that answers neither
  // question. The effort comparison is a later, separate experiment.
  const fm = (n) => readFileSync(join(REPO, "agents", `${n}.agent.md`), "utf8").split("---")[1] ?? "";
  const field = (key, name) => {
    const hit = new RegExp(`^${key}:\\s*(\\S+)$`, "m").exec(fm(name));
    assert.ok(hit, `${name}.agent.md declares no ${key}`);
    return hit[1];
  };
  assert.equal(
    field("effort", "fleet-implementer-alt"),
    field("effort", "fleet-implementer"),
    "the two implementer definitions no longer share one effort — the pair now varies two things",
  );
  // #1343: pinned alongside effort, on the same "shared, not varied" side of
  // the pair — the omp-side key, so a divergence here is the omp analogue of
  // the effort check above. Mutation-tested: setting
  // fleet-implementer-alt.agent.md's `thinking-level` to `high` (leaving
  // fleet-implementer's `xhigh` alone) fails this assertion (`'high' !==
  // 'xhigh'`); reverting the file green again confirms the pin only fires on
  // the real divergence, not on file-read noise.
  assert.equal(
    field("thinking-level", "fleet-implementer-alt"),
    field("thinking-level", "fleet-implementer"),
    "the two implementer definitions no longer share one thinking-level — the omp-side pin now varies two things",
  );
  assert.notEqual(
    field("model", "fleet-implementer-alt"),
    field("model", "fleet-implementer"),
    "the alternate definition names the same model as the default — the pair compares nothing",
  );
});

test("the alternate definition's body is byte-identical to the default's (#1801)", () => {
  // #1801 moved the shared implementer background out of SKILL.md's per-dispatch
  // prompt and into these two agent files' BODIES, on the premise that a member
  // reads its own agent.md body as `§ Role` regardless of which prompt dispatched
  // it (measured on #1777: omp injects the body verbatim, every occurrence). A
  // body that drifts between the two files dispatches two differently-briefed
  // implementers under one shared label, silently — the frontmatter-field pins
  // above read one line each and cannot see a divergence anywhere else in the
  // file. Exact string equality over the whole body is the tightest pin this
  // claim admits: unlike a regex slice, a single added, dropped or reworded
  // byte on either side fails it, and nothing benign can satisfy it by accident.
  const body = (n) => readFileSync(join(REPO, "agents", `${n}.agent.md`), "utf8").split("---")[2] ?? "";
  assert.equal(
    body("fleet-implementer-alt"),
    body("fleet-implementer"),
    "the two implementer definitions' bodies have diverged — #1801's shared background must be pasted identically into both",
  );
});

test("phase 2 binds the rate to phase-0 staging and excludes refills", () => {
  // The rate was expressed in a unit the guard below declares nonexistent for
  // implementers ("refill is level-triggered, so there are no implementer
  // waves"), and the pin above binds the WORDS, not a countable rule. Measured:
  // appending either explicit resolution — "one wave per run; mid-run refills do
  // not start a new wave" and "each refilled slot begins its own wave" — left all
  // five assertions GREEN, and those two readings differ by roughly an order of
  // magnitude in how much of the fleet runs at the alternate tier.
  //
  // So pin the exclusion, which is the half that disambiguates. Both orders, so
  // a legitimate rewording survives.
  const slice = dispatch();
  assert.match(
    slice,
    /never one per refill|no new wave|starts\s+no new wave/i,
    "phase 2 no longer excludes refills from the rate — the count is ambiguous again",
  );
  assert.match(
    slice,
    /phase-0 stag|staged wave/i,
    "phase 2 no longer names phase-0 staging as the unit the rate is counted against",
  );
});

// The difficulty caveat lives in the counter-evidence section, past this file's
// dispatch slice, so it needs its own anchor pair.
const counterEvidence = () =>
  section(RUN_TEAM, "within-run pairing above**", "`minted_false_claim`", "run-team tier-guard counter-evidence");

test("the orthogonality claim is scoped — date only, not difficulty", () => {
  // The claim itself is literally true and narrowly scoped, so this is not a
  // false-claim pin. It is the caveat that goes missing: the alternate member is
  // chosen as the most ordinary ticket and never the hardest, while the top tier
  // absorbs every remaining ticket including all of the hardest. That makes tier
  // SYSTEMATICALLY correlated with difficulty, in a known direction — a different
  // hazard from the "difficulty adds noise" the covariates are elsewhere sold as
  // handling, and the one a reader who trusts "by construction" will skip.
  const slice = counterEvidence();
  assert.match(
    slice,
    /never the hardest/,
    "the counter-evidence section no longer says the alternate tier skips the hardest ticket",
  );
  assert.match(
    slice,
    /difficulty/i,
    "the orthogonality claim no longer names difficulty as the confound it does NOT remove",
  );
  assert.match(
    slice,
    /`sizing`\/`profile`\/`loc`\/`files`|condition a pair comparison/i,
    "the caveat no longer routes the reader to the covariates before reading a pair",
  );
});
