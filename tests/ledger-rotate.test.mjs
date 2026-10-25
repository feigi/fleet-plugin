// `ledger.mjs rotate`: one ledger per run. The current file is archived
// byte-for-byte beside itself. After a `dead` or `none` verdict nothing is
// carried forward, so the next write starts the empty skeleton; after an
// `ancestor` one the rows and `## Dispatched` entries still live are written
// into a new ledger. Every call is its own process against a
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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stallsAt } from "../plugin/scripts/fleet-state.mjs";
import { rendering, renderBrief } from "./support/rendered-brief.mjs";
import { writeQueueGh } from "./support/queue-gh.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

const LEDGER = [
  "# Fleet run ledger", "", "## Rows", "", "- #7 impl-7=killed", "- #8 excluded · behind-pr:#9", "",
  "## Dispatched", "", "- impl-7=killed", "", "## Filed", "", "- #11 a filed subject", "",
  "## Ruled", "", "- #9 merge as is", "", "## Drain", "", "- budget", "",
].join("\n");

const STAMPED = /^ledger\.\d{4}-\d{2}-\d{2}T\d{6}Z\.md$/;
const NOTHING_CARRIED = { carried: { rows: [], dispatched: [] }, retired: [], skipped: [] };
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
    writeFileSync(beatFile, JSON.stringify({ quiet: 0, digest: "", ...extra, ...mark, ...(controller ? { controller } : {}) }));
  }
  const tableFile = join(dir, "proc-table.json");
  writeFileSync(tableFile, JSON.stringify(table));
  // The one program on PATH: the gh `dispatch merge-bot` lists the queue
  // with, answering an empty one.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeQueueGh(bin);
  const env = { ...process.env, PATH: bin, FLEET_PROC_TABLE: tableFile };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const cli = rendering(dir, (args, extraEnv = {}) =>
    spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { encoding: "utf8", env: { ...env, ...extraEnv }, cwd: dir }), (call) => call[0]);
  const archives = () => readdirSync(dir).filter((n) => STAMPED.test(n)).sort();
  const state = () => JSON.parse(readFileSync(beatFile, "utf8"));
  const raw = () => (existsSync(beatFile) ? readFileSync(beatFile, "utf8") : null);
  // The record rotate wrote, less its `at`, which is checked here once: the
  // instant of this call's write, so a reader can tell a mark written since
  // from one the previous run left.
  const ctl = () => {
    const { at, ...rest } = state().controller;
    assert.ok(Number.isInteger(at) && at <= Date.now() && at > Date.now() - 60_000, `controller.at ${at} is not this call's write time`);
    return rest;
  };
  // The same call under a file-size ceiling of `blocks` 512-byte blocks.
  const cliCapped = (args, blocks) =>
    spawnSync("/bin/sh", ["-c", `ulimit -f ${blocks}; exec "$0" "$@"`, process.execPath, SCRIPT, "--file", file, ...args], { encoding: "utf8", env, cwd: dir });
  return { dir, file, cli, cliCapped, archives, state, raw, ctl };
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

// The refusal over a heartbeat file rotate cannot judge, whole: the cause that
// fired, and what removing the file costs. It never prints this run's own omp
// pid or start time — a value to copy into a hand-written record.
const REFUSAL_TAIL = " — repair it so its controller record is intact. Removing it makes this rotate judge none: if the previous run was this omp session's, its live members and retired names are not carried forward, so this run can dispatch onto their work and reuse their names.";
const refusal = (f, cause) => `refusing to rotate ${f.file}: ${join(f.dir, "heartbeat.json")} ${cause}${REFUSAL_TAIL}`;

test("rotate with no heartbeat mark moves the ledger byte-identical to ledger.<UTC stamp>.md, and the next write starts the empty skeleton", (t) => {
  const f = fixture(t);
  const before = Date.now();
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const [archive] = f.archives();
  assert.ok(archive, `no stamped archive in ${readdirSync(f.dir)}`);
  const at = Date.parse(archive.slice("ledger.".length, -".md".length).replace(/T(\d\d)(\d\d)(\d\d)Z$/, "T$1:$2:$3Z"));
  assert.ok(at >= Math.floor(before / 1000) * 1000 && at <= Date.now(), `${archive} is not a UTC stamp of this call`);
  assert.deepEqual(JSON.parse(r.stdout), { rotated: true, archive: join(f.dir, archive), ...NOTHING_CARRIED });
  assert.equal(readFileSync(join(f.dir, archive), "utf8"), LEDGER, "the archive must be the ledger's own bytes");
  assert.equal(existsSync(f.file), false, "rotate must leave no ledger behind");

  const w = f.cli(["row", "12", "impl-12"]);
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual(JSON.parse(f.cli(["read"]).stdout), { rows: ["#12 impl-12"], filed: [], ruled: [], dispatched: [], briefs: {}, queued: {}, agents: {}, drain: null, retired: [] });
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

test("rotate refuses while the previous controller is beating or acting, naming its latest mark and when it would count as stalled", (t) => {
  // A fresh beat, a stale beat covered by a fresh tick, and one covered by a
  // fresh ledger write — all read as beating to fleet-state.mjs's assessBeat.
  const cases = [
    [beat(10_000), "beat", (m) => m.beat.at],
    [{ ...beat(11 * 60_000), ticked: { at: Date.now() - 5_000 } }, "tick", (m) => m.ticked.at],
    [{ ...beat(11 * 60_000), ticked: { at: Date.now() - 50 * 60_000 }, acted: { at: Date.now() - 5_000 } }, "ledger write", (m) => m.acted.at],
  ];
  for (const [mark, what, latest] of cases) {
    const f = fixture(t, { mark });
    const r = f.cli(["rotate"]);
    assert.notEqual(r.status, 0, `${JSON.stringify(mark)}: rotated under a live controller`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /still beating or acting/);
    assert.match(r.stderr, new RegExp(`last ${what} ${new Date(latest(mark)).toISOString().replaceAll(".", "\\.")}`));
    const stalls = new Date(stallsAt({ beat: mark.beat, ticked: mark.ticked ?? null, acted: mark.acted ?? null })).toISOString();
    assert.match(r.stderr, new RegExp(`stalled after ${stalls.replaceAll(".", "\\.")}`));
    assert.equal(readFileSync(f.file, "utf8"), LEDGER, "a refusal must not touch the ledger");
    assert.deepEqual(f.archives(), []);
  }
});

test("rotate stamps `acted` in the same write as its controller record, and every other write subcommand stamps it too", (t) => {
  const f = fixture(t);
  assert.equal(f.cli(["rotate"]).status, 0);
  const { controller, acted } = f.state();
  assert.deepEqual(acted, { at: controller.at });
  const writes = [
    ["row", "12", "impl-12"], ["filed", "40", "a subject"], ["ruled", "41", "merge as is"],
    ["dispatch", "merge-bot"], ["settle", "merge-bot-1=done"],
    ["review", "41", "review=member:review-pr-41"], ["drain", "budget"],
  ];
  for (const args of writes) {
    const before = Date.now();
    const r = f.cli(args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    const at = f.state().acted.at;
    assert.ok(at >= before && at <= Date.now(), `${args[0]}: acted.at ${at} is not inside the call`);
    assert.deepEqual(f.state().controller, controller, `${args[0]} must carry the record`);
  }
  // A read writes nothing, and neither does a refused write.
  const stamped = f.raw();
  assert.equal(f.cli(["read"]).status, 0);
  assert.equal(f.cli(["check", "a subject"]).status, 1);
  assert.equal(f.cli(["row", "--bogus", "x"]).status, 2);
  assert.equal(f.raw(), stamped);
});

test("a write subcommand leaves a heartbeat file it cannot read as it is — the record rotate refuses on is not replaced by a stamp", (t) => {
  const f = fixture(t);
  const corrupt = '{ "controller": {"pid": 1, "lstart"';
  writeFileSync(join(f.dir, "heartbeat.json"), corrupt);
  const w = f.cli(["row", "12", "impl-12"]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stderr, /WARNING/);
  assert.equal(f.raw(), corrupt, "the stamp must not overwrite a file readState could not parse");
  assert.ok(JSON.parse(f.cli(["read"]).stdout).rows.includes("#12 impl-12"), "the write itself still lands");
  const r = f.cli(["rotate"]);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(refusal(f, "is not JSON")), r.stderr);
});

test("every writer leaves a heartbeat file whose controller cannot be judged byte-identical, and a same-session rotate afterwards still refuses", (t) => {
  // The state rotate sees after any of them must still be the lost-record state
  // it refuses on, never `none`: a write that replaced the file would drop the
  // key, and the next rotate would carry nothing.
  for (const controller of [{ pid: "29405", lstart: "x" }, null]) {
    const f = fixture(t, { mark: FRESH, extra: { controller } });
    const before = f.raw();
    const w = f.cli(["row", "12", "impl-12"]);
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stderr, /WARNING .* holds a controller record that cannot be judged/);
    assert.equal(f.raw(), before, `${JSON.stringify(controller)}: the ledger stamp must not replace the file`);
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(refusal(f, "holds a controller record that cannot be judged")), r.stderr);
    assert.equal(f.raw(), before, "a refusal must not write a record");
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
  assert.deepEqual(JSON.parse(r.stdout), { rotated: false, archive: null, ...NOTHING_CARRIED });
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
  assert.deepEqual(f.ctl(), { ...OURS, prior: "dead" });
});

test("rotate reads a live pid whose start time differs as a reused pid: dead, rotated, prior dead", (t) => {
  const pid = liveForeign(t);
  const table = { ...OMP_CHAIN, [pid]: { ppid: 1, argv: ["sleep", "300"], lstart: "foreign-start" } };
  const f = fixture(t, { mark: FRESH, table, controller: { pid, lstart: "an earlier process", prior: "ancestor" } });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.archives().length, 1);
  assert.deepEqual(f.ctl(), { ...OURS, prior: "dead" });
});

test("rotate reads a recorded controller that is a live process the table cannot date as dead", (t) => {
  // `ps` prints no start time only for a process that is gone; a pid that
  // isDead() still calls alive but has no start time has exited in between.
  const pid = liveForeign(t);
  const f = fixture(t, { mark: FRESH, controller: { pid, lstart: "foreign-start", prior: "none" } });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.ctl(), { ...OURS, prior: "dead" });
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
    // LEDGER's one member, `impl-7=killed`, is settled on a row nothing live
    // keeps, so it travels as a retired name and nothing else does.
    assert.deepEqual(JSON.parse(r.stdout).carried, { rows: [], dispatched: [] });
    assert.deepEqual(JSON.parse(r.stdout).retired, ["impl-7"]);
    assert.deepEqual(f.ctl(), { ...OURS, prior: "ancestor" });
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
    assert.deepEqual(f.ctl(), { ...OURS, prior: "none" });
  }
  const none = fixture(t);
  assert.equal(none.raw(), null, "the fixture must start with no state file");
  assert.equal(none.cli(["rotate"]).status, 0);
  assert.deepEqual(none.ctl(), { ...OURS, prior: "none" });
});

test("rotate with no record counts a tick or ledger write inside its window with no beat, and lets a recorded stop or all-stale marks through", (t) => {
  const tick = (agoMs) => ({ ticked: { at: Date.now() - agoMs } });
  const act = (agoMs) => ({ acted: { at: Date.now() - agoMs } });
  const refused = [
    ["no beat, fresh tick", tick(5_000), "tick"],
    ["no beat, fresh ledger write", act(5_000), "ledger write"],
    ["stale beat, fresh tick", { ...beat(4 * 24 * 60 * 60_000), ...tick(5_000) }, "tick"],
  ];
  for (const [label, mark, what] of refused) {
    const f = fixture(t, { mark });
    const before = f.raw();
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 2, `${label}: rotated under a controller that is still acting: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`still beating or acting — last ${what} `), label);
    const stalls = new Date(stallsAt({ beat: mark.beat ?? null, ticked: mark.ticked ?? null, acted: mark.acted ?? null })).toISOString();
    assert.match(r.stderr, new RegExp(`stalled after ${stalls.replaceAll(".", "\\.")}`), `${label}: the stall time named is the one still to come`);
    assert.equal(readFileSync(f.file, "utf8"), LEDGER, `${label}: a refusal must not touch the ledger`);
    assert.equal(f.raw(), before, `${label}: a refusal must not write a record`);
    assert.deepEqual(f.archives(), []);
  }
  const proceeds = [
    ["stopped beat, fresh tick", { ...beat(10_000, 300, "budget exhausted"), ...tick(5_000) }],
    ["no beat, stale tick", tick(16 * 60 * 60_000)],
    ["no beat, stale ledger write", act(16 * 60 * 60_000)],
    ["no beat, stale tick and ledger write", { ...tick(16 * 60 * 60_000), ...act(20 * 60 * 60_000) }],
  ];
  for (const [label, mark] of proceeds) {
    const f = fixture(t, { mark });
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.equal(f.archives().length, 1, label);
    assert.deepEqual(f.ctl(), { ...OURS, prior: "none" }, label);
  }
});

test("rotate reads a controller key it cannot judge as a degraded file and refuses, whatever the key holds", (t) => {
  for (const controller of [{ pid: "29405", lstart: "x" }, { pid: 0, lstart: "x" }, { pid: process.pid, lstart: "" }, { lstart: "x" }, "29405", null]) {
    const f = fixture(t, { mark: STALE, extra: { controller } });
    const before = f.raw();
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 2, `${JSON.stringify(controller)}: expected refusal but got: ${r.stderr}`);
    assert.ok(r.stderr.includes(refusal(f, "holds a controller record that cannot be judged")), r.stderr);
    assert.doesNotMatch(r.stderr, /omp-start|2000000001/, "the refusal must not print this run's own pid or start time");
    assert.equal(f.raw(), before, "a refusal must not write a record");
    assert.equal(readFileSync(f.file, "utf8"), LEDGER);
  }
});

test("rotate records the controller also when there was no ledger to rotate", (t) => {
  const f = fixture(t, { ledger: null, mark: STALE, controller: { pid: deadPid(), lstart: "x", prior: "none" } });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { rotated: false, archive: null, ...NOTHING_CARRIED });
  assert.deepEqual(f.ctl(), { ...OURS, prior: "dead" });
});

test("rotate with no ledger and no record exits 0 under a beating mark, as before, and still records the controller", (t) => {
  const f = fixture(t, { ledger: null, mark: FRESH });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { rotated: false, archive: null, ...NOTHING_CARRIED });
  assert.deepEqual(f.ctl(), { ...OURS, prior: "none" });
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
  assert.deepEqual(f.ctl(), { pid: near, lstart: "near-start", prior: "none" });

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
  const extra = { quiet: 3, digest: "d1", note: "not ours" };
  const mark = STALE;
  const f = fixture(t, { table: NO_OMP, mark, extra, controller: { pid: deadPid(), lstart: "x", prior: "none" } });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const { acted, ...after } = f.state();
  assert.equal("controller" in after, false, "an older run's record must not outlive the run that should have replaced it");
  assert.deepEqual(after, { ...extra, ...mark });
  assert.ok(acted.at <= Date.now() && acted.at > Date.now() - 60_000, "a rotate with no record to write still stamps its ledger write");

  const g = fixture(t, { mark, extra, controller: { pid: deadPid(), lstart: "x", prior: "none" } });
  assert.equal(g.cli(["rotate"]).status, 0);
  const { controller: _record, acted: _acted, ...others } = g.state();
  assert.deepEqual(others, { ...extra, ...mark });
  assert.deepEqual(g.ctl(), { ...OURS, prior: "dead" });
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

test("rotate with no record names its own unreadable process table, not a record that does not exist", (t) => {
  const f = fixture(t, { mark: STALE });
  const r = f.cli(["rotate"], { FLEET_PROC_TABLE: "" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cannot read the process table.*this run's own controller cannot be determined/);
  assert.doesNotMatch(r.stderr, /recorded in/);
  assert.equal(readFileSync(f.file, "utf8"), LEDGER);
  assert.deepEqual(f.archives(), []);
});

test("rotate refuses, moving nothing, on a process table of the wrong shape rather than crashing", (t) => {
  const f = fixture(t, { table: null });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to rotate .*cannot read the process table/);
  assert.doesNotMatch(r.stderr, /TypeError/);
  assert.equal(readFileSync(f.file, "utf8"), LEDGER);
  assert.deepEqual(f.archives(), []);
});

test("rotate refuses, moving nothing, when the heartbeat file exists but cannot be read — a live controller's record is not 'no record'", (t) => {
  const pid = liveForeign(t);
  const table = { ...OMP_CHAIN, [pid]: { ppid: 1, argv: ["sleep", "300"], lstart: "foreign-start" } };
  for (const [label, cause, damage] of [
    ["truncated JSON", "is not JSON", (path) => writeFileSync(path, '{"quiet":0,"controller":{"pid":1')],
    ["not an object", "is not a JSON object", (path) => writeFileSync(path, "[]")],
    ["a directory", "exists but cannot be read", (path) => { rmSync(path); mkdirSync(path); }],
  ]) {
    const f = fixture(t, { mark: STALE, table, controller: { pid, lstart: "foreign-start", prior: "none" } });
    const beatFile = join(f.dir, "heartbeat.json");
    damage(beatFile);
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 2, `${label}: rotated under a record it could not read: ${r.stderr}`);
    assert.ok(r.stderr.includes(refusal(f, cause)), `${label}: ${r.stderr}`);
    assert.equal(readFileSync(f.file, "utf8"), LEDGER, `${label}: a refusal must not touch the ledger`);
    assert.deepEqual(f.archives(), []);
  }
});

// ── an ancestor rotate carries what is still live ────────────────────────────
//
// This session's own earlier run: its members run inside the omp process that
// is still this run's, so their tokens come forward. The record names the test
// runner, the script's parent — alive, its start time matching the table — so
// the verdict is `ancestor`.

const ANCESTOR = { pid: process.pid, lstart: "runner-start", prior: "dead" };

// Every member family live, an open review launch, and the records that ride
// on a live row: tier verdicts, `reviewed=`, a dispositions verdict, a
// conflict hold, a merge hold. Beside them, rows and entries nothing live is
// on, and the sections that are never carried.
const LIVE_ROWS = [
  "#3 impl-3=PR#5 → PR#5 · tier-ok=impl-3:fleet-implementer-slow-high · review=member:review-pr-5",
  "#4 impl-4=PR#6 → PR#6 · tier-ok=impl-4:fleet-implementer-slow-high · review=wf:r1 · reviewed=abc1234:1/0/0:run-abcdefgh · fix-pr-6 · dispositions-unchecked=fix-pr-6:run-abcdefgh",
  "#7 impl-7=PR#8 → PR#8 · tier-unverifiable=impl-7:no-transcript · review=wf:r2 · reviewed=abc1234:0/0/0:run-bcdefghi · finisher-pr-8 · held-behind:#6",
  "#12 impl-12 · tier=task-high · tier-mismatch=impl-11:fleet-implementer-slow-high",
  "#14 conflict-hold:#14 · fix-pr-14",
];
const SETTLED_ROWS = [
  "#9 impl-9=PR#10 → PR#10 · review=wf:r3 · reviewed=abc1234:0/0/0:run-cdefghij · finisher-pr-10=labelled",
  "#11 impl-11=bailed",
  "#13 excluded · behind-pr:#6",
  "#15 review=member:review-pr-15=failed",
];
const LIVE_DISPATCHED = ["fix-pr-6", "finisher-pr-8", "impl-12", "merge-bot-1", "fix-pr-14"];
const SETTLED_DISPATCHED = ["impl-3=PR#5", "impl-4=PR#6", "impl-7=PR#8", "impl-9=PR#10", "finisher-pr-10=labelled", "impl-11=bailed"];
const ledgerOf = ({ rows, dispatched, drain = ["budget"] }) => [
  "# Fleet run ledger", "", "## Rows", "", ...rows.map((r) => `- ${r}`), "",
  "## Dispatched", "", ...dispatched.map((e) => `- ${e}`), "", "## Filed", "", "- #20 a filed subject", "",
  "## Ruled", "", "- #6 merge as is", "", "## Drain", "", ...drain.map((d) => `- ${d}`), "",
].join("\n");
const LIVE = ledgerOf({
  rows: [SETTLED_ROWS[0], LIVE_ROWS[0], SETTLED_ROWS[1], LIVE_ROWS[1], LIVE_ROWS[2], SETTLED_ROWS[2], LIVE_ROWS[3], LIVE_ROWS[4], SETTLED_ROWS[3]],
  dispatched: [...SETTLED_DISPATCHED.slice(0, 3), "fix-pr-6", "finisher-pr-8", ...SETTLED_DISPATCHED.slice(3), "impl-12", "merge-bot-1", "fix-pr-14"],
});
// The settled entries of the three implementers whose rows are carried ride
// with them; the settled entries nothing carried names stay behind — as bare
// names in `## Retired`, in `## Dispatched` order, then the reviewer runner
// a row launched.
const CARRIED = { rows: LIVE_ROWS, dispatched: [...SETTLED_DISPATCHED.slice(0, 3), ...LIVE_DISPATCHED] };
const RETIRED = ["impl-9", "finisher-pr-10", "impl-11", "review-pr-15"];
const read = (f) => JSON.parse(f.cli(["read"]).stdout);

test("an ancestor rotate archives the ledger as-is, carries every live row whole and every ## Dispatched entry a live member or a carried row names, and retires every other settled name", (t) => {
  const f = fixture(t, { ledger: LIVE, controller: ANCESTOR });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const [archive] = f.archives();
  assert.equal(readFileSync(join(f.dir, archive), "utf8"), LIVE, "the archive must be the ledger's own bytes");
  assert.deepEqual(JSON.parse(r.stdout), { rotated: true, archive: join(f.dir, archive), carried: CARRIED, retired: RETIRED, skipped: [] });
  assert.match(r.stderr, /retired 4 name\(s\) from /);
  assert.deepEqual(f.ctl(), { ...OURS, prior: "ancestor" });
  // The tokens riding on a carried row come with it: tier verdicts,
  // `reviewed=`, dispositions, conflict and merge holds.
  assert.deepEqual(read(f), { rows: LIVE_ROWS, dispatched: CARRIED.dispatched, briefs: {}, queued: {}, agents: {}, filed: [], ruled: [], drain: null, retired: RETIRED });
});

test("dead and none carry nothing from the same ledger — unchanged", (t) => {
  for (const [label, opts] of [["dead", { controller: { pid: deadPid(), lstart: "x", prior: "ancestor" } }], ["none", { mark: STALE }]]) {
    const f = fixture(t, { ledger: LIVE, ...opts });
    const r = f.cli(["rotate"]);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.deepEqual(f.ctl(), { ...OURS, prior: label });
    assert.deepEqual(JSON.parse(r.stdout), { rotated: true, archive: join(f.dir, f.archives()[0]), ...NOTHING_CARRIED }, label);
    assert.equal(existsSync(f.file), false, `${label}: nothing may be carried`);
  }
});

test("after an ancestor rotate a carried member's late result settles its own carried token, and a review result answers its carried launch", (t) => {
  const f = fixture(t, { ledger: LIVE, controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  for (const [member, outcome] of [["fix-pr-6", "applied:abcdef1"], ["merge-bot-1", "done"], ["finisher-pr-8", "labelled"], ["impl-12", "PR#30"], ["fix-pr-14", "no-op"]]) {
    const s = f.cli(["settle", member, outcome]);
    assert.equal(s.status, 0, `${member}: ${s.stderr}`);
    assert.equal(JSON.parse(s.stdout).changed, true, `${member}: the settle must land on the carried token`);
  }
  const reviewed = `${LIVE_ROWS[0]} · reviewed=abc1234:0/0/0:run-defghijk`;
  const w = f.cli(["review", "5", "reviewed=abc1234:0/0/0:run-defghijk"]);
  assert.equal(w.status, 0, `the review result must answer the carried launch: ${w.stderr}`);
  assert.equal(JSON.parse(w.stdout).row, "#3", "the result lands on the carried row, the PR's row");
  const after = read(f);
  assert.deepEqual(after.dispatched, [...SETTLED_DISPATCHED.slice(0, 3), "fix-pr-6=applied:abcdef1", "finisher-pr-8=labelled", "impl-12=PR#30", "merge-bot-1=done", "fix-pr-14=no-op"]);
  assert.equal(after.rows[0], reviewed);
});

test("after an ancestor rotate a carried reviewer is recorded dead with review settling its launch =failed, and the next runner takes the next free name", (t) => {
  const f = fixture(t, { ledger: LIVE, controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  const w = f.cli(["review", "5", "review=member:review-pr-5=failed"]);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(read(f).rows[0], LIVE_ROWS[0].replace("review=member:review-pr-5", "review=member:review-pr-5=failed"), "settled where it stands");
  assert.equal(f.cli(["settle", "review-pr-5", "killed"]).status, 2, "a reviewer is no member settle knows");
  const reused = f.cli(["review", "5", "review=member:review-pr-5"]);
  assert.equal(reused.status, 2, "the carried launch's name stays taken");
  assert.match(reused.stderr, /the next free reviewer name is review-pr-5-b/);
  assert.equal(f.cli(["review", "5", "review=member:review-pr-5-b"]).status, 0);
});

test("after an ancestor rotate dispatch refuses a carried live member's name and a retired one, naming the replacement, and dispatch merge-bot names the next bot", (t) => {
  const f = fixture(t, { ledger: LIVE, controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  for (const args of [["12", "impl-12"], ["6", "fix-pr-6"], ["8", "finisher-pr-8"], ["14", "fix-pr-14"]]) {
    const d = f.cli(["dispatch", ...args]);
    assert.notEqual(d.status, 0, `${args.join(" ")}: dispatched a carried live member again`);
    assert.match(d.stderr, /already dispatched this session/, args.join(" "));
  }
  // Retired names: the ticket's row is gone, the name is not.
  for (const [args, next] of [[["9", "impl-9"], "impl-9-b"], [["10", "finisher-pr-10"], "finisher-pr-10-b"], [["11", "impl-11"], "impl-11-b"]]) {
    const d = f.cli(["dispatch", ...args]);
    assert.notEqual(d.status, 0, `${args.join(" ")}: dispatched a retired name again`);
    assert.match(d.stderr, new RegExp(`${args[1]} was already dispatched this session \\(retired by rotate\\) — a replacement takes a name of its own \\(${next}\\)`), args.join(" "));
  }
  const again = f.cli(["dispatch", "11", "impl-11-b"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).member, "impl-11-b");
  const bot = f.cli(["dispatch", "merge-bot-1"]);
  assert.notEqual(bot.status, 0, "merge-bot-1 is carried live");
  assert.match(bot.stderr, /merge-bot-1 is not next — the next merge bot this session is merge-bot-2;/);
  const next = f.cli(["dispatch", "merge-bot"]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).member, "merge-bot-2");
});

test("a settled bot no carried row names is retired, and the next bot numbers past it — the #3082 probe", (t) => {
  const f = fixture(t, { ledger: ledgerOf({ rows: ["#12 impl-12"], dispatched: ["impl-12", "merge-bot-1=done"] }), controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  assert.deepEqual(read(f).dispatched, ["impl-12"]);
  assert.deepEqual(read(f).retired, ["merge-bot-1"]);
  const stale = f.cli(["dispatch", "merge-bot-1"]);
  assert.notEqual(stale.status, 0, "merge-bot-1 is retired");
  assert.match(stale.stderr, /merge-bot-1 is not next — the next merge bot this session is merge-bot-2;/);
  const next = f.cli(["dispatch", "merge-bot"]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).member, "merge-bot-2");
});

test("a settled token only a dropped row holds retires too, and a retired letter is climbed past", (t) => {
  // `impl-30-b=bailed` was `row`-written, never dispatched; `impl-30` sits
  // only in `## Dispatched`. Both retire, and the replacement is `-c`.
  const f = fixture(t, { ledger: ledgerOf({ rows: ["#30 impl-30-b=bailed", "#12 impl-12"], dispatched: ["impl-30=killed", "impl-12"] }), controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  assert.deepEqual(read(f).retired, ["impl-30", "impl-30-b"]);
  const d = f.cli(["dispatch", "30", "impl-30"]);
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /impl-30 was already dispatched this session \(retired by rotate\) — a replacement takes a name of its own \(impl-30-c\)/);
  const c = f.cli(["dispatch", "30", "impl-30-c"]);
  assert.equal(c.status, 0, c.stderr);
});

test("a carried live bot whose settled predecessors stayed behind still numbers the next bot past it", (t) => {
  const f = fixture(t, { ledger: ledgerOf({ rows: [], dispatched: ["merge-bot-1=done", "merge-bot-2"] }), controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  assert.deepEqual(read(f).dispatched, ["merge-bot-2"]);
  const next = f.cli(["dispatch", "merge-bot"]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).member, "merge-bot-3");
});

test("a reviewer runner no carried row names is retired, and review refuses its name, naming the next free one", (t) => {
  const done = "reviewed=abc1234:0/0/0:run-abcdefgh";
  const rows = ["#12 impl-12", `#20 impl-20=PR#21 → PR#21 · review=member:review-pr-21 ${done} · review=member:review-pr-21-b=failed`];
  const f = fixture(t, { ledger: ledgerOf({ rows, dispatched: ["impl-12", "impl-20=PR#21"] }), controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  assert.deepEqual(read(f).retired, ["impl-20", "review-pr-21", "review-pr-21-b"]);
  // The next free name skips every retired letter, not only the refused one.
  for (const name of ["review-pr-21", "review-pr-21-b"]) {
    const r = f.cli(["review", "21", `review=member:${name}`]);
    assert.equal(r.status, 2, `${name}: launched a retired runner name again`);
    assert.match(r.stderr, /names a runner an earlier run of this session already used/, name);
    assert.match(r.stderr, /the next free reviewer name is review-pr-21-c/, name);
  }
  assert.equal(f.cli(["review", "22", "review=member:review-pr-22"]).status, 0, "a name the session never used is free");
  assert.equal(f.cli(["review", "21", "review=member:review-pr-21-c"]).status, 0);
});

test("a settled token on a row the rotate skips retires too, an unsettled one does not", (t) => {
  const settled = "#18 impl-18=killed · review=member:";
  const open = "#19 impl-19 · review=member:";
  const f = fixture(t, { ledger: ledgerOf({ rows: ["#12 impl-12", settled, open], dispatched: ["impl-12"] }), controller: ANCESTOR });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.skipped, [settled, open]);
  assert.deepEqual(out.retired, ["impl-18"]);
});

test("a ## Dispatched entry whose outcome is outside its family's vocabulary is skipped but its name retires, and dispatch refuses it", (t) => {
  const bad = "impl-5=bogus";
  const f = fixture(t, { ledger: ledgerOf({ rows: ["#12 impl-12"], dispatched: ["impl-12", bad] }), controller: ANCESTOR });
  assert.equal(f.cli(["dispatch", "5", "impl-5"]).status, 2, "the name already counts as used inside the run");
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(`skipped unparseable line '${bad}'`), r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.skipped, [bad]);
  assert.deepEqual(out.carried.dispatched, ["impl-12"], "the malformed entry is still not carried");
  assert.deepEqual(out.retired, ["impl-5"]);
  assert.deepEqual(read(f).retired, ["impl-5"]);
  assert.match(readFileSync(f.file, "utf8"), /\n## Retired\n\n- impl-5\n/);
  const d = f.cli(["dispatch", "5", "impl-5"]);
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /impl-5 was already dispatched this session \(retired by rotate\) — a replacement takes a name of its own \(impl-5-b\)/);
});

test("a row token whose outcome is outside its family's vocabulary retires its name whether or not the row parsed, and a bare token beside it retires nothing", (t) => {
  const badRow = "#5 impl-5=bogus";
  const f = fixture(t, { ledger: ledgerOf({ rows: ["#12 impl-12", badRow, "#6 impl-6 · impl-7=bogus · review=member:"], dispatched: ["impl-12"] }), controller: ANCESTOR });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.skipped, [badRow, "#6 impl-6 · impl-7=bogus · review=member:"]);
  assert.deepEqual(out.retired, ["impl-5", "impl-7"], "impl-6 is bare on a skipped row: retired nothing");
  assert.deepEqual(read(f).retired, ["impl-5", "impl-7"]);
  const d = f.cli(["dispatch", "5", "impl-5"]);
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /impl-5 was already dispatched this session \(retired by rotate\) — a replacement takes a name of its own \(impl-5-b\)/);
  assert.equal(f.cli(["dispatch", "6", "impl-6"]).status, 0, "a bare token on a skipped row stays free");
});

test("an out-of-vocabulary outcome on a name a carried row already names is not listed twice, and a name outside the grammar retires nothing", (t) => {
  // `impl-12` is live on its carried row, so its malformed entry adds nothing.
  const f = fixture(t, { ledger: ledgerOf({ rows: ["#12 impl-12"], dispatched: ["impl-12", "impl-12=bogus", "impl-5=bogus", "impl-5=bogus", "nope=bogus"] }), controller: ANCESTOR });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).retired, ["impl-5"]);
});

test("a ## Retired line with an outcome is skipped with a warning that its name is retired bare, a line naming no member or reviewer is skipped with a warning, and the rest is kept", (t) => {
  const bad = ["impl-4=killed", "garbage-name", "merge-bot-2-b"];
  const ledger = `${ledgerOf({ rows: ["#12 impl-12"], dispatched: ["impl-12"] })}\n## Retired\n\n- impl-1\n${bad.map((l) => `- ${l}\n`).join("")}- review-pr-6\n`;
  const f = fixture(t, { ledger, controller: ANCESTOR });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  for (const line of bad) assert.ok(r.stderr.includes(`skipped unparseable line '${line}'`), `stderr must name ${line}: ${r.stderr}`);
  assert.ok(r.stderr.includes("skipped unparseable line 'impl-4=killed' — not carried: impl-4 is retired bare"), r.stderr);
  assert.ok(r.stderr.includes("skipped unparseable line 'garbage-name' — not carried: names no member or reviewer"), r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.skipped, bad);
  assert.deepEqual(out.retired, ["impl-1", "impl-4", "review-pr-6"]);
  assert.deepEqual(read(f).retired, ["impl-1", "impl-4", "review-pr-6"], "the new ledger holds the bare name");
});

test("after a rotate over a ## Retired line with an outcome, dispatch refuses its name and names the replacement", (t) => {
  const ledger = `${ledgerOf({ rows: ["#12 impl-12"], dispatched: ["impl-12"] })}\n## Retired\n\n- impl-4=bogus\n`;
  const f = fixture(t, { ledger, controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  const d = f.cli(["dispatch", "4", "impl-4"]);
  assert.equal(d.status, 2, d.stderr);
  assert.match(d.stderr, /impl-4 was already dispatched this session \(retired by rotate\) — a replacement takes a name of its own \(impl-4-b\)/);
});

// A `## Retired` section as a hand edit leaves it, on a ledger no rotate has
// read: every reader takes a line's name before its first `=`.
const withRetired = (lines) => `${ledgerOf({ rows: ["#12 impl-12"], dispatched: ["impl-12"], drain: [] })}\n## Retired\n\n${lines.map((l) => `- ${l}\n`).join("")}`;

test("before any rotate, a ## Retired line with an outcome holds its name: dispatch refuses it, naming the replacement, and a name no line holds stays free", (t) => {
  const f = fixture(t, { ledger: withRetired(["impl-4=killed"]) });
  const d = f.cli(["dispatch", "4", "impl-4"]);
  assert.equal(d.status, 2, d.stderr);
  assert.match(d.stderr, /impl-4 was already dispatched this session \(retired by rotate\) — a replacement takes a name of its own \(impl-4-b\)/);
  const free = f.cli(["dispatch", "5", "impl-5"]);
  assert.equal(free.status, 0, free.stderr);
});

test("before any rotate, dispatch merge-bot numbers past a bot a ## Retired line holds with an outcome", (t) => {
  const f = fixture(t, { ledger: withRetired(["merge-bot-3=done"]) });
  const next = f.cli(["dispatch", "merge-bot"]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).member, "merge-bot-4");
});

test("a ## Retired line naming no member or reviewer refuses dispatch, naming the line, and writes nothing", (t) => {
  const f = fixture(t, { ledger: withRetired(["impl-1", "garbage-name"]) });
  const before = readFileSync(f.file, "utf8");
  const d = f.cli(["dispatch", "5", "impl-5"]);
  assert.equal(d.status, 2, d.stderr);
  assert.match(d.stderr, /## Retired has a line 'garbage-name' that names no member or reviewer — fix the ledger by hand before dispatch can trust it/);
  assert.equal(readFileSync(f.file, "utf8"), before);
});

test("a ## Retired line naming no member or reviewer refuses review, naming the line, and writes nothing", (t) => {
  const f = fixture(t, { ledger: withRetired(["review-pr-6", "garbage-name"]) });
  const before = readFileSync(f.file, "utf8");
  const r = f.cli(["review", "21", "review=member:review-pr-21"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /## Retired has a line 'garbage-name' that names no member or reviewer — fix the ledger by hand before review can trust it/);
  assert.equal(readFileSync(f.file, "utf8"), before);
});

test("an ancestor rotate skips an unparseable line with a warning naming it, carries every parseable live line, and still rotates a ledger load() refuses", (t) => {
  const badRow = "#16 fix-pr-16=bogus";
  const badReview = "#17 fix-pr-17 · review=member:";
  const badEntry = "not-a-member";
  const bad = ledgerOf({
    rows: [badRow, ...LIVE_ROWS, badReview],
    dispatched: [...LIVE_DISPATCHED, badEntry, "fix-pr-17"],
    drain: ["budget", "a second marker"],
  });
  const f = fixture(t, { ledger: bad, controller: ANCESTOR });
  assert.equal(f.cli(["read"]).status, 2, "the fixture must be a ledger load() refuses");
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  for (const line of [badRow, badReview, badEntry]) {
    assert.ok(r.stderr.includes(`skipped unparseable line '${line}'`), `stderr must name ${line}: ${r.stderr}`);
  }
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.skipped, [badRow, badReview, badEntry]);
  // A skipped row's member still keeps its name through its own entry.
  assert.deepEqual(out.carried, { rows: LIVE_ROWS, dispatched: [...LIVE_DISPATCHED, "fix-pr-17"] });
  assert.equal(readFileSync(join(f.dir, f.archives()[0]), "utf8"), bad);
  assert.deepEqual(read(f).rows, LIVE_ROWS);
});

test("two ancestor rotates in a row carry a still-live token twice, and retired names accumulate", (t) => {
  const f = fixture(t, { ledger: LIVE, controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  // The first run's successor settles a carried member and dispatches a bot;
  // the second rotate retires both and keeps the first rotate's names.
  assert.equal(f.cli(["settle", "impl-12", "killed"]).status, 0);
  assert.equal(f.cli(["dispatch", "merge-bot"]).status, 0);
  assert.equal(f.cli(["settle", "merge-bot-2", "done"]).status, 0);
  // The second run of the same session: its record names the same live
  // ancestor again, and the first archive is moved off its stamped name so
  // two rotates inside one second cannot collide on it.
  const [first] = f.archives();
  renameSync(join(f.dir, first), join(f.dir, "ledger.first.md"));
  writeFileSync(join(f.dir, "heartbeat.json"), JSON.stringify({ quiet: 0, digest: "", controller: ANCESTOR }));
  const again = f.cli(["rotate"]);
  assert.equal(again.status, 0, again.stderr);
  const rows = LIVE_ROWS.filter((r) => !r.startsWith("#12 "));
  const dispatched = CARRIED.dispatched.filter((e) => e !== "impl-12");
  assert.deepEqual(JSON.parse(again.stdout).carried, { rows, dispatched });
  assert.deepEqual(read(f), { rows, dispatched, briefs: {}, queued: {}, agents: {}, filed: [], ruled: [], drain: null, retired: [...RETIRED, "impl-12", "merge-bot-2"] });
  const next = f.cli(["dispatch", "merge-bot"]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).member, "merge-bot-3");
});

test("a dead rotate after an ancestor one drops ## Retired with everything else", (t) => {
  const f = fixture(t, { ledger: LIVE, controller: ANCESTOR });
  assert.equal(f.cli(["rotate"]).status, 0);
  assert.deepEqual(read(f).retired, RETIRED);
  const [first] = f.archives();
  renameSync(join(f.dir, first), join(f.dir, "ledger.first.md"));
  writeFileSync(join(f.dir, "heartbeat.json"), JSON.stringify({ quiet: 0, digest: "", controller: { pid: deadPid(), lstart: "x", prior: "ancestor" } }));
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { rotated: true, archive: join(f.dir, f.archives()[0]), ...NOTHING_CARRIED });
  assert.equal(existsSync(f.file), false, "a dead process holds no name");
  const next = f.cli(["dispatch", "merge-bot"]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).member, "merge-bot-1");
});

test("an ancestor rotate of a ledger with nothing live leaves only ## Retired behind", (t) => {
  const f = fixture(t, { ledger: ledgerOf({ rows: SETTLED_ROWS, dispatched: SETTLED_DISPATCHED }), controller: ANCESTOR });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.ctl(), { ...OURS, prior: "ancestor" });
  const retired = [...SETTLED_DISPATCHED.map((e) => e.split("=")[0]), "review-pr-15"];
  assert.deepEqual(JSON.parse(r.stdout), { rotated: true, archive: join(f.dir, f.archives()[0]), carried: { rows: [], dispatched: [] }, retired, skipped: [] });
  assert.deepEqual(read(f), { rows: [], dispatched: [], briefs: {}, queued: {}, agents: {}, filed: [], ruled: [], drain: null, retired });
  assert.match(readFileSync(f.file, "utf8"), /\n## Retired\n\n- impl-3\n/);
});

test("an ancestor rotate carries every row of a live PR's stream, and the settled entry of a carried member, so a bare token never reads live again", (t) => {
  // The review record and the sibling rows of the PR ride with its live row;
  // a carried bare `fix-pr-5` keeps the settled copy that held it settled.
  const rows = [
    "#5 review=wf:r1 · reviewed=abc1234:2/0/0:run-abcdefgh",
    "#3 impl-3=PR#5 -> PR#5 · fix-pr-5 · review=member:review-pr-5",
    "#20 impl-20=PR#21 -> PR#21",
    "#22 impl-22 · fix-pr-22",
  ];
  const dispatched = ["impl-3=PR#5", "fix-pr-5=no-op", "impl-20=PR#21", "impl-22", "fix-pr-22"];
  const f = fixture(t, { ledger: ledgerOf({ rows, dispatched }), controller: ANCESTOR });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).carried, {
    rows: [rows[0], rows[1], rows[3]],
    dispatched: ["impl-3=PR#5", "fix-pr-5=no-op", "impl-22", "fix-pr-22"],
  });
  assert.deepEqual(read(f).rows, [rows[0], rows[1], rows[3]]);
  assert.deepEqual(read(f).dispatched, ["impl-3=PR#5", "fix-pr-5=no-op", "impl-22", "fix-pr-22"]);
});

test("an ancestor rotate whose write fails leaves the ledger where it was, and a retry carries the same live tokens", (t) => {
  // A file-size ceiling the carried ledger exceeds but the archive link,
  // which writes nothing, does not.
  const live = Array.from({ length: 40 }, (_, i) => `#${100 + i} impl-${100 + i} · ${"padding ".repeat(8).trim()}`);
  const dispatched = live.map((row) => row.split(" ")[1]);
  const ledger = ledgerOf({ rows: live, dispatched });
  const f = fixture(t, { ledger, controller: ANCESTOR });
  const capped = f.cliCapped(["rotate"], 1);
  assert.notEqual(capped.status, 0, "the ceiling must make the carried ledger's write fail");
  assert.match(capped.stderr, /cannot write /);
  assert.equal(readFileSync(f.file, "utf8"), ledger, "the ledger must still be there, whole");
  assert.deepEqual(read(f).rows, live);
  // The failed attempt's archive is moved off its stamped name so the retry,
  // inside the same second, cannot collide with it.
  const [first] = f.archives();
  renameSync(join(f.dir, first), join(f.dir, "ledger.first.md"));
  const again = f.cli(["rotate"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).carried, { rows: live, dispatched });
  assert.deepEqual(read(f).dispatched, dispatched);
});

test("an ancestor rotate carries a bare live dispatched entry whose malformed twin would retire it", (t) => {
  // carryOf filters out malformed entries (with errors) from the dispatched section.
  // A live entry (impl-14) that doesn't have an outcome stays in carried.dispatched.
  // It stays out of ## Retired only because the bare impl-14 entry is passed on in carried.dispatched.
  const f = fixture(t, {
    ledger: ledgerOf({
      rows: ["#12 impl-12"],
      dispatched: ["impl-12", "impl-14", "impl-14=bogus"],
    }),
    controller: ANCESTOR,
  });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  // carried dispatched includes valid entries (malformed impl-14=bogus is filtered out)
  assert.deepEqual(out.carried.dispatched, ["impl-12", "impl-14"]);
  // retired does not include impl-14 because it's in the carried dispatched
  assert(!out.retired.includes("impl-14"), "impl-14 is kept live by its entry in carried.dispatched");
  assert.deepEqual(read(f).dispatched, ["impl-12", "impl-14"]);
  assert(!read(f).retired.includes("impl-14"));
});

test("an ancestor rotate retires a name whose token has an empty outcome, in ## Dispatched and on a row alike, and reports both lines skipped", (t) => {
  // `impl-5=` and `impl-6=` parse with outcome '' and an error, so their lines
  // are skipped; the names were used this session, so each retires. Each name
  // sits in one place only, so neither retire loop can mask the other.
  const dispatchedLine = "impl-5=";
  const rowLine = "#6 impl-6=";
  const f = fixture(t, {
    ledger: ledgerOf({
      rows: [rowLine, "#7 impl-7"],
      dispatched: [dispatchedLine, "impl-7"],
    }),
    controller: ANCESTOR,
  });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.skipped, [rowLine, dispatchedLine]);
  // impl-7 is live and bare, so it is carried and not retired.
  assert.deepEqual(out.retired, ["impl-5", "impl-6"]);
  assert.deepEqual(read(f).retired, ["impl-5", "impl-6"]);
  assert.match(readFileSync(f.file, "utf8"), /\n## Retired\n\n- impl-5\n- impl-6\n/);
});

// ── the briefs a run dispatched with ─────────────────────────────────────────

test("an ancestor rotate carries a live entry with its brief= and a live bot's queued=, retires a settled one's name as any other, and archives briefs/ under the archive's stamp", (t) => {
  const ledger = ledgerOf({
    rows: [LIVE_ROWS[3], SETTLED_ROWS[1], LIVE_ROWS[4]],
    dispatched: ["impl-11=bailed brief=11111111", "impl-12 brief=12121212", "merge-bot-1 brief=bbbbbbbb queued=5,9", "fix-pr-14"],
  });
  const f = fixture(t, { ledger, controller: ANCESTOR });
  const rendered = renderBrief(f.dir, "impl-12");
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const [archive] = f.archives();
  const archived = join(f.dir, `briefs.${archive.slice("ledger.".length, -".md".length)}`);
  assert.equal(existsSync(join(f.dir, "briefs")), false, "the run's briefs must not be left where the next run's dispatch looks");
  assert.equal(readFileSync(join(archived, "impl-12.md"), "utf8"), "The brief for impl-12.\n", "briefs/ moves whole, beside ledger.<stamp>.md");
  assert.equal(JSON.parse(readFileSync(join(archived, "impl-12.json"), "utf8")).sha256, rendered.sha256);
  assert.ok(r.stderr.includes(`archived ${join(f.dir, "briefs")} -> ${archived}`), r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.carried.dispatched, ["impl-12", "merge-bot-1", "fix-pr-14"], "the payload carries the tokens, as before");
  assert.deepEqual(out.retired, ["impl-11"], "a settled entry with a brief= retires its name like any other");
  const l = read(f);
  assert.deepEqual(l.dispatched, ["impl-12", "merge-bot-1", "fix-pr-14"]);
  assert.deepEqual(l.briefs, { "impl-12": "12121212", "merge-bot-1": "bbbbbbbb" }, "an entry without a brief= is carried without one");
  assert.deepEqual(l.queued, { "merge-bot-1": [5, 9] }, "the queue a carried bot's report is judged against travels with it");
  assert.match(readFileSync(f.file, "utf8"), /\n## Dispatched\n\n- impl-12 brief=12121212\n- merge-bot-1 brief=bbbbbbbb queued=5,9\n- fix-pr-14\n/);
  // The carried member's late result settles its token and keeps its brief.
  const s = f.cli(["settle", "impl-12", "PR#30"]);
  assert.equal(s.status, 0, s.stderr);
  assert.match(readFileSync(f.file, "utf8"), /\n- impl-12=PR#30 brief=12121212\n/);
});

test("an ancestor rotate carries an implementer's agent= with its entry, live or settled onto a carried row, and drops a dropped member's", (t) => {
  const ledger = ledgerOf({
    rows: [LIVE_ROWS[1], LIVE_ROWS[3], SETTLED_ROWS[1]],
    dispatched: [
      "impl-4=PR#6 brief=44444444 agent=fleet-implementer-smol-high", "fix-pr-6 brief=66666666",
      "impl-11=bailed brief=11111111 agent=fleet-implementer-slow-high", "impl-12 brief=12121212 agent=fleet-implementer-task-high",
    ],
  });
  const f = fixture(t, { ledger, controller: ANCESTOR });
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const l = read(f);
  assert.deepEqual(l.dispatched, ["impl-4=PR#6", "fix-pr-6", "impl-12"]);
  assert.deepEqual(l.agents, { "impl-4": "fleet-implementer-smol-high", "impl-12": "fleet-implementer-task-high" });
  assert.match(readFileSync(f.file, "utf8"), /\n## Dispatched\n\n- impl-4=PR#6 brief=44444444 agent=fleet-implementer-smol-high\n- fix-pr-6 brief=66666666\n- impl-12 brief=12121212 agent=fleet-implementer-task-high\n/);
  // A carried implementer's late settle keeps its record.
  assert.equal(f.cli(["settle", "impl-12", "PR#30"]).status, 0);
  assert.match(readFileSync(f.file, "utf8"), /\n- impl-12=PR#30 brief=12121212 agent=fleet-implementer-task-high\n/);
});

test("a rotate that carries nothing archives briefs/ too, and refuses before anything moves when its archive name is taken", (t) => {
  const f = fixture(t, { ledger: LIVE, controller: { pid: deadPid(), lstart: "x", prior: "ancestor" } });
  renderBrief(f.dir, "impl-12");
  const r = f.cli(["rotate"]);
  assert.equal(r.status, 0, r.stderr);
  const [archive] = f.archives();
  assert.ok(existsSync(join(f.dir, `briefs.${archive.slice("ledger.".length, -".md".length)}`, "impl-12.json")));
  assert.equal(existsSync(join(f.dir, "briefs")), false);

  const g = fixture(t);
  renderBrief(g.dir, "impl-12");
  // Every second this call can plausibly land on is taken.
  const now = Date.now();
  for (let s = 0; s < 30; s++) mkdirSync(join(g.dir, `briefs.${stamp(now + s * 1000)}`));
  const refused = g.cli(["rotate"]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /refusing to rotate .*briefs\.\S+ already exists/);
  assert.equal(readFileSync(g.file, "utf8"), LEDGER, "nothing moved");
  assert.ok(existsSync(join(g.dir, "briefs", "impl-12.json")));
  assert.deepEqual(g.archives(), []);
});
