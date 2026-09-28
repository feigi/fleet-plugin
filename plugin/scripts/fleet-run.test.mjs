// The Resolver's single-registry contract (ADR 0014): fleet-run reads omp's
// own registry and nothing else. Driven through the real CLI — fleet-run
// reads `os.homedir()` directly and `process.exit()`s, so it cannot be
// exercised in-process the way a module-exporting script can.
//
// Every fixture's env is built from scratch (never `...process.env`), so
// these tests are deterministic regardless of the box they run on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FLEET_RUN = fileURLToPath(new URL("./fleet-run", import.meta.url));

function runFleetRun(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [FLEET_RUN, ...args], {
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH, ...extraEnv },
  });
}

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "fleet-run-home-"));
  const installPath = join(home, ".omp", "plugins", "cache", "a");
  mkdirSync(join(installPath, "scripts"), { recursive: true });
  writeFileSync(join(installPath, "scripts", "probe.mjs"), "content\n");
  mkdirSync(join(home, ".omp", "plugins"), { recursive: true });
  writeFileSync(
    join(home, ".omp", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "fleet-ctl@fleet-plugin": [{ scope: "user", installPath }] } }),
  );
  return { home, installPath };
}

test("the omp registry present: resolves --root with no notice at all", () => {
  const { home, installPath } = fakeHome();
  const r = runFleetRun(home, ["--root"]);
  assert.equal(r.status, 0, `expected success, got status ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout.trim(), installPath);
  assert.equal(r.stderr, "", "a single present registry needs no notice at all");
});

test("omp registry missing: exit 2, stderr names ~/.omp/plugins/installed_plugins.json", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-run-home-"));
  const r = runFleetRun(home, ["--root"]);
  assert.equal(r.status, 2, `expected a resolver refusal, got status ${r.status}: ${r.stdout}`);
  assert.match(r.stderr, /no registry carries "fleet-ctl@fleet-plugin"/);
  assert.match(r.stderr, /\.omp[/\\]plugins[/\\]installed_plugins\.json/);
});

test("--path prints the resolved script path without executing it", () => {
  const { home, installPath } = fakeHome();
  const r = runFleetRun(home, ["--path", "probe.mjs"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(installPath, "scripts", "probe.mjs"));
});

test("a bare script name execs the resolved file, arguments and exit code passed through", () => {
  const { home, installPath } = fakeHome();
  writeFileSync(join(installPath, "scripts", "echo-args.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const r = runFleetRun(home, ["echo-args.mjs", "a", "b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), ["a", "b"]);
});

test("a script that does not exist under the resolved install refuses by name", () => {
  const { home } = fakeHome();
  const r = runFleetRun(home, ["does-not-exist.mjs"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /script not found/);
  assert.match(r.stderr, /does-not-exist\.mjs/);
});
