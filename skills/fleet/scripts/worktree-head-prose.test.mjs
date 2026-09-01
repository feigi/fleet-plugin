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

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

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

// Verification (#532's option 1), all three parts. The two commands are what
// makes it runnable; BOTH commits in the report is what makes the refusal
// actionable, since the subjects are identical and a report naming one sha
// cannot be told from a report about the right tree.
test("phase 1 gives both sides of the head comparison and refuses on mismatch", () => {
  assert.match(slice(), phrase("git -C <path> rev-parse HEAD"));
  assert.match(slice(), phrase("gh pr view <N> --json headRefOid -q .headRefOid"));
  assert.match(slice(), phrase("dispatch nothing into that worktree"));
  assert.match(slice(), phrase("naming BOTH commits"));
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
// What has to survive is that a hand-dispatched worktree is outside that net.
test("phase 1 keeps the workflow backstop from reading as full coverage", () => {
  assert.match(slice(), phrase("A worktree you hand to an agent directly is not"));
});
