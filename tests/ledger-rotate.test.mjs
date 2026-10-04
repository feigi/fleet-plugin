// `ledger.mjs rotate`: one ledger per run. The current file is archived
// byte-for-byte beside itself and nothing is carried forward, so the next
// write starts the empty skeleton. Every call is its own process against a
// scratch `--file` ledger; the heartbeat mark the liveness guard reads is the
// `heartbeat.json` in the same directory, which is where fleet-state.mjs keeps
// it beside the real `.fleet/ledger.md`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function fixture(t, { ledger = LEDGER, mark = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-rotate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ledger.md");
  if (ledger !== null) writeFileSync(file, ledger);
  if (mark !== null) writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({ quiet: 0, elapsed: 0, digest: "", ...mark }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env = { ...process.env, PATH: bin };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const cli = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { encoding: "utf8", env: { ...env, ...extraEnv }, cwd: dir });
  const archives = () => readdirSync(dir).filter((n) => STAMPED.test(n)).sort();
  return { dir, file, cli, archives };
}

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
