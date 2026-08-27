import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLUMNS } from "./member-outcomes.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const TSV = readFileSync(join(REPO, "docs", "metrics", "member-outcomes.tsv"), "utf8");
const header = TSV.split("\n").filter((l) => l.startsWith("#"));

test("the header's column line matches COLUMNS exactly, in order", () => {
  // Drift here is silent and total: every awk one-liner in the header indexes
  // by position, so a column inserted in the code shifts $5 for every reader.
  const line = header.find((l) => l.includes("run_date"));
  assert.ok(line, "header has no column line");
  assert.deepEqual(line.replace(/^#\s*/, "").split("\t"), COLUMNS);
});

test("the header states the blank, hand-edit, and superseded-generation rules", () => {
  // All three are load-bearing and none is enforceable in code, so prose is the
  // only carrier — which is what makes them worth pinning. The third is the one
  // most likely to be dropped as noise by a future editor, and dropping it is
  // how an older, dearer generation gets read as a cheap tier.
  assert.match(TSV, /BLANK MEANS UNKNOWN/);
  assert.match(TSV, /NEVER hand-edit a row/);
  assert.match(TSV, /SUPERSEDED GENERATIONS ARE A SEPARATE POPULATION/);
  assert.match(TSV, /OPAQUE JOIN KEY/);
});

test("the header's pair query names the columns it actually indexes", () => {
  // $1 is session and $3 is role and $5 is model. If COLUMNS changes, this
  // query silently groups on the wrong fields.
  assert.equal(COLUMNS[0], "session");
  assert.equal(COLUMNS[2], "role");
  assert.equal(COLUMNS[4], "model");
});
