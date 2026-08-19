// #677. `run-team/SKILL.md` stated what `--quiet` drops twice, 345 lines apart,
// and only one of the two was complete: the CI-Monitor paragraph named `jobs`
// and `missing`, the finisher-duty paragraph named `jobs` alone. The incomplete
// copy is the one that costs — it is the paragraph an agent reads when deciding
// whether it holds the per-job state a `ready-to-merge` label rests on, and
// `missing` is exactly the field separating "the expected job is absent" from
// "the expected job failed". `review-and-fix.md`'s twin of that same gate was
// complete throughout, so the outlier was visible only to a reader holding all
// three paragraphs open at once. That is what this file is for.
//
// THE FIELD LIST IS READ OUT OF ci-state.mjs, never restated here. `--quiet`'s
// effect on the payload is one assignment, and a field added to or renamed in
// it silently un-completes all three paragraphs at once. Deriving the list means
// that edit reddens here instead, which is the only way the three stay agreed
// with the source rather than merely with each other.
//
// TWO BOUNDS, each measured against the mutation it exists to catch, in the
// manner of `staleness-qualifier-prose.test.mjs`:
//
// - The PARAGRAPH bound. SKILL.md carries two of the three statements, so
//   matched over the whole file each is the other's false green: measured, with
//   the finisher-duty clause gutted a file-wide variant went green off the
//   CI-Monitor copy alone, and stayed green with a decoy line appended too.
// - The CLAUSE bound, from `drops` to the end of its own sentence. The
//   finisher-duty paragraph names `jobs` a second time for an unrelated reason
//   ("or its `jobs`"), so a paragraph-wide match is satisfiable from outside the
//   statement: measured, with the clause narrowed to `missing` alone a
//   paragraph-wide variant went green while this file went red.
//
// A moved anchor reddens instead of silently widening the slice back to the file.
//
// This file names its three sources by path and globs nothing, so its own text
// is not in the corpus and cannot satisfy the pins it carries.
//
// THE CEILING: this pins that each paragraph names every dropped field, and
// nothing else — not that the surrounding rule is right, not the prose around
// the clause, and it does not run ci-state.mjs (ci-state.test.mjs owns its
// behavior). It says nothing about the stderr stream `--quiet` also suppresses,
// which is a separate effect these paragraphs deliberately do not discuss. And
// it covers three paragraphs, not every statement in the repo: the script-surface
// row in `docs/specs/2026-07-23-fleet-plugin-design.md` names both fields
// correctly today and is left to the pattern its siblings already use —
// `worktree-audit.test.mjs` and `no-undo-audit.test.mjs` each check their
// script's Out cell against a real run of that script, which for ci-state.mjs
// means standing up `gh` fixtures and is not the cheap check this one is.
//
// Reflow-safe by construction: `phrase()` joins the anchor's words on `\s+`, so
// SKILL.md (hard-wrapped ~80 cols) and review-and-fix.md (one long line per
// numbered step) take the identical anchor. Measured: the finisher-duty
// paragraph rewrapped at 55 cols stays green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (p) => readFileSync(join(REPO, ...p.split("/")), "utf8");

const phrase = (s) => new RegExp(s.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));

// The one assignment `--quiet` gates the payload on. Its absence is a failure
// rather than an empty field list: an empty list would pass every site vacuously.
const CI_STATE = readFileSync(join(import.meta.dirname, "ci-state.mjs"), "utf8");
const FIELDS = ((CI_STATE.match(/if \(!quiet\) Object\.assign\(payload, \{([^}]*)\}\)/) ?? [])[1] ?? "")
  .split(",").map((f) => f.trim()).filter(Boolean);

test("the dropped-field list is still readable out of ci-state.mjs", () => {
  assert.ok(
    FIELDS.length,
    "ci-state.mjs no longer gates payload fields through `if (!quiet) Object.assign(payload, { ... })` — re-derive FIELDS here from whatever replaced it, never hard-code the list",
  );
});

// The paragraph carrying the statement, and no more of the file than that. A
// missing anchor is a failure rather than a wider slice: silently falling back
// to the whole document is the false green this bound exists to prevent.
function paragraph(name, anchor) {
  const text = read(name);
  const at = text.search(phrase(anchor));
  assert.notEqual(at, -1, `${name}: slice anchor "${anchor}" moved — re-anchor this test, never widen it to the whole file`);
  const rest = text.slice(at);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest : rest.slice(0, end);
}

// From `drops` to the end of its own sentence. The surrounding paragraphs each
// mention at least one dropped field for other reasons, so the clause bound is
// what makes a gutted statement red rather than green on its neighbours.
function dropsClause(name, anchor) {
  const clause = paragraph(name, anchor).match(/drops[^.]*/);
  assert.ok(clause, `${name}: the "${anchor}" paragraph no longer says what \`--quiet\` drops at all`);
  return clause[0];
}

const SKILL = "skills/fleet/skills/run-team/SKILL.md";
const REVIEW_AND_FIX = "skills/fleet/commands/review-and-fix.md";

const SITES = [
  [SKILL, "**Own the CI waits.**", "the CI-Monitor read"],
  [SKILL, "Gate on the `check` job", "the finisher-duty read"],
  [REVIEW_AND_FIX, "6. Diff-check green", "step 6's finisher read"],
];

for (const [name, anchor, label] of SITES) {
  test(`${name} — ${label} names every field \`--quiet\` drops`, () => {
    const clause = dropsClause(name, anchor);
    for (const field of FIELDS) {
      assert.ok(
        clause.includes(`\`${field}\``),
        `${name}: ${label} says "${clause}", which does not name \`${field}\`. ci-state.mjs drops ${FIELDS.map((f) => `\`${f}\``).join(" and ")} under \`--quiet\`, and a reader arriving at this paragraph alone has no reason to see the other statements. Name every field here, or — if ci-state.mjs's payload changed — update all three paragraphs together.`,
      );
    }
  });
}
