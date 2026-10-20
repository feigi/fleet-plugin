// #141. `review-and-fix.md` establishes that `./agent-test` is not the command
// to hand a specialist in a review snapshot. The "filesystem isolation is not
// stack isolation" guard — then in both run-team documents, now only in
// references/isolation.md, with run-team/SKILL.md keeping its lead and a
// pointer — said the opposite: it paired the snapshot with `./agent-test` and
// closed with "say both, every time", handing a specialist on a snapshot a
// command that collides with every sibling's.
//
// Why it is the wrong command depends on which runner the worktree holds, and
// the guard names both. The runner `claim-ticket.sh` writes into a fresh
// worktree is untracked — the claim adds it to the repository's exclude file —
// so a `git archive HEAD | tar -x` snapshot never carries it. A runner the
// repository tracks as its own does ride along, but the claim leaves it
// byte-identical and exports no ports into it, so its isolation is whatever
// that repository built. The reason has been rewritten more than once while
// the conclusion held — a bootstrap that failed in a snapshot, then one that
// succeeded there with the fixed ports every snapshot shared — so the reasons
// are pinned beside the conclusion, not left to drift under it.
//
// The two audiences are not interchangeable and neither conclusion pin stands
// alone: the member in a worktree DOES have the runner and must keep being told
// to use it, so a sweep that strips `./agent-test` from the guard is the
// opposite failure and has to redden too.
//
// Why point rather than restate: specialist tree isolation — snapshot
// provisioning included — is reserved to `review-and-fix.md`, by the bullet
// directly above the guard's lead in run-team/SKILL.md and by isolation.md's own
// "Specialist tree isolation" section, so naming the specialist's command in
// the guard would trade one contradiction for a duplicate that can drift. But a
// pointer outlives its target silently — measured, deleting review-and-fix.md's
// specialist-command bullet reddened nothing — so the pin on review-and-fix.md
// below holds the TARGET present instead of copying it.
//
// THE CEILING, same as agent-test-dir-prose.test.mjs: PRESENCE pins over a
// bounded slice. A later sentence re-pairing the snapshot with the runner stays
// green. Reflow stays green by design — `phrase()` matches across any run of
// whitespace, so isolation.md's long lines and any re-wrap of them take the
// same regexes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const read = (...p) => Pin.file(join(REPO, ...p));
const ISOLATION = read("skills", "run-team", "references", "isolation.md");
const REVIEW_AND_FIX = read("commands", "review-and-fix.md");

// run-team/SKILL.md keeps only the guard's lead beside its pointer to
// references/isolation.md, which carries the guard's body.
//
// Each row carries its label once: the row name is also the slice's `what`,
// so the test name and the doc named in a drift failure cannot disagree.
const slices = [
  ["references/isolation.md", () => ISOLATION.section("## Filesystem isolation is not stack isolation", "references/isolation.md").text],
];

for (const [name, slice] of slices) {
  test(`${name} sends the specialist on a snapshot to review-and-fix.md for the command`, () => {
    assert.match(slice(), Pin.phrase("`review-and-fix.md`"));
  });

  test(`${name} keeps \`./agent-test\` as the worktree audience's command`, () => {
    assert.match(slice(), Pin.phrase("worktree uses `./agent-test`"));
  });

  test(`${name} says a snapshot never carries the runner a claim writes`, () => {
    assert.match(slice(), Pin.phrase("runner a claim writes is untracked, so a `git archive` snapshot never carries it"));
  });

  test(`${name} says a tracked runner rides along with its own repository's isolation`, () => {
    assert.match(slice(), Pin.phrase("no claim exported ports into it — its isolation is whatever that repository built"));
  });
}

// The guard's pin above POINTS at review-and-fix.md rather than restating it, so the
// target's presence needs its own pin or the pointer orphans in silence. The end
// anchor is the generic next-bullet marker, not the following bullet's wording,
// which would make an unrelated rewrite of that bullet a boundary failure here.
// Bounded to the bullet so that a copy of the phrase anywhere else in the file
// cannot keep the pin satisfied with this bullet deleted.
test("review-and-fix.md still hands specialists the command the isolation.md guard points at", () => {
  const bullet = REVIEW_AND_FIX.between("Give specialists a stack-free test command", "\n- **", "review-and-fix.md").text;
  assert.match(bullet, Pin.phrase("the Test entrypoint, read off the Recipe cache"));
  assert.match(bullet, Pin.phrase("`derive-testcmd.sh <worktree or main checkout> test` prints it"));
});

// #1150: any member that dispatches a child writes the child's absolute scratch
// path into its prompt, and the child never derives its own. This bullet is the
// hand-dispatch site — a member dispatching the specialists itself, with no
// controller to run the review — so "their own scratch dir" has to name the
// directory and who resolves it, pinned with its path. Same bullet slice as
// above.
test("review-and-fix.md's specialist dispatch assigns each specialist an absolute scratch path", () => {
  const bullet = REVIEW_AND_FIX.between("Give specialists a stack-free test command", "\n- **", "review-and-fix.md").text;
  assert.match(
    bullet,
    Pin.phrase("`<scratch>/pr<N>/fleet-review-<key>/`, resolved to an absolute path that you write into that specialist's prompt; a specialist never derives its own"),
    "the specialist dispatch no longer names the directory each specialist gets, or no longer has the dispatcher write it, absolute, into the specialist's prompt",
  );
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
