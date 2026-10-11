// What phase 0 does with the rows and `## Dispatched` entries `ledger.mjs
// rotate` carries across a same-session (`ancestor`) restart. The carry itself
// is tested against the script (ledger-rotate.test.mjs, fleet-tick.test.mjs);
// these pins hold the half only the runbook carries — that the fold-in leaves
// a carried row alone, how the controller reconciles each carried token
// against the session's job list, and the tier-check consequence after
// `/resume` — and that the rotate step no longer says nothing is carried.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, bullet, paragraph, phrase, unemphasized } from "./support/prose-pin.mjs";

const RUN_TEAM = readFileSync(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "SKILL.md"), "utf8");
const rotateStep = () => between(RUN_TEAM, "**Rotate the ledger before the fold-in below", "**The guard is the", "run-team rotate step");
const foldIn = () => between(RUN_TEAM, "**Fold in every PR a prior run left open", "**Resume the claims a dead run left", "run-team fold-in step");
const ancestor = () => bullet(RUN_TEAM, "- `prior: ancestor` — this session's own earlier run", "- `prior: none`", "run-team stranded-claim ancestor branch");
const resumeHold = () => paragraph(RUN_TEAM, "**After `/resume`, a carried implementer can hold the whole tick.**",
  "run-team tier-check /resume limitation", "**Run the check right after the dispatch");

test("the rotate step says what an ancestor rotate carries, and that dead and none carry nothing", () => {
  const s = rotateStep();
  assert.match(s, phrase("After `dead` or `none` nothing is carried — no row, exclusion, `## Filed` or `## Ruled` entry"),
    "dead and none must still carry nothing");
  assert.match(s, phrase("it writes a new ledger holding every row of a stream (one PR's rows) in which a row carries an unsettled member token or an open `review=` launch, whole and with every other token on it, plus every unsettled `## Dispatched` entry and the settled entry of each member a carried row names"),
    "the ancestor carry must name what it carries");
  assert.match(s, phrase("A line it cannot parse is skipped with a warning naming it, and the rotation still succeeds."));
  // #3082: a settled name the carry leaves behind is still the session's.
  assert.match(s, phrase("Every other settled name — in `## Dispatched` or on any row — goes into the new ledger's `## Retired` as a bare name, with whatever the archive's own `## Retired` held"),
    "the rotate step must say which names retire");
  assert.match(s, phrase("`dispatch` refuses a retired name and names the replacement"), "and that dispatch reads them");
  assert.match(s, phrase("The tick never reads `## Retired`"), "and the accepted non-goal: a retired ticket is not claimed");
  assert.doesNotMatch(s, /Nothing is carried forward/, "the unconditional no-carry claim must be gone");
  assert.doesNotMatch(s, /Member-killed row's check/, "the ancestor case is the carry's now, not the Member-killed check's");
});

test("the fold-in skips a PR whose row rotate carried, since a row write would wipe its live tokens", () => {
  assert.match(unemphasized(foldIn()), phrase("Skip a PR a row rotate carried already holds — its `#<pr>` key, or the PR of its `impl-<N>=PR#<pr>` token: that row already queues it, and a `ledger.mjs row` write replaces the whole line, wiping the live tokens carried on it."));
});

test("the ancestor branch reconciles each carried token against proc://, and records a death in both forms", () => {
  const s = ancestor();
  assert.match(s, phrase("read `proc://` once, find each `name` among this session's jobs, and act on its state."));
  assert.match(s, phrase("`running` → keep the token."));
  assert.match(s, phrase("`completed` or `failed` → record its result from `agent://<id>` as the **Record, then tick** table records that member's report"));
  assert.match(s, phrase("`cancelled` → record it dead."));
  assert.match(s, phrase("Absent, or a state you cannot read → keep the token live and let the Member-killed row clear it: a token nothing confirms dead counts as live."));
  assert.match(s, phrase("An `impl-`, `fix-pr-`, `finisher-pr-` or `merge-bot-` member is settled: `ledger.mjs settle <name> killed`."),
    "the member form of recording a death");
  assert.match(s, phrase("A reviewer is no member `settle` takes — `settle review-pr-<n> killed` exits 2 — so its launch is settled `=failed` where it stands: a `ledger.mjs review <pr> review=member:<name>=failed` call that turns `review=member:<name>` on the PR's row into `review=member:<name>=failed`"),
    "the reviewer form of recording a death");
  assert.doesNotMatch(s, /Member-killed row's check covers/, "the ancestor branch no longer hands its members to the Member-killed check");
});

test("the tier check states that after /resume a carried live implementer holds the whole tick, and how that clears", () => {
  const s = resumeHold();
  assert.match(s, phrase("the check given this run's `session` finds no `<member>.jsonl` and exits 2, writing nothing. `HOLD (tier unchecked impl-<N>)` then stops the whole tick, not only that member's ticket."));
  assert.match(s, phrase("It clears once the member settles: one settled `killed` or `released` gets `tier-unverifiable=` from the same check"));
  assert.match(s, phrase("`proc://` reads `running` → wait; dead → the Member-killed row."));
});
