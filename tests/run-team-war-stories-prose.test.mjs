// run-team's SKILL.md says the war story behind a rule lives in references/ and
// is read only when a member needs the why. Every SKILL.md paragraph that said
// `measured` moved verbatim to the references/ file for its topic, under a
// heading naming the rule it justifies; the rule kept one clause in SKILL.md and
// a `See references/<file>` pointer beside it. These pins hold what only the
// runbook carries about that move:
//
//   - nothing the move took out was lost: the fixture
//     tests/fixtures/run-team-moved-text/measured-war-stories.txt is the removed
//     text exactly as the pre-move SKILL.md said it, owned by this test, and
//     every sentence of it — after CORRECTIONS below — is found as often as it
//     was said across references/, and, but for a kept clause, not in SKILL.md;
//   - each moved paragraph sits under its heading in its reference file, and
//     its rule's kept clause sits beside the pointer to that file in SKILL.md —
//     but for the Shell traps rules, whose clauses sit in
//     references/shell-traps.md with no pointer;
//   - SKILL.md says `measured` only on a line carrying a pointer, and every
//     reference file SKILL.md cites exists.
//
// THE CEILING shared with every prose pin here: this proves text is PRESENT,
// not that no sentence beside it negates it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const RUN_TEAM_DIR = join(import.meta.dirname, "..", "plugin", "skills", "run-team");
const REFERENCES = join(RUN_TEAM_DIR, "references");
const FIXTURE = join(import.meta.dirname, "fixtures", "run-team-moved-text", "measured-war-stories.txt");
const SKILL = readFileSync(join(RUN_TEAM_DIR, "SKILL.md"), "utf8");
const OUT_OF_SCOPE = join(import.meta.dirname, "..", ".out-of-scope", "fleet-prompt-doc-duplication.md");

const flat = (text) => text.replace(/\s+/g, " ").trim();
const reference = (file) => readFileSync(join(REFERENCES, file), "utf8");

// Every reference file, whitespace-flattened, joined by a character no sentence
// holds, so a sentence cannot be matched across two files.
const referenceCorpus = () =>
  readdirSync(REFERENCES)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => flat(reference(f)))
    .join("\u0000");

const occurrences = (haystack, needle) => {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n += 1;
  return n;
};

// What the move changed in the text it carried, each applied to the fixture
// before its sentences are looked for in references/. A tracker number does not
// ship (plugin/skills ships), so a member named by its PR number is named by
// placeholder; a positional pointer whose target stayed in SKILL.md would point
// at nothing in the reference file, so it names where the target is.
const CORRECTIONS = [
  ["`fix-pr-1184` backgrounded its suite", "`fix-pr-<M>` backgrounded its suite"],
  ["`finisher-pr-1184` reached", "`finisher-pr-<M>` reached"],
  ["`pgrep -f 'finish-finisher-pr-1184'`", "`pgrep -f 'finish-finisher-pr-<M>'`"],
  [
    "**A member runs its test suite in the foreground** above, where `fix-pr-1184`",
    "**A member runs its test suite in the foreground** in references/member-lifecycle.md, where `fix-pr-<M>`",
  ],
  ["Every degraded branch above falls through", "Every degraded branch of SKILL.md's watcher block falls through"],
  ["`fix-pr-983` nearly reported", "one fix-applier nearly reported"],
  ["while `fix-pr-1153` nearly retired", "while another nearly retired"],
  ["the test-run verdict rule below", "the test-run verdict rule in SKILL.md"],
  ["tree every member can write to** above)", "tree every member can write to** in SKILL.md)"],
  ["so the killed row above does not", "so the killed row of SKILL.md's Failure handling table does not"],
  ["Member unaccounted row above, never", "Member unaccounted row of that table, never"],
  ["**Phase 2** carries all three rules to every member.", "**Dispatching the Pull's member** carries all three rules to every member."],
  [
    "so `git push origin \"HEAD:$(git branch --show-current)\"` exits 128 on `fatal: invalid refspec 'HEAD:'`.",
    "so `~/.fleet/bin/fleet-run push-sync.mjs --branch \"$(git branch --show-current)\"` is handed an empty branch and exits 2 before pushing anything.",
  ],
  ["is what Phase 3's block uses", "is what the watcher block under **Own the CI waits** uses"],
];

// The removed text as its blocks — paragraphs, a table, a code block — each
// whitespace-flattened and joined by a character no sentence holds: a block that
// ends without a full stop (a table, a code span, a colon before a block) would
// otherwise run into the next block's first sentence.
const blocksOf = (raw) =>
  raw
    .split(/\n[ \t]*\n/)
    .map(flat)
    .filter((b) => b !== "")
    .join("\u0000");
const fixtureText = () => blocksOf(readFileSync(FIXTURE, "utf8"));
const corrected = () => {
  let f = fixtureText();
  for (const [from, to] of CORRECTIONS) {
    assert.equal(occurrences(f, from), 1, `a correction's original is not in the fixture exactly once: ${from}`);
    f = f.replace(from, to);
  }
  return f;
};

// A moved list item's marker and a numbered step's ordinal claim nothing, so
// neither is part of the sentence a reference file has to carry.
const sentencesOf = (f) =>
  f
    .split("\u0000")
    .flatMap((block) => Pin.sentences(block))
    .map((s) => s.replace(/^(?:\d+\.|-)\s+/, ""))
    .filter((s) => s !== "" && !/^\d+\.$/.test(s));

// The watcher block's comment kept its rule sentence in place; only the
// measured sentence after it moved, so this clause is SKILL.md's, not the
// fixture's.
const WATCHER_COMMENT_CLAUSE = "REST units per listed PR on top of the 200 floor.";

// Each moved paragraph: the reference file it moved to; the heading it sits
// under there; the rule clause SKILL.md kept, word for word from the paragraph,
// with the pointer straight after it (null: the paragraph stated no rule); and
// the paragraph's first sentence as the reference file says it; and, where the
// bold lead only describes and the imperative sentence went with the story, the
// imperative SKILL.md keeps between the clause and the pointer, written for
// SKILL.md rather than moved.
const MOVED = [
  ["member-lifecycle.md", "A missing report is not evidence the member failed to send one", 'So when a report is missing, **ask by name — that is what the "unless the controller asks by name" clause is for — and do not attribute the gap to the member until it answers.**', "**But a missing report is NOT evidence the member failed to send one — the inbound direction drops AND delays messages.**"],
  ["member-lifecycle.md", "A missing report is not evidence the member failed to send one", "The ask is the controller's move, not the member's.", "Note this cuts against the paragraph above only in appearance: the default stays *send once*, because unprompted re-sends were measured 2-to-1 false."],
  ["instruments.md", "Re-check your instruments before every gate decision", "**You read your instruments out of a tree every member can write to — re-check them before every gate decision.**", "Per-member worktrees and `./agent-test`'s port derivation protect members from each other;"],
  ["member-lifecycle.md", "A member runs its test suite in the foreground and blocks on it", "**A member runs its test suite in the foreground and blocks on it.**", "Backgrounding a suite and polling for it makes the member's own progress depend on a wake-up nothing in the fleet guarantees,"],
  ["shell-traps.md", "zsh splits a command substitution, never an unquoted parameter expansion", "**zsh word-splits an unquoted command substitution's result; it does NOT split an unquoted parameter expansion.**", "That one difference is the whole rule, and the hazard is the **assigned-variable** form, never `$(…)`."],
  ["shell-traps.md", "Word the rule against the first row", "**Word the rule against the first row.**", "A warning spelled *never `for x in $(…)`* names the safe form as the hazard,"],
  ["shell-traps.md", "The inline `$(printf …)` form splits on every whitespace character", "it splits on *every* whitespace character, so it is safe only for values that cannot contain one — PR numbers cannot, branch names and paths can.", "Measured on a two-line list whose first value is `two words`:"],
  ["shell-traps.md", "`</dev/null` every command inside a `while read` loop", "**`</dev/null` every command inside a `while read` loop.**", "The loop's stdin *is* the list, and any inner command that reads stdin eats the rest of it."],
  ["shell-traps.md", "`status` is a read-only variable in zsh", "**`status` is a READ-ONLY variable in zsh**, an alias for `$?`.", "So the obvious bash idiom for reading the payload — `status=$(jq -r '.status' ci.json)` — aborts with `read-only variable: status`.", "Name the variable anything else (`ci_status`)."],
  ["pull.md", "Every 5th Pull goes at an exploration cell", "**Every 5th Pull by ledger count goes at an exploration cell.**", "Count the `impl-` rows in `.fleet/ledger.md` at Pull time;"],
  ["pull.md", "The readout counts deliberate comparisons", "**The readout counts DELIBERATE comparisons.**", "An earlier rule asked only for a `session`+`role` carrying more than one distinct `model`,"],
  ["reviewers.md", "A sizing verdict is a measurement only if it post-dates the run that produced it", "**A verdict is a measurement only if it post-dates the run that produced it.**", "A `Sizing:` line typed in before the skill ever ran is byte-identical to one the skill produced,"],
  ["pull.md", "Why the implementer body carries enumerate-and-declare", "Why the agent body carries what it does — read this before editing any `fleet-implementer-<cell>` file, and keep every cell's body byte-identical.", "**Enumerate-and-declare** answers a signature measured four times in one run:"],
  ["ci-and-staleness.md", "Beat when there is nothing to do, and never end your turn on a drained queue", "**Beat when there is nothing to do, and never end your turn on a drained queue.**", "You cannot be woken."],
  ["ci-and-staleness.md", "A conclusion is not stable, even for a fixed run id on an unchanged head", "**A conclusion is not stable, even for a fixed run id on an unchanged head.**", "**Building that key with jq's `//` is the same bug in the opposite direction**:", "Never cache a conclusion, and test any fallback you write against `\"\"`, `null` AND a real conclusion."],
  // A code comment in the watcher block: its measured sentence moved, the code stayed.
  ["ci-watcher.md", "The pass is budgeted at 4 core REST units per listed PR", WATCHER_COMMENT_CLAUSE, "The 4 is the measured ceiling of one ci-state.mjs call on the counter `gh api rate_limit` reports,"],
  ["ci-watcher.md", "One gate, not a gate plus a caveat", "**One gate, not a gate plus a caveat.**", "`jq -e '.verdict and .verdict != \"rate-limited\"'` exits non-zero on unparseable input *and* on a false result,"],
  ["ci-watcher.md", "All pacing in exactly one place — the tick loop's own tail `sleep`", "**All pacing in exactly one place — the tick loop's own tail `sleep`.**", "A sleep inside the per-PR pass multiplies by the number of open PRs"],
  ["ci-watcher.md", "The budget is gated at the floor and again at the pass", "**The budget is gated at the floor and again at the pass, and only the pass gates announce recovery.**", "The 4 is the measured ceiling of one `ci-state.mjs` call's cost on the counter `gh api rate_limit` reports (measured 2026-10-13):"],
  ["ci-watcher.md", "Do not back off and wait", "**Do not back off and wait.**", "These outages are short — a rolling window; one measured reset came 24 seconds after `remaining: 0` —"],
  ["reviewers.md", "Know the trim before you rely on it", "**Know the trim before you rely on it — it is wider than `docsOnly` suggests.**", "Measured: a docs PR that also adds one test file is profile `tests-only` and runs **three** (correctness+tests+comments), not six;"],
  ["reviewers.md", "A refutation needs its positive control", "**A refutation resting on an injection nothing proved landed is not a refutation — it is a cell that never ran.**", "So a negative result is admitted only together with its **positive control**"],
  ["reviewers.md", "Where `<branch>` comes from", "**Where `<branch>` comes from:** the PR's head branch — `gh pr view <N> --json headRefName -q .headRefName`, or the same branch you cut the worktree from.", "(measured 2026-09-18, git 2.50.1)"],
  ["finisher.md", "An unanswered question from the member is an outbox item", "**An unanswered question from the member is an outbox item, and it blocks dispatch with the same weight as a ruling you have already made.**", "That worked because the controller chose to hold, not because a rule required it."],
  // The finisher's duty-2 rules left SKILL.md with its event loop (#3540): each
  // is stated in agents/fleet-finisher.agent.md, the finisher's system prompt,
  // and pinned there by finisher-own-tree-prose and dedupe-guard-prose, so
  // SKILL.md keeps no clause of them, only phase 2's pointer to references/finisher.md.
  ["finisher.md", "Duty 2: every deferral, and every claimed APPLY, has a home that outlives the merge", null, "The test is a durable home, not a tracker number:"],
  ["finisher.md", "`origin/main...HEAD` is right for the positive check and wrong for a negative one", null, "Measured on one PR: a controller wrote \"neither document was touched\" against `origin/main...HEAD`"],
  ["finisher.md", "Whatever you verify by running, run in a tree nobody else owns", null, "Measured once: a finisher was inside that worktree at the instant the fix-applier announced one more clause to land,"],
  ["finisher.md", "Remove the verification worktree on every path", null, "(`contains modified or untracked files`, rc 128, directory left on disk — measured, git 2.50.1)"],
  ["correction-tickets.md", "Every implementer body carries the claim discipline", "**Every implementer body carries the claim discipline, because tickets that restate facts ship new wrong claims** — inherited from the ticket, and minted in prose nobody asked for.", "It was measured on tickets that would have been judged routine too:"],
  ["correction-tickets.md", "A settling command over literal text uses `grep -F`", "**A settling command over literal text uses `grep -F`, and its zero counts only after the same command finds a line known to match.**", "Measured once: `grep -c 'settled by:\\s+x'` answers 0 against a file holding that exact line, and `grep -cF` answers 1."],
  // The section's provenance line: it stated no rule, so nothing stayed behind.
  ["isolation.md", "Where the omp probes ran", null, "Measured 2026-09-09 in a throwaway clone (`/tmp/fleet-probe`) that never touched the real checkout."],
  ["isolation.md", "A fleet member is never dispatched with omp's `isolated: true`", "**A fleet member is never dispatched with omp's `isolated: true`.**", "Measured: an isolated spawn builds its workspace under `~/.omp/wt/<hash>/m`"],
  ["isolation.md", "A member's tree is the claimed worktree, addressed by absolute path", "**A member's tree is the claimed worktree, addressed by absolute path.**", "(**You read your instruments out of a tree every member can write to** in SKILL.md)"],
  ["isolation.md", "`task` does not accept a per-dispatch working directory", "**The one open gap that probe measured: `task` does not accept a per-dispatch working directory.**", "`omp://tools/task.md` documents non-isolated spawns as running `runSubprocess(...)` \"directly with parent cwd\""],
  ["isolation.md", "`task`-dispatched members share one `eval` kernel", "**The same gap reaches past the filesystem: `task`-dispatched members share one `eval` kernel.**", "Measured 2026-09-21, in a live run rather than a probe clone:"],
  ["isolation.md", "`release-ticket.sh` is not a no-op on omp, and a running member hides nothing from `inflight.sh`", "**`release-ticket.sh` is not a no-op on omp, and `inflight.sh`'s probes are unaffected by a running member.**", "Measured against a hand-built claim (a branch plus a `git worktree add`) with a member sleeping inside it:"],
  ["pull.md", "Default: In-flight bound 5", "**Default: In-flight bound 5, fixed for the run.**", "5 keeps worst-case review concurrency below the former reviewer count of 6 and sits near the measured mean In flight of 5.6."],
  ["isolation.md", "A pattern kill reaches siblings", "**A pattern kill reaches siblings — the implementer, fix-applier and finisher briefs forbid it.**", "Measured: an implementer chasing its own stalled run issued a `pkill -f` on its test file's name"],
  ["isolation.md", "What a killed run's output looks like depends on the signal", "**What the victim's output looks like depends on the signal — and one of the cases is a clean green.**", "Each measured on node v26.8.1/darwin against a purpose-spawned fixture killed by its own PID."],
  ["isolation.md", "The command line is no partition either", "**The command line is no partition either — not reliably.**", "Measured with `ps -Ao pid,ppid,args -ww`"],
  ["merge-bot.md", "A mid-run tooling fix lands through a PR", "Plan it as a PR the run's own merge queue lands, never as an edit-and-continue.", "measured 2026-08-10 by a controller that tried exactly that at the end of a 7-PR run."],
  ["failure-handling.md", "A frozen transcript does not establish that a member is dead", "**A frozen transcript does not establish that a member is dead — the discriminator is its scratch dir.**", "Measured once: a refuter wedged forever on `until grep -q` for a marker `node --test` never writes,"],
  // The Run ledger section left SKILL.md (#3542): these three rules are stated
  // in references/ledger.md alone, and SKILL.md keeps no clause of them, only
  // the wake section's LEDGER_POINTER below.
  ["ledger.md", "Writer policy: every write is serialized by `<file>.lock`", null, "measured, 8 concurrent `filed` kept 2–5 of 8 rows."],
  ["ledger.md", "The gap the lock does not close", null, "Accepted — the measured same-run accidental duplicate was filed minutes apart —"],
  ["ledger.md", "`check`'s exits and its `verdict`", null, "and every measured stop over those was survived only by a reader who overrode it and searched the tracker by hand"],
];

// The one line still saying `measured` — a kept rule clause whose own words
// carry it, beside its pointer.
const MEASURED_LINES = [
  "**The one open gap that probe measured: `task` does not accept a per-dispatch working directory.** See references/isolation.md.",
];

// --- nothing the move took out is lost -----------------------------------------

test("every sentence the move took out of SKILL.md is found across references/ as often as the removed text said it", () => {
  const sentences = sentencesOf(corrected());
  assert.ok(sentences.length > 200, `the fixture read as ${sentences.length} sentences — the fixture or the splitter is broken`);
  const owed = new Map();
  for (const s of sentences) owed.set(s, (owed.get(s) ?? 0) + 1);
  const corpus = referenceCorpus();
  const lost = [];
  const miscounted = [];
  for (const [s, n] of owed) {
    const found = occurrences(corpus, s);
    if (found === 0) lost.push(s);
    else if (found !== n) miscounted.push(`${found}× (owed ${n}×) ${s}`);
  }
  assert.deepEqual(lost, [], "sentences removed from SKILL.md that no reference file carries");
  assert.deepEqual(miscounted, [], "sentences carried more or fewer times across references/ than the removed text said them");
});

test("no sentence the move took out is still in SKILL.md, but a kept rule clause", () => {
  const skill = flat(SKILL);
  const kept = new Set(MOVED.map(([, , clause]) => clause).filter((c) => c !== null));
  const left = sentencesOf(fixtureText()).filter((s) => skill.includes(s) && !kept.has(s));
  assert.deepEqual(left, [], "sentences the move took out that SKILL.md carries again");
});

test("the fixture is the removed text: from the first Measured paragraph to the last, and every kept clause is its own words", () => {
  // Anchors on its first and last sentence and on each moved paragraph's
  // kept clause, so a fixture trimmed to make the test pass is caught here.
  const f = fixtureText();
  assert.ok(f.startsWith("**But a missing report is NOT evidence the member failed to send one"), "the fixture lost its first paragraph");
  assert.ok(f.endsWith("from one that was never read and from one whose rows you have to read yourself."), "the fixture lost its last paragraph");
  for (const [, , clause] of MOVED) {
    if (clause !== null && clause !== WATCHER_COMMENT_CLAUSE) assert.ok(f.includes(clause), `the fixture lost, or the kept clause is not its words: ${clause}`);
  }
});

// --- each paragraph under its heading, each rule beside its pointer ------------

const keptCount = (text, clause, file) => (text.match(new RegExp(Pin.phrase(`${clause} See references/${file}`).source, "g")) ?? []).length;

// The Shell traps section moved whole into references/shell-traps.md, and none
// of its rules has a pointer beside it: each clause appears there exactly once,
// with no pointer after it.
const SHELL_TRAPS_MD = reference("shell-traps.md");

for (const [file, heading, clause, opening, imperative] of MOVED) {
  test(`references/${file} carries the paragraph under "## ${heading}"`, () => {
    const slice = Pin.file(join(REFERENCES, file)).section(`## ${heading}`, `references/${file}`).text;
    assert.match(slice, Pin.phrase(opening), `${file}'s "${heading}" section lost: ${opening}`);
  });
  if (clause === null) continue;
  const kept = imperative === undefined ? clause : `${clause} ${imperative}`;
  if (file === "shell-traps.md") {
    const clauseCount = (text, c) => (text.match(new RegExp(Pin.phrase(c).source, "g")) ?? []).length;
    test(`references/${file} keeps "${kept.slice(0, 60)}…" with no pointer`, () => {
      assert.equal(clauseCount(SHELL_TRAPS_MD, kept), 1);
      assert.equal(keptCount(SHELL_TRAPS_MD, kept, file), 0, `references/${file} points this rule at itself`);
    });
  } else {
    test(`SKILL.md keeps "${kept.slice(0, 60)}…" with See references/${file} beside it`, () => {
      assert.equal(keptCount(SKILL, kept, file), 1);
    });
  }
}

// The ACCEPT side: a kept rule hard-wrapped at the file's width, its pointer on
// the next line, is the same rule beside the same pointer.
test("a kept rule wrapped across lines still sits beside its pointer", () => {
  const clause = "**Do not back off and wait.**";
  const line = `${clause} See references/ci-watcher.md.`;
  assert.ok(SKILL.includes(line), "the accept fixture's line moved — re-anchor it");
  const wrapped = SKILL.replace(line, () => `${clause}\nSee references/ci-watcher.md.`);
  assert.notEqual(wrapped, SKILL);
  assert.equal(keptCount(wrapped, clause, "ci-watcher.md"), 1);
});

// The ledger rows above keep no clause in SKILL.md; the pointer that names
// them is what stays, in the wake section.
const LEDGER_POINTER = "The writer policy, the gap the lock does not close, and `check`'s exits:";
test("SKILL.md points at references/ledger.md for the ledger rules it no longer states", () => {
  assert.equal(keptCount(SKILL, LEDGER_POINTER, "ledger.md"), 1, "SKILL.md lost its pointer to references/ledger.md for the writer policy, the lock's gap and `check`'s exits");
});

test("SKILL.md says `measured` only on a line carrying a See references/ pointer, and these are all of them", () => {
  const lines = SKILL.split("\n").filter((l) => /measured/i.test(l));
  for (const l of lines) assert.ok(l.includes("See references/"), `a line says measured with no pointer: ${l}`);
  assert.deepEqual(lines, MEASURED_LINES);
});

test("every reference file SKILL.md cites exists", () => {
  const cited = [...new Set([...SKILL.matchAll(/references\/([\w.-]+\.md)/g)].map((m) => m[1]))];
  assert.ok(cited.length >= 13, `SKILL.md cites ${cited.length} reference files — the matcher is broken`);
  assert.deepEqual(cited.filter((f) => !existsSync(join(REFERENCES, f))), [], "SKILL.md cites a reference file that does not exist");
});

test("no reference file carries an issue, pull request or ADR number, a numbered member name or a test file name: plugin/skills ships", () => {
  for (const f of readdirSync(REFERENCES).filter((x) => x.endsWith(".md"))) {
    const text = reference(f);
    const hits = text.match(/(?<![\w&])#\d+\b|\bADR[ -]?\d+|\b(?:issue|PR|pull request)\s+#?\d+|-pr-\d+|[\w-]+\.test\.mjs/gi) ?? [];
    assert.deepEqual(hits, [], `references/${f} cites a tracker number or a test file`);
  }
});

// --- the out-of-scope record no longer reads as forbidding the move --------------

test("the duplication record's When to reconsider says the rendered briefs met its condition", () => {
  const record = Pin.file(OUT_OF_SCOPE).section("## When to reconsider", ".out-of-scope/fleet-prompt-doc-duplication.md").text;
  assert.match(record, Pin.phrase("nothing is left for a skimmed read to miss"));
  assert.match(record, /^\*\*2026-10-16\.\*\*/m, "the paragraph is not dated");
});
