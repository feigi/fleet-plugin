// #1433. Three PRs reviewed back-to-back from one omp `eval` cell left FOUR
// files modified in the checkout that cell was standing in — one specialist's
// mutation-test experiment per review reaching the repository through a
// RELATIVE path. Review specialists have no assigned worktree to fall back to
// (unlike implementers, whose own relative-path defect is #1411), and the
// controller reads every gate decision — instruments.sh, ci-state.mjs, any
// local `node --test` — out of that same tree, so a modified instrument
// silently changes what a later gate check reads.
//
// WHY THE FIX IS PROMPT PROSE AND NOT A `cwd` ARGUMENT. The preferred remedy
// was an explicit scratch cwd per specialist dispatch, passed through
// review-eval.mjs's `ompAgent()`. Neither dispatch primitive has one:
// eval's `agent()` takes `{ agent, label, schema, schemaMode, isolated, apply,
// merge, tools }` and `task`'s item shape carries no cwd either, and a
// non-isolated spawn runs with the PARENT's cwd. `isolated: true` is not that
// option renamed — it names no directory, it fails preflight wherever
// `task.isolation.enabled` is off, and it MERGES the child's changes back into
// the parent, which for a mutation-testing specialist means applying a
// deliberately broken tree to the checkout. review-eval.mjs's own header holds
// that determination with its sources; this file pins what the prompts say
// because of it.
//
// THREE PARTS, PINNED SEPARATELY, because the later two are inert without the
// first and each fails differently: the inherited cwd is NAMED as a tree the
// agent must not write to, `pwd` fixes which directory that is, and the
// `CWD-AUDIT:` line is what makes a CLEAN run say so. An audit reported only
// when it finds something is indistinguishable from one never run — the same
// reading `unrunReason` already applies to a `test_run` reporting nothing, and
// the reason "four files dirty" was found by chance rather than by a report.
//
// WHY THESE PINS RENDER RATHER THAN GREP, and why the slice is the pin: same
// two reasons review-core-specialist-scratch.test.mjs states. The rules live
// inside template literals whose backticks are written escaped (`` \` ``), so
// a source-text pin passes just as happily on a prompt showing the agent a
// literal `\`; and all three prompts here carry the SAME wording, so a pin
// matched against the whole file would be satisfied by any one of them —
// which is the defect shape this ticket reports one dispatch at a time.
// Each prompt is extracted by its own `agent()` call's anchors through
// prompt-renderer.mjs and rendered, so the other two are outside it by
// construction. Measured, per prompt: reverting the block out of the
// specialist prompt alone reds that prompt's four tests and the shared marker
// pin below, leaving every refuter and snapshot test green; the mirror revert
// does the same the other way, and reverting the snapshot sentence reds its
// prose pin alone. Block-commenting a dispatch reds the whole file at
// extraction — it does not render as live text (strip-comments.mjs).
//
// THE CEILING, same as the sibling scratch pins': nothing here reaches the
// agent's own obedience. These pins settle what a dispatch is TOLD and what
// the schema can carry back — never where a specialist actually writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { phrase } from "./prose-pin.mjs";
import { promptRenderer } from "./prompt-renderer.mjs";
import { AUDIT_COMMAND, AUDIT_STATES, CWD_AUDIT_MARKER, EVERY_RUN, PWD_FIRST, REFUTER_CWD, REPORT_FIELD, SCRATCH_NAMED_REFUTER, SCRATCH_NAMED_SPECIALIST, SPECIALIST_CWD, auditLine } from "./cwd-isolation-pins.mjs";
import { FINDINGS_SCHEMA, VERDICT_SCHEMA, cwdAuditFrom, runReview } from "./review-core.js";

const FILE = "scripts/review-core.js";
const SNAP = { path: "/scr/run-1/snapshot-abc1234", head: "abc1234", runRoot: "/scr/run-1" };

// One specialist's, one refuter's and the snapshot agent's prompt. Every
// argument is fixed: these pins are about what the prompts SAY, not about how
// they vary, so nothing here needs to. `readRules`/`usableDiff`/
// `environmentNote` are stubs for the sibling pins' reason — binding them
// keeps a render that stops passing one throwing a ReferenceError instead of
// dropping a paragraph silently.
const specialist = promptRenderer({
  file: FILE,
  start: "`Review PR #${pr} (branch ${branch}) for: ",
  end: "label: `review:",
  scope: ["pr", "branch", "d", "snap", "worktree", "stats", "testCmd", "readRules", "usableDiff", "environmentNote"],
  what: "review-core.js's specialist prompt (opening `Review PR #${pr} (branch ${branch}) for: `, labelled `review:`)",
})(7, "feature/x", { key: "correctness", prompt: "does it do what it says" }, SNAP, "/repo/.worktrees/7-x", null, "node --test", () => "READ RULES", () => null, () => "TEST ENVIRONMENT");

const refuter = promptRenderer({
  file: FILE,
  start: "`Try to REFUTE this finding from PR #",
  end: "{ label: `verify:",
  scope: ["pr", "f", "snap", "stats", "d", "i", "fi", "readRules", "usableDiff", "environmentNote"],
  what: "review-core.js's refuter prompt (opening `Try to REFUTE this finding from PR #`, labelled `verify:`)",
})(7, { claim: "the guard fails open", file: "a.js", line: 12, evidence: "line 12 has no else" }, SNAP, null, { key: "correctness" }, 0, 0, () => "READ RULES", () => null, () => "TEST ENVIRONMENT");

const snapshot = promptRenderer({
  file: FILE,
  start: "`In ${worktree}, cut an immutable review snapshot",
  end: '{ label: "snapshot"',
  scope: ["worktree", "scratch", "runRootParent", "runRootPrefix", "pr", "harness"],
  what: 'review-core.js\'s snapshot prompt (opening `In ${worktree}, cut an immutable review snapshot`, labelled "snapshot")',
})("/repo/.worktrees/7-x", "/scr", "/scr/pr7", "/scr/pr7/run-", 7, "omp");

// --- Part 1: the inherited cwd is named, as a tree not to write to ---------
// ONE contiguous span per prompt, never two assertions and never a `.{0,N}`
// gap — cwd-isolation-pins.mjs holds both spans and why their three clauses
// have to arrive together. Mutation-tested on each prompt: deleting any one of
// the three clauses, and splicing an exception between them ("…lands THERE,
// unless the command is read-only"), both red these.
test("the rendered specialist prompt names the cwd it inherits and says a relative path lands there", () => {
  assert.match(
    specialist,
    phrase(SPECIALIST_CWD),
    "review-core.js's specialist prompt no longer names the directory it is dispatched INTO — a specialist that does not know its cwd is the controller's checkout has no reason to leave it, " +
      "which is how three reviews left four files modified there (#1433)",
  );
});

test("the rendered refuter prompt names the cwd it inherits and says a relative path lands there", () => {
  assert.match(
    refuter,
    phrase(`your shell does not start there: ${REFUTER_CWD}`),
    "review-core.js's refuter prompt no longer names the directory it is dispatched INTO — a refuter applying a mutation is the likeliest writer of the four files #1433 measured",
  );
});

// --- Part 2: `pwd` first, and the inherited directory is a no-run zone -----
// Both halves in one span (PWD_FIRST, cwd-isolation-pins.mjs says why).
// Mutation-tested: demoting FIRST to "early" or dropping the no-run clause
// reds these.
for (const [name, prompt] of [
  ["specialist", specialist],
  ["refuter", refuter],
]) {
  test(`the rendered ${name} prompt orders pwd as the first command and makes that directory a no-run zone`, () => {
    assert.match(
      prompt,
      PWD_FIRST,
      `review-core.js's ${name} prompt no longer fixes which directory it started in before running anything — the audit below then has no path to audit, and the cd rules guard a directory nothing identified (#1433)`,
    );
  });
}

// --- Part 2.5 (#1721): where the snapshot/scratch dir are named, per prompt
// Each prompt's own claim (SCRATCH_NAMED_SPECIALIST / SCRATCH_NAMED_REFUTER,
// cwd-isolation-pins.mjs says why the two differ). Regression pin: reverting
// review-pr.js's specialist prompt back to "above" while leaving this file on
// "in this prompt" passed the entire suite otherwise (measured at PR #1825's
// review) — nothing previously pinned past PWD_FIRST's "no-run zone from then
// on" on either prompt.
for (const [name, prompt, span] of [
  ["specialist", specialist, SCRATCH_NAMED_SPECIALIST],
  ["refuter", refuter, SCRATCH_NAMED_REFUTER],
]) {
  test(`the rendered ${name} prompt states where the snapshot and scratch dir are named as absolute paths`, () => {
    assert.match(
      prompt,
      span,
      `review-core.js's ${name} prompt no longer makes this claim, or worded it to match "above" when its scratch dir is actually named later (#1721)`,
    );
  });
}

// --- Part 3: the positive self-check, into a field the schema carries ------
// The audit command and the report contract are separate spans, each
// contiguous, for the reasons cwd-isolation-pins.mjs gives. Mutation-tested:
// dropping `-uall`, dropping the `showUntrackedFiles=no` reason, and replacing
// "every run, clean or not" with "when it printed anything" each red one of
// these.
test("the rendered specialist prompt audits the directory it started in, with the explicit untracked mode", () => {
  assert.match(
    specialist,
    phrase(AUDIT_COMMAND),
    "review-core.js's specialist prompt dropped the stray-write audit, or asks for bare `--porcelain` — which a `status.showUntrackedFiles=no` config silences into a false clean, the same false-clean class worktree-audit.sh's own `-uall` exists to deny (#1433)",
  );
});

test("the rendered refuter prompt audits the directory it started in, with the explicit untracked mode", () => {
  assert.match(
    refuter,
    phrase(AUDIT_COMMAND),
    "review-core.js's refuter prompt dropped the stray-write audit, or asks for bare `--porcelain` (#1433)",
  );
});

// The report contract, and the half a prose pin usually cannot reach: the
// field each prompt names has to be one its SCHEMA declares. Both schemas are
// `additionalProperties: false`, so a rule pointing at any other name is inert
// — the agent's audit is dropped in validation and the prompt still reads
// correct. The field name is EXTRACTED from the rendered prompt by
// REPORT_FIELD's capture group rather than transcribed here, so the pin fails
// in either direction: the prompt renaming the field, or the schema losing it.
for (const [name, prompt, schema, schemaName] of [
  ["specialist", specialist, FINDINGS_SCHEMA, "FINDINGS_SCHEMA"],
  ["refuter", refuter, VERDICT_SCHEMA, "VERDICT_SCHEMA"],
]) {
  test(`the rendered ${name} prompt reports its audit into a field ${schemaName} actually carries, every run`, () => {
    const named = prompt.match(REPORT_FIELD);
    assert.ok(
      named,
      `review-core.js's ${name} prompt no longer names a report field for the CWD-AUDIT line — an audit the agent has nowhere to put is an audit the caller never sees (#1433)`,
    );
    assert.equal(schema.additionalProperties, false, `${schemaName} no longer refuses undeclared fields — this pin's premise (a wrongly-named field is DROPPED, not passed through) no longer holds; re-derive it`);
    assert.ok(
      Object.hasOwn(schema.properties, named[1]),
      `review-core.js's ${name} prompt reports the audit in \`${named[1]}\`, which ${schemaName} does not declare — \`additionalProperties: false\` drops it, so the audit dies in validation with the prompt still reading correct`,
    );
    assert.ok(
      schema.required.includes(named[1]),
      `${schemaName} no longer REQUIRES \`${named[1]}\`, so an agent that omits the audit omits the whole field and validates anyway — the report has to ride a field the schema already insists on`,
    );
    // All three states, and the always clause. Two of the states are what keep
    // the check POSITIVE: a prompt that spells out only `dirty` leaves a clean
    // run and a never-run check reporting the same nothing, and `unrepo` is
    // what stops a `fatal: not a git repository` — the honest answer whenever
    // the inherited cwd is not a checkout — being read as a reason to report
    // nothing at all.
    for (const state of AUDIT_STATES) {
      assert.match(
        prompt,
        auditLine(state),
        `review-core.js's ${name} prompt no longer spells the \`${state}\` form of the audit line — the state it cannot spell is the state it will not report (#1433)`,
      );
    }
    assert.match(
      prompt,
      EVERY_RUN,
      `review-core.js's ${name} prompt no longer demands the audit line on a CLEAN run — an audit reported only when it finds something is indistinguishable from one never run, which is exactly how #1433's four files went unrecorded`,
    );
  });
}

// Checked against each prompt individually (CWD_AUDIT_MARKER,
// cwd-isolation-pins.mjs) — a capture group around a fixed literal with no
// alternation inside it can only ever capture that same literal, so comparing
// `inSpecialist[1]` against `inRefuter[1]` (the prior shape of this test)
// could never fail as long as both prompts matched at all; the `assert.ok`
// above already covers that.
for (const [name, prompt] of [
  ["specialist", specialist],
  ["refuter", refuter],
]) {
  test(`the rendered ${name} prompt names the CWD-AUDIT marker as a code span`, () => {
    assert.match(
      prompt,
      CWD_AUDIT_MARKER,
      `review-core.js's ${name} prompt no longer names the CWD-AUDIT marker as a code span — a reader cannot tell the literal from the prose around it`,
    );
  });
}

// --- The snapshot dispatch, whose rule is different ------------------------
// It is dispatched with the same inherited cwd, but it CREATES the scratch
// tree, so it has no scratch directory to `cd` into as a first command and
// gets the other half of the rule instead: every path it uses is absolute or
// `-C`-anchored, so nothing relative may be added to the block.
test("the rendered snapshot prompt says its own block is absolute by construction and forbids adding a relative path", () => {
  assert.match(
    snapshot,
    phrase(
      "Every path in the block above is absolute or `-C`-anchored on purpose: this dispatch carries no working directory of its own either, so you start in the controller's own checkout, and a relative path — a `tar -x` with no `-C`, a bare `git` — reads or writes THERE",
    ),
    "review-core.js's snapshot prompt no longer says why its paths are absolute — the agent that mints the scratch tree is the one dispatch with no scratch dir to cd into, so the rule it gets is the only one it can follow (#1433)",
  );
});

// The other direction, and the one that keeps the sentence above from being
// aspirational: the block really is anchored. Every command line in the prompt
// is checked, so a bare `git status` or a `tar -x` with no `-C` added later
// reds HERE — where the prose claiming otherwise lives — rather than in a
// review that quietly measured the controller's checkout. Command lines are
// the 4-space-indented ones, which is how both blocks in this prompt are
// written; the prose that NAMES `tar -x` and `git` sits at column 0 and is not
// scanned, so this pin cannot be satisfied or broken by its own rule's wording.
test("every command line in the snapshot prompt is -C-anchored, cd-chained, or path-free", () => {
  const lines = snapshot.split("\n").filter((l) => /^ {4}\S/.test(l));
  assert.ok(lines.length >= 15, `only ${lines.length} indented command lines found in the snapshot prompt — the block was reshaped past what this pin scans; update it or restore the block`);
  for (const line of lines) {
    const cdChained = /cd\s+"\$\w+"\s+&&/.test(line);
    for (const m of line.matchAll(/(?<![-\w])git\s+(?!-C\b)(\S+)/g)) {
      assert.ok(
        cdChained,
        `the snapshot block runs \`git ${m[1]}\` with neither \`-C\` nor a chained \`cd\` on the same line — it answers about the directory the dispatch inherited, the controller's own checkout: ${line.trim()}`,
      );
    }
    for (const m of line.matchAll(/(?<![-\w])tar\s+(\S+)/g)) {
      assert.match(
        line,
        /tar\s[^|]*-C\s/,
        `the snapshot block runs \`tar ${m[1]}\` with no \`-C\` — an extraction with no destination unpacks into the inherited cwd: ${line.trim()}`,
      );
    }
  }
});

// --- The specialist's audit reaching the payload (PR #1671 review, gap 1) --
// Part 3 above pins that the audit is NAMED and has somewhere valid to land;
// it does not pin that `runReview` ever reads it back out once it lands
// there. Measured against the PR #1671 review's own reproduction: a
// specialist that dutifully reported `CWD-AUDIT: dirty <checkout>` into
// `scope_searched` had that fact dropped before `runReview`'s return —
// `scope_searched` fed only `unrunReason`'s test-run check, which never reads
// it, so the audit dead-ended inside a field nothing else looked at.
// `cwdAuditFrom` extracts the line; the tests below pin that `runReview`
// folds its result into the payload under `cwdAudit`, and that a missing or
// misspelled line is flagged there rather than silently read as clean.
test("cwdAuditFrom reads each of the audit line's states, and flags its own absence", () => {
  assert.deepEqual(cwdAuditFrom("grepped src/**/*.js for auth checks. CWD-AUDIT: clean /repo/.worktrees/7-x"), {
    state: "clean",
    line: "CWD-AUDIT: clean /repo/.worktrees/7-x",
  });
  assert.deepEqual(cwdAuditFrom("CWD-AUDIT: dirty /repo/.worktrees/7-x — M src/foo.js"), {
    state: "dirty",
    line: "CWD-AUDIT: dirty /repo/.worktrees/7-x — M src/foo.js",
  });
  assert.deepEqual(cwdAuditFrom("CWD-AUDIT: unrepo /repo/.worktrees/7-x"), {
    state: "unrepo",
    line: "CWD-AUDIT: unrepo /repo/.worktrees/7-x",
  });
  // No line at all.
  assert.deepEqual(cwdAuditFrom("grepped src/**/*.js for auth checks"), { state: "missing", line: null });
  // Misspelled — the ticket's own failure mode: a schema-valid string that
  // never actually reports, because FINDINGS_SCHEMA has no pattern over it.
  assert.deepEqual(cwdAuditFrom("CWD AUDIT: clean /repo/.worktrees/7-x"), { state: "missing", line: null });
  assert.deepEqual(cwdAuditFrom(undefined), { state: "missing", line: null });
});

// A minimal fake host: every fact `runReview` otherwise gets from `gh`/`git`
// arrives inside the snapshot agent's own structured response — review-
// core.js never shells out itself, every command lives in a dispatched
// prompt (grep finds no `child_process` import in this file) — so a scripted
// `agent()` stub returning one canned object per dispatch label is a
// complete double for the whole pipeline, no real repository needed.
function fakeReviewHost(scopeSearched) {
  return {
    agent: async (_prompt, opts) => {
      if (opts.label === "snapshot")
        return {
          runRoot: "/scr/pr7/run-ab12",
          path: "/scr/pr7/run-ab12/snapshot-abc123",
          head: "abc123",
          pathVerified: true,
          repoVerified: true,
          testCmd: "node --test",
        };
      if (opts.label === "review:correctness")
        return {
          dimension: "correctness",
          scope_searched: scopeSearched,
          findings: [],
          test_run: { command: "node --test", tests: 5, pass: 5, fail: 0 },
        };
      throw new Error(`fakeReviewHost: unexpected dispatch ${opts.label}`);
    },
    phase: () => {},
    log: () => {},
  };
}

test("runReview carries a specialist's dirty CWD-AUDIT into the payload's cwdAudit field", async () => {
  const host = fakeReviewHost("CWD-AUDIT: dirty /repo/.worktrees/7-x — M src/foo.js");
  const result = await runReview(host, {
    pr: 7,
    worktree: "/repo/.worktrees/7-x",
    scratch: "/scr",
    dimensions: ["correctness"],
  });
  assert.deepEqual(
    result.cwdAudit,
    [{ dimension: "correctness", state: "dirty", line: "CWD-AUDIT: dirty /repo/.worktrees/7-x — M src/foo.js" }],
    "a specialist that reported a dirty checkout must have that fact reach the payload — silently dropping it is the exact defect PR #1671's review found (#1433)",
  );
});

test("runReview flags a specialist's missing CWD-AUDIT line rather than reading it as clean", async () => {
  const host = fakeReviewHost("grepped the diff for auth checks — nothing else searched");
  const result = await runReview(host, {
    pr: 7,
    worktree: "/repo/.worktrees/7-x",
    scratch: "/scr",
    dimensions: ["correctness"],
  });
  assert.deepEqual(
    result.cwdAudit,
    [{ dimension: "correctness", state: "missing", line: null }],
    "a specialist that satisfied FINDINGS_SCHEMA without ever emitting a CWD-AUDIT line must be flagged, not read as an unreported-but-clean run",
  );
});
