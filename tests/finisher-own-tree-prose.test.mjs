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
// Slice-scoped, not whole-file: a bare presence check anywhere in the
// finisher's agent body stays green even when the text moves somewhere its
// reader never reaches (measured before in this same file, #172). The duties
// are stated in that body, which the harness injects as the finisher's system
// prompt; run-team's SKILL.md no longer restates them.
const REPO = join(import.meta.dirname, "..", "plugin");
const FINISHER_BODY = readFileSync(join(REPO, "agents", "fleet-finisher.agent.md"), "utf8");

// The gate belongs to the finisher's duty 2 — verifying a claim by RUNNING is
// the same duty as verifying it by reading the diff, and duty 2 is where the
// finisher already reads. Anchored on the duties' own opening text, so a
// move out of the duty's block reds rather than passing vacuously.
const DUTY1_START = "**Duty 1 is one script, and its exit code is your verdict.**";
const DUTY1_END = "**Re-check the instrument set";
const DUTY2_START = "**Confirm every deferral";
const DUTY2_END = "**Duty 3 is one script";

// Markdown hard-wraps at ~80 columns and this text is a list continuation, so
// every phrase can split across a line with leading indent re-injected at the
// wrap point. Flattening makes the wrap invisible to a phrase match — so a
// pure rewrap, words untouched, cannot red a pin here. Every match in this
// file goes through it; a raw-body assertion is reflow-brittle and reds
// with a message implying the prose was weakened when nothing was.
const flat = (s) => s.replace(/\n[ \t]*/g, " ");

function between(start, end) {
  const at = FINISHER_BODY.indexOf(start);
  assert.notEqual(at, -1, `finisher duty opener ('${start}') moved — update this test`);
  const to = FINISHER_BODY.indexOf(end, at);
  assert.notEqual(to, -1, `finisher duty opener ('${end}') moved — update this test`);
  return flat(FINISHER_BODY.slice(at, to));
}

const duty1Text = () => between(DUTY1_START, DUTY1_END);
const duty2Text = () => between(DUTY2_START, DUTY2_END);

// The gate's two paragraphs' war stories are in references/finisher.md; the
// agent body states each rule, so the gate is still duty 2's, and the
// reference file carries the evidence for it.
const FINISHER_MD = Pin.of(readFileSync(join(REPO, "skills", "run-team", "references", "finisher.md"), "utf8"), "references/finisher.md");
const OWN_TREE = "## Whatever you verify by running, run in a tree nobody else owns";
const REMOVE_IT = "## Remove the verification worktree on every path";
const gateText = () => flat(FINISHER_MD.section(OWN_TREE, "references/finisher.md").text + FINISHER_MD.section(REMOVE_IT, "references/finisher.md").text);

test("duty 2 states the gate's two rules in the finisher's agent body", () => {
  const text = duty2Text();
  assert.match(text, Pin.phrase("**Whatever you verify by RUNNING, run in a tree nobody else owns.**"));
  assert.match(text, Pin.phrase("**Remove it on every path, the failing ones included** — a mutant that comes back green, a suite that will not start, your own halt at any duty."));
});

test("the mutation gate runs in a detached worktree at the dispatch pin, at a path that carries the member name", () => {
  const text = gateText();
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

// The tree the gate runs in is built by one script that also runs the Install
// step in it: a detached worktree holds tracked files only, so on a consumer
// whose dependencies are ignored the suite cannot start (exit 127), and
// nothing else in the finisher's body or brief ran the Install step there.
// finisher-tree.test.mjs drives the script against real repositories; what
// stays pinned here is that the finisher's text calls it with the dispatched
// values, reads its exit code as the verdict, and builds no tree on the paths
// that skip the mutation.
test("the gate's tree is built by finisher-tree.mjs, which runs the Install step in it", () => {
  const CALL = "`~/.fleet/bin/fleet-run finisher-tree.mjs --worktree <abs-path> --pin <your dispatch pin> --pr <N> --member <your member name> --scratch <scratch>`";
  for (const [where, text] of [["the agent body's duty 2", duty2Text()], ["references/finisher.md", gateText()]]) {
    assert.match(
      text,
      Pin.phrase(`${CALL} adds \`git worktree add --detach <scratch>/pr<N>/finish-<your member name> <your dispatch pin>\` and runs the Install step in it, as a claim does`),
      `${where} no longer has the finisher build its tree through finisher-tree.mjs with the path, the pin, the PR, the member name and the scratch root — the tree is back to tracked files only, and a suite whose dependencies are ignored cannot start`,
    );
    assert.match(
      text,
      Pin.phrase("Only exit 0 means a tree at your pin with its dependencies installed and the tree clean"),
      `${where} no longer says exit 0 alone is a usable tree`,
    );
    assert.match(
      text,
      Pin.phrase("Any other exit is a halt at duty 2: cause `other`, the receipt as the evidence, no label"),
      `${where} no longer halts every non-zero exit at duty 2 with cause \`other\`, the receipt as evidence and no label`,
    );
    assert.match(
      text,
      Pin.phrase("1 no usable tree (an occupied path, a failed add, a head that is not your pin, a Recipe that could not be read, a tree dirty before the Install step), 3 the Install step did not run (exit 126 or 127, a broken Recipe), 4 the Install step failed, 5 the Install step changed the tree or left its state unreadable; exit 2 is a refusal with no receipt, a refused invocation or a receipt the script could not write"),
      `${where} no longer names the script's distinct exit codes`,
    );
    assert.match(text, /the script fails closed on an occupied path/, `${where} no longer says an occupied path fails closed`);
    assert.doesNotMatch(text, /`worktree add` on an occupied path fails closed into a halt/, `${where} still says the finisher's own \`worktree add\` meets an occupied path`);
  }
});

test("the tree is built only on the mutation's path: after the Inert diff and Ticketless skips, never before them", () => {
  const text = duty2Text();
  const at = (s) => {
    const i = text.indexOf(s);
    assert.notEqual(i, -1, `duty 2 no longer contains '${s}' — update this test`);
    return i;
  };
  const tree = at("fleet-run finisher-tree.mjs");
  assert.ok(at("**Run the Inert diff verdict before the acceptance mutation.**") < tree, "the Inert diff verdict no longer runs before the tree is built — an inert PR gets a tree it never needed");
  assert.ok(at("**A Ticketless PR has no acceptance mutation to re-run.**") < tree, "the Ticketless check no longer runs before the tree is built — a ticketless PR gets a tree it never needed");
  assert.match(text, Pin.phrase("Only its exit 0 skips the acceptance mutation below"), "the Ticketless skip no longer covers the tree below it");
});

test("the throwaway tree is removed on every path, failures included, and --force is scoped to it", () => {
  const text = gateText();
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
  const text = gateText();
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
  // `--testCmd` (dispatch-prompt.test.mjs), so the brief carrying it is
  // pinned here.
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
    said(/\*\*Duty 1 is one script, and its exit code is your verdict\.\*\*/),
    "duty 1 no longer opens by running one script whose exit code is the verdict — it is back to being steps a finisher follows by hand",
  );
  assert.ok(
    said(/`~\/\.fleet\/bin\/fleet-run finisher-audit\.mjs --worktree <abs-path> --pin <your dispatch pin>` \(the path you were dispatched with, and the full SHA\)/),
    "duty 1 no longer gives the script's call with the dispatched path as --worktree and the full dispatch SHA as --pin",
  );
  assert.ok(
    said(/compares the worktree's `HEAD` to your pin/),
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
    said(/Exit 0, with `cause` null, is the only code that means the worktree is clean at your pin/),
    "duty 1 no longer says exit 0 with a null cause is the only clean result",
  );
  // `human` is duty 3's exit 5 and no verdict of duty 1's audit, so duty 1 does not name it.
  const audit = HALT_CAUSES.filter((c) => c !== "human");
  const causes = `${audit.slice(0, -1).map((c) => `\`${c}\``).join(", ")} or \`${audit.at(-1)}\``;
  assert.ok(
    said(new RegExp(`\`cause\` is the word you name — ${causes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
    "duty 1's exit 1 causes are no longer the ledger's `halted:<cause>` vocabulary — the ledger refuses a word it does not know",
  );
  // The halt itself. Every non-zero exit, and so every cause and the could-not-
  // look exit, halts; an exit 2 is not a pass with an empty verdict.
  assert.ok(
    said(/Exit 2 means the script could not look: you are halted with cause `other`, with the line it printed on stderr as the evidence/),
    "duty 1 no longer halts an exit 2 as cause `other` with the script's stderr as evidence — check it was not weakened",
  );
  assert.ok(
    said(/You do not run any of the script's steps by hand to get past a halt/),
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
