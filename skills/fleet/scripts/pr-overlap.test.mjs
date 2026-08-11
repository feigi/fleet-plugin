// Regression gate for #169: a flag given with no value must die, by name,
// rather than being read as absent or silently consumed as the following
// flag's own value.
//
// `--a`/`--b` given trailing were already caught by pr-overlap.mjs's own
// `if (!a || !b) die(...)` guard — `undefined` is falsy — so it was never a
// silent-widening site the way ci-state.mjs's `--base`/`--workflow` were (see
// feigi's PR #167 review comment). What was NOT caught: `--a` given `--b` as
// its "value" (`pr-overlap.mjs --a --b 5`) — `a` becomes the string "--b",
// passes the falsy check, and only failed later as a confusing `gh pr diff
// --b` error instead of a clear refusal naming the flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./pr-overlap.mjs", import.meta.url));

test("CLI: trailing --a (no value) dies (exit 2) naming the flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--a"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--a needs a value/);
});

test("CLI: --a followed by --b is rejected by name, not run through gh as a PR ref", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--a", "--b", "5"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--a needs a value/);
});

test("CLI: --a=5 form dies by name, not silently read as absent", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--a=5", "--b", "6"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--a needs a space-separated value/);
});

// `value.trim() === ""` was the one clause of the guard no test in any of the
// four scripts reached — it could be deleted from all four at once, green.
test("CLI: --a given a whitespace-only value dies naming the flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--a", "   ", "--b", "6"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--a needs a value/);
});
