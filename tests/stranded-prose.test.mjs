// run-team's phase 0 dispatches off stranded.mjs's answer; the script acts on
// nothing itself. These pins hold the half only the runbook carries: what a
// `resume` and a `report` make the controller do, and that the step runs
// after the rotation whose `prior` it reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./support/prose-pin.mjs";

const RUN_TEAM = readFileSync(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "SKILL.md"), "utf8");
const step = () => between(RUN_TEAM, "**Resume the claims a dead run left without a PR", "1. **Build the Shortlist**",
  "run-team stranded-claim step");

test("the stranded-claim step runs stranded.mjs after the rotation and reads prior, never the record", () => {
  const s = step();
  assert.match(s, phrase("`~/.fleet/bin/fleet-run stranded.mjs` lists and classifies; you dispatch."));
  assert.match(s, phrase("It reads the `prior` rotate just recorded, never the record itself, which names this run's own live controller"));
  assert.ok(RUN_TEAM.indexOf("**Rotate the ledger before the fold-in") < RUN_TEAM.indexOf("**Resume the claims a dead run left"),
    "the step reads the prior rotate writes, so it must come after the rotation");
});

test("a resume dispatches a new member under a new name on the same ticket and worktree, through the ordinary ledger path", () => {
  const s = step();
  assert.match(s, phrase("a new member under a new name — `impl-<N>-b`, or one letter past the highest `impl-<N>-<x>` in the archive that rotate printed the path of — on the same ticket, in the printed worktree and branch"));
  assert.match(s, phrase("Record it the ordinary way — `ledger.mjs row <N> \"impl-<N>-b\"`, then `ledger.mjs dispatch <N> impl-<N>-b`, then the `task` call naming the `agent` it printed, then the tier check — and never `claim-ticket.sh`: the claim already stands."));
});

test("a report goes to the maintainer and nothing else, and ancestor and none resume nothing", () => {
  const s = step();
  assert.match(s, phrase("A `report` goes to the maintainer as `#<N> — <why>` and nothing else: no dispatch, no label change, no release."));
  assert.match(s, phrase("`prior: ancestor` — this session's own earlier run: nothing is listed."));
  assert.match(s, phrase("every claim is `report`, and nothing is resumed."));
  assert.match(s, phrase("Exit 2 is a list that did not answer — a `gh` or `git` failure, a list at its cap, or a worktree whose presence cannot be told — and is never nothing stranded."));
});
