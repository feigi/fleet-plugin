// The Provenance check (ADR 0021): which install kind the Install root is,
// its recorded version, the scripts/ digest over the whole file set under
// `<Install root>/scripts`, Resolver drift, and the exit contract (0 clean,
// 1 drift, 2 nothing to resolve). Driven through the real CLI —
// fleet-provenance reads `os.homedir()` directly and `process.exit()`s.
//
// Every fixture's env is built from scratch (never `...process.env`), so
// these tests are deterministic regardless of the box they run on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVENANCE = fileURLToPath(new URL("./fleet-provenance", import.meta.url));

function runProvenance(home) {
  return spawnSync(process.execPath, [PROVENANCE], {
    encoding: "utf8",
    env: { HOME: home, PATH: process.env.PATH },
  });
}

// A payload whose scripts/ holds a top-level file and one nested
// subdirectory carrying a dotfile, so a walk that skipped either shrinks
// the file count.
function writePayload(payload) {
  const sub = join(payload, "scripts", "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(payload, "scripts", "fleet-run"), "resolver\n");
  writeFileSync(join(sub, ".hidden"), "nested\n");
  return sub;
}

// An install of the given kind, with the Resolver placed byte-identical to
// the installed copy so drift never decides the exit code:
//   marketplace — node_modules entry symlinked into omp's plugin cache;
//   npm         — node_modules entry a real directory (what npm unpacks);
//   link        — node_modules entry symlinked to a checkout elsewhere.
function fakeInstall(kind = "marketplace") {
  const home = mkdtempSync(join(tmpdir(), "fleet-provenance-home-"));
  const nm = join(home, ".omp", "plugins", "node_modules");
  const entry = join(nm, "@feigi", "fleet-ctl");
  mkdirSync(join(nm, "@feigi"), { recursive: true });
  let sub;
  if (kind === "npm") {
    sub = writePayload(entry);
  } else {
    const payload = kind === "marketplace"
      ? join(home, ".omp", "plugins", "cache", "a")
      : join(home, "checkout", "plugin");
    sub = writePayload(payload);
    symlinkSync(payload, entry);
  }
  mkdirSync(join(home, ".fleet", "bin"), { recursive: true });
  writeFileSync(join(home, ".fleet", "bin", "fleet-run"), "resolver\n");
  return { home, sub };
}

const NOTICE = /NOTICE: Install root is a linked checkout/;

for (const [kind, expected] of [["npm", "npm-install"], ["marketplace", "marketplace-install"]]) {
  test(`a ${kind}-shaped install reports kind ${expected}, exit 0, no linked-checkout NOTICE`, () => {
    const { home } = fakeInstall(kind);
    const r = runProvenance(home);
    assert.equal(r.status, 0, `expected success, got status ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^fleet-provenance: kind: ${expected}$`, "m"));
    assert.doesNotMatch(r.stdout, NOTICE);
  });
}

test("a link to a checkout outside omp's cache reports kind linked-checkout and a NOTICE, still exit 0", () => {
  const { home } = fakeInstall("link");
  const r = runProvenance(home);
  assert.equal(r.status, 0, `a link is the dev loop, not a failure: status ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^fleet-provenance: kind: linked-checkout$/m);
  assert.match(r.stdout, NOTICE);
});

test("the version line reads the lock entry, and says none recorded without one", () => {
  const { home } = fakeInstall("npm");
  assert.match(runProvenance(home).stdout, /^fleet-provenance: version: \(none recorded\)$/m);
  writeFileSync(
    join(home, ".omp", "plugins", "omp-plugins.lock.json"),
    JSON.stringify({ plugins: { "@feigi/fleet-ctl": { version: "1.2.3" } } }),
  );
  assert.match(runProvenance(home).stdout, /^fleet-provenance: version: 1\.2\.3$/m);
});

test("no node_modules/@feigi/fleet-ctl entry: exit 2, stderr names the missing plugin, nothing certified", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-provenance-home-"));
  const r = runProvenance(home);
  assert.equal(r.status, 2, `expected a resolution refusal, got status ${r.status}: ${r.stdout}`);
  assert.match(r.stderr, /no omp plugin "@feigi\/fleet-ctl"/);
  assert.equal(r.stdout, "");
});

test("a placed Resolver that differs from the installed copy refuses as drift, exit 1", () => {
  const { home } = fakeInstall("npm");
  writeFileSync(join(home, ".fleet", "bin", "fleet-run"), "stale resolver\n");
  const r = runProvenance(home);
  assert.equal(r.status, 1, `expected drift to fail the check, got status ${r.status}: ${r.stdout}`);
  assert.match(r.stdout, /Resolver drift: REFUSED/);
});

test("a readable nested subdirectory, dotfiles included, is digested with the rest of scripts/", () => {
  const { home } = fakeInstall();
  const r = runProvenance(home);
  assert.equal(r.status, 0, `expected success, got status ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /scripts\/ digest: sha256 [0-9a-f]{64} \(2 files\)/);
});

test("an empty scripts/ makes the digest UNAVAILABLE rather than certifying nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-provenance-home-"));
  const entry = join(home, ".omp", "plugins", "node_modules", "@feigi", "fleet-ctl");
  mkdirSync(join(entry, "scripts"), { recursive: true });
  const r = runProvenance(home);
  assert.match(r.stdout, /scripts\/ digest: UNAVAILABLE — no files under .*scripts — refusing to certify an empty set/);
  assert.doesNotMatch(r.stdout, /scripts\/ digest: sha256/);
});

test("an unlistable nested subdirectory makes the digest UNAVAILABLE, never a shorter file set", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("chmod 000 does not deny a directory listing here");
    return;
  }
  const { home, sub } = fakeInstall();
  chmodSync(sub, 0o000);
  try {
    const r = runProvenance(home);
    assert.match(r.stdout, /scripts\/ digest: UNAVAILABLE — cannot list .*sub \(EACCES\)/);
    assert.doesNotMatch(r.stdout, /scripts\/ digest: sha256/);
  } finally {
    chmodSync(sub, 0o755);
  }
});
