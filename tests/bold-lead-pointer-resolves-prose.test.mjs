import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

// #3627. The run-team skill's prose points at blocks by NAME — `(**X**` in the
// references, `run-team/SKILL.md, **X**` in a script comment or a command file —
// and nothing checked that the name still leads a block anywhere. A renamed or
// removed lead left a dead pointer with the whole suite green. `pointer-target-
// prose.test.mjs` is the sibling this extends in spirit: it reads one command
// file's own `see **X**` clauses and demands the target equal the name; this one
// covers the other two families of pointer, across files, and relaxes equality
// to a word-boundary prefix because the leads these pointers name carry a
// trailing clause or a period inside their emphasis.
//
// Two families, each DERIVED from the files rather than listed here:
//   1. `(**X**` in a run-team references file — resolves to a target in
//      SKILL.md or any references file. SKILL.md is a target pool only: its own
//      `(**X**` pointers are not checked (see where the pointers are gathered).
//   2. A cite of `run-team/SKILL.md`, `run-team/references/<f>.md`, `run-team
//      references/<f>.md`, or (command files only) `references/<f>.md`, in a
//      shipped script comment or command file. The cited file must exist, and
//      every bold name tied to the cite must lead a block in THAT file.
//
// THE CEILING: this proves a name resolves to SOME block that starts with it,
// not that the block is the right one or still says the right thing — a pointer
// renamed in lockstep with its target stays green, correctly. A pointer written
// in a shape the scan does not recognise is not read at all; only the PINNED
// floors below catch that, because a derived count cannot notice itself shrinking.
//
// Out of scope here (#3634 and the ticket's own list): quoted section names,
// backticked or plain-prose section names, cites with no bold name, line-number
// cites, and anything under docs/. Script comments are read as WHOLE-line
// comments only (`Pin.stripGutter`'s own rule), so a trailing `code; // cite` is
// not scanned.

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const SKILL_DIR = join(PLUGIN, "skills", "run-team");
const REFS_DIR = join(SKILL_DIR, "references");
const COMMANDS_DIR = join(PLUGIN, "commands");
const SCRIPTS_DIR = join(PLUGIN, "scripts");

// Rendered relative to plugin/ so a failure names a path a reader can open.
const rel = (abs) => abs.slice(PLUGIN.length + 1);

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

// A target is a BLOCK, so only block-leading emphasis is one: a bold span that
// starts a paragraph, or a list item right after its marker (any indent — a
// nested item or a paragraph inside an item is still a block), plus any
// markdown heading. Matching ANY bold span would let a pointer resolve to
// another pointer, i.e. to itself — the defect `pointer-target-prose.test.mjs`
// was filed for. Scanning the logical-line view makes `^` mean block-leading
// rather than wrap-leading.
const BLOCK_LEAD = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?\*\*([^*\n]+)\*\*/gm;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/gm;

// `skip` is the set of offsets, in the joined view, where a POINTER's `**` sits.
// By construction a pointer is never block-leading (`(` or a cite precedes it on
// its own logical line), so this never fires on the real tree; it holds the
// "never resolves to a pointer" invariant independently of the regexes above.
function targetsOf(text, skip = new Set()) {
  const { text: scan, lineAt } = Pin.logicalLines(text);
  const targets = [];
  for (const span of scan.matchAll(BLOCK_LEAD)) {
    const at = span.index + span[0].indexOf("**");
    if (!skip.has(at)) targets.push({ text: span[1], line: lineAt(span.index) });
  }
  for (const heading of scan.matchAll(HEADING)) {
    targets.push({ text: heading[1], line: lineAt(heading.index) });
  }
  return targets;
}

// How a name matches: the target text STARTS with the pointer name, then the
// target ends or a non-word character follows. `The reviewer` therefore matches
// `**The reviewer.**` and `Phase 1` matches `Phase 1 — Pull: …`, but not
// `Phase 10`. Exact equality would fail on the current tree.
function nameMatches(name, targetText) {
  if (!targetText.startsWith(name)) return false;
  const next = targetText[name.length];
  return next === undefined || /\W/.test(next);
}

const resolves = (name, targets) => targets.some((t) => nameMatches(name, t.text));

// ---------------------------------------------------------------------------
// Sources: a view of a file as scannable segments
// ---------------------------------------------------------------------------

// A segment is `{ text, lineAt }`: prose joined into logical lines, and a map
// from an offset in it back to the PHYSICAL line of the file a reader opens.
function markdownSegments(src) {
  const { text, lineAt } = Pin.logicalLines(src);
  return [{ text, lineAt }];
}

// A script's prose lives in its comments. Each maximal run of whole-line
// comments is one segment: markers off via `Pin.stripGutter`, wrapped lines
// joined via `Pin.logicalLines`. Runs are kept apart so a comment never joins
// onto the code line next to it.
function commentSegments(src, marker, label) {
  const gutter = marker === "//" ? /^\s*\/\// : /^\s*#/;
  const lines = src.split("\n");
  const segments = [];
  for (let i = 0; i < lines.length; ) {
    if (!gutter.test(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && gutter.test(lines[j])) j++;
    const stripped = Pin.of(lines.slice(i, j).join("\n"), `${label} comment run at :${i + 1}`).stripGutter(marker).text;
    const { text, lineAt } = Pin.logicalLines(stripped);
    // `lineAt` is 1-based within the run; the run's first line is file line
    // first+1. `first` is a const so the closure does not follow the loop's `i`.
    const first = i;
    segments.push({ text, lineAt: (at) => first + lineAt(at) });
    i = j;
  }
  return segments;
}

// `.mjs`/`.js` comment with `//`, `.sh` with `#`; an extensionless script by its
// shebang. Anything else (`.json`, `.html`) has no comment syntax this reads.
function markerOf(name, src) {
  if (/\.(mjs|js)$/.test(name)) return "//";
  if (name.endsWith(".sh")) return "#";
  if (name.includes(".")) return null;
  const shebang = src.split("\n", 1)[0];
  if (/\bnode\b/.test(shebang)) return "//";
  if (/\b(?:ba|z)?sh\b/.test(shebang)) return "#";
  return null;
}

const lineText = (scan, at) => {
  const start = scan.lastIndexOf("\n", at - 1) + 1;
  const end = scan.indexOf("\n", at);
  return scan.slice(start, end < 0 ? undefined : end).trim();
};

// ---------------------------------------------------------------------------
// Family 1: `(**X**` in the references
// ---------------------------------------------------------------------------

const POINTER = /\(\*\*([^*\n]+)\*\*/g;

function pointersIn(src) {
  const [{ text, lineAt }] = markdownSegments(src);
  const pointers = [];
  for (const m of text.matchAll(POINTER)) {
    const at = m.index + 1;
    pointers.push({ name: m[1], at, line: lineAt(m.index), context: lineText(text, m.index) });
  }
  return pointers;
}

const mdFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f));

const SKILL_FILE = join(SKILL_DIR, "SKILL.md");
const RUN_TEAM_FILES = [SKILL_FILE, ...mdFiles(REFS_DIR)];
const RUN_TEAM_TEXT = new Map(RUN_TEAM_FILES.map((f) => [f, readFileSync(f, "utf8")]));

// Pointers and targets are gathered per file so a pointer's own offsets can be
// withheld from the targets of ITS file only.
const refPointers = [];
const poolTargets = [];
for (const [file, src] of RUN_TEAM_TEXT) {
  const pointers = pointersIn(src);
  // SKILL.md contributes targets only: its own same-file `(**X**)` pointers are
  // out of this ticket's scope, and three of them do not resolve today.
  if (file !== SKILL_FILE) for (const p of pointers) refPointers.push({ ...p, file });
  poolTargets.push(...targetsOf(src, new Set(pointers.map((p) => p.at))).map((t) => ({ ...t, file })));
}

// Bump deliberately, only when a pointer is genuinely retired from the tree;
// never to silence a red. Measured when #3627 was implemented: nine pointers,
// all in the references directory (SKILL.md's own are not counted).
const PINNED_REFERENCE_POINTERS = 9;
test("every `(**X**` pointer in the run-team references is still recognised", () => {
  assert.ok(
    refPointers.length >= PINNED_REFERENCE_POINTERS,
    `the run-team references yield ${refPointers.length} \`(**X**\` pointers, expected at least ${PINNED_REFERENCE_POINTERS} — a drop means a pointer was reworded OUT of the \`(**X**\` shape rather than removed, so its check below stopped running instead of failing. Restore the shape, or lower PINNED_REFERENCE_POINTERS only once the pointer is gone for good.`,
  );
});

for (const p of refPointers) {
  test(`${rel(p.file)}:${p.line} — the pointer to "${p.name}" resolves to a block in SKILL.md or a references file`, () => {
    assert.ok(
      resolves(p.name, poolTargets),
      `${rel(p.file)}:${p.line} points at **${p.name}**, but no block in SKILL.md or any references file leads with that name (a bold lead or heading that starts with it, ending or followed by a non-word character). Logical line: ${p.context}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Family 2: cites in script comments and command files
// ---------------------------------------------------------------------------

// `run-team/SKILL.md` | `run-team/references/<f>.md` | `run-team references/<f>.md`
// everywhere; a bare `references/<f>.md` only inside a command file, where the
// skill's references are the only ones a command can mean. The lookbehind on the
// bare form keeps `run-team/references/<f>.md` from being matched twice.
const CITE = /(?<![\w-])run-team\/SKILL\.md|(?<![\w-])run-team[/ ]references\/([\w-]+\.md)|(?<![\w/.-])references\/([\w-]+\.md)/g;

// A bold name TIED to a cite: written straight after it (`<file>'s **X**`,
// `<file> (**X**)`, `<file>, **X**`, with an optional closing backtick between),
// or sitting in the same parenthetical.
const ADJACENT = /^`?(?:'s)?[ \t,:(]*\*\*([^*\n]+)\*\*/;
const BOLD = /\*\*([^*\n]+)\*\*/g;

function depthOf(s) {
  let d = 0;
  for (const c of s) {
    if (c === "(") d++;
    else if (c === ")") d--;
  }
  return d;
}

function citesIn(segments, { bare }) {
  const cites = [];
  for (const { text, lineAt } of segments) {
    const found = [...text.matchAll(CITE)].filter((m) => bare || m[2] === undefined);
    for (const [k, m] of found.entries()) {
      const end = m.index + m[0].length;
      const rest = text.slice(end);
      const lineEnd = rest.indexOf("\n") < 0 ? rest.length : rest.indexOf("\n");
      const next = found[k + 1];
      // The tail ends at the logical line's end or at the next cite on it,
      // whichever is first: a name belongs to the nearest cite before it.
      const limit = Math.min(lineEnd, next && next.index >= end ? next.index - end : Infinity);
      const tail = rest.slice(0, limit);

      const lineStart = text.lastIndexOf("\n", m.index - 1) + 1;
      const inParen = depthOf(text.slice(lineStart, m.index)) > 0;

      const names = new Map();
      const adjacent = tail.match(ADJACENT);
      if (adjacent) names.set(tail.indexOf(`**${adjacent[1]}**`), adjacent[1]);
      if (inParen) {
        // Up to the parenthetical's own closer; a bold inside a nested
        // parenthetical is not tied to this cite.
        let d = 0;
        let close = tail.length;
        for (let i = 0; i < tail.length; i++) {
          if (tail[i] === "(") d++;
          else if (tail[i] === ")" && d-- === 0) {
            close = i;
            break;
          }
        }
        const span = tail.slice(0, close);
        for (const b of span.matchAll(BOLD)) if (depthOf(span.slice(0, b.index)) === 0) names.set(b.index, b[1]);
      }

      const file = m[0].endsWith("SKILL.md") ? SKILL_FILE : join(REFS_DIR, m[1] ?? m[2]);
      cites.push({
        cited: m[0],
        file,
        line: lineAt(m.index),
        context: lineText(text, m.index),
        names: [...names.values()],
      });
    }
  }
  return cites;
}

const sourceFiles = [];
for (const f of mdFiles(COMMANDS_DIR)) sourceFiles.push({ file: f, bare: true, segments: markdownSegments(readFileSync(f, "utf8")) });
for (const name of readdirSync(SCRIPTS_DIR).sort()) {
  const file = join(SCRIPTS_DIR, name);
  const src = readFileSync(file, "utf8");
  const marker = markerOf(name, src);
  if (marker) sourceFiles.push({ file, bare: false, segments: commentSegments(src, marker, rel(file)) });
}

const cites = [];
for (const { file, bare, segments } of sourceFiles) {
  for (const c of citesIn(segments, { bare })) cites.push({ ...c, source: file });
}
const tied = cites.flatMap((c) => c.names.map((name) => ({ ...c, name })));

// Measured when #3627 was implemented; bump only when a cite or tied name is
// genuinely retired from the tree, never to silence a red.
const PINNED_CITES = 29;
const PINNED_TIED_NAMES = 9;

test("every cite of a run-team file in a script comment or command file is still recognised", () => {
  assert.ok(
    cites.length >= PINNED_CITES,
    `scripts/ and commands/ yield ${cites.length} run-team cites, expected at least ${PINNED_CITES} — a drop means a cite was reworded OUT of \`run-team/SKILL.md\`, \`run-team/references/<f>.md\`, \`run-team references/<f>.md\` (or \`references/<f>.md\` in a command file) rather than removed, so its check stopped running instead of failing.`,
  );
});

test("every bold name tied to a run-team cite is still recognised", () => {
  assert.ok(
    tied.length >= PINNED_TIED_NAMES,
    `scripts/ and commands/ yield ${tied.length} bold names tied to a run-team cite, expected at least ${PINNED_TIED_NAMES} — a drop means a name was reworded OUT of the tied shapes (\`<file>, **X**\`, \`<file>'s **X**\`, \`<file> (**X**)\`, or inside the cite's parenthetical) rather than removed, so its check stopped running instead of failing.`,
  );
});

for (const c of cites) {
  test(`${rel(c.source)}:${c.line} — the cited ${c.cited} exists`, () => {
    assert.ok(
      existsSync(c.file),
      `${rel(c.source)}:${c.line} cites ${c.cited}, but ${rel(c.file)} does not exist. Logical line: ${c.context}`,
    );
  });
}

const targetsByFile = new Map();
const targetsOfFile = (file) => {
  if (!targetsByFile.has(file)) targetsByFile.set(file, existsSync(file) ? targetsOf(readFileSync(file, "utf8")) : []);
  return targetsByFile.get(file);
};

for (const t of tied) {
  test(`${rel(t.source)}:${t.line} — "${t.name}" resolves to a block in ${rel(t.file)}`, () => {
    assert.ok(
      resolves(t.name, targetsOfFile(t.file)),
      `${rel(t.source)}:${t.line} points at **${t.name}** in ${t.cited}, but no block in ${rel(t.file)} leads with that name (a bold lead or heading that starts with it, ending or followed by a non-word character). Logical line: ${t.context}`,
    );
  });
}

// ---------------------------------------------------------------------------
// The matcher and the scan, on documents of their own
// ---------------------------------------------------------------------------

// What must be ACCEPTED matters as much as what must be refused: a guard whose
// suite only feeds it invalid input pins its false negatives and none of its
// false positives. Every shape below is one the real tree leans on.
test("a name matches a target that carries more text after it, and nothing that merely shares its letters", () => {
  assert.equal(nameMatches("The reviewer", "The reviewer."), true, "a bold lead ending in a period");
  assert.equal(nameMatches("The reviewer", "The reviewer"), true, "the whole span");
  assert.equal(nameMatches("Guard: accumulate per PR", "Guard: accumulate per PR, never conclude inside one run."), true);
  assert.equal(nameMatches("Phase 1", "Phase 1 — Pull: judge, then claim or relabel"), true, "a heading");
  assert.equal(nameMatches("Phase 1", "Phase 10 — later"), false, "a longer number is another block");
  assert.equal(nameMatches("The reviewer", "The reviewers"), false, "a longer word is another block");
  assert.equal(nameMatches("The reviewer", "Not the reviewer."), false, "the name leads the target, it does not merely occur in it");
  assert.equal(nameMatches("Phase 1", "x Phase 1 — y"), false, "the name occurring later in the target, followed by a non-word character, is not a match");
});

test("a target is a block lead: paragraph, list item after its marker, or heading — never a mid-paragraph bold", () => {
  const doc = [
    "# Top heading",
    "",
    "**Paragraph lead.** Body with a mid-line **inside span** in it.",
    "",
    "- **Bullet lead.** Body.",
    "  - **Nested lead.** Body.",
    "1. **Numbered lead.** Body.",
    "",
    "Wrapped paragraph whose second line",
    "**starts bold** after the wrap.",
    "",
    "    # Indented four spaces, a code block",
    "",
    "## Section — with a dash",
  ].join("\n");
  const names = targetsOf(doc).map((t) => t.text);
  for (const want of ["Top heading", "Paragraph lead.", "Bullet lead.", "Nested lead.", "Numbered lead.", "Section — with a dash"]) {
    assert.ok(names.includes(want), `${want} is a target, got ${JSON.stringify(names)}`);
  }
  for (const refuse of ["inside span", "starts bold", "Indented four spaces, a code block"]) {
    assert.ok(!names.includes(refuse), `${refuse} is not block-leading and must not be a target`);
  }
});

test("a pointer never resolves to itself or to another pointer", () => {
  const doc = "Paragraph with a pointer (**Only here**) and another (**Only here**).\n";
  const pointers = pointersIn(doc);
  assert.equal(pointers.length, 2);
  assert.equal(resolves("Only here", targetsOf(doc, new Set(pointers.map((p) => p.at)))), false);
  // The exclusion is what holds the invariant should a pointer ever lead its own block.
  const leading = "**Lead** body\n";
  assert.equal(resolves("Lead", targetsOf(leading)), true);
  assert.equal(resolves("Lead", targetsOf(leading, new Set([0]))), false);
});

test("a pointer wrapped across physical lines is found, and the line reported is the one it opens on", () => {
  const doc = ["Intro sentence", "that wraps (**A name that is", "wrapped across lines**) here.", ""].join("\n");
  const [p, ...rest] = pointersIn(doc);
  assert.equal(rest.length, 0);
  assert.equal(p.name, "A name that is wrapped across lines");
  assert.equal(p.line, 2, "`lineAt` maps back to the physical line the `(**` is on, not the paragraph's first");
});

test("a bold wrapped across `//` and `#` comment lines is found, and a cite joins to its name", () => {
  const js = ["// Header prose that cites run-team/references/pull.md (**Accumulate per PR, never", "// conclude inside one run**) in a wrapped comment.", "const x = 1;"].join("\n");
  const sh = ["# claim run-team references/pull.md, **Claiming**", "echo hi"].join("\n");
  const [a] = citesIn(commentSegments(js, "//", "js fixture"), { bare: false });
  assert.deepEqual(a.names, ["Accumulate per PR, never conclude inside one run"]);
  assert.equal(a.file, join(REFS_DIR, "pull.md"));
  assert.equal(a.line, 1);
  const [b] = citesIn(commentSegments(sh, "#", "sh fixture"), { bare: false });
  assert.deepEqual(b.names, ["Claiming"]);
  assert.equal(b.file, join(REFS_DIR, "pull.md"));
});

test("a trailing comment after code is not read; only a whole-line comment is", () => {
  const js = ["const x = 1; // run-team/references/pull.md, **Trailing**", "// run-team/references/ledger.md, **Whole line**"].join("\n");
  const sh = ["echo hi # run-team/SKILL.md, **Trailing**", "# run-team/references/ledger.md, **Whole line**"].join("\n");
  for (const [src, marker] of [[js, "//"], [sh, "#"]]) {
    const found = citesIn(commentSegments(src, marker, `${marker} fixture`), { bare: false });
    assert.deepEqual(
      found.map((c) => [c.file, c.names]),
      [[join(REFS_DIR, "ledger.md"), ["Whole line"]]],
      `a \`${marker}\` comment after code on its own line must not be scanned`,
    );
  }
});

test("every cite shape ties the name written with it, and only that name", () => {
  const md = [
    "(run-team/SKILL.md, **The tier check**)",
    "",
    "`$(root)/skills/run-team/SKILL.md`'s **The reviewer** bullet owns it, and `references/reviewers.md` (**A review runs**) says more.",
    "",
    "A cite with no name run-team/references/ledger.md and a later (see **Elsewhere**) aside.",
    "",
    "(see run-team/references/pull.md, and also **Not adjacent**)",
    "",
    "(run-team/references/pull.md and run-team/references/ledger.md, and also **Nearest the second**)",
  ].join("\n");
  const [skill, skill2, reviewers, ledger, inParen, firstOfTwo, secondOfTwo] = citesIn(markdownSegments(md), { bare: true });
  assert.deepEqual(skill.names, ["The tier check"]);
  assert.deepEqual(skill2.names, ["The reviewer"]);
  assert.equal(reviewers.file, join(REFS_DIR, "reviewers.md"));
  assert.deepEqual(reviewers.names, ["A review runs"]);
  assert.deepEqual(ledger.names, [], "a bold in a LATER parenthetical is not tied to a cite outside one");
  assert.deepEqual(inParen.names, ["Not adjacent"], "a bold anywhere in the cite's own parenthetical is tied to it");
  assert.deepEqual(firstOfTwo.names, [], "a bold after a second cite in the same parenthetical belongs to that second cite");
  assert.deepEqual(secondOfTwo.names, ["Nearest the second"]);
});

test("a bare `references/<f>.md` is a cite only inside a command file", () => {
  const md = "See references/reviewers.md and run-team references/pull.md.\n";
  assert.deepEqual(citesIn(markdownSegments(md), { bare: true }).map((c) => c.file), [join(REFS_DIR, "reviewers.md"), join(REFS_DIR, "pull.md")]);
  assert.deepEqual(citesIn(markdownSegments(md), { bare: false }).map((c) => c.file), [join(REFS_DIR, "pull.md")]);
});

test("a cite of a file that does not exist is a cite the existence check refuses", () => {
  const [c] = citesIn(markdownSegments("see run-team/references/no-such-file.md\n"), { bare: false });
  assert.equal(existsSync(c.file), false);
  const [ok] = citesIn(markdownSegments("see run-team/references/pull.md\n"), { bare: false });
  assert.equal(existsSync(ok.file), true);
});
