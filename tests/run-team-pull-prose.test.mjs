// run-team's phase 1 is the `pull.mjs` protocol: the tick's PULL rows, the
// questions with their tokens, and the guidance for answering them. Every
// other paragraph of phase 1, and the three mechanical paragraphs of phase 2,
// moved into references/pull.md, the reused-worktree ones into
// references/isolation.md. These pins hold what only the runbook carries about
// that move:
//
//   - nothing the move took out of SKILL.md was lost: the fixture
//     tests/fixtures/run-team-moved-text/phase-1-2-pull.txt is the removed
//     text, owned by this test — each sentence as the reference file now says
//     it, where the move corrected one — and every sentence of it is found as
//     often as it was said across references/, and not at all in SKILL.md;
//   - phase 1 stays short, and its two judgement tables stay byte-identical;
//   - the rows, tokens and exits phase 1 names are the ones the tick and
//     pull.mjs print and take;
//   - each reduced phase 2 paragraph is one sentence naming the pull.mjs step.
//
// THE CEILING shared with every prose pin here: this proves text is PRESENT,
// not that no sentence beside it negates it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { parseAnswer } from "../plugin/scripts/pull.mjs";

const RUN_TEAM_DIR = join(import.meta.dirname, "..", "plugin", "skills", "run-team");
const REFERENCES = join(RUN_TEAM_DIR, "references");
const FIXTURE = join(import.meta.dirname, "fixtures", "run-team-moved-text", "phase-1-2-pull.txt");
const SKILL = readFileSync(join(RUN_TEAM_DIR, "SKILL.md"), "utf8");
const PULL_MD = readFileSync(join(REFERENCES, "pull.md"), "utf8");

const flat = (text) => text.replace(/\s+/g, " ").trim();

// Every reference file, whitespace-flattened, joined by a character no sentence
// holds, so a sentence cannot be matched across two files.
const referenceCorpus = () =>
  readdirSync(REFERENCES)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => flat(readFileSync(join(REFERENCES, f), "utf8")))
    .join("\u0000");

const occurrences = (haystack, needle) => {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n += 1;
  return n;
};

// The removed text as sentences. A numbered step's ordinal ("2.") splits off as
// a sentence of its own and claims nothing, so it is no sentence here.
const removedSentences = () => Pin.sentences(flat(readFileSync(FIXTURE, "utf8"))).filter((s) => s !== "" && !/^\d+\.$/.test(s));

const section = (from, to) => {
  const at = SKILL.indexOf(from);
  const end = SKILL.indexOf(to);
  assert.ok(at !== -1 && end > at, `${from} moved — re-anchor this test, never widen it`);
  assert.equal(SKILL.indexOf(from, at + 1), -1, `${from} occurs twice`);
  return SKILL.slice(at, end);
};
const phase1 = () => section("## Phase 1 — Pull", "### Dispatching the Pull's member");

// --- nothing the move took out is lost ----------------------------------------

// The runner brief was written twice on purpose — phase 1's Materialize
// paragraph and isolation.md's rationale for it, pinned together by
// agent-test-dir-prose — and isolation.md's copy already said this sentence
// word for word. The paragraph moved verbatim into pull.md, so the sentence is
// owed once by the move and once by isolation.md's own copy; nothing else is.
const ALREADY_IN_REFERENCES = new Set([
  "Its arguments land after the Test entrypoint, so what one may name — a test file, a test name — is that entrypoint's to say, and nothing in the runner refuses one that selects no test: a run of zero tests is a failed run, not a pass.",
]);

test("every sentence removed from phases 1 and 2 is found across references/ as often as the removed text said it", () => {
  const sentences = removedSentences();
  assert.ok(sentences.length > 100, `the fixture read as ${sentences.length} sentences — the fixture or the splitter is broken`);
  const owed = new Map();
  for (const s of sentences) owed.set(s, (owed.get(s) ?? 0) + 1);
  for (const s of ALREADY_IN_REFERENCES) {
    assert.ok(owed.has(s), `the fixture no longer says: ${s}`);
    owed.set(s, owed.get(s) + 1);
  }
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

test("no sentence removed from phases 1 and 2 is still in SKILL.md", () => {
  const skill = flat(SKILL);
  assert.deepEqual(removedSentences().filter((s) => skill.includes(s)), [], "sentences the move took out that SKILL.md carries again");
});

test("the fixture is the text the move removed: from the steps' lead-in to the phase 2 prompt paragraph", () => {
  // Anchors on its first and last sentence and on one sentence of each moved
  // block, so a fixture trimmed to make the test pass is caught here.
  const f = flat(readFileSync(FIXTURE, "utf8"));
  assert.ok(f.startsWith("The steps below are what the driver runs"), "the fixture lost its first sentence");
  assert.ok(f.endsWith("so the member's own re-derive step knows the controller's probe could not look."), "the fixture lost its last paragraph");
  for (const s of [
    "**No ancestry check on what that walk printed.**",
    "**The Pull table** — every verdict a Pull can reach",
    "**Relabel by cause.**",
    "**A reused worktree may lack the runner.**",
    "**Claim what you are about to dispatch; dispatch what you have just claimed.**",
    "**Record the dispatch before you make it.**",
    "**The prompt carries only what varies.**",
  ]) assert.ok(f.includes(s), `the fixture lost: ${s}`);
});

test("the reused-worktree paragraphs moved to references/isolation.md, the rest to references/pull.md", () => {
  const iso = flat(readFileSync(join(REFERENCES, "isolation.md"), "utf8"));
  for (const s of ["**A reused worktree may lack the runner.**", "**A reused worktree may also be on the wrong COMMIT.**", "**The two reuse failures are not symmetric.**"]) {
    assert.ok(iso.includes(s), `isolation.md lacks: ${s}`);
  }
  const pull = flat(PULL_MD);
  for (const s of ["**Still live?**", "**Both halves of that command are load-bearing.**", "**Exclusion is a ticket row with a premise.**", "**Claiming.**"]) {
    assert.ok(pull.includes(s), `pull.md lacks: ${s}`);
  }
});

test("references/pull.md carries no issue, pull request or ADR number: plugin/skills ships", () => {
  const hits = PULL_MD.match(/(?<![\w&])#\d+\b|\bADR[ -]?\d+|\b(?:issue|PR|pull request)\s+#?\d+/gi) ?? [];
  assert.deepEqual(hits, []);
});

// --- phase 1 stays short, its tables byte-identical ------------------------

test("phase 1 is under 120 lines", () => {
  const lines = phase1().replace(/\n+$/, "").split("\n").length;
  assert.ok(lines < 120, `phase 1 is ${lines} lines`);
  assert.ok(lines > 40, `phase 1 sliced down to ${lines} lines — the extractor is broken, not the docs`);
});

const DECIDED_TABLE = `   | Left open | Verdict |
   |---|---|
   | architecture, API shape, schema, UX | **undecided** |
   | new dependency, new seam | **undecided** |
   | naming, file layout, ordering, test arrangement | decided — ignore |
`;
const VERDICT_TABLE = `   | Exit | Verdict | What it does at the Pull |
   |---|---|---|
   | 0 | still reproduces | admit it |
   | 1 | provably fixed | do not admit; close citing the payload's \`commit\` and \`subject\` |
   | 2 | could not check | admit it, **and say the probe could not check** |
`;

for (const [name, table] of [["Decided? inventory", DECIDED_TABLE], ["staleness.mjs verdict", VERDICT_TABLE]]) {
  test(`phase 1 holds the ${name} table byte-identical, once`, () => {
    assert.equal(occurrences(phase1(), `\n${table}\n`), 1, `the ${name} table is not in phase 1 byte for byte, or is there twice`);
    assert.equal(occurrences(SKILL, table), 1, `the ${name} table is in SKILL.md more than once`);
  });
}

test("phase 1 keeps the asked-for-change rule and states the relabelled re-admission as the script's exit", () => {
  const p = flat(phase1());
  assert.ok(p.includes("**Grep for the ticket's ASKED-FOR CHANGE, not only its subject construct**"));
  assert.ok(p.includes("**A Pull never re-admits a ticket already relabelled**: the issue step reads the labels fresh and exits 1 `relabelled elsewhere`"));
});

test("SKILL.md sends the controller to references/pull.md and references/isolation.md from phase 1", () => {
  const p = flat(phase1());
  assert.ok(p.includes("See references/pull.md for what each step does, and why."));
  assert.ok(p.includes("is in references/isolation.md."));
});

// --- what phase 1 names is what the scripts print and take ----------------

test("phase 1 names each PULL row the tick prints for a head", () => {
  const p = phase1();
  for (const row of [
    "`PULL #N — pull.mjs next --head N`",
    "`PULL #N (Q2 pending — pull.mjs answer N decided …)`",
    "`… (stale)`",
    "`PULL #N (dispatched, row missing — ledger.mjs row N \"…\")`",
    "`--pull-stale-minutes` (120 by default)",
  ]) assert.ok(p.includes(row), `phase 1 does not name the row ${row}`);
  // The same wording the tick prints, read off its source.
  const tick = readFileSync(join(import.meta.dirname, "..", "plugin", "scripts", "fleet-tick.mjs"), "utf8");
  for (const said of ["pending — pull.mjs answer ${n} ${p.qid} …)", "(dispatched, row missing — ledger.mjs row ${n} ", "— pull.mjs next --head ${n}", '"pull-stale-minutes": { type: "string", default: "120" }']) {
    assert.ok(tick.includes(said), `fleet-tick.mjs no longer prints ${said}`);
  }
});

// Each token phase 1 spells, as a command line would give it, and the question
// it is spelled under. Every one must be a token pull.mjs takes.
const TOKENS = [
  ["staleness", "gone", ["--path", "p", "--", "s"]], ["staleness", "present", ["--path", "p", "--", "s"]],
  ["staleness", "none", ["why"]], ["staleness", "done", []],
  ["close", "yes", []], ["close", "no", ["why"]],
  ["decided", "decided", []], ["decided", "needs-triage", ["the missing decision"]],
  ["decided", "ready-for-human-fork", ["the options"]], ["decided", "ready-for-human-hands", ["judgment", "a line"]],
  ["collision", "clear", []], ["collision", "behind-pr:#12", []], ["collision", "behind-issue:#12", []], ["collision", "paths", ["a/b.mjs"]],
];

test("every token phase 1 gives a question is one pull.mjs takes for it", () => {
  for (const [qid, token, rest] of TOKENS) assert.doesNotThrow(() => parseAnswer(qid, token, rest), `${qid} ${token}`);
});

test("phase 1 spells each question's tokens under its own number", () => {
  const p = flat(phase1());
  const item = (head, next) => {
    const at = p.indexOf(head);
    assert.notEqual(at, -1, `phase 1 has no ${head}`);
    return p.slice(at, next === null ? undefined : p.indexOf(next, at));
  };
  const q1 = item("1. **`staleness` (Q1)**", "2. **`close` (Q1b)**");
  const q1b = item("2. **`close` (Q1b)**", "3. **`decided` (Q2)**");
  const q2 = item("3. **`decided` (Q2)**", "4. **`collision` (Q3)**");
  const q3 = item("4. **`collision` (Q3)**", "**A Pull never re-admits");
  for (const [said, where] of [
    ["`gone --path <p> [--] <string>`", q1], ["`present --path <p> [--] <string>`", q1], ["`none <why>`", q1], ["`done`", q1],
    ["`yes`", q1b], ["`no <why>`", q1b],
    ["`decided`", q2], ["`needs-triage <the missing decision>`", q2], ["`ready-for-human-fork <the options, verbatim from the brief>`", q2],
    ["`ready-for-human-hands <external access|manual testing|judgment> <one line>`", q2],
    ["`clear`", q3], ["`behind-pr:#M`", q3], ["`behind-issue:#M`", q3], ["`paths <p>…`", q3],
  ]) assert.ok(where.includes(said), `phase 1 does not spell ${said} under its question`);
});

test("the exit table names every exit pull.mjs's header lists", () => {
  const header = readFileSync(join(import.meta.dirname, "..", "plugin", "scripts", "pull.mjs"), "utf8").split("// THE STEPS")[0];
  const exits = [...header.matchAll(/^\/\/ {3}(\d+) {2,}/gm)].map((m) => m[1]);
  assert.deepEqual(exits, ["0", "1", "2", "3", "10"], "pull.mjs's EXITS block changed — re-read it");
  const table = phase1().slice(phase1().indexOf("**The exit table**"));
  for (const e of exits) assert.match(table, new RegExp(`^\\| ${e}\\b`, "m"), `the exit table has no row for exit ${e}`);
});

