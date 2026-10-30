// A dispatched member never runs the Label map derivation step and never asks.
// It reads each role its prose has it type or compare with `label-map.mjs show
// <role>`, once, before it acts, and a refusal (any non-zero exit from `show`)
// ends it with its family's existing outcome. Content pins on what each member
// RECEIVES — its agent body and rendered brief together, where the text lives
// in both — plus run-merge-bot.md, which the merge bot reads as its runbook.
//
// Each pin is sliced to the member, section or paragraph it speaks about. Two
// controls keep the pins honest about what they must ACCEPT: the kinds that
// type and compare no role (conflict, red-check) and the implementers read
// nothing, so a read demanded of them would be a false refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { memberPrompt } from "./support/render-brief.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const file = (...parts) => Pin.file(join(PLUGIN, ...parts));

const MERGE_BOT_DOC = file("commands", "run-merge-bot.md");
const FINISHER = file("agents", "fleet-finisher.agent.md");
const FIX_APPLIER = file("agents", "fleet-fix-applier.agent.md");
const MERGE_BOT_AGENT = file("agents", "fleet-merge-bot.agent.md");
const MERGE_BOT_BRIEF = file("skills", "run-team", "briefs", "merge-bot.md");

const SHOW = (role) => `~/.fleet/bin/fleet-run label-map.mjs show ${role}`;
const SHOW_RE = /label-map\.mjs\s+show\b/;

for (const kind of ["review", "dispositions-retry"]) {
  test(`the fix-applier's ${kind} brief reads before its first edit or refuter and ends a refusal with no report`, () => {
    const prompt = memberPrompt("fix-applier", kind);
    const read = Pin.of(prompt, `the ${kind} fix-applier prompt`).between(
      "**Before your first edit or refuter dispatch, read the Label map",
      "**The review's result is",
      `the ${kind} fix-applier's Label map paragraph`,
    ).text;
    assert.match(read, Pin.phrase(SHOW("needs-triage")));
    assert.match(read, Pin.phrase(SHOW("wontfix")));
    assert.match(read, Pin.phrase("You never run `ensure` and never ask anyone."));
    assert.match(read, Pin.phrase("**A non-zero exit from `show` ends you with no report**"));
    assert.match(read, Pin.phrase("do nothing else first, never type the role name in place of the string"));
    assert.match(read, Pin.phrase("send `<your name>: failed (no report): <what show printed>` and exit"));
    // Before the first edit, the first refuter, the first push: the read sits above every place the brief tells it to act.
    const readAt = prompt.search(SHOW_RE);
    for (const act of ["`recipe-check.mjs` (below) from the worktree before committing", "Before you report, write every ruling"]) {
      const at = prompt.search(Pin.phrase(act));
      if (at !== -1) assert.ok(readAt < at, `the Label map read comes after "${act}"`);
    }
  });
}

test("the fix-applier agent definition names the one no-report ending beside its report paragraph", () => {
  const report = FIX_APPLIER.between("Then write your report to the file your brief names,", "**Deferring everything is a normal", "the fix-applier's report paragraph").text;
  assert.match(report, Pin.phrase("One ending writes no report at all: a review or dispositions-retry fix-applier whose Label map read refuses"));
  assert.match(report, Pin.phrase("`<your name>: failed (no report): <what show printed>` as its one line and exits"));
});

test("the fix-applier kinds that type and compare no role read nothing", () => {
  for (const kind of ["conflict", "red-check"]) {
    const brief = memberPrompt("fix-applier", kind);
    // The agent body is shared across kinds and says only that the brief names the read; the brief itself must not command one.
    assert.doesNotMatch(Pin.of(brief, `the ${kind} prompt`).between("You are ALREADY in worktree", "Your report is a file", `the ${kind} brief`).text, SHOW_RE, `the ${kind} brief reads the map`);
  }
});

test("the finisher reads needs-triage and wontfix before duty 1 and halts a refusal with cause other", () => {
  const read = FINISHER.between("**Before duty 1, read the Label map", "**Duty 1 is one script", "the finisher's Label map paragraph").text;
  assert.match(read, Pin.phrase(SHOW("needs-triage")));
  assert.match(read, Pin.phrase(SHOW("wontfix")));
  assert.match(read, Pin.phrase("You never run `ensure` and you never ask anyone."));
  assert.match(read, Pin.phrase("Any non-zero exit from `show` ends you before duty 1, with nothing else done first and the role name never typed in place of the string"));
  assert.match(read, Pin.phrase("`outcome` `halted`, `cause` `other`, `evidence` what `show` printed, `kill` null, and every list empty"));
  assert.ok(FINISHER.text.search(SHOW_RE) < FINISHER.text.indexOf("**Duty 1 is one script"), "the finisher reads after duty 1 begins");
});

test("run-merge-bot.md reads ready-to-merge before selection; a refusal holds no grace and reports every queued PR refused", () => {
  const doc = MERGE_BOT_DOC.text;
  const section = MERGE_BOT_DOC.section("## The Label map", "run-merge-bot.md Label map section").text;
  assert.match(section, Pin.phrase("**At the start of your pass, before selection, read the Label map — once.**"));
  assert.match(section, Pin.phrase(SHOW("ready-to-merge")));
  assert.match(section, Pin.phrase("You run no `ensure` and ask no one."));
  assert.match(section, Pin.phrase("**A non-zero exit from `show` ends your pass before selection**, with nothing else done first and `ready-to-merge` never typed in place of the string"));
  assert.match(section, Pin.phrase("holds no grace"));
  assert.match(section, Pin.phrase("~/.fleet/bin/fleet-run ledger.mjs read | jq -c '.queued[\"merge-bot-<n>\"]'"));
  assert.match(section, Pin.phrase("every PR there `refused` with `reason` `label-map-refused`; an empty or absent queue gives every list empty"));
  assert.match(section, Pin.phrase("Validate it as **One verdict per queued PR** says, then send your final line followed by what `show` printed."));
  assert.match(section, Pin.phrase("**The top-level invocation** prints what `show` printed and stops. It writes no report."));
  // Before selection: the section sits above the first step that selects.
  assert.ok(doc.indexOf("## The Label map") < doc.indexOf("## Order, and the hold rule"), "the read sits after selection begins");
  // The one string serves both polls and the timeline comparison.
  assert.match(doc, Pin.phrase('gh pr list --state open --label "<ready-to-merge string>" --limit 200 --json number'));
  assert.match(doc, Pin.phrase('label="<ready-to-merge string>"'));
  assert.match(doc, Pin.phrase('poll() { gh pr list --state open --label "$label" --limit "$cap"'), "the Monitor's poll no longer passes the string `show` printed");
  assert.match(doc, Pin.phrase('label="<ready-to-merge string>" gh api "repos/{owner}/{repo}/issues/<pr>/timeline?per_page=100"'), "the timeline read hands the string to jq through the environment");
  assert.match(doc, Pin.phrase('.event == "labeled" and .label.name == env.label'));
  // Quoted or bare, a role name after `--label` is the role typed where the mapped string goes; the head record's prefix is not a label.
  assert.doesNotMatch(doc, /--label\s+"?ready-to-merge\b(?!-head)/, "a poll types the role name where the mapped string goes");
  assert.doesNotMatch(doc, /\.label\.name == "ready-to-merge"/, "the timeline comparison types the role name where the mapped string goes");
});

test("run-merge-bot.md carries the head-record sentence in the paragraph that defines the record", () => {
  const para = MERGE_BOT_DOC.paragraph("**The labelled head is the head its labeller recorded.**", "the head-record paragraph", "```bash").text;
  assert.match(para, Pin.phrase("The prefix `ready-to-merge-head:` is not a label: type it as written, whatever string the Label map gives `ready-to-merge`."));
  // The record itself stays as it was written: the prefix and the parse are fixed.
  assert.match(para, Pin.phrase("posts a PR comment whose whole body is `ready-to-merge-head: <sha>`, naming the head it audited, immediately before the label"));
  assert.match(MERGE_BOT_DOC.text, /capture\("\\\\Aready-to-merge-head: \(\?<sha>\[0-9a-f\]\{40\}\)\\\\s\*\\\\z"\)/, "the jq that parses the record changed");
});

test("the merge bot's agent definition and brief say a refusal's final line adds what show printed", () => {
  assert.match(MERGE_BOT_BRIEF.text, Pin.phrase("A Label map refusal, which `run-merge-bot.md` describes, follows that line with what `show` printed."));
  assert.match(MERGE_BOT_AGENT.text, Pin.phrase("A Label map refusal follows that line with what `show` printed."));
  assert.match(MERGE_BOT_AGENT.text, Pin.phrase("ends the pass before any grace is held"));
});

test("every member that reads says a refusal never types the role name", () => {
  const sayings = [
    ["the fix-applier brief", memberPrompt("fix-applier", "review"), "never type the role name in place of the string"],
    ["the finisher", FINISHER.text, "the role name never typed in place of the string"],
    ["run-merge-bot.md", MERGE_BOT_DOC.text, "`ready-to-merge` never typed in place of the string"],
  ];
  for (const [who, text, saying] of sayings) assert.match(text, Pin.phrase(saying), `${who} no longer says a refusal never types the role name`);
});

test("the implementers read nothing: their one role mention is a prohibition", () => {
  for (const name of ["fleet-implementer-slow-high", "fleet-implementer-slow-medium", "fleet-implementer-smol-high", "fleet-implementer-task-high", "fleet-implementer-task-max"]) {
    const text = file("agents", `${name}.agent.md`).text;
    assert.doesNotMatch(text, SHOW_RE, `${name} reads the Label map`);
    assert.match(text, Pin.phrase("Never apply `ready-to-merge`, never merge."), `${name} lost its prohibition`);
  }
});
