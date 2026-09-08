// Blank out a JS file's comments so a source-text assertion cannot be
// satisfied by a declaration or a paragraph a reader's eye skips.
//
// Both escapes were MEASURED green on `workflows/review-pr.js` before this
// existed: the three diff schema fields wrapped in `/* */` (the schema drops
// them, `usableDiff` returns null forever, 12 pass / 0 fail), and the snapshot
// agent's `Report \`diffPath\`` paragraph deleted and re-inserted inside a
// block comment (same, 12 pass / 0 fail). A `^(?!\s*//)` anchor closes
// neither: the commented-out line starts with `/*`, and per-assertion anchors
// have to be remembered once per pin.
//
// It lives here rather than inline in one test file because remembering it is
// exactly what fails. `review-pr-reads.test.mjs` carried a private copy;
// `review-pr-testcmd.test.mjs` was then written against raw source and its
// schema-declaration pin was vacuous against a block-commented `testCmd:
// { type: "string" },` — 9 pass / 0 fail with the field genuinely dead under
// `additionalProperties: false` (#142 review, measured).
//
// Line-based on purpose. A regex stripper (`/\*[\s\S]*?\*\//`) would open a
// comment at `"node --test scripts/*.test.mjs"` — a glob inside a
// string literal — and swallow real code up to the next `*/`. Blank lines
// rather than deleted ones, so offsets stay line-aligned with the file.
//
// Known ceiling: whole-line comments only. A TRAILING `code; // note` keeps
// its comment text, and `//` inside a string literal (a URL, a glob) is left
// alone — which is the point, since blanking those would delete real code.
// Neither form can hide a declaration from a pin, which is what this is for.
export function stripComments(source) {
  const out = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      out.push("");
    } else if (/^\s*\/\*/.test(line)) {
      if (!line.includes("*/")) inBlock = true;
      out.push("");
    } else {
      out.push(/^\s*\/\//.test(line) ? "" : line);
    }
  }
  return out.join("\n");
}
