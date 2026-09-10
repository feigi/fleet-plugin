// Smoke test for the HTTP layer, plus the transcript-reading layer underneath
// the spend panel — no gh, no build loop. Boots the static server against a temp
// dir and asserts it serves board.json and the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createBoardServer, mapCi, encodeProjectDir, findSubagentsDir, gatherSpend } from "./board.mjs";

const SCRIPT = fileURLToPath(new URL("./board.mjs", import.meta.url));

// mapCi regression gate — pins the ci-state verdict mapping, incl. the two paths
// an "empty repo" live test cannot reach: a completed not-green run → red, and a
// no-run-yet / still-running state → unknown (never a false red).
test("mapCi: completed green → green", () => {
  assert.equal(mapCi(JSON.stringify({ status: "completed", verdict: "green" })), "green");
});
test("mapCi: completed not-green → red", () => {
  assert.equal(mapCi(JSON.stringify({ status: "completed", verdict: "not-green" })), "red");
});
test("mapCi: still-running → unknown (never a false red)", () => {
  assert.equal(mapCi(JSON.stringify({ status: "in_progress", verdict: "not-green" })), "unknown");
});
test("mapCi: no run yet (status null) → unknown, not red", () => {
  assert.equal(mapCi(JSON.stringify({ status: null, verdict: "not-green" })), "unknown");
});
// ci-state.mjs (#111) added verdict: "no-ci" for a repo with no workflow
// configured. mapCi has no branch for that string, so what protects the board
// is the trailing `return "unknown"` — and only a payload that gets PAST the
// status gate can reach it. A real no-ci payload carries status null, which the
// gate swallows before it; written that way this test took the same
// branch as its sibling above and stayed green while `verdict === "no-ci"` was
// mutated to return "green". `status: "completed"` is the whole pin: it is the
// shape that reaches the last line, so a silent no-ci→green mapping fails here
// and nowhere else.
test("mapCi: no-ci verdict past the status gate → unknown, not silently mapped", () => {
  assert.equal(mapCi(JSON.stringify({ status: "completed", verdict: "no-ci" })), "unknown");
});
// A non-empty payload that will not parse is a THIRD state, and the return
// value cannot carry it: "unknown" is pinned above and stays pinned — a false
// red is worse than no verdict — so the distinction leaves through stderr or
// not at all. runCiState() hands this payload straight here by design: at any
// exit but 2, non-empty stdout is a real verdict, so a truncated pipe write or
// a warning line printed ahead of the JSON reaches mapCi looking exactly like a
// PR whose first run has not started, and that PR's red-ci flag — the top of
// the attention strip — stays down with nothing said.
test("mapCi: an unparseable payload → unknown, and says so on stderr, naming the PR", () => {
  let v;
  const errs = withStderr(() => { v = mapCi("not json", 6051); });
  assert.equal(v, "unknown");
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /6051/, "the line has to name the PR whose flag is suppressed");
});

// An ABSENT payload is not a garbage one, and the difference is why the warn
// sits after this guard rather than before it: every path that reaches mapCi
// with null went through runCiState()'s own stderr line first, so warning here
// would report the same failed read twice.
test("mapCi: an absent payload (null) → unknown, silently — runCiState already reported it", () => {
  let v;
  const errs = withStderr(() => { v = mapCi(null, 6052); });
  assert.equal(v, "unknown");
  assert.deepEqual(errs, []);
});

// The other half of that split, and the whole reason the guard above tests null
// rather than falsiness. An EMPTY payload is a failed read that nobody reported:
// runCiState() returns stdout unconditionally at exit 0, emptiness untested, so
// a lost stdout write on a green verdict comes back as "" and reaches here
// having said nothing. A `!ciJson` guard cannot tell that from the null above
// and answers "unknown" in silence — the same disappearance #605 exists to end,
// one arm over from the arm it fixed. This test is the only thing separating the
// two guards: the pair above and below it both pass under either guard.
test("mapCi: an empty payload → unknown, and says so — a lost write is not an absent one", () => {
  let v;
  const errs = withStderr(() => { v = mapCi("", 6056); });
  assert.equal(v, "unknown");
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /6056/, "the line has to name the PR whose flag is suppressed");
});

// The false-positive half, and the reason it is a test rather than an argument.
// "no run yet", "still running" and "no-ci" are the states this mapping is
// DESIGNED to answer unknown for — they are readings, not read failures. A warn
// that cannot tell them from a garbage payload prints a line for every PR
// awaiting its first run, on every ~15s tick, and the useful line drowns in it.
test("mapCi: a legitimately unknown state — status null, in_progress, no-ci — stays silent", () => {
  const errs = withStderr(() => {
    mapCi(JSON.stringify({ status: null, verdict: "not-green" }), 6053);
    mapCi(JSON.stringify({ status: "in_progress", verdict: "not-green" }), 6053);
    mapCi(JSON.stringify({ status: "completed", verdict: "no-ci" }), 6053);
  });
  assert.deepEqual(errs, []);
});

// #1170: JSON.parse("null") succeeds and yields d === null, and null alone
// among parsed payloads has no properties to read — every other one boxes and
// reads its status as undefined — so the status gate threw a TypeError back
// out of mapCi. mapCi runs inside gather()'s per-PR loop, so a bare "null" for
// one PR would take out that tick's whole board.json rewrite: under `serve`
// the throw is uncaught until the whole-tick catch, which logs and leaves the
// previous board.json standing, while the one-shot build path exits through
// main().catch and dies loudly. Written as a conditional because this repo's
// ci-state.mjs puts nothing on stdout but JSON.stringify of an object literal,
// so it cannot emit a bare "null" — the guard is defence in depth against a
// producer that can. Silence is the pin the comment claims and the assertion
// nobody wrote: every parseable payload with no status to read answers without
// a line, and the guard has to join that class rather than start warning.
test("mapCi: a JSON payload that parses to null → unknown, not a thrown TypeError", () => {
  let v;
  const errs = withStderr(() => { v = mapCi("null", 1170); });
  assert.equal(v, "unknown");
  assert.deepEqual(errs, [], "silent, like every other payload with no status to read");
});
// The other half: a payload that already answered "unknown" still does, so the
// guard narrowed nothing. It does not discriminate an over-guard — one
// rejecting every non-plain-object answers exactly as this guard does for every
// JSON value, since reaching a verdict at all takes a plain object such a guard
// passes through, so no fixture separates the two.
test("mapCi: parsed payloads with no status still classify unknown, not thrown", () => {
  let v, w;
  const errs = withStderr(() => { v = mapCi("true", 1170); w = mapCi("[]", 1170); });
  assert.equal(v, "unknown");
  assert.equal(w, "unknown");
  assert.deepEqual(errs, [], "silent, like every other payload with no status to read");
});

// `serve` rebuilds every ~15s and calls mapCi once per PR per tick, so a broken
// payload is broken on every tick and the gate is the whole difference between
// one line and a flood. Keyed per PR rather than globally, because a global
// gate would let the first broken PR mask every later one for the rest of the
// run — silence that looks identical to the bug being fixed here.
test("an unparseable payload warns ONCE per PR across ticks, and a second PR is not masked", () => {
  assert.equal(withStderr(() => mapCi("not json", 6054)).length, 1, "tick 1 reports");
  assert.deepEqual(withStderr(() => mapCi("not json", 6054)), [], "tick 2 stays quiet");
  assert.equal(withStderr(() => mapCi("{ trunc", 6055)).length, 1, "another PR still gets its line");
});

// #262 put a payload on stdout at exit 2 for a quota refusal, and runCiState()
// was reading "stdout is non-empty" as "a verdict was read". mapCi alone cannot
// see that: it is handed a string and never learns which exit code produced it,
// so every pin above stayed green while a rate-limited outage overwrote a PR's
// last-known-good CI with "unknown" — the carry-forward gather() documents as
// "On failure, carry the previous board's value for that PR". The seam is
// gather(), so the gate has to sit there.
//
// scriptDir is injected, so both arms drive the REAL runCiState()/gather()
// against a ci-state whose exit code and stdout are exactly what the arm needs;
// the stub `gh` only has to feed the PR loop, since every other gh read in
// gather() degrades through tryRun(). Out of process, because gather() reads
// process.argv and would otherwise read the test runner's.
function gatherCi({ ciStateBody, prevCi }) {
  const cwd = mkdtempSync(join(tmpdir(), "board-gather-"));
  const bin = mkdtempSync(join(tmpdir(), "board-gather-bin-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "board-gather-scripts-"));
  writeFileSync(join(scriptDir, "ci-state.mjs"), ciStateBody);
  writeFileSync(join(bin, "gh"),
    '#!/bin/sh\ncase "$1 $2" in\n"pr list") echo \'[{"number":42,"state":"OPEN","labels":[],"title":"t"}]\' ;;\n*) exit 1 ;;\nesac\n');
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(cwd, "prev.json"), JSON.stringify({ tickets: [{ pr: 42, ci: prevCi }] }));
  const driver = `const { gather } = await import(${JSON.stringify(SCRIPT)});
    const r = gather({ ledgerFile: ${JSON.stringify(join(cwd, "nope.md"))},
                       prevFile: ${JSON.stringify(join(cwd, "prev.json"))},
                       scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    console.log(JSON.stringify(r.ci));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // stderr comes back too: gather() reports through it, and the PR number in a
  // mapCi warn is an argument the call site has to pass — see the unparseable
  // payload test below, which is the only one that can observe that wiring.
  return { ci: JSON.parse(r.stdout.trim().split("\n").pop())[42], stderr: r.stderr };
}

// The regression itself. This payload is what ci-state.mjs emits on a quota
// refusal: it carries no `status`, so if it ever reaches mapCi the answer is
// "unknown" and the previous red is gone.
const RATE_LIMITED_EXIT_2 = `import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ pr: 42, verdict: "rate-limited", reasons: ["quota"] }) + "\\n");
process.exit(2);`;

test("gather: a rate-limited ci-state — exit 2 WITH a payload — carries the previous board's CI value", () => {
  assert.equal(gatherCi({ ciStateBody: RATE_LIMITED_EXIT_2, prevCi: "red" }).ci, "red");
});

// The other direction, and the reason this pair is not one test: a runCiState()
// that returned null for every non-zero exit would satisfy the arm above and
// make the board blind to red CI, which is the failure the carry-forward exists
// to prevent. Exit 1 is a real verdict and must still beat the previous value —
// prev is "green" here precisely so a passing "red" can only have come from
// mapCi reading this payload, never from the carry-forward.
const NOT_GREEN_EXIT_1 = `import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ pr: 42, status: "completed", verdict: "not-green", reasons: ["x"] }) + "\\n");
process.exit(1);`;

test("gather: exit 1 is a verdict, not a failed read — it still overrides the previous value", () => {
  assert.equal(gatherCi({ ciStateBody: NOT_GREEN_EXIT_1, prevCi: "green" }).ci, "red");
});

// The end-to-end shape of #605, and the one test that can see the call site.
// mapCi's warn keys on a PR number mapCi has no other use for, so the argument
// exists only if gather() passes it: leave the call as `mapCi(out)` and every
// in-process test above stays green while the real board prints a line naming
// PR "undefined". Only driving gather() itself pins the wiring.
//
// A warning line ahead of a truncated body — stdout that is non-empty, is a
// real exit-1 verdict by runCiState()'s rule, and still will not parse.
const UNPARSEABLE_EXIT_1 = `import { writeSync } from "node:fs";
writeSync(1, "warning: gh took the slow path\\n{\\"pr\\": 42, \\"status\\": \\"comp");
process.exit(1);`;

// prev is "red" to state plainly what the fix does NOT change: the payload is
// non-null, so gather()'s carry-forward arm is not reached and the PR still
// reverts to "unknown" for this tick. #605's remedy is additive — the return
// value is pinned, only the silence is the defect.
test("gather: an unparseable verdict payload → unknown, with a stderr line naming the PR", () => {
  const r = gatherCi({ ciStateBody: UNPARSEABLE_EXIT_1, prevCi: "red" });
  assert.equal(r.ci, "unknown");
  assert.match(r.stderr, /PR 42/);
});

// #786: `gh issue list`/`gh pr list` rows had no per-row shape guard. A row
// missing `number` is the real "reaches the page as literal `undefined`" case
// — compute-board.mjs joins rows to the ledger BY number, so a numberless row
// collided with every other one on the shared `undefined` key. A row missing
// `title` was never that: compute-board.mjs's titleFor() already falls
// through a falsy PR title to the real issue title, and an issue row with no
// title already fell through to the `#<number>` placeholder — both worked
// before this fix. `labels`, unguarded either way, was the real regression:
// a non-array or null-containing `labels` array crashes gather() outright,
// worse than any `undefined` on the page.
//
// Stubs both `gh` reads directly rather than reusing gatherCi's fixed PR row,
// and stubs ci-state.mjs to answer "unknown" unconditionally — the PR loop
// only needs to complete without throwing, its verdict is not what these
// tests pin. Out of process for the same reason as gatherCi: gather() reads
// process.argv and would otherwise read the test runner's.
function gatherRows({ issuesJson, prsJson }) {
  const cwd = mkdtempSync(join(tmpdir(), "board-gather-rows-"));
  const bin = mkdtempSync(join(tmpdir(), "board-gather-rows-bin-"));
  const scriptDir = mkdtempSync(join(tmpdir(), "board-gather-rows-scripts-"));
  writeFileSync(join(scriptDir, "ci-state.mjs"), "process.stdout.write('{}');\n");
  writeFileSync(join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n"issue list") echo '${issuesJson}' ;;\n"pr list") echo '${prsJson}' ;;\n*) exit 1 ;;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const driver = `const { gather } = await import(${JSON.stringify(SCRIPT)});
    const r = gather({ ledgerFile: ${JSON.stringify(join(cwd, "nope.md"))},
                       prevFile: null, scriptDir: ${JSON.stringify(scriptDir)}, interval: 15 });
    console.log(JSON.stringify({ issues: r.issues, prs: r.prs }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { ...JSON.parse(r.stdout.trim().split("\n").pop()), stderr: r.stderr };
}

// tryParse only checks that gh's stdout is valid JSON, not that it is an
// array — a syntactically-valid object payload used to reach withNumber's
// `for...of` and throw "rows is not iterable", contrary to this PR's own
// premise that tryParse "establishes... that it is an array" (#786 review).
test("gather: a non-array gh payload degrades to an empty list, not a crash", () => {
  const r = gatherRows({ issuesJson: JSON.stringify({ not: "an array" }), prsJson: "[]" });
  assert.deepEqual(r.issues, []);
  assert.match(r.stderr, /gh issue list: expected an array of rows/);
});

test("gather: a well-formed issue/PR row passes through unchanged", () => {
  const r = gatherRows({
    issuesJson: JSON.stringify([{ number: 9, title: "real title", labels: [] }]),
    prsJson: JSON.stringify([{ number: 10, state: "OPEN", title: "real pr title", labels: [] }]),
  });
  assert.deepEqual(r.issues, [{ number: 9, title: "real title", labels: [] }]);
  assert.deepEqual(r.prs, [{ number: 10, state: "OPEN", title: "real pr title", labels: [] }]);
});

test("gather: an issue row with no number is dropped, loudly, not placed as undefined", () => {
  const r = gatherRows({ issuesJson: JSON.stringify([{ title: "orphan" }]), prsJson: "[]" });
  assert.deepEqual(r.issues, []);
  assert.match(r.stderr, /gh issue list: dropping row with no usable number/);
});

test("gather: an issue row missing its title reads as its number, not undefined", () => {
  const r = gatherRows({ issuesJson: JSON.stringify([{ number: 55 }]), prsJson: "[]" });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].number, 55);
  assert.equal(r.issues[0].title, "#55");
});

test("gather: a PR row with no number is dropped, loudly, not placed as undefined", () => {
  const r = gatherRows({ issuesJson: "[]", prsJson: JSON.stringify([{ title: "orphan pr", state: "OPEN" }]) });
  assert.deepEqual(r.prs, []);
  assert.match(r.stderr, /gh pr list: dropping row with no usable number/);
});

// `state` and `title` used to default to a sentinel ("UNKNOWN" / `#<number>`)
// on a PR row. Both defaults are gone: `state`'s only consumer is
// `pr.state === "OPEN"` (compute-board.mjs), already false for `undefined`
// exactly as it was for "UNKNOWN" — an inert guard. `title`'s default made a
// titleless PR row unconditionally truthy, which SILENTLY DISABLED titleFor()'s
// existing fallback to the real issue title (see compute-board.test.mjs for
// the column-placement pin this can't reach — `open`, the boolean `state`
// feeds, is itself never read past that comparison). Raw passthrough, pinned
// here as gather()'s actual output shape.
test("gather: a PR row missing state/title passes through raw, not coerced to a sentinel", () => {
  const r = gatherRows({ issuesJson: "[]", prsJson: JSON.stringify([{ number: 77 }]) });
  assert.equal(r.prs.length, 1);
  // Round-tripped through JSON (gatherRows' driver), so an undefined value
  // survives as an absent key, not a key holding `undefined` — same as what
  // JSON.stringify(model) already does to board.json on every real tick.
  assert.deepEqual(r.prs[0], { number: 77, labels: [] });
});

// The #786 regression review reproduced this live: `labels` was the one field
// this PR's own guard comment claimed was covered ("a row without a usable
// field... doesn't fail the tick") but was never actually guarded — a
// non-array `labels` throws `TypeError: ... .map is not a function`, crashing
// gather() entirely rather than degrading the row.
test("gather: a non-array labels field degrades to [], not a TypeError crash", () => {
  const r = gatherRows({
    issuesJson: JSON.stringify([{ number: 1, title: "t", labels: "not-an-array" }]),
    prsJson: JSON.stringify([{ number: 2, title: "t", state: "OPEN", labels: "not-an-array" }]),
  });
  assert.deepEqual(r.issues[0].labels, []);
  assert.deepEqual(r.prs[0].labels, []);
});

// The second reproduced crash: a `labels` array whose elements are the right
// TYPE (an array) but a WRONG-shaped or null element throws reading `.name`.
test("gather: a malformed element inside labels is dropped, not the whole row", () => {
  const r = gatherRows({
    issuesJson: JSON.stringify([{ number: 1, title: "t", labels: [{ name: "keep" }, null, {}] }]),
    prsJson: "[]",
  });
  assert.deepEqual(r.issues[0].labels, ["keep"]);
});

test("createBoardServer serves board.json and the page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-"));
  writeFileSync(join(dir, "board.json"), JSON.stringify({ generatedAt: 1, tickets: [], attention: [] }));
  writeFileSync(join(dir, "board.html"), "<!doctype html><title>cockpit</title>");
  const server = createBoardServer(dir);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  const j = await fetch(`http://localhost:${port}/board.json`);
  assert.equal(j.status, 200);
  assert.equal((await j.json()).generatedAt, 1);

  const h = await fetch(`http://localhost:${port}/`);
  assert.equal(h.status, 200);
  assert.match(await h.text(), /cockpit/);

  const nf = await fetch(`http://localhost:${port}/nope`);
  assert.equal(nf.status, 404);

  await new Promise((res) => server.close(res));
});

// ── the spend transcript layer ────────────────────────────────────────────────
// Both bugs this file now pins were invisible to the pure-module tests, because
// both live in the I/O that feeds them: a wrong path and a wrong summation. Each
// failed silently as "panel hidden" or "plausible but 3x too big".

test("encodeProjectDir replaces dots as well as slashes", () => {
  // Regression: replacing only `/` produced `-Users-x-.claude`, which never
  // exists, so the panel silently vanished for every dotted cwd — including the
  // repo the fleet skills themselves run out of.
  assert.equal(encodeProjectDir("/Users/x/.claude"), "-Users-x--claude");
  assert.equal(encodeProjectDir("/Users/x/dev/repo"), "-Users-x-dev-repo");
  assert.equal(encodeProjectDir("/Users/x/dev/repo/.claude/worktrees/a"), "-Users-x-dev-repo--claude-worktrees-a");
});

test("findSubagentsDir resolves a dotted cwd and picks the newest session", () => {
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const proj = join(home, ".claude", "projects", "-Users-x--claude");
  const older = join(proj, "11111111-aaaa", "subagents");
  const newer = join(proj, "22222222-bbbb", "subagents");
  mkdirSync(older, { recursive: true });
  mkdirSync(newer, { recursive: true });
  // Ranking reads the newest *.jsonl mtime, so stamp the TRANSCRIPTS, not the
  // dirs. Stamp both explicitly rather than sleeping for a clock tick: both are
  // created inside the same millisecond on a fast filesystem, `mtimeMs` ties,
  // and the sort is stable — a tie would resolve to readdir order and
  // `11111111-aaaa` would win on name.
  writeFileSync(join(older, "agent-a.jsonl"), "");
  utimesSync(join(older, "agent-a.jsonl"), new Date(1000), new Date(1000));
  writeFileSync(join(newer, "agent-b.jsonl"), "");
  utimesSync(join(newer, "agent-b.jsonl"), new Date(9000), new Date(9000));

  assert.equal(findSubagentsDir(home, "/Users/x/.claude"), newer);
  // Unresolvable path is a bug, not an empty run — it must be distinguishable.
  assert.ok(findSubagentsDir(home, "/Users/x/nonexistent").error);
});

test("session ranking uses transcript mtime, not directory mtime", () => {
  // Regression: a directory's mtime moves when an entry is CREATED, never when a
  // file inside it is appended to. Ranking on it tracked the last agent spawn,
  // so a session that spawned all its agents early lost to a newer, idle one —
  // and since the cockpit starts before the first agent spawns, that was the
  // common case at run start. The board would show a PREVIOUS run's spend.
  //
  // The two rankings only disagree when the newest DIRECTORY is not the one
  // holding the newest TRANSCRIPT, so the fixture has to build exactly that and
  // nothing weaker. Creating the busy dir's transcript LAST — the shape this
  // test had before — bumps that dir's own mtime as a side effect, so both
  // rankings then pick `busy` for different reasons and the test stayed green
  // with the fix fully reverted. Stamp all four times explicitly, files before
  // dirs: creating a file is the one operation that moves its parent's mtime,
  // and rewriting an existing file's mtime does not.
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const proj = join(home, ".claude", "projects", "-x");
  const busy = join(proj, "aaaa", "subagents");   // spawned its agents early, still appending
  const idle = join(proj, "bbbb", "subagents");   // spawned one last agent, then went quiet
  mkdirSync(busy, { recursive: true });
  mkdirSync(idle, { recursive: true });
  writeFileSync(join(busy, "agent-b.jsonl"), "");
  writeFileSync(join(idle, "agent-i.jsonl"), "");
  utimesSync(join(busy, "agent-b.jsonl"), new Date(9000), new Date(9000)); // newest TRANSCRIPT
  utimesSync(join(idle, "agent-i.jsonl"), new Date(1000), new Date(1000));
  utimesSync(busy, new Date(1000), new Date(1000));
  utimesSync(idle, new Date(9000), new Date(9000));                        // newest DIRECTORY

  assert.equal(findSubagentsDir(home, "/x"), busy);
});

test("one unreadable session directory loses the ranking instead of sinking the lookup", () => {
  // Regression: newestTranscriptMs' readdirSync sat outside its per-file try and
  // inside findSubagentsDir's, so one bad sibling turned the WHOLE lookup into
  // { error } and the board rendered "spend unavailable" over a perfectly
  // readable live session — a blackout where the per-file catch beside it
  // already chose degradation. A candidate we cannot read must score 0 and lose.
  //
  // `subagents` as a regular FILE rather than a chmod 000 dir: ENOTDIR is the
  // same uncaught throw and, unlike a permission bit, it still throws when the
  // suite runs as root.
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const proj = join(home, ".claude", "projects", "-x");
  const good = join(proj, "aaaa", "subagents");
  mkdirSync(good, { recursive: true });
  mkdirSync(join(proj, "bbbb"), { recursive: true });
  writeFileSync(join(proj, "bbbb", "subagents"), "not a directory");
  writeFileSync(join(good, "agent-a.jsonl"), "");

  assert.equal(findSubagentsDir(home, "/x"), good);
});

test("one unreadable transcript does not take the whole panel down", () => {
  const dir = fixture(TURN);
  mkdirSync(join(dir, "agent-trap.jsonl")); // a directory where a file is expected
  const s = gatherSpend({ dir });
  assert.equal(s.totals.cacheWrite, 1000); // the good agent still counted
  assert.equal(s.skipped, 1);
});

// One assistant turn, written the way Claude Code actually writes it: three
// lines, same message.id, the SAME usage object repeated on each. Only
// output_tokens varies — it is a streaming snapshot, so the last is the total.
const TURN = [
  { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50, output_tokens: 1 }, content: [{ type: "thinking" }] } },
  { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50, output_tokens: 1 }, content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
  { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50, output_tokens: 300 }, content: [{ type: "tool_use", id: "t2", name: "Read" }] } },
];

function fixture(lines, meta) {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  writeFileSync(join(dir, "agent-x.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (meta) writeFileSync(join(dir, "agent-x.meta.json"), JSON.stringify(meta));
  return dir;
}

test("a turn spanning several jsonl lines is billed ONCE, not once per line", () => {
  // Regression: summing usage per line inflated cache_creation by +206% over
  // 2452 real transcripts. The tell was the panel disagreeing with itself —
  // by-role total 4.2x the by-tool total, both claiming to be the same number.
  const s = gatherSpend({ dir: fixture(TURN, { description: "Review PR 1" }) });
  assert.equal(s.totals.cacheWrite, 1000); // not 3000
  assert.equal(s.totals.cacheRead, 50); // not 150
  assert.equal(s.totals.output, 300); // max, not 1+1+300
  assert.equal(s.totals.maxCtx, 1052); // input + read + write, counted once
  assert.equal(s.totals.agents, 1);
});

test("tool calls split across a turn's lines are all counted", () => {
  const s = gatherSpend({ dir: fixture(TURN) });
  const by = Object.fromEntries(s.tools.map((t) => [t.tool, t.calls]));
  assert.equal(by.Bash, 1);
  assert.equal(by.Read, 1);
});

test("by-tool attribution never exceeds the cache_creation it is a share of", () => {
  // The invariant the double-count broke: both panels are views of one number.
  const s = gatherSpend({
    dir: fixture([
      ...TURN,
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(300) }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "x".repeat(100) }] } },
      { type: "assistant", message: { id: "msg_2", usage: { cache_creation_input_tokens: 400, output_tokens: 5 }, content: [{ type: "text" }] } },
    ]),
  });
  const toolTotal = s.tools.reduce((n, t) => n + t.cacheWrite, 0);
  assert.ok(toolTotal <= s.totals.cacheWrite, `${toolTotal} > ${s.totals.cacheWrite}`);
  // The two consecutive result turns both get attributed, 300:100 of the 400.
  const by = Object.fromEntries(s.tools.map((t) => [t.tool, t.cacheWrite]));
  assert.equal(by.Bash, 300);
  assert.equal(by.Read, 100);
});

test("a prose turn whose content is a STRING does not throw", () => {
  // The trap that once turned into a silently absent panel via the outer catch.
  const s = gatherSpend({
    dir: fixture([
      { type: "user", message: { content: "plain prose, not an array" } },
      ...TURN,
    ]),
  });
  assert.equal(s.totals.cacheWrite, 1000);
});

// gatherSpend reports through stderr, so read console.error rather than spawning
// the CLI — the transcript tree the CLI resolves lives under $HOME, and these
// fixtures do not.
function withStderr(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.error = real; }
  return lines;
}

test("a meta.json that exists but cannot be read is reported, not swallowed", () => {
  // #325: the catch here was labelled `/* unnamed agent */`, but existsSync
  // already covers that case, so the only thing reaching it is a real fault —
  // here a read torn mid-write. Measured before the fix: role "other", 0 bytes
  // on stderr, and with a reviewer's meta torn this way reviewPct went 80 -> 0.
  const dir = fixture(TURN);
  writeFileSync(join(dir, "agent-x.meta.json"), '{"spawnDepth":0,"descrip');
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /agent-x\.meta\.json/);
  // #686: the {} fallback drops the panel label to the filename stem too, not
  // just the role — the warning must name both consequences, or the operator
  // reading stderr learns the role changed and is never told the row was renamed.
  assert.match(errs[0], /labelling it from its filename/);
  // Still BOOKED, not skipped. The transcript itself is readable, so letting the
  // fault throw would hand it to the per-file catch above and drop this agent's
  // real tokens from the totals — a wrong total in place of a wrong role.
  assert.equal(s.totals.cacheWrite, 1000);
  assert.equal(s.skipped, 0);
  // #602: booked does not mean undetectable. The role/label are still wrong —
  // "other" and the bare filename — and metaErrors is the one field on this
  // return that says so, distinct from a genuinely zero reviewPct.
  assert.equal(s.metaErrors, 1);
  // #686: pin the label fallback itself, not just the warning that announces it.
  assert.equal(s.top[0].label, "x");
});

test("#686: an intact sidecar's description still wins as the label, unaffected", () => {
  // The accept-path guard for #686: a fix aimed at the fallback label's wording
  // must not start affecting the ordinary case where meta.json is fine.
  const s = gatherSpend({ dir: fixture(TURN, { description: "Review PR 1" }) });
  assert.equal(s.top[0].label, "Review PR 1");
});

test("a genuinely absent meta.json — the real unnamed agent — stays silent", () => {
  // The false-positive half. The unnamed-agent path is the existsSync guard, and
  // it must not start emitting a warning: every controller-dispatched agent
  // without a sidecar would print one, every tick.
  let s;
  assert.deepEqual(withStderr(() => { s = gatherSpend({ dir: fixture(TURN) }); }), []);
  // #602: the false-positive half of metaErrors too — an unnamed agent is
  // normal operation, not a fault, and must not inflate the tally.
  assert.equal(s.metaErrors, 0);
});

test("a meta.json holding valid JSON of the wrong SHAPE is a SIDECAR fault", () => {
  // JSON.parse SUCCEEDS on `null`, so the shape check is the only thing between
  // it and `a.meta.description`. Measured without the guard: the agent's 1000
  // cacheWrite left the totals, it was counted `skipped`, and stderr blamed
  // `agent-x.jsonl` — the TRANSCRIPT — for a fault that is the sidecar's.
  const dir = fixture(TURN);
  writeFileSync(join(dir, "agent-x.meta.json"), "null");
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /agent-x\.meta\.json/);
  assert.equal(s.totals.cacheWrite, 1000);
  assert.equal(s.skipped, 0);
  assert.equal(s.metaErrors, 1);
});

test("#602: a reviewer's torn meta sidecar is distinguishable from a genuine zero reviewPct", () => {
  // Reproduces the issue's measured refuter probe: a reviewer + an implementer,
  // the reviewer's sidecar torn. reviewPct still reads 0 — fixing that number is
  // the #325 defect this ticket was explicitly deferred FROM, not this one's
  // business — but metaErrors is the new field that says the 0 is not to be
  // trusted, where before nothing on this return did.
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  const reviewerTurn = JSON.stringify({ type: "assistant", message: { id: "r1", usage: { cache_creation_input_tokens: 4000, output_tokens: 1 }, content: [] } });
  const implTurn = JSON.stringify({ type: "assistant", message: { id: "i1", usage: { cache_creation_input_tokens: 1000, output_tokens: 1 }, content: [] } });
  writeFileSync(join(dir, "agent-reviewer.jsonl"), reviewerTurn + "\n");
  writeFileSync(join(dir, "agent-reviewer.meta.json"), '{"description":"Review PR 1"'); // torn mid-write
  writeFileSync(join(dir, "agent-impl.jsonl"), implTurn + "\n");
  writeFileSync(join(dir, "agent-impl.meta.json"), JSON.stringify({ description: "impl-1" }));
  const s = gatherSpend({ dir });
  assert.equal(s.reviewPct, 0); // unchanged — the fault this ticket does not fix
  assert.equal(s.metaErrors, 1); // but now visible as a fault, not a legitimate zero
  assert.equal(s.skipped, 0); // both transcripts still contributed their tokens
  assert.equal(s.totals.cacheWrite, 5000);
});

test("#602: a legitimately zero reviewPct with no sidecar fault reports no metaErrors — no false positive", () => {
  const s = gatherSpend({ dir: fixture(TURN, { description: "impl-1" }) });
  assert.equal(s.reviewPct, 0); // genuinely no review-side spend this run
  assert.equal(s.metaErrors, 0); // and nothing claims otherwise
});

test("a broken sidecar warns ONCE across ticks, not once per tick", () => {
  // `serve` rebuilds every ~15s and a broken sidecar is broken on every one, so
  // the `meta` gate is the whole difference between one line and a flood.
  // A single call cannot see that gate at all — pinning it takes two.
  const dir = fixture(TURN);
  writeFileSync(join(dir, "agent-x.meta.json"), '{"spawnDepth":0,"descrip');
  const errs = withStderr(() => { gatherSpend({ dir }); gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one line across two ticks, got " + JSON.stringify(errs));
});

// #606: the per-line catch inside readAgent was position-blind. Its comment
// justified the skip with one cause — the torn last line a transcript being
// appended to has on every tick — but applied it to every line in the split.
// Measured before the fix on a 3-turn transcript, cache_creation 100/200/300:
// a mid-file tear read 400 and a tail tear read 300, both with `skipped` 0 and
// zero bytes on stderr, so the never-expected fault and the expected one were
// indistinguishable to anyone watching.
//
// Raw-text sibling of fixture(): these two pin opposite sides of one
// discriminator, and the TRAILING NEWLINE is the whole difference between them
// — fixture() always writes one, which is exactly the case that must stay
// silent. One jsonl line per turn HERE, so a lost line is a lost turn and the
// cacheWrite assertions below are exact. A real multi-line turn degrades instead
// of vanishing: usage is billed once, on the first SURVIVING line carrying that
// message.id, so cache_creation / cache_read / maxCtx come through whole — but
// the tear still costs that line's tool_use blocks, and tearing the line that
// holds the largest output_tokens snapshot drops the turn's output to the
// largest that survived (measured on a 1/1/300 turn: 300 -> 1).
function rawFixture(text) {
  const dir = mkdtempSync(join(tmpdir(), "spend-"));
  writeFileSync(join(dir, "agent-x.jsonl"), text);
  return dir;
}
const oneLineTurn = (id, cw) => JSON.stringify({
  type: "assistant",
  message: { id, usage: { input_tokens: 0, cache_creation_input_tokens: cw, cache_read_input_tokens: 0, output_tokens: 7 }, content: [{ type: "text" }] },
});
const TORN = '{"type":"assist';
// Hoisted rather than spelled out at each use: three tests below feed the SAME
// mid-file tear, and two of them exist only to re-run the first's exact input.
// Spelled out per site, one can be edited and the others stay green — measured,
// the whole 1158-test suite passes with the copies drifted apart.
const MIDFILE_TEAR = [oneLineTurn("msg_a", 1000), TORN, oneLineTurn("msg_c", 500)].join("\n") + "\n";

test("a transcript line damaged away from the tail is reported, not swallowed", () => {
  // The real-fault half. The damaged line sits BETWEEN two good turns, so the
  // assertion also covers the ticket's second requirement: the surrounding
  // turns' spend is still accounted rather than lost with it.
  const dir = rawFixture(MIDFILE_TEAR);
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
  assert.match(errs[0], /agent-x\.jsonl/);
  assert.equal(s.totals.cacheWrite, 1500);
  // Booked, not skipped — a damaged line costs its own turn, never the agent.
  assert.equal(s.skipped, 0);
});

test("a torn LAST line stays silent — the tear every tick legitimately produces", () => {
  // The false-positive half, and the reason the discriminator has to exist at
  // all: `serve` rebuilds every ~15s, so warning per bad line would print a
  // line every tick for every transcript still being appended to. No trailing
  // newline — the torn write is the final element of the split.
  const dir = rawFixture([oneLineTurn("msg_a", 1000), TORN].join("\n"));
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.deepEqual(errs, []);
  // ...and everything before the tear still parsed.
  assert.equal(s.totals.cacheWrite, 1000);
});

test("a damaged mid-file line warns ONCE across ticks, not once per tick", () => {
  // Same flood argument as the sidecar's `meta` gate: a transcript that is
  // damaged is damaged on every tick, so a single call cannot see the gate.
  const dir = rawFixture(MIDFILE_TEAR);
  const errs = withStderr(() => { gatherSpend({ dir }); gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one line across two ticks, got " + JSON.stringify(errs));
});

test("two damaged transcripts in one dir each get their own warning", () => {
  // The gate is a Set keyed on the FULL PATH, and the dedup test above cannot
  // see that: it holds ONE path constant across two ticks, which a single
  // module-level boolean satisfies identically. Measured — under that boolean
  // the dedup test still fails, but only because an earlier test in this file
  // already set the flag, so it discriminates by execution order rather than by
  // anything it builds. Two paths in one tick is the shape that actually pins
  // per-path keying: a bare-filename key or a global flag silences the second.
  const dir = rawFixture(MIDFILE_TEAR);
  writeFileSync(join(dir, "agent-y.jsonl"), MIDFILE_TEAR);
  const errs = withStderr(() => { gatherSpend({ dir }); });
  assert.equal(errs.length, 2, "expected one line per damaged transcript, got " + JSON.stringify(errs));
  assert.equal(errs.filter((e) => /agent-x\.jsonl/.test(e)).length, 1, JSON.stringify(errs));
  assert.equal(errs.filter((e) => /agent-y\.jsonl/.test(e)).length, 1, JSON.stringify(errs));
});

test("a tail tear that later moves mid-file is reported on the tick it moves", () => {
  // Where the `lines` gate is CALLED is load-bearing and no test above can see
  // it: all three hold the file's SHAPE constant across ticks, so moving the
  // warnOnce call out of the position check — making a legitimate tail tear
  // consume the file's one warning — leaves the suite green while permanently
  // silencing the real fault. Tick 1 is that legitimate live tail tear (no
  // trailing newline); tick 2 is the SAME tear after the transcript grew, which
  // is the sequence `serve` produces every ~15s.
  const dir = rawFixture([oneLineTurn("msg_a", 1000), TORN].join("\n"));
  assert.deepEqual(withStderr(() => gatherSpend({ dir })), [], "tick 1: a torn tail is legitimate, stay silent");
  writeFileSync(join(dir, "agent-x.jsonl"), MIDFILE_TEAR);
  let s;
  const errs = withStderr(() => { s = gatherSpend({ dir }); });
  assert.equal(errs.length, 1, "expected one stderr line on tick 2, got " + JSON.stringify(errs));
  assert.match(errs[0], /agent-x\.jsonl/);
  assert.equal(s.totals.cacheWrite, 1500);
});

// The `lines` and `skips` gates are keyed on the SAME transcript path, and every
// test above feeds each gate a path no other gate has seen — so the whole suite
// stays green under a single warn-once Set with no channel in its key, while a
// torn line permanently silences that file's later skip. Measured: with the
// channel dropped from the key, this is the only test in the file that fails.
//
// Both ticks are faults the operator must see, and they are DIFFERENT faults —
// tick 1 costs one turn out of a booked agent, tick 2 costs the whole agent —
// so neither line may be spent on the other. The directory-where-a-file-is-
// expected trick is the same one the panel-blackout test uses; it produces
// EISDIR out of readAgent's read regardless of who is running the suite, which
// a chmod would not.
test("a torn line and an unreadable read on the SAME transcript each get their own line", () => {
  const dir = rawFixture(MIDFILE_TEAR);
  const file = join(dir, "agent-x.jsonl");
  assert.equal(withStderr(() => gatherSpend({ dir })).length, 1, "tick 1: the mid-file tear");
  rmSync(file);
  mkdirSync(file);
  const errs = withStderr(() => gatherSpend({ dir }));
  assert.equal(errs.length, 1, "tick 2: the unreadable transcript, got " + JSON.stringify(errs));
  assert.match(errs[0], /skipping agent-x\.jsonl/, "the skip gate's line, not the torn-line gate's");
});

// The keyless caller. Every other gate keys on a PR or a path, so nothing else
// in the suite drives warnOnce's empty key, and the folded-in spend-dir gate
// would be collapsed untested. The failure it reports is the session directory
// itself, which is why there is nothing to key on: a second tick cannot be a
// different instance of it.
test("the keyless spend-dir gate warns once per process, not once per tick", () => {
  const dir = { error: "no session directory under ~/.claude/projects for this cwd" };
  assert.equal(withStderr(() => gatherSpend({ dir })).length, 1, "tick 1 reports");
  assert.deepEqual(withStderr(() => gatherSpend({ dir })), [], "tick 2 stays quiet");
});

test("an unreadable dir reports an error rather than posing as an empty run", () => {
  // The distinction that hid the path bug: a hidden panel meant both "nothing
  // yet" and "this is broken", so the broken case never surfaced.
  const s = gatherSpend({ dir: join(tmpdir(), "definitely-not-here-12345") });
  assert.ok(s.error, "expected an error object, got " + JSON.stringify(s));
  // The TAG, not the message: the page routes on `ok` alone (#959), so a
  // producer that stops emitting it hides the panel no matter what `error` says.
  assert.equal(s.ok, false);
});

test("every gatherSpend return carries the tag the page routes on (#959)", () => {
  // One test over all four returns, because the defect was a MISSING tag on one
  // of them, and a per-return test is what leaves the next one untagged.
  // The unresolvable-dir return.
  assert.equal(gatherSpend({ dir: { error: "no session directory for this cwd" } }).ok, false);
  // The all-unreadable return: a dir holding only a transcript that cannot be read.
  const allBad = mkdtempSync(join(tmpdir(), "spend-"));
  mkdirSync(join(allBad, "agent-trap.jsonl")); // a directory where a file is expected
  let bad;
  withStderr(() => { bad = gatherSpend({ dir: allBad }); }); // it warns; the warning is not what is under test
  assert.equal(bad.ok, false);
  assert.match(bad.error, /all 1 transcripts unreadable/);
  // The success return.
  assert.equal(gatherSpend({ dir: fixture(TURN) }).ok, true);
  // And the one return that is deliberately NOT an object: nothing yet.
  assert.equal(gatherSpend({ dir: mkdtempSync(join(tmpdir(), "spend-")) }), null);
});

test("encodeProjectDir covers every non-alphanumeric character", () => {
  assert.equal(encodeProjectDir("/Users/x/my_repo"), "-Users-x-my-repo");
  assert.equal(encodeProjectDir("/Users/x/a b"), "-Users-x-a-b");
});

// #169: `arg()` is CLI-internal (not exported), so this pins the trailing-flag
// refusal at the process boundary. `ledger`/`prev`/`spend-since`/`port`/
// `interval` all read via `arg(n) || default` or `?? `, so a trailing flag
// previously fell straight through to the default in total silence —
// `--spend-since` with nothing after it silently widened the spend panel to
// all-time; `--ledger` with nothing after it silently read the wrong file.
// Dies before any gh call, so no PATH stub is needed here.
test("CLI: trailing --ledger (no value) dies (exit 2) rather than silently falling back to the default ledger", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

test("CLI: --ledger=path form dies by name, not silently read as absent", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger=/tmp/x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a space-separated value/);
});

// The other two branches of the same guard, neither of which the tests above
// reach: a flag eating the NEXT FLAG as its value (mutating away
// `value.startsWith("--")` left board/ci-state/diff-stats 100% green), and an
// explicit empty/whitespace value (`value.trim() === ""` was unpinned in all
// five scripts that then carried it — board, candidates, ci-state, diff-stats,
// pr-overlap — simultaneously). Both die before any gh call.
test("CLI: --ledger followed by another flag is rejected, not read as the string \"--prev\"", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger", "--prev", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

// #463 fallout, and the one ordering nothing else pins: `--ledger` is read
// above stray() and always was, so none of the cases above reaches the new
// guard at all. `--prev` is read inside the `build` branch, where stray() also
// sits — with the read left below it, this invocation refused with `unexpected
// argument '9000'`, naming --port's innocent value instead of the flag
// actually given wrong (measured). Moving the read back below stray() is what
// this reds on.
test("CLI: trailing --prev names --prev, not the innocent value of the flag behind it", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--prev", "--port", "9000"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--prev needs a value/);
});

test("CLI: --ledger given an empty value dies rather than falling back to the default ledger", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger", ""], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

// #468: argPort()/has("open") used to run only inside serve(), so build never
// evaluated them — `build --port abc` and `build --open=1` were silently
// IGNORED at exit 0 rather than refused, the one silent-default shape
// ledger/prev/spend-since/interval (pinned above and in board-cli.test.mjs)
// did not share. main() now calls both once, ahead of the build/serve
// dispatch, so these refuse on build too, with the exact wording serve
// already refuses them with. All three die before gather()'s first gh read
// (the guard moved above the dispatch, not just above serve()'s own call),
// so — like the --ledger/--prev cases above — none of these need the gh-stub
// rig board-cli.test.mjs carries for the guards that fire mid-gather().
test("CLI: build refuses a trailing --port, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port needs a value/);
});

test("CLI: build refuses a non-numeric --port, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", "abc"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

test("CLI: build refuses --open=1, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--open=1"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--open is a boolean flag, not --open=/);
});

// The ordering half of the same fix, and the one the three cases above cannot
// see: they pass a malformed flag ALONE, so nothing distinguishes a guard that
// runs ahead of the build branch's stray() from one that runs after it. Add a
// stray positional and it does: with the guard moved below that stray() call,
// this invocation refused with `unexpected argument 'extra'` (measured),
// naming a trailing token instead of the malformed value the caller actually
// got wrong. Both orderings still exit 2 — only which real mistake gets named
// differs, which is exactly what the --prev case above pins for its own flag.
test("CLI: build refuses a malformed --port ahead of a stray token, naming --port not the stray", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", "abc", "extra"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

// #1076: same ordering gap as the --prev/--port cases above, for the two
// flags PR #1090 (#468) left standing — argInterval()'s read had two call
// sites (serve() directly, and embedded in gather()'s return, which build's
// dispatch reaches too), and the --spend-since read sat inside gather();
// all three sat below every stray() call on every path that reaches them.
// With any of those reads left below the guard, the invocation refused
// with `unexpected argument 'x'` (measured), naming the value flag's own
// innocent trailing token instead of the flag actually given wrong — true
// of build+interval as much as the serve+interval and build+spend-since
// cases below cover. Hoisting both into main(), the same place and the
// same way #468 hoisted argPort()/has("open"), is what these two red on
// if reverted.
test("CLI: serve refuses a trailing --interval ahead of a stray token, naming --interval not the stray", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "serve", "--interval", "--open", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--interval needs a value/);
});

test("CLI: build refuses a trailing --spend-since ahead of a stray token, naming --spend-since not the stray", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--spend-since", "--open", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--spend-since needs a value/);
});

// The other two malformed spellings arg.mjs refuses, which the hoist closes on
// build alongside the three above. Pinned because a NARROWED hoist keeps the
// three green while dropping these: measured, `if (process.argv.includes(
// "--port")) argPort();` — a plausible "only bother when the flag was given" —
// leaves `build --port=9000` at exit 0 with every other case still refusing.
test("CLI: build refuses --port=9000, same message as serve", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port=9000"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port needs a space-separated value, not --port=/);
});

test("CLI: build refuses an empty --port value rather than falling back to the default port", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--port", ""], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port needs a value/);
});

// The hoist sits above the `cmd` dispatch, not just above serve()'s own call,
// so it also changed the no-subcommand path: `board.mjs --port abc` printed
// the usage line before this fix and names the flag after it (measured, both
// sides). Sanctioned by #468's Option A ruling — a malformed flag is refused
// wherever it is written — and unpinned until now: the same narrowing that
// moves the guards into the `build` branch restores the usage line here while
// leaving all four `build` cases above green.
test("CLI: a malformed --port with no subcommand names the flag, not the usage line", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--port", "abc"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

// #169 review: a --port we cannot use falls back to 8123, and the bind error
// used to name that substituted default as if the caller had chosen it — it
// told someone who DID pass --port to "pass --port <n>", pointing them at a
// port they never named. PATH is stripped to an empty dir so every gh/git/node
// child fails fast into tryRun's catch; the tick degrades and serve() still
// reaches listen(). Offline, ~50ms.
const serveArgs = (args) => [SCRIPT, "serve", ...args];
const serveOpts = () => ({
  cwd: mkdtempSync(join(tmpdir(), "board-serve-")),
  env: { ...process.env, PATH: mkdtempSync(join(tmpdir(), "board-nobin-")) },
  encoding: "utf8",
  timeout: 20000,
});

// #366 hardened argPort(): a garbage --port now dies before ever reaching
// listen(), so it can no longer stand in for "--port not given at all" here.
// This test now drives the true absent case; the garbage case moved to the
// numeric-guard tests below.
test("CLI: serve marks 8123 as the default in the bind error when --port was not given", async () => {
  const blocker = createServer();
  // 8123 just has to be held by SOMEONE — us, or whatever already had it.
  await new Promise((res) => { blocker.once("error", res); blocker.listen(8123, res); });
  try {
    const r = spawnSync(process.execPath, serveArgs([]), serveOpts());
    assert.equal(r.status, 2);
    assert.match(r.stderr, /port 8123 \(default\) in use/);
  } finally { blocker.close(() => {}); }
});

test("CLI: serve does NOT call a port the caller really passed a default", async () => {
  const blocker = createServer();
  const port = await new Promise((res) => blocker.listen(0, () => res(blocker.address().port)));
  try {
    const r = spawnSync(process.execPath, serveArgs(["--port", String(port)]), serveOpts());
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`port ${port} in use`));
    assert.doesNotMatch(r.stderr, /\(default\)/);
  } finally { blocker.close(() => {}); }
});

// #366: `Number(x) || default` treated a non-numeric --port/--interval exactly
// like an absent one — silently substituting the default with no refusal.
// These pin the refusal itself, before listen() is ever reached.
test("CLI: serve refuses a non-numeric --port by name, not silently substituting the default", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "abc"]), serveOpts());
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--port wants an integer 0-65535, got abc/);
});

test("CLI: serve refuses an out-of-range or non-integer --port", () => {
  for (const v of ["-1", "70000", "1.5"]) {
    const r = spawnSync(process.execPath, serveArgs(["--port", v]), serveOpts());
    assert.equal(r.status, 2, `expected exit 2 for ${v}: ${r.stderr}`);
    assert.match(r.stderr, /--port wants an integer 0-65535/, `for ${v}: ${r.stderr}`);
  }
});

// The named case that must NOT be refused: listen(0) binds an ephemeral port,
// a real use, and 0 is falsy — the exact value the old `|| null` idiom lost.
// serve() only exits on SIGINT/SIGTERM once bound, so a timeout here is the
// expected shape of success; the refusal this guards against dies with
// status 2 almost instantly and never reaches listen() at all.
//
// Accepting 0 is only half of it: the announced URL has to be one the operator
// can open. Echoing the REQUESTED port printed http://localhost:0 — reachable
// by nothing — while the board sat on the kernel's pick, so pin that the
// number announced is the one bound, not the one asked for (#435 review).
test("CLI: serve accepts --port 0 (ephemeral bind), announces the port it actually bound, and opens nothing unasked", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600"]), { ...serveOpts(), timeout: 2000 });
  assert.notEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /--port wants/);
  const announced = r.stderr.match(/cockpit on http:\/\/localhost:(\d+)/);
  assert.ok(announced, `no cockpit line: ${r.stderr}`);
  assert.notEqual(announced[1], "0", `announced the requested port, not the bound one: ${r.stderr}`);
  // …and the ABSENT half of #364's has() control rides this spawn rather than
  // paying for a second one byte-identical to it: no --open was passed, so
  // nothing may try to open. The --open test below carries the present half,
  // and explains why a failed tryRun("open", …) surfaces on stderr at all.
  assert.doesNotMatch(r.stderr, /open http:\/\/localhost:\d+\/ failed/, r.stderr);
});

test("CLI: serve refuses a non-numeric or non-positive --interval by name", () => {
  for (const v of ["abc", "0", "-5"]) {
    const r = spawnSync(process.execPath, serveArgs(["--interval", v]), serveOpts());
    assert.equal(r.status, 2, `expected exit 2 for ${v}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`--interval wants seconds > 0 and <= 2147483, got ${v}`), `for ${v}: ${r.stderr}`);
  }
});

// Both boundaries, both flags — an untested edge is an edge a later mutation
// walks straight through: `n > 65535` weakened to `n >= 65535` (rejecting the
// legal maximum port) survived the whole suite (#435 review). 65535 may well
// be free here and may not, so pin the ABSENCE of the refusal rather than a
// successful bind: an occupied port dies with "port 65535 in use", a rejected
// one with "--port wants", and only the second is this guard's doing.
test("CLI: serve accepts the maximum legal --port 65535 and refuses 65536", () => {
  const ok = spawnSync(process.execPath, serveArgs(["--port", "65535", "--interval", "3600"]), { ...serveOpts(), timeout: 2000 });
  assert.doesNotMatch(ok.stderr, /--port wants/, ok.stderr);
  const over = spawnSync(process.execPath, serveArgs(["--port", "65536"]), serveOpts());
  assert.equal(over.status, 2, over.stderr);
  assert.match(over.stderr, /--port wants an integer 0-65535, got 65536/);
});

// The interval ceiling is setInterval's, so pin it where it bites: at the max
// the timer must be armed normally, one second past it the flag is refused.
// Without the ceiling, 2147484s becomes a 1ms tick and the rebuild loop spins
// on gh instead of sleeping ~25 days — announced only by Node's own warning.
test("CLI: serve arms the maximum --interval 2147483 without overflowing, and refuses 2147484", () => {
  const ok = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "2147483"]), { ...serveOpts(), timeout: 2000 });
  assert.doesNotMatch(ok.stderr, /--interval wants/, ok.stderr);
  assert.doesNotMatch(ok.stderr, /TimeoutOverflowWarning/, ok.stderr);
  const over = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "2147484"]), serveOpts());
  assert.equal(over.status, 2, over.stderr);
  assert.match(over.stderr, /--interval wants seconds > 0 and <= 2147483, got 2147484/);
});

// #364: has() used exact argv.includes, so a boolean flag written --open=value
// (in any form the value takes) silently read as absent. Boolean-specific
// wording, distinct from arg()'s "needs a space-separated value" above: a
// boolean has no value to give. Dies before listen(), same as the port/interval
// guards above — nothing this reaches ever shells out.
for (const v of ["=true", "=false", "="]) {
  test(`CLI: serve refuses --open${v} as a boolean flag, not silently read as absent`, () => {
    const r = spawnSync(process.execPath, serveArgs([`--open${v}`]), serveOpts());
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--open is a boolean flag, not --open=/);
  });
}

// Position, not just spelling: `serve` is fixed and every case in the loop
// above passes its flag alone, so all three land at exactly process.argv[3] —
// and a guard narrowed to that one index passes all three. Measured (#462
// review): has() rewritten to `process.argv[3].startsWith(...)` kept this file
// green at 34/34 while `serve --port 0 --interval 3600 --open=true` started
// the server, dropped the flag in silence and never opened a browser — #364
// itself, alive under a green suite. The real invocation always carries
// --port/--interval, so pin the flag where an operator actually types it.
// The MESSAGE is the load-bearing assertion, not `status`: spawnSync reports
// status 2 on a timeout too, so a serve left running would satisfy the code
// alone.
test("CLI: serve refuses --open=true behind other flags, not only as the first argument", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--open=true"]), { ...serveOpts(), timeout: 2000 });
  assert.match(r.stderr, /--open is a boolean flag, not --open=/, r.stderr);
  assert.equal(r.status, 2, r.stderr);
});

// The control: the new `=` guard must not touch the bare spelling. Observable
// effect is tryRun("open", …) firing — PATH is stripped to an empty dir
// (serveOpts), so the attempt itself fails ENOENT and shows up on stderr
// rather than actually opening a browser. The other half of the control —
// absence still reading as absent — is asserted on the --port 0 test above,
// whose spawn is byte-identical to the one this would otherwise repeat.
test("CLI: serve --open (bare) still reads as present, not swallowed by the `=` guard", () => {
  const opened = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600", "--open"]), { ...serveOpts(), timeout: 2000 });
  assert.match(opened.stderr, /open http:\/\/localhost:\d+\/ failed/, opened.stderr);
});

// #463: sweep() only ever refuses a `--`-prefixed token, so a bare stray
// alongside a valid subcommand rode through in silence the same way
// `board.mjs build junk` did — this pins the `serve` side of that fix.
// stray() sits at the top of the `serve` branch, ahead of serve()'s own
// port/interval/open reads, so this dies before ever calling listen() —
// same reasoning as every guard above it in this file, and why serveOpts()'s
// 20s timeout is a backstop here rather than the expected path.
test("CLI: serve refuses a stray positional the same way build does", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "junk"]), serveOpts());
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unexpected argument 'junk'/);
});
