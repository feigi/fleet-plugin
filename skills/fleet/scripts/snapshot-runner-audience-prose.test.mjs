// #141. `review-and-fix.md` establishes that `./agent-test` cannot exist in a
// review snapshot: the snapshot is `git archive HEAD | tar -x`, tracked files
// only, and `claim-ticket.sh` writes the runner into the worktree and
// `.git/info/exclude`s it. The "filesystem isolation is not stack isolation"
// guard in both run-team documents said the opposite — it paired the snapshot
// with `./agent-test` and closed with "say both, every time", handing a
// specialist on a snapshot a command that is not there.
//
// The two audiences are not interchangeable and neither pin below stands alone:
// the member in a worktree DOES have the runner and must keep being told to use
// it, so a sweep that strips `./agent-test` from the guard is the opposite
// failure and has to redden too.
//
// Why point rather than restate: the bullet immediately above this guard in
// run-team/SKILL.md reserves specialist tree isolation — snapshot provisioning
// included — to `review-and-fix.md`, so naming the specialist's command here
// would trade one contradiction for a duplicate that can drift.
//
// THE CEILING, same as agent-test-dir-prose.test.mjs: PRESENCE pins over a
// bounded slice. A later sentence re-pairing the snapshot with the runner stays
// green. Reflow stays green by design — `phrase()` matches across any run of
// whitespace, so run-team/SKILL.md's hard-wrapped copy and isolation.md's long
// lines take the same regexes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("skills", "fleet", "skills", "run-team", "SKILL.md");
const ISOLATION = read("skills", "fleet", "skills", "run-team", "references", "isolation.md");

// Bounded at BOTH ends — an unbounded end lets a later, unrelated occurrence of
// the same phrase satisfy the assertion with the guard itself deleted.
function between(text, from, to, what) {
  const at = text.indexOf(from);
  assert.notEqual(at, -1, `${what} no longer contains "${from}" — update this test`);
  const end = text.indexOf(to, at + from.length);
  assert.notEqual(end, -1, `${what} no longer contains "${to}" after "${from}" — update this test`);
  return text.slice(at, end);
}

const phrase = (s) => new RegExp(s.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));

const slices = [
  ["run-team/SKILL.md", () =>
    between(RUN_TEAM, "Filesystem isolation is not stack isolation", "Scratchpad paths need two levels", "run-team/SKILL.md")],
  ["references/isolation.md", () =>
    between(ISOLATION, "## Filesystem isolation is not stack isolation", "## Scratchpad paths need two levels", "references/isolation.md")],
];

for (const [name, slice] of slices) {
  test(`${name} sends the specialist on a snapshot to review-and-fix.md for the command`, () => {
    assert.match(slice(), phrase("`review-and-fix.md`"));
  });

  test(`${name} keeps \`./agent-test\` as the worktree audience's command`, () => {
    assert.match(slice(), phrase("worktree uses `./agent-test`"));
  });
}
