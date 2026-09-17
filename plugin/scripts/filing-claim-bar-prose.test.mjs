// ADR 0002. Step 5 gained a second, earlier bar: a finding whose own claim is
// that correct code could be shaped better never gets its own open issue — it
// goes into the per-review closed record under `Below the claim bar`, with a
// promotion path back out. Measured basis: 2026-08-15→31, 133 triage-closed
// `wontfix` in sixteen days, 121 of them review deferrals, mostly this shape.
//
// What this pins is the bar's KEY — the finding's claim, never its review
// band. #591 is why the distinction is load-bearing: `unverified` conflates
// policy-skipped suggestions with crashed-refuter criticals, so a band-keyed
// rule silently drops findings nobody looked at. A revert of the band sentence
// alone would leave a bar that reads as a severity floor, which is the exact
// shelved option ADR 0001 gated behind #591.
//
// Slices are flattened, same class defect as filing-bar-seat-prose.test.mjs:
// step 5 is one long line today, the ADR hard-wraps, and reflow must not red.
//
// CEILING: presence and adjacency over bounded slices. These prove the bar,
// its routing, and its band-exclusion are stated; they cannot prove a later
// sentence in the same slice does not carve out an exception.
//
// Measured as of this commit, on the working tree with restore after each: six
// mutations — the bar sentence deleted, its verdict inverted (never → keeps),
// the record routing redirected to an own open issue, the band-exclusion
// sentence deleted, the ADR pointer renamed in the prose, and the ADR's guard
// floor retuned 20 → 50 — each reddened its own pin and no other. Controls: an
// unpinned step-5 sentence reworded and the ADR's guard bullets rewrapped both
// stayed green.
//
// #1113 added the applied-promotion pin. Trigger A counts entries "promoted",
// and the filed path leaves a citation on the record while the fix-applier's
// apply path files nothing at all — so the promotion the trigger most needs to
// see left no mark on the record. Step 5 now writes one under a fixed opening
// and the ADR's guard names the same string; the pin compares the two by
// EQUALITY, because a search for one inside the other passes on a narrowing
// rename. Measured on the working tree with restore after each: five mutations
// — step 5's apply-path verdict inverted (files nothing → files its own issue),
// step 5's marker narrowed, the ADR's marker narrowed, the ADR's
// promotion-signal definition reworded down to the filed path alone, and step
// 5's marker unquoted — each reddened this pin and no other, while retuning
// Trigger A's 5 reddened only the older guard pin. Controls: the ADR's Trigger
// A bullet reflowed onto one line and an unpinned step-5 sentence reworded both
// stayed green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const REVIEW_AND_FIX = read("commands", "review-and-fix.md");
const ROOT = join(import.meta.dirname, "..", "..");

const flat = (s) => s.replace(/\s+/g, " ");

const step5 = () => flat(between(REVIEW_AND_FIX, "5. File each deferred finding", "\n6. Diff-check green", "review-and-fix step 5"));

test("step 5 states the claim bar: shaped-better findings never get their own open issue", () => {
  // The bar and its verdict as ONE span. Pinning "Worth a claim" apart from
  // "never gets its own open issue" leaves the join open — a clause spliced
  // between them reverses the rule and satisfies both.
  assert.match(
    step5(),
    phrase(
      "**Worth a claim: a finding whose own claim is that correct code could be shaped better — style, naming, layout, redundancy, a micro-simplification — never gets its own open issue.**",
    ),
    "step 5 lost the worth-a-claim bar — shaped-better findings are back to one open issue each",
  );
});

test("step 5 routes below-bar findings into the closed record, with a promotion path out", () => {
  const s = step5();
  assert.match(
    s,
    phrase("Append it to the same closed record issue under a `Below the claim bar` heading"),
    "step 5 no longer routes a below-bar finding into the per-review closed record issue",
  );
  assert.match(
    s,
    phrase("is the promotion signal: file it open then, citing the record"),
    "step 5 lost the promotion path — a below-bar finding rediscovered as real has no way back to its own issue",
  );
});

test("step 5 keys the bar on the finding's claim, never its review band", () => {
  // Contiguous through the confirmed/torn hand-off: the exclusion is only
  // meaningful bound to where an above-bar finding goes instead.
  assert.match(
    step5(),
    phrase(
      "**The bar reads the finding's claim, never its review band** — a finding that alleges wrong behavior, whatever band it sat in, `unverified`-with-crashed-refuters included, is above this bar and files open under the confirmed/torn split",
    ),
    "step 5 no longer excludes wrong-behavior findings from the claim bar — a band-keyed reading drops crashed-refuter criticals (#591)",
  );
});

test("step 5 points at an ADR that exists, and the ADR keeps its pre-chosen guard", () => {
  // Read the path out of the prose rather than restating it, so a rename that
  // updates only one side reds.
  const [, adrPath] = step5().match(/\(`(docs\/adr\/0002[^`]+)`\)/) ?? [];
  assert.ok(adrPath, "step 5 no longer cites an ADR 0002 path under `docs/adr/`");
  assert.ok(existsSync(join(ROOT, adrPath)), `step 5 points at \`${adrPath}\`, which does not exist`);

  const adr = flat(readFileSync(join(ROOT, adrPath), "utf8"));
  // Floor and both triggers as one span, 0001's precedent: chosen before any
  // data, and separate pins would let any one be retuned alone.
  assert.match(
    adr,
    phrase(
      "**Floor:** 20 below-bar entries across at least 3 distinct run dates. - **Trigger A — bar too wide:** 5 or more of those entries promoted",
    ),
    "the ADR's guard floor or promotion trigger moved — a pre-chosen guard that is retuned later is not a guard",
  );
  assert.match(
    adr,
    phrase("**Trigger B — bar missed the load:** non-record `wontfix` closes still above half of all closes"),
    "the ADR lost trigger B — nothing detects the clause missing the volume it was priced against",
  );
});

test("the applied promotion path is stated in step 5 and read by the ADR's guard", () => {
  const s = step5();
  // The path and its consequence as ONE span. "is that same promotion signal"
  // pinned apart from "it files nothing" leaves the join open, and the second
  // half is the whole reason the first needs writing down: this path leaves no
  // filed issue behind, so nothing lands on the record by itself.
  assert.match(
    s,
    phrase("**An in-scope rediscovery step 2 applied is that same promotion signal, and it files nothing**"),
    "step 5 no longer treats an applied below-bar rediscovery as a promotion — the entry re-derived, checked and worth fixing goes unrecorded",
  );
  // Read the comment's fixed opening out of each file's own prose and compare
  // the two, rather than restating the string here. A rename on one side alone
  // leaves Trigger A counting a mark nothing writes, and neither file is wrong
  // on its own after it. Equality, never a match of one inside the other:
  // measured, shortening step 5's opening to `Promoted — applied` stays green
  // under a `phrase(marker)` search of the ADR, because the ADR's longer string
  // contains it.
  const [, marker] = s.match(/comment on that record issue, opening `([^`]+)`/) ?? [];
  assert.ok(marker, "step 5 no longer gives the applied-promotion comment a fixed opening, so the guard has no mark to count");
  const [, adrPath] = s.match(/\(`(docs\/adr\/0002[^`]+)`\)/) ?? [];
  assert.ok(adrPath, "step 5 no longer cites an ADR 0002 path under `docs/adr/`");
  const adr = flat(readFileSync(join(ROOT, adrPath), "utf8"));
  const [, adrMarker] = adr.match(/`([^`]+)` comment on it/) ?? [];
  assert.equal(
    adrMarker,
    marker,
    `ADR 0002's guard counts \`${adrMarker}\` while step 5 writes \`${marker}\` — the trigger reads a mark nothing leaves`,
  );
  // The definition itself, not just the marker: a guard whose input is
  // undefined is not a guard, and the filed path alone is the half that
  // systematically undercounts.
  assert.match(
    adr,
    phrase("**Promotion signal — two marks, both on the record issue:** an open issue citing the record, and a"),
    "ADR 0002's Trigger A no longer defines what counts as a promotion, so the filed path is the only one an evaluator can see",
  );
});
