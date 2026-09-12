import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { COLUMNS } from "./member-outcomes.mjs";

const REPO = join(import.meta.dirname, "..", "..");
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
  // …and the one column where it does not. Blank `subagent_type` means the
  // dispatch named no agent definition — a closed category, not missing data.
  // Read as "unknown" it turns thousands of pre-2026-08-28 rows into evidence
  // someone believes a re-scrape could recover, which is how #1066's
  // over-count got argued for in the first place.
  assert.match(HEADER, /ITS BLANK IS NOT UNKNOWN/);
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

  const pair = pairQuery();
  // BOTH arms are identified by the dispatch record (#1066), never by the role
  // classifier and never by "the models differ" — so both `$n ~ /…/` tests
  // must land on subagent_type, and there must be two of them.
  const arms = [...pair.matchAll(/\$(\d+) ~ \/\(\^\|:\)fleet-implementer(-alt)?\$\//g)];
  assert.equal(arms.length, 2, "the pair query no longer tests BOTH implementer definitions");
  assert.deepEqual(arms.map((m) => Boolean(m[2])), [true, false], "the -alt arm must be tested FIRST — /fleet-implementer$/ is checked in the else branch");
  for (const [, n] of arms) assert.equal(COLUMNS[n - 1], "subagent_type", "deliberateness comes from the dispatch record");

  const keys = [...pair.matchAll(/[at]\[\$(\d+) FS \$(\d+)\]/g)];
  assert.equal(keys.length, 2, "the pair query no longer keys both arms");
  for (const [, session, model] of keys) {
    assert.equal(COLUMNS[session - 1], "session", "a pair is WITHIN one session");
    assert.equal(COLUMNS[model - 1], "model", "the two arms must have run different MODELS");
  }

  const [, dateKey, dateValue] = /d\[\$(\d+)\]=\$(\d+)/.exec(pair);
  assert.equal(COLUMNS[dateKey - 1], "session");
  assert.equal(COLUMNS[dateValue - 1], "run_date", "the gate's second number is distinct run_dateS");

  const byModel = headerLines.find((l) => /\{n\[\$\d+\]\+\+\}/.test(l));
  assert.ok(byModel, "header lost its rows-by-model read-out");
  assert.equal(COLUMNS[/\{n\[\$(\d+)\]\+\+\}/.exec(byModel)[1] - 1], "model");
});

// The pair query as a runnable awk program: the header block from `awk -F` to
// the path it reads, `#` stripped, the shell quoting removed. Index pins alone
// cannot see a query that indexes the right columns and still counts the wrong
// thing — which is precisely the defect #1066 was filed for.
function pairQuery() {
  const start = headerLines.findIndex((l) => l.includes("awk -F") && l.includes("fleet-implementer-alt"));
  assert.ok(start >= 0, "header lost its within-run pair query");
  let end = start;
  while (end < headerLines.length && !headerLines[end].endsWith("docs/metrics/member-outcomes.tsv")) end++;
  assert.ok(end < headerLines.length, "the pair query never reaches the file it reads");
  return headerLines.slice(start, end + 1).map((l) => l.replace(/^#\s{0,3}/, "")).join("\n");
}

test("the header's pair query counts DELIBERATE pairs, run against a corpus where every near-miss is present", () => {
  // #1066: the query this replaces counted any session+role carrying two
  // models, reported 198 keys against 17 real pairs, and so reported run-team's
  // ten-across-five gate MET while the controlled comparison did not exist.
  //
  // Mutations this must survive, all measured against this fixture and all of
  // which leave the column indexes (and therefore the test above) intact:
  // dropping the `x[2]!=y[2]` model test reads 4 2, dropping the `-alt` anchor
  // so both arms match one definition reads 0 0, and going back to #1066's own
  // query — arms identified by `$3=="implementer"` rather than by the dispatch
  // — reads 4 2, counting the untyped session and missing the omp one.
  const rows = [
    // a real pair: alt at sonnet against the top definition at opus
    ["sA", "2026-09-01", "implementer", "impl-1", "claude-sonnet-5", "high", "1", "", "0", "0", "0", "1", "agent-a1", "claude", "fleet-implementer-alt"],
    ["sA", "2026-09-01", "implementer", "impl-2", "claude-opus-5", "high", "2", "", "0", "0", "0", "1", "agent-a2", "claude", "fleet-implementer"],
    // deliberate dispatch, empty comparison: both arms resolved to one model
    ["sB", "2026-09-01", "other", "impl-3", "claude-sonnet-5", "high", "3", "", "0", "0", "0", "1", "agent-a3", "omp", "fleet-implementer-alt"],
    ["sB", "2026-09-01", "other", "impl-4", "claude-sonnet-5", "high", "4", "", "0", "0", "0", "1", "agent-a4", "omp", "fleet-implementer"],
    // two models, no deliberate dispatch: the accidental pair #1066 counted
    ["sC", "2026-09-01", "implementer", "impl-5", "claude-sonnet-5", "high", "5", "", "0", "0", "0", "1", "agent-a5", "claude", ""],
    ["sC", "2026-09-01", "implementer", "impl-6", "claude-opus-5", "high", "6", "", "0", "0", "0", "1", "agent-a6", "claude", ""],
    // a second pair on the SAME day — two pairs, one run_date
    ["sD", "2026-09-01", "implementer", "impl-7", "claude-sonnet-5", "high", "7", "", "0", "0", "0", "1", "agent-a7", "claude", "fleet-implementer-alt"],
    ["sD", "2026-09-01", "implementer", "impl-8", "claude-opus-5", "high", "8", "", "0", "0", "0", "1", "agent-a8", "claude", "fleet-implementer"],
    // and one on another day, so the second number is not the first
    ["sE", "2026-09-02", "implementer", "impl-9", "claude-sonnet-5", "high", "9", "", "0", "0", "0", "1", "agent-a9", "claude", "fleet-implementer-alt"],
    ["sE", "2026-09-02", "implementer", "impl-10", "claude-opus-5", "high", "10", "", "0", "0", "0", "1", "agent-a10", "claude", "fleet-implementer"],
    // a typed non-implementer at a third model inside a pair session: the
    // review fan-out runs one on every session and must not inflate anything
    ["sE", "2026-09-02", "specialist", "rev", "claude-haiku-4-5", "", "", "", "0", "0", "0", "1", "agent-a11", "claude", "fleet-review-tests"],
  ];
  const corpus = join(mkdtempSync(join(tmpdir(), "mo-hdr-")), "member-outcomes.tsv");
  writeFileSync(corpus, "# header line, skipped by the query\n" + rows.map((r) => r.join("\t")).join("\n") + "\n");

  const program = /awk -F'\\t' '([\s\S]*)' docs\/metrics\/member-outcomes\.tsv$/.exec(pairQuery());
  assert.ok(program, "the pair query is no longer a runnable `awk -F'\\t' '<program>' <file>` line");
  const r = spawnSync("awk", ["-F", "\t", program[1], corpus], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "3 2", "three deliberate pairs across two distinct run_dates");
});
