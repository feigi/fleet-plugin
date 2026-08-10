// Regression gate for the candidate query's two filters — to-spec specs never
// reach the queue, and the list comes back oldest-first — and for its exit
// codes, which are the whole interface for a caller that reads no stderr: 2 is
// "the query broke", 1 is "the queue is empty", and the two must never swap.
//
// candidates.mjs applies its reduction through gh's `--jq`, so the stub below
// runs the same expression gh would have received — under the system jq it
// execs, not the gojq gh embeds and applies in its own process. The spec
// predicate is under test; the ENGINE is not, and the live predicate already
// turns on the difference: `\s` and `\d` are Unicode-aware in jq's Oniguruma
// and ASCII-only in Go's RE2, so a `## User Stories` padded with U+00A0 is a
// spec here and NOT one under gh, where dropSpecs is the only line of defence
// (#204). Nothing announces that: a pattern gojq rejects outright at least
// exits non-zero, but a class that merely matches differently leaves this
// suite green either way. Stubbing gh to return already-reduced JSON would
// leave the jq expression — which is where the spec predicate actually lives —
// completely untested.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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
# gh applies \`--jq\` itself, inside its own process, so a reduction that did not
# take is a real failure mode — an old gh, an expression it rejects, a proxy
# answering with an error object. Overriding the expression is the only way a
# test reaches the empty and non-array refusals: the real one always emits an
# array. It is NOT the only way to reach the row-shape refusal, which a fixture
# alone trips whenever a field's type is wrong upstream (\`"number":"11"\` reduces
# to \`{"n":"11"}\`) — the expression fixes the key set, never the value types.
[ -n "$JQ_OVERRIDE" ] && expr="$JQ_OVERRIDE"
fixture="$FIXTURE"
case " $search " in
  *\\ label:*) ;;
  *) [ -n "$FIXTURE_UNFILTERED" ] && fixture="$FIXTURE_UNFILTERED" ;;
esac
exec jq -c "$expr" "$fixture"
`;

function run(issues, args = ["--require-label", "ready-for-agent"], unfiltered = null, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "candidates-"));
  const fixture = join(dir, "issues.json");
  writeFileSync(fixture, JSON.stringify(issues));
  const gh = join(dir, "gh");
  writeFileSync(gh, STUB);
  chmodSync(gh, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: fixture, ...extraEnv };
  if (unfiltered) {
    const second = join(dir, "unfiltered.json");
    writeFileSync(second, JSON.stringify(unfiltered));
    env.FIXTURE_UNFILTERED = second;
  }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  rmSync(dir, { recursive: true, force: true });
  return { ...r, rows: r.stdout.trim() ? JSON.parse(r.stdout) : [] };
}

// For the failure shapes the fixture stub cannot reach — it always `exec`s jq,
// so it can only ever fail by exit status. A gh that kills itself, or one that
// is absent, is a different `execFileSync` error object entirely.
function runWithGh(script) {
  const dir = mkdtempSync(join(tmpdir(), "candidates-gh-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, script);
  chmodSync(gh, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const r = spawnSync(process.execPath, [SCRIPT, "--require-label", "ready-for-agent"], {
    encoding: "utf8",
    env,
  });
  rmSync(dir, { recursive: true, force: true });
  return r;
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

test("a drop line names its pass — an untagged drop cannot be attributed to the query it came from", () => {
  // Pins the message SHAPE per pass, not the superset relationship the fixture
  // stub cannot produce (its two fixtures are deliberately disjoint — see the
  // file header). #10 is the labeled fixture's sole entry and is a spec, so
  // dropping it empties the labeled query and the fallback runs. #12 is the
  // fallback fixture's non-spec row, there so the fallback result is not
  // itself all specs, and #13 is a second, unrelated spec dropped there —
  // nothing is dropped by both passes here, only that each pass's own drop
  // line is attributable to it.
  const { stderr } = run(
    [ticket(10, "## User Stories\n\n1. As a user…\n")],
    ["--require-label", "ready-for-agent", "--allow-fallback"],
    [
      ticket(12, "## What to build\n\nreal work\n", ["ready-for-human"]),
      ticket(13, "## User Stories\n\n2. As a user…\n", ["ready-for-human"]),
    ],
  );
  assert.match(stderr, /dropped #10 — to-spec spec, not a ticket \(## User Stories\) \[label:ready-for-agent\]/);
  assert.match(stderr, /dropped #13 — to-spec spec, not a ticket \(## User Stories\) \[unfiltered \(fallback\)\]/);
});


test("a drop from the no-label run is tagged [unfiltered] — the one pass tag no other test reaches", () => {
  // Every other run() in this file passes --require-label, so the pass-1
  // ternary always takes its `label:` arm and the `unfiltered` arm is
  // unpinned: rename it to anything and the whole suite stays green. Both
  // documented callers do pass the flag (next-ticket/SKILL.md:15,
  // run-team/SKILL.md:60), so this arm is reachable only by a hand-run — but
  // it is a supported invocation, and its tag is what tells a reader which
  // query dropped what. Two rows, not one: the spec supplies the drop line,
  // the ticket keeps the queue non-empty so this exits 0, not the empty-queue 1.
  const { status, stderr, rows } = run(
    [
      ticket(10, "## User Stories\n\n1. As a user…\n", ["ready-for-human"]),
      ticket(11, "## What to build\n\nx\n", ["ready-for-human"]),
    ],
    [],
  );
  assert.equal(status, 0);
  assert.deepEqual(rows.map((r) => r.n), [11]);
  // The closing `\]` is load-bearing: without it this is also satisfied by the
  // fallback pass's `[unfiltered (fallback)]`, the one tag already pinned above.
  assert.match(stderr, /dropped #10 — to-spec spec, not a ticket \(## User Stories\) \[unfiltered\]/);
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

// `$ gh …` is echoed by query() before every invocation, so its absence is how
// these pin that the refusal came BEFORE any query ran. Status 2 alone does not:
// a query that ran and then died still exits 2, and for --require-label the
// query that runs is the widening one the whole file exists to prevent.
const queriesRun = (stderr) => (stderr.match(/^\$ gh /gm) ?? []).length;

test("a trailing --limit refuses — an absent value is not a licence to use the default", () => {
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent", "--limit"],
  );
  assert.equal(status, 2);
  // Not 0-with-500-rows. `arg()` handed back `undefined`, `?? 500` read that as
  // "flag absent", and the positive-integer guard never saw the malformed input
  // it exists to catch.
  assert.equal(queriesRun(stderr), 0);
});

test("a trailing --require-label refuses — a falsy label runs the query --allow-fallback exists to gate", () => {
  const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], ["--require-label"]);
  // The worst of the three: query() reads a falsy label as "no label", so the
  // UNFILTERED query shipped at exit 0 — the exact widening onto ready-for-human
  // that run-team/SKILL.md:61 withholds --allow-fallback to prevent, reached
  // without the flag. Asserting the status alone would pass on a run that
  // widened and then happened to die.
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
});

test("a --require-label whose value is the next flag refuses — it reaches the same widening", () => {
  // Same harm as the trailing case, one keystroke away: `--allow-fallback` is
  // consumed as the label, `label:--allow-fallback` matches nothing, and the
  // empty result hands straight over to the unfiltered fallback at exit 0.
  const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], ["--require-label", "--allow-fallback"]);
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
});

test("a --require-label whose value is empty refuses — an unset shell variable is not 'no label'", () => {
  // The likeliest spelling of all of them, and the only one the caller cannot
  // see: `--require-label "$LABEL"` with the variable unset leaves an empty
  // argv slot, not a missing one. `""` is falsy, so query() dropped the label
  // term and ran the UNFILTERED search at exit 0 — and stderr said
  // `N candidate(s)` with no label suffix, indistinguishable from a clean run.
  const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], ["--require-label", ""]);
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
});

test("a --require-label=value refuses — indexOf cannot see the = form, so the flag reads as absent", () => {
  // Not the same route as the three above: `indexOf("--require-label")` misses
  // `--require-label=x` entirely, so arg() returned null — "flag absent" — and
  // the unfiltered query ran at exit 0 with the label the caller did pass.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label=ready-for-agent"],
  );
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
});

test("an unknown flag refuses and names it — a flag that is merely ignored runs unfiltered", () => {
  // `--label ready-for-agent` is not an invented typo: it is what run-team's
  // phase 0 rule said, one line under a command spelling it `--require-label`.
  // Ignored, the label term never reaches gh, so the ready-for-human queue
  // ships at exit 0 — the widening `--require-label` exists to prevent, reached
  // by following this repo's own instruction.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--label", "ready-for-agent"],
  );
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
  // The flag has to be NAMED. A bare "bad arguments" leaves the caller — markdown
  // read by a model, with no way to see the script — re-guessing its own spelling.
  // Line-anchored, per die()'s leading newline.
  assert.match(stderr, /^candidates: Unknown option '--label'/m);
});

// The test above is satisfied by a guard that only works when the bad flag is
// FIRST, which is what shipped: the catch tested
// `e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"` and dropped every other
// parseArgs error. That is not a narrower guard but a disabled one. parseArgs
// stops at the FIRST offending argument, so an argument raising any other code
// was swallowed and the unknown flag behind it was never reached — the query
// then ran UNFILTERED at exit 0, which is the whole harm #173 exists to stop.
//
// Rows 1-2 are the two masking arguments on their own; rows 3-4 put a real
// `--label` BEHIND each of them, which is the shape the code test let through
// and the one no other test in this file covers. All four must refuse before
// any query — `status` alone is not enough, since exit 2 is also what a broken
// query produces after gh has already run.
for (const [what, args, refusal] of [
  [
    "a bare positional",
    ["ready-for-agent"],
    /^candidates: Unexpected argument 'ready-for-agent'\./m,
  ],
  [
    "a boolean flag handed a =value",
    ["--allow-fallback=true"],
    /^candidates: Option '--allow-fallback' does not take an argument/m,
  ],
  [
    "an unknown flag behind a positional",
    ["junk", "--label", "ready-for-agent"],
    /^candidates: Unexpected argument 'junk'\./m,
  ],
  [
    "an unknown flag behind a =value boolean",
    ["--allow-fallback=true", "--label", "ready-for-agent"],
    /^candidates: Option '--allow-fallback' does not take an argument/m,
  ],
]) {
  test(`${what} refuses before any query — every parseArgs error is a refusal, not just the unknown-name one`, () => {
    const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], args);
    assert.equal(queriesRun(stderr), 0);
    assert.equal(status, 2);
    // The refusal has to name the OFFENDING argument, not merely the accepted
    // set: parseArgs reports the first offender, and a caller told only "bad
    // arguments" cannot tell which of its four tokens was wrong.
    assert.match(stderr, refusal);
  });
}

// `--allow-fallback=true` is silently IGNORED rather than merely unchecked:
// `has()` compares exactly, so the `=` form never matches and the fallback is
// disabled without a word. The fixtures below are the arrangement that shows
// it — the labeled query comes back empty and the unfiltered one has a row —
// so the flag is the only thing standing between exit 1 and exit 0. Measured
// on the code-testing version, `--allow-fallback=true` here exited 1 ("queue
// empty, query fine") for a run that never applied the flag it was handed,
// while the space-separated spelling exited 0 off the fallback. `notEqual(1)`
// is therefore the load-bearing assertion, not decoration: it is the exact
// code the ignored form produced.
test("--allow-fallback=true never reaches the fallback — a flag has() cannot see must refuse, not be dropped", () => {
  const { status, stderr } = run(
    [],
    ["--require-label", "nonexistent", "--allow-fallback=true"],
    [ticket(12, "## What to build\n\ny\n", ["ready-for-human"])],
  );
  assert.equal(queriesRun(stderr), 0);
  assert.notEqual(status, 1);
  assert.equal(status, 2);
});

// The control for the test above. Without it, "refuses the = form" is equally
// satisfied by a guard that refuses `--allow-fallback` in every spelling, which
// would break the one caller that legitimately passes it
// (next-ticket/SKILL.md:15). Same fixtures, space-separated: the fallback has
// to run and ship the unfiltered row at exit 0.
test("--allow-fallback still falls back in its space-separated spelling — the = refusal is not a blanket one", () => {
  const { status, stderr, rows } = run(
    [],
    ["--require-label", "nonexistent", "--allow-fallback"],
    [ticket(12, "## What to build\n\ny\n", ["ready-for-human"])],
  );
  assert.equal(queriesRun(stderr), 2);
  assert.equal(status, 0);
  assert.deepEqual(rows.map((r) => r.n), [12]);
});

// The parseArgs call sits BELOW the value guards so their wording wins wherever
// both would refuse, and ORDER is the only thing that decides that. Node's
// message for this same argv is "Option '--require-label <value>' argument
// missing", which names the syntax; #169's names the flag the way every other
// refusal in this file does. Anchored at both ends so the suffix parseArgs'
// branch appends cannot satisfy it.
test("--require-label with no value keeps #169's wording — the name check runs after the value guards", () => {
  const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], ["--require-label"]);
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: --require-label needs a value$/m);
});

test("gh output that is not an array refuses — a reduction that did not apply is not an empty queue", () => {
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: '{message:"Not Found"}' },
  );
  // 2, not 1. Unchecked, the object flows on and the first use of it throws —
  // and an uncaught throw exits 1, the code reserved for "successful query, no
  // survivors". A caller reading only the status hears "there is no work".
  assert.equal(status, 2);
  // Anchored on the die() prefix: `--jq` also appears in the echoed `$ gh` line,
  // so an unanchored /--jq/ passes on a run that never refused at all.
  assert.match(stderr, /^candidates: .*--jq/m);
});

test("gh output that is empty refuses — the reduction emits an array for every input, including none", () => {
  // The one shape the checks below cannot see, because it never reaches the
  // parse. `[…]`-wrapped, the expression emits `[]` for an empty list, so no
  // output at all means it did not run — the same fact as a wrong shape, and
  // NOT an empty queue. Returning `[]` here spent that on exit 1, "no work".
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: "empty" },
  );
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: .*--jq/m);
});

test("gh rows that were never reduced refuse — raw issues are not {n,t,l,d,spec}", () => {
  // What a gh that ignored `--jq` actually returns: the unreduced `--json`
  // payload. An array, so an array check alone passes it through.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: "." },
  );
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: .*--jq/m);
  // The refusal names the row by index and never prints it. This is the one
  // payload-shaped stderr path in the file, and an unreduced row carries the
  // full issue body — the ~97% this script exists to not fetch. Without this,
  // a die() that interpolated the row instead of its index kept the whole
  // suite green while emitting every body it refused to pull.
  assert.doesNotMatch(stderr, /What to build/);
});

test("a failed gh query refuses without re-emitting gh's own stderr", () => {
  // A program jq cannot compile: it exits non-zero, so execFileSync throws and
  // the fail-closed die() runs. jq echoes the offending program in its own
  // error, which is the marker below.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: "MARKER_ZZZ(((" },
  );
  // 2, not 1: a broken query is not an empty queue — the archetypal fail-closed
  // path, and the one die() in query() that had no test at all.
  assert.equal(status, 2);
  // Both halves of the contract, and neither is a count over the whole stream.
  // Counting occurrences looks like the tighter pin but is coupled to jq's
  // choice of error path: `(((` is unbalanced, so jq takes the SYNTAX-error
  // branch, which echoes the program once. Balanced `MARKER_ZZZ` takes the
  // undefined-function branch, which names the symbol AND echoes the program —
  // two occurrences from the child alone, failing an exactly-1 assertion
  // against correct code.
  //
  // So: the child's copy must arrive (execFileSync forwards it), and the
  // refusal line must not carry it a second time (#176 — measured 7,700 B of
  // gh stderr becoming 15,454 B, into a caller that is markdown read by a
  // model). The same duplication this file's row-shape refusal already avoids.
  assert.match(stderr, /MARKER_ZZZ/);
  const refusal = stderr.match(/^candidates: .*$/m)[0];
  assert.match(refusal, /^candidates: gh issue list failed/);
  assert.doesNotMatch(refusal, /MARKER_ZZZ/);
});

test("the refusal survives a gh stderr larger than the pipe buffer — the case that motivated it", () => {
  // The failure mode the fix targets, at the size it actually happens. gh's
  // forwarded stderr is written first and die()'s line last, so with an async
  // console.error the refusal is the FIRST thing process.exit() discards: the
  // caller gets 64 KiB of gh noise, exit 2, and no statement of what broke.
  // Under the buffer every variant passes, so the program must stay large.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: `${"z".repeat(100_000)}(((` },
  );
  assert.equal(status, 2);
  assert.ok(stderr.length > 60_000, `gh stderr must exceed the buffer, got ${stderr.length}`);
  assert.match(stderr, /^candidates: gh issue list failed/m);
});

test("gh missing entirely is named as ENOENT — the shape that prints nothing at all", () => {
  // The other side of `e.code ?? …`. Deleting the whole `e.code` half leaves
  // the suite green without this: the jq test above only ever reaches the
  // exit-status branch. ENOENT is the shape where die() is the SOLE diagnostic
  // — nothing spawned, so no child stderr was forwarded to fall back on.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { PATH: "/nonexistent" },
  );
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: gh issue list failed: ENOENT$/m);
});

test("a signal-killed gh is named by its signal, not reported as `exit null`", () => {
  // Third disjoint shape: `e.code` undefined AND `e.status` null, so a
  // two-branch expression prints `exit null` and names nothing. Live for gh —
  // the OOM killer on a large query, a SIGPIPE, a propagated Ctrl-C — and the
  // child prints nothing on its way out, so this line is all the caller gets.
  const { status, stderr } = runWithGh(`#!/bin/sh\nkill -TERM $$\n`);
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: gh issue list failed: killed by SIGTERM$/m);
  assert.doesNotMatch(stderr, /exit null/);
});

test("a payload past the pipe buffer arrives whole — truncated JSON must never read as exit 0", () => {
  // process.exit() discards queued writes, and stdout on a pipe (which is what
  // spawnSync gives us, and what every real caller gives it) is async. 499 rows
  // — one UNDER the default --limit, so refuseIfCapped never fires — measured
  // 65,536 B and mid-JSON at exit 0: a corrupt payload typed as success, the
  // one outcome this file's exit codes exist to make impossible.
  //
  // The pin is `rows`, which run() JSON.parses: truncation throws there. The
  // byte assertion is what makes it meaningful — under the buffer this test
  // passes against process.exit() too, so it must stay comfortably over.
  const issues = Array.from({ length: 499 }, (_, i) => ({
    number: i + 1,
    title: "t".repeat(120),
    labels: [{ name: "ready-for-agent" }, { name: "size:m" }],
    body: "## What to build\n\ndepends on #7\n",
  }));
  const { status, stdout, rows } = run(issues);
  assert.ok(stdout.length > 70_000, `payload must exceed the 64 KiB buffer, got ${stdout.length}`);
  assert.equal(rows.length, 499);
  assert.equal(status, 0);
});

test("an empty queue is exit 1, not 2 — the query worked and there is no work", () => {
  // The other half of the contract in this file's header. Every refusal above
  // pins 2; nothing pinned 1, so a change spending 2 on an empty queue — the
  // swap the header forbids — shipped green. Verified by mutation: flipping
  // `rows.length === 0 ? 1 : 0` to `? 2 : 0` fails this test and only this one.
  const { status, stdout } = run([], ["--require-label", "ready-for-agent"]);
  assert.equal(status, 1);
  assert.equal(stdout.trim(), "[]");
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

// The other half of #173, and the half that produced the refused invocation
// above: the rule a controller reads lives in another file and was pinned by
// nothing, so it named a flag the script has never accepted.
const RUN_TEAM = readFileSync(join(import.meta.dirname, "..", "skills", "run-team", "SKILL.md"), "utf8");

test("run-team's phase 0 rule names the flag candidates.mjs accepts", () => {
  // The step-1 bullet alone. A slice any wider is vacuous for this claim: the
  // command one line above the rule already spells `--require-label` correctly,
  // so a positive match anywhere in phase 0 stays green with the rule naming
  // anything at all.
  const at = RUN_TEAM.indexOf("1. **Candidate scan**");
  assert.notEqual(at, -1, "run-team phase 0 step 1 moved — update this test");
  const end = RUN_TEAM.indexOf("\n2. ", at);
  assert.notEqual(end, -1, "run-team phase 0 step 2 moved — update this test");
  const step1 = RUN_TEAM.slice(at, end);
  // Leading backtick, so this can only be satisfied by the RULE: in the command
  // above it, `--require-label` is preceded by a line break, not a backtick.
  // The gap is loose enough that rewording around `mandatory` stays green and
  // tight enough that a different flag in the rule does not.
  assert.match(
    step1,
    /`--require-label ready-for-agent`[\s\S]{0,20}mandatory/,
    "run-team's mandatory-label rule no longer names --require-label",
  );
  // The positive pin cannot see a SECOND sentence naming the wrong flag, which
  // is exactly what shipped. `--require-label` does not contain `--label`, so
  // this needs no quoting to tell them apart.
  assert.doesNotMatch(
    step1,
    /--label\b/,
    "run-team's phase 0 step 1 names `--label`, which candidates.mjs refuses",
  );
});
