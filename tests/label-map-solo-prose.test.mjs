// The solo entry points run the Label map derivation step; no dispatched member
// and not the merge bot ever does. Content pins on shipped prose, not on any
// script: `label-map.mjs ensure` is the step, and which files may name it is
// the rule.
//
// Each pin is sliced to the step, paragraph or file it speaks about, so a stray
// copy of the wording elsewhere cannot buy the pass. The role rule is pinned as
// ORDER — present, and above the first role name of the file's body — because a
// rule stated after the first `gh` command it governs has already lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const file = (...parts) => Pin.file(join(PLUGIN, ...parts));

const NEXT_TICKET = file("skills", "next-ticket", "SKILL.md");
const SIZING = file("skills", "sizing-a-ticket", "SKILL.md");
const REVIEW_AND_FIX = file("commands", "review-and-fix.md");
const MERGE_BOT_DOC = file("commands", "run-merge-bot.md");
const FIX_APPLIER_BRIEF = file("skills", "run-team", "briefs", "fix-applier.md");
const MERGE_BOT_BRIEF = file("skills", "run-team", "briefs", "merge-bot.md");

const AGENTS = readdirSync(join(PLUGIN, "agents"))
  .filter((f) => /^fleet-.*\.agent\.md$/.test(f))
  .sort();
const IMPLEMENTERS = AGENTS.filter((f) => f.startsWith("fleet-implementer-"));

const ROLE_RULE = "Label names in this file are roles; the Label map gives the string to type; a member never derives the map.";
const ENSURE = /label-map\.mjs\s+ensure/;
const ROLE = /\b(needs-triage|needs-info|ready-for-agent|ready-for-human|wontfix|in-progress|onhold|ready-to-merge)\b/;

// A markdown file's body: what follows the frontmatter fence.
const bodyOf = (text) => (text.startsWith("---\n") ? text.slice(text.indexOf("\n---\n", 4) + "\n---\n".length) : text);

// The rule must be there and sit above the first role name of `text`.
const assertRuleAboveFirstRole = (text, where) => {
  const rule = text.search(Pin.phrase(ROLE_RULE));
  assert.notEqual(rule, -1, `${where} does not carry the role rule`);
  assert.equal(text.split(/\s+/).join(" ").split(ROLE_RULE).length - 1, 1, `${where} states the role rule more than once`);
  const role = text.search(ROLE);
  assert.notEqual(role, -1, `${where} names no role, so the rule has nothing to govern — update this test`);
  assert.ok(rule < role, `${where} names a role before it states the role rule`);
};

test("/next-ticket runs ensure before its candidates query and no longer creates in-progress itself", () => {
  const step1 = NEXT_TICKET.between("## 1. Candidates", "## 2. Dependencies", "next-ticket step 1").text;
  const ensureAt = step1.search(ENSURE);
  const queryAt = step1.indexOf("candidates.mjs");
  assert.notEqual(ensureAt, -1, "step 1 does not run the derivation step");
  assert.notEqual(queryAt, -1, "step 1 no longer runs the candidates query");
  assert.ok(ensureAt < queryAt, "step 1 runs the candidates query before the derivation step");
  assert.match(step1, Pin.phrase("--require-label ready-for-agent --allow-fallback"), "the query keeps naming the role it requires");
  // The question, naming the payload's table file; the answer and the second `ensure`; how to make the answer permanent in that file; and the two refusals that are no question.
  assert.match(step1, Pin.phrase("Exit 3 → it printed the question payload"));
  assert.match(step1, Pin.phrase("a JSON object with `certain`, `uncertain` and `tableFile`, the path of the repository's triage-label table"));
  assert.match(step1, Pin.phrase("(a role declared in the table but not in the tracker names the payload's `tableFile`)"));
  assert.match(step1, Pin.phrase("**Wait for the answer**, then run `~/.fleet/bin/fleet-run label-map.mjs set --create` with it"));
  assert.match(step1, Pin.phrase("run `ensure` again, which now exits 0"));
  assert.match(step1, Pin.phrase("add or edit the row for the role in the file the payload's `tableFile` names"));
  assert.match(step1, Pin.phrase("Exit 1 or 2 → show what it printed and stop; neither is a question."));

  assert.doesNotMatch(NEXT_TICKET.text, /gh label create in-progress/, "the claim still creates the label itself");
  const claim = NEXT_TICKET.between("## 5. Claim it", "## 6. Size the ticket", "next-ticket step 5").text;
  assert.match(claim, Pin.phrase('gh issue edit <N> --add-label "<in-progress string>"'));
  assert.match(claim, Pin.phrase("`<in-progress string>` is what `~/.fleet/bin/fleet-run label-map.mjs show in-progress` prints"));
  assert.doesNotMatch(claim, /--add-label in-progress/, "the claim types the role name where the mapped string goes");
});

test("/review-and-fix runs ensure standalone before step 1 and says a dispatched fix-applier never does", () => {
  const preamble = REVIEW_AND_FIX.between("`<scratch>` below is", "1. Run the review yourself.", "review-and-fix.md preamble").text;
  assert.match(preamble, Pin.phrase("**Standalone, before step 1, run the Label map derivation step:** `~/.fleet/bin/fleet-run label-map.mjs ensure`."));
  assert.match(preamble, Pin.phrase("wait for the answer, run `~/.fleet/bin/fleet-run label-map.mjs set --create` with it"));
  assert.match(preamble, Pin.phrase("then `ensure` again, which now exits 0. Exit 1 or 2 → show what it printed and stop."));
  // The payload's table file, named for the question and for making the answer permanent; the maintainer edits that table, the agent never does.
  assert.match(preamble, Pin.phrase("it printed the question payload, whose `tableFile` is the path of the repository's triage-label table"));
  assert.match(preamble, Pin.phrase("(a role declared in the table but not in the tracker names `tableFile`)"));
  assert.match(preamble, Pin.phrase("After that second `ensure`, tell the maintainer to add or edit the role's row in the file `tableFile` names; never write that table yourself."));
  assert.match(preamble, Pin.phrase("**Dispatched as a fix-applier, you never run `ensure` and never ask:**"));
  // The derivation step is not a numbered step: the fix-applier's brief cites steps 2, 3 and 5 by number.
  assert.doesNotMatch(preamble, /^\d+\. /m, "the derivation step took a step number, which renumbers the steps the fix-applier brief cites");
});

test("every gh command review-and-fix types with a role types the string show prints", () => {
  const s = REVIEW_AND_FIX.text;
  assert.match(s, Pin.phrase("`<needs-triage string>`, `<wontfix string>` and `<ready-to-merge string>` below"));
  assert.match(s, Pin.phrase('`gh issue create --label "<needs-triage string>"`'), "the deferral filing types the role");
  assert.match(s, Pin.phrase("filed with `gh issue create --label \"<wontfix string>\"` and then CLOSED"), "the suggestion-band record types the role");
  assert.match(s, Pin.phrase('`gh pr edit <pr> --add-label "<ready-to-merge string>"`'), "the standalone label types the role");
  assert.doesNotMatch(s, /gh issue create --label needs-triage/);
  assert.doesNotMatch(s, /--add-label ready-to-merge/);
});

test("no fleet agent definition and not run-merge-bot.md runs ensure", () => {
  // Positive control: the pattern does find the step where it is run, so a zero below is a measurement.
  assert.match(NEXT_TICKET.text, ENSURE, "the control file no longer runs ensure — the pattern below would pass vacuously");
  assert.match(REVIEW_AND_FIX.text, ENSURE, "the control file no longer runs ensure — the pattern below would pass vacuously");
  assert.ok(AGENTS.length > 5, "the agent glob found no definitions");
  for (const name of AGENTS) {
    const text = file("agents", name).text;
    assert.doesNotMatch(text, ENSURE, `${name} runs the derivation step`);
  }
  assert.doesNotMatch(MERGE_BOT_DOC.text, ENSURE, "run-merge-bot.md runs the derivation step");
  assert.doesNotMatch(FIX_APPLIER_BRIEF.text, ENSURE, "the fix-applier brief runs the derivation step");
  assert.doesNotMatch(MERGE_BOT_BRIEF.text, ENSURE, "the merge-bot brief runs the derivation step");
});

test("review-and-fix step 6 carries the head-record sentence beside the gh pr comment that writes the record", () => {
  const step6 = REVIEW_AND_FIX.between("6. Diff-check green", "**Bind green to the *run*", "review-and-fix.md step 6").text;
  const record = 'gh pr comment <pr> --body "ready-to-merge-head: <prHead>"';
  const sentence = "The prefix `ready-to-merge-head:` is not a label: type it as written, whatever string the Label map gives `ready-to-merge`.";
  const recordAt = step6.search(Pin.phrase(record));
  const sentenceAt = step6.search(Pin.phrase(sentence));
  const labelAt = step6.search(/--add-label "<ready-to-merge string>"/);
  assert.notEqual(recordAt, -1, "step 6 no longer writes the record");
  assert.notEqual(sentenceAt, -1, "step 6 does not say the record's prefix is not a label");
  assert.notEqual(labelAt, -1, "step 6 no longer adds the label");
  assert.ok(recordAt < sentenceAt && sentenceAt < labelAt, "the sentence is not between the record and the label");
  // Beside, not elsewhere in the step: nothing but the record's own gloss sits between them.
  const between = step6.slice(recordAt + record.length, sentenceAt);
  assert.ok(between.length < 400, "the sentence is no longer beside the command that writes the record");
  assert.equal((step6.match(/ready-to-merge-head:/g) ?? []).length, 2, "the record's prefix is typed other than as written, or somewhere new");
});

test("every file in the slice that names a role carries the role rule above its first role name", () => {
  assertRuleAboveFirstRole(bodyOf(NEXT_TICKET.text), "next-ticket/SKILL.md");
  assertRuleAboveFirstRole(bodyOf(SIZING.text), "sizing-a-ticket/SKILL.md");
  assertRuleAboveFirstRole(bodyOf(REVIEW_AND_FIX.text), "commands/review-and-fix.md");
  assertRuleAboveFirstRole(bodyOf(MERGE_BOT_DOC.text), "commands/run-merge-bot.md");
  for (const name of ["fleet-finisher.agent.md", "fleet-fix-applier.agent.md", ...IMPLEMENTERS]) {
    assertRuleAboveFirstRole(bodyOf(file("agents", name).text), `agents/${name}`);
  }
  // The merge bot's definition names its role only in its frontmatter description, which is no body text, so
  // there is no role name for the rule to sit above; the rule is still stated, once, near the top of the body.
  const mergeBotBody = bodyOf(file("agents", "fleet-merge-bot.agent.md").text);
  assert.match(mergeBotBody, Pin.phrase(ROLE_RULE), "fleet-merge-bot.agent.md does not carry the role rule");
  assert.ok(mergeBotBody.search(Pin.phrase(ROLE_RULE)) < 400, "fleet-merge-bot.agent.md states the role rule far from the top of its body");
  // The kind heading appears twice: the worktree preamble, then the section carrying the steps to run.
  const reviewKind = FIX_APPLIER_BRIEF.between("## kind: review, dispositions-retry\nRead `", "\n## kind: conflict", "the fix-applier brief's review kind").text;
  assertRuleAboveFirstRole(reviewKind, "briefs/fix-applier.md, kind review and dispositions-retry");
});
