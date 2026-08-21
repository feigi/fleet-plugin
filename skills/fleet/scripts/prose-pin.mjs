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
