import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRole, computeSpend, attributeTools, mergeTools } from "./compute-spend.mjs";

const agent = (o) => ({ label: "x", role: "other", cacheWrite: 0, output: 0, cacheRead: 0, maxCtx: 0, ...o });

const call = (id, name, cacheWrite = 0) => ({ kind: "assistant", cacheWrite, tools: [{ id, name }] });
const result = (...rs) => ({ kind: "result", results: rs.map(([id, chars]) => ({ id, chars })) });

test("a tool result's cost is the NEXT assistant turn's cache write, not its own turn's", () => {
  // The turn that CALLS a tool has not seen the result yet, so charging it there
  // would credit the cost to whatever the agent happened to do beforehand.
  const tools = attributeTools([
    call("t1", "Bash", 100),
    result(["t1", 500]),
    { kind: "assistant", cacheWrite: 900, tools: [] },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool, "Bash");
  assert.equal(tools[0].cacheWrite, 900);
  assert.equal(tools[0].resultChars, 500);
  assert.equal(tools[0].calls, 1);
});

test("a multi-result turn splits proportionally by result size", () => {
  const tools = attributeTools([
    { kind: "assistant", cacheWrite: 0, tools: [{ id: "a", name: "Read" }, { id: "b", name: "Grep" }] },
    result(["a", 750], ["b", 250]),
    { kind: "assistant", cacheWrite: 1000, tools: [] },
  ]);
  const by = Object.fromEntries(tools.map((t) => [t.tool, t.cacheWrite]));
  assert.equal(by.Read, 750);
  assert.equal(by.Grep, 250);
});

test("CONSECUTIVE result turns accumulate — that, not the multi-block turn, is the real shape", () => {
  // Regression. Parallel tool calls do NOT arrive as one user turn carrying two
  // tool_result blocks: across 45,062 real result-bearing turns, none carried
  // two. They arrive as N single-result turns in a row (4,087 occurrences).
  // Replacing `pending` per result turn dropped every batch but the last —
  // 9.1% of all attributions — and made the proportional split above dead code.
  const tools = attributeTools([
    { kind: "assistant", cacheWrite: 0, tools: [{ id: "a", name: "Read" }, { id: "b", name: "Grep" }] },
    result(["a", 750]),
    result(["b", 250]),
    { kind: "assistant", cacheWrite: 1000, tools: [] },
  ]);
  const by = Object.fromEntries(tools.map((t) => [t.tool, t.cacheWrite]));
  assert.equal(by.Read, 750);
  assert.equal(by.Grep, 250);
});

test("an all-empty result batch still splits evenly rather than vanishing", () => {
  // A tool that returns nothing still costs a turn to process; dropping it would
  // silently under-report the cheap-but-chatty tools.
  const tools = attributeTools([
    { kind: "assistant", cacheWrite: 0, tools: [{ id: "a", name: "Read" }, { id: "b", name: "Grep" }] },
    result(["a", 0], ["b", 0]),
    { kind: "assistant", cacheWrite: 400, tools: [] },
  ]);
  const by = Object.fromEntries(tools.map((t) => [t.tool, t.cacheWrite]));
  assert.equal(by.Read, 200);
  assert.equal(by.Grep, 200);
});

test("a result whose tool_use id was never seen is counted as unknown, not dropped", () => {
  const tools = attributeTools([result(["orphan", 100]), { kind: "assistant", cacheWrite: 50, tools: [] }]);
  assert.equal(tools[0].tool, "unknown");
  assert.equal(tools[0].cacheWrite, 50);
});

test("a trailing result with no following assistant turn costs nothing but is still counted", () => {
  // Truncated transcripts are normal — an agent killed mid-turn. The call and the
  // bytes are real; the cache write never happened, so attributing one would invent spend.
  const tools = attributeTools([call("t1", "Bash", 0), result(["t1", 900])]);
  assert.equal(tools[0].calls, 1);
  assert.equal(tools[0].resultChars, 900);
  assert.equal(tools[0].cacheWrite, 0);
});

test("mergeTools sums across agents and recomputes shares over the merged total", () => {
  const merged = mergeTools([
    [{ tool: "Bash", calls: 2, resultChars: 100, cacheWrite: 300, pct: 100 }],
    [{ tool: "Bash", calls: 1, resultChars: 50, cacheWrite: 100, pct: 50 },
     { tool: "Read", calls: 4, resultChars: 20, cacheWrite: 100, pct: 50 }],
  ]);
  const by = Object.fromEntries(merged.map((t) => [t.tool, t]));
  assert.equal(by.Bash.calls, 3);
  assert.equal(by.Bash.cacheWrite, 400);
  assert.equal(by.Bash.resultChars, 150);
  assert.equal(by.Read.pct, 20);
  assert.equal(merged[0].tool, "Bash"); // sorted by spend
});

test("depth beats description for review-shaped names — fan-out is not reviewer spend", () => {
  // The fan-out names grandchildren things like "Review PR 539 correctness".
  // Matching description first would book half the specialist spend as reviewer
  // spend and destroy the only number that matters.
  assert.equal(classifyRole({ spawnDepth: 1, description: "Review PR 539 correctness" }), "specialist");
  assert.equal(classifyRole({ spawnDepth: 2, description: "Implement ticket 540" }), "specialist");
});

test("the controller's own UNNAMED dispatches are depth 1 too — sizing is not fan-out", () => {
  // Regression: only NAMED members are depth 0. The phase-0 sizing agents are
  // dispatched straight from the controller but unnamed, so they arrive at
  // depth 1 looking exactly like a specialist. Classifying on depth alone put
  // all five in "specialist" and moved the review headline from 83% to 87%.
  assert.equal(classifyRole({ spawnDepth: 1, description: "Size candidate batch A" }), "sizing");
  assert.equal(classifyRole({ spawnDepth: 1, description: "Size ticket 531" }), "sizing");
});

test("the sizing pattern is anchored, so a specialist that mentions sizing stays a specialist", () => {
  assert.equal(classifyRole({ spawnDepth: 1, description: "Review PR 539 — check batch sizing logic" }), "specialist");
});

test("memory agents are classified before depth, so they never land in review spend", () => {
  assert.equal(classifyRole({ agentType: "memory-proxy", description: "Save memory" }), "memory");
  assert.equal(classifyRole({ agentType: "memory-housekeeper", spawnDepth: 0 }), "memory");
});

test("depth-0 fleet roles come off the controller's naming convention", () => {
  assert.equal(classifyRole({ spawnDepth: 0, description: "Implement ticket 556" }), "implementer");
  assert.equal(classifyRole({ spawnDepth: 0, description: "Review PR 564" }), "reviewer");
  assert.equal(classifyRole({ spawnDepth: 0, description: "Finish PR 563" }), "finisher");
  assert.equal(classifyRole({ spawnDepth: 0, description: "Merge wave 7 — final" }), "merge-bot");

  assert.equal(classifyRole({ spawnDepth: 0, description: "something else entirely" }), "other");
});

test("finish-<n> agentType classifies as finisher — a historical spelling that must stay classifiable", () => {
  // `finisher-pr-<n>` is the canonical finisher name (#326); `finish-<n>` is a
  // spelling earlier runs actually dispatched and recorded runs still have to
  // classify. The match has to come off the agentType, not the literal words
  // "finish pr" or "finisher": the description deliberately does NOT start with
  // `finish-`, so an implementation keying on `description` alone fails here.
  assert.equal(classifyRole({ agentType: "finish-436", description: "Apply reviewer findings for PR 436" }), "finisher");
  // ...and the `^` has to be a real anchor: `finish-` mid-string is not a
  // finisher. Without this, dropping the anchor leaves the case above green.
  assert.equal(classifyRole({ spawnDepth: 0, description: "Rework the finish-label docs" }), "other");
  // A two-ticket finisher was dispatched as `finish-<n>-<m>`, so the pattern has
  // to match on the prefix rather than on a `finish-<digits>` shape. Its
  // description carries no finisher word either, for the same reason as above.
  assert.equal(classifyRole({ spawnDepth: 0, agentType: "finish-424-425", description: "Apply reviewer findings for PR 424 and 425" }), "finisher");
});

test("missing meta never throws — a transcript with no sibling .meta.json still counts", () => {
  assert.equal(classifyRole(undefined), "other");
  assert.equal(classifyRole({}), "other");
});

test("implementers classify off agentType, which is where `impl-` actually appears", () => {
  // `^impl-` is anchored against `${agentType} ${description}`, so it only ever
  // fires via the type. Pin that coupling — the description alone never matches.
  assert.equal(classifyRole({ spawnDepth: 0, agentType: "impl-332", description: "whatever" }), "implementer");
});

test("a role outside ROLE_ORDER is still reported, so percentages sum to 100", () => {
  // Regression: roles were built by mapping over ROLE_ORDER, so an unknown role
  // vanished from the table while its tokens stayed in totals — the column
  // silently stopped summing to 100 and the run read as cheaper than it was.
  const { roles, totals } = computeSpend({
    agents: [agent({ role: "weird", cacheWrite: 500 }), agent({ role: "reviewer", cacheWrite: 500 })],
  });
  assert.equal(totals.cacheWrite, 1000);
  assert.deepEqual(roles.map((r) => r.role).sort(), ["reviewer", "weird"]);
  assert.equal(roles.reduce((n, r) => n + r.pct, 0), 100);
});

test("percentages are of cache_creation, not of raw tokens", () => {
  // cacheRead is deliberately lopsided here: if it leaked into the ranking or
  // the percentage base, the implementer would outrank the reviewer.
  const { roles, totals } = computeSpend({
    agents: [
      agent({ role: "reviewer", cacheWrite: 300, cacheRead: 10 }),
      agent({ role: "implementer", cacheWrite: 100, cacheRead: 9_000_000 }),
    ],
  });
  assert.equal(roles[0].role, "reviewer");
  assert.equal(roles[0].pct, 75);
  assert.equal(roles[1].pct, 25);
  assert.equal(totals.cacheRead, 9_000_010);
});

test("reviewPct sums specialists and reviewers", () => {
  const { reviewPct } = computeSpend({
    agents: [
      agent({ role: "specialist", cacheWrite: 470 }),
      agent({ role: "reviewer", cacheWrite: 360 }),
      agent({ role: "implementer", cacheWrite: 170 }),
    ],
  });
  assert.equal(Math.round(reviewPct), 83);
});

test("an empty run produces zeroes, not NaN", () => {
  const s = computeSpend({ agents: [] });
  assert.equal(s.totals.cacheWrite, 0);
  assert.deepEqual(s.roles, []);
  assert.deepEqual(s.top, []);
  assert.equal(s.reviewPct, 0);
});

test("maxCtx is a max, never a sum", () => {
  const { roles, totals } = computeSpend({
    agents: [agent({ role: "reviewer", maxCtx: 324_000 }), agent({ role: "reviewer", maxCtx: 120_000 })],
  });
  assert.equal(roles[0].maxCtx, 324_000);
  assert.equal(totals.maxCtx, 324_000);
});

test("top is ranked by cache_creation and honours topN", () => {
  const { top } = computeSpend({
    agents: [
      agent({ label: "a", cacheWrite: 10 }),
      agent({ label: "b", cacheWrite: 30 }),
      agent({ label: "c", cacheWrite: 20 }),
    ],
    topN: 2,
  });
  assert.deepEqual(top.map((t) => t.label), ["b", "c"]);
});
