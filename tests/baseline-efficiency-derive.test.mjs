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
// calls neither node nor gh) and pin that copy against the scraper's COLUMNS.
const SCRIPT = new URL("../docs/research/baseline-efficiency-derive.py", import.meta.url).pathname;

const LOAD = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("derive", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
`;

function python(body, args) {
  // PYTHONDONTWRITEBYTECODE: loading the script would otherwise write a
  // __pycache__/ into docs/research/ of the checkout under test.
  const r = spawnSync("python3", ["-c", LOAD + body, SCRIPT, ...args], {
    encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(r.status, 0, `python3 failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// scrape_member_outcomes() runs the scraper into a fixed TSV path, then reads
// that file. Here `subprocess.run` writes a fixture to the `--file` it was
// handed and `Path` points the fixed path into this test's own directory.
// The fixture holds one full-width row and nothing else: what the script does
// with a row of any other width is #3465's to decide, so this test pins none.
test("the derive script's COLUMNS is member-outcomes.mjs's COLUMNS, and scrape_member_outcomes() keys a full-width row by it", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  assert.deepEqual(python("print(json.dumps(mod.COLUMNS))", []), COLUMNS);

  const dir = tempDir("derive-columns-");
  const full = COLUMNS.map((c) => `v-${c}`).join("\t");
  const fixture = join(dir, "fixture.tsv");
  writeFileSync(fixture, `# ${COLUMNS.join("\t")}\n${full}\n`);

  const rows = python(`
import shutil
fixture, out = sys.argv[2], sys.argv[3]
def run(argv, **kw):
    shutil.copyfile(fixture, argv[argv.index("--file") + 1])
mod.subprocess.run = run
real_path = mod.Path
mod.Path = lambda _p: real_path(out)
print(json.dumps(mod.scrape_member_outcomes()))
`, [fixture, join(dir, "out.tsv")]);

  assert.deepEqual(rows, [Object.fromEntries(COLUMNS.map((c) => [c, `v-${c}`]))]);
});
