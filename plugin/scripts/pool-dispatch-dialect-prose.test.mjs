// #1804, under map #1768 (spec 2026-09-24 § 2, ADR 0012). Phase 2's dispatch
// site states how a Pull puts its implementer to work: neutral prose for the
// rule that holds on both harnesses — a Pull is one claim followed by one
// dispatch of a new member under a name no member has held, and nothing holds
// a queue — with a Marked line Pair beneath it carrying each harness's own
// dispatch call.
//
// HISTORY, because the filename keeps it. This file was #1590's: the pinned
// pair then said Claude refilled a freed slot by hand while omp refilled it
// from the staged set's own `eval` workpool, which handed a queued item to a
// freed worker with no completion event. The two lines stated two mechanisms,
// so the pair sat on `KNOWN_EQUALITY_EXCEPTIONS` under #1590. The spec retired
// the pool (a pool's only refill virtue is exactly what a Pull forbids, its
// completions never arrive per member, and the alternate tier was dispatched
// outside it), so #1804 deleted the pool block with its preflight, its
// per-staged-set lifetime, its cap-vs-worker-bound rule, its pool-derived liveness,
// its item-vs-context split, its blocked-only wait and its lost-kernel rule —
// and the tests that pinned them, per spec § 2's change surface. What survives
// is retargeted to the new Pair below: the neutral rule, each line's content
// and foreign-token half, the divergence classification — and the equality
// half now in the OTHER direction: the two lines differ only in the dispatch
// tool, so the pair must pass the equality bar with NO exception.
//
// MARKED-PAIR DISCIPLINE (ADR 0004 point 6, #1299's ruling). Each line is its
// own one-line slice — never the section — pinned on its own content AND with
// a `doesNotMatch` for the other harness's tool tokens, so an inversion in one
// dialect cannot pass on the other. Both slices nest INSIDE `section()`, never
// off the file-wide `RUN_TEAM` string: `run-team/SKILL.md` carries other pairs,
// and a file-wide `indexOf("OMP:")` would silently pin the first of those.
//
// CEILING: presence and `doesNotMatch` pins over bounded slices. What these
// still cannot catch is a whole new paragraph appended AFTER a pinned clause
// carving an exception out of it. That half belongs to review, as it does for
// every other prose pin in this directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, markedLine, paragraph, phrase } from "./prose-pin.mjs";
import { pairTree, classifyPair, checkPair, foreignTokens, KNOWN_EQUALITY_EXCEPTIONS } from "./marked-pairs.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// The dispatch block, bounded by its own opening rule and by the tier-mechanism
// paragraph that follows it. Both bounds are prose this block does not own, so
// no edit inside it can move either one.
const section = () =>
  between(
    RUN_TEAM,
    "**A Pull is one claim followed by one dispatch",
    "**Dispatch every implementer as",
    "run-team/SKILL.md phase 2 dispatch block",
  );

// Bound to the pair itself: the CLAUDE line ends where the OMP marker starts,
// and the OMP line ends at the paragraph that follows both.
const claudeLine = () => between(section(), "CLAUDE: a Pull dispatches", "\nOMP:", "run-team/SKILL.md dispatch CLAUDE line");
const ompLine = () => between(section(), "OMP: a Pull dispatches", "\n\n", "run-team/SKILL.md dispatch OMP line");

// The real pair, located by the file's OWN text rather than by a copy pasted
// into this test: `markedLine` asserts exactly one marker per label inside the
// block, and the marker text is then matched against what the tree-wide scan
// found. A copy here would agree with itself after any edit to the prose.
function realPair() {
  const claude = markedLine(section(), "CLAUDE", "run-team/SKILL.md dispatch block").replace(/^\s*CLAUDE: /, "");
  const { pairs, orphans } = pairTree(REPO);
  const pair = pairs.find((p) => p.claude === claude);
  assert.ok(
    pair,
    `the dispatch block's CLAUDE line is not half of any pair the divergence check found — it was orphaned, or its partner is no longer the very next line. Orphans: ${orphans.map((o) => `${o.file}:${o.line} (${o.reason})`).join("; ") || "none"}`,
  );
  return pair;
}

test("run-team/SKILL.md: the neutral rule is one claim then one fresh dispatch per Pull, no queue, and no one-harness knob", () => {
  // ONE contiguous span per claim. Each clause alone is satisfiable by prose
  // that drops the others: "one dispatch" without "a name no member has held"
  // permits a wake, and without "nothing holds a queue" a pool comes back.
  assert.match(
    section(),
    /A\s+Pull\s+is\s+one\s+claim\s+followed\s+by\s+one\s+dispatch\s+of\s+a\s+new\s+member\s+under\s+a\s+name\s+no\s+member\s+has\s+held;\s+nothing\s+holds\s+a\s+queue\.\*\*\s+That\s+is\s+true\s+on\s+both\s+harnesses/,
    "the neutral rule no longer states one claim then one dispatch of a new member under a never-held name, with no queue, true on both harnesses",
  );
  assert.match(
    section(),
    /the\s+member\s+is\s+fresh\s+and\s+never\s+a\s+wake\s+of\s+one\s+that\s+already\s+ran,\s+and\s+no\s+knob\s+on\s+this\s+path\s+works\s+on\s+one\s+harness\s+only/,
    "the neutral rule no longer forbids a dispatch that wakes a member that already ran, or no longer forbids a knob that works on one harness only",
  );
});

test("run-team/SKILL.md: the CLAUDE line dispatches with one `Agent` call per Pull and carries none of omp's tokens", () => {
  assert.match(
    claudeLine(),
    /one\s+more\s+`Agent`\s+call\s+—\s+definition\s+`fleet-ctl:fleet-implementer`,\s+or\s+`fleet-ctl:fleet-implementer-alt`\s+on\s+every\s+5th\s+Pull;\s+name\s+`impl-<N>`;\s+in\s+the\s+background/,
    "the CLAUDE line no longer names one `Agent` call per Pull with the implementer definition, the alternate one on every 5th Pull, the `impl-<N>` name and a background dispatch",
  );
  // The doesNotMatch half of the pair discipline: a CLAUDE line loose enough to
  // also name omp's tools has collapsed the pair into one wording.
  assert.doesNotMatch(claudeLine(), /`task\b/, "the CLAUDE line names omp's `task` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(claudeLine(), /`eval`/, "the CLAUDE line names omp's `eval` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(claudeLine(), /`hub`/, "the CLAUDE line names omp's `hub` tool — the pair has collapsed into one wording");
});

test("run-team/SKILL.md: the OMP line dispatches with one `task` call per Pull, carries none of Claude's tokens, and no pool", () => {
  assert.match(
    ompLine(),
    /one\s+more\s+`task`\s+call\s+—\s+definition\s+`fleet-implementer`,\s+or\s+`fleet-implementer-alt`\s+on\s+every\s+5th\s+Pull;\s+name\s+`impl-<N>`;\s+in\s+the\s+background/,
    "the OMP line no longer names one `task` call per Pull with the implementer definition, the alternate one on every 5th Pull, the `impl-<N>` name and a background dispatch",
  );
  assert.doesNotMatch(ompLine(), /`Agent`/, "the OMP line names Claude's `Agent` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(ompLine(), /`subagent_type`/, "the OMP line names Claude's `subagent_type` field — the pair has collapsed into one wording");
  assert.doesNotMatch(ompLine(), /`SendMessage`/, "the OMP line names Claude's `SendMessage` tool — the pair has collapsed into one wording");
  // The retired mechanism, by name: the pool (and `eval`'s kernel-resident
  // `agent()`) coming back onto this line is the exact regression #1804 closed.
  assert.doesNotMatch(ompLine(), /workpool|`eval`|agent\(/, "the OMP line dispatches through `eval` again — the workpool is retired (ADR 0012), and a kernel-resident handle dies with the kernel");
});

test("run-team/SKILL.md: the divergence check reads the dispatch block as a same-rule Pair", () => {
  const pair = realPair();
  assert.equal(pair.ompLine, pair.claudeLine + 1, "the two marked lines are no longer adjacent physical lines");
  assert.equal(
    classifyPair(pair),
    "same-rule",
    "the dispatch block no longer classifies as a same-rule Pair. A `does-not-apply` reading means one line picked up a recognized non-applicability idiom — but a Pull dispatches on BOTH harnesses, so that classification would be wrong about the rule itself",
  );
});

test("run-team/SKILL.md: neither dispatch line carries the other harness's dialect token, by the tree's own instrument", () => {
  // The independent second check `marked-pairs.mjs` documents: equality alone
  // cannot see a token SWAP, because both sides' tokens normalize to the same
  // placeholder regardless of which line carries which.
  const pair = realPair();
  assert.deepEqual(foreignTokens(pair.claude, "OMP", pair.file), [], "the dispatch CLAUDE line carries an omp dialect token");
  assert.deepEqual(foreignTokens(pair.omp, "CLAUDE", pair.file), [], "the dispatch OMP line carries a Claude dialect token");
});

test("run-team/SKILL.md: the dispatch pair differs only in the dispatch tool, with no equality exception", () => {
  // Spec § 2: "One same-rule Pair: the two marked lines differ only in tool
  // name. The `#1590` entry in `marked-pairs.mjs` `KNOWN_EQUALITY_EXCEPTIONS`
  // is deleted, not kept." So this pair must meet the equality bar outright —
  // an exemption here would be the pool's divergence smuggled back in.
  const pair = realPair();
  const v = checkPair(pair);
  assert.equal(v.exempt, false, "the dispatch pair is on KNOWN_EQUALITY_EXCEPTIONS — the two lines must differ only in the dispatch tool, which needs no exemption");
  assert.deepEqual(v.violations, [], "the dispatch pair fails the divergence check — its two lines now differ in more than the dispatch tool, or carry a foreign token");
  assert.equal(
    KNOWN_EQUALITY_EXCEPTIONS.some((e) => e.issue === 1590),
    false,
    "KNOWN_EQUALITY_EXCEPTIONS still carries #1590's pool-refill entry — spec § 2 deletes it with the pool",
  );
});

test("run-team/SKILL.md: the claim is made only for the dispatch that follows it", () => {
  // Spec § 2, ruled without a question: phase 1 claims serially in the main
  // checkout, immediately followed by the one dispatch. Both halves together —
  // the claim's owner without the ordering rule permits a run's worth of
  // labelled, unworked worktrees.
  assert.match(
    section(),
    /Claim\s+what\s+you\s+are\s+about\s+to\s+dispatch;\s+dispatch\s+what\s+you\s+have\s+just\s+claimed\.\*\*\s+Phase\s+1\s+makes\s+the\s+claim,\s+serially\s+in\s+the\s+main\s+checkout/,
    "the block no longer binds each claim to the dispatch that follows it, or no longer keeps the claim in phase 1's serial pass",
  );
});

test("run-team/SKILL.md: no per-call tier or effort on the dispatch path", () => {
  // Spec § 2: the pool block's alternate-tier paragraph is deleted "except 'no
  // per-call tier or effort anywhere on this path' (ADR 0005), which stays."
  assert.match(
    section(),
    /\*\*No\s+per-call\s+tier\s+or\s+effort\s+anywhere\s+on\s+this\s+path\*\*:\s+tier\s+stays\s+the\s+agent\s+definition's\s+own\s+frontmatter\s+\(ADR\s+0005\)/,
    "the block no longer forbids a per-call tier or effort — ADR 0005's Declared tier is the agent file's frontmatter and nothing on this path may override it",
  );
});

test("run-team/SKILL.md: the prompt carries only what varies, and the shared background is the agent body", () => {
  // Spec § 2 Decision 2. Both halves: the body named as where the background
  // lives, and the prompt restricted to the placeholders — a prompt told to
  // carry "the ticket" alone would re-grow the 15.5 KB paste this retired.
  assert.match(
    section(),
    /is\s+the\s+body\s+of\s+`agents\/fleet-implementer\.agent\.md`,\s+byte-identical\s+in\s+`agents\/fleet-implementer-alt\.agent\.md`[\s\S]{0,120}Never\s+re-paste\s+it\./,
    "the block no longer says the shared background is the agent body, or no longer forbids re-pasting it into the prompt",
  );
  assert.match(
    section(),
    /The\s+prompt\s+fills\s+that\s+body's\s+placeholders[\s\S]{0,420}Beyond\s+those\s+it\s+carries\s+only/,
    "the block no longer restricts the prompt to the agent body's placeholders plus a named short list",
  );
  for (const slot of ["`<abs-path>`", "`<branch>`", "`<scratch>/impl-<N>/`", "`<distilled brief>`"]) {
    assert.match(section(), phrase(slot), `the block no longer names the ${slot} placeholder the prompt fills`);
  }
});

test("run-team/SKILL.md: implementer liveness is the ledger's, written before the dispatch and stated by nobody", () => {
  // Spec § 2 Decision 3: the STATED path is the only path, derived from the
  // ledger. The write comes first — a member that dies between spawn and write
  // is invisible — so the order is pinned with the command.
  assert.match(
    section(),
    /`~\/\.fleet\/bin\/fleet-run\s+ledger\.mjs\s+dispatch\s+<N>\s+impl-<N>`[\s\S]{0,140}and\s+the\s+call\s+follows/,
    "the block no longer records the dispatch on the ledger before the call",
  );
  assert.match(
    section(),
    /Live\s+implementers\s+are\s+the\s+`impl-`\s+tokens\s+with\s+no\s+`=<outcome>`\s+—\s+the\s+tick\s+reads\s+that\s+count\s+off\s+the\s+ledger,\s+and\s+nobody\s+states\s+it/,
    "the block no longer derives live implementers from the ledger's unsettled tokens",
  );
});

// The OMP dispatch line's own doesNotMatch (above) only guards that ONE marked
// line. Confirmed live: replacing the "No workpool, and no kernel-resident
// handle" sentence itself with an instruction to open a workpool per Pull
// leaves every run-team prose test green, because nothing scans the REST of
// phase 2 for a reintroduced workpool call. Scoped to all of phase 2, with the
// retirement sentence's own bare mention of the word stripped first, so the
// guard cannot vacuously trip on the very sentence that retires the pattern.
const phase2 = () => between(RUN_TEAM, "## Phase 2", "## Phase 3", "run-team/SKILL.md Phase 2");
const phase2WithoutRetirementSentence = () => {
  const body = phase2();
  const retirement = paragraph(
    body,
    "No workpool, and no kernel-resident handle.",
    "run-team/SKILL.md workpool retirement sentence",
  );
  return body.replace(retirement, "");
};

test("run-team/SKILL.md: no workpool instruction is reintroduced into phase 2 outside the retirement sentence", () => {
  const rest = phase2WithoutRetirementSentence();
  assert.doesNotMatch(rest, /workpool\(/i, "phase 2 opens a workpool outside the sentence that retires it");
  assert.doesNotMatch(rest, /eval\.workpool\.freshAgents/i, "phase 2 calls eval.workpool.freshAgents outside the sentence that retires it");
});
