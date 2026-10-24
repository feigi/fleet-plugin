// run-team's phase 0 dispatches off stranded.mjs's answer; the script acts on
// nothing itself. These pins hold the half only the runbook carries: what a
// `resume` and a `report` make the controller do, and that the step runs
// after the rotation whose `prior` it reads.
import { test } from "node:test";
import assert from "node:assert/strict";

import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

// The phase-0 step paragraphs live in the reference file, one heading per moved step paragraph.
const PHASE0 = Pin.file(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "references", "phase-0.md"));
const step = () => PHASE0.section("## Resume the claims a dead run left without a PR", "phase-0 stranded-claim step").text;

test("the stranded-claim step runs stranded.mjs after the rotation and reads prior, never the record", () => {
  const s = step();
  assert.match(s, Pin.phrase("`~/.fleet/bin/fleet-run stranded.mjs` lists and classifies; you dispatch."));
  assert.match(s, Pin.phrase("It reads the `prior` rotate just recorded, never the record itself, which names this run's own live controller"));
  // `between` throws when either anchor is gone or the two come in the other
  // order, which a bare `indexOf` comparison reads as true when one is missing.
  PHASE0.between("**Rotate the ledger before the fold-in", "**Resume the claims a dead run left",
    "the step reads the prior rotate writes, so it must come after the rotation");
});

test("a resume dispatches a new member under a new name on the same ticket and worktree, through the ordinary ledger path", () => {
  const s = step();
  assert.match(s, Pin.phrase("a new member under a new name — `impl-<N>-b`, or one letter past the highest `impl-<N>-<x>` in the archive that rotate printed the path of — on the same ticket, in the printed worktree and branch"));
  assert.match(s, Pin.phrase("Record it the ordinary way — `ledger.mjs row <N> \"impl-<N>-b\"`, then `dispatch-prompt.mjs render implementer --member impl-<N>-b …`, then `ledger.mjs dispatch <N> impl-<N>-b`, then the `task` call naming the `agent` it printed, then the tier check — and never `claim-ticket.sh`: the claim already stands."));
});

test("a report goes to the maintainer and nothing else, and ancestor and none resume nothing", () => {
  const s = step();
  assert.match(s, Pin.phrase("A `report` goes to the maintainer as `#<N> — <why>` and nothing else: no dispatch, no label change, no release."));
  assert.match(s, Pin.phrase("`prior: ancestor` — this session's own earlier run: no `in-progress` claim is listed."));
  assert.match(s, Pin.phrase("every `in-progress` claim is `report`, and nothing is resumed."));
  assert.match(s, Pin.phrase("Exit 2 is a list that did not answer — a `gh` or `git` failure, a list at its cap, a worktree whose presence cannot be told, or, after `ancestor`, a ledger that cannot be read — and is never nothing stranded."));
});

test("a claim no in-progress label holds live is a report whatever prior says, with the dry run's blockers and both ways out", () => {
  const s = step();
  assert.match(s, Pin.phrase("Whatever `prior` says — every implementer claim on the disk, a worktree `.worktrees/<N>-impl-<N>[-x]` or a local branch `implementer/<N>-impl-<N>[-x]`, whose issue is open and carries no `in-progress` label and no open PR: `report`, never `resume`."));
  assert.match(s, Pin.phrase("Its `why` is the blocker list of a read-only `release-ticket.sh <N> impl-<N>[-x] implementer` dry run"));
  assert.match(s, Pin.phrase("then the two ways out: push the branch and open a PR, or release the claim by hand."));
  assert.match(s, Pin.phrase("A dry run or an issue read that does not answer still lists the claim, naming why."));
});
