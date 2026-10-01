// The Provenance check's scripts/ digest (ADR 0021): it certifies the whole
// file set under `<Install root>/scripts`, so a subtree it cannot list must
// fail the digest rather than shrink it. Driven through the real CLI —
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

// A marketplace-shaped install whose scripts/ holds a top-level file and one
// nested subdirectory, with the Resolver placed byte-identical to the
// installed copy so drift never decides the exit code.
function fakeInstall() {
  const home = mkdtempSync(join(tmpdir(), "fleet-provenance-home-"));
  const payload = join(home, ".omp", "plugins", "cache", "a");
  const sub = join(payload, "scripts", "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(payload, "scripts", "fleet-run"), "resolver\n");
  writeFileSync(join(sub, "hidden.mjs"), "nested\n");
  const nm = join(home, ".omp", "plugins", "node_modules");
  mkdirSync(join(nm, "@feigi"), { recursive: true });
  symlinkSync(payload, join(nm, "@feigi", "fleet-ctl"));
  mkdirSync(join(home, ".fleet", "bin"), { recursive: true });
  writeFileSync(join(home, ".fleet", "bin", "fleet-run"), "resolver\n");
  return { home, sub };
}

test("a readable nested subdirectory is digested with the rest of scripts/", () => {
  const { home } = fakeInstall();
  const r = runProvenance(home);
  assert.equal(r.status, 0, `expected success, got status ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /scripts\/ digest: sha256 [0-9a-f]{64} \(2 files\)/);
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
