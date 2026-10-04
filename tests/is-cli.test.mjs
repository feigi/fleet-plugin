// is-cli.mjs: the "was this module run as the CLI?" guard every script ends
// with. A string comparison of import.meta.url against argv[1] skipped main()
// whenever the script was reached through a symlinked path (on macOS `/tmp` is
// one) and exited 0 with no output — the code that reads as "nothing to do".
// The second half of this file runs every CLI script through a symlinked
// directory, one case per script, because the helper being right says nothing
// about a script that does not call it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { isCLI } from "../plugin/scripts/is-cli.mjs";

const SCRIPTS_DIR = fileURLToPath(new URL("../plugin/scripts", import.meta.url));

function fixture() {
  const dir = tempDir("is-cli-");
  const file = join(dir, "real.mjs");
  writeFileSync(file, "export {};\n");
  return { dir, file, url: pathToFileURL(file).href };
}

test("isCLI accepts the module's own path, a relative path to it and a symlink to it", () => {
  const { dir, file, url } = fixture();
  const link = join(dir, "link.mjs");
  symlinkSync(file, link);
  assert.equal(isCLI(url, file), true);
  assert.equal(isCLI(url, relative(process.cwd(), file)), true);
  assert.equal(isCLI(url, link), true);
});

test("isCLI accepts a module reached through a symlinked directory", () => {
  const { dir, file, url } = fixture();
  const linkDir = join(dir, "dir-link");
  symlinkSync(dir, linkDir);
  assert.equal(isCLI(url, join(linkDir, "real.mjs")), true);
  assert.equal(isCLI(pathToFileURL(join(linkDir, "real.mjs")).href, file), true);
});

test("isCLI refuses another module — an import, not a run", () => {
  const { dir, url } = fixture();
  const other = join(dir, "other.mjs");
  writeFileSync(other, "export {};\n");
  assert.equal(isCLI(url, other), false);
});

test("isCLI refuses, rather than throws, when argv[1] is missing or names nothing", () => {
  const { dir, url } = fixture();
  assert.equal(isCLI(url, null), false);
  assert.equal(isCLI(url, ""), false);
  assert.equal(isCLI(url, join(dir, "gone.mjs")), false);
  assert.equal(isCLI(url, "-"), false);
});

test("isCLI defaults to the live process.argv[1]", () => {
  const { url } = fixture();
  assert.equal(isCLI(url), false);
  assert.equal(isCLI(pathToFileURL(process.argv[1]).href), true);
});

// Each script refuses an unknown flag with exit 2 before it reads or writes
// anything; a skipped main() exits 0. The real-path run is the control: the
// symlinked run must match it, not merely be non-zero.
const CLI_SCRIPTS = [
  "diff-stats", "fleet-heartbeat", "fleet-tick", "frontmatter-check", "main-checkout",
  "member-outcomes", "tier-check", "tier-outcomes", "tier-roles", "board", "dispositions-check", "recipe-prove",
];

for (const name of CLI_SCRIPTS) {
  test(`${name}.mjs run through a symlinked path still runs main()`, () => {
    const dir = tempDir("is-cli-run-");
    const linkDir = join(dir, "scripts-link");
    symlinkSync(SCRIPTS_DIR, linkDir);
    const run = (script) => spawnSync(process.execPath, [script, "--bogus"], { cwd: dir, encoding: "utf8" });
    const real = run(join(SCRIPTS_DIR, `${name}.mjs`));
    const linked = run(join(linkDir, `${name}.mjs`));
    assert.equal(real.status, 2, real.stderr);
    assert.equal(linked.status, real.status, `via symlink: ${linked.stderr}`);
    assert.equal(linked.stderr, real.stderr);
  });
}

// The other direction: the control above cannot tell a guard that tests the
// path from one that is always true — both run main() under --bogus. Loading
// the script as a module must leave main() unrun: no output, exit 0.
for (const name of CLI_SCRIPTS) {
  test(`${name}.mjs imported as a module does not run main()`, () => {
    const dir = tempDir("is-cli-import-");
    const url = pathToFileURL(join(SCRIPTS_DIR, `${name}.mjs`)).href;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, "");
  });
}
