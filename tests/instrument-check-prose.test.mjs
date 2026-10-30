// #436. `instruments.sh` is executed by an AGENT reading run-team/SKILL.md, so
// the script being correct buys nothing on its own — the whole mechanism is
// three clauses of prose, and every one of them can rot without an error:
//
//   - the RULE (both refusing exit codes, no re-read after a refusal, and the
//     one condition under which re-pinning is legitimate),
//   - the PIN at phase 0 step 0, which must sit after the fast-forward,
//   - the REPORT in a tooling defect found mid-run: the controller edits
//     nothing and never re-pins. Lose that clause and the controller's own fix
//     makes every later gate refuse, which is how a guard gets discarded rather
//     than fixed.
//
// The refusal half is the one worth pinning hardest. "Exit 0 is the only code
// that lets a gate proceed" is the acceptance criterion; a later edit that
// softened exit 2 to "re-run and continue" would read as perfectly reasonable
// prose and would turn a fail-closed guard into a fail-open one, silently.
//
// THE CEILING, shared with every prose pin in this repo: these prove a clause is
// PRESENT in the smallest slice that can hold it. None can prove a sentence
// added beside it does not negate it, and none runs anything —
// instruments.test.mjs owns the script's behaviour. Read each assertion as "not
// vacuous to REWORDING", never as "this rule cannot be subverted".
//
// Zero deps: `node --test tests/instrument-check-prose.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM = Pin.file(join(REPO, "skills", "run-team", "SKILL.md"));
// The phase-0 step paragraphs live in the reference file, one heading per moved step paragraph.
const PHASE0 = Pin.file(join(REPO, "skills", "run-team", "references", "phase-0.md"));

// Bounded at both ends, and the slices are small on purpose: the file names
// `instruments.sh` in three separate places, so a slice running to EOF is
// satisfied by whichever of the other two survived. The rule is its own
// subsection of the judgement rules, so the subsection is the bound.
const RULE = () =>
  RUN_TEAM.section("### Re-check the instruments before a gate", "run-team instrument rule").text;
// What the set covers, and the re-pin's consequence, moved to the
// instruments reference beside the rule's rationale.
const INSTRUMENTS_MD = Pin.file(join(REPO, "skills", "run-team", "references", "instruments.md"));

// The END bound is THIS paragraph's own blank line, via `paragraph()`. It was a
// literal `between()` end anchor on the heading of the NEXT, unrelated phase-0
// step, which made an unrelated rename of that neighbour red this pin with a
// bare "no longer contains" that reads as an instrument-check regression and is
// not one — reproduced at `fa65476` as a negative control the suite should NOT
// have caught, and fixed here (#1062 records the exact wording; naming it again
// here would only be a second copy free to drift). A blank line is the bound
// that belongs to the pinned content and the one a rewrap cannot move, and
// `anchorAt` additionally refuses a start anchor occurring more than once — so
// this slice is tighter than what it replaces, still bounded at BOTH ends (an
// unbounded end would let an unrelated later copy satisfy the assertions, the
// worse failure), and no prose was added to give it something to anchor on.
// `paragraph()` is this directory's single definition of that bound (#823,
// #1372): a hand-rolled end anchor on neighbouring text is the defect it
// removes, not a style choice.
const PIN_STEP = () => PHASE0.paragraph("**Pin the instruments,", "phase-0 pin", "## Record the main-checkout baseline").text;

// The gate list is one bullet, and this slice is bounded to it. Read out of the
// whole RULE slice, `phrase("reap")` is satisfied by the unrelated `reap.sh`
// mention further down it, so the loop below stayed green with the gate name
// gone. Word boundaries would not have fixed it: `\breap\b` matches inside
// `reap.sh` too. Bounding the text the loop reads is what cannot regress.
const GATES = () =>
  RUN_TEAM.between(
    "**Re-check before you act on any instrument reading**",
    "**Exit 0 is the only code",
    "run-team gate list",
  ).text;

const TOOLING_FIX = () =>
  RUN_TEAM.section("### A tooling defect found mid-run", "run-team tooling defect").text;

test("the rule states that BOTH non-zero codes refuse, not just the changed one", () => {
  const rule = RULE();
  // Exit 0 as the sole proceeding code, and exit 2 named as a refusal beside
  // exit 1. Pinning only "exit 1 refuses" would stay green on the fail-open
  // rewrite this exists to prevent, since exit 2 is the code that reads like a
  // retry.
  assert.match(rule, Pin.phrase("Exit 0 is the only code that lets a gate proceed"));
  assert.match(rule, Pin.phrase("Exit 1 (the set changed) and exit 2 (the check could not answer) both refuse"));
});

test("the rule forbids re-reading the instrument after a refusal", () => {
  // "Refuse and report, not silently re-read" is #436's stated behaviour on
  // detection. Without this clause the rule reads as a warning rather than a
  // gate, and re-running until it passes is the obvious wrong reflex.
  assert.match(RULE(), Pin.phrase("report what it printed and do NOT re-read the instrument"));
});

test("the rule names the gates it runs before, not just 'a gate'", () => {
  // The check is worthless if the controller cannot tell where it applies. Each
  // of these is a decision the fleet takes off an instrument reading.
  const gates = GATES();
  for (const gate of ["SHA acceptance", "CI verdict", "reconcile", "reap", "label gate"]) {
    assert.match(gates, Pin.phrase(gate), `the rule stopped naming the ${gate}`);
  }
});

test("the rule limits re-pinning to the maintainer's adopt", () => {
  // The baseline IS the mechanism, and `--pin` overwrites it with whatever is in
  // the tree, never comparing first. Nothing in the script can tell a re-pin
  // after a deliberate fix from one used to clear a refusal under time pressure,
  // so this clause is the only thing between the two — and losing it discards
  // the guard while every other pin here stays green.
  const rule = RULE();
  assert.match(rule, Pin.phrase("Re-pin only on the maintainer's adopt"));
  assert.match(rule, Pin.phrase("Re-pinning to clear a refusal you cannot explain discards the check"));
});

test("the rule escalates a pinned tree whose HEAD moved and gives the maintainer restore or adopt", () => {
  // A refusal cannot tell a move the maintainer would adopt from one they
  // would not, so the controller's own reading of "only this run's merged PRs"
  // is exactly what must not decide. Lose the first clause and a fast-forward
  // is re-pinned over again; lose the second and the reset runs on a switched
  // branch, where it moves a branch that is not `main`.
  const rule = RULE();
  assert.match(rule, Pin.phrase("A pinned tree whose HEAD moved is the maintainer's to settle, whoever moved it"));
  assert.match(rule, Pin.phrase("never re-pin over it: not for a fast-forward to `origin/main`, and not when the commits between are only this run's own merged PRs"));
  assert.match(rule, Pin.phrase("On their **restore**, run `git reset --keep <pin commit>` — only when the pinned tree is the main checkout and the tick prints no `MAIN-CHECKOUT` line"));
  assert.match(rule, Pin.phrase("On their **adopt**, re-pin"));
});

test("the rule records that refs are out of the digest, and why", () => {
  // Not decoration: the ticket's corroborating evidence is a stray branch, so
  // the next reader will ask. Without the reason, "add refs to the digest" is
  // an obvious-looking improvement that fires on ordinary work several times a
  // fleet run — which is the noise #436's third acceptance criterion rules out.
  const rule = INSTRUMENTS_MD.section("## What the instrument set covers", "references/instruments.md coverage").text;
  assert.match(rule, Pin.phrase("It does not cover refs, deliberately"));
  assert.match(rule, Pin.phrase("a per-gate refusal on that is noise"));
});

test("phase 0 step 0 pins the set, and only after the fast-forward", () => {
  const step = PIN_STEP();
  assert.match(step, Pin.phrase("instruments.sh --pin"));
  // The ordering is the load-bearing half. Phase 0 step 0 fast-forwards the
  // checkout because the runbook is read out of it; pinning first certifies the
  // superseded text for the whole run, and every later gate then passes.
  assert.match(step, Pin.phrase("after that fast-forward and before anything reads them"));
  // Both anchors present, in this order. The hand-rolled `indexOf(ff) <
  // indexOf(pin)` this replaces was vacuous to the rewording it exists to catch:
  // reword the fast-forward away and `indexOf` returns -1, which is less than
  // anything. `between` throws by name on either anchor missing and on the
  // reversed order, which is every case the comparison was meant to cover.
  PHASE0.between("git merge --ff-only origin/main", "**Pin the instruments,", "phase-0 ordering").text;
});

/**
 * The counterfactual rule, as a function so the refuse and accept cases can be
 * fed input this repo does not contain. Returns null when the step is sound,
 * else the reason.
 */
export function wrongOrderFault(step) {
  // #1061. This sentence states what happens in the order the instruction
  // above it forbids, so its MOOD is the whole content. Unmarked ("Pinning
  // ahead of the fast-forward pins the superseded text and certifies it for
  // the rest of the run.") it parses as a declarative describing what the
  // instruction achieves, and the reader — usually an agent — is then told by
  // the runbook to do the one thing the instruction exists to prevent.
  //
  // Scoped to the SENTENCE, never the step slice: over the paragraph the
  // marker below is satisfied by a modal a later edit adds to any other
  // clause in it. Anchored on the COST and not on the opening word, because
  // the marker can be a modal ("Pinning before … WOULD instead pin") or a
  // conditional ("IF you pin before …") and only the second keeps "Pinning"
  // as the subject — a start anchor on that word makes every conditional
  // rewording an anchor red.
  //
  // The sentence is `sentences()`'s, never a first-period `[^.]*` window
  // (#1940). That window ran straight past a `?` or `!` — and so did a
  // splitter that missed a bold sentence's `.**` — so a neighbour ending in
  // one lent the declarative its `if` or `would` and the mutant below passed.
  // It also began after any period inside the sentence (`instruments.sh`,
  // "e.g."), which stripped the marker from a valid conditional rewording.
  // Newlines are whitespace to the splitter, so a rewrap moves neither end;
  // the count is `anchorAt`'s exactly-once guarantee, held inline because this
  // bound is a sentence rather than an anchor.
  const hits = Pin.sentences(step).filter((s) => /superseded\s+text/.test(s));
  if (hits.length !== 1) {
    return `the sentence naming what pinning in the wrong order costs occurs ${hits.length} times — re-anchor this test, never widen it to the paragraph`;
  }
  const [wrongOrder] = hits;
  // The marker, and the mutant this check exists to kill: restore the
  // declarative above, which keeps every token pinned anywhere in this file
  // and flips only the mood — RED here and nowhere else. Deleting the
  // sentence reds on the count above instead, which measures vocabulary
  // removal and proves less.
  if (!/\bwould\b|\bif\b/i.test(wrongOrder)) {
    return "the wrong-order sentence lost its counterfactual marker — it now reads as a statement of what pinning DOES, which is the failure it is describing";
  }
  // And it still says whose order is wrong. A marked sentence that no longer
  // names the fast-forward it is contrasting with pins mood over nothing.
  if (!Pin.phrase("fast-forward").test(wrongOrder)) {
    return "the wrong-order sentence stopped naming the fast-forward it is the counterfactual of";
  }
  return null;
}

test("phase 0 step 0 states the WRONG pin order as a counterfactual, not as a fact", () => {
  assert.equal(wrongOrderFault(PIN_STEP()), null);
});

// #1940. The other half, fed shapes the step does not hold today. The
// first-period window accepted the declarative whenever the sentence beside it
// ended in `?` or `!` and carried a marker of its own — the one mutant this
// rule exists to kill — and refused a conditional with a filename or an
// abbreviation ahead of its `if`.
test("a neighbouring sentence cannot lend the declarative its marker, and a period inside the sentence cannot strip it (#1940)", () => {
  const declarative = "Pinning ahead of the fast-forward pins the superseded text and certifies it for the rest of the run.";
  for (const neighbour of [
    `What if one refuses? ${declarative}`,
    `It would be too late afterwards! ${declarative}`,
    `**If in doubt, pin after the fast-forward.** ${declarative}`,
    "Pinning ahead of the fast-forward pins the superseded text! If in doubt, re-pin.",
  ]) {
    assert.match(wrongOrderFault(neighbour), /counterfactual marker/, neighbour);
  }

  assert.equal(wrongOrderFault("If you run instruments.sh --pin before that fast-forward, it pins the superseded text."), null);
  assert.equal(wrongOrderFault("Pinning before that fast-forward (e.g. from a stale tree) would instead pin the superseded text."), null);
});

test("a tooling defect is reported, never fixed by the controller", () => {
  const fix = TOOLING_FIX();
  assert.match(fix, Pin.phrase("never fix it yourself"));
  assert.match(fix, Pin.phrase("the defect stays live for the rest of this run.** See references/instruments.md."));
  // The consequence, spelled out, is what stops the edit being made as a
  // helpful shortcut: an edit under the pinned tree makes the controller's own
  // fix look like tampering. It sits in the reference the pointer names.
  const why = INSTRUMENTS_MD.section("## Reporting a tooling defect", "references/instruments.md reporting").text;
  assert.match(why, Pin.phrase("every later gate refuses"));
});

test("the path the prose tells the controller to run is a real executable", () => {
  // The cheapest guard against the whole mechanism being prose about nothing:
  // a renamed or deleted script leaves all the assertions above green.
  //
  // Absence is all this can decide, and the collection it replaces could not
  // decide more: the capture group was a fixed literal, so the Set it filled
  // held one element or none and `size === 1` was "the name appears somewhere"
  // wearing a cross-site consistency check's clothes.
  const SH = "scripts/instruments.sh";
  assert.match(RUN_TEAM.text, Pin.phrase("~/.fleet/bin/fleet-run instruments.sh"), "the prose stopped naming the instrument check through the Resolver");
  accessSync(join(REPO, SH), constants.X_OK);
});
