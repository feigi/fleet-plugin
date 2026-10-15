import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { renderBrief } from "./support/render-brief.mjs";
import { HALT_CAUSES } from "../plugin/scripts/ledger-grammar.mjs";

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
const REPO = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

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
  // finisher only through its brief — the agent body names the value, never
  // carries one — and the renderer refuses a finisher brief rendered without
  // `--testCmd`, so the controller's instruction to pass it is pinned beside
  // the brief that carries it.
  //
  // The instruction and its reason in ONE sentence, `sentences()`'s (#1940).
  // The first-period `[^.]*` gap this replaces refused a valid rewording with
  // an "e.g." or a filename between the two, and ran on past a `?` or `!` —
  // the latter nearly inert here, since both phrases must be verbatim anyway.
  assert.ok(
    Pin.sentences(duty1Text()).some((s) => /Pass `--testCmd` too.*duty 2's mutation gate runs it/.test(s)),
    "the controller is no longer told to pass the finisher a `--testCmd` — duty 2's placeholders reach it unsubstituted and the gate has no command to run",
  );
  assert.match(renderBrief("finisher", "fresh"), /^testCmd: TESTCMD-4$/m, "the finisher's brief no longer carries the test command duty 2's gate runs");
});

// Duty 1 was a procedure a finisher followed by hand (#525, #1106, #2141): run
// `worktree-audit.sh`, which takes no argument and audits every worktree, find
// this worktree's row by the resolved form of the path, read dirty from the row,
// compare `HEAD` to the dispatch pin, halt on the three row shapes that cannot
// answer. Each of those was a sentence a clause could be deleted from, and the
// by-hand reading of them is what the duty script `finisher-audit.mjs` removes.
// The behaviour moved with it: finisher-audit.test.mjs drives the no-argument
// audit, the realpath match, the dirty cross-check, the head-equality check and
// all three row shapes against real repositories. What stays pinned here is
// what only the duty's prose can say: that the duty IS the script, how it is
// called, and what each exit code obliges. Each pin holds ONE sentence
// (`sentences()`, #1940), so a clause deleted from inside the duty reds its own
// pin rather than being satisfied by a neighbour.
test("duty 1 is one script, called through the Resolver with both flags, its exit code the verdict", () => {
  const said = (re) => Pin.sentences(duty1Text()).some((s) => re.test(s));
  assert.ok(
    said(/\*\*Audit the worktree\*\* by running one script, `finisher-audit\.mjs`/),
    "duty 1 no longer opens by running `finisher-audit.mjs` — it is back to being steps a finisher follows by hand",
  );
  assert.ok(
    said(/`~\/\.fleet\/bin\/fleet-run finisher-audit\.mjs --worktree <abs-path> --pin <your dispatch pin>`, the path the one you were dispatched with, however it was spelled, and the pin the full SHA/),
    "duty 1 no longer gives the script's call with the dispatched path as --worktree and the full dispatch SHA as --pin",
  );
  assert.ok(
    said(/Its exit code is the verdict of this duty/),
    "duty 1 no longer says the script's exit code is the verdict — a finisher reads the JSON and decides for itself",
  );
  // The three things the script settles that a finisher used to settle by eye,
  // each named so that deleting one reds. Hand instructions for any of them
  // are the by-hand path back, and are excluded below.
  assert.ok(
    said(/finds this worktree's row by its `realpath`, so a spelling reached through a symlink still finds a healthy worktree's row/),
    "duty 1 no longer says the row is matched by realpath — a symlinked spelling finds no row and halts a healthy tree as *worktree absent*",
  );
  assert.ok(
    said(/it reads dirty from the row and from `git status --porcelain -unormal`/),
    "duty 1 no longer names the dirty check's two instruments — the row's `dirty` field and `git status --porcelain -unormal`",
  );
  assert.ok(
    said(/it compares the worktree's `HEAD` to your dispatch pin/),
    "duty 1 no longer says diverged is the worktree's HEAD against the dispatch pin — neither the audit nor git status can see a clean tree that moved past it",
  );
  assert.doesNotMatch(
    duty1Text(),
    /`realpath <abs-path>`|`cd <abs-path> && pwd -P`|it takes no argument|row's `ahead`/,
    "duty 1 tells the finisher to resolve the path, call `worktree-audit.sh` or read the row by hand again — the script owns those steps",
  );
});

test("duty 1's exit codes: 0 alone is clean, 1 names a cause from the ledger's vocabulary, 2 halts as `other`", () => {
  const said = (re) => Pin.sentences(duty1Text()).some((s) => re.test(s));
  assert.ok(
    said(/Exit 0, `cause` null, is the only result that means the worktree is clean at your pin/),
    "duty 1 no longer says exit 0 with a null cause is the only clean result",
  );
  const causes = `${HALT_CAUSES.slice(0, -1).map((c) => `\`${c}\``).join(", ")} or \`${HALT_CAUSES.at(-1)}\``;
  assert.ok(
    said(new RegExp(`Exit 1 means \`cause\` names why not — ${causes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — and exit 2 means the script could not look`)),
    "duty 1's exit 1 causes are no longer the ledger's `halted:<cause>` vocabulary, or exit 2 is no longer named — the ledger refuses a word it does not know",
  );
  // The halt itself. Every non-zero exit, and so every cause and the could-not-
  // look exit, halts *here* before the label; an exit 2 is not a pass with an
  // empty verdict.
  assert.ok(
    said(/Every non-zero exit halts the finisher \*here\*, before the label: it reports the verdict as printed and labels nothing, and an exit 2 is cause `other` with the line the script printed on stderr as its evidence/),
    "duty 1 no longer halts the finisher *here*, before the label, on every non-zero exit — check it was not weakened",
  );
  assert.ok(
    said(/none of the script's steps is run by hand to get past a halt/),
    "duty 1 no longer forbids running the script's steps by hand to get past a halt",
  );
});

test("duty 2's own caveats are not clipped by duty 1's rewrite", () => {
  // The neighbour check. Duty 1's halt is the guard that caught #389 live, and
  // it is pinned above; duty 2 sits directly under it. (The always-halts
  // invariant in the halt block is owned by finisher-pin-race-prose.test.mjs —
  // not re-pinned here.)
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
