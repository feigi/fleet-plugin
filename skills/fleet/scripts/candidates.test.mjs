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

test("every spec is dropped and named — a filter that stops at the first leaks the rest", () => {
  const { rows, stderr } = run([
    ticket(10, "## User Stories\n\n1. As a user, I want…\n"),
    ticket(11, "## Problem Statement\n\ny\n\n## User Stories\n\n2. As a user…\n"),
    ticket(12, "## What to build\n\nx\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [12]);
  // deepEqual on the parsed lines, not a substring match: `/dropped #10/` is
  // satisfied by a hardcoded number and by logging kept rows too. This pins
  // both that 10 and 11 are named and that 12 is not.
  assert.deepEqual(stderr.match(/dropped #\d+/g), ["dropped #10", "dropped #11"]);
});

test("near misses are kept — the predicate's shape is specified, not accidental", () => {
  // One fixture per dimension the regex commits to. Without these, every
  // loosening of the heading match still passes: the dropped fixture differs
  // from a ticket in all of them at once, so it discriminates none.
  const { rows } = run([
    ticket(1, "### User Stories\n\nnested under an h2\n"),
    ticket(2, "## user stories\n\nlowercase\n"),
    ticket(3, "##User Stories\n\nno separating space\n"),
    ticket(4, "## User Stories (draft)\n\ntrailing text\n"),
    ticket(5, "Mentions ## User Stories mid-line, not a heading.\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [1, 2, 3, 4, 5]);
});

test("the cap is checked before specs are dropped — filtering first hides truncation", () => {
  // The ordering candidates.mjs calls load-bearing. Swap the two and this is
  // the only thing that fails: dropSpecs shrinks the array below --limit, the
  // cap check stops seeing a capped list, and the silent-truncation bug the
  // "no silent caps" rule exists to close comes back with every test green.
  const { status, stderr } = run(
    [
      ticket(10, "## User Stories\n\n1. As a user…\n"),
      ticket(11, "## What to build\n\nx\n"),
    ],
    ["--require-label", "ready-for-agent", "--limit", "2"],
  );
  assert.equal(status, 2);
  assert.match(stderr, /capped/);
});

test("the spec predicate never reaches the payload — it is pure token cost downstream", () => {
  const { rows } = run([ticket(12, "## What to build\n\nplain ticket\n")]);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["d", "l", "n", "t"]);
});

test("candidates come back oldest first, whatever order gh returned them in", () => {
  // gh defaults to created-desc, so newest-first is the realistic input.
  const { rows } = run([
    ticket(42, "## What to build\n\nc\n"),
    ticket(19, "## What to build\n\nb\n"),
    ticket(7, "## What to build\n\na\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [7, 19, 42]);
});
