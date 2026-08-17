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
// would trade one contradiction for a duplicate that can drift. But a pointer
// outlives its target silently — measured, deleting review-and-fix.md's
// specialist-command bullet reddened nothing — so the third pin below holds the
// TARGET present instead of copying it.
//
// THE CEILING, same as agent-test-dir-prose.test.mjs: PRESENCE pins over a
// bounded slice. A later sentence re-pairing the snapshot with the runner stays
// green. Reflow stays green by design — `phrase()` matches across any run of
// whitespace, so run-team/SKILL.md's hard-wrapped copy and isolation.md's long
// lines take the same regexes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("skills", "fleet", "skills", "run-team", "SKILL.md");
const ISOLATION = read("skills", "fleet", "skills", "run-team", "references", "isolation.md");
const REVIEW_AND_FIX = read("skills", "fleet", "commands", "review-and-fix.md");

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

// Each row carries its label once: the row name is also `between()`'s `what`,
// so the test name and the doc named in a drift failure cannot disagree.
const slices = [
  ["run-team/SKILL.md", RUN_TEAM, "Filesystem isolation is not stack isolation", "Scratchpad paths need two levels"],
  ["references/isolation.md", ISOLATION, "## Filesystem isolation is not stack isolation", "## Scratchpad paths need two levels"],
];

for (const [name, text, from, to] of slices) {
  const slice = () => between(text, from, to, name);

  test(`${name} sends the specialist on a snapshot to review-and-fix.md for the command`, () => {
    assert.match(slice(), phrase("`review-and-fix.md`"));
  });

  test(`${name} keeps \`./agent-test\` as the worktree audience's command`, () => {
    assert.match(slice(), phrase("worktree uses `./agent-test`"));
  });
}

// Both pins above POINT at review-and-fix.md rather than restate it, so the
// target's presence needs its own pin or the pointer orphans in silence. The end
// anchor is the generic next-bullet marker, not the following bullet's wording,
// which would make an unrelated rewrite of that bullet a boundary failure here.
// Bounding is not optional: the glob occurs twice in that file, so an unbounded
// pin would stay satisfied by the other occurrence with this bullet deleted.
test("review-and-fix.md still hands specialists the command both guards point at", () => {
  const bullet = between(REVIEW_AND_FIX, "Give specialists a stack-free test command", "\n- **", "review-and-fix.md");
  assert.match(bullet, phrase("node --test skills/fleet/scripts/*.test.mjs"));
});

// The same contradiction in the other voice: a test file whose comment tells the
// reader to run it with the worktree runner. A specialist reads that comment on
// a snapshot, where the runner is not. `node --test <path>` is what most other
// suite comments here already say, and it runs in both trees — measured on the
// two files this replaced it in, from the worktree root and from a real
// `git archive HEAD | tar -x` snapshot (35 and 72 tests, 0 fail, in each; the
// snapshot carried no `agent-test`).
//
// The pattern is a runner invocation whose next token is a path — it holds a
// separator or ends in `.test.mjs` — so it skips agent-test-dir-prose.test.mjs,
// whose header discusses the runner as a subject rather than as an instruction.
// Narrower spellings were measured and rejected: anchoring on a literal
// `skills/` misses the same instruction written with a `./` on the path, a bare
// relative path, a quoted glob, or no `./` on the runner, and requiring the
// argument to end in `.test.mjs` drops the directory form the runner also takes.
// The `(?!\/\/)` is load-bearing rather than defensive: `\s+` must cross
// newlines to reach a block comment's continuation, and without the lookahead
// correct prose that merely ends a line on the runner's name reds too —
// measured at 7 of 71 reflow widths of agent-test-dir-prose.test.mjs's
// untouched header, against 0 with it.
//
// ITS CEILING: an instruction wrapped across two `//` continuation lines stays
// green. That is character-identical to wrapped prose about the runner, so no
// regex separates them; reword such a comment when you meet one.
//
// It stays a REGEX with its slashes escaped for a second reason: written as a
// plain string literal the pattern would occur in this file, and the scan would
// report itself.
test("no suite comment tells the reader to run it with the worktree runner", () => {
  const dir = import.meta.dirname;
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".test.mjs"))
    .filter((f) => /agent-test\s+(?!\/\/)\S*(?:\/|\.test\.mjs)/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(offenders, [], `name \`node --test <path>\` instead: ${offenders.join(", ")}`);
});
