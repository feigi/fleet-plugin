// #836. `docs/agents/triage-labels.md`'s Meaning column is a TRANSCRIPT of the
// tracker's own label descriptions — three of the five cells were byte-identical
// to `gh api repos/feigi/claude-config/labels/<name> --jq .description` when this
// was written. A transcript has no owner, so it drifts against whichever side
// moves. ADR 0001 repriced the filing bar to "is the defect confirmed"; the
// `ready-for-agent` cell kept saying "Fully specified", which a remedy-open
// ticket is by construction not.
//
// The fix was to strip the criterion rather than restate it, so what needs
// guarding is a RE-ADDITION, and its vector is named and still live: the
// `ready-for-agent` description on the tracker still carries the old wording,
// and anyone re-syncing this column from it puts the contradiction back.
//
// #836 raises the `ready-for-agent` cell alone. The `ready-for-human` pin below
// is an ADDITION, made under the ticket's own acceptance criterion that "the
// other four rows are checked for the same drift while the file is open". That
// check found the same narrowing in `ready-for-human` and nothing to correct in
// the other three. Its vector is not the re-sync above — the tracker's own
// `ready-for-human` description does not narrow to implementation — so what is
// pinned there is the narrowing itself.
//
// CEILING: each test pins one row slice, on three things — the role-to-label-
// string mapping, that the gloss still turns on whether an AFK agent can take
// the work, and the absence of the restated criterion. The middle one is what
// stops the negative passing on an emptied cell; the label-string companion
// alone does not, because it pins columns the gloss is not in. None of this
// proves the column carries no OTHER restated criterion — no assertion can. The
// bound is the file's own stated job at `:3`, which "maps those roles to the
// actual label strings": a mapping, not a criteria source.
//
// Measured as of this commit, on a copy of the tree with `cp` restore after
// each: seven mutations — the old description re-synced verbatim, the criterion
// re-added with two words wedged into the adjacency, `ready-for-human` narrowed
// back to implementation, that same narrowing with the noun gone, the
// label-string mapping broken, and each gloss cell emptied out entirely — each
// reddened its own pin and no other. Controls: a benign reword of either pinned
// cell, an unpinned row's cell rewritten, and the table re-padded to a wider
// column all stayed green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const TABLE = readFileSync(join(REPO, "docs", "agents", "triage-labels.md"), "utf8");

// One table row per slice. The claim is a single cell, so anything wider lets
// a neighbouring row satisfy the assertion with the cell rewritten.
const row = (label) => between(TABLE, `| \`${label}\``, "\n|", `the ${label} row`);

test("the ready-for-agent row maps the role and states no filing criterion", () => {
  const r = row("ready-for-agent");
  assert.match(
    r,
    phrase("| `ready-for-agent` | `ready-for-agent` |"),
    "the ready-for-agent row no longer maps the role to its label string — that mapping is what scripts read",
  );
  // The gloss itself, which the mapping companion above does not cover: it pins
  // columns 1 and 2, so emptying column 3 leaves it green and the negative
  // below then passes on nothing at all.
  assert.match(
    r,
    /AFK agent/,
    "the ready-for-agent gloss no longer says who the label routes work to, so the negative below is passing on an empty cell",
  );
  // The stem, not the phrase. A negative pinned to the adjacency is trivially
  // evaded — measured: `/[Ff]ully\s+\w*\s*specified/` stayed green against
  // "Ready for a fully and precisely specified AFK agent", because a one-word
  // gap does not span two. A one-row gloss cell has no innocent use of the stem.
  assert.doesNotMatch(
    r,
    /specifi/i,
    "the ready-for-agent gloss is back to promising a fully specified ticket, which the filing bar in `commands/review-and-fix.md` step 5 contradicts — a confirmed defect files here with its remedy still open",
  );
});

test("the ready-for-human row does not narrow the role to implementation", () => {
  const r = row("ready-for-human");
  assert.match(
    r,
    phrase("| `ready-for-human` | `ready-for-human` |"),
    "the ready-for-human row no longer maps the role to its label string — that mapping is what scripts read",
  );
  assert.match(
    r,
    /AFK agent/,
    "the ready-for-human gloss no longer says who the label routes work to, so the negative below is passing on an empty cell",
  );
  // Stem again: "Requires a human to implement" carries the same narrowing
  // with the noun gone.
  assert.doesNotMatch(
    r,
    /implement/i,
    "the ready-for-human gloss is back to requiring human implementation — `skills/run-team/SKILL.md` also routes work needing a human BEFORE implementation here",
  );
});
