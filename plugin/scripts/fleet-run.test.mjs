// The Resolver's single-resolution-point contract (ADR 0014, ADR 0021):
// fleet-run resolves the Install root as the realpath of
// `~/.omp/plugins/node_modules/@feigi/fleet-ctl` — the one path every omp install
// kind (marketplace/link/npm) places — and nothing else. Driven through the
// real CLI — fleet-run reads `os.homedir()` directly and `process.exit()`s,
// so it cannot be exercised in-process the way a module-exporting script can.
//
// Every fixture's env is built from scratch (never `...process.env`), so
// these tests are deterministic regardless of the box they run on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
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

// A marketplace/link-shaped install: a real payload dir with a scripts/
// subtree, symlinked into node_modules/@feigi/fleet-ctl — the shape omp's own
// installers place. The Install root the resolver reports is the payload's
// realpath (macOS resolves tmpdir through /private, and the resolver applies
// realpathSync, so expectations must too).
function fakeInstall() {
  const home = mkdtempSync(join(tmpdir(), "fleet-run-home-"));
  const payload = join(home, ".omp", "plugins", "cache", "a");
  mkdirSync(join(payload, "scripts"), { recursive: true });
  writeFileSync(join(payload, "scripts", "probe.mjs"), "content\n");
  const nm = join(home, ".omp", "plugins", "node_modules");
  mkdirSync(join(nm, "@feigi"), { recursive: true });
  symlinkSync(payload, join(nm, "@feigi", "fleet-ctl"));
  return { home, payload };
}

test("node_modules/@feigi/fleet-ctl present: --root prints its realpath, no notice", () => {
  const { home, payload } = fakeInstall();
  const r = runFleetRun(home, ["--root"]);
  assert.equal(r.status, 0, `expected success, got status ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout.trim(), realpathSync(payload));
  assert.equal(r.stderr, "", "a single present package dir needs no notice at all");
});

test("node_modules/@feigi/fleet-ctl absent: exit 2, stderr names ~/.omp/plugins/node_modules/@feigi/fleet-ctl", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-run-home-"));
  const r = runFleetRun(home, ["--root"]);
  assert.equal(r.status, 2, `expected a resolver refusal, got status ${r.status}: ${r.stdout}`);
  assert.match(r.stderr, /no omp plugin "@feigi\/fleet-ctl"/);
  assert.match(r.stderr, /\.omp[/\\]plugins[/\\]node_modules[/\\]@feigi[/\\]fleet-ctl/);
});

test("a dangling link is named as dangling, not as a missing entry", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-run-home-"));
  const nm = join(home, ".omp", "plugins", "node_modules");
  mkdirSync(join(nm, "@feigi"), { recursive: true });
  symlinkSync(join(home, "does", "not", "exist"), join(nm, "@feigi", "fleet-ctl"));
  const r = runFleetRun(home, ["--root"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dangling/);
});

test("--path prints the resolved script path without executing it", () => {
  const { home, payload } = fakeInstall();
  const r = runFleetRun(home, ["--path", "probe.mjs"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(realpathSync(payload), "scripts", "probe.mjs"));
});

test("a bare script name execs the resolved file, arguments and exit code passed through", () => {
  const { home, payload } = fakeInstall();
  writeFileSync(join(payload, "scripts", "echo-args.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const r = runFleetRun(home, ["echo-args.mjs", "a", "b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), ["a", "b"]);
});

test("a script that does not exist under the resolved install refuses by name", () => {
  const { home } = fakeInstall();
  const r = runFleetRun(home, ["does-not-exist.mjs"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /script not found/);
  assert.match(r.stderr, /does-not-exist\.mjs/);
});
