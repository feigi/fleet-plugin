// #1561. PR #1082 (as #1084/#1530) added two directory-safety rules to
// `workflows/review-pr.js`'s refuter prompt — chain the directory change into
// the command, and bracket a fixture's own git with `git rev-parse
// --show-toplevel` — and PR #1559 (#1550) mirrored them into `review-core.js`'s
// own SPECIALIST prompt (review-core-specialist-scratch.test.mjs pins that
// copy). `review-core.js` carries a THIRD copy of the same rules' target risk
// in its own REFUTER prompt — "Verify against the snapshot ... by RUNNING
// something — compile it, run the test, apply the mutation" orders exactly
// the git-touching work the two rules exist to make safe — and carried
// neither rule, naming only a scratch path.
//
// Naming the scratch path is not the same rule and does not close either
// failure mode: a `cd` that silently fails leaves the following `;`-separated
// `git` running in whatever directory the agent was already in (the incident
// review-pr-refuter-scratch.test.mjs records as commit 020d6ea, reached during
// the PR #488 fix-applier run), and an agent that BELIEVES it is already in
// its scratch copy and is wrong runs `git init` / `git commit` against the
// repository. Neither is caught by a sentence about where writes SHOULD go.
//
// INLINED, NOT SHARED, same as this file's specialist copy and for the same
// reason: #496's brief rules the shared-source route out, and this is a
// fourth distinct prompt block in this codebase (review-pr.js's specialist,
// review-pr.js's refuter, review-core.js's specialist, and this one), not an
// import target.
//
// WHY THIS PIN RENDERS RATHER THAN GREPS. The rules live inside a template
// literal with escaped backticks (`` \` ``); a source-text pin has to tolerate
// the backslash and then passes just as happily on a prompt that shows the
// refuter a literal `\` instead of a code span. Rendering settles what the
// agent actually reads.
//
// THE SLICE IS THE PIN. Both rules already exist in this same file's
// SPECIALIST prompt (lines above this one), so a pin unbounded to the whole
// file would pass on that copy alone — exactly the defect this ticket
// reports, and exactly what "review-core.js's refuter prompt" must not be
// allowed to mean here. The extraction is bounded by the refuter `agent()`
// call's own template, opening at `Try to REFUTE this finding from PR #` and
// closing at its own `label: \`verify:`, so the specialist prompt sits
// entirely outside it by construction. Measured: reverting the two rules out
// of only the refuter prompt (leaving the specialist's copy untouched) reds
// both rule tests below.
//
// THE CEILING, same as review-pr-refuter-scratch.test.mjs's and
// review-core-specialist-scratch.test.mjs's: nothing here reaches the agent's
// own obedience. These pins settle what a refuter is TOLD, never where it
// actually writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";

const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "scripts", "review-core.js"), "utf8");

// Extraction runs against CODE, not SOURCE: a block-commented `agent(...)`
// call still contains the whole template, so extracting from raw source would
// render dead text and report every criterion satisfied — the vacuity class
// strip-comments.mjs exists for.
const CODE = stripComments(SOURCE);

const TEMPLATE_START = "`Try to REFUTE this finding from PR #";
const TEMPLATE_END = "{ label: `verify:";

// The template's free names, in the order `render` binds them. `readRules`
// and `usableDiff` are stubs: what they return is not under test here.
// `environmentNote` is bound for the same reason as the workflow's copy: a
// render that stops binding it throws a ReferenceError rather than dropping a
// paragraph silently.
const SCOPE = ["pr", "f", "snap", "stats", "d", "i", "fi", "readRules", "usableDiff", "environmentNote"];

function refuterTemplate() {
  const start = CODE.indexOf(TEMPLATE_START);
  assert.notEqual(
    start,
    -1,
    "review-core.js no longer builds a refuter prompt opening `Try to REFUTE this finding from PR #` — " +
      "either it was renamed, or the whole verify fan-out is commented out. Update this test, or restore the prompt.",
  );
  const end = CODE.indexOf(TEMPLATE_END, start);
  assert.notEqual(end, -1, "the refuter agent() call no longer carries a `verify:` label after its prompt — update this test");
  const slice = CODE.slice(start, end);
  return slice.slice(1, slice.lastIndexOf("`"));
}

const RENDER = new Function(...SCOPE, "return `" + refuterTemplate() + "`");

// One refuter's prompt. Every argument is fixed: these pins are about what the
// prompt SAYS, not about how it varies, so nothing here needs to.
const render = () =>
  RENDER(
    7,
    { claim: "the guard fails open", file: "a.js", line: 12, evidence: "line 12 has no else" },
    { path: "/scr/run-1/snapshot-abc1234", head: "abc1234", runRoot: "/scr/run-1" },
    null,
    { key: "correctness" },
    0,
    0,
    () => "READ RULES",
    () => null,
    () => "TEST ENVIRONMENT",
  );

// The first rule. ONE contiguous regex rather than two assertions. Both gaps
// are the literal punctuation the rendered prompt carries around "never"
// ("…`, " before it, a line break plus backtick after) rather than a
// free-text `.{0,N}` span — mutation-tested: splicing "never except in dry
// runs" into the first gap reds this assertion, where a `.{0,60}`-gapped
// version of this same regex (as used by review-pr-refuter-scratch.test.mjs)
// does not catch that splice.
test("the rendered refuter prompt chains cd into the git command, never semicolon", () => {
  assert.match(
    render(),
    /cd\s+"\$D"\s+&&\s+git\s+…`,\s+never\s+`cd\s+"\$D";\s+git\s+…/s,
    "review-core.js's refuter prompt carries no cd-chaining rule — a silently failed `cd` leaves the following `git` " +
      "running in the checkout, which is what produced commit 020d6ea during the PR #488 fix-applier run (#1561)",
  );
});

// The second rule. Both halves, because they have OPPOSITE expected outcomes:
// a lone "resolves to your scratch path" guard is unsatisfiable before `git
// init` — a fresh scratch dir has no toplevel and exits 128 — and a guard that
// cannot pass on the clean path gets ignored. Naming a path alone does not
// catch the observed failure either, which was an agent BELIEVING it was
// already in scratch and being wrong.
test("the rendered refuter prompt requires a toplevel assertion around git init/commit, including the realpath remedy for macOS's /private/tmp symlink", () => {
  assert.match(
    render(),
    /`git\s+rev-parse\s+--show-toplevel`:\s+before\s+`git\s+init`\s+it\s+must\s+NOT\s+resolve\s+to\s+the\s+repository,\s+and\s+a\s+fresh\s+scratch\s+dir's\s+`fatal:\s+not\s+a\s+git\s+repository`\s+\(exit\s+128\)\s+is\s+the\s+pass,\s+not\s+a\s+failure;\s+before\s+any\s+`git\s+commit`\s+it\s+must\s+resolve\s+to\s+your\s+scratch\s+path\s+—\s+compare\s+resolved\s+forms\s+\(`realpath`\),\s+since\s+`--show-toplevel`\s+can\s+report\s+`\/private\/tmp\/…`\s+for\s+a\s+`\/tmp`\s+scratch\s+dir\s+on\s+macOS/s,
    "review-core.js's refuter prompt carries no toplevel assertion around a fixture's own git init/commit, or dropped the " +
      "realpath remedy for macOS's /private vs /tmp symlink (#1561)",
  );
});

// The other direction: a prompt that GAINS rules can displace what orders the
// real run those rules exist to make safe. A refuter's whole job is to run
// something against the snapshot; the two added rules must not read as
// forbidding that entirely.
test("the rendered refuter prompt still orders a real run against the snapshot", () => {
  assert.match(
    render(),
    /Verify against the snapshot .* by RUNNING something/s,
    "review-core.js's refuter prompt no longer orders a real run against the snapshot — adding the two directory-safety " +
      "rules must not displace the instruction they exist to make safe",
  );
});
