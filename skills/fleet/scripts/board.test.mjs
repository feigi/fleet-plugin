// Smoke test for the HTTP layer, plus the transcript-reading layer underneath
// the spend panel — no gh, no build loop. Boots the static server against a temp
// dir and asserts it serves board.json and the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardServer, mapCi, encodeProjectDir, findSubagentsDir, gatherSpend } from "./board.mjs";

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
  writeFileSync(join(newer, "agent-a.jsonl"), ""); // bump newer's mtime
  // ...but only far enough to be visible. Both dirs are created inside the same
  // millisecond on a fast filesystem, `mtimeMs` ties, and the sort is stable —
  // so the tie resolves to readdir order and `11111111-aaaa` wins on name. Age
  // `older` explicitly rather than sleeping for a clock tick.
  utimesSync(older, new Date(0), new Date(0));

  assert.equal(findSubagentsDir(home, "/Users/x/.claude"), newer);
  assert.equal(findSubagentsDir(home, "/Users/x/nonexistent"), null);
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

test("gatherSpend returns null rather than throwing when the dir is unreadable", () => {
  assert.equal(gatherSpend({ dir: join(tmpdir(), "definitely-not-here-12345") }), null);
});
