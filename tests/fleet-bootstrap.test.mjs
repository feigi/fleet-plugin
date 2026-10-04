// fleet-bootstrap's checkout-vs-install decision (ADR 0003 point 4, ADR
// 0021): it places `~/.fleet/bin/fleet-run` from its own sibling copy, and
// only without `--from-checkout` when its own directory's parent IS the
// realpath of `~/.omp/plugins/node_modules/@feigi/fleet-ctl`. Driven through
// the real CLI — the script reads `__dirname` and `os.homedir()` and
// `process.exit()`s — so the installed shape runs a copy placed inside a fake
// install's scripts/.
//
// Every fixture's env is built from scratch (never `...process.env`), so
// these tests are deterministic regardless of the box they run on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOOTSTRAP = fileURLToPath(new URL("../plugin/scripts/fleet-bootstrap", import.meta.url));
const CHECKOUT_RESOLVER = fileURLToPath(new URL("../plugin/scripts/fleet-run", import.meta.url));

function runBootstrap(script, home, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH },
  });
}

// A linked install (the dev-loop shape, and a marketplace install's): a
// payload dir carrying fleet-bootstrap and a resolver in scripts/,
// symlinked into node_modules/@feigi/fleet-ctl.
function fakeInstall() {
  const home = mkdtempSync(join(tmpdir(), "fleet-bootstrap-home-"));
  const payload = join(home, "checkout", "plugin");
  mkdirSync(join(payload, "scripts"), { recursive: true });
  copyFileSync(BOOTSTRAP, join(payload, "scripts", "fleet-bootstrap"));
  writeFileSync(join(payload, "scripts", "fleet-run"), "installed resolver\n");
  const nm = join(home, ".omp", "plugins", "node_modules");
  mkdirSync(join(nm, "@feigi"), { recursive: true });
  symlinkSync(payload, join(nm, "@feigi", "fleet-ctl"));
  return { home, installedBootstrap: join(payload, "scripts", "fleet-bootstrap") };
}

const placed = (home) => join(home, ".fleet", "bin", "fleet-run");

test("run from the install root it places the installed resolver with no flag and no exception notice", () => {
  const { home, installedBootstrap } = fakeInstall();
  const r = runBootstrap(installedBootstrap, home);
  assert.equal(r.status, 0, `expected the install run to proceed, got status ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /BOOTSTRAP EXCEPTION/);
  assert.equal(readFileSync(placed(home), "utf8"), "installed resolver\n");
});

test("run from a checkout that is not the install root without --from-checkout: exit 2, nothing placed", () => {
  const { home } = fakeInstall();
  const r = runBootstrap(BOOTSTRAP, home);
  assert.equal(r.status, 2, `expected a refusal, got status ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /refusing to place .* which is not omp's resolved install root/);
  assert.equal(existsSync(placed(home)), false);
});

test("run from a checkout with no install at all: the refusal says omp is not installed", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-bootstrap-home-"));
  const r = runBootstrap(BOOTSTRAP, home);
  assert.equal(r.status, 2, `expected a refusal, got status ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /omp: not installed/);
});

test("run from a checkout with --from-checkout: places the checkout's resolver and announces the exception", () => {
  const { home } = fakeInstall();
  const r = runBootstrap(BOOTSTRAP, home, ["--from-checkout"]);
  assert.equal(r.status, 0, `expected the licensed exception to proceed, got status ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /BOOTSTRAP EXCEPTION/);
  assert.deepEqual(readFileSync(placed(home)), readFileSync(CHECKOUT_RESOLVER));
});
