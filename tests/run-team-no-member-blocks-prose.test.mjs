// run-team/SKILL.md is the controller's runbook, not a member's prompt. A member
// reads its agent body and the brief the renderer prints, so SKILL.md carries no
// `>`-quoted block for the controller to paste, and no rule telling it to "say
// it in every dispatch prompt": each such rule was replaced by the template
// line that carries it, and that line is pinned here against the rendered brief.
//
// Three claims, each with a control that feeds the check a text it must catch:
//
//   - no line of SKILL.md (or of a reference file) is a `>` quote line;
//   - the CI wait has one owner, the controller: the retired "wait for green"
//     duty text survives nowhere under plugin/, and the fix-applier's body and
//     brief each say to push, write the report and exit, never poll a CI run;
//   - every dispatch-prompt rule the runbook used to dictate is gone from it,
//     and its replacement line is carried by every rendered brief it governs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { CASES, PLUGIN, agentBody, label, renderBrief } from "./support/render-brief.mjs";

const RUN_TEAM = join(PLUGIN, "skills", "run-team");
const SKILL = readFileSync(join(RUN_TEAM, "SKILL.md"), "utf8");
// Phase 1's relabel-by-cause paragraph moved into references/pull.md.
const PULL_MD = readFileSync(join(RUN_TEAM, "references", "pull.md"), "utf8");
const QUOTE_LINE = /^[ \t]*>/;
const quoteLines = (text) => text.split("\n").filter((l) => QUOTE_LINE.test(l));

test("run-team/SKILL.md and its reference files carry no `>` quote line", () => {
  assert.deepEqual(quoteLines(SKILL), [], "SKILL.md holds a quoted block — a member reads its agent body and rendered brief, so a block here is a second copy the controller is told to paste");
  for (const f of readdirSync(join(RUN_TEAM, "references"))) {
    assert.deepEqual(quoteLines(readFileSync(join(RUN_TEAM, "references", f), "utf8")), [], `references/${f} holds a quoted block`);
  }
  // The control: the matcher sees a quote at depth one, nested and indented.
  assert.equal(quoteLines("a\n> b\n> > c\n  > d\ne").length, 3);
});

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

test("the retired fixer duty `Wait for green checks` survives nowhere under plugin/", () => {
  const files = walk(PLUGIN);
  const holding = (needle) => files.filter((p) => readFileSync(p, "utf8").includes(needle));
  // The control: the same walk, with the same literal match, finds a line known to be there.
  assert.ok(holding("Exit 75 from the suite is not a test result").length >= 3, "the walk cannot find a line known to exist, so its zero proves nothing");
  assert.deepEqual(holding("Wait for green checks"), []);
});

test("the CI wait has one owner: the fix-applier's body and brief both say to push, report and exit, never poll a CI run", () => {
  assert.match(agentBody("fleet-fix-applier"), Pin.phrase("Once your work is pushed, write your report and exit; never poll a CI run."));
  for (const c of CASES.filter((x) => x.role === "fix-applier")) {
    assert.match(renderBrief(c.role, c.kind), Pin.phrase("Push, write your report, exit; never poll a CI run."), `${label(c)}'s brief no longer says to push, report and exit without polling CI`);
  }
  const reviewAndFix = readFileSync(join(PLUGIN, "commands", "review-and-fix.md"), "utf8");
  assert.match(reviewAndFix, Pin.phrase("Under the fleet, do not hold this wait."), "review-and-fix.md step 4 no longer states who owns the wait");
});

// The rules SKILL.md used to dictate, each as a phrase of the old wording.
const RETIRED_RULES = [
  "Say it in every dispatch prompt",
  "Say in every dispatch prompt that you do not acknowledge reports",
  "Give them the line verbatim",
  "Give the finisher the instrument re-check verbatim too",
  "Give the finisher the test-run verdict rule verbatim too",
  "Give the finisher duty 3 verbatim as well",
  "Give the finisher this verbatim",
  "Give it the cause block below, verbatim",
  "Tell every implementer, fix-applier and finisher, in its brief, in one line",
  "Tell it to read `~/.omp/plugins/node_modules/@feigi/fleet-ctl/commands/run-merge-bot.md`",
  "Put the standing CI facts in that prompt",
  "Its prompt takes the prompt below's",
  "A pattern kill reaches siblings — say so in the dispatch prompt",
  "So say in the dispatch prompt that",
];

test("every `say it in the dispatch prompt` rule is gone from SKILL.md", () => {
  const flat = SKILL.replace(/\s+/g, " ");
  // The control: the same flattening finds a rule that is there.
  assert.ok(flat.includes("**Name every member.**"), "the flattened SKILL.md no longer holds a known line, so its absences prove nothing");
  for (const rule of RETIRED_RULES) assert.ok(!flat.includes(rule), `SKILL.md still dictates: "${rule}" — the template carries it now`);
});

const ack = "The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.";
const foreground = "A member runs its test suite in the foreground and blocks on it. Exit 75 from the suite is not a test result; run the command again.";
const warnings = "Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.";
const noPkill = "Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours.";
const REPLACEMENTS = [
  ["the no-acknowledgement line", ack, ["implementer", "fix-applier", "finisher", "merge-bot", "review-runner"]],
  ["the warnings-acted-on line", warnings, ["implementer", "fix-applier", "finisher", "merge-bot", "review-runner"]],
  ["the foreground-suite and exit-75 lines", foreground, ["implementer", "fix-applier", "finisher"]],
  ["the pattern-kill prohibition", noPkill, ["implementer", "fix-applier", "finisher"]],
  ["the report paragraph", "Your report is a file,", ["implementer", "fix-applier", "finisher", "merge-bot"]],
];

test("each replacement line is carried by every rendered brief it governs, every kind", () => {
  for (const [what, line, roles] of REPLACEMENTS) {
    for (const c of CASES.filter((x) => roles.includes(x.role))) {
      assert.match(renderBrief(c.role, c.kind), Pin.phrase(line), `${label(c)}'s brief no longer carries ${what}`);
    }
  }
});

test("the relabel comments live in briefs/relabel.md and SKILL.md renders them instead of quoting them", () => {
  for (const kind of ["needs-triage", "fork", "hands"]) {
    assert.match(renderBrief("relabel", kind), Pin.phrase("*Relabelled by the fleet controller.* Pulled for implementation and returned:"), `relabel ${kind} lost its opening`);
  }
  const flat = SKILL.replace(/\s+/g, " ");
  assert.ok(PULL_MD.replace(/\s+/g, " ").includes("dispatch-prompt.mjs render relabel --kind <kind>"), "references/pull.md no longer says the comment is rendered");
  assert.ok(!flat.includes("Relabelled by the fleet controller"), "SKILL.md quotes a relabel comment again");
});
