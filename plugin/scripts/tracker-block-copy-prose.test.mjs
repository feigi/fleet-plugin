// #374. `docs/agents/issue-tracker.md` reproduces the implementer issue-read
// block — since #1804 carried by the body of `agents/fleet-implementer.agent.md`
// (spec 2026-09-24 § 2 Decision 2), which each harness injects as the member's
// system prompt; before that, by a `>` quote block in `run-team/SKILL.md`'s
// phase 2 — and the copy has fallen behind that block
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
// comparison. That remedy is now MEASURED green: #1004 found that rewording the
// block's last sentence in both files still reddened the growth assertion,
// because the reword invalidated a hard-coded copy of that sentence kept here
// as a fixture — a red that named growth for an edit that was not growth. Every
// fixture below is now derived from the live block instead, so the prescribed
// remedy reddens nothing.
//
// A rewrap is not an edit either: both slices are whitespace-normalized, and
// "a rewrapped copy still matches" below is what holds that open.
//
// NOR IS AN EMPHASIS MOVE, on the anchors. Narrowing a `**` span within the
// sentence this file anchors the far end of its slice on — `**Re-derive the
// ticket's claims** against ...`, same words, same order, same meaning —
// reddened all FOUR tests here, with a message about a stale end anchor
// (#1004, measured at two refs). Anchors are therefore matched against a view
// with `**` removed. The COMPARED SLICES keep every byte: this file compares
// one file's block against another file's copy of it, so emphasis appearing on
// one side only is real drift and still reddens. That is the one place this
// file deliberately diverges from `dispatch-block-pins-prose.test.mjs`, which
// strips `**` outright — it pins content against a single file, so it has no
// second side to disagree with and nothing to lose by stripping.
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
// and passes here, however the fixtures are obtained. No fixture change reaches
// that, and deriving them did not: the content pins in
// `dispatch-block-pins-prose.test.mjs` are what catch an identical gutting of
// both files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paragraph, unemphasized } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
// The body alone — everything after the frontmatter's closing `---`. Named
// SKILL for the history above: this was run-team/SKILL.md's phase 2 until #1804.
const SKILL = read("agents", "fleet-implementer.agent.md").split("---").slice(2).join("---");
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const TRACKER = readFileSync(join(REPO_ROOT, "docs", "agents", "issue-tracker.md"), "utf8");

// Names the block by its opening clause. Semantic, and the one clause both
// files must share for either to be the block at all.
const OPENER = "Read the issue with `gh issue view <N>";
const SKILL_END = /^Re-derive the ticket's claims against/;
const TRACKER_END = /^#/;

// Imported from `prose-pin.mjs` — anchor matching only, never the compared
// text. See the header for why the two differ. Written without `**` on both
// sides of the test so an anchor that someone later types WITH the markers
// still matches, and so the anchors above read as the sentences they name
// rather than as markup. `skillBlock`/`trackerBlock` below opt the same
// helper into `quoteBlock`/`paragraph`'s own anchor matching, so an opener
// move like this one does not stop at those two fixtures while `block`
// itself stays green (#1004, measured — see the comment above them).

// The far end of the slice is anchored on the first thing that is NOT this
// rule, and never on the block's own last sentence. A closing-phrase anchor
// stops the slice at today's last sentence, so a sentence appended after it
// falls outside BOTH slices and the pin passes with the copy already behind.
// The paragraph break is that same mistake one level up, and it shipped: #374's
// review appended a whole new `>` paragraph beside the block in run-team only
// and every test here stayed green while the tracker was genuinely behind.
// Anchoring past the rule instead puts growth of any size — sentence or
// paragraph — INSIDE the slice, where the equality pin sees it.
//
// WHY THIS IS NOT `quoteBlock`, which #1002 added for exactly this shape of
// job. `quoteBlock` bounds a block at its own maximal run of `>` lines, and
// growth arriving as a blank-line-separated `>` paragraph beside the block is a
// SEPARATE run. Measured on this file's own fixtures: a `>`-joined growth
// paragraph lands inside `quoteBlock`'s return, a blank-line-separated one does
// not — and the blank-line shape is the one #374's review actually shipped, and
// the one the anchor above catches. So a one-block bound (`quoteBlock` until
// #1804, `paragraph` since the block became plain prose in the agent body) is
// used below for the FIXTURES, where a bound that is exactly one block is what
// is wanted, and the slice keeps this broader bound, which is strictly wider.
//
// The two anchors differ because the two files hold the block differently: in
// the tracker it owns a `##` section, so the next heading ends it; in the
// agent body (run-team until #1804) it is one blockquote rule among siblings, so the rule that follows it does.
// Both are SEMANTIC, like the opener, and both are guarded below — an anchor
// that goes stale reddens loudly rather than silently widening the slice.
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
function block(text, what, end) {
  const paragraphs = text
    .split("\n")
    .map((l) => l.replace(/^>\s?/, ""))
    .join("\n")
    .split(/\n\s*\n/)
    // Whitespace-normalized for the reason `prose-pin.mjs`'s `phrase()` is:
    // these two files hard-wrap the same prose at different widths TODAY, so
    // without this the pin refuses the copy it is supposed to accept.
    .map((p) => p.split(/\s+/).join(" ").trim())
    .filter((p) => p);
  // Exactly one, not the first: a second paragraph opening the same way is a
  // second copy, and `find` would compare one of them and leave the other free
  // to say anything.
  const hits = paragraphs.filter((p) => unemphasized(p).startsWith(unemphasized(OPENER)));
  assert.equal(hits.length, 1, `${what}: expected exactly one paragraph opening "${OPENER}", found ${hits.length} — update this test`);
  const rest = paragraphs.slice(paragraphs.indexOf(hits[0]) + 1);
  // Guarded, or a stale end anchor runs the slice to EOF and swallows the whole
  // rest of the file: still red, but red about the wrong thing.
  const stop = rest.findIndex((p) => end.test(unemphasized(p)));
  assert.notEqual(stop, -1, `${what}: nothing after the block matches ${end} — the end anchor is stale, update this test`);
  const slice = [hits[0], ...rest.slice(0, stop)];
  // Positive control. Both slices coming back empty is how an equality pin
  // passes while asserting nothing, and a stale anchor is how they would get
  // there; the check above only proves the paragraph STARTS somewhere.
  assert.ok(hits[0].length > OPENER.length, `${what}: the block slice is no longer than its opener — the extractor is broken, not the docs`);
  return slice.join("\n");
}

const source = (text = SKILL) => block(text, "agents/fleet-implementer.agent.md", SKILL_END);
const copy = (text = TRACKER) => block(text, "docs/agents/issue-tracker.md", TRACKER_END);

// Each side's own raw bytes, for the fixtures below to mutate. Both throw,
// naming the block, if it is gone, doubled or re-anchored — which is the
// staleness guard a hard-coded copy of the prose needed and could not have,
// and unlike that copy, this one names the actual cause.
//
// `paragraph` bounds the agent body's side at the block's own blank line, so a
// fixture built from it cannot run past the block's end onto the next block.
// That is not hypothetical tidiness: a sibling rewrap fixture in
// `dispatch-block-pins-prose.test.mjs` ran one line past its block, spliced two
// blocks onto one line, and left its own staleness guard vacuous (#1003).
//
// `emphasisTolerant: true` on both: OPENER carries no `**`, and `block` above
// already tolerates a `**` landing on its words via `unemphasized`. Without
// this, the same emphasis move throws HERE instead — `quoteBlock`/`anchorAt`
// matched the raw byte here, not the unemphasized view, so a fixture-locating
// anchor this file never meant to be emphasis-sensitive went stale on an edit
// `block` itself shrugs off (#1004, measured: `**Read the issue**` reddened
// both fixture-based tests below, not just this one, with a stale-anchor
// message rather than the growth or reflow they are meant to catch).
// The agent body carries the block as plain prose, like the tracker, so its
// bound is the paragraph too — no `>` run to bound it since #1804.
const skillBlock = () => paragraph(SKILL, OPENER, "the implementer body's issue-read block", { emphasisTolerant: true });
// The tracker's copy is plain prose in a `##` section, not a quote run, so its
// bound is the paragraph — `prose-pin.mjs`'s single definition of that bound,
// blank-line-terminated and anchored exactly once.
const trackerBlock = () => paragraph(TRACKER, OPENER, "the tracker's copy of the issue-read block", { emphasisTolerant: true });

// Gutter off, whitespace collapsed — the shape wrap width cannot change, used
// below to prove a rewrap moved the breaks and nothing else.
const flat = (s) =>
  s
    .split("\n")
    .map((l) => l.replace(/^>\s?/, ""))
    .join(" ")
    .split(/\s+/)
    .join(" ")
    .trim();

// Re-wraps at word boundaries and nowhere else, at a width the file does not
// use, so the accept case is exercised at wrap points the tree does not
// currently contain. Never splits a word, so the words and their order are
// invariant — which is what makes the equality check on `flat` below a real
// guard against a corrupt fixture rather than a restatement of the wrap.
const rewrapOne = (text, width, gutter) => {
  const lines = [[]];
  let len = 0;
  for (const word of flat(text).split(" ")) {
    if (len && len + 1 + word.length > width) {
      lines.push([]);
      len = 0;
    }
    len += (len ? 1 : 0) + word.length;
    lines.at(-1).push(word);
  }
  return lines.map((l) => `${gutter}${l.join(" ")}`).join("\n");
};

// Per quote-paragraph, not over the whole flattened run: once the block has
// grown a blank-gutter-line paragraph beside it (the growth test below),
// `skillBlock()` returns TWO `>` paragraphs, and flattening both into one run
// before wrapping — the previous shape of this function — deletes the
// internal separator between them. The rewrapped text comes back as a single
// paragraph, `block()` re-splits the untouched copy on the blank line it
// still has, and the equality check compares a 2-paragraph copy against a
// 1-paragraph rewrap with no cause named (#1004, measured: the only red was a
// bare equality diff on "a rewrapped copy still matches"). Splitting on the
// separator line first — gutter-only, so it matches whether the gutter is
// `> ` or absent — and rejoining with that same line after wrapping each
// piece keeps every paragraph's wrap independent and the separator intact
// either way.
const rewrap = (text, width, gutter) =>
  text
    .split(/\n[ \t]*(?:>[ \t]*)?\n/)
    .map((part) => rewrapOne(part, width, gutter))
    .join(`\n${gutter.trimEnd()}\n`);

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
  //
  // Both sides, because either file can be reflowed independently and the
  // normalization that accepts one is not the one that accepts the other: the
  // source side's breaks carry a `>` gutter and the copy side's do not.
  //
  // Replacer functions, not replacement strings: `$&`, `$'` and `` $` `` are
  // interpreted in the latter, and these fixtures are whole blocks of prose
  // nobody is auditing for `$`.
  const skill = skillBlock();
  const narrowSkill = rewrap(skill, 46, "");
  assert.equal(flat(narrowSkill), flat(skill), "the source rewrap changed the block's words, not just its breaks — the fixture is corrupt, not the docs");
  assert.notEqual(narrowSkill, skill, "the source rewrap no longer changes run-team's wrapping — pick a width the file does not already use");
  assert.equal(copy(), source(SKILL.replace(skill, () => narrowSkill)));

  const tracker = trackerBlock();
  const narrowTracker = rewrap(tracker, 52, "");
  assert.equal(flat(narrowTracker), flat(tracker), "the copy rewrap changed the block's words, not just its breaks — the fixture is corrupt, not the docs");
  assert.notEqual(narrowTracker, tracker, "the copy rewrap no longer changes the tracker's wrapping — pick a width the file does not already use");
  assert.equal(copy(TRACKER.replace(tracker, () => narrowTracker)), source());
});

test("upstream growth arriving as a new paragraph beside the block reddens", () => {
  // The hole the paragraph break left, and the reason the end anchor moved past
  // the rule: growth does not have to land inside the block's last paragraph.
  // Test 1 covers the sentence-sized case; this is the same drift one size up,
  // and under the paragraph-break slice it passed.
  const skill = skillBlock();
  const grown = SKILL.replace(skill, () => `${skill}\n\nIf the ticket names a linked PR, read that PR's diff too.`);
  // Non-vacuity, and the assertion the hard-coded fixture used to stand in for:
  // the appended paragraph has to land INSIDE the source slice, or the
  // comparison below never sees the growth it is named for. Checked on the
  // slice rather than on the file, because landing in the file is what
  // `String.replace` guarantees and landing in the slice is what matters.
  assert.match(source(grown), /linked PR/, "the growth fixture landed outside the slice — the end anchor stops short of the block, update this test");
  assert.notEqual(source(grown), copy());
});
