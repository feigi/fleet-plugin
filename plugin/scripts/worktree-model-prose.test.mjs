// #1344, ruled on #1315. The worktree/claim model section documents four
// rulings for both harnesses and one marked pair (per #1299/#1316): claim,
// release and reap are git-native and unchanged on omp; `isolated: true` is
// never used for a fleet member, because it patch-applies into the CALLING
// SESSION's cwd on completion rather than confining a member to its claimed
// worktree — the precise spill this section exists to prevent; a member
// addresses its worktree by absolute path on both harnesses, which is one
// shared invariant with two different recipes for handing a member its cwd;
// and `release-ticket.sh`/`inflight.sh` are unaffected by a live member.
//
// The one measured gap: whether omp's `task` tool accepts a per-dispatch
// working directory. It does not — `omp://tools/task.md`'s item schema has no
// `cwd` field, and a probe subagent dispatched with none of those fields
// returned the calling session's own `pwd`, not a claimed worktree. So the
// OMP line of the marked pair states the absolute-path discipline as the
// recipe, not a translation of a feature that does not exist.
//
// Marked-pair discipline (#1299 ruling on #1316's container): each line is
// its own one-line slice, pinned exactly, with a `doesNotMatch` for the
// other harness's tool token — `Agent`/`subagent_type` for Claude, `` `task` ``
// (the tool, not the generic English word) and `bash` for omp. Mutation-tested
// 2026-09-09, four runs per the #1299 procedure, against a scratch copy of
// this file: (1) inverting/deleting the CLAUDE line reddens only its own test
// and the divergence between the two lines' tool tokens is what a delete
// removes — the OMP line's tests stayed green; (2) the symmetric mutation on
// the OMP line reddened only its tests; (3) a benign reword of the shared
// lead sentence above the pair (whitespace/synonym outside the pinned spans)
// left every test green; (4) swapping the two lines' tool tokens (`Agent`
// onto the OMP line, `task`/`bash` onto the CLAUDE line) reddened both lines'
// `doesNotMatch` assertions, the two-dialect-specific mutant the procedure
// exists to catch. No divergence-check instrument exists yet (#1346, open) to
// assert a third outcome from runs 1/2/4; this file carries the pair
// discipline on its own until that instrument lands.
//
// CEILING: presence and doesNotMatch pins over bounded slices, one contiguous
// regex per claim. What they cannot catch is a whole new sentence appended
// after a clause carving out an exception, or a reflow that keeps every
// pinned word but reorders which paragraph they sit in.
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

// Bound to the pair itself: starts where the CLAUDE line opens, ends at the
// gap paragraph that follows both lines. Neither line's slice can satisfy the
// other's assertions, and the shared lead sentence above is out of reach.
const claudeLine = () =>
  between(RUN_TEAM, "CLAUDE: the `Agent` tool", "\nOMP:", "run-team/SKILL.md CLAUDE line");
const ompLine = () =>
  between(RUN_TEAM, "OMP:", "\n\n**The one open gap", "run-team/SKILL.md OMP line");

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
  // away — the mechanism is why the prohibition cannot move.
  assert.match(
    section(),
    /never\s+dispatched\s+with\s+omp's\s+`isolated:\s+true`[\s\S]{0,200}~\/\.omp\/wt\/<hash>\/m[\s\S]{0,300}patch-applied\s+into\s+the[\s\S]{0,60}calling\s+session's\s+own\s+cwd[\s\S]{0,400}probe-isolated\.txt/,
    "the isolated-never-used rule or its measured evidence (workspace path, patch-apply-into-calling-session's-cwd, the probe file) is gone",
  );
  assert.match(
    section(),
    phrase("`isolated` stays unused for every member, and `task.isolation.enabled` stays off"),
  );
});

test("run-team/SKILL.md: absolute-path addressing is stated as the shared contract, not a dialect card", () => {
  assert.match(
    section(),
    /member's\s+tree\s+is\s+the\s+claimed\s+worktree,\s+addressed\s+by\s+absolute\s+path[\s\S]{0,80}shared\s+contract,\s+true\s+on\s+both\s+harnesses\s+without\s+translation/,
    "the absolute-path rule no longer reads as one shared invariant true on both harnesses",
  );
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

test("run-team/SKILL.md: OMP line names the task tool's missing cwd field, measured, and not Claude's tool tokens", () => {
  assert.match(
    ompLine(),
    /`task`\s+tool's\s+item\s+schema[\s\S]{0,100}carries\s+no\s+working-directory\s+field\s+either[\s\S]{0,250}returned\s+the\s+calling\s+session's\s+own\s+cwd,\s+not\s+the\s+claimed\s+worktree/,
    "the OMP line no longer names the task tool's schema, or the measured pwd result",
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
