// #436. `instruments.sh` is executed by an AGENT reading run-team/SKILL.md, so
// the script being correct buys nothing on its own — the whole mechanism is
// three clauses of prose, and every one of them can rot without an error:
//
//   - the RULE (both refusing exit codes, no re-read after a refusal, and the
//     one condition under which re-pinning is legitimate),
//   - the PIN at phase 0 step 0, which must sit after the fast-forward,
//   - the RE-PIN in the mid-run tooling fix, the one legitimate writer to the
//     set. Lose that clause and the first tooling fix of a run makes every
//     later gate refuse, which is how a guard gets discarded rather than fixed.
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
// Zero deps: `node --test skills/fleet/scripts/instrument-check-prose.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

// Bounded at both ends, and the slices are small on purpose: the file names
// `instruments.sh` in three separate places, so a slice running to EOF is
// satisfied by whichever of the other two survived.
const RULE = () =>
  between(
    RUN_TEAM,
    "**You read your instruments out of a tree every member can write to",
    "\n## Phase 0 — shortlist",
    "run-team instrument rule",
  );

const PIN_STEP = () =>
  between(RUN_TEAM, "**Pin the instruments,", "**Launch the cockpit.**", "run-team phase 0 pin");

// The gate list is one bullet, and this slice is bounded to it. Read out of the
// whole RULE slice, `phrase("reap")` is satisfied by the unrelated `reap.sh`
// mention further down it, so the loop below stayed green with the gate name
// gone. Word boundaries would not have fixed it: `\breap\b` matches inside
// `reap.sh` too. Bounding the text the loop reads is what cannot regress.
const GATES = () =>
  between(
    RUN_TEAM,
    "**Re-check before you act on any instrument reading**",
    "**Exit 0 is the only code",
    "run-team gate list",
  );

const TOOLING_FIX = () =>
  between(RUN_TEAM, "## Fix the tooling mid-run", "\n## Failure handling", "run-team tooling fix");

test("the rule states that BOTH non-zero codes refuse, not just the changed one", () => {
  const rule = RULE();
  // Exit 0 as the sole proceeding code, and exit 2 named as a refusal beside
  // exit 1. Pinning only "exit 1 refuses" would stay green on the fail-open
  // rewrite this exists to prevent, since exit 2 is the code that reads like a
  // retry.
  assert.match(rule, phrase("Exit 0 is the only code that lets a gate proceed"));
  assert.match(rule, phrase("Exit 1 (the set changed) and exit 2 (the check could not answer) both refuse"));
});

test("the rule forbids re-reading the instrument after a refusal", () => {
  // "Refuse and report, not silently re-read" is #436's stated behaviour on
  // detection. Without this clause the rule reads as a warning rather than a
  // gate, and re-running until it passes is the obvious wrong reflex.
  assert.match(RULE(), phrase("report what it printed and do NOT re-read the instrument"));
});

test("the rule names the gates it runs before, not just 'a gate'", () => {
  // The check is worthless if the controller cannot tell where it applies. Each
  // of these is a decision the fleet takes off an instrument reading.
  const gates = GATES();
  for (const gate of ["SHA acceptance", "CI verdict", "reconcile", "reap", "label gate"]) {
    assert.match(gates, phrase(gate), `the rule stopped naming the ${gate}`);
  }
});

test("the rule limits re-pinning to a change the controller made deliberately", () => {
  // The baseline IS the mechanism, and `--pin` overwrites it with whatever is in
  // the tree, never comparing first. Nothing in the script can tell a re-pin
  // after a deliberate fix from one used to clear a refusal under time pressure,
  // so this clause is the only thing between the two — and losing it discards
  // the guard while every other pin here stays green.
  const rule = RULE();
  assert.match(rule, phrase("Re-pin only after a change you made deliberately"));
  assert.match(rule, phrase("Re-pinning to clear a refusal you cannot explain discards the check"));
});

test("the rule records that refs are out of the digest, and why", () => {
  // Not decoration: the ticket's corroborating evidence is a stray branch, so
  // the next reader will ask. Without the reason, "add refs to the digest" is
  // an obvious-looking improvement that fires on ordinary work several times a
  // wave — which is the noise #436's third acceptance criterion rules out.
  const rule = RULE();
  assert.match(rule, phrase("It does not cover refs, deliberately"));
  assert.match(rule, phrase("a per-gate refusal on that is noise"));
});

test("phase 0 step 0 pins the set, and only after the fast-forward", () => {
  const step = PIN_STEP();
  assert.match(step, phrase("instruments.sh --pin"));
  // The ordering is the load-bearing half. Phase 0 step 0 fast-forwards the
  // checkout because the runbook is read out of it; pinning first certifies the
  // superseded text for the whole run, and every later gate then passes.
  assert.match(step, phrase("after that fast-forward and before anything reads them"));
  // Both anchors present, in this order. The hand-rolled `indexOf(ff) <
  // indexOf(pin)` this replaces was vacuous to the rewording it exists to catch:
  // reword the fast-forward away and `indexOf` returns -1, which is less than
  // anything. `between` throws by name on either anchor missing and on the
  // reversed order, which is every case the comparison was meant to cover.
  between(RUN_TEAM, "git merge --ff-only origin/main", "**Pin the instruments,", "run-team phase 0 ordering");
});

test("the mid-run tooling fix re-pins — the one legitimate writer to the set", () => {
  const fix = TOOLING_FIX();
  assert.match(fix, phrase("Re-pin first"));
  assert.match(fix, phrase("instruments.sh"));
  // The consequence, spelled out, is what stops the step being dropped as
  // ceremony: skipping it makes the controller's own fix look like tampering.
  assert.match(fix, phrase("the next gate refuses on your own fix"));
});

test("the path the prose tells the controller to run is a real executable", () => {
  // The cheapest guard against the whole mechanism being prose about nothing:
  // a renamed or deleted script leaves all the assertions above green.
  //
  // Absence is all this can decide, and the collection it replaces could not
  // decide more: the capture group was a fixed literal, so the Set it filled
  // held one element or none and `size === 1` was "the name appears somewhere"
  // wearing a cross-site consistency check's clothes.
  const SH = "skills/fleet/scripts/instruments.sh";
  assert.match(RUN_TEAM, phrase(`~/.claude/${SH}`), "the prose stopped naming the instrument check by path");
  accessSync(join(REPO, SH), constants.X_OK);
});
