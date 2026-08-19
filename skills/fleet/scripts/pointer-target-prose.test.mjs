import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #197. `review-and-fix.md` points at its own blocks by name — "see **X**" —
// and the emphasised block it names carried trailing content INSIDE the
// emphasis, so the name in the pointer was never the string on the target.
// That reads fine linearly and fails exactly one way: an agent that greps for
// the pointer string finds the pointer and nothing else, i.e. the citation
// resolves to itself. Same class as `review-pr-citation-prose.test.mjs`, one
// document inward — there the citation was a line number, here it is a name.
//
// THE CEILING: this proves every pointer NAME resolves to a distinct target,
// nothing about the target being the right block or saying the right thing. A
// pointer renamed in lockstep with its target stays green, correctly. Derived
// from the document rather than hardcoded, so a pointer added later is covered
// without editing this file — and so this file cannot satisfy its own pins.
const REPO = join(import.meta.dirname, "..", "..", "..");
const DOC = "skills/fleet/commands/review-and-fix.md";
const TEXT = readFileSync(join(REPO, DOC), "utf8");

// A pointer clause is `see` plus one or more emphasised names joined by `and`,
// `or` or a comma — `see **A** and **B** below`. Offsets are tracked because
// the pointer is itself a bold span: resolving a name against the whole file
// would let the pointer match ITSELF and pass with no target in the document.
const CLAUSE = /[Ss]ee ((?:\*\*[^*\n]+\*\*)(?:(?:,| and| or) \*\*[^*\n]+\*\*)*)/g;
const BOLD = /\*\*([^*\n]+)\*\*/g;

const lineOf = (offset) => TEXT.slice(0, offset).split("\n").length;

const pointers = [];
for (const clause of TEXT.matchAll(CLAUSE)) {
  const base = clause.index + clause[0].indexOf(clause[1]);
  for (const name of clause[1].matchAll(BOLD)) {
    pointers.push({ text: name[1], offset: base + name.index, line: lineOf(base + name.index) });
  }
}

const pointerOffsets = new Set(pointers.map((p) => p.offset));
const targets = new Map();
for (const span of TEXT.matchAll(BOLD)) {
  if (pointerOffsets.has(span.index)) continue;
  if (!targets.has(span[1])) targets.set(span[1], lineOf(span.index));
}
for (const heading of TEXT.matchAll(/^#{1,6} +(.+?)\s*$/gm)) {
  if (!targets.has(heading[1])) targets.set(heading[1], lineOf(heading.index));
}

// Without this the suite is vacuous by construction: a regex that stops
// matching generates zero per-pointer tests and the file passes green with
// every pointer in the document broken.
test("the pointer clauses are still recognisable in the document", () => {
  assert.ok(
    pointers.length > 0,
    `no "see **…**" pointer clause found in ${DOC} — either the document stopped pointing at its own blocks by name, or the clause shape changed and every pin below silently stopped running`,
  );
});

for (const p of pointers) {
  test(`the pointer to "${p.text}" at :${p.line} resolves to a target`, () => {
    assert.ok(
      targets.has(p.text),
      `${DOC}:${p.line} points at **${p.text}**, but no block in the file is emphasised as exactly that string — a literal search for the pointer finds only the pointer. Move any trailing punctuation or trailing clause OUTSIDE the target's \`**…**\` so the emphasised span is verbatim what the pointer names.`,
    );
  });
}
