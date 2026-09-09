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
