import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #389. The runbook calls the finisher an auditor, but its gate MUTATES: the
// controller has it independently re-run the ticket's acceptance mutation, run
// the suite, and discard. That makes it a writer in the worktree the
// fix-applier owns, with nothing sequencing the two. Measured on #380 — the
// finisher was inside that worktree at the instant the fix-applier announced
// one more clause to land. Neither ordering is detectable afterwards from the
// diff: a restore eats the uncommitted clause, or the mutant is still there
// when the fix-applier commits and a deliberately broken guard ships as the
// fix, in a commit nothing re-reviews.
//
// The ruling was the middle option of the three the ticket raised: give the
// finisher its own tree. NOT "sequence them" (controller discipline is what
// failed) and NOT "make the finisher non-mutating" (that trades away the
// independent verification the gate exists for) — so this file pins the
// mutation as much as the isolation.
//
// Slice-scoped, not whole-file: a bare presence check anywhere in this
// 1900+ line SKILL.md stays green even when the text moves somewhere its
// reader never reaches (measured before in this same file, #172).
const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

// The gate belongs to the finisher's duty 2 — verifying a claim by RUNNING is
// the same duty as verifying it by reading the diff, and duty 2 is where the
// finisher already reads. Anchored on the two duties' own opening text, so a
// renumber or a move out of the duty list reds rather than passing vacuously.
const DUTY1_START = "1. **Audit the worktree**";
const DUTY2_START = "2. **Confirm every deferral";
const DUTY2_END = "3. Add `ready-to-merge`";

// Markdown hard-wraps at ~80 columns and this text is a list continuation, so
// every phrase can split across a line with leading indent re-injected at the
// wrap point. Flattening makes the wrap invisible to a phrase match — so a
// pure rewrap, words untouched, cannot red a pin here. Every match in this
// file goes through it; a raw-RUN_TEAM assertion is reflow-brittle and reds
// with a message implying the prose was weakened when nothing was.
const flat = (s) => s.replace(/\n[ \t]*/g, " ");

function between(start, end) {
  const at = RUN_TEAM.indexOf(start);
  assert.notEqual(at, -1, `finisher duty opener ('${start}') moved — update this test`);
  const to = RUN_TEAM.indexOf(end, at);
  assert.notEqual(to, -1, `finisher duty opener ('${end}') moved — update this test`);
  return flat(RUN_TEAM.slice(at, to));
}

const duty1Text = () => between(DUTY1_START, DUTY2_START);
const duty2Text = () => between(DUTY2_START, DUTY2_END);

test("the mutation gate runs in a worktree the finisher adds itself, at its dispatch pin", () => {
  const text = duty2Text();
  // ONE contiguous span. The command and its ref operand have to stay joined:
  // `worktree add --detach` at some other ref is a different instruction, and
  // two independent phrase matches stay green through exactly that swap.
  assert.match(
    text,
    /git worktree add --detach [^`]*<your dispatch pin>/,
    "the gate no longer adds its own detached worktree at the dispatch pin — either the finisher is back to mutating the worktree another member owns, or the tree is created at some other ref",
  );
  // Which ref is the whole point, and it is the same substitution the halt
  // block's head-equality check already rejects: a member that kept working
  // and pushed after the pin matches the branch tip, so a tree cut at
  // `headRefOid` gets mutation-verified over commits no reviewer read.
  assert.doesNotMatch(
    text,
    /git worktree add --detach [^`]*(headRefOid|origin\/)/,
    "the throwaway tree is cut at the pushed branch tip rather than the dispatch pin — a member that pushed past the pin gets its unreviewed commits verified and labelled",
  );
  // The scratch root is shared with every sibling member, so the PR number
  // alone is not a unique path: a PR with a second finisher collides, and
  // `worktree add` on an occupied path fails closed into a halt with a purely
  // mechanical cause.
  //
  // Read the path OFF the add and require the remove to name it back. The
  // token appears twice, so a bare match on the scoping is satisfied by
  // either occurrence alone: strip it from just one command and add/remove
  // silently target different paths, which is undetectable in both
  // directions. Mismatched, the remove either refuses (rc 128, tree leaked)
  // or succeeds against a differently-scoped path and takes a sibling
  // finisher's tree with it.
  const added = text.match(/git worktree add --detach ([^`]*?) <your dispatch pin>/);
  assert.ok(added, "no `git worktree add --detach <path> <your dispatch pin>` left to read a path out of");
  assert.match(
    added[1],
    /^<scratch>\/pr<N>\/finish-<your member name>$/,
    "the throwaway tree's path no longer carries the member name — the scratch root is shared, so two finishers on one PR collide on it",
  );
  assert.match(
    text,
    new RegExp(`git worktree remove --force ${added[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "the remove names a different path than the add — either the remove refuses and the tree leaks, or it removes a differently-scoped tree that is not this finisher's",
  );
});

test("the throwaway tree is removed on every path, failures included, and --force is scoped to it", () => {
  const text = duty2Text();
  assert.match(
    text,
    /git worktree remove --force/,
    "the removal no longer forces — the tree is deliberately dirty when the gate finishes, so a plain remove refuses it and the tree leaks",
  );
  // Contiguous: "remove it" and "on every path including the failing ones" are
  // one invariant. A removal documented only on the success path is exactly
  // the leak this criterion exists to prevent, and it reads as satisfied if
  // the two halves are matched separately.
  assert.match(
    text,
    /Remove it on every path, the failing ones included/,
    "the every-path removal invariant is gone or was split — a gate that only removes the tree when the mutation behaves leaks one worktree per halt",
  );
  // `--force` is banned elsewhere in this runbook on worktrees that might hold
  // someone's only copy. Without the stated scope this reads as a licence.
  assert.match(
    text,
    /right only here/,
    "the `--force` exception no longer says it is scoped to this tree — elsewhere in this runbook a `worktree remove` refusal is a finding, and an unscoped exception reads as permission to force past it",
  );
  // Nothing sweeps a leak for the finisher: reap's branchless sweep is bounded
  // to the fleet's worktree home, so a tree under <scratch> is reported and
  // left. A gate that assumes reap collects it will leak silently.
  assert.match(
    text,
    /reap\.sh/,
    "the gate no longer says a leaked scratch tree is outside reap's sweep — a finisher that assumes the leak is collected for it leaves one per finish",
  );
});

test("the owned worktree stays a read — the finisher never writes to or restores it", () => {
  const text = duty2Text();
  // The live incident's near-miss: the controller's halt instruction said
  // "restore the mutated paths", which IS the silent-destruction ordering. The
  // finisher refused because it could not prove the diff was its own. That
  // refusal was judgement, not a rule; this makes it a rule.
  assert.match(
    text,
    /None of this licenses a write to the owned worktree\./,
    "the ban on writing to the owned worktree is gone — the throwaway tree removes the hazard only while the finisher also stops treating the owned tree as a write target",
  );
  assert.match(
    text,
    /you never restore that tree, because you never wrote to it/,
    "the no-restore rule no longer reads as a consequence of never having written — stated as a bare prohibition it invites a controller instruction to override it, which is what happened live",
  );
});

test("independent re-verification survives — the gate still mutates and runs the suite itself", () => {
  const text = duty2Text();
  // ACCEPT side. The ticket's third option was to make the finisher
  // non-mutating and have it read the fix-applier's record instead. That was
  // ruled out: the independent gate caught two unpinned fixes in the run that
  // produced this ticket. A change that isolates the writes but quietly drops
  // the mutation satisfies every other test here and guts the gate.
  assert.match(
    text,
    /acceptance mutation/,
    "the gate no longer re-runs the ticket's acceptance mutation — isolating the write is not the point if the independent verification goes with it",
  );
  assert.match(
    text,
    /<testCmd>/,
    "the gate no longer runs the suite itself — reading the fix-applier's recorded result is the option this ticket's ruling rejected",
  );
  // A placeholder nobody substitutes is not a gate. `<testCmd>` reaches the
  // finisher only through the controller's prompt — there is no fleet-finisher
  // agent definition to carry a default — and the runbook's pass-list named
  // the workflow and the fix-applier only, so the gate shipped unenforceable.
  assert.match(
    duty1Text(),
    /Give it `<testCmd>` too[^.]*duty 2's mutation gate runs it/,
    "the controller is no longer told to hand the finisher a `<testCmd>` — duty 2's placeholders reach it unsubstituted and the gate has no command to run",
  );
});

test("duty 1's dirty-tree halt survives, and duty 2's own caveats are not clipped", () => {
  // ACCEPT side, and the neighbour check. Duty 1's halt is the guard that
  // caught #389 live; the throwaway tree makes an overlap harmless, which is
  // not a reason to stop detecting one. It is unpinned everywhere else, and it
  // sits one duty away from this edit. (The always-halts invariant in the
  // two-cause block is already owned by finisher-pin-race-prose.test.mjs — not
  // re-pinned here.)
  assert.match(
    duty1Text(),
    /Dirty or diverged halts the finisher \*here\*, before the label/,
    "duty 1's dirty-or-diverged halt no longer reads as before — check it was not weakened while giving the gate its own tree",
  );
  // The paragraph the new gate is appended directly after, and the half of
  // duty 2 that dedupe-guard-prose.test.mjs does NOT cover: it pins the
  // positive `origin/main...HEAD` check, nothing pins this scoping caveat. An
  // insertion that swallows a trailing paragraph is the ordinary way to break
  // a neighbour, and it leaves every other test here green.
  assert.match(
    duty2Text(),
    /That range is right for the positive check and wrong for a negative one\./,
    "duty 2's negative-claim scoping caveat was clipped — appending the mutation gate must not swallow the paragraph it lands after",
  );
});
