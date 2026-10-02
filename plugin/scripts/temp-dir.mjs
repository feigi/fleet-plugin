// Temp directories for test fixtures that are removed when the process exits.
//
// A fixture builder deep inside a helper often has no node:test context to
// hang a `t.after()` on, and a bare `mkdtempSync(join(tmpdir(), …))` there
// leaves its directory behind for good: across the suite that was hundreds of
// directories per run. Each one made here is recorded and removed at process
// exit instead — one process per test file under `node --test`, so the
// directories live exactly as long as the file that made them.
//
// Removal restores owner permissions first when a plain remove fails: a
// fixture that chmods a directory unsearchable and then fails before its own
// restore would otherwise make `rmSync` throw and the directory survive.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = [];

function remove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    spawnSync("chmod", ["-R", "u+rwX", dir]);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      // An exception thrown from an exit handler would replace the run's own
      // exit status, so a directory that still cannot go is reported instead.
      process.stderr.write(`temp-dir: could not remove ${dir}: ${e.message}\n`);
    }
  }
}

process.on("exit", () => {
  for (const dir of made) remove(dir);
});

/** `mkdtempSync(join(tmpdir(), prefix))`, removed when this process exits. */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
