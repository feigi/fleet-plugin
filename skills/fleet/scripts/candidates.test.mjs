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
search=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) shift; expr="$1" ;;
    --search) shift; search="$1" ;;
  esac
  shift
done
# The fallback is the query with no POSITIVE label: term. The leading space is
# the whole test and cannot be dropped: every exclusion is spelled \`-label:\`,
# so a bare \`*label:*\` matches the unfiltered query too and silently serves it
# the labeled fixture — the fallback then looks untaken however well it works.
# \$search is padded so the term still matches when it leads: gh ignores
# qualifier order, so reordering query()'s template must not invert this.
# No second fixture supplied — both queries see the same rows, as before.
# The two fixtures are deliberately DISJOINT, which real gh could never be
# (unfiltered is a superset). A faithful superset makes the stub's ignored
# --limit stop the cap tests firing. So never assert a labeled row is ABSENT
# from the fallback payload — it was never in that fixture, and it passes
# whatever the code does.
fixture="$FIXTURE"
case " $search " in
  *\\ label:*) ;;
  *) [ -n "$FIXTURE_UNFILTERED" ] && fixture="$FIXTURE_UNFILTERED" ;;
esac
exec jq -c "$expr" "$fixture"
`;

function run(issues, args = ["--require-label", "ready-for-agent"], unfiltered = null) {
  const dir = mkdtempSync(join(tmpdir(), "candidates-"));
  const fixture = join(dir, "issues.json");
  writeFileSync(fixture, JSON.stringify(issues));
  const gh = join(dir, "gh");
  writeFileSync(gh, STUB);
  chmodSync(gh, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: fixture };
  if (unfiltered) {
    const second = join(dir, "unfiltered.json");
    writeFileSync(second, JSON.stringify(unfiltered));
    env.FIXTURE_UNFILTERED = second;
  }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  rmSync(dir, { recursive: true, force: true });
  return { ...r, rows: r.stdout.trim() ? JSON.parse(r.stdout) : [] };
}

// Labels are settled by the fixture, not by the query: the stub ignores
// `--search`'s label term beyond picking a fixture. A row in the unfiltered
// fixture therefore has to carry a label that would NOT have matched the
// labeled query, or the two fixtures contradict each other.
const ticket = (n, body, labels = ["ready-for-agent"]) => ({
  number: n,
  title: `ticket ${n}`,
  labels: labels.map((name) => ({ name })),
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

test("a labeled queue of only specs falls back to unfiltered — all filtered out is an empty queue", () => {
  // The emptiness test gating --allow-fallback has to read the length AFTER
  // the specs are dropped. Reading the raw one leaves a ready-for-agent queue
  // holding nothing but to-spec specs reporting "no work" with the fallback
  // untried, while #12 sits there claimable.
  const { rows, status, stderr } = run(
    [
      ticket(10, "## Problem Statement\n\nx\n\n## User Stories\n\n1. As a user…\n"),
      ticket(11, "## User Stories\n\n2. As a user…\n"),
    ],
    ["--require-label", "ready-for-agent", "--allow-fallback"],
    [
      ticket(12, "## What to build\n\nreal work\n", ["ready-for-human"]),
      // A spec HERE is what makes the assertion below discriminate: delete the
      // strip inside the fallback and #13 ships as a claimable ticket. A leaked
      // spec passes phase 2's bail tests, so a member implements a whole spec.
      ticket(13, "## User Stories\n\n4. As a user…\n", ["ready-for-human"]),
    ],
  );
  assert.deepEqual(rows.map((r) => r.n), [12]);
  // The BRANCH ran, not merely that the unfiltered fixture reached some query.
  // Move the positive term to the front of `search` and the stub serves the
  // LABELED query the unfiltered fixture: same payload, same status, fallback
  // never entered. The payload alone pins the fixture, never the branch.
  assert.match(stderr, /retrying unfiltered/);
  // Two queries actually RAN. The announcement above prints before the query,
  // so it pins the branch being entered, never that its answer shipped.
  assert.equal(stderr.match(/^\$ gh /gm).length, 2);
  // The strip inside the block ran. Delete that line and every assertion above
  // still passes while `spec` — and any spec row — reaches the payload.
  assert.deepEqual(Object.keys(rows[0]).sort(), ["d", "l", "n", "t"]);
  // Exit 0, not 1: the payload and the "is there work" answer are one fact,
  // and a caller that reads only the status must not still hear "empty".
  assert.equal(status, 0);
});

test("the cap is checked before specs are dropped in the fallback too, not only in the labeled query", () => {
  // The cap-before-drop ordering of "the cap is checked before specs are
  // dropped", one branch deeper — NOT the drop-before-emptiness test directly
  // above, which pins the other half of the same wedge. The labeled query is
  // under its cap on 1 row, empties out, and hands over to the fallback —
  // whose 2 rows hit --limit 2 exactly. Drop first and one spec leaves, the
  // cap check sees 1, and the truncated list ships as an answer.
  const { status, stderr } = run(
    [ticket(10, "## User Stories\n\n1. As a user…\n")],
    ["--require-label", "ready-for-agent", "--allow-fallback", "--limit", "2"],
    [
      ticket(12, "## User Stories\n\n3. As a user…\n", ["ready-for-human"]),
      ticket(13, "## What to build\n\nx\n", ["ready-for-human"]),
    ],
  );
  assert.equal(status, 2);
  // Pin which query refused. `/capped/` alone is satisfied by the labeled
  // query dying, which is a different bug with the same exit code.
  assert.match(stderr, /unfiltered \(fallback\)/);
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
