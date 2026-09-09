import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// #1349's own acceptance text: `grep -n 'pr-review-toolkit' workflows/ skills/
// commands/` returns nothing — the six vendored names are never DISPATCHED.
// Scoped to those three directories deliberately, not the whole `plugin/`
// tree: `agents/fleet-review-*.agent.md`'s credit comments plainly name the
// vendored source they adapted a prompt from (review finding on #1361 — an
// earlier revision obfuscated the slug there to satisfy an over-widened
// reading of this same criterion, which helped nobody and made the credit
// harder to verify). Attribution prose and dispatch names are different
// claims; this pins the one #1349 actually makes.
const REPO = join(import.meta.dirname, "..");

function allFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(full));
    else out.push(full);
  }
  return out;
}

test("no file under workflows/, skills/, or commands/ mentions the retired vendor plugin", () => {
  for (const dir of ["workflows", "skills", "commands"]) {
    for (const file of allFiles(join(REPO, dir))) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /pr-review-toolkit/, `${file} still mentions pr-review-toolkit`);
    }
  }
});

// The counterpart: agents/ deliberately DOES name it, in plain text, as
// attribution — this is not covered by the criterion above and must not be
// "fixed" into the same obfuscated shape a prior revision tried.
test("agents/fleet-review-*.agent.md credit the vendored source plainly, not obfuscated", () => {
  const dims = ["correctness", "silent-failure", "tests", "comments", "types", "simplify"];
  for (const key of dims) {
    const text = readFileSync(join(REPO, "agents", `fleet-review-${key}.agent.md`), "utf8");
    assert.match(text, /pr-review-toolkit/, `fleet-review-${key}.agent.md no longer plainly credits the vendored plugin`);
  }
});
