// Regression gate for the candidate query's two filters: to-spec specs never
// reach the queue, and the list comes back oldest-first.
//
// candidates.mjs applies its reduction through gh's server-side `--jq`, so the
// stub below runs the real jq against a fixture with the same expression gh
// would have received. Stubbing gh to return already-reduced JSON would leave
// the jq expression — which is where the spec predicate actually lives —
// completely untested.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./candidates.mjs", import.meta.url));

const STUB = `#!/bin/sh
# Stand-in for \`gh issue list … --jq <expr>\`. Applies the expression gh was
# given to the fixture, so the expression is under test rather than assumed.
expr=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) shift; expr="$1" ;;
  esac
  shift
done
exec jq -c "$expr" "$FIXTURE"
`;

function run(issues, args = ["--require-label", "ready-for-agent"]) {
  const dir = mkdtempSync(join(tmpdir(), "candidates-"));
  const fixture = join(dir, "issues.json");
  writeFileSync(fixture, JSON.stringify(issues));
  const gh = join(dir, "gh");
  writeFileSync(gh, STUB);
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: fixture },
  });
  rmSync(dir, { recursive: true, force: true });
  return { ...r, rows: r.stdout.trim() ? JSON.parse(r.stdout) : [] };
}

const ticket = (n, body) => ({
  number: n,
  title: `ticket ${n}`,
  labels: [{ name: "ready-for-agent" }],
  body,
});

test("a to-spec spec is dropped — it is to-tickets' input, not a claimable ticket", () => {
  const { rows } = run([
    ticket(10, "## Problem Statement\n\nx\n\n## User Stories\n\n1. As a user, I want…\n"),
    ticket(11, "## What to build\n\nAdd a --json flag.\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [11]);
});

test("a drop names the issue number — a filtered list that says nothing reads as complete", () => {
  const { stderr } = run([
    ticket(10, "## User Stories\n\n1. As a user, I want…\n"),
    ticket(11, "## What to build\n\nx\n"),
  ]);
  assert.match(stderr, /dropped #10/);
});

test("the spec predicate never reaches the payload — it is pure token cost downstream", () => {
  const { rows } = run([ticket(12, "## What to build\n\nplain ticket\n")]);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["d", "l", "n", "t"]);
});
