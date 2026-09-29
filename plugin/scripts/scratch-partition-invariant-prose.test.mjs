// #1150. The PR that landed this repo's two-sided scratch-partition rule —
// "any member that dispatches a child writes an absolute directory under its
// own partition into that child's prompt, one per child and never shared, and
// a child never derives its own" (run-team/SKILL.md's "Scratchpad paths need
// two levels" bullet) and its twin in references/isolation.md's "The axis is
// two-sided" paragraph — shipped with NO test coverage for either sentence.
// Measured directly: `grep -rn "and a child never derives its own\|any member
// that dispatches a child writes" plugin/scripts` found zero matches before
// this file, and inverting the rule in a scratch copy ("a member that
// dispatches a child may let the child derive its own directory under the
// shared partition") left every test in all five of that PR's diff-touched
// files green — the defect #1150 exists to rule out has no pin anywhere.
//
// This mirrors dispatch-block-pins-prose.test.mjs's treatment of the
// identical invariant in fleet-implementer.agent.md's child-dispatch block
// (that file pins the *implementer's* own instance of this rule; this one
// pins the two general statements of it that the implementer, fix-applier
// and review-side members are all read against).
//
// THE CEILING: a phrase()-based presence pin over one paragraph each. A
// carve-out sentence appended AFTER the pinned clause, or a rewording that
// keeps every pinned word but drops the parent-writes/child-never-derives
// relationship between them, is not caught here — see dispatch-block-golden-
// prose.test.mjs for that stronger, whole-block mechanism; this file's job is
// only to stop the clause from being deleted or inverted unnoticed, which is
// the shape #1150 measured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("skills", "run-team", "SKILL.md");
const ISOLATION = read("skills", "run-team", "references", "isolation.md");

const SKILL_BULLET = () =>
  between(
    RUN_TEAM,
    "**Scratchpad paths need two levels",
    "**IDE/harness diagnostics attribute",
    "run-team/SKILL.md's scratchpad-paths bullet",
  );

const SKILL_CLAUSE =
  "any member that dispatches a child writes an absolute directory under its own partition into that child's prompt, one per child and never shared, and a child never derives its own";

test("run-team/SKILL.md's scratchpad-paths bullet pins the parent-writes, child-never-derives rule", () => {
  assert.match(
    SKILL_BULLET(),
    phrase(SKILL_CLAUSE),
    "the bullet no longer states that any member dispatching a child writes an absolute directory into that child's prompt, one per child and never shared, with the child never deriving its own — the exact rule #1150 exists to establish, and inverting it left the diff-touched suite green before this pin existed",
  );
});

const ISOLATION_PARAGRAPH = () =>
  between(
    ISOLATION,
    "The axis is two-sided",
    "## IDE/harness diagnostics attribute",
    "references/isolation.md's two-sided-axis paragraph",
  );

const ISOLATION_CLAUSE =
  "every agent it dispatches gets a directory under that one, unique to that child and never shared, written into the child's prompt as an absolute path; a child never derives its own";

test("references/isolation.md's two-sided-axis paragraph pins the same parent-writes, child-never-derives rule", () => {
  assert.match(
    ISOLATION_PARAGRAPH(),
    phrase(ISOLATION_CLAUSE),
    "the paragraph no longer states that every dispatched agent gets a directory under its parent's own, unique and never shared, written in as an absolute path with the child never deriving its own — isolation.md's statement of the same #1150 rule SKILL.md's bullet carries",
  );
});
