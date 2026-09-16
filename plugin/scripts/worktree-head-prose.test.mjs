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
test("phase 1 gives the creation form that cannot inherit a stale local ref", () => {
  assert.match(slice(), phrase("git worktree add --detach <path> origin/<branch>"));
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

// The lagging field is still READ here, and that is deliberate: its
// disagreement with the ref is the desync signal run-merge-bot.md's step 1
// acts on. What has to survive is the demotion, because a read whose role is
// unstated is one edit away from being the gate again.
test("phase 1 keeps the headRefOid read but says it is not the gate", () => {
  assert.match(slice(), phrase("gh pr view <N> --json headRefOid -q .headRefOid"));
  assert.match(slice(), phrase("it is NOT the gate"));
  assert.match(slice(), phrase("never the operand this refusal turns on"));
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
test("phase 1 retries a mismatch once through a fetch, and says it is once", () => {
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
// What has to survive is that a hand-dispatched worktree is outside that net —
// and, since #1168, that the net itself is woven from the lagging field, so it
// cannot stand in for the ref compare even on the path it does cover.
test("phase 1 keeps the workflow backstop from reading as full coverage", () => {
  assert.match(slice(), phrase("A worktree you hand to an agent directly is not"));
  assert.match(slice(), phrase("that backstop compares against `headRefOid`"));
  assert.match(slice(), phrase("never a reason to skip the ref compare"));
});
