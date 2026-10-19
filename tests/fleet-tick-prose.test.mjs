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
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { EVENT_HEADER } from "./support/fleet-event-header.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM = Pin.file(join(REPO, "skills", "run-team", "SKILL.md"));
const CI_AND_STALENESS = Pin.file(join(REPO, "skills", "run-team", "references", "ci-and-staleness.md"));

// SLICE SIZE is what does the anchoring. A regex over a whole section is
// satisfied by incidental prose elsewhere in it, and an unbounded slice runs to
// EOF where the red-flag list restates half of this vocabulary — enough to keep
// every assertion below green with the section deleted outright.
// The tick instruction only, ending where the tick's list of rows begins.
// Widened to the wake table it would be satisfied by the wake bullets' own
// mentions of the tick, which say nothing about the script.
const tickBlock = () =>
  RUN_TEAM.between("**In one line, every wake is one `fleet-event.mjs` call, which ends in the tick.**", "It prints `actual/target`", "run-team tick block").text;

// The six counts a caller used to state (#1803 deleted them, spec 2026-09-24
// § 6 §1). Any one of them back in the block is a controller told to supply a
// number the tick now refuses as an unknown flag — exit 2 on every wake.
const DELETED_FLAGS = ["--implementers", "--reviewers", "--merge-bots", "--pool", "--reviews-ready", "--merge-holds"];
// The three configuration flags `--in-flight` replaced. Any one of them back
// in the block is a controller told to pass a flag the tick refuses as unknown.
const RETIRED_FLAGS = ["--implementer-cap", "--reviewer-cap", "--max-reviews"];

test("the tick block names the script and only the flags it still takes", () => {
  const s = tickBlock();
  assert.match(s, /fleet-tick\.mjs/);
  // The one configuration flag that survived: the In-flight bound a caller
  // passes from `$ARGUMENTS` is the only thing it says.
  assert.ok(s.includes("--in-flight"), "tick block does not name --in-flight");
  assert.match(s, Pin.phrase("pass `--in-flight` on every tick when `$ARGUMENTS` set it, and never otherwise"));
  for (const flag of RETIRED_FLAGS) {
    assert.doesNotMatch(s, new RegExp(`${flag}(?![\\w-])`), `tick block still names ${flag}, which fleet-tick.mjs refuses since --in-flight replaced it`);
  }
  // A lookahead after the name, so `--reviewer-cap` never reads as `--reviewers`
  // and `--pool` never matches inside a longer word.
  for (const flag of DELETED_FLAGS) {
    assert.doesNotMatch(s, new RegExp(`${flag}(?![\\w-])`), `tick block still names ${flag}, which fleet-tick.mjs refuses since #1803`);
  }
});

// The frontmatter is what a user sees when invoking the skill: its hint is the
// invocation shape and its description must not state the retired sizing.
test("the run-team frontmatter hints the one in-flight argument and states no retired default", () => {
  const front = RUN_TEAM.text.split("\n---\n")[0];
  assert.match(front, /^argument-hint: "\[in-flight\]"$/m);
  assert.doesNotMatch(front, /default 2 and 6/);
});

test("the tick block says the tick reads the run itself, and nobody states a count", () => {
  // Inverted from the caller-stated era. A reader told the counts are theirs to
  // state hunts for flags that no longer exist; one told nothing hand-edits a
  // row to make the tick see what it wants. The ledger is the input, written
  // through ledger.mjs, and a token the tick cannot read is a refusal.
  const s = tickBlock();
  assert.match(s, Pin.phrase("nobody states a count"));
  assert.match(s, /`\.fleet\/ledger\.md`/);
  assert.match(s, /`\.fleet\/shortlist\.json`/);
  assert.match(s, Pin.phrase("refuses rather than guessing"));
  assert.doesNotMatch(s, /refuses rather than\s+defaulting them/, "the block still says the live counts are the controller's to state");
});

// The rule lives in two retained places: the tick block passes `--in-flight`
// only when `$ARGUMENTS` set it, and phase 2's tier check says omp's semaphore
// is not the bound and its line is a notice.
const tierRolesParagraph = () =>
  RUN_TEAM.between("`task.maxConcurrency` is not the bound", "\n\n", "run-team phase 2 maxConcurrency rule").text;

test("--in-flight is the run's bound, omp leaves it at its default, and the semaphore is a notice, never a hold", () => {
  const tick = tickBlock();
  assert.match(tick, Pin.phrase("pass `--in-flight` on every tick when `$ARGUMENTS` set it, and never otherwise"));
  assert.doesNotMatch(tick, /--in-flight \d/, "the rule now hard-codes a numeric bound — the point of leaving it at its default is that no caller passes one");
  assert.match(tierRolesParagraph(), Pin.phrase("prints a notice line and still"));
});

// The Defaults paragraph moved, with its measurements, to references/pull.md;
// SKILL.md keeps the default beside the pointer.
const PULL_MD = Pin.file(join(REPO, "skills", "run-team", "references", "pull.md"));
test("the Defaults paragraph states the bound's default with its rationale and the re-derive rule, and the retired sizing note is gone", () => {
  const kept = RUN_TEAM.paragraph("**Default: In-flight bound 5, fixed for the run.**", "run-team Defaults paragraph", "**The review backlog never gates").text;
  assert.match(kept, Pin.phrase("**Default: In-flight bound 5, fixed for the run.** See references/pull.md."));
  const def = PULL_MD.section("## Default: In-flight bound 5", "references/pull.md Defaults section").text;
  assert.match(def, Pin.phrase("fixed for the run"));
  assert.match(def, Pin.phrase("set by load, not throughput"));
  assert.match(def, Pin.phrase("once 20 or more PRs have merged under it, never from one run's rows"));
  assert.doesNotMatch(`${kept}\n${def}`, /1\.95/, "the Defaults paragraph still carries the retired reviewer sizing note");
});

test("§ Queue depth defines In flight and the In-flight bound, and documents the hold's rank, detail and refresh rule", () => {
  const inFlight = RUN_TEAM.bullet("- **In flight**", "- **In-flight bound**", "In flight definition").text;
  assert.match(inFlight, Pin.phrase("a ticket between its Claim and its PR's merge"));
  assert.match(inFlight, Pin.phrase("A PR closing nothing is never in flight"));
  const bound = RUN_TEAM.bullet("- **In-flight bound**", "**Default: In-flight bound 5", "In-flight bound definition").text;
  assert.match(bound, Pin.phrase("reviewers, finishers and the merge bot never slow for it"));
  const s = queueDepthTable();
  assert.match(s, Pin.phrase("`HOLD (in-flight <n>/<B>)` when n tickets are between Claim and merge and n ≥ B"));
  assert.match(s, Pin.phrase("`HOLD (in-flight <n>/<B>)` ranks last of the four"));
  assert.match(s, Pin.phrase("implementers=<i> prs=<p> unclaimed=<k> supply=<s>"));
  assert.match(s, Pin.phrase("The reviewer row reads `<units>/<B>`"));
  assert.match(s, Pin.phrase("never while the bound holds"));
  // A head whose Pull ended this run is no head a PULL row can name: counted,
  // it holds back the refresh that would fill its slot.
  assert.match(s, Pin.phrase("The table's shortlist counts no head whose Pull ended this run"));
  assert.match(s, Pin.phrase("Unclaimed there counts no head whose Pull ended this run"));
  // After a refresh at unclaimed < B the row prints the trigger's count, not the
  // refreshed file's, so the idle row can carry a count above 0.
  assert.match(s, Pin.phrase("A refresh at unclaimed < B leaves `unclaimed=` at that count, so `SUGGEST /triage` can print it above 0"));
  const shortlist = RUN_TEAM.bullet("- **shortlist**", "- **supply**", "shortlist definition").text;
  assert.match(shortlist, Pin.phrase("The tick's `unclaimed=`. Not after a refresh at unclaimed < B (below)."));
});

test("phase 0 runs tier-roles.mjs --check --in-flight <B> and says its notice never holds", () => {
  const step = RUN_TEAM.paragraph("The `tier-roles` step runs", "run-team phase 0 tier-roles step", "- `NEED derive-recipe`").text;
  assert.match(step, Pin.phrase("tier-roles.mjs --check --in-flight <B>"));
  assert.match(step, Pin.phrase("is a notice in the step's output and never holds"));
});

test("the failure-handling row and the settle-outcomes list name blocked", () => {
  const row = RUN_TEAM.between("| Implementer blocked or ambiguous *mid-implementation* |", "\n| `review-pr` workflow throws or returns no tree", "failure-handling blocked row").text;
  assert.match(row, Pin.phrase("`ledger.mjs settle impl-<N> blocked`"));
  assert.match(row, Pin.phrase("the ticket is not In flight"));
  assert.match(RUN_TEAM.between("Outcomes: `impl-N` = `PR#M | bailed |", "`fix-pr-M` = `applied:<head>", "settle-outcomes list").text, Pin.phrase("tier-mismatch | blocked"));
});

test("the wake table names every wake, each with its fleet-event.mjs command", () => {
  // The table IS the edge list: a wake missing from it is a wake that records
  // nothing and so is invisible to the tick, which reads only the ledger. What
  // each command records is in fleet-event.mjs's header, which
  // fleet-event-wake-table.test.mjs pins; here each wake is pinned to its command.
  const table = RUN_TEAM.paragraph("| Wake | Command |", "wake table", "### What a wake owes beyond its call").text;
  const rows = table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Wake"));
  const WAKES = [
    ["Implementer report", "`fleet-event.mjs impl-report impl-<N>`"],
    ["Review result file written (workflow notification / `review-pr-<n>` report)", "`fleet-event.mjs review-result <pr> <path>`"],
    ["Review launch failed", "`fleet-event.mjs review-failed <pr> <launch>`"],
    ["Fix-applier report", "`fleet-event.mjs fix-report fix-pr-<M>`"],
    ["Finisher report", "`fleet-event.mjs finisher-report finisher-pr-<M>`"],
    ["Merge-bot pass report", "`fleet-event.mjs merge-bot-report merge-bot-<n>`"],
    ["CI run terminal", "`fleet-event.mjs ci <pr>`"],
    ["Label seen (persistent Monitor)", "`fleet-event.mjs label <pr>`"],
    ["`CONFLICT` line", "`fleet-event.mjs conflict <pr>`"],
    ["Heartbeat", "`fleet-event.mjs heartbeat`"],
    ["Drain", "`fleet-event.mjs drain --reason \"<reason>\"`"],
    ["Undrain", "`fleet-event.mjs undrain --reason \"<reason>\"`"],
    ["Member confirmed dead or never dispatched", "`fleet-event.mjs member-died <member>`"],
  ];
  assert.equal(rows.length, WAKES.length, `the table has ${rows.length} wake rows, not the ${WAKES.length} the script's kinds make`);
  for (const [wake, command] of WAKES) {
    assert.ok(rows.includes(`| ${wake} | ${command} |`), `the wake table has no "${wake}" row naming ${command}`);
  }
  // A finisher halt is the finisher-report kind, so its bullet keeps only the
  // by-hand per-cause rule; a finisher that died is the member-died kind, and
  // its bullet keeps the cockpit flag it is resolved from by hand.
  assert.match(RUN_TEAM.bullet("- **Finisher reports halted**", "- **A finisher failed or was killed**", "finisher-halted wake").text, Pin.phrase("**Resolving a finisher halt**"));
  const died = RUN_TEAM.bullet("- **A finisher failed or was killed**", "- **Implementer bails before implementing**", "finisher-died wake").text;
  assert.match(died, Pin.phrase("(`member-died finisher-pr-<M>`)"));
  assert.match(died, Pin.phrase("**Resolving a finisher that died**"));
  // What follows the table: the call's lines acted on, the beat.
  assert.match(RUN_TEAM.between("| Drain |", "\n- **", "after the table").text, Pin.phrase("arm the beat"));
});

test("the tick on every wake admits no wake covers a drained queue, and says whose case that is", () => {
  // A reader who takes the wakes for the whole cure stops looking for the
  // drained-queue case they cannot reach. The pointer is the part that must not
  // rot — an admission with nowhere to go is how #3 lost item 2. The why moved
  // to references/ci-and-staleness.md; the wake table's rule points there.
  const why = CI_AND_STALENESS.section("## Tick on every wake", "references/ci-and-staleness.md").text;
  assert.match(why, /none\s+covers a fully drained queue/);
  assert.match(why, Pin.phrase("That state is the heartbeat's."));
  const rule = RUN_TEAM.paragraph("**Rule: record, tick, act, beat.**", "run-team record-tick rule", "Run each as").text;
  assert.match(rule, Pin.phrase("See references/ci-and-staleness.md."));
});

// Both merge-side wakes, each sliced to its own bullet — the shared vocabulary
// makes a section-wide match worthless here.
test("the merge-bot-pass-done wake is one fleet-event.mjs call; the reap and the reclaim it owes are in the script's header", () => {
  const bullet = RUN_TEAM.between("- **Merge-bot pass reports done**", "\n- **The run ends", "merge-bot-done wake").text;
  assert.match(bullet, /`fleet-event\.mjs merge-bot-report merge-bot-<n>`/);
  assert.doesNotMatch(bullet, /reap\.sh --apply|reclaim-scratch\.mjs/, "the bullet restates the reap and the reclaim the tick's --apply owns");
  assert.match(EVENT_HEADER, /The reap and the reclaim run under the tick's `--apply`\./);
  assert.match(EVENT_HEADER, Pin.phrase("always, even when the pass merged nothing"));
});

test("the tick block runs the tick with --apply", () => {
  assert.match(tickBlock(), /fleet-tick\.mjs --apply/);
});

test("phase 2's tier check says tick --apply runs the check", () => {
  const phase2 = RUN_TEAM.paragraph("**After every Pull's dispatch, the tier check runs", "run-team phase 2 tier check paragraph", "**The tick holds the next Pull until that verdict exists.**").text;
  assert.match(phase2, /`tick --apply` runs it itself/);
  assert.match(phase2, Pin.phrase("HOLD (tier unchecked impl-<N>)"));
});

test("the CI-terminal wake runs the tick", () => {
  const bullet = RUN_TEAM.between("- **Monitor: CI run completes**", "\n- **A fix-applier reports", "CI-terminal wake").text;
  assert.match(bullet, /run the tick/);
});

// The queue-depth table's own slice, ending at the `/triage` note that follows
// it. Anchored to the section heading instead, the pointer would be satisfied
// by the section's review-backlog bullets, which name `fleet-tick.mjs` before
// the table does.
const queueDepthTable = () =>
  RUN_TEAM.between("**Do not re-derive this by hand", "`/triage` is user-invoked only", "queue-depth table").text;

test("the queue-depth table points at the executable reconcile", () => {
  const s = queueDepthTable();
  assert.match(s, /fleet-tick\.mjs/);
  assert.match(s, /computed, not remembered/);
});

test("the queue-depth table keeps the implementer row's four holds above its rows", () => {
  // The one ordering the script encodes that the table cannot show: implementers()
  // returns a HOLD for a drain, a tier mismatch, an unchecked tier or the
  // In-flight bound before it ever reaches a PULL. A table read as authoritative
  // without them Pulls under a hold. All four, each by the ACTION string the tick
  // prints.
  const s = queueDepthTable();
  assert.match(s, /Four\s+holds\s+outrank\s+every\s+row/);
  for (const hold of ["`HOLD (draining)`", "`HOLD (tier mismatch impl-<N>)`", "`HOLD (tier unchecked impl-<N>)`", "`HOLD (in-flight <n>/<B>)`"]) {
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

test("the queue-depth table says a specs-dropped tail on the row is not \"no work\"", () => {
  // The tick names candidates.mjs's to-spec drops on the implementer row
  // whatever its ACTION; an empty shortlist carrying one read as no work is
  // the stall the tail exists to end.
  const s = queueDepthTable();
  assert.match(s, Pin.phrase("a `specs-dropped=#<N> (…)` at the end of its counts names the tickets the to-spec filter kept out of the shortlist"));
  assert.match(s, Pin.phrase("an empty shortlist carrying one is not \"no work\""));
});

test("the review-backlog definition states what the script actually counts", () => {
  // The gate's input. Left as the narrow definition alone, a controller reading
  // a HOLD cannot tell an over-count from a real review-bound pipeline.
  const def = RUN_TEAM.bullet("- **review backlog**", "- **In flight**", "review-backlog definition").text;
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

// The step-0 fold-in section only, in the phase-0 reference file. Widened to
// the whole of phase 0 it would be satisfied by the candidate-scan and
// in-flight bullets, which talk about queueing and review without saying
// inherited PRs are in scope at all.
const PHASE0 = Pin.file(join(REPO, "skills", "run-team", "references", "phase-0.md"));
const foldInBlock = () =>
  PHASE0.section("## Fold in every PR a prior run left open", "phase-0 fold-in block").text;

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
// invokes it. The slice is the standing instruction, ending where the tick's
// rows begin.
const heartbeatBlock = () =>
  RUN_TEAM.between("**Beat when there is nothing to do", "## The tick's rows", "run-team heartbeat block").text;

test("the event loop tells the controller to arm the beat instead of ending its turn", () => {
  // The entry point. Every word of the block below is unreachable if the loop
  // never says to run it, which is exactly how item 2 of #3 went missing.
  const bullet = RUN_TEAM.bullet("- **Nothing to do right now**", "**Beat when there is nothing to do",
    "nothing-to-do event").text;
  assert.match(bullet, /do not end your turn/);
});

test("the heartbeat block names the script and the re-issue protocol", () => {
  const s = heartbeatBlock();
  assert.match(s, /fleet-heartbeat\.mjs/);
  // The partial-hold branch IS the mechanism: nothing lets
  // one command block a whole interval, so a reader who stops at the first line
  // ends the turn mid-interval and the beat dies there. Prose that names the
  // script without the re-issue rule is a heartbeat with one beat.
  assert.match(s, /re-issue this command now, do not end your turn/);
  assert.match(s, /one blocking call per turn/);
});

test("the heartbeat block bounds the ceiling, and the reference says why", () => {
  // Without the reason, 20 minutes reads as arbitrary and the next reader
  // raises it to an hour — reintroducing #3's blindness at a slower rate, which
  // is the one failure this design can still be tuned into.
  assert.match(heartbeatBlock(), Pin.phrase("**Do not raise `--ceiling` past 30 minutes.** See references/ci-and-staleness.md."));
  const why = CI_AND_STALENESS.section("## The beat's ceiling is a real bound", "references/ci-and-staleness.md").text;
  assert.match(why, /supply grows from OUTSIDE the fleet/);
  assert.match(why, /Do not raise it past 30\s+minutes/);
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

test("the heartbeat block says whose stall a line is and names what is stranded", () => {
  // A stall whose stranded tickets go unmentioned is read as an obituary
  // rather than as work. Which marks the stall is judged off is the tick's
  // own (fleet-state.mjs's stallReport(), pinned by fleet-state.test.mjs);
  // what the controller does with each wording is pinned here.
  const s = heartbeatBlock();
  // One entry per wording fleet-state.mjs's stallReport() can lead with, each
  // saying what follows from it: a gone controller's claims come back, a live
  // one's do not, and no record decides nothing.
  assert.match(s, Pin.phrase("`heartbeat STALLED, controller gone` — the run that stranded them is dead. Its claims without a PR come back through the next run's phase 0 stranded-claim step (references/phase-0.md, \"Resume the claims a dead run left without a PR\"), and its open PRs through the fold-in."));
  assert.match(s, Pin.phrase("`heartbeat not beating, controller alive (pid N)` — a controller that stopped beating and kept going. Nothing died, so nothing is resumed"));
  assert.match(s, Pin.phrase("`heartbeat STALLED` alone — no record says whether that controller lives. The line is detection only."));
  // #2968: the previous run's recorded stop is its end, printed once.
  assert.match(s, Pin.phrase("Your first tick may print `previous run stopped deliberately at <time> (<age> ago) — recorded reason: <reason>` instead: the stop the previous run recorded. It is that run's end, not a verdict on yours, and no later tick prints it."));
  // Nothing restarts a dead run — the next run's phase 0 resumes it. Prose
  // that left this open invites a controller to invent a restart.
  assert.match(s, /nothing restarts the run that stranded them/);
});

test("the --stop paragraph keeps the drain out of it and points at End of run (#2968)", () => {
  // A stop recorded at the drain is read as the end of the run while the
  // review and merge sides are still working it.
  const p = RUN_TEAM.paragraph("It holds nothing and returns at once.", "run-team --stop paragraph", "**A stall line names whose stall it is.**").text;
  assert.doesNotMatch(p, /drain the run deliberately/);
  assert.match(p, Pin.phrase("A drained run records it as the last step of **End of run** (above), never at the drain itself."));
});

test("End of run follows the drain bullet and ends with --stop (#2968)", () => {
  const b = RUN_TEAM.bullet("- **The run ends, or the maintainer says drain**", "- **The finisher-gate wakes**", "run-team drain bullet").text;
  const steps = [...b.matchAll(/^\s+(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(steps, [1, 2, 3], "End of run is one ordered list: begin, the loop, finish");
  assert.match(b, Pin.phrase("1. `~/.fleet/bin/fleet-run fleet-event.mjs drain --reason \"<reason>\"` — runs `closeout.mjs begin --reason \"<reason>\"`"));
  assert.match(EVENT_HEADER, Pin.phrase("`closeout.mjs begin` drains (`ledger.mjs drain`), then releases every claim that never became a PR and settles each `impl-<N>=released`"));
  assert.match(b, Pin.phrase("2. Act on the review, fix-applier and merge rows until the tick prints `ACTION: run over → fleet-heartbeat.mjs --stop \"<reason>\"`, which it does once the run is draining with no open PR and no live implementer."));
  assert.match(b, Pin.phrase("3. `~/.fleet/bin/fleet-run closeout.mjs finish --reason \"<reason>\"`"));
  assert.match(b, Pin.phrase("then records `fleet-heartbeat.mjs --stop` last, because every reader takes a recorded stop as the end of the run."));
});

// The ask-by-name paragraph, where a missing report is handled; it moved to
// references/member-lifecycle.md, and SKILL.md keeps its rule beside a pointer.
// The tick's SETTLE line is the report file read off disk, so the paragraph
// sends the controller to that line before it pings anyone; without the
// sentence a report that is on disk still costs an ask-by-name round trip. A
// file that fails its schema is REPORT-INVALID, not SETTLE, because `settle
// --from-report` refuses it, so the paragraph names both.
const MEMBER_LIFECYCLE = Pin.file(join(REPO, "skills", "run-team", "references", "member-lifecycle.md"));
const askByNameParagraph = () => MEMBER_LIFECYCLE.paragraph(
  "**But a missing report is NOT evidence the member failed to send one",
  "member-lifecycle.md ask-by-name paragraph",
  "Note this cuts against the paragraph above only in appearance",
).text;

test("the ask-by-name paragraph reads a missing message off the tick's SETTLE and REPORT-INVALID lines before anyone is pinged", () => {
  assert.match(askByNameParagraph(),
    Pin.phrase("The tick prints `SETTLE <member>` for a report file on disk that passes its schema and `REPORT-INVALID` for one that fails it, so a missing message is read off those lines before anyone is pinged."),
    "the ask-by-name paragraph no longer sends the controller to the tick's SETTLE and REPORT-INVALID lines before a ping");
});

// The transcript-listing tick rows, each with its remedy, read inside its own
// list item so a sibling row's words cannot satisfy it. The rows' full text is
// in references/tick-rows.md; SKILL.md keeps one line for each.
const TICK_ROWS = Pin.file(join(REPO, "skills", "run-team", "references", "tick-rows.md"));

test("the REFRESHED and SUGGEST /triage tick rows leave an ended head out of the count, and the row keeps the trigger's count", () => {
  const refreshed = TICK_ROWS.bullet("- `REFRESHED shortlist: <n> entries; <k> lifted`", "- `SUGGEST /triage, hold idle`", "tick-rows REFRESHED row").text;
  assert.match(refreshed, Pin.phrase("a head whose Pull ended this run not counted, the implementer row's `unclaimed=` prints that same `<u>`, not the refreshed file's count"));
  const suggest = TICK_ROWS.bullet("- `SUGGEST /triage, hold idle`", "- `specs-dropped=#<N>", "tick-rows SUGGEST row").text;
  assert.match(suggest, Pin.phrase("A head whose Pull already ended in this run is not counted toward the refresh, so a shortlist of only such heads triggers the refresh before this row prints"));
});

test("the UNRECORDED tick row names its remedy: record the dispatch on the ledger, or confirm it is a stranger's member", () => {
  const row = TICK_ROWS.bullet("- `UNRECORDED <stem> (transcript exists, no ledger token)`", "- `NO-TRANSCRIPT <member>", "tick-rows UNRECORDED row").text;
  assert.match(row, Pin.phrase("Record it with `ledger.mjs dispatch`, or confirm it is a stranger's member."));
  assert.match(row, Pin.phrase("it resets no `quiet`, changes no row and frees no slot"));
  assert.match(row, Pin.phrase("(`…; UNRECORDED <stem> persists — …`)"));
});

test("the NO-TRANSCRIPT tick row names its remedy: make the task call, or run the member-died wake; and where the session directory comes from", () => {
  const row = TICK_ROWS.bullet("- `NO-TRANSCRIPT <member> (live <age>m, no <session>/<member>.jsonl)`", "- `SETTLE <member>", "tick-rows NO-TRANSCRIPT row").text;
  assert.match(row, Pin.phrase("Make the `task` call, or run the **Member confirmed dead or never dispatched** wake (`fleet-event.mjs member-died <member>`)"));
  assert.match(row, Pin.phrase("`--no-transcript-after` minutes ago (default 5)"));
  assert.match(row, Pin.phrase("`…; NO-TRANSCRIPT <member> persists — …`"));
  assert.match(row, Pin.phrase("Both lines read the session directory this run's phase-0 receipt names, else `--session <dir>`; with neither the tick skips them with one stderr line."));
});

test("the NO-TRANSCRIPT tick row says a heartbeat file that cannot be used silences both age checks, and names the one stderr line the tick prints for it", () => {
  const row = TICK_ROWS.bullet("- `NO-TRANSCRIPT <member> (live <age>m, no <session>/<member>.jsonl)`", "- `SETTLE <member>", "tick-rows NO-TRANSCRIPT row").text;
  assert.match(row, Pin.phrase("neither `CHECK-LIVENESS` nor `NO-TRANSCRIPT` can fire."));
  assert.match(row, Pin.phrase("The tick says so with one stderr line, `fleet-tick: CHECK-LIVENESS and NO-TRANSCRIPT not checked — <file> <cause>, so first-seen ages are unavailable`, naming only the checks that would have run that tick."));
});

test("the ESCALATE pr-closed tick row is the maintainer's: no dispatch, no comment, and only replace or release once no member on the PR is live", () => {
  const row = TICK_ROWS.bullet("- `ESCALATE pr-closed #<N> PR#<M>`", "- `ESCALATE pr-unchecked #<N> PR#<M>`", "tick-rows pr-closed row").text;
  assert.match(row, Pin.phrase("tell the maintainer once per ticket per run, dispatch nothing for #N, and post no GitHub comment."));
  assert.match(row, Pin.phrase("Reopening PR M, or closing #N, clears it by itself on the next tick."));
  assert.match(row, Pin.phrase("Act only on the maintainer's `replace #N` or `release #N`, and only once the line names no live member"));
  assert.match(row, Pin.phrase("Its new PR settles onto the same row, and that two-PR row is a legitimate shape"));
  assert.match(row, Pin.phrase("`ledger.mjs settle impl-<N>-<x> released`, which ends the line."));
  const list = RUN_TEAM.bullet("- `ESCALATE pr-closed #<N> PR#<M>`, `… pr-unchecked …`", "- `HOLD (…)`", "SKILL.md pr-closed line").text;
  assert.match(list, Pin.phrase("tell them once per ticket per run; no dispatch or comment for #N."));
  assert.match(list, Pin.phrase("Reopening M or closing #N clears it."));
  assert.match(list, Pin.phrase("Only `replace #N` (`NEED resume`, same row) or `release #N` (closed-PR `release-ticket.sh --apply`, settle `released`) acts, once no live member names M."));
});

test("ADR 0028's Status line records that the tick now reads the session directory's listing, and still no transcript's contents", () => {
  const adr = Pin.file(join(import.meta.dirname, "..", "docs", "adr", "0028-a-live-token-past-its-p99-points-the-controller-at-the-registry-census.md"));
  const status = adr.paragraph("**Status:**", "ADR 0028 Status line", "## Context").text;
  assert.match(status, Pin.phrase("Amended by #3201: the tick reads the session directory's listing to reconcile ledger tokens; it still reads no transcript's contents and no registry."));
});
