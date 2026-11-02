// `recipe-check.mjs` exits 2 for a refusal the member can clear and 4 for one
// it cannot, and every surface that tells a member to run it says how each
// ends:
//
//   - the implementer brief, rendered: exit 4 ends `blocked`;
//   - the fix-applier brief, rendered, for every kind it has: exit 4 ends in a
//     `failed` report, never the no-report ending;
//   - review-and-fix.md's step 3, which the fix-applier runs: neither exit is
//     red.
//
// The controller's side: a settle wake's `NEED derive-recipe` is phase 0's
// mid-run trigger, counted in its one re-derivation per run, and the two
// Failure handling rows of run-team's SKILL.md name it.
//
// THE CEILING: presence pins over a paragraph each, as prose-pin.mjs bounds
// them; a negating sentence added beside an intact span stays green.
// dispatch-block-golden-prose.test.mjs holds both briefs whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { CASES, renderBrief } from "./support/render-brief.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const read = (...p) => readFileSync(join(PLUGIN, ...p), "utf8");

// The paragraph of a rendered brief that tells the member what exit 2 and exit 4 are.
const endings = (text, anchor, what) => Pin.of(text, what).paragraph(anchor, what, "Your report is a file,").text;

const CLEARABLE = "do what its message says, then run `recipe-check.mjs` again, and if it refuses again push nothing and end as for exit 4";
const NEVER_DERIVE = "never derive the Recipe, and never rebase, re-run or edit to get around it";

test("the rendered implementer brief ends exit 2 by clearing it once and exit 4 in a blocked report that carries the refusal", () => {
  const p = endings(renderBrief("implementer"), "Exit 2 is a refusal you can clear:", "the implementer brief's recipe-check refusal paragraph");
  assert.match(p, Pin.phrase("Exit 2 is a refusal you can clear: it ran nothing and wrote nothing, and its message names the cause — a working tree that is not the staged tree, git that did not answer, a usage error."));
  assert.match(p, Pin.phrase("Do what it says, then run `recipe-check.mjs` again; refused again → push nothing and end as for exit 4."));
  assert.match(p, Pin.phrase("Exit 4 is a refusal you cannot clear: no usable Recipe, a Recipe reader that did not answer, or a reports directory it cannot create or write to."));
  assert.match(p, Pin.phrase("Never derive the Recipe, and never rebase, re-run or edit to get around it."));
  assert.match(p, Pin.phrase("One exception: when the refusal names a path your own staged change deletes, renames or changes the mode of (`git diff --cached --summary`), undo that change unless the ticket requires it, and run `recipe-check.mjs` once more."));
  assert.match(p, Pin.phrase("Otherwise — the change is required, or the re-run refuses again — push nothing and end as `blocked`: write the report with `outcome` `blocked`, `pr`, `head` and `bailCause` null, `bailDetail` `recipe-check.mjs`'s stderr verbatim, and leave the worktree as it stands."));
  assert.match(p, Pin.phrase("The ticket stays claimed, its label untouched, and waits for the maintainer."));
});

for (const kind of CASES.filter((c) => c.role === "fix-applier").map((c) => c.kind)) {
  test(`the rendered fix-applier ${kind} brief ends exit 2 by clearing it once and exit 4 in a failed report, not the no-report ending`, () => {
    const p = endings(renderBrief("fix-applier", kind), "A refusal that recorded nothing is no red.", `the fix-applier ${kind} brief's recipe-check refusal paragraph`);
    assert.match(p, Pin.phrase("Exit 2 is one you can clear — a working tree that is not the staged tree, git that did not answer, a usage error:"));
    assert.match(p, Pin.phrase(CLEARABLE));
    assert.match(p, Pin.phrase("Exit 4 is one you cannot clear — no usable Recipe, a Recipe reader that did not answer, a reports directory it cannot create or write to:"));
    assert.match(p, Pin.phrase(NEVER_DERIVE));
    assert.match(p, Pin.phrase("When the refusal names a path your own staged change deletes, renames or changes the mode of (`git diff --cached --summary`), undo that change unless the PR requires it, and run `recipe-check.mjs` once more."));
    assert.match(p, Pin.phrase("Otherwise — the change is required, or the re-run refuses again — push nothing and write a `failed` report, a report and not the no-report ending: `head` the PR's head on origin, which you pushed nothing past, `applied` and `deferred` empty, `dispositionsRecord` and `testRun` null, the refusal verbatim in `confirmation`, and `filed` and `unrecorded` as for any outcome."));
  });
}

test("review-and-fix step 3 calls neither exit 2 nor exit 4 red: each is a refusal that records nothing, and the brief says how it ends", () => {
  const step = Pin.of(read("commands", "review-and-fix.md"), "review-and-fix.md")
    .between("**Under the fleet, run the two through `recipe-check.mjs`, not one by one:**", "4. **Under the fleet, do not hold this wait.**", "review-and-fix step 3's recipe-check paragraph").text;
  assert.match(step, Pin.phrase("Exit 1 is red; exit 2 and 4 are refusals that record nothing: your brief says how each ends;"));
  assert.doesNotMatch(step, /A non-zero exit is red/);
});

test("phase 0's mid-run rule counts a settle wake's NEED derive-recipe in its one re-derivation, and says what to retry", () => {
  const p = Pin.of(read("skills", "run-team", "references", "phase-0.md"), "phase-0.md")
    .paragraph("**Mid-run, a cache that stops running is re-derived once", "phase 0's mid-run rule", "## Fold in every Owned PR a prior").text;
  assert.match(p, Pin.phrase("So is the `NEED derive-recipe` a settle wake prints, `fleet-event.mjs impl-report` for an implementer settled `blocked` and `fix-report` for a fix-applier settled `failed`:"));
  assert.match(p, Pin.phrase("a line printed while that derivation runs is covered by it, and one printed after its `RECIPE PROVEN` is the second refusal that stalls the run."));
  assert.match(p, Pin.phrase("What to retry for a wake's line: a fix-applier's PR is fix-due again and the tick re-dispatches it; a blocked implementer's ticket is reported to the maintainer and waits for their `replace #<N>`."));
  assert.match(p, Pin.phrase("The count is yours to keep; the ledger holds no record of it."));
});

test("phase 0's Recipe read names the Check step beside install and test, each at origin/main", () => {
  const p = Pin.of(read("skills", "run-team", "references", "phase-0.md"), "phase-0.md")
    .between("**Derive the Recipe — the Recipe derivation step — before the fold-in below", "**Where `checkCmd` comes from:**", "the Recipe derivation step").text;
  assert.match(p, Pin.phrase("`~/.fleet/bin/fleet-run derive-testcmd.sh . install --at origin/main`, `~/.fleet/bin/fleet-run derive-testcmd.sh . check --at origin/main` and `~/.fleet/bin/fleet-run derive-testcmd.sh . test --at origin/main`."));
  assert.match(p, Pin.phrase("**All three exit 0 → the cache is present and valid: use it as it stands and derive nothing.**"));
  assert.match(p, Pin.phrase("**`RECIPE PROVEN`** → re-run the three reads above (`derive-testcmd.sh . install --at origin/main`, `derive-testcmd.sh . check --at origin/main` and `derive-testcmd.sh . test --at origin/main`);"));
});

test("run-team's Failure handling rows for a blocked implementer and a fix-applier that cannot reach green name the wake's NEED as phase 0's mid-run trigger", () => {
  const skill = Pin.file(join(PLUGIN, "skills", "run-team", "SKILL.md"));
  const blocked = skill.between("| Implementer blocked or ambiguous *mid-implementation* |", "| `review-pr` workflow throws", "the implementer-blocked row").text;
  assert.match(blocked, Pin.phrase("the ticket is not In flight and waits for a human;"));
  assert.match(blocked, Pin.phrase("its `NEED derive-recipe` is phase 0's mid-run trigger"));
  const failed = skill.between("| Reviewer, fix-applier or red-check fixer cannot reach green |", "| Merge bot finds the worktree ahead of the PR head", "the cannot-reach-green row").text;
  assert.match(failed, Pin.phrase("the last two settle `failed`; a wake's `NEED derive-recipe` is phase 0's mid-run trigger"));
});
