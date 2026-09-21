// #1344, ruled on #1315. The worktree/claim model section documents four
// rulings for both harnesses and one marked pair (per #1299/#1316): claim,
// release and reap are git-native and unchanged on omp; `isolated: true` is
// never used for a fleet member, because it patch-applies into the CALLING
// SESSION's cwd on completion rather than confining a member to its claimed
// worktree — the precise spill this section exists to prevent; a member
// addresses its worktree by absolute path on both harnesses, which is one
// shared invariant with two different recipes for handing a member its cwd;
// `release-ticket.sh`/`inflight.sh` are unaffected by a live member; and the
// controller's own cwd stays the main checkout on both harnesses.
//
// The one measured gap: whether omp's `task` tool accepts a per-dispatch
// working directory. It does not — `omp://tools/task.md`'s item schema has no
// `cwd` field, and a probe subagent dispatched with none of those fields
// returned the calling session's own `pwd`, not a claimed worktree. So the
// OMP line of the marked pair states the absolute-path discipline as the
// recipe, not a translation of a feature that does not exist. `effort` and
// `isolated` are themselves conditional fields on that schema (present only
// when `task.enableEffort`/`task.isolation.enabled` are on), so the OMP line
// only claims a missing cwd field for the schema as it actually appears, not
// for a fixed field list.
//
// Marked-pair discipline (#1299 ruling on #1316's container): each line is
// its own one-line slice, pinned exactly, with a `doesNotMatch` for the
// other harness's tool token — `Agent`/`subagent_type` for Claude, `` `task` ``
// (the tool, not the generic English word) and `bash` for omp. Each marked
// line is ALSO a single physical line in SKILL.md itself (CONTEXT.md's own
// "Dialect" entry: the marker is the line's first token, so a pin addresses
// exactly one line by `^\s*(CLAUDE|OMP): `) — long, unwrapped, rather than
// hard-wrapped like the surrounding prose, so no interior newline hides part
// of the line from that anchor shape.
//
// `claudeLine`/`ompLine` slice INSIDE `section()`, never off the file-wide
// `RUN_TEAM` string: two sibling prose tickets in flight at the same time
// (#1341, #1349) add their own `OMP: `-prefixed lines earlier in this same
// file, and a file-wide `indexOf("OMP:")` would silently pin one of theirs
// instead once either lands first. Nesting is `dispatch-block-pins-prose.
// test.mjs`'s `block()` pattern: `between(region(), from, to, what)`.
//
// Mutation-tested 2026-09-09, four runs per the #1299 procedure, against a
// scratch copy of this file (never the real checkout): (1) inverting the
// CLAUDE line's tokens reddened only its own test — the OMP line's tests
// stayed green; (2) the symmetric mutation on the OMP line reddened only its
// tests; (3) a benign reword of the shared lead sentence above the pair
// (whitespace/synonym outside the pinned spans) left every test green; (4)
// swapping the two lines' tool tokens (`Agent`/`subagent_type` onto the OMP
// line, `task`/`bash` onto the CLAUDE line) reddened both lines' tests, the
// two-dialect-specific mutant the procedure exists to catch. No
// divergence-check instrument exists yet (#1346, open) to assert a third
// outcome from runs 1/2/4; this file carries the pair discipline on its own
// until that instrument lands.
//
// CEILING: presence and doesNotMatch pins over bounded slices, one contiguous
// regex per claim, gaps sized to the actual prose plus a small margin rather
// than a round number — a round, generous gap (e.g. `{0,400}`) has room for an
// inserted "unless X" exception clause to survive inside it; a tight one does
// not (checked: splicing a ~140-char clause into the isolated-prohibition gap
// reds the test). What these still cannot catch is a whole new sentence
// appended AFTER a clause carving out an exception, or a reflow that keeps
// every pinned word but reorders which paragraph they sit in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

const section = () =>
  between(
    RUN_TEAM,
    "## Worktree and claim model, on both harnesses",
    "## Queue depth",
    "run-team/SKILL.md",
  );

// Nested inside `section()` (never `RUN_TEAM` directly), so a sibling
// ticket's own `CLAUDE:`/`OMP:` line elsewhere in the file cannot satisfy or
// break these anchors. Bound to the pair itself: starts where the CLAUDE line
// opens, ends at the gap paragraph that follows both lines. Neither line's
// slice can satisfy the other's assertions, and the shared lead sentence
// above is out of reach.
const claudeLine = () =>
  between(section(), "CLAUDE: the `Agent` tool", "\nOMP:", "run-team/SKILL.md CLAUDE line");
const ompLine = () =>
  between(section(), "OMP:", "\n\n**The one open gap", "run-team/SKILL.md OMP line");

test("run-team/SKILL.md: claim, release and reap are named unchanged on omp, with no dialect branch", () => {
  assert.match(
    section(),
    /Claim,\s+release\s+and\s+reap\s+are\s+unchanged\s+on\s+omp[\s\S]{0,400}none\s+of\s+the\s+four\s+scripts\s+carries\s+a\s+dialect\s+branch/,
    "the four scripts (claim/release/reap/inflight) are no longer named as unchanged and dialect-branch-free on omp",
  );
});

test("run-team/SKILL.md: isolated is never used, with the calling-session-cwd spill measured", () => {
  // ONE contiguous span: the prohibition alone, without the measured spill
  // mechanism, reads as an unexplained rule a future editor could "simplify"
  // away — the mechanism is why the prohibition cannot move. Gaps are sized
  // to the actual prose (60/138/3/91 chars measured) plus a small margin, not
  // a round generous number: a round `{0,300}` has room for a spliced-in
  // "unless X" exception clause (~140 chars) to survive inside it; these do
  // not.
  assert.match(
    section(),
    /`isolated:\s+true`[\s\S]{0,80}~\/\.omp\/wt\/<hash>\/m[\s\S]{0,160}patch-applied\s+into\s+the[\s\S]{0,20}calling\s+session's\s+own\s+cwd[\s\S]{0,120}probe-isolated\.txt/,
    "the isolated-never-used rule or its measured evidence (workspace path, patch-apply-into-calling-session's-cwd, the probe file) is gone, or an exception clause was spliced into one of the tightened gaps",
  );
  assert.match(
    section(),
    phrase("`isolated` stays unused for every member and `task.isolation.enabled` stays off"),
  );
  // The measured/inferred split the review demanded: the probe measured its
  // own session's cwd, not "the controller's main checkout" directly — the
  // controller case is stated as the explicit inference it is, not folded
  // into the measurement.
  assert.match(
    section(),
    phrase("in the probe session's own cwd — which for an actual fleet run is the controller's main checkout"),
    "the probe-cwd sentence no longer distinguishes what was measured from the controller case it infers",
  );
});

// #1447. The third measurement this section carries, and the only one whose
// hazard is invisible to the repo: `isolated` and the missing `cwd` field are
// both about where BYTES land, so `git status` can catch them after the fact.
// A shared kernel collides in memory and leaves nothing behind, which is why
// the measurement is recorded here rather than left to the incident that
// found it.
test("run-team/SKILL.md: the shared eval kernel is measured, with the isolated-by-construction exception kept", () => {
  // The claim bound to its evidence, and to the fact that it was measured in a
  // LIVE run — every other measurement in this section came from a throwaway
  // probe clone, and a reader who assumes the same of this one would discount
  // it as not reproducing the real dispatch path.
  assert.match(
    section(),
    /`task`-dispatched\s+members\s+share\s+one\s+`eval`\s+kernel[\s\S]{0,80}live\s+run\s+rather\s+than\s+a\s+probe\s+clone[\s\S]{0,170}same\s+Python\s+kernel\s+pid[\s\S]{0,110}each\s+read\s+the\s+others'\s+top-level\s+bindings/,
    "the shared-kernel claim, its live-run provenance, or the pid/cross-read evidence behind it is gone",
  );
  assert.match(
    section(),
    phrase("a bare `WT` bound by one member was read back by a sibling and by the controller"),
    "the reproduced collision no longer names the bare variable the original report was filed on",
  );
  // WHY the sharing follows from the documented keying. Without this, the
  // keying reads as a partition and the conclusion looks unsupported — the
  // point is that both key components are constant across one run's members.
  assert.match(
    section(),
    phrase("the session id is inherited from the controller, and the cwd is the main checkout for all of them"),
    "the section no longer explains why the documented kernel key fails to separate two members of one run",
  );
  // THE EXCEPTION, quoted from upstream. This is the boundary that stops the
  // finding being generalised into "subagent state is never isolated": eval's
  // own `agent()` children are isolated by construction, and a future editor
  // deciding how to fix this needs to know which spawns already are.
  assert.match(
    section(),
    phrase("children created by eval's own `agent()` explicitly do not"),
    "the isolated-by-construction exception for eval's own agent() children is gone, so the finding reads as covering every spawn",
  );
  // The corollary bound to its blast radius — `reset` is the destructive half
  // of the same mechanism, and it is the one a member reaches for innocently.
  assert.match(
    section(),
    /corollary\s+is\s+`reset`[\s\S]{0,140}resetting\s+its\s+own\s+kernel\s+resets\s+every[\s\S]{0,20}concurrent\s+sibling's/,
    "the reset corollary or the sibling damage it causes is gone from the section",
  );
  // The measurement is only worth recording if it reaches members. Phase 2 is
  // where the rule is carried verbatim, so the pointer is pinned with it.
  assert.match(
    section(),
    phrase("**Phase 2** carries all three to every member"),
    "the section no longer points at the phase that actually delivers these rules to a member",
  );
});

test("run-team/SKILL.md: absolute-path addressing is stated as the shared contract, not a dialect card", () => {
  assert.match(
    section(),
    /member's\s+tree\s+is\s+the\s+claimed\s+worktree,\s+addressed\s+by\s+absolute\s+path[\s\S]{0,80}shared\s+contract,\s+true\s+on\s+both\s+harnesses\s+without\s+translation/,
    "the absolute-path rule no longer reads as one shared invariant true on both harnesses",
  );
});

test("run-team/SKILL.md: each marked line is a single physical line in the file", () => {
  // CONTEXT.md's Dialect entry pins the marker shape to `^\s*(CLAUDE|OMP): `
  // — a marked line broken across a hard-wrapped newline is invisible to
  // that anchor past its first physical line.
  const claudeIdx = section().indexOf("CLAUDE: the `Agent` tool");
  const claudeEndOfLine = section().indexOf("\n", claudeIdx);
  const claudeFullLine = section().slice(claudeIdx, claudeEndOfLine);
  assert.match(claudeFullLine, /addressed there by the absolute path alone\.$/, "the CLAUDE line wraps onto a second physical line");

  const ompIdx = section().indexOf("OMP: the `task` tool");
  const ompEndOfLine = section().indexOf("\n", ompIdx);
  const ompFullLine = section().slice(ompIdx, ompEndOfLine);
  assert.match(ompFullLine, /absolute paths for `write`\/`edit`\.$/, "the OMP line wraps onto a second physical line");
});

test("run-team/SKILL.md: CLAUDE line names the Agent tool's cwd recipe and not omp's tool tokens", () => {
  assert.match(
    claudeLine(),
    /`Agent`\s+tool\s+call\s+this\s+runbook\s+dispatches\s+through[\s\S]{0,60}`subagent_type`,\s+no\s+working-directory\s+field\s+anywhere\s+in\s+this\s+file[\s\S]{0,120}dispatch\s+prompt/,
    "the CLAUDE line no longer names the Agent tool, subagent_type, or the dispatch-prompt recipe",
  );
  // The doesNotMatch half of the pair discipline: a CLAUDE line loose enough
  // to also match omp's tool tokens is loose enough to match neither claim.
  assert.doesNotMatch(claudeLine(), /`task`/, "the CLAUDE line names omp's `task` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(claudeLine(), /\bbash\b/, "the CLAUDE line names omp's bash cwd mechanism — the pair has collapsed into one wording");
});

test("run-team/SKILL.md: OMP line names the task tool's missing cwd field, its conditional fields, measured, and not Claude's tool tokens", () => {
  assert.match(
    ompLine(),
    /`task`\s+tool's\s+item\s+schema[\s\S]{0,250}only\s+when\s+their\s+own\s+settings\s+enable\s+them[\s\S]{0,80}carries\s+no\s+working-directory\s+field\s+either[\s\S]{0,250}returned\s+the\s+calling\s+session's\s+own\s+cwd,\s+not\s+the\s+claimed\s+worktree/,
    "the OMP line no longer names the task tool's schema, its conditional fields, or the measured pwd result",
  );
  // `effort`/`isolated` are conditional, not always-present fields — the line
  // must say so rather than presenting a fixed field list.
  assert.match(
    ompLine(),
    phrase("`effort`/`isolated` only when their own settings enable them"),
    "the OMP line presents effort/isolated as always-present schema fields rather than conditional ones",
  );
  assert.match(
    ompLine(),
    phrase("`bash`'s own `cwd` parameter set to it on every call and absolute paths for `write`/`edit`"),
  );
  assert.doesNotMatch(ompLine(), /`Agent`/, "the OMP line names Claude's `Agent` tool — the pair has collapsed into one wording");
  assert.doesNotMatch(ompLine(), /subagent_type/, "the OMP line names Claude's subagent_type — the pair has collapsed into one wording");
});

test("run-team/SKILL.md: the measured gap states task has no per-dispatch cwd, quoting the doc", () => {
  assert.match(
    section(),
    /`task`\s+does\s+not\s+accept\s+a[\s\S]{0,30}per-dispatch\s+working\s+directory[\s\S]{0,200}directly\s+with\s+parent\s+cwd[\s\S]{0,200}no\s+`cwd`\s+field\s+appears\s+anywhere\s+in\s+the\s+item\s+schema/,
    "the gap verdict, or the omp://tools/task.md quote it rests on, is gone",
  );
});

test("run-team/SKILL.md: release-ticket.sh is not a no-op on omp and inflight.sh's probes are unaffected", () => {
  assert.match(
    section(),
    /`release-ticket\.sh`\s+is\s+not\s+a\s+no-op\s+on\s+omp,\s+and\s+`inflight\.sh`'s\s+probes\s+are\s+unaffected\s+by\s+a\s+running\s+member/,
    "the release/inflight headline claim is gone",
  );
  assert.match(
    section(),
    phrase("`~/.omp/wt/` was empty after every isolated run: omp's own teardown touches only omp's own workspace, never the claim"),
    "the measured teardown-scope evidence behind 'not a no-op' is gone",
  );
  assert.match(
    section(),
    phrase("`inflight.sh` hides nothing from omp"),
  );
});

test("run-team/SKILL.md: the controller's own cwd staying the main checkout gets its own stated ruling", () => {
  // Ruling 4 on its own, not folded as a trailing clause onto the
  // release/inflight paragraph above it.
  assert.match(
    section(),
    phrase("The controller's own cwd stays the main checkout on both harnesses, unchanged"),
    "ruling 4 (the controller's own cwd is unchanged) no longer has its own stated sentence",
  );
});
