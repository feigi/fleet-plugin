import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logicalLines } from "./prose-pin.mjs";

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
//
// #1609: both scans below run over the document's LOGICAL lines, never its
// physical ones. Every regex here is single-line by necessity — a clause must
// not run past its own paragraph, and a target must lead its block — so a
// rewrap of the runbook used to move the document out from under them: pure
// reflow of step 4, not one word changed, took the pointer list from 5 names
// to 3 and retired two pins by deleting them. `logicalLines` puts the wrap
// tolerance in the INPUT so the regexes keep their bounds; `lineAt` maps a hit
// back to the physical line a reader opens.
const REPO = join(import.meta.dirname, "..");
const DOC = "commands/review-and-fix.md";
const TEXT = readFileSync(join(REPO, DOC), "utf8");

// A pointer clause is `see` plus one or more emphasised names joined by `and`,
// `or` or a comma, either of the last two optionally preceded by a comma —
// `see **A**, **B**, and **C** below`. Without the optional comma the last name
// of an Oxford list is dropped and never pinned at all.
const CLAUSE = /[Ss]ee ((?:\*\*[^*\n]+\*\*)(?:(?:,? and|,? or|,) \*\*[^*\n]+\*\*)*)/g;
const BOLD = /\*\*([^*\n]+)\*\*/g;

// Both scans over ONE document, as a function rather than straight-line module
// scope: the reflow pin at the bottom has to run this exact extraction over a
// rewrapped copy, and a second local copy of the scan would pin only itself
// while the real one reverted to physical lines.
function scan(doc) {
  const { text: SCAN, lineAt } = logicalLines(doc);
  const pointers = [];
  for (const clause of SCAN.matchAll(CLAUSE)) {
    const base = clause.index + clause[0].indexOf(clause[1]);
    for (const name of clause[1].matchAll(BOLD)) {
      pointers.push({ text: name[1], offset: base + name.index, line: lineAt(base + name.index) });
    }
  }

  // A target is a BLOCK, so only block-leading emphasis is one. Matching ANY
  // emphasis here is what makes this suite stop discriminating: every bold span
  // CLAUSE does not recognise as a pointer would register as a target, so one
  // pointer resolves to another pointer and the file greens on exactly the
  // defect #197 was filed for. The offset exclusion below is belt-and-braces —
  // a clause always has `see ` before its first name, so a pointer is never
  // block-leading — and it holds the invariant independently of this regex.
  //
  // Scanning the joined view is what makes `^` mean block-leading rather than
  // wrap-leading: on the raw bytes, a `**Bold**` a reflow happens to push to
  // column 0 mid-paragraph registers as a target, and a pointer then resolves
  // to a block the wrap invented — the same reflow, failing green not red.
  const pointerOffsets = new Set(pointers.map((p) => p.offset));
  const targets = new Map();
  for (const span of SCAN.matchAll(/^\*\*([^*\n]+)\*\*/gm)) {
    if (pointerOffsets.has(span.index)) continue;
    if (!targets.has(span[1])) targets.set(span[1], lineAt(span.index));
  }
  for (const heading of SCAN.matchAll(/^#{1,6} +(.+?)\s*$/gm)) {
    if (!targets.has(heading[1])) targets.set(heading[1], lineAt(heading.index));
  }
  return { pointers, targets };
}

const { pointers, targets } = scan(TEXT);

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

// #1609, the pin the two above could not carry. Both of them read the document
// as it is checked in — one physical line per paragraph — so neither notices
// that every regex up there is `\n`-hostile by necessity. Measured against the
// physical-line scan this replaced, reflowing this file with not one word
// changed: at 80 columns the pointer list goes 5 names → 4, at 45 → 2, and
// the pins for the names it loses do not fail, they stop existing. Targets go
// the same way and vary more sharply by width, not a flat count — three
// block-leading `**…**` spans stop being targets at 80 columns, six at 60,
// and six again at 45, because the wrap lands inside the emphasis. At 45
// columns alone, up to four NEW ones also appear (`skipped`, `default`,
// `run-binding`, `critical/important`) because the wrap pushed a
// mid-paragraph bold to column 0. That last set is the silent direction: a
// pointer resolving to a block the reflow invented.
//
// Reflowed HERE rather than committed as a fixture: a checked-in rewrapped copy
// rots away from the real document the moment someone edits one and not the
// other, and this has to hold for the runbook's CURRENT words. The word-identity
// assert is what keeps the fixture honest — a `reflow` that garbled the text
// would make the comparison below trivially true against garbage on both sides.
// It is necessary and not sufficient: whitespace-normalised equality cannot see
// INDENT, and the first cut of this helper silently de-indented every wrapped
// paragraph's opening line while passing that assert. The target-set compare
// below is what caught it, which is the same thing it is here to catch.
const reflow = (text, cols) => {
  const out = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^ {0,3}(?:```|~~~)/.test(line)) fenced = !fenced;
    // A hard break is authored, not a wrap point — an editor does not reflow
    // through one, and neither does `logicalLines`.
    if (fenced || line.length <= cols || /(?:[ \t]{2}|\\)$/.test(line)) {
      out.push(line);
      continue;
    }
    // Two indents, not one. `lead` keeps the opening line where the author put
    // it — dropping it promotes an indented continuation paragraph to a
    // top-level one, a structural edit — and `indent` puts every wrapped line
    // past a list marker, because wrapping a list item flush left would turn
    // its tail into a new paragraph.
    const lead = line.match(/^[ \t]*/)[0];
    const indent = " ".repeat(line.match(/^(?:[ \t]*(?:[-*+]|\d+[.)])[ \t]+|[ \t]*)/)[0].length);
    const words = line.slice(lead.length).split(" ").filter(Boolean);
    let cur = lead + (words.shift() ?? "");
    for (const word of words) {
      if (`${cur} ${word}`.length > cols) {
        out.push(cur);
        cur = indent + word;
      } else cur = `${cur} ${word}`;
    }
    out.push(cur);
  }
  return out.join("\n");
};

// Three widths: 80 is an ordinary editor wrap, 45 splits inside the emphasised
// names themselves, and 60 sits between and loses a DIFFERENT pointer than 80
// does. One width alone measures one accident of where the breaks landed.
for (const cols of [80, 60, 45]) {
  test(`a pure reflow of ${DOC} at ${cols} columns changes no pointer and no target`, () => {
    const rewrapped = reflow(TEXT, cols);
    assert.notEqual(rewrapped, TEXT, `reflow at ${cols} columns changed nothing — this pin is not exercising a rewrap`);
    assert.equal(
      rewrapped.replace(/\s+/g, " ").trim(),
      TEXT.replace(/\s+/g, " ").trim(),
      "the reflow fixture changed the document's words, so the comparison below would prove nothing",
    );
    const after = scan(rewrapped);
    assert.deepEqual(
      after.pointers.map((p) => p.text),
      pointers.map((p) => p.text),
      `rewrapping ${DOC} at ${cols} columns changes which pointers this file finds — the scan is reading physical lines again, so an author who reflows a paragraph silently retires the pins for every pointer the wrap split.`,
    );
    // The other direction, and the one that fails GREEN: a target lost to the
    // wrap takes its pointer's pin down as a spurious red, and a `**Bold**`
    // that the wrap pushes to column 0 mid-paragraph is a target the reflow
    // invented — one more block for a pointer to resolve to for free.
    assert.deepEqual(
      [...after.targets.keys()],
      [...targets.keys()],
      `rewrapping ${DOC} at ${cols} columns changes which blocks count as targets — block-leading emphasis is being read as "starts a physical line" rather than "starts a block".`,
    );
  });
}
