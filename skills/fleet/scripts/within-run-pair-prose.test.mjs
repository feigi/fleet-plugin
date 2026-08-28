import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #864's finding is that tier is entangled with calendar date and therefore
// with prompt evolution — 8 of 9 sonnet rows in one week, 23 of 24 opus rows in
// the next. Dispatching one implementer per wave at the alternate tier makes
// tier orthogonal to date BY CONSTRUCTION, which is the only thing that lets
// the accumulated rows ever answer the question they are collected for.
//
// This is the one part of the change that costs something on every run, so it
// is also the part a compression pass is likeliest to quietly drop. These pins
// are what notices.
//
// `section()` is duplicated from implementer-model-tier.test.mjs rather than
// shared — the repo already keeps two copies of these seven lines and nothing
// detects drift between them. A third module would be the first abstraction
// nobody asked for.
const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

function section(startAnchor, endAnchor, label) {
  const at = RUN_TEAM.indexOf(startAnchor);
  assert.notEqual(at, -1, `${label}: '${startAnchor}' moved — update this test`);
  const end = RUN_TEAM.indexOf(endAnchor, at + startAnchor.length);
  assert.notEqual(end, -1, `${label}: '${endAnchor}' moved — update this test`);
  return RUN_TEAM.slice(at, end);
}

// Paragraph-tight, and deliberately NARROWER than the dispatch slice in
// implementer-model-tier.test.mjs: widened to the phase, the tier-guard
// paragraphs below would satisfy half of these pins on their own.
const dispatch = () =>
  section("**Dispatch every implementer", "**`class=routine`", "run-team phase 2 dispatch rule");

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
  assert.notEqual(
    field("model", "fleet-implementer-alt"),
    field("model", "fleet-implementer"),
    "the alternate definition names the same model as the default — the pair compares nothing",
  );
});
