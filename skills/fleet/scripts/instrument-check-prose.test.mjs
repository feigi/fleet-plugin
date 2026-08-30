// #436. `instruments.sh` is executed by an AGENT reading run-team/SKILL.md, so
// the script being correct buys nothing on its own — the whole mechanism is
// three clauses of prose, and every one of them can rot without an error:
//
//   - the RULE (both refusing exit codes, and no re-read after a refusal),
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
  const rule = RULE();
  for (const gate of ["SHA acceptance", "CI verdict", "reconcile", "reap", "label gate"]) {
    assert.match(rule, phrase(gate), `the rule stopped naming the ${gate}`);
  }
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
  assert.ok(
    RUN_TEAM.indexOf("git merge --ff-only origin/main") < RUN_TEAM.indexOf("**Pin the instruments,"),
    "the pin must be documented after the fast-forward, not before it",
  );
});

test("the mid-run tooling fix re-pins — the one legitimate writer to the set", () => {
  const fix = TOOLING_FIX();
  assert.match(fix, phrase("Re-pin first"));
  assert.match(fix, phrase("instruments.sh"));
  // The consequence, spelled out, is what stops the step being dropped as
  // ceremony: skipping it makes the controller's own fix look like tampering.
  assert.match(fix, phrase("the next gate refuses on your own fix"));
});

test("every path the prose tells the controller to run is a real executable", () => {
  // The cheapest guard against the whole mechanism being prose about nothing:
  // a renamed or deleted script leaves all the assertions above green.
  const paths = new Set(
    [...RUN_TEAM.matchAll(/~\/\.claude\/(skills\/fleet\/scripts\/instruments\.sh)/g)].map((m) => m[1]),
  );
  assert.equal(paths.size, 1, "the prose stopped naming the instrument check by path");
  for (const p of paths) accessSync(join(REPO, p), constants.X_OK);
});
