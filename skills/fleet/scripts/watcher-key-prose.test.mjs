// #183. The watcher key was stated in two documents and the copies disagreed.
// `run-team/SKILL.md` keys on `<run-id>:<attempt>:<conclusion>` and names the
// `attempt`-less form as the bug that looks like it works — a rerun landing on
// the same conclusion regenerates an already-seen key and fires nothing, so the
// second failure is silent and reads exactly like a run still in progress.
// `references/ci-and-staleness.md` — the file SKILL.md sends a controller to for
// the why, from its CI paragraphs — still carried the two-part form at both of
// its own sites. A controller that follows the pointer reads the refuted form
// last, and last read is what it arms the Monitor with.
//
// THE CEILING: the tree-wide pin is literal. It catches the two-part key written
// as the token, not a paraphrase ("key on run id and conclusion") that means the
// same thing, and it cannot tell a stale copy from a deliberate counter-example —
// a document that wants to show the broken form has to update this test. Neither
// pin runs anything: ci-state.test.mjs owns `ci-state.mjs`'s behavior, and the
// Monitor is armed by a controller reading this prose, not by code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const FLEET = join(REPO, "skills", "fleet");
const CI_AND_STALENESS = readFileSync(
  join(FLEET, "skills", "run-team", "references", "ci-and-staleness.md"),
  "utf8",
);

const TWO_PART = "`<run-id>:<conclusion>`";
const THREE_PART = "`<run-id>:<attempt>:<conclusion>`";

// Reflow-safety: markdown here hard-wraps at ~80 columns, so any of these tokens
// can land across a line break, and a pin that only matches the unwrapped form
// reddens on a rewrap that changed nothing. Paragraphs are split off FIRST — the
// bound that keeps a positive pin from being satisfied by a neighbouring
// paragraph — and only then is whitespace inside each one flattened.
const flat = (s) => s.replace(/\s+/g, " ").trim();
const paragraphs = (text) => text.split(/\n\s*\n/).map(flat);

// Anchored on what the sentence SAYS, never on where it sits: an ordinal re-rots
// the moment anyone inserts ahead of it.
function paragraphSaying(text, anchor, label) {
  const hits = paragraphs(text).filter((p) => p.includes(anchor));
  assert.equal(hits.length, 1, `${label}: '${anchor}' matched ${hits.length} paragraphs, expected 1 — update this test`);
  return hits[0];
}

const SITES = [
  ["the Monitor the controller arms over open PRs' latest runs", "controller arms second persistent Monitor"],
  ["the never-cache-a-conclusion rule", "never cache conclusion"],
];

test("ci-and-staleness.md keys watchers on the three-part form at both of its sites", () => {
  for (const [label, anchor] of SITES) {
    assert.match(
      paragraphSaying(CI_AND_STALENESS, anchor, label),
      new RegExp(THREE_PART.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${label} no longer keys on ${THREE_PART}; without \`attempt\` a rerun onto the same conclusion fires nothing and a stalled PR is indistinguishable from a running one`,
    );
  }
});

// Tree-wide, because the defect was a copy drifting from its original — pinning
// only the file this ticket corrected leaves the next copy free to be made wrong.
test("no document under skills/fleet states the two-part watcher key", () => {
  const offenders = readdirSync(FLEET, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.parentPath.includes("node_modules"))
    .map((e) => join(e.parentPath, e.name))
    // This file quotes the broken form to test for it, so it cannot test itself.
    .filter((f) => f !== import.meta.filename)
    .filter((f) => flat(readFileSync(f, "utf8")).includes(TWO_PART));
  assert.deepEqual(
    offenders,
    [],
    `these state the refuted two-part watcher key ${TWO_PART}; it must be ${THREE_PART}. If one of them means to show the broken form deliberately, update this test rather than the document`,
  );
});
