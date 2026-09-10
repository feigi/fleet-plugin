import assert from "node:assert/strict";

// Bound at BOTH ends: an unbounded end lets a later, unrelated occurrence of the
// same phrase satisfy the assertion with the real clause deleted.
export function between(text, from, to, what) {
  const at = text.indexOf(from);
  assert.notEqual(at, -1, `${what} no longer contains "${from}" — update this test`);
  const end = text.indexOf(to, at + from.length);
  assert.notEqual(end, -1, `${what} no longer contains "${to}" after "${from}" — update this test`);
  return text.slice(at, end);
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
export function paragraph(text, anchor, what) {
  const rest = text.slice(anchorAt(text, anchor, what));
  const end = rest.search(/\n[ \t]*\n/);
  return end === -1 ? rest : rest.slice(0, end);
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
export function anchorAt(text, anchor, what) {
  const hits = [...text.matchAll(new RegExp(phrase(anchor).source, "g"))];
  assert.notEqual(hits.length, 0, `${what}: slice anchor "${anchor}" moved — re-anchor this test, never widen it to the whole file`);
  assert.equal(hits.length, 1, `${what}: slice anchor "${anchor}" occurs ${hits.length} times — a pin would bind the wrong copy; narrow the anchor`);
  return hits[0].index;
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
