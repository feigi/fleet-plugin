import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { COLUMNS } from "./member-outcomes.mjs";
import { GATE } from "./cell-readout.mjs";

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
  // transcript carried no `session_init` agent to read — a closed category,
  // not missing data. Read as "unknown" it turns thousands of pre-2026-08-28
  // rows into evidence someone believes a re-scrape could recover, which is
  // how #1066's over-count got argued for in the first place.
  assert.match(HEADER, /ITS BLANK IS NOT UNKNOWN/);
  assert.match(HEADER, /NEVER hand-edit a row/);
  assert.match(HEADER, /SUPERSEDED GENERATIONS ARE A SEPARATE POPULATION/);
  assert.match(HEADER, /OPAQUE JOIN KEY/);
  // The corpus spans both transcript depths. A reader who assumes the flat half
  // only would under-count every review role by roughly half.
  assert.match(HEADER, /workflows\/wf_/);
});

test("the blank-subagent_type wording says what blank means on omp, in the header and the script alike", () => {
  // An untyped dispatch records the generic `task`; blank is only a transcript
  // with no `session_init` agent to read. Both places that restate the column
  // must say so, and neither may call a blank an untyped dispatch.
  const SRC = readFileSync(join(import.meta.dirname, "member-outcomes.mjs"), "utf8");
  const flat = (s) => s.replace(/^\/\/ ?|^# ?/gm, "").replace(/\s+/g, " ");
  for (const [where, text] of [["header", flat(HEADER)], ["script", flat(SRC)]]) {
    assert.match(text, /no `session_init` agent to read/, `${where}: blank's cause`);
    assert.match(text, /records the generic `task`/, `${where}: untyped dispatch's record`);
    assert.doesNotMatch(text, /named no (agent )?definition/, `${where}: stale wording`);
    assert.doesNotMatch(text, /untyped Task call/, `${where}: stale wording`);
  }
});

test("the header's awk read-out indexes the column it names", () => {
  // Read the `$n` reference out of the header's own awk line and resolve it
  // against COLUMNS — a fact about the CODE alone (COLUMNS[4]) stays green when
  // the header is repointed. Mutation this must survive: changing the `$n` in
  // the header without changing COLUMNS.
  const byModel = headerLines.find((l) => /\{n\[\$\d+\]\+\+\}/.test(l));
  assert.ok(byModel, "header lost its rows-by-model read-out");
  assert.equal(COLUMNS[/\{n\[\$(\d+)\]\+\+\}/.exec(byModel)[1] - 1], "model");
});

// The comparison count is cell-readout.mjs's, and the header only points at it:
// a second copy of the definition as a runnable query is two countings free to
// drift apart, which is how the pre-cell pair query came to count pairs no cell
// owns once the cell grid replaced the two definitions it keyed on.
test("the header points at cell-readout.mjs for a cell's comparisons and carries no query of its own", () => {
  const invocation = headerLines.find((l) => /^#\s+node \S*cell-readout\.mjs\s*$/.test(l));
  assert.ok(invocation, "header lost its `node plugin/scripts/cell-readout.mjs` pointer");
  const script = invocation.replace(/^#\s+node\s+/, "").trim();
  assert.equal(script, "plugin/scripts/cell-readout.mjs");
  assert.ok(existsSync(join(REPO, script)), `the header points at ${script}, which does not exist`);
  // The pointer is runnable as written, from the repo root, against this
  // repo's own metrics files.
  const r = spawnSync(process.execPath, [script], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);

  assert.doesNotMatch(HEADER, /fleet-implementer-alt\$\//, "the header still carries the pre-cell pair query");
  const subagentType = new RegExp(`\\$${COLUMNS.indexOf("subagent_type") + 1}(?!\\d)`);
  assert.ok(
    !headerLines.some((l) => subagentType.test(l)),
    "an awk read-out over `subagent_type` is a second counting of comparisons",
  );

  // The definition the header states is the one the script applies.
  const block = HEADER.replace(/^#\s?/gm, "").replace(/\s+/g, " ");
  assert.match(block, /a comparison is one session holding an ADMISSIBLE row at X and an admissible slow-high row whose resolved \(`model`, `effort`\) differ from the X row's/);
  assert.match(block, /admissible only when its `subagent_type` is `fleet-implementer-<chosen_cell>` and its `effort` is the cell's level/);
  assert.match(block, /joined to its row here on `session`\+`agent`/);
  const gate = /at least (\w+) comparisons across (\w+) or more distinct `run_date`s/.exec(block);
  assert.ok(gate, "the header no longer states the gate");
  const words = { five: 5, ten: 10 };
  assert.deepEqual({ comparisons: words[gate[1]], runDates: words[gate[2]] }, { ...GATE }, "the header's gate is not cell-readout.mjs's GATE");
  assert.match(block, /`<cell> <comparisons> <run_dates> <resolved models>`/);
  assert.match(block, /`mixed \(<model-a> n=…, <model-b> n=…\)`/);
});

test("the header names a producer script that exists", () => {
  const producer = /produced by (\S+\.mjs)/.exec(HEADER);
  assert.ok(producer, "the header no longer names the script that produces its rows");
  assert.ok(existsSync(join(REPO, producer[1])), `the header names ${producer[1]} as its producer, which does not exist`);
  assert.equal(producer[1], "plugin/scripts/member-outcomes.mjs");
});
