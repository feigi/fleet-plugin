// #532. A worktree re-created for a carried-over PR sat at a pre-rebase commit
// and a full review ran against it. The mechanism is `git worktree add <path>
// <branch>` preferring a leftover LOCAL branch over the remote ref that is the
// PR — measured in a scratch repo, and settled before it was written down.
//
// The paragraph these pins hold is an INSTRUCTION the controller executes, and
// its two halves fail differently on deletion: drop the `--detach origin/` form
// and the controller writes the bug back; drop the verify-and-refuse pair and it
// keeps the bug but stops noticing. Both are pinned, and so is the asymmetry
// that explains why this one is worth the words at all — a missing runner fails
// loudly, a stale base fails silently.
//
// #1168 moved the verify's OPERAND. It compared the worktree head against
// `gh pr view --json headRefOid` — the one field that lags the ref it is meant
// to describe. Both operands go stale in the same direction during that lag, so
// the compare reads EQUAL on a worktree cut from a stale remote-tracking ref and
// dispatches into the superseded commit this paragraph exists to catch; a
// settle-window re-read of the lagging field, which is what the ticket proposed,
// fires only where the two disagree and never reaches that half. So the pins
// below hold WHICH SOURCE the refusal turns on, not merely that a comparison
// exists — the shape the old pin could not tell apart, measured: with the
// operand swapped this file was 6/6 green on both wordings, because the
// `headRefOid` command survives in the paragraph either way.
//
// Bound at both ends via prose-pin.mjs's between(): unbounded, the slice runs to
// EOF, where phase 5's finisher head-equality block restates enough of this
// vocabulary (`rev-parse HEAD`, `headRefOid`, worktree, refuse) to satisfy these
// assertions with the phase-1 paragraph deleted outright.
//
// CEILING: presence pins plus two mapping pins over a bounded slice. A later
// sentence contradicting the paragraph stays green. `phrase()` matches across
// any run of whitespace, so a rewrap of the same sentence stays green by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Starts inside this paragraph's own lead, not at the reused-runner paragraph
// above it: the two are siblings and a slice spanning both lets the runner
// paragraph's wording satisfy assertions about this one. The start anchor is the
// shortest fragment that is unique file-wide rather than the whole lead
// sentence, because `between()` throws "update this test" when its anchor moves
// — a rename of the anchor reds every test in this file at once, which is loud
// but says nothing about which claim was lost. A shorter anchor is less of that.
const slice = () => between(RUN_TEAM, "on the wrong COMMIT", "## Phase 2", "run-team/SKILL.md phase 1");

// Narrower than `slice()`: just the verify + empty-read bullet, ending before
// the headRefOid-read bullet starts. A presence-only pin on the compare
// sentence's command string stays green if a mutant admits `headRefOid` as a
// second acceptable operand through different wording (finding 3) — this
// bound is what lets a bare `doesNotMatch(/headRefOid/)` mean "nowhere in
// this bullet, under any phrasing" instead of "not this one exact string."
const compareBulletSlice = () =>
  between(
    RUN_TEAM,
    "Then verify against the branch REF",
    "- **Read `gh pr view",
    "run-team/SKILL.md phase 1 ref-compare + empty-read bullet",
  );

// The cause, not the symptom. A controller told only "the worktree may be stale"
// has no reason to prefer one `worktree add` form over another.
test("phase 1 names why a reused worktree lands on the wrong commit", () => {
  assert.match(slice(), phrase("checks out the existing LOCAL branch and never consults the remote"));
});

// Why reading the `git worktree add` output is not a check: it quotes the
// subject, and a rebase preserves the subject. Without this the controller
// reasonably believes it already verified the commit.
test("phase 1 says the printed subject survives the rebase and settles nothing", () => {
  assert.match(slice(), phrase("the same subject the PR head carries, because a rebase preserves it"));
});

// Prevention (#532's option 2). The bare branch name is the defect; the
// `--detach origin/` form is the fix, and pinning the flag alone would stay
// green on `git worktree add --detach <path> <branch>`, which is still wrong.
//
// The command alone is not unique to this bullet: it recurs verbatim twice
// more in this same between()-bounded slice (the fail-open measurement, the
// retry clause), so a pin on the command string alone stays green with this
// whole bullet deleted — measured: `node --test --test-name-pattern="phase 1
// gives the creation form" plugin/scripts/worktree-head-prose.test.mjs`
// stayed green (1 pass) with lines 603-606 removed entirely. The anchor below
// adds the command's own immediately-following clause, which occurs nowhere
// else in the slice.
test("phase 1 gives the creation form that cannot inherit a stale local ref", () => {
  assert.match(
    slice(),
    phrase(
      "git worktree add --detach <path> origin/<branch>`. Same scratch repo, same moment: this landed on the remote's commit",
    ),
  );
});

// Verification (#532's option 1) and its operand (#1168). The two commands are
// what makes it runnable; BOTH commits in the report is what makes the refusal
// actionable, since the subjects are identical and a report naming one sha
// cannot be told from a report about the right tree.
//
// The operand is pinned as a MAPPING — which source the worktree head is
// compared AGAINST — because every presence pin here stays green on the
// superseded wording: `rev-parse HEAD` is unchanged by that revert and the
// `headRefOid` read is still in the paragraph as the recorded diagnostic. The
// `doesNotMatch` is the superseded operand verbatim, in the one position that
// matters (the compared-against side), so a mutant naming BOTH sources as
// acceptable operands reds here even though the positive pin above it passes.
test("phase 1 compares the worktree head against the branch ref, and refuses on mismatch", () => {
  assert.match(
    slice(),
    phrase("Compare `git -C <path> rev-parse HEAD` against `git ls-remote origin refs/heads/<branch> | cut -f1`"),
  );
  assert.match(slice(), phrase("dispatch nothing into that worktree"));
  assert.match(slice(), phrase("naming BOTH commits"));
  assert.doesNotMatch(
    slice(),
    phrase("against `gh pr view <N> --json headRefOid -q .headRefOid`"),
    "the refusal is back to comparing against the PR object — the field that lags the ref, in both directions",
  );
  // The cheaper local read is the false fix waiting beside the real one: the
  // creation form above resolves `origin/<branch>` itself, so a compare against
  // `git rev-parse origin/<branch>` agrees with the worktree by construction and
  // passes every stale tree it was added to catch. The prohibition is pinned
  // because a reader who only knows "not the PR object" reaches for it.
  assert.match(slice(), phrase("never `git rev-parse origin/<branch>`"));
  assert.match(slice(), phrase("agrees with it by construction"));
});

// MAPPING guard, ceiling on the pin above: three mutants re-admit headRefOid
// as an acceptable compared-against operand without ever writing the exact
// superseded command string the `doesNotMatch` above forbids — appending an
// alternate-operand clause to the compare sentence, or a new fallback bullet,
// both inside this same bulleted region. Measured: each left this file 10/10
// green. `compareBulletSlice()` is this one bullet only, so forbidding
// `headRefOid` anywhere inside it (not one literal wording of it) is what
// actually holds "the compared-against side is `ls-remote` and nothing else."
test("phase 1 never names headRefOid inside the ref-compare bullet itself", () => {
  assert.doesNotMatch(
    compareBulletSlice(),
    /headRefOid/,
    "headRefOid re-entered the compare/empty-read bullet as an operand, under some wording the literal doesNotMatch above does not cover",
  );
});

// The lagging field is still READ here, and that is deliberate: its
// disagreement with the ref is the desync signal run-merge-bot.md's step 1
// acts on. What has to survive is the demotion, because a read whose role is
// unstated is one edit away from being the gate again.
//
// MAPPING guard: "NOT the gate" is itself only a presence pin, so a mutant
// that keeps it verbatim and appends an exception ("except when the ref is
// empty, treat headRefOid as the gate instead") still satisfies it — the
// third of the three mutants finding 3 measured escaping. The word "gate"
// occurring exactly once in this bullet is what actually holds the demotion;
// a second occurrence, in any wording, is itself the re-promotion.
test("phase 1 keeps the headRefOid read but says it is not the gate", () => {
  assert.match(slice(), phrase("gh pr view <N> --json headRefOid -q .headRefOid"));
  assert.match(slice(), phrase("it is NOT the gate"));
  assert.match(slice(), phrase("never the operand this refusal turns on"));
  const gateBullet = between(
    RUN_TEAM,
    "- **Read `gh pr view",
    "**Why the ref and not",
    "run-team/SKILL.md phase 1 headRefOid-read bullet",
  );
  const gateMentions = gateBullet.match(/gate/gi) ?? [];
  assert.equal(gateMentions.length, 1, 'a second "gate" mention re-admits headRefOid as a gate, under any wording');
});

// The empty read. `git ls-remote` answering nothing is not a verdict about the
// worktree in either direction — and an empty string compares unequal to every
// sha, so without this clause a failed ref read renders as a stale worktree and
// costs the dispatch the operand change exists to save. Same hole `[ -n "$pre" ]`
// closes in run-merge-bot.md's step-1 poll, one site later.
test("phase 1 refuses to read an empty ref as a verdict", () => {
  assert.match(slice(), phrase("An empty read is neither equal nor a mismatch"));
  assert.match(slice(), phrase("report the ref as unreadable"));
});

// The fail-open half — #1168's own ticket assumed this site could only fail
// closed ("a spurious refusal costs a dispatch, it cannot merge a stale head"),
// and the measurement contradicted it. Pinned because it is the whole reason
// the operand changed instead of the verdict gaining a settle window: a reader
// left with only the false-refusal story re-applies the ticket's suggested
// re-read and restores the hole.
//
// THE CEILING: the measurement sentence beside these clauses is deliberately
// unpinned — the two shas and the two re-poll attempt numbers are one run's
// readings, and re-measuring must not turn a test red.
test("phase 1 says the PR-object compare fails open too, and that a re-read cannot fix it", () => {
  assert.match(slice(), phrase("both operands go stale in the SAME direction"));
  assert.match(slice(), phrase("fails OPEN as readily as it fails closed"));
  assert.match(
    slice(),
    phrase("Re-reading `headRefOid` on a settle window does not reach that half at all"),
  );
});

// The remedy for a real mismatch, and its bound. Two clauses that fail
// independently: without the fetch-and-re-create the ordinary cause (this
// clone has not fetched) costs a dispatch it need not cost, and without the
// bound the same instruction reads as "keep fetching until it agrees" — the
// unbounded loop run-merge-bot.md's step 1 already had to have written out of
// it once.
//
// The instruction also has to survive being carried out literally: the path
// is already occupied by the tree the first bullet just created, so
// re-running `git worktree add --detach <path> origin/<branch>` on it exits
// 128 without `git worktree remove --force <path>` first — measured in a
// scratch repo (git 2.50.1). That removal is pinned by name, the same form
// phase 5's own scratch-worktree duty already uses.
test("phase 1 retries a mismatch once through a fetch, and says it is once", () => {
  assert.match(slice(), phrase("git worktree remove --force <path>"));
  assert.match(slice(), phrase("fetch and re-create once before reporting it"));
  assert.match(slice(), phrase("Bounded at one retry"));
});

// The asymmetry, pinned as a MAPPING rather than as two presences. Both words
// live in the same short paragraph, so `/LOUDLY/` + `/SILENTLY/` stay green with
// the two swapped — which inverts the whole point, since the reader would then
// treat the silent failure as the one that announces itself. `[^.]` keeps each
// match inside one sentence and the lookahead is what makes a swap red.
test("phase 1 binds the loud failure to the runner and the silent one to the base", () => {
  assert.match(slice(), /missing\s+runner(?:(?!SILENTLY)[^.])*?LOUDLY/);
  assert.match(slice(), /stale\s+base(?:(?!LOUDLY)[^.])*?SILENTLY/);
});

// The backstop's SCOPE. "review-pr.js refuses" alone reads as coverage and makes
// the phase-1 verify look redundant — the exact reasoning that would delete it.
// What has to survive is that a hand-dispatched worktree is outside that net,
// and that the net covering the other path is still not a substitute for the
// compare in this one.
//
// #1168 wove that net from the lagging field, and this paragraph said so. #1513
// moved `review-pr.js`'s own operand to the same `ls-remote` read this bullet
// uses, which makes the old sentence FALSE — and false in the direction that
// costs something, since a controller told the workflow check is unsound has a
// reason to distrust a review that refused for a real mismatch. So the claim is
// pinned in its new form AND the superseded one is forbidden by name: a revert
// to it satisfies every positive pin here word for word.
test("phase 1 keeps the workflow backstop from reading as full coverage", () => {
  // The paragraph's OPENING claim, and a measured gap: with only the pins that
  // follow, reverting this clause to "whose head is not the PR head" left this
  // file 11/11 green. The bolded `That backstop now compares…` sentence then
  // contradicts it, and a reader takes the operand from whichever they hit
  // first.
  assert.match(slice(), phrase("refuses a snapshot whose head is not the branch ref's"));
  assert.match(slice(), phrase("A worktree you hand to an agent directly is not"));
  assert.match(slice(), phrase("That backstop now compares against the same ref this bullet does"));
  assert.match(slice(), phrase("never a reason to skip the ref compare"));
  assert.doesNotMatch(
    slice(),
    /backstop compares against `headRefOid`/,
    "the paragraph has the workflow backstop comparing against the PR object again — #1513 moved it to the branch ref, and a controller reading the stale claim distrusts a check that is now sound",
  );
});

// The run-log marker this paragraph QUOTES is a verbatim copy of a string in
// `review-pr.js`, which is the disconnect this repo files as a defect in its own
// right: a prose-only presence pin stays green while the code's marker moves,
// and a controller then hunts a run log for a line it will never find. Compared
// against the source, so either side moving reds.
test("phase 1's quoted run-log marker is the one review-pr.js actually prints", () => {
  assert.match(slice(), phrase("branch ref (absent): head check SKIPPED"));
  const line = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("log(`snapshot "));
  assert.ok(line, "review-pr.js's snapshot run-log line is gone — the marker this paragraph quotes is printed nowhere");
  assert.ok(
    line.includes("branch ref ") && line.includes("(absent): head check SKIPPED"),
    `phase 1 quotes a run-log marker review-pr.js no longer prints:\n  ${line}`,
  );
});
