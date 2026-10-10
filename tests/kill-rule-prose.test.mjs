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
const REVIEW_AND_FIX = read("plugin", "commands", "review-and-fix.md");

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
// One whole paragraph of the site — a blank line (gutter or not) either side.
const isolates = (site, paragraph) => stripQuoteGutter(site).split(/\n[ \t]*\n/).some((p) => flat(p).trim() === flat(paragraph).trim());

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

// The in-scope suggestion refuter has no abstain — its verdict is `{refuted,
// reason}` and dispositions-check refuses one that abstains — so its inconclusive
// path leaves `refuted` true: the suggestion defers instead of applying unchecked.
const SUGGESTION_ABSTAIN = "leave `refuted` true, so the suggestion defers on the record instead of applying on a check that decided nothing";
// A quote nested in the fix-applier's quote carries `> > ` — every level goes.
const suggestionRefuter = (text, what, end) =>
  between(text, "Try to REFUTE this finding", end, what).split("\n").map((l) => l.replace(/^(?:\s*>)+ ?/, "")).join("\n");

// Every kill site: its text, the clause its own inconclusive path takes, and
// whether it lays the rules out as paragraphs of their own.
const KILL_SITES = async () => {
  const { tests, refuter } = await renderedPrompts();
  return [
    ["the `tests` dimension's dispatched prompt", tests, "file no finding above `suggestion` on it, and name the gap — both runs — in `scope_searched`", true],
    ["agents/fleet-review-tests.agent.md", agent("fleet-review-tests"), "file no finding above `suggestion` on it, and name the gap — both runs — in `scope_searched`", true],
    ["the refuter's dispatched prompt", refuter, "set `inconclusive` to true and name the runs in `reason`", true],
    ["agents/fleet-review-verifier.agent.md", agent("fleet-review-verifier"), "set `inconclusive` to true and name the runs in `reason`", true],
    ["run-team's fix-applier prompt", fixApplier(), "do not report the test as proven, and measure again in a clean state", true],
    ["run-team's in-scope suggestion refuter brief", suggestionRefuter(RUN_TEAM, "run-team/SKILL.md", "Survives → apply it, with one hold"), SUGGESTION_ABSTAIN, true],
    ["review-and-fix.md step 2's in-scope suggestion refuter brief", suggestionRefuter(REVIEW_AND_FIX, "review-and-fix.md", "That last clause is the whole mechanism"), SUGGESTION_ABSTAIN, false],
    ["run-team's finisher test-run verdict block", finisher(), "halt with cause `other`, with both runs — the mutant's and the unmutated tree's — as evidence", true],
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

// A sentence appended INSIDE a rule paragraph still contains it, so `holds`
// stays green: "Exit 1 alone is a kill." glued to the end of Valid red
// contradicts the rule and passed every pin. A site that lays each rule out as
// its own paragraph (a blank line either side, gutter or not) is held to the
// paragraph, whole. review-and-fix.md's brief is one source line, so it has no
// paragraph to hold and is left to `holds` alone.
test("every kill site that lays the rules out as paragraphs carries each one whole, with nothing glued onto it", async () => {
  for (const [where, text, , paragraphs] of await KILL_SITES()) {
    if (!paragraphs) continue;
    for (const [name, paragraph] of Object.entries(RULES)) {
      assert.ok(isolates(text, paragraph), `${where} no longer carries the ${name} paragraph as a paragraph of its own — a sentence glued onto it contradicts the rule and still passes a containment pin`);
    }
  }
});

test("the pin reds on a sentence appended inside a rule paragraph, and stays green on the same text reflowed", async () => {
  const [, text] = (await KILL_SITES())[2];
  const glued = text.replace(VALID_RED.slice(-30), (m) => `${m} Exit 1 alone is a kill.`);
  assert.notEqual(glued, text, "the control's mutation did not land");
  assert.ok(holds(glued, VALID_RED), "the containment pin no longer holds on a glued sentence — this control then proves nothing about isolates()");
  assert.ok(!isolates(glued, VALID_RED), "a sentence glued inside the Valid red paragraph passed");
  assert.ok(isolates(text.replace(/ /g, "  "), VALID_RED), "isolates() reds on a respaced paragraph");
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
// turns on — at every copy, since the fix-applier prompt carries the rules twice
// — and ACCEPT the same words rewrapped.
test("the pin reds on a dropped baseline clause and stays green on a reflow", () => {
  const text = fixApplier();
  const gutted = text.replace(/,\s*(?:>\s*)*and\s+(?:>\s*)*no\s+(?:>\s*)*kill\s+(?:>\s*)*stands\s+(?:>\s*)*without\s+(?:>\s*)*that\s+(?:>\s*)*green\s+(?:>\s*)*run\s+(?:>\s*)*on\s+(?:>\s*)*the\s+(?:>\s*)*unmutated\s+(?:>\s*)*tree/g, "");
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
