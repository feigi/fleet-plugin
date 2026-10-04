// A reviewer that holds the dispatch tool still has to be TOLD the fan-out is
// requested work, or it declines to dispatch the specialists and the run
// silently downgrades to a thinner solo review. Two documents say so: run-team's
// "Authorize the fan-out explicitly" paragraph, and member-lifecycle.md's
// "Capability is not permission" section.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");

const SKILL = read("skills", "run-team", "SKILL.md");
const LIFECYCLE = read("skills", "run-team", "references", "member-lifecycle.md");

// [label, passage, the sentence stating "holding the tool is not authorization",
//  the sentence stating what the reviewer must be told]. The two documents word
// the same rule differently, so each carries its own spelling.
const PASSAGES = [
  [
    "run-team/SKILL.md's 'Authorize the fan-out explicitly' paragraph",
    paragraph(SKILL, "Authorize the fan-out explicitly.", "run-team/SKILL.md"),
    "holding the dispatch tool is not authorization to use it",
    "State that the full specialist set IS the requested work",
  ],
  [
    "member-lifecycle.md's 'Capability is not permission' section",
    between(LIFECYCLE, "## Capability is not permission", "\n## ", "references/member-lifecycle.md"),
    "Holding the dispatch tool does not authorize using it",
    "reviewer prompt must state full specialist set IS requested work",
  ],
];

test("both fan-out passages say holding the dispatch tool is not authorization to use it", () => {
  for (const [label, passage, notAuthorization] of PASSAGES) {
    assert.match(
      passage,
      phrase(notAuthorization),
      `${label} no longer says "${notAuthorization}" — without it a reviewer that holds the dispatch tool reads the fan-out as optional and silently downgrades to a thinner solo review`,
    );
  }
});

test("both fan-out passages tell the controller to state the full specialist set IS the requested work", () => {
  for (const [label, passage, , mustState] of PASSAGES) {
    assert.match(
      passage,
      phrase(mustState),
      `${label} no longer says "${mustState}" — the controller is no longer told what the reviewer prompt must carry`,
    );
  }
});

test("neither fan-out passage rests the rule on a standing instruction the member inherits", () => {
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
