import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLUMNS } from "./member-outcomes.mjs";

const REPO = join(import.meta.dirname, "..");
const TSV = readFileSync(join(REPO, "docs", "metrics", "member-outcomes.tsv"), "utf8");
// The header is the LEADING comment block, which is also exactly what the CLI
// preserves across a rewrite. Slicing it — rather than collecting `#` lines from
// anywhere — is what keeps the prose assertions below from being satisfied by a
// stray comment sitting among the data rows.
const headerLines = [];
for (const l of TSV.split("\n")) {
  if (!l.startsWith("#") && l.trim()) break;
  headerLines.push(l);
}
const HEADER = headerLines.join("\n");

test("the header's column line matches COLUMNS exactly, in order", () => {
  // Drift here is silent and total: every awk one-liner in the header indexes
  // by position, so a column inserted in the code shifts $5 for every reader.
  //
  // Anchored on the tab-separated shape, not on `includes("run_date")`: the
  // loose lookup took the first top-down match, so a future header paragraph
  // that merely mentioned run_date above this line would silently pin prose.
  const line = headerLines.find((l) => l.startsWith("# session\t"));
  assert.ok(line, "header has no `# session<TAB>...` column line");
  assert.deepEqual(line.replace(/^#\s*/, "").split("\t"), COLUMNS);
});

test("the header states the blank, hand-edit, and superseded-generation rules", () => {
  // All three are load-bearing and none is enforceable in code, so prose is the
  // only carrier — which is what makes them worth pinning. The third is the one
  // most likely to be dropped as noise by a future editor, and dropping it is
  // how an older, dearer generation gets read as a cheap tier.
  //
  // Matched against the HEADER SLICE, not the whole file: matching the file
  // meant a pinned rule that had been moved down among the data rows still
  // satisfied the pin.
  assert.match(HEADER, /BLANK MEANS UNKNOWN/);
  assert.match(HEADER, /NEVER hand-edit a row/);
  assert.match(HEADER, /SUPERSEDED GENERATIONS ARE A SEPARATE POPULATION/);
  assert.match(HEADER, /OPAQUE JOIN KEY/);
  // The corpus spans both transcript depths. A reader who assumes the flat half
  // only would under-count every review role by roughly half.
  assert.match(HEADER, /workflows\/wf_/);
});

test("the header's awk read-outs index the columns they name", () => {
  // This test asserted COLUMNS[0]/[2]/[4] — a fact about the CODE, not about
  // the queries it is named for. Mutation-proven: repointing the header's pair
  // query from $1/$3/$5 to $2/$4/$6 left it GREEN, so the query the header
  // calls "the only unconfounded comparison" could silently group on run_date
  // and distinguish by effort with nothing to catch it.
  //
  // So read the `$n` references out of the header's own awk lines and resolve
  // each against COLUMNS. Mutation this must survive: changing any `$n` in the
  // header without changing COLUMNS.
  const awkLines = headerLines.filter((l) => l.includes("awk -F"));
  assert.ok(awkLines.length >= 2, "header lost its awk read-outs");

  const pair = headerLines.filter((l) => /\{k=\$\d+ FS \$\d+/.test(l))[0];
  assert.ok(pair, "header lost its within-run pair query");
  const [, group1, group2, distinguish] = /\{k=\$(\d+) FS \$(\d+);.*?FS \$(\d+) in s/.exec(pair);
  assert.equal(COLUMNS[group1 - 1], "session", "pair query must group on session");
  assert.equal(COLUMNS[group2 - 1], "role", "pair query must group on role");
  assert.equal(COLUMNS[distinguish - 1], "model", "a pair is a session+role that ran more than one MODEL");

  const byModel = headerLines.find((l) => /\{n\[\$\d+\]\+\+\}/.test(l));
  assert.ok(byModel, "header lost its rows-by-model read-out");
  assert.equal(COLUMNS[/\{n\[\$(\d+)\]\+\+\}/.exec(byModel)[1] - 1], "model");
});
