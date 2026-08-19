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
// pointer renamed in lockstep with its target stays green, correctly. The
// pointer LIST is derived from the document rather than hardcoded, so a pointer
// added later is covered without editing this file — and so this file cannot
// satisfy its own pins. Only the floor under that list, `PINNED` below, is a
// literal, because a derived count cannot notice itself shrinking.
const REPO = join(import.meta.dirname, "..", "..", "..");
const DOC = "skills/fleet/commands/review-and-fix.md";
const TEXT = readFileSync(join(REPO, DOC), "utf8");

// A pointer clause is `see` plus one or more emphasised names joined by `and`,
// `or` or a comma, either of the last two optionally preceded by a comma —
// `see **A**, **B**, and **C** below`. Without the optional comma the last name
// of an Oxford list is dropped and never pinned at all.
const CLAUSE = /[Ss]ee ((?:\*\*[^*\n]+\*\*)(?:(?:,? and|,? or|,) \*\*[^*\n]+\*\*)*)/g;
const BOLD = /\*\*([^*\n]+)\*\*/g;

const lineOf = (offset) => TEXT.slice(0, offset).split("\n").length;

const pointers = [];
for (const clause of TEXT.matchAll(CLAUSE)) {
  const base = clause.index + clause[0].indexOf(clause[1]);
  for (const name of clause[1].matchAll(BOLD)) {
    pointers.push({ text: name[1], offset: base + name.index, line: lineOf(base + name.index) });
  }
}

// A target is a BLOCK, so only block-leading emphasis is one. Matching ANY
// emphasis here is what makes this suite stop discriminating: every bold span
// CLAUSE does not recognise as a pointer would register as a target, so one
// pointer resolves to another pointer and the file greens on exactly the
// defect #197 was filed for. The offset exclusion below is belt-and-braces —
// a clause always has `see ` before its first name, so a pointer is never
// block-leading — and it holds the invariant independently of this regex.
const pointerOffsets = new Set(pointers.map((p) => p.offset));
const targets = new Map();
for (const span of TEXT.matchAll(/^\*\*([^*\n]+)\*\*/gm)) {
  if (pointerOffsets.has(span.index)) continue;
  if (!targets.has(span[1])) targets.set(span[1], lineOf(span.index));
}
for (const heading of TEXT.matchAll(/^#{1,6} +(.+?)\s*$/gm)) {
  if (!targets.has(heading[1])) targets.set(heading[1], lineOf(heading.index));
}

// The count, not merely non-emptiness: PARTIAL degradation is the real hole.
// Reword one clause's verb and that pointer's pin silently disappears while
// the survivors keep the suite green — measured, a single `see` → `consult`
// retires a pin with no signal at all. Bump this deliberately when a pointer
// is genuinely retired from the document; never to silence a red.
const PINNED = 5;
test("every pointer clause in the document is still recognised", () => {
  assert.ok(
    pointers.length >= PINNED,
    `${DOC} yields ${pointers.length} pointer names, expected at least ${PINNED} — a drop means a pointer was rephrased OUT of the \`see **…**\` shape rather than removed from the document, so its pin below stopped running instead of failing. Restore the clause shape, or lower ${PINNED} only once you have confirmed the pointer is gone from ${DOC} for good.`,
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
