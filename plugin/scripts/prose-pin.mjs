import assert from "node:assert/strict";

// How many times `needle` occurs in `haystack`, overlaps included — two
// overlapping hits are two places a slice could start, which is exactly the
// ambiguity the caller below refuses. A count, not the offsets: the caller
// needs only "more than one" and the number to say so with. Cursor-bounded
// rather than chained off the previous hit, so an anchor that strips to ""
// terminates instead of spinning on `indexOf("", i)`'s clamped return.
function occurrenceCount(haystack, needle) {
  let n = 0;
  for (let i = 0; i <= haystack.length; ) {
    const hit = haystack.indexOf(needle, i);
    if (hit === -1) break;
    n += 1;
    i = hit + 1;
  }
  return n;
}

// Bound at BOTH ends: an unbounded end lets a later, unrelated occurrence of the
// same phrase satisfy the assertion with the real clause deleted.
//
// `emphasisTolerant` mirrors the option `anchorAt` and `quoteBlock` already
// carry — same name, same default of off — and reuses their `unemphasized`/
// `rawOffset` pair rather than carrying a second stripper. On, BOTH the anchors
// and the document are read through `unemphasized`, so `**` may be removed,
// added, narrowed, widened, or moved to another word boundary anywhere inside
// an anchor without moving the slice. Stripping the ANCHOR too is what
// `anchorAt`'s own tolerant mode does not do, and is the direction this family
// needs: its anchors are typed WITH `**` when the source is, so a document that
// loses the emphasis is the common break.
//
// BOTH anchors must then resolve EXACTLY ONCE when tolerant — the standard
// `anchorAt` and `quoteBlock` already hold for their one anchor, and the price
// of tolerance here, paid at both ends alike (`occurrenceCount` below is
// shared by both guards). Stripping `**` can only ADD matches to a search over
// the stripped view, never remove one the literal anchor had, so a tolerant
// anchor can resolve somewhere the literal one never could: on a text-identical
// phrase sitting in a different emphasis state elsewhere in the document, or —
// when an anchor literal itself carries a `*` run that does not collapse to a
// clean `**`-pair count — on a shorter, less specific phrase the literal anchor
// never matched at all, which can make a tolerant match genuinely WIDER than
// the literal one, not merely earlier. Either direction is invisible to every
// assertion inside the slice: at the START, the pinned words are all present,
// sourced from the wrong copy; at the END, a slice that lands short silently
// DELETES content, which can flip a `doesNotMatch` pin from correctly RED to
// falsely GREEN — the same false-green class a wrong START does, just reached
// from the other side. Both throw instead, for the reason a missing anchor
// throws rather than widening to the whole file.
//
// Only the TOLERANT path pays that price. The literal path's END anchor keeps
// first-hit-after-the-start and stays non-unique ON PURPOSE — an end bound's
// job there is to be the next one, not the only one — and two of this
// directory's real end anchors depend on exactly that:
// `snapshot-runner-audience-prose.test.mjs`'s `"\n- **"` means "wherever the
// next bullet starts", and `instrument-check-prose.test.mjs`'s `"**Exit 0 is
// the only code"` names a sentence `run-team/SKILL.md` states twice, once bold
// and once inside a blockquote. Neither callsite turns `emphasisTolerant` on,
// so the guard above never sees them; an exactly-once literal-mode end bound
// would refuse both while preventing no widening that exists today.
//
// Matching stays a literal `indexOf` over the stripped view, NOT `phrase()` as
// `anchorAt` uses: #1492's own ticket measured that trade. `phrase()` is
// `s.trim().split(/\s+/)`, which discards a leading newline — and `between`
// anchors carry load-bearing ones, e.g. `fix-applier-correction-rules-prose
// .test.mjs`'s `PROMPT_END`, `"\n**Put the standing CI facts"`: the leading
// `\n` is what ties that anchor to the phrase's own line start rather than to
// any mid-line occurrence of the same words. `phrase()`'s `.trim()` would
// strip that newline before matching, silently loosening the anchor. A
// tolerant mode built on `phrase()` would trade this family's false reds for
// that false green. Emphasis tolerance and whitespace tolerance are separate
// axes; this option moves only the first.
//
// The returned slice is raw bytes with `**` intact — `rawOffset` maps each
// endpoint back and stops BEFORE the marker, so a tolerant slice keeps the
// emphasis its caller goes on to compare.
export function between(text, from, to, what, { emphasisTolerant = false } = {}) {
  const haystack = emphasisTolerant ? unemphasized(text) : text;
  const start = emphasisTolerant ? unemphasized(from) : from;
  const stop = emphasisTolerant ? unemphasized(to) : to;
  const at = haystack.indexOf(start);
  assert.notEqual(at, -1, `${what} no longer contains "${from}" — update this test`);
  if (emphasisTolerant) {
    const hits = occurrenceCount(haystack, start);
    assert.equal(
      hits,
      1,
      `${what}: emphasis-tolerant slice anchor "${from}" occurs ${hits} times once \`**\` is ignored — the slice would start at the first and pull in what the literal anchor excluded; narrow the anchor or drop emphasisTolerant`,
    );
  }
  const searchFrom = at + start.length;
  const end = haystack.indexOf(stop, searchFrom);
  assert.notEqual(end, -1, `${what} no longer contains "${to}" after "${from}" — update this test`);
  if (emphasisTolerant) {
    const hits = occurrenceCount(haystack.slice(searchFrom), stop);
    assert.equal(
      hits,
      1,
      `${what}: emphasis-tolerant slice end anchor "${to}" occurs ${hits} times after the start once \`**\` is ignored — the slice would end at the first and could drop or admit content the literal anchor did not; narrow the anchor or drop emphasisTolerant`,
    );
  }
  return emphasisTolerant ? text.slice(rawOffset(text, at), rawOffset(text, end)) : text.slice(at, end);
}

// `\s+` between every word, never a literal space — prose this matches against
// is often hard-wrapped, so any inter-word space in the source may be a
// newline plus indent. Regex metacharacters in the phrase are escaped first.
export const phrase = (s) => new RegExp(s.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));

// The paragraph carrying a rule, and no more of the document than that. A
// positive regex matched over a whole file is satisfiable from OUTSIDE the
// clause it guards — a stray copy of the wording left anywhere else buys the
// pass — so a prose pin's slice bound is the pin, and the regex is the easy
// half. Ends at the blank line, because a paragraph boundary is the one
// bound a rewrap cannot move; the ANCHOR goes through `phrase()` for the
// mirror-image reason, since `between`'s literal `indexOf` would break on a
// rewrap the pinned clause itself survives, turning a reflow into a red.
// A missing anchor throws rather than widening: silently falling back to the
// whole document is the false green this bound exists to prevent.
//
// The blank line is matched as `\n[ \t]*\n`, never the literal `\n\n`: an
// editor that keeps a list item's indent on the line between two paragraphs
// writes `\n   \n`, which a literal search does not see — the slice then
// widens silently into the next paragraph, and a decoy there buys the green
// this bound exists to deny. No `*.md` in this repo carries a whitespace-only
// line today and nothing enforces that — no `.editorconfig`, no prettier or
// markdownlint config, no CI check — and every paragraph pinned so far is
// indented list content, which is exactly where an editor produces that shape.
//
// The anchor must match EXACTLY ONCE — see `anchorAt`, which holds that half.
//
// The single definition of a paragraph bound in this directory. It was
// extracted (#823) while pins elsewhere still hand-rolled this same
// search-to-blank-line slicer locally, every copy carrying both false greens
// above by construction; #1372 migrated them onto it. A pin needing this bound
// imports it — a local copy is the defect, not a style choice.
export function paragraph(text, anchor, what, options) {
  const rest = text.slice(anchorAt(text, anchor, what, options));
  const end = rest.search(/\n[ \t]*\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

// Anchor matching only — never the compared text, so a caller that turns this
// on still returns raw bytes with emphasis intact. Exported so a pin comparing
// two files' copies of the same block (`**` moving on one side is real drift)
// does not hand-roll a second definition to locate the block it is comparing.
export const unemphasized = (s) => s.replace(/\*\*/g, "");

// Maps an offset found in `unemphasized(text)` back to `text`, stopping before
// any `**` at that point rather than after it — so a slice starting there
// keeps the marker instead of silently dropping it from the raw bytes a
// caller goes on to compare or substring-replace.
function rawOffset(text, unemphasizedOffset) {
  let seen = 0;
  let i = 0;
  while (seen < unemphasizedOffset) {
    if (text.startsWith("**", i)) i += 2;
    else {
      seen += 1;
      i += 1;
    }
  }
  return i;
}

// The offset of an anchor that must occur EXACTLY ONCE, mirroring `markedLine`'s
// own count assert for the same reason: a search takes the FIRST match silently,
// so an un-gutter'd restatement of the anchored block ABOVE the real one — the
// shape this repo's prose already uses where a phase quotes a member prompt back
// at itself — binds the pin to the copy while the real rule is gutted. A
// blockquoted copy is harmless (`\s+` cannot span the `>` gutter); a plain one is
// not. A missing anchor throws rather than widening, for `paragraph`'s reason.
//
// Split out of `paragraph` rather than left inside it because a slice whose END
// bound is not a blank line needs the same guarantee and must not copy it: the
// source site in `quiet-payload-prose.test.mjs` anchors on a declaration and
// takes the `//` comment block ABOVE it, bounded by code at both ends.
// `emphasisTolerant` is opt-in and off by default: most anchors here are
// typed WITH `**` when the source is (see e.g. `ancestry-check-position-prose
// .test.mjs`), so matching against `unemphasized(text)` unconditionally would
// break every anchor that itself carries emphasis. On, it lets an anchor
// typed WITHOUT `**` still find its target after a meaning-preserving
// emphasis move on the matched words — measured need in
// `tracker-block-copy-prose.test.mjs`, where the opener anchor has none.
export function anchorAt(text, anchor, what, { emphasisTolerant = false } = {}) {
  const haystack = emphasisTolerant ? unemphasized(text) : text;
  const hits = [...haystack.matchAll(new RegExp(phrase(anchor).source, "g"))];
  assert.notEqual(hits.length, 0, `${what}: slice anchor "${anchor}" moved — re-anchor this test, never widen it to the whole file`);
  assert.equal(hits.length, 1, `${what}: slice anchor "${anchor}" occurs ${hits.length} times — a pin would bind the wrong copy; narrow the anchor`);
  return emphasisTolerant ? rawOffset(text, hits[0].index) : hits[0].index;
}

// A shell comment block wraps at `#`, so a pinned phrase can break across lines
// with the comment gutter, not whitespace, at the break — `\s+` does not span a
// `#`. Strip the gutter and rejoin with the single inter-word space a wrap point
// replaces.
export const stripHashGutter = (text) => text.split("\n").map((l) => l.replace(/^\s*#\s?/, "")).join(" ");

// A markdown blockquote wraps every line in a leading `>` gutter, so a
// dispatch instruction embedded inside a quoted prompt (#1341's grandchild
// recipe, nested under run-team's fix-applier prompt) does not begin with its
// harness token until the gutter is stripped. Mirrors stripHashGutter's
// reason for existing, one gutter shape later.
export const stripQuoteGutter = (text) => text.split("\n").map((l) => l.replace(/^\s*>+\s?/, "")).join("\n");

// One verbatim dispatch block, bounded by its OWN quote run rather than by the
// next block's opening words, and returned with the gutter intact so the caller
// owns the normalization. #1002: a whole-block golden fixture needs a slice that
// is exactly one block, and the neighbour-anchored form every presence pin in
// this directory uses is not one. Measured on `run-team/SKILL.md`:
// `dispatch-block-pins-prose.test.mjs`'s `commitBlock` runs from `Commit
// incrementally` to `**Every scratch file` and so already contains the whole
// stash-prohibition block that landed between them, and its `worktreeBlock`
// likewise contains the distilled-brief block. Both slices silently grew a
// second block, which a presence pin never notices and a golden could not
// survive: the fixture would be "this block plus whatever lands after it", and
// re-blessing it would bless the insertion too.
//
// A maximal run of `>` lines is the bound markdown itself uses, so it cannot
// drift: a sentence appended inside the block stays inside the run, and a block
// spliced in after it is a SEPARATE run — which is what makes "every run in the
// region has a fixture" a check a caller can make at all.
//
// Column-0 `>` only, matching how every pin in this directory already strips
// this gutter (`/^>\s?/`) and how `member-prompt-prose.test.mjs` asserts every
// member-facing line carries one. An indented gutter is not silently absorbed
// here: it ends the run, so the block reds against its fixture instead of
// passing under a changed markdown context.
export function quoteBlocks(text) {
  const runs = [];
  let open = null;
  for (const line of text.split("\n")) {
    if (line.startsWith(">")) (open ??= []).push(line);
    else if (open) {
      runs.push(open.join("\n"));
      open = null;
    }
  }
  if (open) runs.push(open.join("\n"));
  return runs;
}

// The one quote run that BEGINS with `opener`, for a caller comparing that run
// against a golden copy. Both failure directions throw rather than return, for
// the reason a golden makes sharper than a presence pin does: an extractor that
// returns "" for a block it cannot find compares empty against empty — or
// against a fixture nobody re-blessed — and a deleted block passes.
//
// Anchored at the run's START, not anywhere inside it, so the identifier names
// the block rather than merely occurring in it: a later block quoting the same
// opening words cannot answer to it. Matched through `phrase()` on the
// flattened run for `paragraph`'s reason — a literal `indexOf` reds on a rewrap
// that the opener itself survives, turning a reflow into a red.
// `emphasisTolerant` mirrors `anchorAt`'s option and for the same reason: off
// by default because an opener typed WITH `**` must still match one, on so an
// opener typed WITHOUT it can find a target whose emphasis moved. Safe to
// apply only to the match, never to `hits[0]` itself — the returned run keeps
// its `**` intact, since that is the raw byte content callers go on to
// compare or rewrap.
export function quoteBlock(text, opener, what, { emphasisTolerant = false } = {}) {
  const head = new RegExp(`^${phrase(opener).source}`);
  const view = emphasisTolerant ? unemphasized : (s) => s;
  const hits = quoteBlocks(text).filter((run) =>
    head.test(view(run.split("\n").map((l) => l.replace(/^>[ \t]?/, "")).join(" ").split(/\s+/).join(" ").trim())),
  );
  assert.notEqual(
    hits.length,
    0,
    `${what}: no quote block opens on "${opener}" — the block was deleted, un-quoted, or its opening words changed. Re-anchor or restore it; this throws rather than comparing a golden fixture against nothing`,
  );
  assert.equal(
    hits.length,
    1,
    `${what}: ${hits.length} quote blocks open on "${opener}" — a fixture would bind to whichever came first; narrow the opener`,
  );
  return hits[0];
}

// A `.js` line comment wraps at `// `, so a marked pair embedded as a
// documentary comment (workflows/*.js — a Workflow script cannot `import`,
// so a shared prose module is out of reach there) does not begin with its
// harness token until the comment gutter is stripped. Third gutter shape,
// same reason as the other two: only whole-line `//` comments are stripped
// (mirrors `stripComments.mjs`'s own line-based-on-purpose note) — a
// trailing `code; // CLAUDE: ...` is not a marked line, it is code with a
// trailing note, and stripping mid-line would blur that distinction. No
// real `// `-gutter pair exists yet: #1361's `review-pr.js` `resumeFor`
// cross-reference — the first `.js` marked pair — is two BARE lines (no
// gutter at all) inside a `/* ... */` block comment, which this function
// never touches and does not need to; it is scanned correctly because the
// marker is already the line's first token. This function is here for the
// `//`-prefixed shape when one lands, not because one has.
export const stripSlashGutter = (text) => text.split("\n").map((l) => l.replace(/^\s*\/\/\s?/, "")).join("\n");

// The dialect-token table CONTEXT.md § Dialect and #1299's ruling both name:
// tool names (`SendMessage`/`Agent`/`Workflow`/`subagent_type` on Claude,
// `hub`/`task`/`eval`/`agent(` on omp). Anchored on a LEADING BACKTICK, not a
// bare `\b` word, because this repo's prose always code-quotes a tool name
// when naming it, and the bare English words collide with real prose:
// member-lifecycle.md's own CLAUDE line says "the temptation to re-task
// peaks exactly when it cannot work" — a bare `\btask\b` matches inside
// "re-task" — and "send" is ordinary English ("a bare send") on the same
// line as `SendMessage`. `agent(` requires the open paren so it never
// matches omp's `agent()` tool call spelled without trailing paren — but
// spelling ALONE does not separate it from Claude's own Workflow-script
// builtin `agent(` inside `review-pr.js` (ADR 0004's own caution, measured
// true by Review1363: the bare regex false-positives on a synthetic
// Claude-line-shaped string naming that builtin). The spelling collision is
// real; what closes it is `marked-pairs.mjs`'s `normalizeDialect`/
// `foreignTokens` disabling this entry's omp side specifically inside
// `workflows/*.js`, where the ambiguity lives — this table has no file
// context of its own, so the disambiguation is the caller's job, not this
// regex's. Every entry matches a CODE SPAN opener (`` ` `` immediately
// before the token), so `normalizeDialect` (marked-pairs.mjs) can widen a hit
// to its whole enclosing span.
export const DIALECT_TOKENS = [
  { name: "dispatch tool", claude: /`Agent\b/, omp: /`task\b/ },
  { name: "send/wake channel", claude: /`SendMessage\b/, omp: /`hub\b/ },
  { name: "workflow-script tool", claude: /`Workflow\b/, omp: /`eval\b/ },
  { name: "dispatch field", claude: /`subagent_type\b/, omp: /`agent\(/ },
];

// A Marked line (CONTEXT.md § Dialect) is `CLAUDE: ` or `OMP: ` as the
// line's first token, once any comment/quote gutter is stripped — never a
// keyword search, or the divergence hazard #1299 named (a line loose enough
// to match both dialects matches neither claim) reappears one gutter later.
// Asserts exactly one such line for `label` exists, so a duplicated or
// deleted marker reds here rather than silently matching the wrong copy.
export function markedLine(text, label, what) {
  const lines = text.split("\n").filter((l) => new RegExp(`^\\s*${label}: `).test(l));
  assert.equal(lines.length, 1, `${what}: expected exactly one "${label}: " marked line, found ${lines.length}`);
  return lines[0];
}

// #1299 point 1: "a pin loose enough to match both wordings is thereby
// rejected at authoring time, not discovered at mutation time." `pairSlices`
// is that rejection. It bounds a pair's own two-line region (never a whole
// section — the same fat-slice hazard `between`'s own doc-comment warns
// about), extracts each Marked line via `markedLine`, then — before handing
// either slice back — finds each line's OWN `DIALECT_TOKENS` entry and
// asserts it does NOT also appear on the partner line. A pair authored with
// a token common to both dialects (or with no recognized token at all, which
// is the same defect: nothing to pin the line to its own harness) throws
// here, at construction, rather than shipping a pin that would pass under
// either wording — #1346's demonstration mutates a fixture pair to share one
// token and asserts the throw; each of the four guard branches is also
// unit-tested individually, here in `prose-pin.test.mjs`.
//
// NOT YET WIRED to a production consumer (Review1363's finding): the nine
// real pairs are still pinned in `member-lifecycle-dialect-prose.test.mjs`
// and `worktree-model-prose.test.mjs` through bare `markedLine` plus
// hand-rolled `doesNotMatch` regexes — precisely the per-pin, per-author
// guesswork this helper exists to replace, and precisely where the
// construction-time throw above cannot fire on an already-loose hand-rolled
// pin. Deliberately deferred rather than migrated inline here: both
// consumer files are already-merged, reviewed, mutation-tested deliverables
// of other tickets (#1341, #1344), and migrating their pins risks
// invalidating that review without a matching re-review pass. Filed as
// #1364.
export function pairSlices(text, sectionFrom, sectionTo) {
  const region = between(text, sectionFrom, sectionTo, "pairSlices region");
  const claude = markedLine(region, "CLAUDE", "pairSlices CLAUDE line");
  const omp = markedLine(region, "OMP", "pairSlices OMP line");

  let claudeToken = null;
  let ompToken = null;
  for (const token of DIALECT_TOKENS) {
    if (!claudeToken && token.claude.test(claude)) claudeToken = token;
    if (!ompToken && token.omp.test(omp)) ompToken = token;
  }
  if (!claudeToken) {
    throw new Error(`pairSlices: CLAUDE line names no recognized dialect token, so no pin on it could be bound to Claude: ${JSON.stringify(claude)}`);
  }
  if (!ompToken) {
    throw new Error(`pairSlices: OMP line names no recognized dialect token, so no pin on it could be bound to omp: ${JSON.stringify(omp)}`);
  }
  if (claudeToken.claude.test(omp)) {
    throw new Error(`pairSlices: the CLAUDE line's "${claudeToken.name}" token also matches the OMP line — a pin on it would match both dialects`);
  }
  if (ompToken.omp.test(claude)) {
    throw new Error(`pairSlices: the OMP line's "${ompToken.name}" token also matches the CLAUDE line — a pin on it would match both dialects`);
  }
  return { claude, omp };
}

// A paragraph's physical line breaks, removed. `phrase()` holds this axis for
// a pin that KNOWS the words it is looking for; this holds it for a pin that
// DERIVES its subjects from the document. Those are different problems: a
// literal you can pre-tolerate with `\s+`, but a scan like `see \*\*([^*\n]+)\*\*`
// has to keep `\n` out of its own character classes to stay one clause, and a
// generative regex cannot be made whitespace-tolerant and bounded at once.
// #1609: rewrapping `review-and-fix.md`'s step 4 — pure reflow, not one word
// changed — took that scan from 5 pointer names to 3, and the pins for the two
// it lost stopped existing rather than failing. Three separate breaks, all the
// same shape: the literal space in `see `, the literal space in the list
// separator, and `\n` excluded from the name class. Tolerating them one at a
// time in the regex is how the bound gets lost — move the WRAP, not the scan.
//
// The view, never the file: this returns a copy to scan, and `lineAt` maps a
// hit in it back to the physical line a reader has to open. A pin reporting an
// offset into the joined copy names a line that does not exist in the source.
//
// Joining only ADDS matches, so a pin cannot lose a hit to this — but `^` moves,
// and that is the point in both directions. A `**Bold**` that a wrap happens to
// push to column 0 mid-paragraph reads as block-leading to a `/^\*\*/m` scan
// today, which is the mirror false GREEN: a pointer resolving to a target the
// reflow invented. On the joined view it is mid-line again, where it belongs.
//
// What is NOT modelled: an indented (4-space) code block. Its second and later
// lines are indistinguishable from a deeply-indented list continuation without
// a real block parser, so they join and the block collapses to one line. Fenced
// code is modelled and never joined — scan code through a fence, not an indent.

// Starts a new block, so it never continues the line above.
const BLOCK_START = /^ {0,3}(?:#{1,6}\s|[-*+](?:\s|$)|\d+[.)]\s|>|\||```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
// Complete in itself, so the line below never continues IT. Narrower than
// BLOCK_START on purpose: a list item and a blockquote both take lazy
// continuation lines, a heading and a thematic break take none.
const BLOCK_END = /^ {0,3}(?:#{1,6}\s|\||```|~~~|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
// Two trailing spaces or a trailing backslash is markdown's hard line break —
// an authored break, not a wrap point, and removing it would change the render.
const HARD_BREAK = /(?:[ \t]{2}|\\)$/;

export function logicalLines(text) {
  const src = text.split("\n");
  const joins = new Array(src.length).fill(false);
  let fenced = false;
  for (let i = 0; i < src.length; i++) {
    const fence = /^ {0,3}(?:```|~~~)/.test(src[i]);
    joins[i] =
      i > 0 &&
      !fenced &&
      !fence &&
      /\S/.test(src[i - 1]) &&
      /\S/.test(src[i]) &&
      !HARD_BREAK.test(src[i - 1]) &&
      !BLOCK_END.test(src[i - 1]) &&
      !BLOCK_START.test(src[i]);
    if (fence) fenced = !fenced;
  }

  const starts = new Array(src.length);
  const out = [];
  let offset = 0;
  for (let i = 0; i < src.length; i++) {
    // A wrap point is one inter-word space, so the indent the wrap introduced
    // comes off and exactly one space goes back — `stripHashGutter`'s rejoin,
    // one gutter shape fewer. The trailing trim is why that space is never two.
    let line = joins[i] ? src[i].replace(/^[ \t]+/, "") : src[i];
    if (joins[i + 1]) line = line.replace(/[ \t]+$/, "");
    if (i > 0) {
      const sep = joins[i] ? " " : "\n";
      out.push(sep);
      offset += sep.length;
    }
    starts[i] = offset;
    out.push(line);
    offset += line.length;
  }

  // Strictly increasing — an unjoined line contributes its own `\n` and a
  // joined one is non-blank by construction — so this bisect has no ties to
  // break and an offset inside line i answers i, never i+1.
  const lineAt = (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { text: out.join(""), lineAt };
}
