// #659. Phase 0's liveness paragraph prescribes
// `git log -S '<old string>' --oneline origin/main -- <file> | head -1` and then
// argues for the `origin/main` pin. The argument named the wrong failure mode:
// it said an unpinned search on a checkout behind the remote "prints nothing at
// exit 0", which is the symptom of the **new**-string search the paragraph
// directly above FORBIDS — not of the old-string search it prescribes.
//
// Measured on the recipe's own worked example (#206,
// `skills/next-ticket/SKILL.md`, git 2.50.1), old string
// `server-side \`--search\` + \`--jq\``, new string
// `\`--search\` narrows server-side, \`--jq\` reduces inside \`gh\``:
//
//   old @ 0dc39ef^  → `4fd2f73` at exit 0   (a WRONG commit, not empty)
//   new @ 0dc39ef^  → empty at exit 0
//   old @ 4fd2f73^  → empty at exit 0       (behind the rename as well)
//   old @ origin/main → `0dc39ef` first     (the fix — the pin working)
//
// So each symptom belongs to a different search, and the one the paragraph
// prescribes fails by naming a plausible wrong commit — which
// `git merge-base --is-ancestor` then clears exactly as well as the real fix
// (measured: exit 0 for `4fd2f73` and `0dc39ef` alike), so the ancestry gate is
// no backstop. That is strictly worse than empty output, and the clause taught
// readers to expect empty. Both halves of the attribution are pinned here
// because a correction that keeps only one of them still misattributes the
// other.
//
// SLICE SIZE anchors these, as in `staleness-qualifier-prose.test.mjs`. This
// document discusses old wording, new wording, exit-0 emptiness and `head -1`
// across several neighbouring paragraphs, so a whole-file match is satisfiable
// from outside the rule it guards: measured, with the live clause reverted to
// its #659 wording and each pinned phrase appended once as a stray line further
// down the file, an unbounded suite went green — the pass bought entirely by
// the decoy. The slice is cut to the one paragraph carrying the rule, and a
// moved anchor reddens rather than silently widening back to the file.
//
// THE CEILING: this pins the two attributions and nothing else — not the
// `--reverse` sentences that follow, not that the recipe above is right. A
// deliberate reword reddens this; re-anchor the phrase here rather than
// dropping the attribution a second time. Reflow-safe by construction:
// `phrase()` joins words on `\s+`, so a rewrap of the hard-wrapped paragraph is
// a no-op.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { phrase } from "./prose-pin.mjs";

const SKILL = "skills/run-team/SKILL.md";
const ANCHOR = "**Both halves of that command are load-bearing.**";

// The paragraph carrying the rule, and no more of the file than that. A missing
// anchor is a failure rather than a wider slice: silently falling back to the
// whole document is the false green this bound exists to prevent.
function rule() {
  const text = readFileSync(join(import.meta.dirname, "..", ...SKILL.split("/")), "utf8");
  const at = text.search(phrase(ANCHOR));
  assert.notEqual(at, -1, `${SKILL}: slice anchor "${ANCHOR}" moved — re-anchor this test, never widen it to the whole file`);
  const rest = text.slice(at);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest : rest.slice(0, end);
}

const OLD_HALF = "the prescribed **old**-string search names a *wrong* commit at exit 0";
const NEW_HALF = "the **new**-string search the paragraph above forbids that prints nothing at exit 0";

test("the liveness paragraph attributes the WRONG-COMMIT symptom to the prescribed old-string search", () => {
  assert.match(
    rule(),
    phrase(OLD_HALF),
    `${SKILL}'s "${ANCHOR}" paragraph no longer says "${OLD_HALF}". Unpinned, the search the recipe PRESCRIBES answers with a plausible wrong commit on a checkout behind the fix — measured, \`4fd2f73\` at \`0dc39ef^\` — and \`--is-ancestor\` clears it. Reading that failure as empty output is #659.`,
  );
});

test("the liveness paragraph attributes the EMPTY-OUTPUT symptom to the forbidden new-string search", () => {
  assert.match(
    rule(),
    phrase(NEW_HALF),
    `${SKILL}'s "${ANCHOR}" paragraph no longer says "${NEW_HALF}". "Prints nothing at exit 0" is the symptom of the new-string search the paragraph above forbids, never the consequence of dropping \`origin/main\` from the prescribed one — that swap is exactly #659.`,
  );
});
