// Smoke test for the HTTP layer only — no gh, no build loop. Boots the static
// server against a temp dir and asserts it serves board.json and the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardServer, mapCi } from "./board.mjs";

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
