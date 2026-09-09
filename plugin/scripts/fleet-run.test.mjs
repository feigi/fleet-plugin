// The digest-based immateriality decision in fleet-run's ambiguous
// both-registries-present branch (#1355 review, round 2): refusing is only
// right when the pick actually matters. Driven through the real CLI —
// fleet-run reads `process.env`/`os.homedir()` directly and `process.exit()`s,
// so it cannot be exercised in-process the way a module-exporting script can.
//
// Every fixture's env is built from scratch (never `...process.env`), so
// these tests are deterministic regardless of the box they run on — in
// particular regardless of whether OMPCODE/CLAUDECODE happen to be set in
// the ambient ancestor shell, which is exactly the condition under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FLEET_RUN = fileURLToPath(new URL("./fleet-run", import.meta.url));

// A fake `$HOME` with both harnesses' registries pointing at `scripts/`
// directories holding one file each with the given content — identical
// content makes the two installs' digests match, different content makes
// them diverge.
function fakeHome(claudeContent, ompContent) {
  const home = mkdtempSync(join(tmpdir(), "fleet-run-home-"));
  const claudeRoot = join(home, ".claude", "plugins", "cache", "a");
  const ompRoot = join(home, ".omp", "plugins", "cache", "b");
  mkdirSync(join(claudeRoot, "scripts"), { recursive: true });
  mkdirSync(join(ompRoot, "scripts"), { recursive: true });
  writeFileSync(join(claudeRoot, "scripts", "probe.mjs"), claudeContent);
  writeFileSync(join(ompRoot, "scripts", "probe.mjs"), ompContent);
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  mkdirSync(join(home, ".omp", "plugins"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "fleet-ctl@fleet-plugin": [{ scope: "user", installPath: claudeRoot }] } }),
  );
  writeFileSync(
    join(home, ".omp", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "fleet-ctl@fleet-plugin": [{ scope: "user", installPath: ompRoot }] } }),
  );
  return { home, claudeRoot, ompRoot };
}

function runFleetRun(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [FLEET_RUN, ...args], {
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH, ...extraEnv },
  });
}

test("both registries present, no positive signal, byte-identical scripts/: picks deterministically and succeeds", () => {
  const { home, claudeRoot } = fakeHome("same content\n", "same content\n");
  const r = runFleetRun(home, ["--root"]);
  assert.equal(r.status, 0, `expected success, got status ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout.trim(), claudeRoot, "the documented fallback order is: positive signal, else claude");
  assert.match(r.stderr, /byte-identical on both/);
  assert.match(r.stderr, /picking claude/);
});

test("both registries present, no positive signal, differing scripts/: refuses rather than guess", () => {
  const { home } = fakeHome("claude content\n", "omp content, different\n");
  const r = runFleetRun(home, ["--root"]);
  assert.equal(r.status, 2, `expected a resolver refusal, got status ${r.status}: ${r.stdout}`);
  assert.match(r.stderr, /digests differ/);
  assert.match(r.stderr, /FLEET_HARNESS=claude or FLEET_HARNESS=omp/);
});

test("both registries present, no positive signal, differing scripts/, FLEET_HARNESS set: obeys the override", () => {
  const { home, ompRoot } = fakeHome("claude content\n", "omp content, different\n");
  const r = runFleetRun(home, ["--root"], { FLEET_HARNESS: "omp" });
  assert.equal(r.status, 0, `expected the override to be obeyed, got status ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout.trim(), ompRoot);
});

test("both registries present, a positive signal (CLAUDECODE set, OMPCODE unset): prefers it regardless of digest", () => {
  const { home, claudeRoot } = fakeHome("claude content\n", "omp content, different\n");
  const r = runFleetRun(home, ["--root"], { CLAUDECODE: "1" });
  assert.equal(r.status, 0, `expected success, got status ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout.trim(), claudeRoot);
  assert.match(r.stderr, /running harness detected as claude/);
});

test("only one registry present: no digest check, no ambiguity", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-run-home-"));
  const claudeRoot = join(home, ".claude", "plugins", "cache", "a");
  mkdirSync(join(claudeRoot, "scripts"), { recursive: true });
  writeFileSync(join(claudeRoot, "scripts", "probe.mjs"), "content\n");
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "fleet-ctl@fleet-plugin": [{ scope: "user", installPath: claudeRoot }] } }),
  );
  const r = runFleetRun(home, ["--root"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), claudeRoot);
  assert.equal(r.stderr, "", "a single present registry needs no notice at all");
});
