// #102. PR #75 made `./agent-test <dir>` work, but the two documents that brief
// members still said `<file>`. Neither was falsified — a file argument works —
// so the capability stayed invisible to exactly the audience #75 was for: agents
// type a directory anyway, and before #75 the resulting MODULE_NOT_FOUND red got
// misread as a finding against the diff under review.
//
// Measured against this worktree's own runner before being written down: a
// directory holding one test file ran it (`ℹ tests 1`, exit 0), and an empty
// directory printed `agent-test: no test files under <dir>` and exited 1. The
// refusal is the half that has to be documented with the capability — appending
// nothing to argv leaves it empty, and bare `node --test` then discovers the
// whole worktree, a green for a suite nobody asked for.
//
// The clause is pinned VERBATIM in both documents, and by one regex set, because
// the two are the same brief written twice: run-team/SKILL.md's Phase 1 step and
// references/isolation.md's rationale for it. A fix landing in only one leaves
// whichever the reader reached still file-only.
//
// NOT pinned, deliberately — these mention `./agent-test` without claiming an
// argument shape, so they are not this ticket's class: the "filesystem isolation
// is not stack isolation" guard in both documents, the reused-worktree note in
// run-team/SKILL.md, review-and-fix.md's specialist test command, and
// references/reaping.md's note that the runner is an ignored file.
//
// THE CEILING, same as refuter-scratch-prose.test.mjs: PRESENCE pins over a
// bounded slice. A whole new sentence appended after the clause, carving out an
// exception, stays green; text spliced inside one does not. A reflow stays green
// by design — the words are pinned, not their layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("skills", "fleet", "skills", "run-team", "SKILL.md");
const ISOLATION = read("skills", "fleet", "skills", "run-team", "references", "isolation.md");

const slices = [
  ["run-team/SKILL.md", () =>
    between(RUN_TEAM, "Materialize the isolation envelope as a file", "A reused worktree may lack the runner", "run-team/SKILL.md")],
  ["references/isolation.md", () =>
    between(ISOLATION, "## Materialize the isolation envelope as a file", "## Filesystem isolation is not stack isolation", "references/isolation.md")],
];

for (const [name, slice] of slices) {
  test(`${name} briefs the runner with a shape that admits a directory`, () => {
    assert.match(slice(), phrase("`./agent-test <file-or-dir>`"));
  });

  test(`${name} says a directory expands to the test files under it`, () => {
    assert.match(slice(), phrase("A directory works too and expands to the test files under it"));
  });

  test(`${name} says a directory with no test files refuses`, () => {
    assert.match(slice(), phrase("one holding none refuses rather than passing vacuously"));
  });
}
