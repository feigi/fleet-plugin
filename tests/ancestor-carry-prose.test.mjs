// What phase 0 does with the rows and `## Dispatched` entries `ledger.mjs
// rotate` carries across a same-session (`ancestor`) restart. The carry itself
// is tested against the script (ledger-rotate.test.mjs, fleet-tick.test.mjs);
// these pins hold the half only the runbook carries — that the fold-in leaves
// a carried row alone, how the controller reconciles each carried token
// against the session's job list, and the tier-check consequence after
// `/resume` — and that the rotate step no longer says nothing is carried.
import { test } from "node:test";
import assert from "node:assert/strict";

import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const RUN_TEAM = Pin.file(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "SKILL.md"));
// The phase-0 step paragraphs live in the reference file, one heading per moved step paragraph.
const PHASE0 = Pin.file(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "references", "phase-0.md"));
const rotateStep = () => PHASE0.between("**Rotate the ledger before the fold-in below", "**The guard is the", "phase-0 rotate step").text;
const foldIn = () => PHASE0.between("**Fold in every PR a prior run left open", "**Resume the claims a dead run left", "phase-0 fold-in step").text;
const ancestor = () => PHASE0.bullet("- `prior: ancestor` — this session's own earlier run", "- `prior: none`", "phase-0 stranded-claim ancestor branch").text;
const resumeHold = () => RUN_TEAM.bullet("- **The tier check.**", "- **The exploration rule.**", "run-team tier-check /resume limitation").text;

test("the rotate step says what an ancestor rotate carries, and that dead and none carry nothing", () => {
  const s = rotateStep();
  assert.match(s, Pin.phrase("After `dead` or `none` nothing is carried — no row, exclusion, `## Filed` or `## Ruled` entry"),
    "dead and none must still carry nothing");
  assert.match(s, Pin.phrase("it writes a new ledger holding every row of a stream (one PR's rows) in which a row carries an unsettled member token or an open `review=` launch, whole and with every other token on it, plus every unsettled `## Dispatched` entry and the settled entry of each member a carried row names"),
    "the ancestor carry must name what it carries");
  assert.match(s, Pin.phrase("A line it cannot parse is skipped with a warning naming it, and the rotation still succeeds; a member name on a skipped line that carries an outcome is retired all the same, and a bare member token on a skipped row retires nothing."));
  // A settled name the carry leaves behind is still the session's.
  assert.match(s, Pin.phrase("Every other settled name — in `## Dispatched` or on any row, and including a name whose outcome is outside its family's vocabulary, whose line is skipped below — and every reviewer runner a row launched goes into the new ledger's `## Retired` as a bare name, with whatever the archive's own `## Retired` held"),
    "the rotate step must say which names retire");
  assert.match(s, Pin.phrase("`dispatch` refuses a retired name and names the replacement"), "and that dispatch reads them");
  assert.match(s, Pin.phrase("`review` refuses a retired runner name and names the next free reviewer name"), "and that review does");
  assert.match(s, Pin.phrase("The tick reads `## Retired` only to account for a transcript in the session directory: a ticket an earlier run worked is not claimed by it"), "and the accepted non-goal: a retired ticket is not claimed");
  assert.match(s, Pin.phrase("Every reader takes a `## Retired` line's name as its text before the first `=` — the whole line when there is none — so a name written with an outcome stays retired; a line whose name is no member or reviewer name makes `dispatch`, `review` and the tick refuse, naming the line, until it is fixed by hand."),
    "and the one reading of a `## Retired` line every reader shares");
  assert.doesNotMatch(s, /Nothing is carried forward/, "the unconditional no-carry claim must be gone");
  assert.doesNotMatch(s, /Member-killed row's check/, "the ancestor case is the carry's now, not the Member-killed check's");
});

test("the fold-in skips a PR whose row rotate carried, since a row write would wipe its live tokens", () => {
  assert.match(Pin.unemphasized(foldIn()), Pin.phrase("Skip a PR a row rotate carried already holds — its `#<pr>` key, or the PR of its `impl-<N>=PR#<pr>` token: that row already queues it, and a `ledger.mjs row` write replaces the whole line, wiping the live tokens carried on it."));
});

test("the ancestor branch reconciles each carried token against proc://, and records a death in both forms", () => {
  const s = ancestor();
  assert.match(s, Pin.phrase("read `proc://` once, find each `name` among this session's jobs, and act on its state."));
  assert.match(s, Pin.phrase("`running` → keep the token."));
  assert.match(s, Pin.phrase("`completed` or `failed` → record its result from `agent://<id>` as the wake table of **Rule: record, tick, act, beat** records that member's report"));
  assert.match(s, Pin.phrase("`cancelled` → record it dead."));
  assert.match(s, Pin.phrase("Absent, or a state you cannot read → keep the token live and let the Member-killed row clear it: a token nothing confirms dead counts as live."));
  assert.match(s, Pin.phrase("An `impl-`, `fix-pr-`, `finisher-pr-` or `merge-bot-` member is settled: `ledger.mjs settle <name> killed`."),
    "the member form of recording a death");
  assert.match(s, Pin.phrase("A reviewer is no member `settle` takes — `settle review-pr-<n> killed` exits 2 — so its launch is settled `=failed` where it stands: a `ledger.mjs review <pr> review=member:<name>=failed` call that turns `review=member:<name>` on the PR's row into `review=member:<name>=failed`"),
    "the reviewer form of recording a death");
  assert.doesNotMatch(s, /Member-killed row's check covers/, "the ancestor branch no longer hands its members to the Member-killed check");
});

test("the tier check states that after /resume a carried live implementer holds the whole tick, and how that clears", () => {
  const s = resumeHold();
  assert.match(s, Pin.phrase("the check given this run's `session` finds no `<member>.jsonl` and exits 2, writing nothing. `HOLD (tier unchecked impl-<N>)` then stops the whole tick, not only that member's ticket."));
  assert.match(s, Pin.phrase("It clears once the member settles: one settled `killed` or `released` gets `tier-unverifiable=` from the same check"));
  assert.match(s, Pin.phrase("`proc://` reads `running` → wait; dead → the Member-killed row."));
});
