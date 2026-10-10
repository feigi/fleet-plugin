// #2881. A mutation counted as killed on any red exit. Vitest 3.2.x can exit 1
// with 0 failing tests (an unhandled birpc `onTaskUpdate` timeout), and a
// load-sensitive test can fail once in a full suite and pass when run again —
// one consumer run recorded a mutant killed 1 time in 5 whose rerun was green
// 5/5. Both read as a kill wherever a kill was scored off the exit status.
//
// The fix is ONE statement of the rule — Valid red, Narrowed run, Kill and the
// Evidence line — quoted word for word at every site whose instructions score
// a kill or file a failing test. The paragraphs are owned HERE, never read out
// of review-core.mjs, so a reword in one place reds instead of quietly
// becoming the fixture. Each site is read where its instructions live: the
// prompts review-core.mjs actually dispatches (rendered through runReview
// over a scripted host), the two agent definitions, and the two run-team
// briefs the controller pastes verbatim.
//
// THE CEILING (prose-pin.mjs): a negating sentence added beside an intact
// paragraph stays green. The golden fixtures cover that for the run-team
// blocks; nothing does for the agent definitions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, quoteBlock, stripQuoteGutter, unemphasized } from "./support/prose-pin.mjs";
import { runReview, sharedRunNote, DEFAULT_DIMENSIONS } from "../plugin/scripts/review-core.mjs";
import { pipeline, parallel, ARGS, SNAP, review, finding, vote, scriptedHost } from "./support/review-host-fixture.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("plugin", "skills", "run-team", "SKILL.md");
const CONTEXT = read("CONTEXT.md");

const VALID_RED =
  "**Valid red:** a run that completed — the command returned on its own, with no signal and no timeout, deadline or kill having fired — in which the test the claim names is reported failing. An exit ≠ 0 with no failing test is not red, and a different test failing is not red for this claim. A red in the full suite only triggers a narrowed run; it is never evidence on its own.";
const NARROWED =
  "**Narrowed run:** the Test entrypoint with arguments appended, `<testCmd> <args>`. That appended arguments reach the Test entrypoint is all that is promised about them, so a narrowed run counts only if it reports `tests` > 0 and its output names the claimed test. If no narrowing can be proven, run the full `<testCmd>` and read the named test's own result from its output.";
const KILL =
  "**Kill:** the mutant produced a valid red in a narrowed run, and the same narrowed command, in the same tree with the mutant reverted, ran a valid green with the named test passing — completed, exit 0, `tests` > 0, `cancelled` 0. A completed exit ≠ 0 with the named test not failing is not a kill, and no kill stands without that green run on the unmutated tree. The result is inconclusive, never a kill, when the red does not reproduce in the narrowed run, when the unmutated tree is red too, or when no usable run exists.";
const EVIDENCE =
  "**Evidence line:** every kill and every valid red you claim carries one line in the claim's own free-text field: `red: <cmd> → exit N, fail K incl <test>; baseline: <cmd> → exit 0, <test> pass`. A failing-test finding filed off the review's shared run carries the `red:` half alone.";
const RULES = { "Valid red": VALID_RED, "Narrowed run": NARROWED, Kill: KILL, "Evidence line": EVIDENCE };

// Gutters and `**` are layout, not text: a `>` brief, a `.agent.md` body and a
// JS template carry the same words wrapped three ways.
const flat = (s) => unemphasized(stripQuoteGutter(s)).replace(/\s+/g, " ");
const holds = (site, paragraph) => phrase(unemphasized(paragraph)).test(flat(site));

// --- the sites, read where their instructions live ------------------------

const failing = { command: "node --test", logPath: "/r/test-run.log", exitCode: 1, tests: 5, pass: 3, fail: 2 };
const ownerNote = sharedRunNote(failing, "correctness", "correctness");

async function renderedPrompts() {
  const dims = ["correctness", "tests"];
  const { host, prompts } = scriptedHost({
    snapshot: [SNAP],
    "review:correctness": [review([finding("critical")])],
    "review:tests": [review([])],
    "verify:correctness": [vote(false)],
  });
  await runReview({ ...host, pipeline, parallel }, { ...ARGS, dimensions: dims });
  return { tests: prompts["review:tests"][0], refuter: prompts["verify:correctness"][0] };
}

const fixApplier = () =>
  quoteBlock(
    between(RUN_TEAM, "### Reviewers", "#### Fallback: hand-dispatched reviewer", "run-team's Reviewers section"),
    "You are ALREADY in worktree `<abs-path>`, whose PR branch is",
    "the fix-applier prompt",
  );
const finisher = () => quoteBlock(RUN_TEAM, "**A test run is a verdict only if it ran to completion", "the finisher's test-run verdict block");
const agent = (name) => read("plugin", "agents", `${name}.agent.md`).split("---").slice(2).join("---");

// Every kill site: its text, plus the clause its own inconclusive path takes.
const KILL_SITES = async () => {
  const { tests, refuter } = await renderedPrompts();
  return [
    ["the `tests` dimension's dispatched prompt", tests, "file no finding above `suggestion` on it, and name the gap — both runs — in `scope_searched`"],
    ["agents/fleet-review-tests.agent.md", agent("fleet-review-tests"), "file no finding above `suggestion` on it, and name the gap — both runs — in `scope_searched`"],
    ["the refuter's dispatched prompt", refuter, "set `inconclusive` to true and name the runs in `reason`"],
    ["agents/fleet-review-verifier.agent.md", agent("fleet-review-verifier"), "set `inconclusive` to true and name the runs in `reason`"],
    ["run-team's fix-applier prompt", fixApplier(), "do not report the test as proven, and measure again in a clean state"],
    ["run-team's finisher test-run verdict block", finisher(), "halt with cause `other`, with both runs — the mutant's and the unmutated tree's — as evidence"],
  ];
};

test("every kill site quotes Valid red, Narrowed run, Kill and the Evidence line word for word", async () => {
  for (const [where, text, inconclusive] of await KILL_SITES()) {
    for (const [name, paragraph] of Object.entries(RULES)) {
      assert.ok(holds(text, paragraph), `${where} no longer quotes the ${name} paragraph word for word — reword every site together, and this fixture with them`);
    }
    assert.ok(holds(text, inconclusive), `${where} lost its inconclusive path: "${inconclusive}"`);
  }
});

test("the owner dimension's failing-test note carries Valid red, Narrowed run and the Evidence line, and no Kill", () => {
  for (const paragraph of [VALID_RED, NARROWED, EVIDENCE]) assert.ok(holds(ownerNote, paragraph), `the owner note lost: ${paragraph.slice(0, 40)}`);
  assert.ok(!holds(ownerNote, KILL), "the owner dimension's failing-test finding needs a valid red only, not a kill with a baseline");
  assert.ok(holds(ownerNote, "A failing test is filed off this run only on a valid red: rerun it first in a narrowed run in your own copy of the snapshot"));
  assert.ok(holds(ownerNote, "file no finding above `suggestion` on it and name both runs"));
  // Only the owner is told; a non-owner is still told not to duplicate it.
  assert.ok(!holds(sharedRunNote(failing, "correctness", "tests"), VALID_RED));
});

test("no kill site keeps the exit-status-only reading it replaced", async () => {
  const { tests } = await renderedPrompts();
  assert.doesNotMatch(flat(tests), /confirm that test goes red/);
  assert.doesNotMatch(flat(agent("fleet-review-tests")), /confirm that test goes red/);
  assert.doesNotMatch(flat(finisher()), /exits 1 is a plain failure/);
  // The refuter's bias stays, scoped to reasoning: a run that could not decide
  // is not "uncertain".
  assert.ok(holds(agent("fleet-review-verifier"), "default to `refuted: true` if you are uncertain in your reasoning"));
});

// The narrowing is the Test entrypoint plus appended arguments, and nothing a
// particular runner spells: the Recipe guarantees only that they reach it.
test("the narrowed-run paragraph names no runner-specific command", () => {
  assert.doesNotMatch(NARROWED, /agent-test|vitest|jest|pytest|mocha|--test-name-pattern|--grep|\s-t\s|\s-k\s/);
});

// The pin's own controls: it must REFUSE a site that drops the clause a kill
// turns on, and ACCEPT the same words rewrapped.
test("the pin reds on a dropped baseline clause and stays green on a reflow", () => {
  const text = fixApplier();
  const gutted = text.replace(/,\s*(?:>\s*)*and\s+(?:>\s*)*no\s+(?:>\s*)*kill\s+(?:>\s*)*stands\s+(?:>\s*)*without\s+(?:>\s*)*that\s+(?:>\s*)*green\s+(?:>\s*)*run\s+(?:>\s*)*on\s+(?:>\s*)*the\s+(?:>\s*)*unmutated\s+(?:>\s*)*tree/, "");
  assert.notEqual(gutted, text, "the control's mutation did not land — the clause is no longer spelled this way");
  assert.ok(!holds(gutted, KILL), "the pin passed a Kill paragraph with its baseline clause deleted");
  const rewrapped = text.replace(/ /g, "\n> ");
  assert.ok(holds(rewrapped, KILL), "the pin reds on a pure reflow");
});

test("CONTEXT.md defines Valid green, Valid red and Kill", () => {
  const entry = (term) => flat(between(CONTEXT, `**${term}**:`, "_Avoid_:", `CONTEXT.md's ${term} entry`));
  assert.match(entry("Valid green"), /exit 0, `tests` above 0 and `cancelled` 0/);
  assert.match(entry("Valid red"), /the test the claim names is reported failing/);
  assert.match(entry("Valid red"), /An exit ≠ 0 with no failing test is not red/);
  assert.match(entry("Kill"), /a Valid green with the named test passing on the same narrowed command in the same tree with the mutant reverted/);
});

test("the tests dimension's catalog prompt is the one the rendered prompt carries", () => {
  const tests = DEFAULT_DIMENSIONS.find((d) => d.key === "tests");
  assert.ok(holds(tests.prompt, KILL));
});
