// run-team's SKILL.md is a wake-to-command table: its sections run in the order
// the controller needs them, each opens with its exit condition, and what the
// controller reads only when a member needs the why lives under references/.
// These pins hold what only the runbook carries about that shape:
//
//   - the section order, by heading text, and the shape of the section list
//     the ticket names: invariants, phase 0, the wake table, the tick's rows,
//     the Pull, dispatch, the finisher gate, the judgement rules, then the
//     failure table, guards, red flags and the report;
//   - every `## ` section's first paragraph states what the controller does and
//     when it is done with the section, and no section's table is followed by
//     prose;
//   - the invariants are at most ten lines, one line each, and the tick's rows
//     are one line each, each row name the tick prints present once;
//   - nothing the rewrite took out was lost: the fixture
//     tests/fixtures/run-team-moved-text/skill-before-shape-rewrite.md is the
//     whole SKILL.md as it read before the rewrite, owned by this test, and
//     every sentence of it is found in SKILL.md or across references/ as often
//     as it was said, but for the sentences CHANGED and DELETED below, each
//     named with what stands in its place, a CHANGED sentence's old half said
//     nowhere now and a DELETED one said fewer times than the fixture said it,
//     by at least the times it is listed;
//   - the three blocks the rewrite moved whole — Shell traps, the invariants'
//     full statements, the tick rows' full text — are found across references/
//     as often as they were said, and not at all in SKILL.md.
//
// THE CEILING shared with every prose pin here: this proves text is PRESENT,
// not that no sentence beside it negates it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const RUN_TEAM_DIR = join(import.meta.dirname, "..", "plugin", "skills", "run-team");
const REFERENCES = join(RUN_TEAM_DIR, "references");
const FIXTURE = join(import.meta.dirname, "fixtures", "run-team-moved-text", "skill-before-shape-rewrite.md");
const SKILL = readFileSync(join(RUN_TEAM_DIR, "SKILL.md"), "utf8");

const flat = (text) => text.replace(/\s+/g, " ").trim();
const occurrences = (haystack, needle) => {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n += 1;
  return n;
};

// --- the blocks of a document -------------------------------------------------

const FENCE = /^\s*(?:```|~~~)/;
// The document's units, each whitespace-flattened: a paragraph, a top-level
// list item with whatever hangs off it, one table row, a fenced block. A
// heading carries no sentence. A unit that ends without a full stop (a table
// row, a code span, a colon before a block) would otherwise run into the next
// unit's first sentence, so units are what sentences are cut from.
export const units = (text) => {
  const out = [];
  let cur = [];
  let fence = false;
  const push = () => {
    if (cur.length > 0) out.push(flat(cur.join("\n")));
    cur = [];
  };
  for (const line of text.split("\n")) {
    if (fence) {
      cur.push(line);
      if (FENCE.test(line)) {
        push();
        fence = false;
      }
      continue;
    }
    if (FENCE.test(line)) {
      push();
      cur.push(line);
      fence = true;
      continue;
    }
    if (line.trim() === "" || /^#{1,6}\s/.test(line)) {
      push();
      continue;
    }
    if (/^(?:[-*]|\d+\.)\s/.test(line) || /^\s*\|/.test(line)) push();
    cur.push(line);
  }
  push();
  return out;
};

// A moved list item's marker and a numbered step's ordinal claim nothing.
const sentencesOf = (text) =>
  units(text)
    .flatMap((u) => Pin.sentences(u))
    .map((s) => s.replace(/^(?:\d+\.|-)\s+/, ""))
    .filter((s) => s !== "" && !/^\d+\.$/.test(s));

const counted = (sentences) => {
  const m = new Map();
  for (const s of sentences) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
};

// Every reference file, whitespace-flattened, joined by a character no sentence
// holds, so a sentence cannot be matched across two files.
const referenceCorpus = () =>
  readdirSync(REFERENCES)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => flat(readFileSync(join(REFERENCES, f), "utf8")))
    .join("\u0000");

// --- the section order --------------------------------------------------------

// Every `## ` heading, in order, fences skipped.
export const headingsOf = (text) => {
  const out = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    else if (!fence && /^## /.test(line)) out.push(line);
  }
  return out;
};

// The ticket's ten, in its order — the sections the controller acts from.
const TICKET_ORDER = [
  "## Invariants",
  "## Phase 0 — shortlist",
  "## The wake table",
  "## The tick's rows",
  "## Phase 1 — Pull: judge, then claim or relabel",
  "## The finisher gate",
  "## Judgement rules the drivers stop for",
  "## Failure handling",
  "## Guards",
  "## Red flags",
  "## Report",
];

// What the ticket does not name stays in the file, between the judgement rules
// and the failure table, in the order the file had it.
const STANDING = [
  "## Rules that fail silently",
  "## Worktree and claim model",
  "## Queue depth",
  "## Tier outcomes guard",
  "## Why the implementer body carries what it does",
  "## Fix the tooling mid-run",
];

test("the sections run in the order the ticket names, the standing sections between the judgement rules and the failure table", () => {
  const judge = TICKET_ORDER.indexOf("## Judgement rules the drivers stop for");
  const expected = [...TICKET_ORDER.slice(0, judge + 1), ...STANDING, ...TICKET_ORDER.slice(judge + 1)];
  assert.deepEqual(headingsOf(SKILL), expected);
});

test("no `## ` heading is a section this file did not have a reason to keep: Shell traps live in references/", () => {
  assert.ok(!headingsOf(SKILL).includes("## Shell traps"));
  assert.match(readFileSync(join(REFERENCES, "shell-traps.md"), "utf8"), /^## Shell traps$/m);
});

// --- the first paragraph is the exit condition --------------------------------

const EXIT_VERBS = ["run", "dispatch", "answer", "act", "hold", "report", "stop"];
// Refuses a listed word that directly follows a determiner (a, an, the, one, this,
// that, each, every, its, their, your) or is followed by 's or ’s (possessive). A
// determiner lookbehind cannot catch every noun use (e.g. "a single run" or "the
// team's run"), and a full part-of-speech parser is deliberately not used. This
// keeps the check honest rather than claiming paraphrase-proofness.
const EXIT_VERB = new RegExp(`(?<!\\b(?:a|an|the|one|this|that|each|every|its|their|your)\\s+)\\b(?:${EXIT_VERBS.join("|")})\\b(?![’']s)`, "i");

// A `## ` section as its top-level blocks: the text between its heading and the
// next `## ` heading, cut into paragraphs, lists, tables, code blocks and
// headings by the blank lines and markers a reader sees.
export const sectionsOf = (text) => {
  const out = [];
  let cur = null;
  let fence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) {
      cur = { heading: line, lines: [] };
      out.push(cur);
    } else if (cur !== null) cur.lines.push(line);
  }
  return out.map(({ heading, lines }) => ({ heading, blocks: blocksOf(lines) }));
};

// Each block is {kind, text}: heading, table, fence, list or para.
export const blocksOf = (lines) => {
  const blocks = [];
  let cur = null;
  let fence = false;
  const close = () => {
    if (cur !== null) blocks.push(cur);
    cur = null;
  };
  const open = (kind, line) => {
    close();
    cur = { kind, text: line };
  };
  for (const line of lines) {
    if (fence) {
      cur.text += `\n${line}`;
      if (FENCE.test(line)) {
        close();
        fence = false;
      }
      continue;
    }
    if (FENCE.test(line)) {
      open("fence", line);
      fence = true;
    } else if (line.trim() === "") close();
    else if (/^#{1,6}\s/.test(line)) {
      open("heading", line);
      close();
    } else if (cur === null) {
      open(/^\|/.test(line) ? "table" : /^(?:[-*]|\d+\.)\s/.test(line) ? "list" : "para", line);
    } else if (cur.kind === "table" && !/^\|/.test(line)) {
      open("para", line);
    } else if (cur.kind === "para" && /^\|/.test(line)) {
      open("table", line);
    } else cur.text += `\n${line}`;
  }
  close();
  return blocks;
};

// The first paragraph of a section: its first block that is not a heading.
export const firstParagraph = ({ blocks }) => blocks.find((b) => b.kind !== "heading");

test("every `## ` section opens with a paragraph that states what the controller does and when it is done", () => {
  const sections = sectionsOf(SKILL);
  assert.ok(sections.length >= 17, `${sections.length} sections read — the splitter is broken`);
  for (const section of sections) {
    const first = firstParagraph(section);
    assert.ok(first !== undefined && first.kind === "para", `${section.heading} does not open with a paragraph`);
    assert.match(first.text, EXIT_VERB, `${section.heading}'s first paragraph names none of ${EXIT_VERBS.join(", ")}: it states no exit condition`);
  }
});

test("a first paragraph naming none of the exit verbs, or no paragraph at all, is refused; one naming any is accepted", () => {
  const sec = (md) => sectionsOf(`## S\n\n${md}\n`)[0];
  for (const verb of EXIT_VERBS) {
    const p = firstParagraph(sec(`Done when you ${verb} it.\n\nMore.`));
    assert.match(p.text, EXIT_VERB, verb);
  }
  // Test determiners that should be rejected
  assert.doesNotMatch(firstParagraph(sec("Something happens inside one run.\n\nMore.")).text, EXIT_VERB, "word after 'one ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Through the run's own merge queue.\n\nMore.")).text, EXIT_VERB, "word followed by 's should be rejected");
  assert.doesNotMatch(firstParagraph(sec("A dispatch is started.\n\nMore.")).text, EXIT_VERB, "word after 'A ' should be rejected");
  // Test determiners with different exit verbs
  assert.doesNotMatch(firstParagraph(sec("Inside the dispatch.\n\nMore.")).text, EXIT_VERB, "word after 'the ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Inside each answer.\n\nMore.")).text, EXIT_VERB, "word after 'each ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Inside an act.\n\nMore.")).text, EXIT_VERB, "word after 'an ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Inside this stop.\n\nMore.")).text, EXIT_VERB, "word after 'this ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Inside that hold.\n\nMore.")).text, EXIT_VERB, "word after 'that ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Inside every report.\n\nMore.")).text, EXIT_VERB, "word after 'every ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Inside its run.\n\nMore.")).text, EXIT_VERB, "word after 'its ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Inside their dispatch.\n\nMore.")).text, EXIT_VERB, "word after 'their ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Inside your answer.\n\nMore.")).text, EXIT_VERB, "word after 'your ' should be rejected");
  assert.doesNotMatch(firstParagraph(sec("The act's details.\n\nMore.")).text, EXIT_VERB, "word followed by 's should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Inside the  run.\n\nMore.")).text, EXIT_VERB, "word after a determiner and more than one space should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Team run’s ledger.\n\nMore.")).text, EXIT_VERB, "word followed by ’s should be rejected");
  // Verify verbs without determiners still match
  assert.match(firstParagraph(sec("Report it to the maintainer.\n\nMore.")).text, EXIT_VERB, "verb without determiner should match");
  assert.match(firstParagraph(sec("You can stop when green.\n\nMore.")).text, EXIT_VERB, "verb after a word merely ending in a determiner's letters should match");
  assert.doesNotMatch(firstParagraph(sec("Report's header is long.\n\nMore.")).text, EXIT_VERB, "word followed by 's with no determiner before it should be rejected");
  assert.doesNotMatch(firstParagraph(sec("Nothing to see here, move along.\n\nStop.")).text, EXIT_VERB);
  assert.equal(firstParagraph(sec("- a list first\n\nStop.")).kind, "list");
  assert.equal(firstParagraph(sec("| a | b |\n|---|---|\n| 1 | 2 |\n\nStop.")).kind, "table");
});

// --- no table is followed by prose --------------------------------------------

// A top-level table is the last thing before a heading or the end of its
// section. A table nested in a list item is part of that item.
export const proseAfterTable = (section) => {
  const hits = [];
  section.blocks.forEach((b, i) => {
    if (b.kind !== "table") return;
    const next = section.blocks[i + 1];
    if (next !== undefined && next.kind !== "heading") hits.push(`${section.heading}: a table is followed by ${next.kind}: ${flat(next.text).slice(0, 60)}`);
  });
  return hits;
};

test("no section has a table followed by prose: every table closes its section or the block under its heading", () => {
  const sections = sectionsOf(SKILL);
  const tables = sections.flatMap((s) => s.blocks.filter((b) => b.kind === "table"));
  assert.ok(tables.length >= 5, `${tables.length} tables read — the splitter is broken`);
  assert.deepEqual(sections.flatMap(proseAfterTable), []);
});

test("a table followed by a paragraph, a list or a second table is refused; one that ends its section or precedes a heading is accepted", () => {
  const sec = (md) => sectionsOf(`## S\n\nFirst.\n\n${md}\n`)[0];
  assert.equal(proseAfterTable(sec("| a |\n|---|\n| 1 |\n\nTrailing prose.")).length, 1);
  assert.equal(proseAfterTable(sec("| a |\n|---|\n| 1 |\n\n- trailing item")).length, 1);
  assert.equal(proseAfterTable(sec("| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |")).length, 1);
  assert.equal(proseAfterTable(sec("| a |\n|---|\n| 1 |")).length, 0);
  assert.equal(proseAfterTable(sec("| a |\n|---|\n| 1 |\n\n### Next\n\nProse under it.")).length, 0);
  assert.equal(proseAfterTable(sec("A table with no blank line before the prose:\n| a |\n|---|\n| 1 |\nTrailing prose.")).length, 1);
});

// --- the invariants and the rows are one line each ----------------------------

test("the invariants are at most ten lines, one line each", () => {
  const section = sectionsOf(SKILL).find((s) => s.heading === "## Invariants");
  const lines = section.blocks.flatMap((b) => b.text.split("\n")).filter((l) => l.trim() !== "");
  assert.ok(lines.length <= 10, `${lines.length} lines`);
  const items = section.blocks.filter((b) => b.kind === "list").flatMap((b) => b.text.split("\n"));
  assert.ok(items.length >= 6, "the invariants list is gone");
  for (const line of items) assert.match(line, /^- /, `an invariant runs over a line: ${line}`);
});

const ROW_NAMES = [
  "`PULL #<N> …`",
  "`REFRESHED shortlist: <n> entries; <k> lifted`",
  "`SUGGEST /triage, hold idle`",
  "`specs-dropped=#<N> …`",
  "`DISPATCH fix-pr PR#<M> …`",
  "`DISPATCH review PR#<M> …`",
  "`DISPATCH merge-bot`",
  "`DISPATCH finisher PR#<M> …`",
  "`ESCALATE unlabelled PR#<M> …`",
  "`CONFLICT PR#<M> …`",
  "`ESCALATE conflict PR#<M> …`",
  "`ESCALATE pr-closed #<N> PR#<M>`, `… pr-unchecked …`",
  "`HOLD (…)`",
  "`AT CAP`, `IDLE OK`",
  "`MAIN-CHECKOUT-DIRTY …`",
  "`MAIN-CHECKOUT-UNKNOWN …`",
  "`MAIN-CHECKOUT-NO-BASELINE …`",
  "`PHASE0-INCOMPLETE <step>…`",
  "`CHECK-LIVENESS <member> (…)`",
  "`UNRECORDED <stem> (…)`",
  "`NO-TRANSCRIPT <member> (…)`",
  "`SETTLE <member> (report on disk …)`",
];

test("the tick's rows are one line each, each row the tick prints named once, with what it asks and where its full text is", () => {
  const section = sectionsOf(SKILL).find((s) => s.heading === "## The tick's rows");
  const list = section.blocks.filter((b) => b.kind === "list");
  assert.equal(list.length, 1, "the rows are one list");
  const lines = list[0].text.split("\n");
  assert.deepEqual(
    lines.map((l) => ROW_NAMES.find((n) => l.startsWith(`- ${n} — `)) ?? l),
    ROW_NAMES,
    "a row line is missing, repeated, out of order, or runs over a line",
  );
  assert.match(firstParagraph(section).text, Pin.phrase("The full text of each row is in references/tick-rows.md."));
});

// The reference carries each row's full text: its bullets are the fixture's rows.
test("references/tick-rows.md names every row the tick's list names", () => {
  const ref = readFileSync(join(REFERENCES, "tick-rows.md"), "utf8");
  for (const name of ROW_NAMES) {
    const lead = name.replace(/^`([^`]*?)(?: …| \(…\)|…)?`.*$/, "$1").replace(/ <.*$/, "");
    assert.ok(ref.includes(`- \`${lead}`), `references/tick-rows.md has no row for ${name}`);
  }
});

// --- nothing the rewrite took out is lost -------------------------------------

// Sentences the rewrite changed: the pre-rewrite sentence and the sentence that
// stands in SKILL.md (or the reference file named) now. A positional pointer
// whose target moved names where the target is; a sentence a split paragraph
// left dangling is finished; a lead-in whose block moved says so.
//
// The cut that removed `## Phase 3 — event loop` (#3540) keeps its own pairs in
// tests/fixtures/run-team-moved-text/phase-3-dispositions.json, `changed` and
// `deleted` in this file's shape: a pointer retargeted at the section that now
// owns its wake, and each sentence that restated a script, or that a
// references/ file or an agent body already carries, named with what stands
// in its place.
const PHASE_3 = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "run-team-moved-text", "phase-3-dispositions.json"), "utf8"));
// The cut that removed `## Phase 2 — dispatch every member` keeps its own pairs in
// tests/fixtures/run-team-moved-text/phase-2-dispositions.json, in the same shape.
const PHASE_2 = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "run-team-moved-text", "phase-2-dispositions.json"), "utf8"));
const CHANGED = [
  ...PHASE_2.changed,
  ...PHASE_3.changed,
  [
    "**Pin once**, at phase 0 step 0 below, from the main checkout you are running this from — never from a member's worktree, which is gitignored and carries no baseline: `~/.fleet/bin/fleet-run instruments.sh --pin`.",
    "**Pin once**, at phase 0 step 0 above, from the main checkout you are running this from — never from a member's worktree, which is gitignored and carries no baseline: `~/.fleet/bin/fleet-run instruments.sh --pin`."
  ],
  [
    "No harness supplies a scratch directory to a member, so a member left to name its own invents one — and the liveness read below, which looks at the files under the directory a member's own prompt assigned it, then watches a directory nobody else can find.",
    "No harness supplies a scratch directory to a member, so a member left to name its own invents one — and the liveness read in **The tick's rows**, which looks at the files under the directory a member's own prompt assigned it, then watches a directory nobody else can find."
  ],
  [
    "Monitor and Bash commands run under **zsh**, and the shell in this file is prescriptive — copied verbatim into a watcher or into the merge bot's agent body.",
    "Monitor and Bash commands run under **zsh**, and the shell in SKILL.md is prescriptive — copied verbatim into a watcher or into the merge bot's agent body."
  ],
  [
    "Stated in full at *A probe that cannot read is a transition event, not silence* in Phase 3, and it binds every watcher in this file rather than that one block: the third value beside pass and fail is what turns a broken loop into a loud failure instead of a quiet one.",
    "Stated in full at *A probe that cannot read is a transition event, not silence* under **Own the CI waits**, and it binds every watcher in SKILL.md rather than that one block: the third value beside pass and fail is what turns a broken loop into a loud failure instead of a quiet one."
  ],
  [
    "Listed first because it is the only wake with no trigger — every other row above arrives; this one is the absence of one.",
    "Listed on its own because it is the only wake with no trigger — every other row above arrives; this one is the absence of one."
  ],
  [
    "The diff-validating `check` job green with no heavy job (the diff-validating suites, not the `rebase-check` currency gate) in `failure` → a finisher CANDIDATE (gated below), a `check` **failure** that is not solely staleness → the **red-check fixer** (**Then dispatch a red-check fixer**, below), behind the same review-returned and fix-applier-reported gate as a finisher.",
    "The diff-validating `check` job green with no heavy job (the diff-validating suites, not the `rebase-check` currency gate) in `failure` → a finisher CANDIDATE (gated below), a `check` **failure** that is not solely staleness → the **red-check fixer** (**Then dispatch a red-check fixer**, above), behind the same review-returned and fix-applier-reported gate as a finisher."
  ],
  [
    "**A fix-applier reports `no-op`, or a SHA you have already bound** → dispatch the finisher **now**, against the existing head — when that head's bound conclusion is red, the red-check fixer instead (**Then dispatch a red-check fixer**, below), never a finisher and never a wait.",
    "**A fix-applier reports `no-op`, or a SHA you have already bound** → dispatch the finisher **now**, against the existing head — when that head's bound conclusion is red, the red-check fixer instead (**Then dispatch a red-check fixer**, above), never a finisher and never a wait."
  ],
  [
    "**Then iterate with the inline `$(printf '%s\\n' \"$prs\")` form, never a bare `for pr in $prs`** — the assigned-variable trap in **Shell traps**, which carries the mechanism, with its measurements in references/shell-traps.md.",
    "**Then iterate with the inline `$(printf '%s\\n' \"$prs\")` form, never a bare `for pr in $prs`** — the assigned-variable trap in **Shell traps**, in references/shell-traps.md, which carries the mechanism and its measurements."
  ],
  [
    "When the diff-validating `check` job is green **and no heavy job is in `failure`** (the heavy diff-validating suites — not the `rebase-check` currency gate; a `skipped` heavy job is behind-count staleness and fine — **solely** off that count, which is a condition to establish rather than infer, see the five-condition note in the fix-applier body) — or `ci-state.mjs` reads `verdict: \"no-ci\"`, see below — **and once the PR's review has returned and its fix-applier, if one was dispatched, has sent its report, which the CI-completes edge above states in full** — dispatch a **finisher** — a fresh small agent, not the fix-applier resumed.",
    "When the diff-validating `check` job is green **and no heavy job is in `failure`** (the heavy diff-validating suites — not the `rebase-check` currency gate; a `skipped` heavy job is behind-count staleness and fine — **solely** off that count, which is a condition to establish rather than infer, see the five-condition note in the fix-applier body) — or `ci-state.mjs` reads `verdict: \"no-ci\"`, see above — **and once the PR's review has returned and its fix-applier, if one was dispatched, has sent its report, which the CI-completes edge above states in full** — dispatch a **finisher** — a fresh small agent, not the fix-applier resumed."
  ],
  [
    "Its four duties are a checklist — audit the worktree, confirm every deferral has a tracker home and re-run the acceptance mutation, apply one release label, report — and the merge gate downstream still catches whatever it gets wrong, the same argument that puts the merge bot on the same tier below.",
    "Its four duties are a checklist — audit the worktree, confirm every deferral has a tracker home and re-run the acceptance mutation, apply one release label, report — and the merge gate downstream still catches whatever it gets wrong, the same argument that puts the merge bot on the same tier above."
  ],
  [
    "A bot already looping cannot be corrected — the loop consumes the turns a correction would land in — so `agents/fleet-merge-bot.agent.md` carries **every entry in Shell traps**, each written out in full: the rules in that section with the measurements from `references/shell-traps.md` beside them, and the bot has them before its first turn.",
    "A bot already looping cannot be corrected — the loop consumes the turns a correction would land in — so `agents/fleet-merge-bot.agent.md` carries **every entry in `references/shell-traps.md`'s Shell traps**, each written out in full: the rules with the measurements from that file beside them, and the bot has them before its first turn."
  ],
  [
    "An edit to Shell traps or to `references/shell-traps.md` lands in that body in the same change.",
    "An edit to `references/shell-traps.md` lands in that body in the same change."
  ],
  [
    "`~/.fleet/bin/fleet-run closeout.mjs finish --reason \"<reason>\"` — scrapes the run's member facts, checks the tier-outcomes rows, refreshes the metrics, commits the three metrics files and opens their PR, then records `fleet-heartbeat.mjs --stop` last, because every reader takes a recorded stop as the end of the run.",
    "`~/.fleet/bin/fleet-run closeout.mjs finish --reason \"<reason>\"` — scrapes the run's member facts, checks the tier-outcomes rows, refreshes the metrics, commits the three metrics files and opens their PR, sets the phase-0 receipt aside as `.fleet/phase0.previous.json`, then records `fleet-heartbeat.mjs --stop` last, because every reader takes a recorded stop as the end of the run."
  ],
  [
    "`heartbeat not beating, controller alive (pid N)`, or `(this session's earlier run)` — a controller that stopped beating and kept going.",
    "`heartbeat not beating, controller alive (pid N)` — a controller that stopped beating and kept going."
  ],
  [
    "Read the report's `git cherry <pin> HEAD origin/main`: only `-` lines is a clean rebase, and a `+` line is a conflict resolution that changed content or a commit past the pin.",
    "The report's `evidence.replay` reads `pure` only when `git range-diff origin/main <pin> HEAD` pairs every pinned commit with an unchanged one; `changed` (a commit dropped, edited or added, or a stale `origin/main`) or `unknown` means read `evidence.rangeDiff` before acting, and `evidence.remote.state` says whether that head is on the PR."
  ],
  [
    "`jq '{pr, head, resume, testEnvironment, dimensionsRun, dimensionsUnrun, cwdAudit, counts}' <scratch>/pr<pr>/<run>/review.json` is the whole of your read, and it is what you record: `reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`, off `head`, `counts` and the run root's name — the runner's `ledger` field — on the PR's row, with `ledger.mjs review <pr>`.",
    "`jq '{pr, head, resume, testEnvironment, suiteVerdict, dimensionsRun, dimensionsUnrun, cwdAudit, counts}' <scratch>/pr<pr>/<run>/review.json` is the whole of your read, and it is what you record: `reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`, off `head`, `counts` and the run root's name — the runner's `ledger` field — on the PR's row, with `ledger.mjs review <pr>`."
  ],
  [
    "A specialist that dies contributes zero findings while its key stays in `dimensionsRun`; a review whose one shared test run executed nothing — the review runs the test command once, and every specialist reads that run instead of running its own — leaves every key there with no suite behind it.",
    "A specialist that dies contributes zero findings while its key stays in `dimensionsRun`."
  ],
  [
    "A key in `dimensionsRun` and NOT in `dimensionsUnrun` ran a suite; every `dimensionsUnrun` entry is `{dimension, reason}` naming which failure it was.",
    "A key in `dimensionsRun` and NOT in `dimensionsUnrun` returned a review; every `dimensionsUnrun` entry is `{dimension, reason}` naming a specialist that returned nothing, its `reason` the crash."
  ],
  [
    "In a review it leaves every dimension unrun, for the reason \"no suite slot within <n> s — the host is at its suite bound; not a test failure\", with no retry inside the run: re-review it under the next runner letter (`review-pr-<pr#>-b` after a first runner), as for a runner that reported `failed`.",
    "In a review it makes `suiteVerdict` not usable, `suiteVerdict.reason` beginning \"no suite slot within <n> s — the host is at its suite bound; not a test failure\", with no retry inside the run: read that `reason` off the digest and re-review it under the next runner letter (`review-pr-<pr#>-b` after a first runner), as for a runner that reported `failed`."
  ],
  [
    "No ledger refuses this call (exit 2, nothing removed): mid-run there is always one, so its absence is a fault to look at, never permission.",
    "Without `--after-rotate` — the per-pass sweep `tick --apply` runs after each merge pass — no ledger refuses the call (exit 2, nothing removed): mid-run there is always one, so its absence is a fault to look at, never permission."
  ],
  [
    "**Implementer bails before implementing** → `fleet-event.mjs impl-report impl-<N>` settles `impl-<N>=bailed` and demotes by cause:",
    "**Implementer bails before implementing** → `fleet-event.mjs impl-report impl-<N>` settles `impl-<N>=bailed` and acts by `bailCause`, never by parsing `bailDetail`; no cause opens a PR:"
  ],
  [
    "| Cause | Label |",
    "| Cause | `bailCause` | `bailDetail` format | Issue action | Ledger |"
  ],
  [
    "| brief does not decide *what* to build | `needs-triage` |",
    "| brief does not decide *what* to build | `undecided` | `<one line>` | relabel `needs-triage` | `=bailed` |"
  ],
  [
    "| genuine fork — options named, none ruled | `ready-for-human` |",
    "| genuine fork — options named, none ruled | `fork` | `<options>` | relabel `ready-for-human` | `=bailed` |"
  ],
  [
    "| needs human hands — external access, manual testing, judgment during the work | `ready-for-human` |",
    "| needs human hands — external access, manual testing, judgment during the work | `hands` | `<cause>: <line>` | relabel `ready-for-human` | `=bailed` |"
  ],
  [
    "The call relabels, comments the cause and releases the claim, then ticks: the head the tick names next is a *different* ticket.",
    "The call comments the cause and releases the claim — never when `fixed` neither closes nor relabels N — then ticks: the head the tick names next is a *different* ticket."
  ],
  [
    "| Implementer bails before implementing | → `needs-triage` if under-specified, `ready-for-human` if it needs human hands or leaves a fork open; drop `in-progress`, comment the cause, release the claim, refill (phase 3) |",
    "| Implementer bails before implementing | Act by the report's `bailCause` as the **Relabel causes** table says, then refill (**What a wake owes beyond its call**) |"
  ],
  [
    "Run `~/.fleet/bin/fleet-run phase0.mjs --session <session-dir>` from this main checkout, `<session-dir>` being this run's own session directory.",
    "Run phase 0 from a Python eval cell in this main checkout, without `--session`: `subprocess.run([os.path.expanduser(\"~/.fleet/bin/fleet-run\"), \"phase0.mjs\", …], stderr=subprocess.STDOUT)`."
  ],
  [
    "| 1 `LEFT #N: excluded · behind-…` | `collision` answered `behind-pr:#M` or `behind-issue:#M` | next entry |",
    "| 1 `LEFT #N: excluded …` | `collision` answered `behind-pr:#M` or `behind-issue:#M`, or its ledger exclusion stands | next entry |"
  ],
  [
    "| 1 `LEFT #N: relabelled <label>: …` | `decided` answered with a cause | next entry |",
    "| 1 `LEFT #N: relabelled <label>: …` | `decided` answered with a cause, or a stranded ruling | next entry |"
  ],
  [
    "The deficit is then *computed, not remembered*, which is the whole point: a table you must remember to consult is one you will not consult under a merge-side event storm, and that is how implementers reached 0/target with one approved ticket waiting and ~57 `ready-for-agent` in supply while nobody noticed (#3).",
    "The deficit is then *computed, not remembered*, which is the whole point: a table you must remember to consult is one you will not consult under a merge-side event storm, and that is how implementers reached 0/target with ~57 `ready-for-agent` in supply while nobody noticed (#3)."
  ],
  [
    "**A finisher failed or was killed** → `ledger.mjs settle finisher-pr-<M>=failed` for a finisher that crashed or gave up, `=killed` for one that was killed; no label, and the tick prints no dispatch for it.",
    "**A finisher failed or was killed** → the **Member confirmed dead or never dispatched** wake (`member-died finisher-pr-<M>`), which settles it `failed` or `killed`; no label, and the tick prints no dispatch for it."
  ],
  [
    "Make the `task` call, or settle the token `killed`.",
    "Make the `task` call, or run the **Member confirmed dead or never dispatched** wake (`fleet-event.mjs member-died <member>`), which settles the token `killed` once the first-seen stamp is past five minutes."
  ],
  [
    "| Member **killed** (spend limit, API error, crash) | Confirm it is dead first — a frozen transcript does not establish that; see below — then new member, new name, prompt carries inherited state |",
    "| Member **killed** (spend limit, API error, crash) | Confirm it is dead first — a frozen transcript does not establish that; see below — then run the **Member confirmed dead or never dispatched** wake, then new member, new name, prompt carries inherited state |"
  ],
  [
    "A `running` row → the mtime discriminator below, two polls: moved means BLOCKED and alive; frozen at both polls **and** no artifact movement → `write proc://<member>/kill`, `ledger.mjs settle <member> killed`, fresh name.",
    "A `running` row → the mtime discriminator below, two polls: moved means BLOCKED and alive; frozen at both polls **and** no artifact movement → `write proc://<member>/kill`, the **Member confirmed dead or never dispatched** wake, fresh name."
  ],
  [
    "`NEED resume #<n> <worktree> <branch>` — a dead run's claim with no PR.",
    "`NEED resume #<n> <worktree> <branch>` — a dead run's claim: no PR, or not only `CLOSED` ones."
  ]
];

// Sentences deleted outright, each named with what stands in its place.
const DELETED = [
  ...PHASE_2.deleted,
  ...PHASE_3.deleted,
  [
    "**`impl-<N>/`** goes once issue #N is CLOSED, or when it is OPEN, no live `impl-<N>` token names it and nothing under it has changed in 7 days.",
    "reclaim-scratch.mjs's header, which `tick --apply` runs after the reap, and tests/reclaim-scratch.test.mjs"
  ],
  [
    "A duty 1 halt's report carries the verdict as printed, the JSON line, so a `rebase` halt's report carries the output of `git cherry <pin> HEAD origin/main` that its `evidence` holds.",
    "agents/fleet-finisher.agent.md's report paragraph, which has a duty 1 halt's `evidence` carry the verdict as printed, `replay`, `rangeDiff` and `remote` included"
  ],
  [
    "See references/shell-traps.md.",
    "nothing: each Shell traps rule now sits in references/shell-traps.md, with its evidence under its own heading there, so the pointer named the file it was in"
  ],
  [
    "Its duties, in this order:",
    "agents/fleet-finisher.agent.md, which states each duty and is the finisher's system prompt; phase 2's **The finisher** points at references/finisher.md"
  ],
  [
    "It returns `{pr, head, resume, testEnvironment, dimensionsRun, dimensionsUnrun, cwdAudit, counts, snapshot, survived, refuted, unverified}` — the **digest** first, then the snapshot and the findings — and it lands as one artefact, `<scratch>/pr<pr>/<run>/review.json`, holding that bare object.",
    "review-core.mjs's result file, whose fields **Reading a review result**'s `jq` read names and tests/review-path-default.test.mjs checks against the function's actual return"
  ],
  [
    "`needs-triage` routes back to `/triage`, which can return it as `ready-for-agent`; `ready-for-human` for hands or a fork; `needs-triage` for a brief that names no *what*.",
    "the bail table's Issue action column, which names each cause's label, and references/pull.md's **Relabel by cause**, which routes `needs-triage` and `ready-for-human`"
  ],
  [
    "The same causes relabel an unclaimed ticket at the Pull (phase 1), where there is no `in-progress` to drop — the causes and labels are one table, applied at whichever point the ticket fails them.",
    "references/pull.md's Pull table and **Relabel by cause**, which carry the Pull's own relabels and its close of a fixed ticket; the bail table gained `fixed` and `covered`, which the Pull does not apply"
  ],
  [
    "`hub cancel` leaves a peer hard-aborted and unmessageable, but a `failed` job's peer can stay `idle` and answer normally.",
    "references/member-lifecycle.md's two-axes paragraph, which says the same — `hub cancel` → `cancelled`, the peer hard-aborted and unmessageable, and a `failed` job's peer can stay `idle` and resumable — and which SKILL.md's Recovery section points at"
  ],
  [
    "The instrument-set rule is stated once, at the top of this file, which no finisher is dispatched to read, so it reaches one through that body.",
    "agents/fleet-finisher.agent.md, which carries the instrument-set rule a finisher reads"
  ],
  [
    "An entry that names neither `session` nor `transcript` takes the session directory phase 0's receipt `.fleet/phase0.json` records, and is exit 2 naming the receipt when it records none; the check reads the member's own `<session>/<member>.jsonl` directly, so a member with no assistant turn yet still resolves off its dispatch-time record.",
    "closeout.mjs's transcript lookup, which tests/closeout.test.mjs pins"
  ],
  [
    "Its `conflict` brief carries the same worktree and branch identity paragraph, but in place of the review paragraphs: bring `<branch>` current with `origin/main`, resolving every conflict by `run-merge-bot.md`'s **No-undo audit**, run `<testCmd>`, push, report the new head.",
    "dispatch-prompt.mjs's `conflict` kind, which renders the identity paragraph; tests/dispatch-prompt.test.mjs pins the render"
  ],
  [
    "Its `red-check` brief carries the same worktree and branch identity paragraph, but in place of the review paragraphs: read the failing job's log, fix the cause, run `<testCmd>`, push, report the new head, and **stop**.",
    "dispatch-prompt.mjs's `red-check` kind, which renders the identity paragraph; tests/dispatch-prompt.test.mjs pins the render"
  ],
  [
    "The brief carries what varies, and the renderer prints it: `~/.fleet/bin/fleet-run dispatch-prompt.mjs render fix-applier --kind <review|conflict|dispositions-retry|red-check> --member <name> --worktree <abs-path> --branch <branch> --testCmd <testCmd> --scratch <scratch>`, plus `--pr <pr#> --run <run>` for a review or a dispositions retry and `--mismatched-record <path> --violations <list>` for a retry.",
    "dispatch-prompt.mjs's render flags, printed by its usage; tests/dispatch-prompt.test.mjs pins the render"
  ],
  [
    "test --at origin/main` prints it — and the one you hand specialists per **Give specialists a stack-free test command** above.",
    "plugin/commands/review-and-fix.md's **Give specialists a stack-free test command**, which carries the rule"
  ],
  ["`→ PR#M` stays as the human-readable arrow; the tick reads only the `=` tokens.", "ledger.mjs's token grammar, ledger-grammar.mjs"],
  ["`DISPATCH finisher PR#<M> …` — a finisher settled `labelled`, yet the open list shows PR M without `ready-to-merge`, and no `label-off=` (**Run ledger**) accounts for the removal.", "fleet-tick.mjs's printed line; references/tick-rows.md"],
  ["`dispatch merge-bot` names the next bot itself.", "ledger.mjs dispatch merge-bot; tests/ledger-dispatch.test.mjs"],
  ["`label-off=<finisher-pr-M[-x]>` is yours, written before you take `ready-to-merge` off PR M on purpose (taking it off before you approve a push, or clearing one left on a moved head), naming that PR's latest finisher attempt: the tick reads a missing label as a finisher's miss only after the last attempt a `label-off=` names, so without it your own removal reads as one.", "references/ledger.md's label-off section; SKILL.md's wake section"],
  ["**`ledger.mjs dispatch <ticket|pr> <member>`** — before the dispatch call, marks the member live on its row and appends it to `## Dispatched` with `brief=<first 8 hex of its brief's sha256>`.", "ledger.mjs dispatch; tests/ledger-dispatch.test.mjs"],
  ["**`ledger.mjs review <pr> <token>…`** — the only writer of `review=` and `reviewed=` (below): appends each to the PR's row — the ticket row once `settle impl-<N>=PR#M` has run, else `#M`, created when neither exists — and prints `{pr, row, line, created, next}`, `row` the key written and `next` the runner name the PR's next launch takes, null with every letter taken.", "ledger.mjs review; tests/ledger-row-review.test.mjs"],
  ["**`ledger.mjs rotate`** — phase 0's first ledger write, every run: moves the file as-is to `ledger.<UTC YYYY-MM-DDTHHMMSSZ>.md` beside it under the same `<file>.lock`, and the next write starts the empty skeleton — unless the previous run was this session's own, when it first writes the rows and `## Dispatched` entries still live into a new ledger, and every other settled name, or name given an out-of-vocabulary outcome, into its `## Retired` (references/phase-0.md, \"Rotate the ledger\", says which).", "ledger.mjs rotate; tests/ledger-rotate.test.mjs; references/phase-0.md's Rotate the ledger"],
  ["**`ledger.mjs settle <member> <outcome>`** — rewrites the token to `<member>=<outcome>` in both places.", "ledger.mjs settle; tests/ledger-settle-report.test.mjs"],
  ["**`ledger.mjs settle <member> --from-report [--reports <dir>]`** — the settle for a member that wrote a report: reads `<dir>/<member>.json` (`<dir>` defaults to `<scratch>/reports`), derives the outcome from it and, before writing, checks what that outcome claims — `PR#M`: `verify-sha.sh` on the report's branch and head, and PR M OPEN and closing N; `bailed`: a `bailCause`, which the receipt names; `applied:<head>`: origin's branch at that head; `no-op`: origin's branch at the head the PR's latest `reviewed=` names; `labelled`: `ready-to-merge` on the PR and in the read-back; `halted:<cause>`: a cause and non-empty evidence; `done`: every PR the bot merged reads MERGED.", "ledger.mjs settle --from-report; tests/ledger-settle-report.test.mjs"],
  ["`review` holds a PR's review record to these rules, read across every row that maps to the PR — its settled `impl-<N>=PR#<M>` token, else its first `PR#` mention, else its key — in ledger order.", "ledger.mjs review; tests/ledger-row-review.test.mjs"],
  ["`row` and `token` refuse a `label-off=` naming no `finisher-pr` member that `## Dispatched` or some row already carries.", "ledger.mjs row and token; tests/ledger.test.mjs"],
  ["`row` holds the rest: a launch open before the write is still on one of the PR's rows after it, `=failed` allowed, and a member name appears once on the line, whatever its outcome.", "ledger.mjs row; tests/ledger.test.mjs"],
  ["`row` refuses a malformed member token anywhere in its text — one whose outcome is outside the vocabulary above, e.g. `merge-bot-1=dispatched` — at exit 2, naming the token and writing nothing, because every reader would take it as a permanent settle.", "ledger-grammar.mjs; tests/ledger-grammar.test.mjs"],
  ["`settle impl-N=PR#M` also folds a `#M` row a PR-bound dispatch or a `review` made before the settle into `#N`'s row, so the PR's row is the one row naming each PR from then on — but only when `#N`'s row named no PR before this write (a second `PR#` on it would misattribute the fold, or bury `#N`'s own fresher `review=` state under an older one) and no implementer claims `#M`'s row as its own.", "ledger.mjs settle; tests/ledger-settle-report.test.mjs"],
  ["`settle impl-N=PR#M` refuses a settle after which a PR maps to more than one row when it did not before, judged after the fold — a PR has one row, the PR's row; a split already on disk is carried.", "ledger.mjs settle; tests/ledger-settle-report.test.mjs"],
  ["A `review=<launch>=failed` whose `review=<launch>` the row holds settles that launch in place, alone or with the next launch in the same call.", "ledger.mjs review; tests/ledger-row-review.test.mjs"],
  ["A filer whose `filed` failed twice reports `unrecorded: #N <subject>` instead — an `unrecorded` entry of its report file — and `settle <member> --from-report` runs `filed` for it.", "ledger.mjs settle --from-report; tests/ledger-settle-report.test.mjs"],
  ["A launch identity (a workflow's runId, or a runner's name, `=failed` aside) appears once, and no launch takes a runner name the ledger's `## Retired` holds — an earlier run of this session launched it — naming the next free reviewer name instead.", "ledger.mjs review's launch check; tests/ledger-row-review.test.mjs"],
  ["**A member's token is `<member>` while it is live and `<member>=<outcome>` once it settles** — the grammar is `ledger-grammar.mjs`'s, and the tick derives every live count from it, so nobody states one.", "ledger-grammar.mjs; tests/ledger-grammar.test.mjs"],
  ["Any other token is refused.", "ledger-grammar.mjs; tests/ledger-grammar.test.mjs"],
  ["A second launch refused for an open one waits for that one's `reviewed=`, or — once the Member-killed row confirms its runner dead — settles it `=failed` in the same `review` call as the new launch.", "ledger.mjs review; tests/ledger-row-review.test.mjs"],
  ["A settled member stays settled.", "ledger.mjs settle; tests/ledger.test.mjs"],
  ["A write that adds a violation is refused, exit 2, nothing written; one already on the ledger and carried forward is not.", "ledger.mjs; tests/ledger.test.mjs"],
  ["Every `review=`/`reviewed=` parses.", "ledger-grammar.mjs; tests/ledger-grammar.test.mjs"],
  ["Every `reviewed=` answers the nearest earlier launch that is neither answered nor `=failed`.", "ledger.mjs review; tests/ledger-row-review.test.mjs"],
  ["Every record goes through `ledger.mjs` (**Run ledger**), which `fleet-event.mjs` drives — never a hand edit.", "SKILL.md's wake section; ledger.mjs; tests/ledger.test.mjs"],
  ["Exit 2: the report is absent or invalid, or a check could not look, and nothing is written; a check that could not look is run again once `gh` and `git` answer.", "ledger.mjs check's exits; tests/ledger.test.mjs"],
  ["Exit 3: a check failed — the member's claim and the world disagree — and nothing is written; you rule.", "ledger.mjs check; SKILL.md's wake section"],
  ["**filed** (`ledger.mjs filed <issue> <subject>`, checked with `ledger.mjs check <subject>` before every `gh issue create`) — so a finding already recorded this run is not filed twice.", "references/ledger.md's filed-and-ruled section; ledger.mjs filed"],
  ["It lives in this run's ledger, so the next run's rotation retires it with everything else.", "references/phase-0.md's Rotate the ledger"],
  ["It refuses a member whose `briefs/<member>.json` beside the ledger is missing, names another role or carries no sha256, a brief file beside it that is missing or does not hash to that sha256, a name this session already used — on the ledger or in its `## Retired` — and names the replacement (`-b`, `-c` …), a second live member on one ticket or PR, any implementer once the run is draining, an implementer whose row's `tier=` names no single definition or one with no file under `agents/`, and a finisher on a ledger the tick itself refuses.", "ledger.mjs dispatch; tests/ledger-dispatch.test.mjs"],
  ["It refuses a write that adds a `review=`/`reviewed=` token (one the row already holds is carried), and one after which a PR maps to more than one row when it did not before — `row <M>` creating `#M` for a PR a ticket row maps, or a rewrite adding a `PR#M` mention to another row — naming the PR's row (`settle impl-N=PR#M` applies the same rule after its fold).", "ledger.mjs row and review; tests/ledger-row-review.test.mjs"],
  ["It then records each `unrecorded` filing in **filed** and, for a fix-applier, each refutation the report defers in **ruled**, once however often it runs, and prints `{member, outcome, checks, filed, ruled}`.", "ledger.mjs filed and ruled; references/ledger.md"],
  ["Never rotate mid-run: it is phase 0's step alone.", "references/phase-0.md's Rotate the ledger"],
  ["No launch appears while an earlier one is open — unanswered and not `=failed`.", "ledger.mjs review; tests/ledger-row-review.test.mjs"],
  ["One git-ignored `.fleet/ledger.md` per run, updated at **every** state change via `~/.fleet/bin/fleet-run ledger.mjs` subcommands (`row`, `filed`, `ruled`, `check`, `read`, `dispatch`, `settle`, `review`, `drain`, `rotate`).", "references/ledger.md; ledger.mjs"],
  ["Outcomes: `impl-N` = `PR#M | bailed | released | killed | tier-mismatch | blocked`; `fix-pr-M` = `applied:<head> | no-op | failed | killed`; `finisher-pr-M` = `labelled | failed | killed | halted:<cause>`, `<cause>` one of `live-editor | rebase | past-pin | unreadable | missing | absent | other` (**Resolving a finisher halt**); `merge-bot-n` = `done | killed`.", "ledger-grammar.mjs's outcome vocabulary; tests/ledger-grammar.test.mjs"],
  ["Phase 0 rotates it before anything reads it, so no exclusion, filing, ruling or drain marker outlives the run that wrote it, and no row does either — except, when the previous run was this session's own, a row still carrying a live token, which rotate carries forward with its live `## Dispatched` entries (phase 0).", "references/phase-0.md's Rotate the ledger"],
  ["Plus two append-only lists:", "ledger.mjs rotate; tests/ledger-rotate.test.mjs"],
  ["Refused while the recorded controller is alive and not this run's ancestor, ledger or none — or, with no record and a ledger to move, while the heartbeat mark is still beating, or a tick or ledger write is inside its window with no beat — or when the archive name already exists, the process table cannot be read, or `.fleet/heartbeat.json` exists but cannot be used (unreadable, not JSON, not an object, or a `controller` it cannot judge); with no ledger and no such refusal it moves nothing and exits 0.", "ledger.mjs rotate; tests/ledger-rotate.test.mjs"],
  ["**ruled** (`ledger.mjs ruled <pr> <decision>`) — PR + decision + one-line reason, so a replacement controller does not re-litigate a settled call.", "references/ledger.md's filed-and-ruled section; ledger.mjs ruled"],
  ["The bare form above, for an outcome a report carries, warns `settled without --from-report` on stderr.", "ledger.mjs settle; tests/ledger-settle-report.test.mjs"],
  ["The FILER writes this one, not you: `review-and-fix.md` step 5 and finisher duty 2 each run `filed` immediately after their own `gh issue create`, with the subject they passed to `check`, and report `filed: #N <subject>`.", "review-and-fix.md step 5; finisher duty 2"],
  ["The guard is stated in references/phase-0.md, \"Rotate the ledger\".", "references/phase-0.md's Rotate the ledger"],
  ["Then it records this run's controller in `.fleet/heartbeat.json`.", "references/phase-0.md's Rotate the ledger"],
  ["Write `label-off=<latest finisher attempt>` onto the PR's row first (`ledger.mjs token <PR number> label-off=<latest finisher attempt>`, which keeps every token the row already has — **Run ledger**), then remove `ready-to-merge`, then approve.", "SKILL.md's wake section (Once the label is on)"],
  ["Write neither by hand:", "references/ledger.md's writer policy"],
  ["**`ledger.mjs drain \"<reason>\"`** — the one drain marker per run; supply stops, the review and merge sides keep going.", "ledger.mjs drain; tests/ledger-dispatch.test.mjs"],
  ["**The file lives one run.**", "references/ledger.md's one git-ignored `.fleet/ledger.md` per run sentence"],
  ["See references/ledger.md.", "the pointers now inline in SKILL.md's wake section and failure table"]
];

const oldSentences = () => counted(sentencesOf(readFileSync(FIXTURE, "utf8")));
const referenceFiles = () => readdirSync(REFERENCES).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(join(REFERENCES, f), "utf8"));
const newSentences = () => counted([...sentencesOf(SKILL), ...referenceFiles().flatMap(sentencesOf)]);

test("every sentence of the pre-rewrite SKILL.md is in SKILL.md or across references/ as often as it was said, but for the changed and the deleted", () => {
  const was = oldSentences();
  assert.ok(was.size > 1000, `the fixture read as ${was.size} distinct sentences — the fixture or the splitter is broken`);
  const now = newSentences();
  const excused = new Set([...CHANGED.map(([from]) => from), ...DELETED.map(([from]) => from)]);
  const lost = [];
  for (const [s, n] of was) {
    if (excused.has(s)) continue;
    const found = now.get(s) ?? 0;
    if (found < n) lost.push(`${found}× (said ${n}×) ${s}`);
  }
  assert.deepEqual(lost, [], "sentences the rewrite lost");
  const missing = CHANGED.filter(([, to]) => (now.get(to) ?? 0) < 1).map(([from]) => from);
  assert.deepEqual(missing, [], "changed sentences whose replacement is not in SKILL.md or across references/");
  for (const [from] of [...CHANGED, ...DELETED]) assert.ok(was.has(from), `a changed or deleted sentence the fixture never said: ${from}`);
});

// The changed and the deleted are only excused above, which says nothing about
// one coming back. A changed sentence's pre-rewrite half is said nowhere now. A
// deleted sentence is said at most as often as the fixture said it, less once
// for each time it is listed deleted, so a pointer dropped at one site while
// other sites keep saying it still counts.
test("no changed sentence's pre-rewrite half is in SKILL.md or across references/, and no deleted sentence is said as often as before", () => {
  const was = oldSentences();
  const now = newSentences();
  const back = [];
  for (const [from] of CHANGED) if ((now.get(from) ?? 0) > 0) back.push(`changed, still said ${now.get(from)}×: ${from}`);
  const listed = counted(DELETED.map(([from]) => from));
  for (const [from, k] of listed) {
    const allowed = (was.get(from) ?? 0) - k;
    if ((now.get(from) ?? 0) > allowed) back.push(`deleted, said ${now.get(from)}× (fixture ${was.get(from)}×, listed ${k}×): ${from}`);
  }
  assert.deepEqual(back, [], "changed or deleted sentences said again");
});

// --- the three blocks that moved whole ----------------------------------------

const fixtureText = () => readFileSync(FIXTURE, "utf8");
const cut = (text, start, stop) => Pin.of(text, "the fixture").between(start, stop, "the moved block").text;
// The two lines SKILL.md keeps word for word as its one-liner: already one line.
const KEPT_VERBATIM = new Set(["A reviewer never reviews a PR it implemented.", "`AT CAP`, `IDLE OK` — nothing to do on that row."]);
const MOVED_BLOCKS = [
  ["Shell traps", () => cut(fixtureText(), "## Shell traps\n", "\n## Phase 0 — shortlist")],
  ["the invariants' full statements", () => cut(fixtureText(), "## Invariants\n", "\n## Guards")],
  ["the tick rows' full text", () => cut(fixtureText(), "- `PULL #<N> …`", "\n**Tier guards under Pull.**")],
];

for (const [what, block] of MOVED_BLOCKS) {
  test(`${what}: every sentence is across references/ as often as it was said, and none is in SKILL.md`, () => {
    const was = counted(sentencesOf(block()));
    assert.ok(was.size >= 5, `${what} read as ${was.size} sentences — the fixture or the splitter is broken`);
    const refs = counted(referenceFiles().flatMap(sentencesOf));
    const skill = counted(sentencesOf(SKILL));
    const excused = new Set([...CHANGED, ...DELETED].map(([from]) => from));
    const lost = [];
    const stayed = [];
    for (const [s, n] of was) {
      if (excused.has(s)) continue;
      if ((refs.get(s) ?? 0) < n) lost.push(s);
      if ((skill.get(s) ?? 0) > 0 && !KEPT_VERBATIM.has(s)) stayed.push(s);
    }
    assert.deepEqual(lost, [], `sentences of ${what} the references lost`);
    assert.deepEqual(stayed, [], `sentences of ${what} SKILL.md still says`);
  });
}

test("SKILL.md's invariant for ready-to-merge keeps the metrics-PR exemption and the duty it licenses on its own line", () => {
  const line = SKILL.split("\n").find((l) => l.startsWith("- `ready-to-merge` is added by a reviewer only"));
  assert.match(line, Pin.phrase("but for the run's own artifact PR, which this line does not reach"));
  assert.match(line, Pin.phrase("label and merge that one yourself"));
});

// A one-line row is the rule's whole meaning for a controller that reads only
// SKILL.md: the qualifier the full row carries goes on the line too.
const rowLine = (name) => SKILL.split("\n").find((l) => l.startsWith(`- ${name} — `));

test("the MAIN-CHECKOUT-UNKNOWN row keeps the exception to never recording over it", () => {
  const line = rowLine("`MAIN-CHECKOUT-UNKNOWN …`");
  assert.match(line, Pin.phrase("never `--record` over it unless the line itself says re-record"));
});

test("the SETTLE row sends the controller to the report wake, which does the work a bare settle does not", () => {
  const line = rowLine("`SETTLE <member> (report on disk …)`");
  assert.match(line, Pin.phrase("run that member's report wake from the wake table"));
});

test("the DISPATCH fix-pr row names the next suffix when the member name is already on record", () => {
  const line = rowLine("`DISPATCH fix-pr PR#<M> …`");
  assert.match(line, Pin.phrase("`ledger.mjs dispatch <M> fix-pr-<M>` (the next suffix when that name is already on record)"));
});
