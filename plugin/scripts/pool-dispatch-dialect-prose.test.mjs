// #1590, under #1420, after #1587 (the tick's pool-derived liveness shape) and
// #1588 (the preflight that refuses a pool unless fresh-agents-per-item is
// effectively on). Phase 2's dispatch site now states how an implementer slot
// is REFILLED: neutral prose for the rule that holds on both harnesses —
// slots are refilled to the cap from the staged pool, and a refill is a new
// member under a new name — with a Marked line Pair beneath it carrying each
// harness's own convention. Claude refills by re-entering phase 1 then 2 and
// dispatching one more member, which is an edge the controller has to observe;
// omp refills from the staging wave's own dispatch pool, which hands a queued
// item to a freed worker with no completion event at all. That difference is
// the whole ticket: #3 measured implementers sitting at 0 of target with 57
// `ready-for-agent` in supply, because 0 live implementers emit no completion
// event and the refill was wired as one.
//
// MARKED-PAIR DISCIPLINE (ADR 0004 point 6, #1299's ruling). Each line is its
// own one-line slice — never the section — pinned on its own content AND with
// a `doesNotMatch` for the other harness's tool tokens, so an inversion in one
// dialect cannot pass on the other. Both lines are single physical lines in
// SKILL.md (CONTEXT.md § Dialect: the marker is the line's first token, so a
// pin addresses exactly one line by `^\s*(CLAUDE|OMP): `) — long and
// unwrapped, rather than hard-wrapped like the surrounding prose, so no
// interior newline hides part of a line from that anchor shape.
//
// Both slices nest INSIDE `section()`, never off the file-wide `RUN_TEAM`
// string: `run-team/SKILL.md` carries four other pairs, and a file-wide
// `indexOf("OMP:")` would silently pin the first of those instead. Same
// nesting pattern as `worktree-model-prose.test.mjs` and
// `dispatch-block-pins-prose.test.mjs`'s `block()`.
//
// THE INSTRUMENT, which `worktree-model-prose.test.mjs` predates and could not
// use. #1346 landed `marked-pairs.mjs`, so the classification half of this
// ticket's acceptance is asserted by the real divergence check over the real
// tree rather than by a regex standing in for one: the block must pair, must
// classify as `same-rule` and NOT as a does-not-apply pair, must carry no
// foreign token on either line, and its equality gap must be a NAMED, filed
// exception rather than a silent one.
//
// WHY THE EQUALITY GAP IS REAL AND NOT A WORDING PROBLEM. `checkPair`'s
// same-rule bar is "differ only in dialect tokens once those are stripped".
// This pair cannot meet it, and the reason is the ticket itself: the omp line
// states a mechanism — a queued item handed to a freed worker with no event —
// that has no Claude-side counterpart clause to normalize against, because on
// Claude no such queue exists. Wording the two lines into literal equality
// would mean deleting the divergence the pair exists to record. So it joins
// `KNOWN_EQUALITY_EXCEPTIONS` under its own filed issue (#1590), the same
// shape the seven pairs filed on #1362 already use, and the list's own
// bidirectional membership test in `marked-pairs.test.mjs` keeps that addition
// from being a silent one.
//
// MUTATION RECORD, #1299's four-run procedure, measured 2026-09-22 against a
// scratch copy of the repo (never the real checkout), one mutant per copy,
// each copy running THIS file plus `marked-pairs.test.mjs` (35 tests clean):
//   1. CLAUDE line inverted — its claim rewritten to the pool's ("refilled by
//      the staging wave's own dispatch pool … so the refill is nothing you
//      have to run"). 31 pass / 4 fail: this file's CLAUDE-line test and its
//      exception test, plus the tree-wide equality and membership tests. The
//      OMP line's own content test stayed GREEN — the property #1299 asks for,
//      an inversion in one dialect cannot pass on the other.
//   2. OMP line inverted symmetrically — rewritten to the hand dispatch
//      ("re-entering phase 1 then phase 2 and dispatching one more member by
//      hand"). 31/4, the mirror set: the OMP-line test, the exception test,
//      and the same two tree-wide tests. The CLAUDE line's own content test
//      stayed GREEN.
//   3. Benign reword of the neutral sentence ABOVE the pair, outside every
//      pinned span ("Where the refill comes FROM is what differs." ->
//      "What differs between them is only where the refill comes FROM."):
//      35/0, everything green. That is the control — it is what says the pins
//      above are bound to their claims rather than to the paragraph's bytes.
//   4. Tool tokens SWAPPED in place (`eval` onto the CLAUDE line, `Agent`
//      onto the OMP line). 28/7: BOTH lines' tests, both foreign-token tests,
//      the exception test and the two tree-wide tests. This is the mutant
//      `normalizeDialect` alone cannot see — both sides' tokens map to the
//      same placeholder regardless of which line carries which — so it is the
//      foreign-token check, not equality, that catches it.
//
// Runs 1, 2 and 4 all red the tree-wide equality and membership tests as well,
// and that is the content key doing its job: `KNOWN_EQUALITY_EXCEPTIONS` is
// keyed on `file` plus BOTH lines' exact text, so an edit to EITHER line drops
// the exemption rather than carrying it silently onto rewritten prose.
//
// CEILING: presence and `doesNotMatch` pins over bounded slices, one
// contiguous regex per claim, gaps sized to the actual prose plus a small
// margin rather than a round number — a round, generous gap has room for an
// "unless X" exception clause to survive inside it. What these still cannot
// catch is a whole new paragraph appended AFTER a pinned clause carving an
// exception out of it. That half belongs to review, as it does for every other
// prose pin in this directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, markedLine, phrase } from "./prose-pin.mjs";
import { pairTree, classifyPair, checkPair, foreignTokens, KNOWN_EQUALITY_EXCEPTIONS } from "./marked-pairs.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// The refill block, bounded by its own opening rule and by the dispatch
// sentence that follows it. Both bounds are prose this block does not own, so
// no edit inside it can move either one.
const section = () =>
  between(
    RUN_TEAM,
    "**Implementer slots are refilled to the cap from the staged pool",
    "One named member per ticket, up to cap, background.",
    "run-team/SKILL.md phase 2 refill block",
  );

// Bound to the pair itself: the CLAUDE line ends where the OMP marker starts,
// and the OMP line ends at the paragraph that follows both. Neither slice can
// satisfy the other's assertions, and the neutral sentence above is out of
// reach of both.
const claudeLine = () =>
  between(section(), "CLAUDE: a freed slot", "\nOMP:", "run-team/SKILL.md refill CLAUDE line");
const ompLine = () =>
  between(section(), "OMP: a freed slot", "\n\n**Everything below", "run-team/SKILL.md refill OMP line");

// The real pair, located by the file's OWN text rather than by a copy pasted
// into this test: `markedLine` asserts exactly one marker per label inside the
// block, and the marker text is then matched against what the tree-wide scan
// found. A copy here would agree with itself after any edit to the prose.
function realPair() {
  const claude = markedLine(section(), "CLAUDE", "run-team/SKILL.md refill block").replace(/^\s*CLAUDE: /, "");
  const { pairs, orphans } = pairTree(REPO);
  const pair = pairs.find((p) => p.claude === claude);
  assert.ok(
    pair,
    `the refill block's CLAUDE line is not half of any pair the divergence check found — it was orphaned, or its partner is no longer the very next line. Orphans: ${orphans.map((o) => `${o.file}:${o.line} (${o.reason})`).join("; ") || "none"}`,
  );
  return pair;
}

test("run-team/SKILL.md: the neutral rule is refill-to-cap from the staged pool, a fresh member under a new name, and no one-harness knob", () => {
  // ONE contiguous span. The three clauses are pinned together because each
  // alone is satisfiable by prose that drops the others: "refilled to the cap"
  // without "a new member under a new name" permits a wake, and both without
  // the knob clause permits exactly the caller-facing per-harness switch ADR
  // 0004 exists to refuse.
  assert.match(
    section(),
    /Implementer\s+slots\s+are\s+refilled\s+to\s+the\s+cap\s+from\s+the\s+staged\s+pool[\s\S]{0,40}a\s+refill\s+is\s+a\s+new\s+member\s+under\s+a\s+new\s+name[\s\S]{0,80}true\s+on\s+both\s+harnesses/,
    "the neutral rule no longer states refill-to-cap from the staged pool, a new member under a new name, and that both harnesses hold it",
  );
  assert.match(
    section(),
    /a\s+refill\s+is\s+a\s+fresh\s+member\s+and\s+never\s+a\s+wake\s+of\s+one\s+that\s+already\s+ran[\s\S]{0,40}no\s+knob\s+on\s+this\s+path\s+works\s+on\s+one\s+harness\s+only/,
    "the neutral rule no longer forbids a refill that wakes a member that already ran, or no longer forbids a knob that works on one harness only",
  );
});

test("run-team/SKILL.md: the CLAUDE line states this harness's own refill and carries none of omp's tokens", () => {
  assert.match(
    claudeLine(),
    /re-entering\s+phase\s+1\s+then\s+phase\s+2\s+and\s+making\s+one\s+more\s+`Agent`\s+call\s+under\s+a\s+name\s+no\s+member\s+has\s+held/,
    "the CLAUDE line no longer names the hand dispatch (phase 1 then 2, one more `Agent` call, a name no member has held) as this harness's refill",
  );
  // The WHY, bound to the mechanism rather than asserted alone: without it,
  // "refill is a level-check" reads as a preference an editor could drop for
  // the pool wording, which is the inversion this pin exists to catch.
  assert.match(
    claudeLine(),
    /the\s+refill\s+is\s+a\s+level-check\s+you\s+run[\s\S]{0,90}because\s+nothing\s+here\s+holds\s+a\s+queue\s+that\s+could\s+hand\s+the\s+freed\s+slot\s+its\s+next\s+ticket/,
    "the CLAUDE line no longer says the refill is a level-check the controller runs, or no longer says why (no queue on this harness hands the slot its next ticket)",
  );
  // The doesNotMatch half of the pair discipline: a CLAUDE line loose enough
  // to also name omp's tools has collapsed the pair into one wording.
  assert.doesNotMatch(claudeLine(), /`eval`/, "the CLAUDE line names omp's `eval` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(claudeLine(), /`task[.`]/, "the CLAUDE line names omp's `task` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(claudeLine(), /`hub`/, "the CLAUDE line names omp's `hub` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(claudeLine(), /workpool/, "the CLAUDE line claims the pool mechanism, which is the OMP line's claim — the pair has been inverted or swapped");
});

test("run-team/SKILL.md: the OMP line states the pool that refills with no event, and carries none of Claude's tokens", () => {
  assert.match(
    ompLine(),
    /refilled\s+by\s+the\s+staging\s+wave's\s+own\s+dispatch\s+pool[\s\S]{0,60}hands\s+a\s+queued\s+item\s+to\s+the\s+freed\s+worker\s+with\s+no\s+completion\s+event\s+for\s+you\s+to\s+observe/,
    "the OMP line no longer names the wave's dispatch pool handing a queued item to a freed worker with NO completion event — which is the whole of what this ticket changes",
  );
  assert.match(
    ompLine(),
    /`eval`'s\s+`workpool\(agent,\s+name,\s+context,\s+tools\)`[\s\S]{0,40}opened\s+once\s+per\s+wave[\s\S]{0,40}read\s+for\s+the\s+level\s+condition[\s\S]{0,40}pushed\s+to\s+the\s+number\s+of\s+items\s+the\s+tick\s+says\s+may\s+be\s+in\s+flight/,
    "the OMP line no longer names the pool call, its one-per-wave lifetime, that it is READ for the level condition, or that the push is to the tick's number",
  );
  assert.doesNotMatch(ompLine(), /`Agent`/, "the OMP line names Claude's `Agent` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(ompLine(), /`subagent_type`/, "the OMP line names Claude's `subagent_type` field — the pair has collapsed into one wording");
  assert.doesNotMatch(ompLine(), /`SendMessage`/, "the OMP line names Claude's `SendMessage` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(
    ompLine(),
    /level-check\s+you\s+run/,
    "the OMP line claims the controller-run level-check, which is the CLAUDE line's claim — the pair has been inverted or swapped",
  );
});

test("run-team/SKILL.md: the divergence check reads the refill block as a Pair, not as a does-not-apply Pair", () => {
  const pair = realPair();
  assert.equal(pair.ompLine, pair.claudeLine + 1, "the two marked lines are no longer adjacent physical lines");
  assert.equal(
    classifyPair(pair),
    "same-rule",
    "the refill block no longer classifies as a same-rule Pair. A `does-not-apply` reading means one line picked up a recognized non-applicability idiom (\"does not apply\", \"has no slot for\") — but the refill rule holds on BOTH harnesses and only its mechanism diverges, so that classification would be wrong about the rule itself",
  );
});

test("run-team/SKILL.md: neither refill line carries the other harness's dialect token, by the tree's own instrument", () => {
  // The independent second check `marked-pairs.mjs` documents: equality alone
  // cannot see a token SWAP, because both sides' tokens normalize to the same
  // placeholder regardless of which line carries which. This is the assertion
  // that reds on run 4 of the mutation procedure above.
  const pair = realPair();
  assert.deepEqual(foreignTokens(pair.claude, "OMP", pair.file), [], "the refill CLAUDE line carries an omp dialect token");
  assert.deepEqual(foreignTokens(pair.omp, "CLAUDE", pair.file), [], "the refill OMP line carries a Claude dialect token");
});

test("run-team/SKILL.md: the refill pair's equality gap is a named exception filed on #1590, and nothing else about it is exempted", () => {
  const pair = realPair();
  const v = checkPair(pair);
  assert.equal(v.exempt, true, "the refill pair is no longer on KNOWN_EQUALITY_EXCEPTIONS — an equality gap this pair cannot close without deleting the divergence it records must stay NAMED, never absorbed by loosening the check");
  assert.deepEqual(
    v.violations,
    [],
    "the refill pair has a violation the exception list does not cover — the exemption is scoped to equality alone, so a foreign token or a both-lines non-applicability idiom still fails here",
  );
  assert.equal(v.exemptViolations.length, 1, "the refill pair no longer has the equality gap its exception exists for — if the two lines really became equal, drop the entry from KNOWN_EQUALITY_EXCEPTIONS in the same change");
  const entry = KNOWN_EQUALITY_EXCEPTIONS.find((e) => e.file === pair.file && e.claude === pair.claude && e.omp === pair.omp);
  assert.equal(entry.issue, 1590, "the refill pair's exception must cite the issue it was filed on");
});

test("run-team/SKILL.md: the pool is preflighted and refused, and the setting is never written by the run", () => {
  assert.match(
    section(),
    /Read\s+the\s+\*effective\*\s+`eval\.workpool\.freshAgents`\s+yourself\s+before\s+opening\s+the\s+pool,\s+and\s+refuse\s+unless\s+it\s+reads\s+`true`/,
    "the preflight, its EFFECTIVE read, and its refusing condition are no longer stated — a pool opened without them turns every refill into a silent wake",
  );
  // The refusal's consequence, bound to the refusal: a stated guard with no
  // stated fallback is the one a controller routes around.
  assert.match(
    section(),
    /Failing\s+that\s+check\s+is\s+not\s+a\s+thing\s+to\s+route\s+around:\s+dispatch\s+that\s+wave\s+by\s+hand/,
    "the refusal no longer names what to do instead (dispatch the wave by hand), so it reads as an obstacle rather than a verdict",
  );
  assert.match(
    section(),
    /\*\*Never\s+set\s+it\s+yourself\.\*\*[\s\S]{0,140}install-time\s+operator\s+work\s+\(ADR\s+0003\s+point\s+9\)/,
    "the block no longer forbids the run from setting the session-wide key itself, or no longer points at ADR 0003 point 9 as whose work it is",
  );
});

test("run-team/SKILL.md: one named pool per staging wave, and a new wave opens a new pool", () => {
  assert.match(
    section(),
    /One\s+named\s+pool\s+per\s+phase-0\s+staging\s+wave[\s\S]{0,120}settles\s+and\s+closes\s+on\s+its\s+first\s+full\s+drain[\s\S]{0,160}the\s+next\s+staging\s+opens\s+a\s+NEW\s+named\s+pool\s+rather\s+than\s+pushing\s+to\s+a\s+closed\s+one/,
    "the pool's per-wave lifetime is gone: without the first-full-drain close AND the new-pool-per-wave rule, a refilled queue that momentarily empties leaves the controller pushing into a closed pool",
  );
});

test("run-team/SKILL.md: the cap is fleet accounting and the push is to the tick's number, not the pool's worker bound", () => {
  assert.match(
    section(),
    /bounded\s+by\s+the\s+live\s+`task\.maxConcurrency`[\s\S]{0,140}knows\s+nothing\s+about\s+the\s+implementer\s+cap[\s\S]{0,40}the\s+tick\s+decides\s+how\s+many\s+items\s+may\s+be\s+in\s+flight\s+and\s+you\s+push\s+to\s+that\s+number/,
    "the push-to-cap discipline is gone: without it the implementer cap is silently replaced by the runtime's own concurrency ceiling, which is a bound the fleet never chose",
  );
  assert.match(
    section(),
    /This\s+buys\s+refill\s+semantics\s+and\s+zero\s+throughput/,
    "the block no longer says the pool buys no throughput — read as a parallelism win, the cap becomes the thing to raise",
  );
});

test("run-team/SKILL.md: the implementer row's liveness is read out of the pool, and an unread pool is a refusal rather than a zero", () => {
  assert.match(
    section(),
    /`reconcile\(\)`\s+is\s+exported\s+and\s+I\/O-free[\s\S]{0,200}passes\s+`poolLiveness:\s+\{live,\s+queued\}`[\s\S]{0,120}mapped\s*\n?\s*from\s+the\s+pool's\s+status\s+AT\s+THAT\s+BOUNDARY/,
    "the pool-derived liveness recipe is gone, or no longer puts the mapping from the pool's own status on the caller's side of the boundary",
  );
  assert.match(
    section(),
    /\*\*Absent\s+or\s+unreadable\s+pool\s*\n?\s*status\s+is\s+a\s+REFUSE\s+row,\s+never\s+a\s+zero\*\*[\s\S]{0,160}over-dispatch\s+direction/,
    "the block no longer says an unreadable pool refuses rather than reading as zero live implementers — a zero there is a full cap's worth of dispatch off a pool nobody read",
  );
  assert.match(
    section(),
    phrase("The row then prints `counts=pool-derived`"),
    "the block no longer says the row states its own provenance, which is what lets a reader tell a pool-derived count from a stated one when they disagree",
  );
});

test("run-team/SKILL.md: the alternate-tier member is dispatched outside the pool and still counts against the cap, with no per-call tier", () => {
  assert.match(
    section(),
    /alternate-tier\s+member\s+is\s+dispatched\s+outside\s+the\s+pool,\s+exactly\s+as\s+today,\s*\n?and\s+still\s+counts\s+against\s+the\s+wave's\s+cap[\s\S]{0,80}A\s+pool\s+is\s+homogeneous\s+in\s+its\s+agent/,
    "the alternate-tier exception is gone, or no longer counts that member against the wave's cap, or no longer says why a pool cannot carry it (a pool is homogeneous in its agent)",
  );
  assert.match(
    section(),
    /\*\*No\s+per-call\s+tier\s+or\s+effort\s+anywhere\s+on\s+this\s+path\*\*:\s+tier\s*\n?stays\s+the\s+agent\s+definition's\s+own\s+frontmatter\s+\(ADR\s+0005\)/,
    "the block no longer forbids a per-call tier or effort on the pool path — ADR 0005's Declared tier is the agent file's frontmatter and nothing on this path may override it",
  );
});

test("run-team/SKILL.md: the item carries only what varies and the pool's context carries the shared background", () => {
  assert.match(
    section(),
    /Ticket\s+number\s+and\s+distilled\s+brief\s+go\s+on\s+the\s+item[\s\S]{0,180}stated\s+once\s+as\s+the\s+pool's\s+context,\s+so\s+a\s+refill\s+does\s+not\s*\n?re-send\s+it/,
    "the item-vs-context payload split is gone: either the item stops carrying only what varies, or the shared background stops being stated once as the pool's context",
  );
  assert.match(
    section(),
    /the\s+backstop\s+for\s+an\s+insufficient\s+brief,\s+never\s+the\s+default\s+path/,
    "the unconditional issue re-fetch is no longer held as a backstop, so it reads as the default path again",
  );
});

test("run-team/SKILL.md: the claim stays phase 1's, and is never staged ahead of the push it belongs to", () => {
  // The deviation this block records deliberately, and the reason it is a
  // pin rather than a comment: #1590's body asks for a member-owned claim,
  // and phase 1's own rule — "Never parallel, never inside a member —
  // concurrent `worktree add` and label writes race" — is measured and still
  // true in this tree. The pool would run that race N ways at once, so what
  // moves is WHEN a claim is made, never WHO makes it. Both halves are
  // pinned together: the claim's owner without the staging rule permits a
  // wave's worth of labelled, unworked worktrees.
  assert.match(
    section(),
    /Phase\s+1\s*\n?still\s+makes\s+the\s+claim,\s+serially\s+in\s+the\s+main\s+checkout[\s\S]{0,140}what\s+the\s+pool\s+changes\s+is\s+\*when\*\s*\n?you\s+claim,\s+not\s+\*who\*\s+claims/,
    "the block no longer keeps the claim in phase 1's serial pass, or no longer says the pool moves only WHEN a claim is made — moving it inside a member runs phase 1's measured race once per pooled dispatch",
  );
  assert.match(
    section(),
    /\*\*never\s+stage\s+a\s+claim\s+ahead\s+of\s+the\s+push\s+it\s+belongs\s*\n?to\.\*\*[\s\S]{0,260}Claim\s+what\s+you\s+are\s*\n?about\s+to\s+push;\s+push\s+what\s+you\s+have\s+just\s+claimed/,
    "the claim-with-the-push rule is gone — a claim queued behind items nobody has received is a worktree and an `in-progress` label with no member behind them",
  );
});

test("run-team/SKILL.md: completion detection is unchanged and the ledger still records a Dispatch per member", () => {
  assert.match(
    section(),
    /\*\*Completion\s+detection\s+is\s+unchanged\.\*\*\s+Members\s+report\s+as\s+they\s+do\s+today\s+and\s+the\s*\n?monitor\s+edges\s+stay[\s\S]{0,260}trade\s+a\s+dead\s*\n?refill\s+edge\s+for\s+a\s+dead\s+completion\s+edge/,
    "the block no longer holds completion detection where it is, or no longer says why: routing consumption through the pool trades a dead refill edge for a dead completion edge",
  );
  assert.match(
    section(),
    /the\s+ledger\s+still\s+records\s+one\s+Dispatch\s+per\s+member,\s+so\s*\n?member-outcomes\s+scraping\s+and\s+tier\s+accounting\s+are\s+unaffected/,
    "the block no longer keeps one ledger Dispatch per member, which is what member-outcomes scraping and tier accounting are derived from",
  );
  assert.match(
    section(),
    /A\s+pool-dispatched\s*\n?member's\s+transcript\s+must\s+be\s+reachable\s+exactly\s+as\s+a\s+hand-dispatched\s+one's\s+is/,
    "the block no longer requires a pool-dispatched member's transcript to be reachable the way a hand-dispatched one's is, so the two populations could silently diverge",
  );
});

test("run-team/SKILL.md: waiting on the pool is the blocked-only path, and a blanket wait is named a defect", () => {
  assert.match(
    section(),
    /settles\s+on\s+the\s+pool's\s+DRAIN\s+and\s*\n?not\s+per\s+item,\s+so\s+a\s+controller\s+parked\s+there\s+stops\s+servicing\s+the\s+reviewer\s+and\s+merge\s*\n?sides/,
    "the wait's hazard is gone: without it, blocking on the pool reads as the simple fix rather than as the original stall with the roles swapped",
  );
  assert.match(
    section(),
    /conditional\s+on\s+having\s+nothing\s+live\s+to\s+service\s+at\s+all[\s\S]{0,140}A\s+blanket\s+"wait\s+on\s+the\s*\n?pool"\s+is\s+a\s+defect/,
    "the wait is no longer conditional on having nothing live to service, or a blanket wait is no longer named a defect",
  );
});

test("run-team/SKILL.md: a lost or reset kernel is a refusal and a re-stage, never an empty queue", () => {
  assert.match(
    section(),
    /A\s+lost\s+or\s+reset\s+kernel\s+is\s+a\s+refusal\s+and\s+a\s+re-stage,\s+never\s+an\s+empty\s+queue[\s\S]{0,200}refuse,\s+re-stage\s*\n?the\s+wave\s+under\s+a\s+new\s+pool\s+name/,
    "the lost-kernel rule is gone — a vanished pool read as a drained one is a full cap's worth of free capacity that never existed",
  );
});

test("run-team/SKILL.md: the refill block scopes itself to the implementer row and leaves the reviewer and merge-bot rows alone", () => {
  assert.match(
    section(),
    /Everything\s+below\s+is\s+the\s+pool's\s+own\s+discipline\s+and\s+therefore\s+omp's\s+alone[\s\S]{0,200}nothing\s+in\s+this\s+block\s+touches\s+the\s+reviewer\s+rows,\s+the\s+merge-bot\s+rows,\s+or\s+either\s*\n?of\s+their\s+instructions/,
    "the block no longer scopes the pool discipline to omp and to the implementer row — read as harness-neutral, it would restate Claude's refill as a pool it does not have",
  );
});
