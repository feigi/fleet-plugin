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

// Signal 3 reads each implementer's own transcript, SESSION_DIR/<member>.jsonl,
// through first_last_ts(); implementer_intervals() is that collection. Here
// SESSION_DIR points into this test's own directory.
const VALID = '{"timestamp":"2026-09-18T15:05:00.000Z"}\n{"timestamp":"2026-09-18T16:00:00.000Z"}\n';

function sessionDir(prefix, transcripts) {
  const dir = tempDir(prefix);
  for (const [member, text] of Object.entries(transcripts)) writeFileSync(join(dir, `${member}.jsonl`), text);
  return dir;
}

const FIRST_LAST = `
print(json.dumps(mod.first_last_ts(mod.Path(sys.argv[2]))))
`;

test("first_last_ts() returns (None, None) for a missing transcript and for one with no parseable line", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  const dir = sessionDir("derive-first-last-", { garbage: "garbage\n{bad\n" });
  assert.deepEqual(python(FIRST_LAST, [join(dir, "missing.jsonl")]), [null, null]);
  assert.deepEqual(python(FIRST_LAST, [join(dir, "garbage.jsonl")]), [null, null]);
});

test("first_last_ts() skips garbage lines between timestamped ones and keeps the real first and last", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  const dir = sessionDir("derive-first-last-mixed-", {
    mixed: 'garbage\n{"timestamp":"2026-09-18T15:05:00.000Z"}\n{bad\n{"type":"x"}\n{"timestamp":"2026-09-18T16:00:00.000Z"}\ngarbage\n',
  });
  assert.deepEqual(python(FIRST_LAST, [join(dir, "mixed.jsonl")]),
    ["2026-09-18T15:05:00.000Z", "2026-09-18T16:00:00.000Z"]);
});

test("first_last_ts()'s per-line guard catches only a JSON decode error", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  const dir = sessionDir("derive-first-last-guard-", { m: VALID });
  const body = `
def loads(_s):
    raise RuntimeError("not a decode error")
mod.json.loads = loads
mod.first_last_ts(mod.Path(sys.argv[2]))
`;
  const r = runPython(body, [join(dir, "m.jsonl")]);
  assert.notEqual(r.status, 0, `expected the RuntimeError to escape, got exit 0 with ${r.stdout}`);
  assert.match(r.stderr, /RuntimeError: not a decode error/);
});

const INTERVALS = `
import contextlib, io
mod.SESSION_DIR = mod.Path(sys.argv[2])
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    intervals, skipped = mod.implementer_intervals(json.loads(sys.argv[3]))
print(json.dumps({"intervals": [[s.isoformat(), e.isoformat()] for s, e in intervals],
                  "skipped": skipped, "out": buf.getvalue()}))
`;

const VALID_INTERVAL = [["2026-09-18T15:05:00+00:00", "2026-09-18T16:00:00+00:00"]];

test("implementer_intervals() names the implementers whose transcript gave no timestamps in one WARNING, and leaves them out of the intervals", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  const dir = sessionDir("derive-intervals-", { "impl-1": VALID, "impl-2": "garbage\n{bad\n" });
  const rows = [
    { role: "implementer", member: "impl-1" },
    { role: "implementer", member: "impl-2" },
    { role: "implementer", member: "impl-3" },
    // A non-implementer with no transcript is not Signal 3's, so not named.
    { role: "reviewer", member: "snapshot-9" },
  ];
  const got = python(INTERVALS, [dir, JSON.stringify(rows)]);
  assert.deepEqual(got.intervals, VALID_INTERVAL);
  assert.deepEqual(got.skipped, ["impl-2", "impl-3"]);
  const warnings = got.out.split("\n").filter((l) => l.includes("WARNING:"));
  assert.equal(warnings.length, 1, `expected one WARNING line, got ${JSON.stringify(got.out)}`);
  assert.match(warnings[0], /^ {2}WARNING: 2 implementer\(s\) .*counted idle.*: impl-2, impl-3$/);
});

test("implementer_intervals() prints nothing when every implementer's transcript gave timestamps", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  const dir = sessionDir("derive-intervals-clean-", { "impl-1": VALID });
  const got = python(INTERVALS, [dir, JSON.stringify([{ role: "implementer", member: "impl-1" }])]);
  assert.deepEqual(got, { intervals: VALID_INTERVAL, skipped: [], out: "" });
});
