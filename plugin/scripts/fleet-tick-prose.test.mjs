// Pins the run-team prose that makes fleet-tick.mjs reachable. The script is
// inert if nothing invokes it: #3's failure was not a missing computation, it
// was a correct table nobody consulted under a merge-side event storm, and a
// reconcile the event loop never names is that failure with an extra file.
//
// THE CEILING EVERY PIN HERE SHARES, same as review-path-default.test.mjs:
// these prove a phrase is PRESENT. None can prove it is not NEGATED — a
// sentence inserted inside the slice granting the opposite reads as fine to all
// of them. Read each as "not vacuous to rewording", never as "this rule cannot
// be subverted".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between as section, markedLine, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// SLICE SIZE is what does the anchoring. A regex over a whole section is
// satisfied by incidental prose elsewhere in it, and an unbounded slice runs to
// EOF where the red-flag list restates half of this vocabulary — enough to keep
// every assertion below green with the section deleted outright.
// The tick instruction only, ending where the next standing instruction
// begins. Widened to the whole Phase 3 loop it would be satisfied by the wake
// bullets' own mentions of the tick, which say nothing about the script.
const tickBlock = () =>
  section(RUN_TEAM, "**Every wake ends in the tick.**", "**Own the CI waits.**", "run-team tick block");

// The six counts a caller used to state (#1803 deleted them, spec 2026-09-24
// § 6 §1). Any one of them back in the block is a controller told to supply a
// number the tick now refuses as an unknown flag — exit 2 on every wake.
const DELETED_FLAGS = ["--implementers", "--reviewers", "--merge-bots", "--pool", "--reviews-ready", "--merge-holds"];

test("the tick block names the script and only the flags it still takes", () => {
  const s = tickBlock();
  assert.match(s, /fleet-tick\.mjs/);
  // The three configuration flags that survived, individually: a cap passed
  // from `$ARGUMENTS` and the review bound are the only things a caller says.
  for (const flag of ["--implementer-cap", "--reviewer-cap", "--max-reviews"]) {
    assert.ok(s.includes(flag), `tick block does not name ${flag}`);
  }
  // A lookahead after the name, so `--reviewer-cap` never reads as `--reviewers`
  // and `--pool` never matches inside a longer word.
  for (const flag of DELETED_FLAGS) {
    assert.doesNotMatch(s, new RegExp(`${flag}(?![\\w-])`), `tick block still names ${flag}, which fleet-tick.mjs refuses since #1803`);
  }
});

test("the tick block says the tick reads the run itself, and nobody states a count", () => {
  // Inverted from the caller-stated era. A reader told the counts are theirs to
  // state hunts for flags that no longer exist; one told nothing hand-edits a
  // row to make the tick see what it wants. The ledger is the input, written
  // through ledger.mjs, and a token the tick cannot read is a refusal.
  const s = tickBlock();
  assert.match(s, phrase("nobody states a count"));
  assert.match(s, /`\.fleet\/ledger\.md`/);
  assert.match(s, /`\.fleet\/shortlist\.json`/);
  assert.match(s, phrase("refuses rather than guessing"));
  assert.doesNotMatch(s, /refuses rather than\s+defaulting them/, "the block still says the live counts are the controller's to state");
});

// The Pair itself, bounded to its own paragraph: ADR 0004's marked-line shape,
// read line by line rather than by a regex over the block.
const maxReviewsPair = () =>
  section(RUN_TEAM, "**`--max-reviews <n>`", "\n\n", "run-team --max-reviews Pair");

test("--max-reviews is a Marked-line Pair: Claude bounds reviews at one, omp runs to the reviewer cap", () => {
  const region = maxReviewsPair();
  const claude = markedLine(region, "CLAUDE", "--max-reviews CLAUDE line");
  const omp = markedLine(region, "OMP", "--max-reviews OMP line");
  assert.match(claude, phrase("fleet-tick.mjs --max-reviews 1`"));
  assert.match(omp, /fleet-tick\.mjs`/);
  assert.doesNotMatch(omp, /--max-reviews/, "the omp line bounds reviews too — the default there is the reviewer cap");
  // The lift condition is what keeps the Claude bound from reading permanent.
  assert.match(region, phrase("two concurrent"));
});

test("the record-before-tick table names every wake, each with what it records", () => {
  // Spec 2026-09-24 § 6 §7. The table IS the edge list now: a wake missing from
  // it is a wake that records nothing and so is invisible to the tick, which
  // reads only the ledger. Row by row, each by its wake and its record.
  const table = section(RUN_TEAM, "| Wake | Record, then tick |", "\n\n", "record-before-tick table");
  const rows = table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Wake"));
  const WAKES = [
    ["Implementer report", ["verify-sha.sh", "settle impl-<N>=PR#<M>", "=bailed"]],
    ["Review workflow notification / `review-pr-<n>` report", ["<scratch>/review-<pr>.json", "reviewed=<head>:"]],
    ["Fix-applier report", ["settle fix-pr-<M>=", "ruled"]],
    ["Finisher report", ["settle finisher-pr-<M>=labelled"]],
    ["Label seen (persistent Monitor)", ["nothing to record"]],
    ["CI run terminal", ["ci=<run-id>:<attempt>:<conclusion>", "finisher gate"]],
    ["Merge-bot pass report", ["held-behind:#<lower>", "settle merge-bot-<n>=done", "reap.sh --apply"]],
    ["Drain", ["ledger.mjs drain", "settle impl-<N>=released"]],
    ["Heartbeat", ["nothing to record"]],
  ];
  assert.equal(rows.length, WAKES.length, `the table has ${rows.length} wake rows, not the ${WAKES.length} the spec names`);
  for (const [wake, records] of WAKES) {
    const row = rows.find((r) => r.startsWith(`| ${wake} |`));
    assert.ok(row, `the record-before-tick table has no "${wake}" row`);
    for (const rec of records) assert.ok(row.includes(rec), `the "${wake}" row no longer records ${rec}`);
  }
  // What follows the table: the tick, every printed line acted on, the beat.
  assert.match(section(RUN_TEAM, "| Heartbeat |", "\n- **", "after the table"), phrase("act on every line it prints, and arm the beat"));
});

test("the tick block admits no wake covers a drained queue, and says whose case that is", () => {
  // A reader who takes the wakes for the whole cure stops looking for the
  // drained-queue case they cannot reach. The pointer is the part that must not
  // rot — an admission with nowhere to go is how #3 lost item 2.
  const s = tickBlock();
  assert.match(s, /none\s+covers a fully drained queue/);
  assert.match(s, /fleet-heartbeat\.mjs/);
});

// Both merge-side wakes, each sliced to its own bullet — the shared vocabulary
// makes a section-wide match worthless here.
test("the merge-bot-pass-done wake records, reaps, then ticks", () => {
  const bullet = section(RUN_TEAM, "- **Merge-bot pass reports done**", "\n- **The run ends", "merge-bot-done wake");
  assert.match(bullet, /reap\.sh --apply/);
  assert.match(bullet, /run the tick/);
});

test("the CI-terminal wake runs the tick", () => {
  const bullet = section(RUN_TEAM, "- **Monitor: CI run completes**", "\n- **A fix-applier reports", "CI-terminal wake");
  assert.match(bullet, /run the tick/);
});

// The queue-depth table's own slice, ending at the `/triage` note that follows
// it. Anchored to the section heading instead, the pointer would be satisfied
// by the Phase 3 block above, which lives in the same file.
const queueDepthTable = () =>
  section(RUN_TEAM, "**Do not re-derive this by hand", "`/triage` is user-invoked only", "queue-depth table");

test("the queue-depth table points at the executable reconcile", () => {
  const s = queueDepthTable();
  assert.match(s, /fleet-tick\.mjs/);
  assert.match(s, /computed, not remembered/);
});

test("the queue-depth table keeps the implementer row's three holds above its rows", () => {
  // The one ordering the script encodes that the table cannot show: implementers()
  // returns a HOLD for a drain, a tier mismatch or a saturated review side before
  // it ever reaches a PULL. A table read as authoritative without them Pulls
  // under a hold. All three, each by the ACTION string the tick prints.
  const s = queueDepthTable();
  assert.match(s, /Three\s+holds\s+outrank\s+every\s+row/);
  for (const hold of ["`HOLD (draining)`", "`HOLD (tier mismatch impl-<N>)`", "`HOLD (review side saturated)`"]) {
    assert.ok(s.includes(hold), `the queue-depth table no longer names ${hold} above its rows`);
  }
});

test("the queue-depth table's empty row suggests /triage and asks nobody to tick (#1804)", () => {
  // Supply is automatic (ADR 0013): the old pool-0 rows asked the maintainer to
  // tick a multi-select that no longer exists. Exactly one row answers an empty
  // shortlist after the tick's own refresh, and it is the tick's own string.
  const s = queueDepthTable();
  assert.match(s, /\|\s*0 after that refresh\s*\|\s*`SUGGEST \/triage, hold idle`\s*\|/);
  assert.doesNotMatch(s, /ask the maintainer to tick/, "the queue-depth table asks the maintainer to tick — phase 0's multi-select is retired (ADR 0013)");
});

test("the review-backlog definition states what the script actually counts", () => {
  // The gate's input. Left as the narrow definition alone, a controller reading
  // a HOLD cannot tell an over-count from a real review-bound pipeline.
  const def = section(RUN_TEAM, "- **review backlog**", "\n\n**Defaults: 2 implementers, 6 reviewers", "review-backlog definition");
  assert.match(def, /open PR without `ready-to-merge`/);
  // The review state now lives on the ledger (spec 2026-09-24 § 3 §7), so the
  // count is exact rather than a wider read held "earlier, never later": a PR
  // with a `review=` token is under review or reviewed, and one settled
  // `=failed` is owed a review again.
  assert.match(def, /no\s+`review=`\s+token/);
  assert.match(def, /`=failed`/);
  assert.doesNotMatch(def, /lives in your head/, "the definition still says per-PR review state lives in the controller's head — the ledger records it");
  // Both halves of the closing-issue clause. The predicate alone is a rule a
  // reader can only obey; the reason is what stops the next narrowing pass
  // from dropping it as a stray filter, since a PR nothing will ever review
  // floors the gate's input permanently rather than transiently.
  assert.match(def, /that closes an\s+issue/);
  assert.match(def, /nothing in the run can drain/);
  // The exemption is scoped to the chore PR THIS run authors. Unscoped, a reader
  // applies it to an INHERITED chore PR too — which step 0 queues for review, so
  // a reader counts it BY HAND. The reviewBacklog number excludes it either way:
  // a PR closing no issue fails the closing-issue test whichever run left it
  // open, so nothing here is a claim about the script's output. That under-read
  // is the opposite error from #590's over-read, and the narrow phrase separates
  // them.
  //
  // Finding 2: \s+ between every pinned word, matching this file's own
  // convention above. The pinned clause spans a line break in SKILL.md, so
  // literal spaces red on a whitespace-only reflow — a false failure naming a
  // regression that did not happen.
  assert.match(def, /never\s+one\s+a\s+PRIOR\s+run\s+left\s+open/);
  // The corrected half: the prose must keep saying the mechanical number
  // excludes such a PR, or the by-hand reading silently becomes a claim about
  // fleet-tick.mjs again.
  assert.match(def, /number\s+still\s+excludes\s+it/);
  assert.match(def, /BY\s+HAND/);
});

// The step-0 fold-in bullet only, ending where the numbered candidate scan
// begins. Widened to the whole of phase 0 it would be satisfied by the
// candidate-scan and in-flight bullets, which talk about queueing and review
// without saying inherited PRs are in scope at all.
const foldInBlock = () =>
  section(
    RUN_TEAM,
    "**Fold in every PR a prior run left open, before shortlisting.**",
    "1. **Build the Shortlist**",
    "run-team step-0 fold-in block",
  );

test("the fold-in block says inherited PRs are queued before shortlisting, as ordinary review work", () => {
  // #1237's own review found this bullet unpinned while its sibling addition in
  // the same PR was pinned. Unpinned, a reword silently reverts phase 0 to
  // scanning ISSUES only and inherited PRs go unreviewed again — the #1222
  // pattern this bullet cites as its own motivation.
  const s = foldInBlock();
  assert.match(s, /before\s+shortlisting/);
  // The three roles individually. "Queue it for review" without them reads as a
  // note to self; naming them is what makes it the same pipeline as ticket work.
  for (const role of ["review workflow", "fix-applier", "finisher"]) {
    assert.ok(s.includes(role), `fold-in block does not name the ${role}`);
  }
  // The #590 tie-back is the reason the rule survives a narrowing pass: a PR
  // that is both unreviewable and uncounted is what strands the gate.
  assert.match(s, /unreviewable AND uncounted/);
});

// --------------------------------------------------------------------------
// The heartbeat's prose — #357. It belongs in this file for the reason the
// header gives: these pins exist because a reconcile nothing invokes is #3 with
// an extra file, and on a drained queue the heartbeat is the ONLY thing that
// invokes it. The slice is the standing instruction, ending where the CI-wait
// instruction begins.
const heartbeatBlock = () =>
  section(RUN_TEAM, "**Beat when there is nothing to do", "**Own the CI waits.**", "run-team heartbeat block");

test("the event loop tells the controller to arm the beat instead of ending its turn", () => {
  // The entry point. Every word of the block below is unreachable if the loop
  // never says to run it, which is exactly how item 2 of #3 went missing.
  const bullet = section(RUN_TEAM, "- **Nothing to do right now**", "- **Implementer report**",
    "nothing-to-do event");
  assert.match(bullet, /do not end your turn/);
});

test("the heartbeat block names the script and the re-issue protocol", () => {
  const s = heartbeatBlock();
  assert.match(s, /fleet-heartbeat\.mjs/);
  // The partial-hold branch IS the mechanism on both harnesses: no harness lets
  // one command block a whole interval, so a reader who stops at the first line
  // ends the turn mid-interval and the beat dies there. Prose that names the
  // script without the re-issue rule is a heartbeat with one beat.
  assert.match(s, /re-issue this command now, do not end your turn/);
  assert.match(s, /one blocking call per turn/);
});

test("the heartbeat block says why the ceiling is bounded", () => {
  // Without the reason, 20 minutes reads as arbitrary and the next reader
  // raises it to an hour — reintroducing #3's blindness at a slower rate, which
  // is the one failure this design can still be tuned into.
  assert.match(heartbeatBlock(), /supply grows from OUTSIDE the fleet/);
  assert.match(heartbeatBlock(), /Do not raise it past 30\s+minutes/);
});

test("the heartbeat block forbids stopping on an idle queue", () => {
  // The unattended-overnight ruling. A beat that ends when supply empties
  // terminates the run at 01:00 and misses every ticket triaged after it.
  assert.match(heartbeatBlock(), /does not stop on idleness/);
});

test("the heartbeat block gives the command for a deliberate stop", () => {
  // #1597. Nothing else can write the reason afterwards — the mark has one
  // writer and that writer is this script — so a controller that never reads
  // the flag leaves every deliberate stop indistinguishable from a crash, and
  // the next run reports "no recorded reason" for a death that named itself.
  // The literal invocation, not just the idea: a reader who knows a stop
  // "should be recorded" and not how has the same nothing.
  const s = heartbeatBlock();
  assert.match(s, /--stop "budget exhausted"/);
  assert.match(s, /holds nothing and returns at once/);
  // And that skipping it is survivable, because a controller told only that
  // it is required will burn a turn on it while the budget it is out of runs
  // down. The honest cost is one degraded field, not a lost run.
  assert.match(s, /Skipping it is not fatal/);
});

test("the heartbeat block says a stall line is the PREVIOUS run and names what is stranded", () => {
  // Both halves are load-bearing and neither is obvious. Read as this run's
  // own state, the line is a controller reporting itself dead — the shape
  // that gets a healthy run abandoned. And a stall whose stranded tickets go
  // unmentioned is read as an obituary rather than as work: those tickets
  // keep the claim label the candidate scan excludes, so nothing else in the
  // run will ever surface them again.
  const s = heartbeatBlock();
  assert.match(s, /is the PREVIOUS run, never this one/);
  assert.match(s, /in-progress/);
  assert.match(s, /EXCLUDES that label/);
  // Detection only — the ruling this ticket's whole scope rests on. Prose
  // that left this open invites a controller to invent a restart, which is
  // the question ADR 0008 ruled on and #1724 owns.
  assert.match(s, /nothing restarts the run that stranded them/);
});
