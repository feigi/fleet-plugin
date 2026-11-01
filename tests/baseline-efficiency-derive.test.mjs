import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tempDir } from "./support/temp-dir.mjs";
import { COLUMNS } from "../plugin/scripts/member-outcomes.mjs";

// docs/research/baseline-efficiency-derive.py reads the TSV that
// plugin/scripts/member-outcomes.mjs writes, through its own copy of the
// column list. These tests load the script as a module (its `main()` sits
// behind `if __name__ == "__main__"`, so importing it reads no transcript and
// calls neither node nor gh), pin that copy against the scraper's COLUMNS, and
// pin that a row of any other width stops the scrape instead of being skipped.
const SCRIPT = new URL("../docs/research/baseline-efficiency-derive.py", import.meta.url).pathname;

const LOAD = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("derive", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
`;

function runPython(body, args) {
  // PYTHONDONTWRITEBYTECODE: loading the script would otherwise write a
  // __pycache__/ into docs/research/ of the checkout under test.
  return spawnSync("python3", ["-c", LOAD + body, SCRIPT, ...args], {
    encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
}

function python(body, args) {
  const r = runPython(body, args);
  assert.equal(r.status, 0, `python3 failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// scrape_member_outcomes() runs the scraper into a fixed TSV path, then reads
// that file. Here `subprocess.run` writes a fixture to the `--file` it was
// handed and `Path` points the fixed path into this test's own directory.
const SCRAPE = `
import shutil
fixture, out = sys.argv[2], sys.argv[3]
def run(argv, **kw):
    shutil.copyfile(fixture, argv[argv.index("--file") + 1])
mod.subprocess.run = run
real_path = mod.Path
mod.Path = lambda _p: real_path(out)
print(json.dumps(mod.scrape_member_outcomes()))
`;

// Writes `tsv` as the fixture; returns the [fixture, out] argv SCRAPE reads.
function fixtureArgs(prefix, tsv) {
  const dir = tempDir(prefix);
  const fixture = join(dir, "fixture.tsv");
  writeFileSync(fixture, tsv);
  return [fixture, join(dir, "out.tsv")];
}

const FULL = COLUMNS.map((c) => `v-${c}`).join("\t");

test("the derive script's COLUMNS is member-outcomes.mjs's COLUMNS, and scrape_member_outcomes() keys a full-width row by it", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  assert.deepEqual(python("print(json.dumps(mod.COLUMNS))", []), COLUMNS);

  // A `#` line and a blank line around the full-width row stay skipped.
  const rows = python(SCRAPE, fixtureArgs("derive-columns-", `# ${COLUMNS.join("\t")}\n\n${FULL}\n`));
  assert.deepEqual(rows, [Object.fromEntries(COLUMNS.map((c) => [c, `v-${c}`]))]);
});

// A row one cell short and a row one cell too wide each stop the scrape: a
// guard that refused only short rows, or only wide ones, fails one case.
for (const [label, width] of [["short", COLUMNS.length - 1], ["too-wide", COLUMNS.length + 1]]) {
  test(`scrape_member_outcomes() exits non-zero on a ${label} row, naming both widths and the producer`, (t) => {
    if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
    const bad = Array.from({ length: width }, (_, i) => `x${i}`).join("\t");
    const r = runPython(SCRAPE, fixtureArgs(`derive-${label}-`, `# ${COLUMNS.join("\t")}\n${FULL}\n${bad}\n`));
    assert.notEqual(r.status, 0, `expected a refusal, got exit 0 with ${r.stdout}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(`malformed row: ${width} fields, expected ${COLUMNS.length}\\b`));
    assert.match(r.stderr, /COLUMNS .*plugin\/scripts\/member-outcomes\.mjs/);
  });
}
