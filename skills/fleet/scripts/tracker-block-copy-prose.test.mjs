// #374. `docs/agents/issue-tracker.md` reproduces the implementer issue-read
// block from `run-team/SKILL.md`, and the copy has fallen behind that block
// twice: #79 found it carrying the command and its caveat but neither rule
// saying which text wins, and #373 restored those two without the judgement
// rule that had arrived beside them upstream in the meantime.
//
// So this pins the copy COMPLETE against the source, rather than pinning any
// sentence present in it. A presence pin on the sentence #374 restores leaves
// the next sentence added upstream to drift exactly as that one did — the
// failure mode is the block GROWING, and only an end-to-end comparison sees
// growth.
//
// DESIGN, and the thing to read before deleting this test when it reddens: it
// compares the two paragraphs whole, so an edit to one side alone IS a failure,
// by construction. That is not a false positive — one wording, two files, and
// the file you did not edit is the copy that just went stale. The fix when it
// reddens is to apply the same edit to the other side, never to loosen the
// comparison. A rewrap is not an edit: both slices are whitespace-normalized,
// and "a rewrapped copy still matches" below is what holds that open.
//
// #23's `caveat-unification-prose.test.mjs` deliberately left this pair out,
// on the ground that `run-team`'s copy sits inside a verbatim subagent prompt
// written for a different audience. That holds for the SKILL files it does
// compare, which paraphrase; it does not hold here, because the tracker
// section is not a paraphrase of the block but a reproduction of it, differing
// today only in wrap width and the prompt's quote markers. Comparing whole is
// available precisely because the copy is verbatim.
//
// THE CEILING: this proves the copy AGREES with the source. It cannot prove
// either is correct — a wrong sentence written into both agrees with itself
// and passes here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const SKILL = read("skills", "fleet", "skills", "run-team", "SKILL.md");
const TRACKER = read("docs", "agents", "issue-tracker.md");

// Names the block by its opening clause. Semantic, and the one clause both
// files must share for either to be the block at all.
const OPENER = "Read the issue with `gh issue view <N>";

// The far end of the slice is found STRUCTURALLY — the paragraph break — and
// never by a closing phrase. A phrase anchor stops the slice at today's last
// sentence, so a sentence appended after it falls outside BOTH slices and the
// pin passes with the copy already behind. That is the exact drift this test
// exists to catch, so the end of the slice is the one place it cannot take the
// convenient route.
//
// Paragraphs are split, unquoted and whitespace-normalized BEFORE the opener is
// looked for, so neither end of the slice depends on where a line happens to
// break. Matching the opener against a raw line instead costs the accept case
// its point: a reflow landing inside the opener reddens on the anchor itself,
// where no amount of normalizing the slice afterwards can help. (Measured — the
// first draft of this test did exactly that.)
//
// Quote markers are stripped: they are markdown holding the block inside
// run-team's verbatim prompt, not part of the text being copied. Stripped
// before the paragraph split too, so a `>`-only separator line still closes the
// paragraph rather than joining two.
function block(text, what) {
  const paragraphs = text
    .split("\n")
    .map((l) => l.replace(/^>\s?/, ""))
    .join("\n")
    .split(/\n\s*\n/)
    // Whitespace-normalized for the reason `prose-pin.mjs`'s `phrase()` is:
    // these two files hard-wrap the same prose at different widths TODAY, so
    // without this the pin refuses the copy it is supposed to accept.
    .map((p) => p.split(/\s+/).join(" ").trim());
  // Exactly one, not the first: a second paragraph opening the same way is a
  // second copy, and `find` would compare one of them and leave the other free
  // to say anything.
  const hits = paragraphs.filter((p) => p.startsWith(OPENER));
  assert.equal(hits.length, 1, `${what}: expected exactly one paragraph opening "${OPENER}", found ${hits.length} — update this test`);
  // Positive control. Both slices coming back empty is how an equality pin
  // passes while asserting nothing, and a stale anchor is how they would get
  // there; the check above only proves the paragraph STARTS somewhere.
  assert.ok(hits[0].length > OPENER.length, `${what}: the block slice is no longer than its opener — the extractor is broken, not the docs`);
  return hits[0];
}

const source = () => block(SKILL, "run-team/SKILL.md");
const copy = () => block(TRACKER, "docs/agents/issue-tracker.md");

test("the tracker's copy of the issue-read block carries the block whole", () => {
  // Equality, not containment: every stale copy this section has produced has
  // been a strict PREFIX of the block, and `includes()` accepts a prefix.
  assert.equal(copy(), source());
});

test("a copy that stops short of the block's end reddens", () => {
  // The refuse direction, built as a prefix because that is the shape the drift
  // has actually taken twice. Derived from the live copy rather than quoting a
  // sentence, so it still shortens a block that has grown since.
  const short = copy().slice(0, copy().lastIndexOf(". ") + 1);
  assert.notEqual(short, copy(), "the truncation fixture no longer shortens the copy — update it");
  assert.notEqual(short, source());
});

test("a rewrapped copy still matches", () => {
  // The accept direction. Feeding the comparison prose it MUST accept is the
  // only thing pinning reflow-safety; a suite of already-matching inputs passes
  // with the normalization deleted. Re-wrapping a doc is not drift, and a pin
  // that reddened on it would be deleted by the next person who reflowed a
  // paragraph.
  const rewrapped = TRACKER.replace(OPENER, OPENER.replace(" ", "\n   "));
  assert.notEqual(rewrapped, TRACKER, "the rewrap fixture no longer matches the tracker — update it");
  assert.equal(block(rewrapped, "rewrapped tracker"), source());
});
