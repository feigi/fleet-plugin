// #1177. The merge bot's gate is specified in `run-team/SKILL.md`'s **Merge
// bot** section as "gate on the payload's own fields ... read with `jq`", and
// the trap list above it named only failures that return a WRONG VERDICT. It
// had nothing for the gate that never evaluated, and `jq` has exit codes for
// exactly that: measured here on jq 1.7.1, `echo '{"a":1}' | jq -e '.a｜length'`
// (a full-width `｜` where `|` was meant) exits 3, against 1 for a real
// false-or-null and 0 for a real truthy. A three-outcome code read as a boolean
// is wrong whichever way it is read — `-eq 0` blocks a mergeable PR on a typo,
// `-ne 1` merges on a gate that never parsed — so neither direction is a safe
// default and the rule has to be written down rather than left to a bot's
// judgement in the moment. It was left to one: the bot merging #1172 got rc=3,
// read it as neither pass nor fail on its own initiative, and re-ran.
//
// PIN THE IMPERATIVE, NOT THE RATIONALE. #1147's tier row is the record for the
// opposite shape — every explanatory sentence around a mandate pinned and the
// mandate itself left bare, so inverting it costs nothing. So this pins the two
// clauses that ARE the rule (a non-0/1 exit is not a verdict; re-run once, then
// report and stop) and leaves the measured code list, the two spellings of the
// misreading, and the sibling-script citation deliberately unpinned — those are
// the sentences that must stay free to be re-measured or reworded.
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
// the brief, and the sentence resuming the gate spec after them. Unbounded, the
// terms this pins (`jq`, exit codes, "re-run") occur freely across a file of
// thousands of lines, and a bare file-wide match would go green off any of them.
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

test("the trap list bounds the response: re-run once, then report and stop", () => {
  assert.match(
    gateTraps(),
    phrase("re-run the gate once, and if the same exit repeats report it and stop rather than re-running again"),
  );
});
