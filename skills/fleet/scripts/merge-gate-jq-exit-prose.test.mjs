// #1177. The merge bot's gate is specified in `run-team/SKILL.md`'s **Merge
// bot** section as "gate on the payload's own fields ... read with `jq`", and
// the trap list named only failures that return a WRONG VERDICT. It had nothing
// for the gate that never evaluated, and `jq` has exit codes for exactly that:
// measured here on jq-1.7.1-apple, `echo '{"a":1}' | jq -e '.a｜length'`
// (a full-width `｜` where `|` was meant) exits 3, against 1 for a real
// false-or-null and 0 for a real truthy. A three-outcome code read as a boolean
// is wrong whichever way it is read — `-eq 0` blocks a mergeable PR on a typo,
// `-ne 1` merges on a gate that never parsed — so neither direction is a safe
// default and the rule has to be written down rather than left to a bot's
// judgement in the moment. It was left to one: the bot merging #1172 got rc=3
// and read it as neither pass nor fail on its own initiative. What cleared it
// was correcting the `｜`; the re-run alongside could not have, because a
// program that does not compile does not compile differently on a second run
// (measured: three consecutive runs of the malformed program return 3, 3, 3).
// That asymmetry is why the rule scopes its response by exit rather than
// prescribing one re-run for all of them.
//
// PIN THE IMPERATIVE, NOT THE RATIONALE. #1147's tier row is the record for the
// opposite shape — every explanatory sentence around a mandate pinned and the
// mandate itself left bare, so inverting it costs nothing. So this pins the
// clauses that ARE the rule (a non-0/1 exit is not a verdict; the response is
// scoped to what the exit can change) and leaves the measured code list, the
// spellings of the misreading, and the sibling-script citation deliberately
// unpinned — those are the sentences that must stay free to be re-measured or
// reworded.
//
// THE CEILING: presence over a bounded slice, in the manner of
// `candidates-exit3-prose.test.mjs`. It cannot prove a sentence added beside
// the rule does not carve an exception out of it, and it does not exercise
// `jq` — no script in this repo reads a `jq` exit code as a verdict, the gate
// is written by the bot at run time, so there is no behavior here to test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

// The trap list alone, not the Merge bot section and not the file. Both bounds
// are the prose that brackets the list: the sentence ordering the traps into
// the brief, and the sentence resuming the gate spec after them. What the bound
// buys is PLACEMENT, not protection from term collision: `phrase()` builds its
// regex from the whole quoted sentence, so an unbounded pin does not go green
// off a stray `jq` — it goes green off the sentence surviving ANYWHERE in the
// file, including moved out of the trap list into an unrelated section, which
// is the realistic rot. Measured: with the rule relocated to an appendix, the
// bounded pin fails and an unbounded one passes.
const gateTraps = () =>
  between(
    RUN_TEAM,
    "**Put every gate trap in the bot's brief",
    "So **gate on the payload's own fields**",
    "run-team/SKILL.md's Merge bot trap list",
  );

test("the trap list says a jq exit outside 0 and 1 is not a verdict", () => {
  assert.match(gateTraps(), phrase("A `jq` exit outside 0 and 1 is not a verdict"));
});

test("the trap list scopes the response to what the exit can change", () => {
  assert.match(
    gateTraps(),
    phrase(
      "Scope the response to what the exit can change: 5, and 4 while the payload may still be filling, can clear on a re-read, so re-run the gate once and report if the same exit repeats; 3 and 2 are properties of the program and the invocation, so a second run returns them by construction — report and stop without re-running.",
    ),
  );
});
