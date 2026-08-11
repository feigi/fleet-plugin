// Pins the two rules that `docs/agents/issue-tracker.md` states nowhere else.
// The global `CLAUDE.md` routes every agent here for issue operations, and this
// section defines the phrase "fetch the relevant ticket" that the fleet skills
// defer to. #79: the section reproduced the issue-read command and its bare
// `--comments` caveat verbatim but carried neither rule, so the copy read as
// complete while the two rules that decide WHICH TEXT WINS were absent.
//
// THE CEILING, same as fleet-tick-prose.test.mjs: these prove a phrase is
// PRESENT. Neither can prove it is not negated by a sentence added beside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const TRACKER = readFileSync(join(REPO, "docs", "agents", "issue-tracker.md"), "utf8");

// Sliced to this section alone. Unbounded to EOF the slice runs through the
// wayfinding operations, and a `## Agent Brief` mention anywhere past here
// would satisfy the assertions with the section itself deleted.
function fetchSection() {
  const start = '## When a skill says "fetch the relevant ticket"';
  const at = TRACKER.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const end = TRACKER.indexOf("\n## ", at + start.length);
  assert.notEqual(end, -1, "no heading follows the fetch section — update this test");
  return TRACKER.slice(at, end);
}

test("the fetch section says the Agent Brief comment outranks the issue body", () => {
  // Without it an agent that reads the documented entry point takes the body as
  // authoritative and never learns a brief can overrule it.
  assert.match(fetchSection(), /`## Agent Brief` comment\s+is\s+authoritative over the issue body/);
});

test("the fetch section says a Respec block can rule out hypotheses the body raises", () => {
  // The brief-outranks-body rule alone does not say a brief may SUBTRACT: an
  // agent can honor it and still chase a hypothesis Respec already killed.
  assert.match(fetchSection(), /Respec` block — it may\s+explicitly\s+rule out hypotheses the body raises/);
});
