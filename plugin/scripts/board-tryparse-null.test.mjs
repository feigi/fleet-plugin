// #1181: board.mjs's `tryParse` guarded its INPUT string against nullish and
// not its PARSED VALUE. `JSON.parse("null")` succeeded and yielded null, so a
// bare `null` payload skipped the fallback and reached the caller as its
// answer — the shape #1170 fixed one function over, in `mapCi`.
//
// That gap does not crash either of tryParse's two current callers today:
// withNumber's own array guard already rejects a null `rows` at the ghRows
// call site, and gather()'s ledger branch already treats a null parse as
// falsy. This guard is defense in depth, not a crash fix — what it actually
// changes is (a) one named "payload is JSON null" stderr line in place of a
// caller's own, more generic shape complaint, and (b) real protection for a
// future tryParse caller with no shape guard of its own downstream. The two
// "refusal" tests below pin that stderr line; their value assertions were
// already true before this guard existed, and stay here as regression
// coverage for the caller-visible shape, not as proof of the fix.
//
// Driven through the exported `gather()` rather than against `tryParse`, which
// is module-private: the guard is only observable where a caller consumes the
// result, and that is the boundary a consumer actually sees. Out of process for
// the reason board.test.mjs's own gather drivers are — gather() reads
// process.argv and would otherwise read the test runner's.
//
// A separate file rather than more of board.test.mjs, the same reason
// ledger-read-require-file.test.mjs gives: the fleet runs several implementers
// at once and two PRs appending to one test file conflict, which costs the PR
// its CI entirely.
//
// The accept side of a well-formed payload is board.test.mjs's "a well-formed
// issue/PR row passes through unchanged", at this same seam; what is pinned
// here is the accept side this guard could newly break — a parsed answer that
// is FALSY but readable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOARD = fileURLToPath(new URL("./board.mjs", import.meta.url));

// `repo view` answers a real object so nothing but the read under test can put
// the string "parse failed" on stderr; the assertions below are scoped to their
// own read besides, so neither guard rests on the other.
const REPO_JSON = '{"nameWithOwner":"o/r","url":"https://example.invalid/o/r"}';

// `ledgerBody` is the body of a stub `ledger.mjs`. board.mjs spawns
// `node <scriptDir>/ledger.mjs`, and only a stub can hand it stdout that
// arrives at exit 0 and parses to something no real ledger.mjs emits.
function gatherWith({ issuesJson = "[]", prsJson = "[]", ledgerBody = null } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "board-tpnull-"));
  const bin = mkdtempSync(join(tmpdir(), "board-tpnull-bin-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "board-tpnull-scripts-"));

  writeFileSync(join(scriptDir, "ci-state.mjs"), "process.stdout.write('{}');\n");
  writeFileSync(join(scriptDir, "ledger.mjs"),
    ledgerBody ?? `console.log(JSON.stringify({ rows: [], filed: [], ruled: [] }));`);
  writeFileSync(join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n` +
    `"issue list") echo '${issuesJson}' ;;\n` +
    `"pr list") echo '${prsJson}' ;;\n` +
    `"repo view") echo '${REPO_JSON}' ;;\n` +
    `*) exit 1 ;;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);

  const driver = `const { gather } = await import(${JSON.stringify(BOARD)});
    const r = gather({ ledgerFile: ${JSON.stringify(join(cwd, "ledger.md"))},
                       prevFile: null, scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    console.log(JSON.stringify({ issues: r.issues, prs: r.prs, ledger: r.ledger }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, `the driver itself must not fail\n${r.stdout}${r.stderr}`);
  return { ...JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr };
}

// ── the refusal ──────────────────────────────────────────────────────────────

test("gather: a `gh` payload that parses to JSON null degrades to an empty list, not to null (#1181)", () => {
  const r = gatherWith({ issuesJson: "null" });
  assert.deepEqual(r.issues, []);
  // Even without this guard tryParse still returns null here, and
  // withNumber's own array check already rejects a null `rows` — this site
  // never actually crashed. What the guard changes is the wording: this
  // named line in place of withNumber's generic "expected an array of rows,
  // got null" shape complaint.
  assert.match(r.stderr, /gh issue list: payload is JSON null/);
  // And not worded as the catch branch's fault: the parse succeeded. Reusing
  // that message is the likeliest way to write this guard, and it puts the two
  // states the ledger read deliberately keeps apart (#816) back under one
  // wording, sending whoever reads it looking for malformed stdout that is not
  // there.
  assert.doesNotMatch(r.stderr, /gh issue list parse failed/);
});

test("gather: a ledger read that parses to JSON null is `unparsed`, and says which fault it was (#1181)", () => {
  const r = gatherWith({ ledgerBody: `console.log("null");` });
  assert.equal(r.ledger.state, "unparsed");
  assert.deepEqual({ rows: r.ledger.rows, filed: r.ledger.filed, ruled: r.ledger.ruled },
    { rows: [], filed: [], ruled: [] });
  assert.match(r.stderr, /ledger read: payload is JSON null/);
});

// ── the accept side: what this guard must NOT refuse ─────────────────────────

test("gather: a falsy-but-readable parsed payload still reaches the caller (#1181)", () => {
  // `0` stands for the whole falsy-but-readable class — `false` and `""` reach
  // the identical comparison — and it is the value that discriminates the
  // guard actually written from the one a reader reaches for: `=== null`
  // forwards it, `!parsed` swallows it. The forwarding is observable because
  // withNumber is then the thing that refuses it, and it names what it saw.
  const r = gatherWith({ issuesJson: "0" });
  assert.deepEqual(r.issues, []);
  assert.match(r.stderr, /gh issue list: expected an array of rows, got 0/,
    "tryParse must forward a falsy answer to its caller's own shape guard, not intercept it");
  assert.doesNotMatch(r.stderr, /gh issue list: payload is JSON null/,
    "0 is not null — reporting it as such is the falsiness bug this pins");
});
