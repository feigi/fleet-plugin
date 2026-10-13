// A reviewer that holds the dispatch tool still has to be TOLD the fan-out is
// requested work, or it declines to dispatch the specialists and the run
// silently downgrades to a thinner solo review. member-lifecycle.md's
// "Capability is not permission" section says so.
//
// What the rule rests on is the distinction itself — holding the tool is not
// authorization to use it — and not on any standing instruction an omp member
// inherits. The retired wording named such an instruction (`AgentTool`) and
// rested the rule on that inheritance; reverting either document to it left
// every other test green, because nothing read these two passages at all.
//
// Each passage is sliced to its own paragraph or section, never matched
// file-wide: both documents discuss the fan-out in many other places, and a
// file-wide match is satisfied by any of them while the rule's own wording is
// gutted. Every match goes through `phrase()`, which tolerates a rewrap of the
// same words — a pin that reds on a reflow discriminates nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const read = (...p) => Pin.file(join(REPO, ...p));

const LIFECYCLE = read("skills", "run-team", "references", "member-lifecycle.md");

// [label, passage, the sentence stating "holding the tool is not authorization",
//  the sentence stating what the reviewer must be told].
const PASSAGES = [
  [
    "member-lifecycle.md's 'Capability is not permission' section",
    LIFECYCLE.section("## Capability is not permission", "references/member-lifecycle.md").text,
    "Holding the dispatch tool does not authorize using it",
    "reviewer prompt must state full specialist set IS requested work",
  ],
];

test("the fan-out passage says holding the dispatch tool is not authorization to use it", () => {
  for (const [label, passage, notAuthorization] of PASSAGES) {
    assert.match(
      passage,
      Pin.phrase(notAuthorization),
      `${label} no longer says "${notAuthorization}" — without it a reviewer that holds the dispatch tool reads the fan-out as optional and silently downgrades to a thinner solo review`,
    );
  }
});

test("the fan-out passage tells the controller to state the full specialist set IS the requested work", () => {
  for (const [label, passage, , mustState] of PASSAGES) {
    assert.match(
      passage,
      Pin.phrase(mustState),
      `${label} no longer says "${mustState}" — the controller is no longer told what the reviewer prompt must carry`,
    );
  }
});

test("the fan-out passage does not rest the rule on a standing instruction the member inherits", () => {
  // The retired premise, not a spelling of it: any restatement that grounds the
  // rule in an inherited do-not-dispatch instruction is the claim this ticket
  // removed, whichever tool name it uses. `AgentTool` and the verb `inherits`
  // are the two ways it was written.
  for (const [label, passage] of PASSAGES) {
    assert.doesNotMatch(
      passage,
      /AgentTool|\binherit/i,
      `${label} grounds the fan-out rule in an inherited standing instruction again — omp members inherit no such instruction; the rule is that holding the tool is not authorization to use it`,
    );
  }
});
