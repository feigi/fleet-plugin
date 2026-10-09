// `ledger.mjs rotate`: one ledger per run. The current file is archived
// byte-for-byte beside itself and nothing is carried forward, so the next
// write starts the empty skeleton. Every call is its own process against a
// scratch `--file` ledger; the heartbeat mark and the controller record the
// liveness guard reads are the `heartbeat.json` in the same directory, which
// is where fleet-state.mjs keeps it beside the real `.fleet/ledger.md`.
//
// Every call reads its process tree from a FLEET_PROC_TABLE fixture, never
// from `ps`: this suite runs under live omp sessions, whose omp the real walk
// would find. The table's walk starts at the test runner's own pid, which is
// the spawned script's parent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stallsAt } from "../plugin/scripts/fleet-state.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

const LEDGER = [
  "# Fleet run ledger", "", "## Rows", "", "- #7 impl-7=killed", "- #8 excluded · behind-pr:#9", "",
  "## Dispatched", "", "- impl-7=killed", "", "## Filed", "", "- #11 a filed subject", "",
  "## Ruled", "", "- #9 merge as is", "", "## Drain", "", "- budget", "",
].join("\n");

const STAMPED = /^ledger\.\d{4}-\d{2}-\d{2}T\d{6}Z\.md$/;
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "");

// Pids no real process is likely to hold. Only the table names them, and the
// script reads them only through the table.
const OMP = 2_000_000_001, OUTER_OMP = 2_000_000_002;
const OMP_CHAIN = {
  [process.pid]: { ppid: OMP, argv: [process.execPath, "--test"], lstart: "runner-start" },
  [OMP]: { ppid: OUTER_OMP, argv: ["bun", "/home/u/.bun/bin/omp", "--resume", "x"], lstart: "omp-start" },
  [OUTER_OMP]: { ppid: 1, argv: ["/usr/local/bin/omp"], lstart: "outer-start" },
};
const NO_OMP = { [process.pid]: { ppid: 1, argv: [process.execPath, "--test"], lstart: "runner-start" } };

function fixture(t, { ledger = LEDGER, mark = null, controller = null, table = OMP_CHAIN, extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-rotate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ledger.md");
  if (ledger !== null) writeFileSync(file, ledger);
  const beatFile = join(dir, "heartbeat.json");
  if (mark !== null || controller !== null) {
    writeFileSync(beatFile, JSON.stringify({ quiet: 0, elapsed: 0, digest: "", ...extra, ...mark, ...(controller ? { controller } : {}) }));
  }
  const tableFile = join(dir, "proc-table.json");
  writeFileSync(tableFile, JSON.stringify(table));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env = { ...process.env, PATH: bin, FLEET_PROC_TABLE: tableFile };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const cli = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { encoding: "utf8", env: { ...env, ...extraEnv }, cwd: dir });
  const archives = () => readdirSync(dir).filter((n) => STAMPED.test(n)).sort();
  const state = () => JSON.parse(readFileSync(beatFile, "utf8"));
  const raw = () => (existsSync(beatFile) ? readFileSync(beatFile, "utf8") : null);
  return { dir, file, cli, archives, state, raw };
}

// A live process that is no ancestor of the script: the foreign controller.
function liveForeign(t) {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  return child.pid;
}

// A pid whose process has exited and been reaped.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

const beat = (agoMs, interval = 300, stopped = "") => ({ beat: { at: Date.now() - agoMs, interval, stopped } });

test("rotate with no heartbeat mark moves the ledger byte-identical to ledger.<UTC stamp>.md, and the next write starts the empty skeleton", (t) => {
  const f = fixture(t);
  const before = Date.now();
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const [archive] = f.archives();
  assert.ok(archive, `no stamped archive in ${readdirSync(f.dir)}`);
  const at = Date.parse(archive.slice("ledger.".length, -".md".length).replace(/T(\d\d)(\d\d)(\d\d)Z$/, "T$1:$2:$3Z"));
  assert.ok(at >= Math.floor(before / 1000) * 1000 && at <= Date.now(), `${archive} is not a UTC stamp of this call`);
  assert.deepEqual(JSON.parse(r.stdout), { rotated: true, archive: join(f.dir, archive) });
  assert.equal(readFileSync(join(f.dir, archive), "utf8"), LEDGER, "the archive must be the ledger's own bytes");
  assert.equal(existsSync(f.file), false, "rotate must leave no ledger behind");

  const w = f.cli(["row", "12", "impl-12"]);
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual(JSON.parse(f.cli(["read"]).stdout), { rows: ["#12 impl-12"], filed: [], ruled: [], dispatched: [], drain: null });
  assert.equal(readFileSync(join(f.dir, archive), "utf8"), LEDGER, "a later write must not land in the archive");
});

test("rotate archives a ledger the readers refuse, as-is", (t) => {
  const bad = `${LEDGER}- a second marker\n`;
  const f = fixture(t, { ledger: bad });
  assert.equal(f.cli(["read"]).status, 2, "the fixture must be a ledger load() refuses");
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(f.dir, f.archives()[0]), "utf8"), bad);
});

test("rotate proceeds under a stalled mark and under a recorded stop", (t) => {
  for (const mark of [beat(11 * 60_000), beat(10_000, 300, "budget exhausted"), { ...beat(11 * 60_000), ticked: { at: Date.now() - 60 * 60_000 } }]) {
    const f = fixture(t, { mark });
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 0, `${JSON.stringify(mark)}: ${r.stderr}`);
    assert.equal(f.archives().length, 1);
    assert.equal(existsSync(f.file), false);
  }
});

test("rotate refuses while the previous controller is beating, naming the last beat and when it would count as stalled", (t) => {
  // A fresh beat, and a stale beat covered by a fresh tick — both read as
  // beating to fleet-state.mjs's assessBeat.
  for (const mark of [beat(10_000), { ...beat(11 * 60_000), ticked: { at: Date.now() - 5_000 } }]) {
    const f = fixture(t, { mark });
    const r = f.cli(["rotate"]);
    assert.notEqual(r.status, 0, `${JSON.stringify(mark)}: rotated under a live controller`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(`last beat ${new Date(mark.beat.at).toISOString()}`));
    const stalls = new Date(stallsAt({ beat: mark.beat, ticked: mark.ticked ?? null })).toISOString();
    assert.match(r.stderr, new RegExp(`stalled after ${stalls.replaceAll(".", "\\.")}`));
    assert.equal(readFileSync(f.file, "utf8"), LEDGER, "a refusal must not touch the ledger");
    assert.deepEqual(f.archives(), []);
  }
});

test("rotate refuses when the archive name already exists, moving nothing", (t) => {
  const f = fixture(t);
  // Every second this call can plausibly land on is taken.
  const now = Date.now();
  for (let s = 0; s < 30; s++) writeFileSync(join(f.dir, `ledger.${stamp(now + s * 1000)}.md`), "older archive\n");
  const r = f.cli(["rotate"]);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /refusing to rotate .* already exists/);
  assert.equal(readFileSync(f.file, "utf8"), LEDGER);
  for (const a of f.archives()) assert.equal(readFileSync(join(f.dir, a), "utf8"), "older archive\n");
});

test("rotate with no ledger file says there is nothing to rotate and exits 0", (t) => {
  const f = fixture(t, { ledger: null });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /nothing to rotate/);
  assert.deepEqual(JSON.parse(r.stdout), { rotated: false, archive: null });
  assert.deepEqual(f.archives(), []);
  assert.equal(existsSync(f.file), false);
});

test("rotate refuses a stray argument — an imagined --dry-run — moving nothing", (t) => {
  const f = fixture(t);
  for (const extra of ["--dry-run", "now"]) {
    const r = f.cli(["rotate", extra]);
    assert.equal(r.status, 2, `${extra}: ${r.stderr}`);
    assert.match(r.stderr, /usage: ledger\.mjs rotate/);
    assert.equal(readFileSync(f.file, "utf8"), LEDGER);
    assert.deepEqual(f.archives(), []);
  }
});

test("rotate takes the write lock: a live holder keeps it from moving the file", (t) => {
  const f = fixture(t);
  writeFileSync(`${f.file}.lock`, String(process.pid));
  const r = f.cli(["rotate"], { LEDGER_LOCK_TIMEOUT_MS: "200" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cannot lock/);
  assert.equal(readFileSync(f.file, "utf8"), LEDGER);
  assert.deepEqual(f.archives(), []);
});

// ── the controller record ────────────────────────────────────────────────────

const FRESH = beat(10_000);
const STALE = { ...beat(4 * 24 * 60 * 60_000), ticked: { at: Date.now() - 16 * 60 * 60_000 } };
const OURS = { pid: OMP, lstart: "omp-start" };

test("rotate refuses a live foreign controller whose start time matches, whatever the mark says — exit 2, nothing moved, nothing written", (t) => {
  const pid = liveForeign(t);
  const table = { ...OMP_CHAIN, [pid]: { ppid: 1, argv: ["sleep", "300"], lstart: "foreign-start" } };
  for (const [label, mark] of [["stale", STALE], ["beating", FRESH], ["no mark", {}]]) {
    const f = fixture(t, { mark, table, controller: { pid, lstart: "foreign-start", prior: "none" } });
    const before = f.raw();
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 2, `${label}: rotated a live controller's ledger: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(`refusing to rotate .*controller pid ${pid}.* is alive`));
    assert.equal(readFileSync(f.file, "utf8"), LEDGER, `${label}: a refusal must not touch the ledger`);
    assert.deepEqual(f.archives(), []);
    assert.equal(f.raw(), before, `${label}: a refusal must not rewrite the record`);
  }
});

test("rotate rotates when the recorded controller is dead, and records this run's omp with prior dead", (t) => {
  const f = fixture(t, { mark: FRESH, controller: { pid: deadPid(), lstart: "whatever", prior: "none" } });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.archives().length, 1);
  assert.equal(existsSync(f.file), false);
  assert.deepEqual(f.state().controller, { ...OURS, prior: "dead" });
});

test("rotate reads a live pid whose start time differs as a reused pid: dead, rotated, prior dead", (t) => {
  const pid = liveForeign(t);
  const table = { ...OMP_CHAIN, [pid]: { ppid: 1, argv: ["sleep", "300"], lstart: "foreign-start" } };
  const f = fixture(t, { mark: FRESH, table, controller: { pid, lstart: "an earlier process", prior: "ancestor" } });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.archives().length, 1);
  assert.deepEqual(f.state().controller, { ...OURS, prior: "dead" });
});

test("rotate reads a recorded controller that is a live process the table cannot date as dead", (t) => {
  // `ps` prints no start time only for a process that is gone; a pid that
  // isDead() still calls alive but has no start time has exited in between.
  const pid = liveForeign(t);
  const f = fixture(t, { mark: FRESH, controller: { pid, lstart: "foreign-start", prior: "none" } });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.state().controller, { ...OURS, prior: "dead" });
});

test("rotate rotates under its own ancestor, at any depth, even while the mark is beating, with prior ancestor", (t) => {
  // isDead() is real, so a recorded ancestor must be a live process: the test
  // runner itself (the script's parent), and a live process the table places
  // two levels further up, above the nearest omp.
  const deep = liveForeign(t);
  const table = {
    ...OMP_CHAIN,
    [OMP]: { ...OMP_CHAIN[OMP], ppid: deep },
    [deep]: { ppid: 1, argv: ["/usr/local/bin/omp"], lstart: "deep-start" },
  };
  for (const [ancestor, lstart] of [[process.pid, "runner-start"], [deep, "deep-start"]]) {
    const f = fixture(t, { mark: FRESH, table, controller: { pid: ancestor, lstart, prior: "dead" } });
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 0, `${ancestor}: ${r.stderr}`);
    assert.equal(f.archives().length, 1);
    assert.equal(existsSync(f.file), false);
    assert.deepEqual(f.state().controller, { ...OURS, prior: "ancestor" });
  }
});

test("rotate with no record keeps the mark check — refused while beating, nothing written — and records prior none when it rotates", (t) => {
  const refused = fixture(t, { mark: FRESH });
  const before = refused.raw();
  const r = refused.cli(["rotate"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /still beating/);
  assert.equal(readFileSync(refused.file, "utf8"), LEDGER);
  assert.equal(refused.raw(), before, "a refusal must not write a record");

  for (const mark of [STALE, {}]) {
    const f = fixture(t, { mark });
    const ok = f.cli(["rotate"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(f.archives().length, 1);
    assert.deepEqual(f.state().controller, { ...OURS, prior: "none" });
  }
  const none = fixture(t);
  assert.equal(none.raw(), null, "the fixture must start with no state file");
  assert.equal(none.cli(["rotate"]).status, 0);
  assert.deepEqual(none.state().controller, { ...OURS, prior: "none" });
});

test("rotate reads a malformed record as no record", (t) => {
  for (const controller of [{ pid: "29405", lstart: "x" }, { pid: 0, lstart: "x" }, { pid: process.pid, lstart: "" }, { lstart: "x" }, "29405"]) {
    const f = fixture(t, { mark: STALE, controller });
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 0, `${JSON.stringify(controller)}: ${r.stderr}`);
    assert.deepEqual(f.state().controller, { ...OURS, prior: "none" });
  }
});

test("rotate records the controller also when there was no ledger to rotate", (t) => {
  const f = fixture(t, { ledger: null, mark: STALE, controller: { pid: deadPid(), lstart: "x", prior: "none" } });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { rotated: false, archive: null });
  assert.deepEqual(f.state().controller, { ...OURS, prior: "dead" });
});

test("rotate with no ledger and no record exits 0 under a beating mark, as before, and still records the controller", (t) => {
  const f = fixture(t, { ledger: null, mark: FRESH });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { rotated: false, archive: null });
  assert.deepEqual(f.state().controller, { ...OURS, prior: "none" });
});

test("rotate with no ledger still refuses to replace a live foreign controller's record", (t) => {
  const pid = liveForeign(t);
  const table = { ...OMP_CHAIN, [pid]: { ppid: 1, argv: ["sleep", "300"], lstart: "foreign-start" } };
  const f = fixture(t, { ledger: null, mark: STALE, table, controller: { pid, lstart: "foreign-start", prior: "none" } });
  const before = f.raw();
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(f.raw(), before);
  assert.equal(existsSync(f.file), false);
});

test("rotate records the NEAREST omp ancestor — argv[0] or argv[1] named exactly omp — and its start time", (t) => {
  const near = 2_000_000_011, sh = 2_000_000_012;
  const table = {
    [process.pid]: { ppid: sh, argv: [process.execPath, "fleet-run", "ledger.mjs"], lstart: "runner-start" },
    [sh]: { ppid: near, argv: ["sh", "-c", "omp"], lstart: "sh-start" },
    [near]: { ppid: OMP, argv: ["/opt/bin/omp"], lstart: "near-start" },
    ...Object.fromEntries(Object.entries(OMP_CHAIN).filter(([p]) => Number(p) !== process.pid)),
  };
  const f = fixture(t, { table });
  assert.equal(f.cli(["rotate"]).status, 0);
  assert.deepEqual(f.state().controller, { pid: near, lstart: "near-start", prior: "none" });

  // A file name that merely contains `omp`, and `omp` in a later argument, are not omp.
  const lookalikes = {
    [process.pid]: { ppid: 2_000_000_021, argv: [process.execPath, "--test"], lstart: "runner-start" },
    2_000_000_021: { ppid: 2_000_000_022, argv: ["/usr/bin/ompd"], lstart: "a" },
    2_000_000_022: { ppid: 2_000_000_023, argv: ["bun", "/x/omp.js"], lstart: "b" },
    2_000_000_023: { ppid: 1, argv: ["node", "script.mjs", "omp"], lstart: "c" },
  };
  const g = fixture(t, { table: lookalikes });
  assert.equal(g.cli(["rotate"]).status, 0);
  assert.equal("controller" in g.state(), false, `${JSON.stringify(g.state())}: a look-alike was taken for omp`);
});

test("rotate with no omp ancestor removes an older record, and every other key in the file survives", (t) => {
  const extra = { quiet: 3, elapsed: 40, digest: "d1", note: "not ours" };
  const mark = STALE;
  const f = fixture(t, { table: NO_OMP, mark, extra, controller: { pid: deadPid(), lstart: "x", prior: "none" } });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const after = f.state();
  assert.equal("controller" in after, false, "an older run's record must not outlive the run that should have replaced it");
  assert.deepEqual(after, { ...extra, ...mark });

  const g = fixture(t, { mark, extra, controller: { pid: deadPid(), lstart: "x", prior: "none" } });
  assert.equal(g.cli(["rotate"]).status, 0);
  assert.deepEqual(g.state(), { ...extra, ...mark, controller: { ...OURS, prior: "dead" } });
});

test("rotate refuses, moving nothing, when the process table cannot be read", (t) => {
  // No FLEET_PROC_TABLE and no `ps` on PATH: a controller that cannot be
  // judged is never judged dead.
  const pid = liveForeign(t);
  const f = fixture(t, { mark: STALE, controller: { pid, lstart: "foreign-start", prior: "none" } });
  const before = f.raw();
  const r = f.cli(["rotate"], { FLEET_PROC_TABLE: "" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cannot read the process table/);
  assert.equal(readFileSync(f.file, "utf8"), LEDGER);
  assert.deepEqual(f.archives(), []);
  assert.equal(f.raw(), before);
});
