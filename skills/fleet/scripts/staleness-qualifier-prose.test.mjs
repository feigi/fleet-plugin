// #196. `review-and-fix.md` step 6 and `run-team/SKILL.md`'s finisher-dispatch
// condition are twins: each tells whoever applies `ready-to-merge` that a
// `skipped` heavy job does not block the label. The #182 dedup pass dropped
// `behind-count` from the reviewer-side copy alone, leaving "a `skipped` heavy
// job is staleness" — which names no cause, so the sentence no longer says
// WHICH staleness is the benign one. `skipped` off a non-zero behind-count is;
// a heavy job skipped for any other reason is an unverified suite, and this is
// the clause standing between that and a label.
//
// The drift was one-sided and silent — `board.mjs` and
// `references/ci-and-staleness.md` both still named the behind-count, and no
// assertion in this suite compared the two documents, so only a reader holding
// both open could see it. That is what this file is for.
//
// THE CEILING: this pins the qualifier on the shared clause and nothing else —
// not the rest of either sentence, not that the surrounding rule is right. Both
// documents word the clause identically today, so one phrase covers both; that
// is a fact about the current text, not a constraint, and a deliberate reword
// reddens this. Re-anchor the phrase here when that happens, rather than
// dropping the qualifier a second time.
//
// Reflow-safe by construction: `phrase()` joins the words on `\s+`, so
// SKILL.md (hard-wrapped ~80 cols) and review-and-fix.md (one long line per
// numbered step) take the identical regex, and a rewrap of either is a no-op.
// Measured: each of the clause's six inter-word gaps broken on its own, and all
// six broken at once, still match, and both containing paragraphs rewrapped at
// 60-400 cols stay green. The one break that defeats it falls INSIDE
// `behind-count` (Python `textwrap` at width 40 hyphen-breaks it into
// `behind-` / `count`), which no Markdown wrapper does — and loosening the token
// to admit it would let `behind- count` read as the qualifier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");

const phrase = (s) => new RegExp(s.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));

const CLAUSE = "a `skipped` heavy job is behind-count staleness";

const DOCS = [
  ["skills/fleet/commands/review-and-fix.md", read("skills", "fleet", "commands", "review-and-fix.md")],
  ["skills/fleet/skills/run-team/SKILL.md", read("skills", "fleet", "skills", "run-team", "SKILL.md")],
];

for (const [name, text] of DOCS) {
  test(`${name} qualifies the benign \`skipped\` heavy job as behind-count staleness`, () => {
    assert.match(
      text,
      phrase(CLAUSE),
      `${name} no longer says "${CLAUSE}". Bare "staleness" names no cause, and its twin document still names one — that one-sided drop is exactly #196. Restore the qualifier; if the clause was reworded on purpose, re-anchor CLAUSE in this file to the new wording in BOTH documents at once.`,
    );
  });
}
