import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between, phrase } from "./prose-pin.mjs";
import { discoverWorkflowFiles, WORKFLOWS } from "./workflow-files.mjs";

// #853. A workflow script whose body carries any statement BEFORE
// `export const meta` was observed absent from the workflow registry — no
// error, no warning, nothing that tells it apart from a file that was never
// written, a wrong path, or a harness that refused the construct you were
// actually probing.
//
// FOREIGN EVIDENCE, cited as observed rather than as a specification: the
// registry is the harness's, and this repo cannot settle what its loader
// guarantees. Measured against the Claude Code harness on 2026-08-23 by
// `impl-538` while implementing #538, recorded on PR #852, filed as #853. The
// `Workflow` tool's own contract states the requirement; what no document
// stated is the FAILURE MODE, silent omission rather than a load error.
//
// The behaviour is the harness's; the guard is OURS. Asserting the shape of
// our own files needs no cooperation from the loader, and the consequence
// lands on `workflows/review-pr.js`, the fleet's DEFAULT review path. A file
// that fails to register produces no red at all: the fleet falls back to the
// hand-dispatched reviewer, where dimension selection never runs and nothing
// budgets the adversarial pass, and the only symptom is a review that is
// quietly thinner — indistinguishable downstream from a review that found
// nothing.
//
// Files are DISCOVERED, never listed. A hardcoded list reproduces this
// ticket's own failure mode one level up: the workflow nobody remembered to
// add is silently uncovered, which reads exactly like a workflow that passes.
//
// #1204 closed the narrower version of the same hole, one filter down: the
// discovery here was a flat `readdirSync` filtered on `.endsWith(".js")`, so a
// `workflows/x.mjs` or a `workflows/sub/x.js` was never inspected and this
// guard stayed green over it. It now walks the tree and SPLITS it, in
// workflow-files.mjs — which carries the measurement that made the split
// possible, and which `review-pr-reads.test.mjs` shares rather than copies;
// that file's parse check was hardcoded to the one filename until the same
// ticket derived it from this set.
const REVIEW_PR = readFileSync(join(WORKFLOWS, "review-pr.js"), "utf8");

// The first NON-COMMENT statement, per the rule — a leading licence block or an
// explanatory paragraph is legal and must not red. Comments are blanked by the
// shared stripper rather than skipped by a regex written here, so a `/* */`
// block spanning lines is handled the way every other pin in this directory
// handles one.
//
// The `*/` split is LOAD-BEARING, not tidying. The shared stripper is
// line-based and blanks a line WHOLE when it opens with `/*` or when it closes
// a block — code on that line included. So `/* h */ const scratch = 'x';`, and
// a block closed by `*/ const scratch = 'x';`, both vanish; the export below
// them then reads as first; and the guard goes SILENTLY green on exactly the
// file it exists to catch. `/** @type {{a:number}} */ const cfg = { a: 1 };` is
// an ordinary JSDoc one-liner that lands there. Breaking every `*/` onto its
// own line first puts that tail where the stripper cannot blank it; all three
// shapes are pinned in the refusal table below. Fixing the stripper instead is
// refused for the reason strip-comments.mjs states: a span regex opens a
// comment at a glob inside a string literal and swallows the real code after
// it.
//
// Two ceilings remain, and BOTH ARE LOUD — a red with an obvious fix, never a
// silent pass. That is the trade this whole file exists to make, and after the
// split it runs in that direction only.
//   - `/* c */ export const meta = {` written on one physical line reds: the
//     split leaves the export indented and `META_FIRST` anchors at `^`.
//     Refusing an indented export costs nothing here, because both of this
//     repo's syntax checks strip the export with `/^export /m` before
//     compiling and that pattern does not match an indented line either:
//       $ grep -rl 'replace(/\^export /m' .github/workflows/ci.yml scripts/
//         .github/workflows/ci.yml
//         scripts/review-pr-reads.test.mjs
//   - a `*/` inside a string literal or inside a `//` comment ABOVE the export
//     splits that line as well, and its tail then reads as a statement.
//     Settled that every file under `workflows/` reaches `export const meta`
//     before its first `*/`:
//       $ for f in workflows/*.js; do printf '%s: ' "$f"; awk '/^export const meta/{print "export first"; exit} /\*\//{print "*-slash first"; exit}' "$f"; done
//         workflows/review-pr.js: export first
const firstStatement = (source) =>
  stripComments(source.replace(/\*\//g, "*/\n")).split("\n").find((line) => line.trim() !== "") ?? "";

const META_FIRST = /^export\s+const\s+meta\b/;

test("every workflow file's first non-comment statement is `export const meta`", () => {
  const { registrable } = discoverWorkflowFiles();
  // A FLOOR, not a count. Discovery over an empty (or newly renamed)
  // `workflows/` yields an empty list, the loop below then inspects nothing,
  // and the test goes green having asserted over no file — which is this
  // ticket's own silent-absence defect arriving through the guard written to
  // prevent it. A pinned total is refused for the reason the derived list
  // exists: it would have to be edited every time a workflow is added, and
  // that is the step nobody remembers.
  assert.ok(
    registrable.length > 0,
    "no registrable workflow file found in workflows/ — this guard is asserting over nothing and would pass vacuously",
  );
  for (const f of registrable) {
    // Two causes, two messages. An empty or comment-only file has NO statement
    // rather than the wrong one first, and reporting it as "a statement before
    // `export const meta`" sends the reader looking for a statement that isn't
    // there. #853's entire provenance is a misattributed cause — a probe's
    // registry absence read as an import rejection — so a guard written against
    // that trap must not misattribute its own failure.
    const first = firstStatement(readFileSync(join(WORKFLOWS, f), "utf8"));
    assert.match(
      first,
      META_FIRST,
      first === ""
        ? `workflows/${f} carries no statement at all — an empty or comment-only file never reaches \`export const meta\`, and the harness drops it from the registry silently`
        : `workflows/${f} has a statement before \`export const meta\` — the harness drops it from the registry silently, and nothing else in this repo would notice`,
    );
  }
});

// The half the shape guard above cannot reach, and the one #1204 is about. A
// file the loader never opens has no first statement to be wrong: widening the
// discovery above to cover it would assert the meta-first rule on a file that
// is dead whatever its first line says, which is a GREEN on a broken file —
// the same silence one filter further out.
//
// So the widened discovery feeds two assertions, not one. This is the second:
// anything under `workflows/` that reads as a script and is not flat `.js` is
// refused outright, with the loader's own reason. Measured, not assumed — see
// workflow-files.mjs for the probe that settled it against Claude Code 2.1.272.
//
// This is the only thing in the repo that would notice. `ci.yml`'s
// `case plugin/workflows/*)` arm parse-checks a nested `.js` and passes it, and
// a `.mjs` under `workflows/` falls to the `*.mjs` step's `node --check`, which
// reds for the wrong reason entirely (top-level `return`) and sends the reader
// to fix the body of a file whose only defect is its name.
test("no file under workflows/ is a workflow the harness would never register", () => {
  const { unregistrable } = discoverWorkflowFiles();
  assert.deepEqual(
    unregistrable,
    [],
    unregistrable
      .map(({ path, why }) => `workflows/${path} is never loaded: ${why}`)
      .join("; ") +
      " — the harness drops it with no error and no warning, so nothing downstream can tell it from a workflow that ran",
  );
});

// And the classifier's own half, on a tree that holds every shape at once.
// Without this, the two assertions above are satisfied by a discovery that
// returns `unregistrable: []` unconditionally — the repo's real `workflows/`
// holds one flat `.js`, so a split that never splits anything is green on it,
// green on both tests, and blind to exactly the file the ticket is about. The
// fixture is the only place the negative shapes exist.
test("discovery splits the tree the way the harness's loader does", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-files-"));
  try {
    mkdirSync(join(dir, "nested"));
    for (const rel of [
      "review-pr.js",
      "merge-wave.js",
      "nearmiss.mjs",
      "nearmiss.cjs",
      "nearmiss.ts",
      join("nested", "deep.js"),
      join("nested", "deep.mjs"),
      // Not a script, not this guard's business: a note beside a workflow must
      // not red, or the guard becomes the thing people delete.
      "README.md",
    ])
      writeFileSync(join(dir, rel), "export const meta = {};\n");
    const { registrable, unregistrable } = discoverWorkflowFiles(dir);
    assert.deepEqual(
      registrable,
      ["merge-wave.js", "review-pr.js"],
      "the registrable set is not exactly the flat .js files the loader reaches",
    );
    assert.deepEqual(
      unregistrable.map((u) => u.path).sort(),
      ["nearmiss.cjs", "nearmiss.mjs", "nearmiss.ts", join("nested", "deep.js"), join("nested", "deep.mjs")].sort(),
      "a shape the loader drops is missing from the refusal set, or a file it loads landed there",
    );
    // The reason is load-bearing, not decoration: a nested file renamed to
    // `.js` is still nested, and a reader told only "wrong extension" moves it
    // to a name that changes nothing.
    assert.match(
      unregistrable.find((u) => u.path === join("nested", "deep.js")).why,
      /nested/,
      "a nested file's refusal does not say it is nested, so the fix it suggests would not work",
    );
    assert.match(
      unregistrable.find((u) => u.path === "nearmiss.mjs").why,
      /extension/,
      "a near-miss extension's refusal does not name the extension",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The other half of a shape assertion, and the sharper one: a legal file this
// matcher refuses is a false red with no way to satisfy it, and a guard that
// cannot go green gets deleted — worse than no guard.
test("the meta-first guard accepts the legal ways a workflow file can begin", () => {
  for (const [form, source] of [
    ["bare, nothing before it", "export const meta = {\n  name: 'x',\n};"],
    ["leading blank lines", "\n\n\nexport const meta = {"],
    ["a licence block comment", "/*\n * Copyright someone.\n * All rights reserved.\n */\nexport const meta = {"],
    ["a JSDoc block", "/**\n * What this workflow does.\n */\nexport const meta = {"],
    ["a run of line comments", "// why this exists\n// and a second line\nexport const meta = {"],
    ["a comment block then blank lines", "// header\n\n\nexport const meta = {"],
    ["a trailing comment on the export line", "export const meta = { // opens the meta block"],
    // A comment whose TEXT is a statement must not be read as one. This is the
    // form that made the shared stripper necessary in the first place, rather
    // than a `^(?!\s*//)` anchor written per assertion.
    ["a commented-out statement", "// const x = 1;\n/* import 'node:fs'; */\nexport const meta = {"],
    ["irregular spacing in the declaration", "export   const\tmeta={"],
  ])
    assert.match(firstStatement(source), META_FIRST, `a legal workflow file is refused: ${form}`);
});

// And the shapes it must refuse, so the acceptance list above cannot be
// satisfied by a matcher that accepts everything.
test("the meta-first guard refuses the shapes that silently drop a workflow", () => {
  for (const [form, source] of [
    ["a const before the export", "const scratch = 'x';\nexport const meta = {"],
    ["a static import before the export", "import { readFileSync } from 'node:fs';\nexport const meta = {"],
    ["a call before the export", "log('starting');\nexport const meta = {"],
    // Legal JS, still refused, and the refusal is CORRECT. Settled with
    // `new AsyncFunction('"use strict";\nconst meta = {};')`, which compiles: a
    // directive prologue is legal at the start of a function body, so nothing
    // local rejects it — but it is a statement before the export, so the
    // harness's shape rule drops the file anyway. Legality is not the question
    // this guard asks.
    ['a "use strict" directive', '"use strict";\nexport const meta = {'],
    // A shebang is likewise refused, and likewise correctly. Settled with
    // `new AsyncFunction("#!/usr/bin/env node\\nconst meta = {};")`, which
    // throws `SyntaxError: Invalid or unexpected token` — the hashbang grammar
    // is only legal at the start of a Script or Module source, and a workflow
    // body is neither (the observed harness compiles it as a function body,
    // per #538). So a shebang is not a legal form here to begin with; refusing
    // it costs nothing that could have worked.
    ["a shebang", "#!/usr/bin/env node\nexport const meta = {"],
    // The export present but not FIRST, with the real one further down. A
    // matcher that searched the file instead of reading its first statement
    // would go green on exactly the file this ticket is about.
    ["the export present but preceded", "const meta2 = 1;\nexport const meta = {"],
    // And the mirror: the only `export const meta` is inside a comment. A
    // matcher run over raw source rather than stripped source accepts this.
    ["the export only inside a comment", "// export const meta = {\nconst x = 1;"],
    ["an empty file", ""],
    ["a file of only comments", "// nothing here\n"],
    // The false-GREEN shapes, and the reason `firstStatement` splits at `*/`.
    // Each carries a real statement on the same physical line as a block
    // comment's close, and each was measured passing this guard before the
    // split — a silent green on the file this whole test exists to red.
    ["code on the line that closes a block comment", "/*\n * header\n */ const scratch = 'x';\nexport const meta = {"],
    ["code after a one-line block comment", "/* header */ const scratch = 'x';\nexport const meta = {"],
    ["a JSDoc one-liner declaration", "/** @type {{a:number}} */ const cfg = { a: 1 };\nexport const meta = {"],
    // And the same physical line with no comment involved at all. This row is
    // the only one that discriminates `META_FIRST`'s `^`: drop the anchor and
    // every other row here still refuses, because none of them puts
    // `export const meta` anywhere on the line the matcher is handed.
    ["a statement before the export on one line", "const scratch = 1; export const meta = {"],
  ])
    assert.doesNotMatch(firstStatement(source), META_FIRST, `a dropped-from-the-registry shape is accepted: ${form}`);
});

// The prose half of #853, and the half a passing test cannot deliver: what
// cost time was not a broken workflow but a MISATTRIBUTED CAUSE, and the
// person about to repeat it is the one writing a throwaway probe — who meets
// this file's subject at the re-measure instruction in review-pr.js, not here.
// Slice-bounded at both ends, per prose-pin.mjs: a presence check over the
// whole 1200-line source stays green when the paragraph lands somewhere its
// reader never reaches.
//
// Pinned as AFFIRMATIVE MOVES rather than as a phrase about the trap. A
// synonym walks around a description; it cannot supply the instruction that
// makes the next probe sound.
test("the throwaway-probe instruction carries the silent-omission trap", () => {
  // The `//` gutter has to come off before matching, for the reason
  // `stripHashGutter` exists in prose-pin.mjs: a JS comment block wraps at
  // `//`, and `\s+` does not span one, so a pinned phrase that happens to
  // break across a line today reds on prose that says exactly the right
  // thing. Rejoined with the single space the wrap point replaced.
  const record = between(
    REVIEW_PR,
    "re-measure with a throwaway workflow",
    "The head compare below",
    "review-pr.js's sandbox record",
  )
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/\s?/, ""))
    .join(" ");
  // Three spans, not four phrases. The last runs CONTIGUOUSLY from the control
  // through the positive signal to the sentence's closing period, because four
  // independent presence checks pin only that the words appear — never that
  // nothing BETWEEN them reverses the guidance. Measured: an exception clause
  // spliced onto the instruction ("… as a result -- UNLESS the absence already
  // reads as rejection, in which case trust the first probe and skip the twin
  // entirely") tells the reader to do the exact thing this paragraph exists to
  // stop, and left all four separate assertions green. The span is the fix this
  // repo already uses for that defect class (#488, #144).
  for (const [pin, why] of [
    [
      "registry presence is not evidence",
      "the record does not say what registry presence is not — a reader takes an absence as a result",
    ],
    [
      "any statement before `export const meta`",
      "the shape rule itself is not stated, so the reader cannot avoid tripping it",
    ],
    [
      "twin with the construct under test removed, and make the workflow RUN and return a computed marker instead of reading its presence as a result.",
      "the control and the positive signal are no longer one unbroken instruction — either the control is unnamed, or no positive signal replaces presence, or something spliced into the join lets the reader trust an absence after all",
    ],
  ])
    assert.match(record, phrase(pin), why);
});
