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
import { readdirSync, readFileSync } from "node:fs";
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
// only when `$ARGUMENTS` set it, and the phase-0 `tier-roles` step says omp's
// `task.maxConcurrency` line is a notice in the step's output and never a hold.
const tierRolesParagraph = () =>
  RUN_TEAM.between("The `tier-roles` step runs", "\n\n", "run-team phase 0 tier-roles step").text;

test("--in-flight is the run's bound, omp leaves it at its default, and the semaphore is a notice, never a hold", () => {
  const tick = tickBlock();
  assert.match(tick, Pin.phrase("pass `--in-flight` on every tick when `$ARGUMENTS` set it, and never otherwise"));
  assert.doesNotMatch(tick, /--in-flight \d/, "the rule now hard-codes a numeric bound — the point of leaving it at its default is that no caller passes one");
  assert.match(tierRolesParagraph(), Pin.phrase("is a notice in the step's output and never holds"));
});

// The Defaults paragraph moved, with its measurements, to references/pull.md;
// SKILL.md keeps the default beside the pointer, in phase 0's tier-roles step.
const PULL_MD = Pin.file(join(REPO, "skills", "run-team", "references", "pull.md"));
test("the Defaults paragraph states the bound's default with its rationale and the re-derive rule, and the retired sizing note is gone", () => {
  const kept = RUN_TEAM.paragraph("**Default: In-flight bound 5, fixed for the run.**", "run-team Defaults paragraph", "- `NEED derive-recipe`").text;
  assert.match(kept, Pin.phrase("**Default: In-flight bound 5, fixed for the run.** See references/pull.md."));
  const def = PULL_MD.section("## Default: In-flight bound 5", "references/pull.md Defaults section").text;
  assert.match(def, Pin.phrase("fixed for the run"));
  assert.match(def, Pin.phrase("set by load, not throughput"));
  assert.match(def, Pin.phrase("once 20 or more PRs have merged under it, never from one run's rows"));
  assert.doesNotMatch(`${kept}\n${def}`, /1\.95/, "the Defaults paragraph still carries the retired reviewer sizing note");
});

test("phase 0 runs tier-roles.mjs --check --in-flight <B> and says its notice never holds", () => {
  const step = RUN_TEAM.paragraph("The `tier-roles` step runs", "run-team phase 0 tier-roles step", "- `NEED derive-recipe`").text;
  assert.match(step, Pin.phrase("tier-roles.mjs --check --in-flight <B>"));
  assert.match(step, Pin.phrase("is a notice in the step's output and never holds"));
});

test("the failure-handling row names blocked", () => {
  const row = RUN_TEAM.between("| Implementer blocked or ambiguous *mid-implementation* |", "\n| `review-pr` workflow throws or returns no tree", "failure-handling blocked row").text;
  assert.match(row, Pin.phrase("`ledger.mjs settle impl-<N> blocked`"));
  assert.match(row, Pin.phrase("the ticket is not In flight"));
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
    ["Alarm (a [fleet-alarm] turn)", "`fleet-event.mjs heartbeat`"],
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
  assert.match(RUN_TEAM.between("| Drain |", "\n- **", "after the table").text, Pin.phrase("mark the beat"));
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

test("the tier check bullet says tick --apply runs the check", () => {
  const bullet = RUN_TEAM.bullet("- **The tier check.**", "- **The exploration rule.**", "run-team tier-check bullet").text;
  assert.match(bullet, /`tick --apply`/);
});

test("the CI-terminal wake runs the tick", () => {
  const bullet = RUN_TEAM.between("- **Monitor: CI run completes**", "\n- **A fix-applier reports", "CI-terminal wake").text;
  assert.match(bullet, /run the tick/);
});

// The rationale for reading the depth off the tick moved to references/tick-rows.md;
// SKILL.md's tick's rows keep the rule beside the pointer.

test("reading the depth off the tick points at the executable reconcile", () => {
  const s = TICK_ROWS.section("## Read the depth off the tick, never derive it by hand", "references/tick-rows.md depth section").text;
  assert.match(s, /fleet-tick\.mjs/);
  assert.match(s, /computed, not remembered/);
  assert.match(RUN_TEAM.text, Pin.phrase("Read the depth off the tick and never derive it by hand: act on the row it prints"));
});

test("the specs-dropped row says a specs-dropped tail is not \"no work\"", () => {
  // The tick names candidates.mjs's to-spec drops on the implementer row
  // whatever its ACTION; an empty shortlist carrying one read as no work is
  // the stall the tail exists to end.
  const row = RUN_TEAM.text.split("\n").find((l) => l.startsWith("- `specs-dropped=#<N> …` — "));
  assert.ok(row, "the tick's rows no longer carry the specs-dropped row");
  assert.match(row, Pin.phrase("log those tickets as specs awaiting to-tickets, not as no work"));
});

test("the SUGGEST /triage row says suggest, never run, and asks nobody to tick", () => {
  // `/triage` is user-invoked: the controller reports the suggestion and never
  // blocks on it. Supply is automatic (ADR 0013), so the row never asks the
  // maintainer to tick the multi-select phase 0 no longer has.
  const row = RUN_TEAM.text.split("\n").find((l) => l.startsWith("- `SUGGEST /triage, hold idle` — "));
  assert.ok(row, "the tick's rows no longer carry the SUGGEST /triage row");
  assert.match(row, Pin.phrase("suggest `/triage` in the report, never run it. The suggestion is a report, not a blocking prompt."));
  assert.doesNotMatch(row, /ask the maintainer to tick/i, "the SUGGEST /triage row asks the maintainer to tick — phase 0's multi-select is retired (ADR 0013)");
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
  RUN_TEAM.between("**Mark the beat when there is nothing to do", "## The tick's rows", "run-team heartbeat block").text;

test("the event loop tells the controller to mark the beat and end its turn", () => {
  // The entry point. Every word of the block below is unreachable if the loop
  // never says to run it, which is exactly how item 2 of #3 went missing.
  const bullet = RUN_TEAM.bullet("- **Nothing to do right now**", "**Mark the beat when there is nothing to do",
    "nothing-to-do event").text;
  assert.match(bullet, /mark the beat, then end your turn/);
});

test("the heartbeat block names the script and the one-line protocol", () => {
  const s = heartbeatBlock();
  assert.match(s, /fleet-heartbeat\.mjs/);
  // The recorded line and the unrecorded one are the whole protocol: a reader
  // who learns only the first ends its turn over a mark that never landed, and
  // the alarm's gate never passes on a run with no recorded beat.
  assert.match(s, Pin.phrase("`… beat marked, alarm due in <N>s (quiet=<n>) → end your turn`"));
  assert.match(s, Pin.phrase("`… beat NOT marked …` — this beat arms no alarm you can count on, so ending your turn could be the stall."));
});

test("the heartbeat block says an alarm turn arrives and what it runs", () => {
  assert.match(heartbeatBlock(), Pin.phrase("The alarm's turn arrives as a user message that starts `[fleet-alarm]` and names `fleet-event.mjs heartbeat`"));
});

test("the heartbeat block no longer tells the controller to hold its turn", () => {
  const s = heartbeatBlock();
  assert.doesNotMatch(s, /--hold/);
  assert.doesNotMatch(s, /re-issue/);
  assert.doesNotMatch(s, /blocking call/);
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
  assert.match(refreshed, Pin.phrase("a head whose Pull ended this run not counted (unless it ended on an exclusion whose premise has lifted), the implementer row's `unclaimed=` prints that same `<u>`, not the refreshed file's count"));
  const suggest = TICK_ROWS.bullet("- `SUGGEST /triage, hold idle`", "- `specs-dropped=#<N>", "tick-rows SUGGEST row").text;
  assert.match(suggest, Pin.phrase("A head whose Pull already ended in this run is not counted toward the refresh, so a shortlist of only such heads triggers the refresh before this row prints"));
  assert.match(suggest, Pin.phrase("It is not printed while the refreshed shortlist holds a head whose Pull ended only on an exclusion whose premise has lifted and a slot is free: that head gets its `PULL` row"));
});

test("How a Pull ends: an ended head gets no row, and a Pull that ended on an exclusion is the exception once its premise has lifted", () => {
  const s = RUN_TEAM.paragraph("A head whose Pull already ended in this run", "run-team How a Pull ends paragraph", "**A Pull never re-admits").text;
  assert.match(s, Pin.phrase("gets no row: `next` without `--head` skips it, `next --head <N>` would start the ticket over, and the next head fills the slot"));
  assert.match(s, Pin.phrase("A lifted exclusion's head (reason `excluded ·`) is the exception: it is counted and Pulled again"));
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

test("nothing under run-team/ says never to end the turn", () => {
  // Positive control first: the scan reads the files it claims to, so a
  // zero below is not an empty directory. The phrase it must not find is the
  // one the hold needed; it is checked case-insensitively and with the
  // whitespace of a wrapped line folded.
  const dir = join(REPO, "skills", "run-team");
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(e.parentPath, e.name));
  assert.ok(files.some((f) => f.endsWith("SKILL.md")), "the scan did not reach SKILL.md");
  const flat = (f) => readFileSync(f, "utf8").replace(/\s+/g, " ").toLowerCase();
  assert.ok(files.some((f) => flat(f).includes("end your turn")), "the scan found no `end your turn` at all");
  const hits = files.filter((f) => flat(f).includes("never end your turn"));
  assert.deepEqual(hits, [], "a run-team file still says never to end the turn");
});
