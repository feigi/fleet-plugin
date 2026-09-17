// Pins the rule that `docs/agents/issue-tracker.md` states nowhere else.
// #79: the section reproduced the issue-read command and its bare `--comments`
// caveat verbatim but carried neither of the (then two) WHICH-TEXT-WINS rules,
// so the copy read as complete while they were absent. #25 later dropped the
// second of those rules — the `Respec` block was instructed nowhere else and
// never defined, in this doc or in any real issue — leaving the
// brief-outranks-body rule pinned here alone.
//
// No SKILL.md instructs an agent to READ this doc as its entry point for
// the fetch-the-relevant-ticket rule: the rule reaches agents through three
// SKILL.md files that each carry their own copy — run-team word-for-word
// inside its verbatim implementer prompt, next-ticket and sizing-a-ticket
// paraphrased — not by deferring here. (run-team/SKILL.md does link this
// doc once, at its closing-keyword exemption — an unrelated rule, not a
// hand-off to this section.) #79 brought the doc into sync with those three
// copies; it is the catch-up copy, not their source, so this pin keeps the
// doc from drifting back out, nothing more.
//
// What DEPENDS on this doc is settled by MUTATION, never by grepping for
// `issue-tracker`: the string matches many more paths than read the doc,
// and a match cannot tell a mention from a dependency. Write `MUTATED` over
// `docs/agents/issue-tracker.md` in a scratch copy of the tree and run
// `node --test plugin/scripts/*.test.mjs` (every test file lives there);
// what reddens against that copy's own green baseline is what reads it.
// Measured on this commit: this file, `closing-keyword-prose.test.mjs` and
// `tracker-block-copy-prose.test.mjs`, no other suite. Re-run the mutation
// rather than trusting that list — a grep result frozen into a header is
// the defect #1119 names.
//
// THE CEILING, same as fleet-tick-prose.test.mjs: this proves a phrase is
// PRESENT. It cannot prove it is not negated by a sentence added beside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
const TRACKER = readFileSync(join(REPO, "docs", "agents", "issue-tracker.md"), "utf8");

// Sliced to this section alone. Unbounded to EOF the slice runs through the
// wayfinding operations, and a `## Agent Brief` mention anywhere past here
// would satisfy the assertions with the section itself deleted. Stops at the
// next `#` or `##` — either one closes this section — and falls back to EOF
// rather than bailing, so a correct doc still passes once this is the last
// section. Not `indexOf("\n## ")` alone: that runs the slice through a later
// `# ` h1, and the rules relocated under one then read as still present.
function fetchSection() {
  const start = '## When a skill says "fetch the relevant ticket"';
  const at = TRACKER.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const rest = TRACKER.slice(at + start.length);
  const next = rest.match(/\n#{1,2} /);
  return start + (next ? rest.slice(0, next.index) : rest);
}

test("the fetch section says the Agent Brief comment outranks the issue body", () => {
  // Without it an agent that reads the documented entry point takes the body as
  // authoritative and never learns a brief can overrule it.
  assert.match(fetchSection(), /`## Agent Brief` comment\s+is\s+authoritative over the issue body/);
});
