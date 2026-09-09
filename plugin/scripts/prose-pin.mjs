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
// so a shared prose module is out of reach there; #1361's `review-pr.js`
// `resumeFor` cross-reference is the first instance) does not begin with its
// harness token until the comment gutter is stripped. Third gutter shape,
// same reason as the other two: only whole-line `//` comments are stripped
// (mirrors `stripComments.mjs`'s own line-based-on-purpose note) — a
// trailing `code; // CLAUDE: ...` is not a marked line, it is code with a
// trailing note, and stripping mid-line would blur that distinction.
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
// matches Claude's own generic "agent" noun (ADR 0004's own caution: the
// Workflow-script builtin `agent(` in `review-pr.js` is never omp's `eval`
// helper by spelling alone) or omp's `agent()` tool call spelled without
// trailing paren. Every entry matches a CODE SPAN opener (`` ` `` immediately
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
// token and asserts the throw.
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
