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
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// `value.trim() === ""` was the one clause of the guard no test reached in any
// of the five scripts that then carried their own copy of it — board,
// candidates, ci-state, diff-stats, pr-overlap — so it could be deleted from
// all five at once, green. #367 has since folded those copies into arg.mjs's
// single one, which every one of the five still routes through.
test("CLI: --a given a whitespace-only value dies naming the flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--a", "   ", "--b", "6"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--a needs a value/);
});

// The other half of arg()'s guard: every case above is a value it must
// REFUSE. Nothing above ever hands the script a well-formed pair, so #367's
// shared arg() could return `undefined` for every accepted input and this
// file would stay green. `--a 1 --b 2` must reach gh and report a verdict.
test("CLI: well-formed --a/--b values are accepted and the CLI reports a verdict", () => {
  const bin = mkdtempSync(join(tmpdir(), "pr-overlap-bin-"));
  const gh = join(bin, "gh");
  // `$3` is the PR number pr-overlap.mjs passes as `gh pr diff <pr> --name-only`.
  writeFileSync(
    gh,
    '#!/bin/sh\ncase "$3" in\n  1) echo src/shared.ts ;;\n  2) echo src/shared.ts ;;\nesac\n',
  );
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--a", "1", "--b", "2"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(payload, { a: 1, b: 2, files: ["src/shared.ts"], modules: ["shared"], dirs: ["src"], signal: "files" });
});

// #878: `--a 0`/`--b 0` is the row the `=== null` absence check exists for,
// and the one a later "simplification" back to `!a || !b` silently breaks:
// numArg() returns a NUMBER, so `!a` is true for a zero the caller plainly
// GAVE, and the usage die above would then answer it as though `--a` were
// never given at all. Companion to arg.test.mjs's identical row for
// diff-stats.mjs and ci-state.test.mjs's own for `--pr` — #878's own comment
// names all three callers as sharing this contract, and only diff-stats.mjs
// had this row before.
//
// `strictEqual` on both fields, same reason as the well-formed test above: a
// payload reading `a`/`b` back as the string "0" would satisfy a loose check
// while breaking every consumer that keys on a number.
test("#878: --a 0/--b 0 reach gh rather than drawing the usage line for an absent flag", () => {
  const bin = mkdtempSync(join(tmpdir(), "pr-overlap-bin-"));
  const gh = join(bin, "gh");
  writeFileSync(gh, '#!/bin/sh\ncase "$3" in\n  0) echo src/shared.ts ;;\nesac\n');
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--a", "0", "--b", "0"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /usage:/, `--a 0/--b 0 was answered as an absent flag: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.a, 0, `a zero --a must survive to the payload as 0: ${r.stdout}`);
  assert.strictEqual(payload.b, 0, `a zero --b must survive to the payload as 0: ${r.stdout}`);
});
