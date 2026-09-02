// #836. `docs/agents/triage-labels.md`'s Meaning column is a TRANSCRIPT of the
// tracker's own label descriptions — three of the five cells were byte-identical
// to `gh api repos/feigi/claude-config/labels/<name> --jq .description` when this
// was written. A transcript has no owner, so it drifts against whichever side
// moves. ADR 0001 repriced the filing bar to "is the defect confirmed"; the
// `ready-for-agent` cell kept saying "Fully specified", which a remedy-open
// ticket is by construction not.
//
// The fix was to strip the criterion rather than restate it, so what needs
// guarding is a RE-ADDITION, and its vector is named and still live: the label
// description on the tracker still carries the old wording, and anyone
// re-syncing this column from it puts the contradiction straight back.
//
// CEILING: this pins two phrases out of two one-row slices. It catches the
// re-sync vector and a narrowing of `ready-for-human` back to implementation.
// It cannot prove the column carries no OTHER restated criterion — no assertion
// can, which is why the column's job is stated in the file's own `:3` rather
// than defended here.
//
// Measured as of this commit, on the working tree with `cp` restore after each:
// five mutations — the old description re-synced verbatim, the criterion
// re-added with two words wedged into the adjacency, `ready-for-human` narrowed
// back to implementation, that same narrowing with the noun gone, and the
// label-string mapping broken — each reddened its own pin and no other.
// Controls: a benign reword of a pinned cell, an unpinned row's cell rewritten,
// and the table re-padded to a wider column all stayed green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const TABLE = readFileSync(join(REPO, "docs", "agents", "triage-labels.md"), "utf8");

// One table row per slice. The claim is a single cell, so anything wider lets
// a neighbouring row satisfy the assertion with the cell rewritten.
const row = (label) => between(TABLE, `| \`${label}\``, "\n|", `the ${label} row`);

test("the ready-for-agent row maps the role and states no filing criterion", () => {
  const r = row("ready-for-agent");
  // Positive companion: without it the negative below passes trivially on a row
  // that has degenerated to nothing.
  assert.match(
    r,
    phrase("| `ready-for-agent` | `ready-for-agent` |"),
    "the ready-for-agent row no longer maps the role to its label string — that mapping is what scripts read",
  );
  // The stem, not the phrase. A negative pinned to the adjacency is trivially
  // evaded — measured: `/[Ff]ully\s+\w*\s*specified/` stayed green against
  // "Ready for a fully and precisely specified AFK agent", because a one-word
  // gap does not span two. A one-row gloss cell has no innocent use of the stem.
  assert.doesNotMatch(
    r,
    /specifi/i,
    "the ready-for-agent gloss is back to promising a fully specified ticket, which the filing bar in `skills/fleet/commands/review-and-fix.md` step 5 contradicts — a confirmed defect files here with its remedy still open",
  );
});

test("the ready-for-human row does not narrow the role to implementation", () => {
  const r = row("ready-for-human");
  assert.match(
    r,
    phrase("| `ready-for-human` | `ready-for-human` |"),
    "the ready-for-human row no longer maps the role to its label string — that mapping is what scripts read",
  );
  // Stem again: "Requires a human to implement" carries the same narrowing
  // with the noun gone.
  assert.doesNotMatch(
    r,
    /implement/i,
    "the ready-for-human gloss is back to requiring human implementation — `skills/fleet/skills/run-team/SKILL.md` also routes work needing a human BEFORE implementation here",
  );
});
