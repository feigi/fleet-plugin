// What run-team's briefing documents say about the runner a claim writes, and
// what they must no longer say. The runner `claim-ticket.sh` writes into a
// fresh worktree is a thin exec of the Recipe's Test entrypoint: a member's
// arguments land after that entrypoint, so what one may name is the
// entrypoint's to say, and nothing in the runner refuses an argument that
// selects no test. Directory expansion, and the refusal of a directory holding
// no tests, belong to a `node --test` argument shim a repository may track as
// its own `agent-test`, not to any runner the plugin writes — so a brief that
// promises them promises every consumer something its runner does not do.
//
// The brief is pinned in both documents by one set, because the two are the
// same brief written twice: run-team/SKILL.md's Phase 1 step and
// references/isolation.md's rationale for it. A fix landing in only one leaves
// whichever the reader reached still wrong.
//
// The runner used to be a tracked bootstrap that re-materialized itself from
// `claim-ticket.sh` on every invocation; nothing emits a runner on request any
// more, and a claim writes one only into the fresh worktree it creates. The
// sweep at the bottom holds that retired vocabulary out of every shipped
// markdown file, and the reused-worktree pin holds the claim-only fact where a
// controller decides whether a tree has a runner at all.
//
// THE CEILING: PRESENCE pins over a bounded slice, plus ABSENCE pins whose
// patterns are checked against the forms they exist to catch. A reworded
// promise of directory expansion that dodges the absence pattern stays green.
// A reflow stays green by design — the words are pinned, not their layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("skills", "run-team", "SKILL.md");
const ISOLATION = read("skills", "run-team", "references", "isolation.md");

// A brief that promises the shim: a directory argument, or the refusal of one
// holding no tests.
const DIRECTORY_CLAUSE = /<file-or-dir>|expands? to the test files under it|one holding none refuses/;

// The retired runner: a bootstrap asking the emitter for a fresh runner on
// every invocation, the file it wrote beside itself, and the change that made
// the runner tracked.
const BOOTSTRAP_RUNNER = /--write-runner|\.agent-test\.sh|re-?materiali[sz]|#55\b/;

const slices = [
  ["run-team/SKILL.md", () =>
    between(RUN_TEAM, "Materialize the isolation envelope as a file", "A reused worktree may lack the runner", "run-team/SKILL.md")],
  ["references/isolation.md", () =>
    between(ISOLATION, "## Materialize the isolation envelope as a file", "## Filesystem isolation is not stack isolation", "references/isolation.md")],
];

test("the absence patterns match each retired form they exist to catch", () => {
  for (const form of [
    "Brief members with `./agent-test <file-or-dir>` and nothing else",
    "A directory works too and expands to the test files under it",
    "one holding none refuses rather than passing vacuously",
  ]) assert.match(form, DIRECTORY_CLAUSE, form);
  for (const form of [
    "materializes the current runner from `claim-ticket.sh --write-runner`",
    "into the gitignored `.agent-test.sh` beside it",
    "The runner is re-materialized on every invocation",
    "re-materialize when you need the current runner",
    "tracked at the repo root since #55",
  ]) assert.match(form, BOOTSTRAP_RUNNER, form);
});

for (const [name, slice] of slices) {
  test(`${name} briefs members with the runner and nothing else`, () => {
    assert.match(slice(), phrase("Brief members with `./agent-test` and nothing else"));
  });

  test(`${name} says a member's arguments land after the Test entrypoint`, () => {
    assert.match(slice(), phrase("Its arguments land after the Test entrypoint, so what one may name — a test file, a test name — is that entrypoint's to say"));
  });

  test(`${name} says a run of zero tests is a failed run`, () => {
    assert.match(slice(), phrase("nothing in the runner refuses one that selects no test: a run of zero tests is a failed run, not a pass"));
  });

  test(`${name} promises no directory expansion`, () => {
    assert.doesNotMatch(slice(), DIRECTORY_CLAUSE);
  });
}

test("run-team/SKILL.md says only a fresh claim writes the runner", () => {
  const p = paragraph(RUN_TEAM, "**A reused worktree may lack the runner.**", "run-team/SKILL.md reused-worktree runner paragraph");
  assert.match(p, phrase("`claim-ticket.sh` writes `agent-test` only into the fresh worktree it claims"));
});

test("no shipped markdown file describes the runner as a bootstrap the emitter re-materializes", () => {
  const files = readdirSync(REPO, { recursive: true })
    .filter((rel) => rel.endsWith(".md") && !rel.split("/").includes("node_modules"));
  assert.ok(files.includes(join("skills", "run-team", "references", "isolation.md")), "the sweep no longer reaches isolation.md");
  const hits = files.filter((rel) => BOOTSTRAP_RUNNER.test(read(rel)));
  assert.deepEqual(hits, [], "a shipped document still describes the retired runner bootstrap");
});
