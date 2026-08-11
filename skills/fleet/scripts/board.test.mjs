// Smoke test for the HTTP layer, plus the transcript-reading layer underneath
// the spend panel — no gh, no build loop. Boots the static server against a temp
// dir and asserts it serves board.json and the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, chmodSync, realpathSync } from "node:fs";
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
// gate swallows two lines earlier; written that way this test took the same
// branch as its sibling above and stayed green while `verdict === "no-ci"` was
// mutated to return "green". `status: "completed"` is the whole pin: it is the
// shape that reaches the last line, so a silent no-ci→green mapping fails here
// and nowhere else.
test("mapCi: no-ci verdict past the status gate → unknown, not silently mapped", () => {
  assert.equal(mapCi(JSON.stringify({ status: "completed", verdict: "no-ci" })), "unknown");
});
test("mapCi: null or unparseable input → unknown", () => {
  assert.equal(mapCi(null), "unknown");
  assert.equal(mapCi("not json"), "unknown");
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

test("an unreadable dir reports an error rather than posing as an empty run", () => {
  // The distinction that hid the path bug: a hidden panel meant both "nothing
  // yet" and "this is broken", so the broken case never surfaced.
  const s = gatherSpend({ dir: join(tmpdir(), "definitely-not-here-12345") });
  assert.ok(s.error, "expected an error object, got " + JSON.stringify(s));
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
// four scripts simultaneously). Both die before any gh call.
test("CLI: --ledger followed by another flag is rejected, not read as the string \"--prev\"", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger", "--prev", "x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
});

test("CLI: --ledger given an empty value dies rather than falling back to the default ledger", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "build", "--ledger", ""], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--ledger needs a value/);
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

test("CLI: serve marks 8123 as the default in the bind error when --port could not be used", async () => {
  const blocker = createServer();
  // 8123 just has to be held by SOMEONE — us, or whatever already had it.
  await new Promise((res) => { blocker.once("error", res); blocker.listen(8123, res); });
  try {
    const r = spawnSync(process.execPath, serveArgs(["--port", "abc"]), serveOpts());
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

// ── the --spend-since trust boundary ──────────────────────────────────────────
// gather() reads process.argv directly and die()s with process.exit(2), so it
// cannot be called in-process the way gatherSpend() is — which is why this
// validation shipped with no coverage at all. Drive the real CLI instead.
//
// The stub `gh` fails on every call: each gh read goes through tryRun, which
// catches and degrades, so the board still builds and no test here touches the
// network or this repo's live issue list. It is prepended to PATH rather than
// replacing it, because gather() also shells out to `node`.
function runBoard(sinceArgs) {
  const home = mkdtempSync(join(tmpdir(), "since-home-"));
  // realpath, not the bare mkdtemp path: on darwin $TMPDIR is under /var, which
  // is a symlink to /private/var, and the child's process.cwd() reports the
  // RESOLVED form. Encoding the unresolved one puts the fixture at a path
  // findSubagentsDir never looks in, and the panel comes back { error }.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "since-cwd-")));
  const bin = mkdtempSync(join(tmpdir(), "since-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);
  // findSubagentsDir() defaults to $HOME and cwd, so the fixture has to sit
  // where the encoding puts it — encodeProjectDir is the same function under
  // test above, which is why the path is built with it rather than by hand.
  const sub = join(home, ".claude", "projects", encodeProjectDir(cwd), "sess", "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "agent-a.jsonl"), TURN.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return spawnSync(process.execPath, [SCRIPT, "build", "--ledger", join(cwd, "nope.md"), ...sinceArgs], {
    cwd, encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("--spend-since rejects a seconds-magnitude epoch — the mistake its own comment names", () => {
  // The motivating bug, and the one a finiteness-only guard cannot see: a
  // seconds value is perfectly finite, so it passed, filtered nothing out, and
  // produced a whole-session panel that reported itself as scoped — shipping
  // the bogus number into board.json's `since`, where nothing downstream could
  // tell. 1e12 ms is 2001-09-09, so every seconds-magnitude epoch is below it.
  const r = runBoard(["--spend-since", String(Math.floor(Date.now() / 1000))]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--spend-since wants epoch milliseconds/);
});

test("--spend-since rejects garbage, zero, negative and a boundary in the future", () => {
  // A future boundary matches nothing at all, which renders as an empty panel
  // rather than as the operator error it is.
  for (const v of ["yesterday", "0", "-1", String(Date.now() + 86_400_000)]) {
    const r = runBoard(["--spend-since", v]);
    assert.equal(r.status, 2, `expected exit 2 for ${v}: ${r.stderr}`);
    assert.match(r.stderr, /--spend-since wants epoch milliseconds/);
  }
});

test("--spend-since with the value omitted fails, rather than reading as 'no filter at all'", () => {
  // The flag as the last argv: arg() yields undefined and the guard's old
  // `sinceRaw == null` read that as "flag absent" — exit 0, whole session,
  // no stderr. Gating on has() is what closes it.
  const r = runBoard(["--spend-since"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--spend-since/);
});

test("a valid epoch-ms --spend-since survives the guard and reaches the payload", () => {
  // The leg that stops the guard from being merely strict. `since` is also the
  // only field downstream can read to tell a scoped panel from an unscoped one,
  // so it has to arrive, not just be accepted.
  const since = Date.now() - 3_600_000;
  const r = runBoard(["--spend-since", String(since)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).spend.since, since);
});

test("no --spend-since at all is not an error — the panel is simply unscoped", () => {
  const r = runBoard([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).spend.since, null);
});
