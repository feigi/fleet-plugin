import { test } from "node:test";
import assert from "node:assert/strict";
import { CELLS, computeCellEvidence } from "../plugin/scripts/compute-cell-evidence.mjs";
import { readCostGuard } from "../plugin/scripts/fleet-tick.mjs";
import { guardFile } from "../plugin/scripts/pr-cost.mjs";

// The Cell evidence tab's model, pure: the guard section (what the guard holds
// each Cell to) and "Declared, not measured". Every word the page shows is built
// here, so each state and each label is pinned on the string it makes.

// One guard entry as pr-cost.mjs's guardFile writes it: the whole computeReport
// entry beside `n`. Today's slow-high, give or take: 69 merged, 8 of 69 claims failed.
const entry = (cell, o = {}) => ({
  cell, generation: "claude-opus-5", n: 69, n_pulls: 75, n_merged: 69, n_claims: 69, n_failed: 8, fail_rate: 0.1159,
  mean_usd: 14.9, median_usd: 12, by_hand: 56, no_ruling: 0, pending: 0, router_usd: 0, usd_diff_ci95: null,
  left_out: 0, unpriced: 0, untimed: 0, excluded: 0, older: [], ...o,
});
const guardOk = (cells, o = {}) => ({
  status: "ok",
  guard: {
    computed_at: "2026-10-26T19:17:33.000Z", window_start: "2026-10-03",
    baseline: { cell: "slow-high", generation: "claude-opus-5", n: 69, mean_usd: 14.9, fail_rate: 0.1159 },
    cells, tripped: [], verdict: "ok", retire: false, min_n: 20, trip_points: 15, tsv_blobs: {}, ...o,
  },
});
const TODAY = () => guardOk([
  entry("slow-high"),
  entry("task-high", { generation: "claude-sonnet-5-5", n_failed: 15, fail_rate: 0.2174, mean_usd: 10.2, by_hand: 60, excluded: 1 }),
  entry("smol-high", { generation: "claude-haiku-5-5", n: 32, n_merged: 32, n_claims: 32, n_failed: 7, fail_rate: 0.2188, mean_usd: 6.1, by_hand: 26, excluded: 5, unpriced: 1 }),
]);

const ROLES = { value: { slow: "anthropic/claude-opus-5:high", task: "anthropic/claude-sonnet-5-5:high", smol: "anthropic/claude-haiku-5-5:auto" }, readAt: Date.UTC(2026, 9, 28, 9, 0), error: null };
const NO_RECEIPTS = { phase0: null, closeout: null };
const AGENTS = {
  list: [...CELLS.map((c) => ({ file: `fleet-implementer-${c}.agent.md`, model: `"@${c.split("-")[0]}:${c.split("-")[1]}"` })),
    { file: "fleet-finisher.agent.md", model: '"@slow:high"' }, { file: "fleet-review-types.agent.md", model: "'@smol:medium'" }],
  error: null,
};
const build = (o = {}) => computeCellEvidence({ guard: TODAY(), receipts: NO_RECEIPTS, agents: AGENTS, modelRoles: ROLES, ...o });
const cellOf = (ce, cell) => ce.guard.cells.find((c) => c.cell === cell);

// -- all five Cells, in every state --------------------------------------------

const STATES = {
  "today's guard": () => ({ guard: TODAY() }),
  "no cost guard": () => ({ guard: { status: "missing" } }),
  "an unreadable guard": () => ({ guard: { status: "unreadable", why: "not JSON" } }),
  "holds nothing back": () => ({ guard: guardOk([entry("slow-high", { n: 7, n_merged: 7 })], { verdict: "none", baseline: { cell: "slow-high", generation: "claude-opus-5", n: 7, mean_usd: 14.9, fail_rate: 0.1 } }) }),
  "a tripped Cell": () => ({ guard: guardOk(TODAY().guard.cells, { verdict: "tripped", tripped: ["task-high"] }) }),
  "a guard that predates the new fields": () => ({ guard: guardOk([{ cell: "slow-high", generation: "claude-opus-5", n: 40, mean_usd: 14.9, fail_rate: 0.1, untimed: 0 }]) }),
  "no modelRoles read yet": () => ({ modelRoles: null }),
};

test("all five implementer Cells are drawn in a fixed order, in every state", () => {
  for (const [name, o] of Object.entries(STATES)) {
    assert.deepEqual(build(o()).guard.cells.map((c) => c.cell), CELLS, name);
  }
  assert.deepEqual(CELLS, ["slow-high", "task-high", "smol-high", "slow-medium", "task-max"]);
});

test("every anchor a card or link could name exists in every state: each Cell, and each generation", () => {
  for (const [name, o] of Object.entries(STATES)) {
    const ce = build(o());
    for (const c of ce.guard.cells) {
      assert.equal(c.anchor, `cell-${c.cell}`, name);
      const anchors = [c.figures?.anchor, c.none?.anchor, ...c.older.map((x) => x.anchor)].filter(Boolean);
      // A Cell with figures names its generation; one without names the Tier route model's, when there is one.
      if (c.figures) assert.equal(c.figures.anchor, `cell-${c.cell}@${c.figures.generation}`, name);
      if (name !== "no modelRoles read yet" || c.figures) assert.ok(anchors.length > 0, `${name}: ${c.cell} has a generation anchor`);
    }
    const all = ce.guard.cells.flatMap((c) => [c.anchor, c.figures?.anchor, c.none?.anchor, ...c.older.map((x) => x.anchor)]).filter(Boolean);
    assert.equal(new Set(all).size, all.length, `${name}: no anchor is drawn twice`);
  }
});

test("a Cell the guard holds beyond the five is drawn after them, never left out", () => {
  const ce = build({ guard: guardOk([entry("slow-high"), entry("slow-low", { generation: "claude-opus-5" })]) });
  assert.deepEqual(ce.guard.cells.map((c) => c.cell), [...CELLS, "slow-low"]);
  assert.equal(cellOf(ce, "slow-low").figures.generation, "claude-opus-5");
});

// -- today's guard ---------------------------------------------------------------

test("today's guard: slow-high, task-high and smol-high with their three figures; slow-medium and task-max 'no figures yet'", () => {
  const ce = build();
  const g = ce.guard;
  assert.equal(g.state, "trips-nothing");
  assert.equal(g.heading, "trips nothing");
  assert.equal(g.source, "this repository's runs · computed 2026-10-26 19:17Z · window from 2026-10-03 · min 20 merged PRs · floor 15 pts over slow-high");

  const slow = cellOf(ce, "slow-high");
  assert.equal(slow.baseline, true);
  assert.equal(slow.judged, "judged on claude-opus-5");
  assert.equal(slow.route.text, "Tier route: anthropic/claude-opus-5 · high");
  assert.equal(slow.route.flag, null);
  assert.equal(slow.figures.merged.text, "69 ≥ 20 ✓");
  assert.equal(slow.figures.failRate.text, "11.6% · the floor is 26.6%");
  assert.deepEqual(slow.figures.failRate.beside, ["56 of 69 Rulings given by hand"]);
  assert.equal(slow.figures.usd.text, "$14.90");

  const task = cellOf(ce, "task-high");
  assert.equal(task.baseline, false);
  assert.equal(task.judged, "judged on claude-sonnet-5-5");
  assert.equal(task.figures.merged.text, "69 ≥ 20 ✓");
  assert.equal(task.figures.failRate.text, "21.7% · +10.1 pts on slow-high · 4.9 pts inside the floor");
  assert.deepEqual(task.figures.failRate.beside, ["60 of 69 Rulings given by hand"]);
  assert.equal(task.figures.usd.text, "$10.20 · −31.5% on slow-high");

  const smol = cellOf(ce, "smol-high");
  assert.equal(smol.figures.merged.text, "32 ≥ 20 ✓");
  assert.deepEqual(smol.figures.failRate.beside, ["26 of 32 Rulings given by hand"]);

  for (const cell of ["slow-medium", "task-max"]) {
    const c = cellOf(ce, cell);
    assert.equal(c.figures, null, cell);
    assert.equal(c.judged, null, cell);
  }
  assert.equal(cellOf(ce, "slow-medium").none.text, "no figures yet for claude-opus-5");
  assert.equal(cellOf(ce, "task-max").none.text, "no figures yet for claude-sonnet-5-5");
  assert.equal(cellOf(ce, "task-max").none.anchor, "cell-task-max@claude-sonnet-5-5");
});

// -- the verdict states ------------------------------------------------------------

test("the heading gives the verdict: trips nothing, trips <cells>, holds nothing back, no cost guard", () => {
  assert.equal(build().guard.heading, "trips nothing");
  const tripped = build({ guard: guardOk(TODAY().guard.cells, { verdict: "tripped", tripped: ["task-high", "smol-high"] }) }).guard;
  assert.equal(tripped.state, "trips");
  assert.equal(tripped.heading, "trips task-high, smol-high");
  const none = build(STATES["holds nothing back"]()).guard;
  assert.equal(none.state, "holds-nothing-back");
  assert.equal(none.heading, "holds no Cell back until slow-high has 20 merged PRs: it has 7");
  const missing = build(STATES["no cost guard"]()).guard;
  assert.equal(missing.state, "no-guard");
  assert.equal(missing.heading, "no cost guard");
  assert.equal(missing.source, null);
});

test("holds nothing back: each Cell reads 'n of 20', and a Cell past 20 is not judged until the baseline is", () => {
  const ce = build({
    guard: guardOk([entry("slow-high", { n: 7, n_merged: 7 }), entry("task-high", { n: 25, n_merged: 25 }), entry("smol-high", { n: 3, n_merged: 3 })],
      { verdict: "none", baseline: { cell: "slow-high", generation: "claude-opus-5", n: 7, mean_usd: 14.9, fail_rate: 0.1 } }),
  });
  assert.equal(cellOf(ce, "slow-high").figures.merged.text, "7 of 20: not judged");
  assert.equal(cellOf(ce, "smol-high").figures.merged.text, "3 of 20: not judged");
  assert.equal(cellOf(ce, "task-high").figures.merged.text, "25 ≥ 20: not judged until slow-high has 20");
});

test("a Cell below min_n reads 'n of 20: not judged' even while the guard judges others", () => {
  const ce = build({ guard: guardOk([entry("slow-high"), entry("task-high", { n: 12, n_merged: 12 })]) });
  assert.equal(cellOf(ce, "task-high").figures.merged.text, "12 of 20: not judged");
});

// -- no cost guard: the newest receipt's metrics line ----------------------------------

const step = (status, at, output) => ({ status, at, output });
const NOGUARD = { guard: { status: "missing" } };
const noGuardNotes = (receipts) => build({ ...NOGUARD, receipts }).guard.notes.filter((n) => !/modelRoles/.test(n));

test("no cost guard: a skipped refresh is quoted with its time", () => {
  const phase0 = step("ok", "2026-10-28T08:00:00.000Z",
    "metrics-refresh.mjs ran\nmetrics-refresh: drain: nothing pending\nmetrics-refresh: cost guard: skipped, docs/metrics/member-outcomes.tsv not found — no corpus to guard yet; .fleet/cost-guard.json left as it is");
  assert.deepEqual(noGuardNotes({ phase0, closeout: null }),
    ["skipped at 2026-10-28 08:00Z: docs/metrics/member-outcomes.tsv not found — no corpus to guard yet"]);
});

test("no cost guard: a failed refresh is quoted with its time, from either receipt's wording", () => {
  const why = "pr-cost.mjs --guard exited 1: pr-cost: docs/metrics/member-outcomes.tsv: malformed row: 20 fields, expected 23";
  const phase0 = step("failed", "2026-10-28T08:00:00.000Z", `metrics-refresh.mjs failed: exit 1\nmetrics-refresh: cost guard failed: ${why}`);
  const closeout = step("failed", "2026-10-28T09:30:00.000Z", `metrics-refresh.mjs failed: metrics-refresh: drain: 0 rows from x into y (0 already there)\nmetrics-refresh: cost guard failed: ${why}`);
  assert.deepEqual(noGuardNotes({ phase0, closeout: null }), [`failed at 2026-10-28 08:00Z: ${why}`]);
  assert.deepEqual(noGuardNotes({ phase0: null, closeout }), [`failed at 2026-10-28 09:30Z: ${why}`]);
});

test("no cost guard: a refresh that failed before the guard duty is quoted by its own line, and an output with none is quoted as it stands", () => {
  const drain = step("failed", "2026-10-28T08:00:00.000Z", "metrics-refresh.mjs failed: metrics-refresh: drain failed: pending file malformed");
  assert.deepEqual(noGuardNotes({ phase0: drain, closeout: null }), ["failed at 2026-10-28 08:00Z: drain failed: pending file malformed"]);
  const bare = step("failed", "2026-10-28T08:00:00.000Z", "metrics-refresh.mjs failed: exit 1");
  assert.deepEqual(noGuardNotes({ phase0: bare, closeout: null }), ["failed at 2026-10-28 08:00Z: metrics-refresh.mjs failed: exit 1"]);
});

test("no cost guard: with both receipts, the newer metrics step is the one quoted", () => {
  const older = step("failed", "2026-10-28T08:00:00.000Z", "metrics-refresh: cost guard failed: old");
  const newer = step("ok", "2026-10-28T10:00:00.000Z", "metrics-refresh: cost guard: skipped, docs/metrics/tier-outcomes.tsv not found — no corpus to guard yet; .fleet/cost-guard.json left as it is");
  assert.match(noGuardNotes({ phase0: newer, closeout: older })[0], /^skipped at 2026-10-28 10:00Z: docs\/metrics\/tier-outcomes\.tsv/);
  assert.match(noGuardNotes({ phase0: older, closeout: newer })[0], /^skipped at 2026-10-28 10:00Z: docs\/metrics\/tier-outcomes\.tsv/);
});

test("no cost guard: with no receipt, it says so; a receipt whose metrics step has not run is not quoted as a refresh", () => {
  assert.deepEqual(noGuardNotes(NO_RECEIPTS), ["no phase 0 or close-out receipt here"]);
  assert.deepEqual(noGuardNotes({ phase0: step("pending", "2026-10-28T08:00:00.000Z", ""), closeout: null }),
    ["no metrics refresh has run in the receipts here"]);
});

test("no cost guard: a refresh that succeeded and left no guard is quoted as it ran", () => {
  const phase0 = step("ok", "2026-10-28T08:00:00.000Z", "metrics-refresh.mjs ran\nmetrics-refresh: cost guard: verdict ok, pr-cost.mjs exit 0; .fleet/cost-guard.json computed 2026-10-28T08:00:00.000Z");
  assert.deepEqual(noGuardNotes({ phase0, closeout: null }), ["ran at 2026-10-28 08:00Z: verdict ok, pr-cost.mjs exit 0; .fleet/cost-guard.json computed 2026-10-28T08:00:00.000Z"]);
});

test("no cost guard: a guard the reader refuses says why, and still quotes the refresh", () => {
  const phase0 = step("ok", "2026-10-28T08:00:00.000Z", "metrics-refresh: cost guard: skipped, docs/metrics/member-outcomes.tsv not found — no corpus to guard yet; .fleet/cost-guard.json left as it is");
  const g = build({ guard: { status: "unreadable", why: "not a guard verdict" }, receipts: { phase0, closeout: null } }).guard;
  assert.equal(g.heading, "no cost guard");
  assert.deepEqual(g.notes.filter((n) => !/modelRoles/.test(n)), [
    "cost-guard.json unreadable: not a guard verdict",
    "skipped at 2026-10-28 08:00Z: docs/metrics/member-outcomes.tsv not found — no corpus to guard yet",
  ]);
});

test("no cost guard: every Cell reads 'no figures yet for <the Tier route model>', and none of it is an alert", () => {
  const ce = build(NOGUARD);
  for (const c of ce.guard.cells) assert.equal(c.figures, null, c.cell);
  assert.equal(cellOf(ce, "slow-high").none.text, "no figures yet for claude-opus-5");
  assert.equal(cellOf(ce, "smol-high").none.text, "no figures yet for claude-haiku-5-5");
  assert.equal(cellOf(ce, "slow-high").baseline, true, "slow-high is the baseline with no guard too");
  assert.equal(ce.alerts, undefined, "this part draws no alert at all");
});

test("a guard on disk that the newest refresh did not write: the failure and the figures' age are both said", () => {
  const closeout = step("failed", "2026-10-28T09:30:00.000Z", "metrics-refresh: cost guard failed: pr-cost.mjs --guard exited 1: malformed row");
  const g = build({ receipts: { phase0: null, closeout } }).guard;
  assert.ok(g.notes.includes("the newest refresh failed at 2026-10-28 09:30Z: pr-cost.mjs --guard exited 1: malformed row; these figures are from 2026-10-26 19:17Z"), JSON.stringify(g.notes));
  assert.equal(g.heading, "trips nothing", "the figures stay");
  // A failure older than the guard is the guard's own past, not its present.
  const old = step("failed", "2026-10-25T09:30:00.000Z", "metrics-refresh: cost guard failed: x");
  assert.deepEqual(build({ receipts: { phase0: old, closeout: null } }).guard.notes, []);
});

// -- a guard that predates the new fields: 'not checked', never 0 -------------------------

test("a guard written before the per-Cell counts reads 'not checked' where each count would show, never 0", () => {
  const ce = build({
    guard: guardOk([
      { cell: "slow-high", generation: "claude-opus-5", n: 40, mean_usd: 14.9, fail_rate: 0.1, untimed: 0 },
      { cell: "task-high", generation: "claude-sonnet-5-5", n: 30, mean_usd: 10.2, fail_rate: 0.2174, untimed: 2 },
    ], { baseline: { cell: "slow-high", generation: "claude-opus-5", n: 40, mean_usd: 14.9, fail_rate: 0.1 }, trip_points: undefined, window_start: undefined }),
  });
  const g = ce.guard;
  assert.match(g.source, /window: not checked · min 20 merged PRs · floor: not checked$/);
  assert.ok(g.notes.some((n) => /^not checked: this guard predates the claim counts, failure counts, by-hand count, left-out count, pending count, no-Admissible-row count, unpriced count/.test(n)), JSON.stringify(g.notes));

  const task = cellOf(ce, "task-high").figures;
  assert.equal(task.failRate.text, "21.7% · gap and floor: not checked");
  assert.deepEqual(task.failRate.beside, ["Rulings given by hand: not checked"]);
  assert.deepEqual(task.merged.beside, ["left out, pending, no Admissible row, unpriced: not checked"]);
  assert.deepEqual(task.merged.marks, ["¹"], "untimed is there and non-zero: it still gets its footnote");
  assert.equal(task.usd.text, "$10.20 · −31.5% on slow-high");
  assert.equal(task.failRate.beside.concat(task.merged.beside).some((w) => /\b0\b/.test(w)), false);
});

// -- the figures, worked from counts ---------------------------------------------------------

test("a fail-rate gap is worked from the claim and failure counts, not from rounded rates", () => {
  // 1 of 3 is 33.3% and 2 of 7 is 28.6%: the rounded rates differ by 4.7, the counts by 4.76.
  const ce = build({
    guard: guardOk([entry("slow-high", { n_claims: 7, n_failed: 2 }), entry("task-high", { n_claims: 3, n_failed: 1 })],
      { baseline: { cell: "slow-high", generation: "claude-opus-5", n: 69, mean_usd: 14.9, fail_rate: 0.2857 } }),
  });
  assert.equal(cellOf(ce, "task-high").figures.failRate.text, "33.3% · +4.8 pts on slow-high · 10.2 pts inside the floor");
  assert.equal(cellOf(ce, "slow-high").figures.failRate.text, "28.6% · the floor is 43.6%");
});

test("a cell cheaper in failures reads a minus; one exactly at the floor reads past it, as the guard rules", () => {
  const better = build({ guard: guardOk([entry("slow-high", { n_claims: 20, n_failed: 4 }), entry("task-high", { n_claims: 20, n_failed: 1 })]) });
  assert.equal(cellOf(better, "task-high").figures.failRate.text, "5.0% · −15.0 pts on slow-high · 30.0 pts inside the floor");
  const edge = build({ guard: guardOk([entry("slow-high", { n_claims: 20, n_failed: 0 }), entry("task-high", { n_claims: 20, n_failed: 3 })]) });
  assert.equal(cellOf(edge, "task-high").figures.failRate.text, "15.0% · +15.0 pts on slow-high · 0.0 pts past the floor");
  const past = build({ guard: guardOk([entry("slow-high", { n_claims: 20, n_failed: 0 }), entry("task-high", { n_claims: 20, n_failed: 5 })]) });
  assert.equal(cellOf(past, "task-high").figures.failRate.text, "25.0% · +25.0 pts on slow-high · 10.0 pts past the floor");
});

test("no claims is not a 0% fail rate", () => {
  const ce = build({ guard: guardOk([entry("slow-high"), entry("task-high", { n_claims: 0, n_failed: 0, fail_rate: null }),
    entry("smol-high", { n_claims: 5, n_failed: 1 })], {}) });
  assert.equal(cellOf(ce, "task-high").figures.failRate.text, "no fail rate yet: no claims");
  const noBase = build({ guard: guardOk([entry("slow-high", { n_claims: 0, n_failed: 0, fail_rate: null }), entry("smol-high", { n_claims: 5, n_failed: 1 })]) });
  assert.equal(cellOf(noBase, "smol-high").figures.failRate.text, "20.0% · no gap: slow-high has no claims");
  assert.equal(cellOf(noBase, "slow-high").figures.failRate.text, "no fail rate yet: no claims");
});

test("$ per merged PR reads against the baseline's, and no merged PR is not $0", () => {
  const ce = build({ guard: guardOk([entry("slow-high"), entry("task-high", { mean_usd: 20.0 }), entry("smol-high", { mean_usd: null, n: 0, n_merged: 0 })]) });
  assert.equal(cellOf(ce, "task-high").figures.usd.text, "$20.00 · +34.2% on slow-high");
  assert.equal(cellOf(ce, "smol-high").figures.usd.text, "no merged PR yet: no $ per merged PR");
});

test("a gap on an exact half rounds away from zero, a minus as a plus", () => {
  // 27 of 48 against 1 of 1 is −43.75 pts; 21 of 48 against 0 of 1 is +43.75.
  const minus = build({ guard: guardOk([entry("slow-high", { n_claims: 1, n_failed: 1 }), entry("task-high", { n_claims: 48, n_failed: 27 })]) });
  assert.equal(cellOf(minus, "task-high").figures.failRate.text, "56.3% · −43.8 pts on slow-high · 58.8 pts inside the floor");
  const plus = build({ guard: guardOk([entry("slow-high", { n_claims: 1, n_failed: 0 }), entry("task-high", { n_claims: 48, n_failed: 21 })]) });
  assert.equal(cellOf(plus, "task-high").figures.failRate.text, "43.8% · +43.8 pts on slow-high · 28.8 pts past the floor");
});

test("no difference from the baseline reads +0.0, never a minus", () => {
  const ce = build({ guard: guardOk([entry("slow-high"), entry("task-high")]) });
  assert.equal(cellOf(ce, "task-high").figures.failRate.text, "11.6% · +0.0 pts on slow-high · 15.0 pts inside the floor");
  assert.equal(cellOf(ce, "task-high").figures.usd.text, "$14.90 · +0.0% on slow-high");
});

test("a count that is no count (negative or absent) works no gap: the stored rate shows, gap and floor not checked", () => {
  for (const o of [{ n_failed: -3 }, { n_claims: undefined }]) {
    const ce = build({ guard: guardOk([entry("slow-high"), entry("task-high", o)]) });
    assert.equal(cellOf(ce, "task-high").figures.failRate.text, "11.6% · gap and floor: not checked", JSON.stringify(o));
  }
  const noBaseCounts = build({ guard: guardOk([entry("slow-high", { n_claims: undefined }), entry("task-high")]) });
  assert.equal(cellOf(noBaseCounts, "task-high").figures.failRate.text, "11.6% · gap: not checked: slow-high has no counts");
});

test("a baseline $ per merged PR that is no number is no comparison, not a figure", () => {
  const ce = build({ guard: guardOk([entry("slow-high"), entry("task-high")],
    { baseline: { cell: "slow-high", generation: "claude-opus-5", n: 69, mean_usd: "14.9", fail_rate: 0.1159 } }) });
  assert.equal(cellOf(ce, "task-high").figures.usd.text, "$14.90 · no comparison: slow-high has no $ per merged PR");
});

test("an older generation: its stored rate where it has claims but no failures counted; one that names no generation is left out", () => {
  const ce = build({ guard: guardOk([entry("slow-high", {
    older: [null, { generation: 5 }, { generation: "" }, { generation: "claude-opus-4", n_claims: 10, fail_rate: 0.3 }],
  })]) });
  assert.deepEqual(cellOf(ce, "slow-high").older.map((o) => [o.generation, o.failRate]), [["claude-opus-4", "30.0%"]]);
});

test("a computed_at that is no time is quoted as it came in the source line", () => {
  const ce = build({ guard: guardOk([entry("slow-high")], { computed_at: "garbage" }) });
  assert.match(ce.guard.source, / · computed garbage · /);
});

test("left out and pending sit beside n when k > 0, and only then", () => {
  const ce = build({ guard: guardOk([entry("slow-high", { left_out: 2, pending: 3 }), entry("task-high", { left_out: 0, pending: 4 })]) });
  assert.deepEqual(cellOf(ce, "slow-high").figures.merged.beside, ["2 left out", "3 pending"]);
  assert.deepEqual(cellOf(ce, "task-high").figures.merged.beside, ["4 pending"]);
  assert.deepEqual(cellOf(build(), "slow-high").figures.merged.beside, []);
});

test("Rulings given by hand: 'k of n' beside the fail rate when k > 0, nothing when 0", () => {
  const ce = build({ guard: guardOk([entry("slow-high", { by_hand: 0 }), entry("task-high", { by_hand: 1, n: 12, n_merged: 12 })]) });
  assert.deepEqual(cellOf(ce, "slow-high").figures.failRate.beside, []);
  assert.deepEqual(cellOf(ce, "task-high").figures.failRate.beside, ["1 of 12 Rulings given by hand"]);
});

test("no Admissible row, unpriced and untimed are footnotes: a mark on n, a sentence under the section", () => {
  const ce = build();
  assert.deepEqual(cellOf(ce, "task-high").figures.merged.marks, ["¹"]);
  assert.deepEqual(cellOf(ce, "smol-high").figures.merged.marks, ["²", "³"]);
  assert.deepEqual(cellOf(ce, "slow-high").figures.merged.marks, []);
  assert.deepEqual(ce.guard.footnotes, [
    { mark: "¹", text: "task-high: 1 drawn here have no Admissible row: they ran under another Cell, at another effort, or with no model on record, so they count in no Cell's figures" },
    { mark: "²", text: "smol-high: 5 drawn here have no Admissible row: they ran under another Cell, at another effort, or with no model on record, so they count in no Cell's figures" },
    { mark: "³", text: "smol-high: 1 unpriced: part of their Spend can't be booked" },
  ]);
  const untimed = build({ guard: guardOk([entry("slow-high", { untimed: 4 })]) }).guard.footnotes;
  assert.deepEqual(untimed, [{ mark: "¹", text: "slow-high: 4 untimed: a member's work time isn't on record" }]);
});

// -- older generations ---------------------------------------------------------------------

test("older generations sit nested under their Cell, marked not judged, each with its own anchor", () => {
  const older = [
    { generation: "claude-opus-4-9", n_merged: 30, n_claims: 30, n_failed: 3, fail_rate: 0.1, mean_usd: 18.5, unpriced: 0 },
    { generation: "claude-opus-4-8", n_merged: 9, n_claims: 0, n_failed: 0, fail_rate: null, mean_usd: null },
  ];
  const ce = build({ guard: guardOk([entry("slow-high", { older })]) });
  assert.deepEqual(cellOf(ce, "slow-high").older, [
    { generation: "claude-opus-4-9", anchor: "cell-slow-high@claude-opus-4-9", mark: "not judged", merged: "30 merged PRs", failRate: "10.0%", usd: "$18.50" },
    { generation: "claude-opus-4-8", anchor: "cell-slow-high@claude-opus-4-8", mark: "not judged", merged: "9 merged PRs", failRate: "no fail rate yet", usd: "no $ per merged PR" },
  ]);
  assert.equal(cellOf(ce, "slow-high").figures.generation, "claude-opus-5", "the newest stays the one judged");
});

// -- the Tier route and its labels ---------------------------------------------------------------

test("a Tier route that differs from the judged generation carries the flag, and the two names both show", () => {
  const roles = { ...ROLES, value: { ...ROLES.value, task: "anthropic/claude-sonnet-5-6:high" } };
  const ce = build({ modelRoles: roles });
  const task = cellOf(ce, "task-high");
  assert.equal(task.judged, "judged on claude-sonnet-5-5");
  assert.equal(task.route.text, "Tier route: anthropic/claude-sonnet-5-6 · high");
  assert.equal(task.route.flag, "⚑ differs from the judged generation");
  assert.equal(cellOf(ce, "slow-high").route.flag, null);
});

test("the match is exact apart from the provider prefix: claude-opus-5.5 is not claude-opus-5-5", () => {
  const roles = { ...ROLES, value: { ...ROLES.value, slow: "anthropic/claude-opus-5.5:high" } };
  const ce = build({ modelRoles: roles, guard: guardOk([entry("slow-high", { generation: "claude-opus-5-5" })]) });
  assert.equal(cellOf(ce, "slow-high").route.flag, "⚑ differs from the judged generation");
  const same = build({ modelRoles: { ...ROLES, value: { ...ROLES.value, slow: "claude-opus-5" } } });
  assert.equal(cellOf(same, "slow-high").route.flag, null, "a role written without its provider prefix still matches");
});

test("an unset model role reads so, and that Cell's comparison is 'not checked'", () => {
  const roles = { ...ROLES, value: { slow: "anthropic/claude-opus-5:high", smol: "anthropic/claude-haiku-5-5:auto" } };
  const ce = build({ modelRoles: roles });
  const task = cellOf(ce, "task-high");
  assert.equal(task.route.text, "modelRoles.task unset: omp picks the model");
  assert.equal(task.route.flag, "not checked");
  assert.equal(cellOf(ce, "task-max").none.text, "no figures yet for task-max", "no Tier route model to name: the Cell is named");
  assert.equal(cellOf(ce, "task-max").none.anchor, null);
});

test("a failing modelRoles read keeps the carried value and says 'as read at <time>; reading fails: <why>'", () => {
  const roles = { ...ROLES, error: { at: Date.UTC(2026, 9, 28, 9, 5), message: "omp config get modelRoles --json failed (ENOENT)" } };
  const ce = build({ modelRoles: roles });
  const words = "as read at 2026-10-28 09:00Z; reading fails: omp config get modelRoles --json failed (ENOENT)";
  assert.equal(cellOf(ce, "slow-high").route.label, words);
  assert.equal(cellOf(ce, "slow-high").route.text, "Tier route: anthropic/claude-opus-5 · high", "the carried value still shows");
  assert.ok(ce.guard.notes.includes(words), "and the heading carries it once");
  assert.equal(build().guard.notes.length, 0, "a read that stands says nothing");
});

test("modelRoles never read: 'not checked', with why, and a read that failed with nothing carried says that too", () => {
  const ce = build({ modelRoles: null });
  assert.equal(cellOf(ce, "slow-high").route.text, "Tier route: not checked");
  assert.equal(cellOf(ce, "slow-high").route.label, "not checked: modelRoles not read yet");
  assert.equal(cellOf(ce, "slow-high").route.flag, null);
  assert.equal(cellOf(ce, "task-max").none.text, "no figures yet for task-max");
  const failed = build({ modelRoles: { value: null, readAt: null, error: { at: 1, message: "boom" } } });
  assert.equal(cellOf(failed, "slow-high").route.label, "not checked: modelRoles not read yet; reading fails: boom");
});

// -- Declared, not measured ----------------------------------------------------------------------

test("Declared, not measured lists every other member: its Declared tier and its Tier route model · level", () => {
  const d = build().declared;
  assert.equal(d.heading, "Declared, not measured: 2 other members");
  assert.deepEqual(d.members, [
    { name: "fleet-finisher", declared: "@slow:high", route: "anthropic/claude-opus-5 · high" },
    { name: "fleet-review-types", declared: "@smol:medium", route: "anthropic/claude-haiku-5-5 · medium" },
  ]);
});

test("Declared, not measured counts the real definitions: the plugin's own, minus the five Cells", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { parseFrontmatter } = await import("../plugin/scripts/tier-roles.mjs");
  const dir = new URL("../plugin/agents/", import.meta.url);
  const list = readdirSync(dir).filter((f) => f.endsWith(".agent.md")).map((file) => ({ file, model: parseFrontmatter(readFileSync(new URL(file, dir), "utf8")).model }));
  const d = computeCellEvidence({ guard: { status: "missing" }, receipts: NO_RECEIPTS, agents: { list, error: null }, modelRoles: ROLES }).declared;
  assert.equal(d.members.length, list.length - 5);
  assert.equal(d.heading, `Declared, not measured: ${list.length - 5} other members`);
  assert.ok(d.members.every((m) => !m.name.startsWith("fleet-implementer-")));
  assert.ok(d.members.every((m) => /^@(slow|task|smol):\w+$/.test(m.declared) && / · /.test(m.route)), JSON.stringify(d.members.find((m) => !/ · /.test(m.route))));
});

test("Declared, not measured: one member reads singular; unset roles, odd tiers and an unread modelRoles read as such", () => {
  const agents = { list: [{ file: "fleet-a.agent.md", model: '"@task:high"' }], error: null };
  assert.equal(build({ agents }).declared.heading, "Declared, not measured: 1 other member");
  const odd = { list: [{ file: "fleet-a.agent.md", model: '"@task:high"' }, { file: "fleet-b.agent.md", model: "opus" }, { file: "fleet-c.agent.md", model: null }], error: null };
  const unset = build({ agents: odd, modelRoles: { ...ROLES, value: { slow: "x/y:high" } } }).declared.members;
  assert.deepEqual(unset.map((m) => m.route), ["modelRoles.task unset: omp picks the model", "Declared tier is not a route", "no Declared tier"]);
  assert.deepEqual(build({ agents: odd, modelRoles: null }).declared.members.map((m) => m.route), ["not checked", "Declared tier is not a route", "no Declared tier"]);
});

test("Declared, not measured: definitions that could not be listed are not 0 members", () => {
  const d = build({ agents: { list: [], error: "/x/agents: ENOENT" } }).declared;
  assert.equal(d.heading, "Declared, not measured: the definitions could not be read: /x/agents: ENOENT");
  assert.deepEqual(d.members, []);
});

// -- the real writer's file, through the tick's reader ----------------------------------------------

test("figures show from the file pr-cost.mjs writes, as the tick's reader accepts it", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const report = {
    window_start: "2026-10-03", baseline: { cell: "slow-high", generation: "claude-opus-5", n: 20, mean_usd: 10, fail_rate: 0.1 },
    cells: [
      { cell: "slow-high", generation: "claude-opus-5", n_pulls: 20, n_merged: 20, n_claims: 20, n_failed: 2, fail_rate: 0.1, mean_usd: 10, median_usd: 10, by_hand: 4, no_ruling: 0, pending: 1, router_usd: 0, usd_diff_ci95: null, left_out: 0, unpriced: 0, untimed: 0, excluded: 0, older: [] },
    ],
    tripped: [], verdict: "ok", retire: false,
  };
  const path = join(mkdtempSync(join(tmpdir(), "cell-evidence-")), "cost-guard.json");
  writeFileSync(path, JSON.stringify(guardFile(report, "2026-10-28T08:00:00.000Z", { "docs/metrics/x.tsv": "ab" })));
  const read = readCostGuard(path);
  assert.equal(read.status, "ok");
  const ce = build({ guard: read });
  assert.equal(cellOf(ce, "slow-high").figures.merged.text, "20 ≥ 20 ✓");
  assert.deepEqual(cellOf(ce, "slow-high").figures.merged.beside, ["1 pending"]);
  assert.equal(cellOf(ce, "slow-high").figures.failRate.text, "10.0% · the floor is 25.0%");
  assert.deepEqual(ce.guard.notes, [], "a complete guard needs no 'not checked'");
});

// -- policy rows: what routes now, row by row ----------------------------------------------------

const { readFileSync } = await import("node:fs");
const { policyRowsView, repoIdentity } = await import("../plugin/scripts/compute-cell-evidence.mjs");
const SHIPPED = JSON.parse(readFileSync(new URL("../plugin/scripts/router-table.json", import.meta.url), "utf8"));
const INSTALL = { name: "@feigi/fleet-ctl", version: "3.104.0", repository: "git+https://github.com/feigi/fleet-plugin.git", error: null };
const HERE = "https://github.com/feigi/fleet-plugin";
const FIVE = ["slow-high", "task-high", "smol-high", "slow-medium", "task-max"];

// A table fitted on 198 Pulls, in stage 2, short of the two effort Cells: heavy has a row of its own.
const FITTED = (o = {}) => ({
  window_start: "2026-10-03", fitted_commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", n_rows: 198, stage: 2, cells: FIVE, burn_in: true,
  rows: { cost: { "*": "slow-high", heavy: "task-high" }, speed: { "*": "slow-high", heavy: "task-high" } },
  classifier: { b: null, tau: null },
  estimates: {
    "*": { "slow-high": { generation: "claude-opus-5", merged: 69 }, "task-high": { generation: "claude-sonnet-5-5", merged: 60 }, "smol-high": { generation: "claude-haiku-5-5", merged: 12 } },
    heavy: { "slow-high": { generation: "claude-opus-5", merged: 40 }, "task-high": { generation: "claude-sonnet-5-5", merged: 31 } },
  },
  reasons: {
    cost: {
      "*": { cell: "slow-high", reason: "no-qualifier", cells: { "task-high": { verdict: "not-reliably-cheaper", range: [-1.25, 0.5] }, "smol-high": { verdict: "too-few", range: null } }, pairs: [] },
      heavy: { cell: "task-high", reason: "sole-qualifier", cells: { "task-high": { verdict: "qualifies", range: [-4.2, -1.1] } }, pairs: [] },
    },
    speed: {
      "*": { cell: "slow-high", reason: "no-qualifier", cells: { "task-high": { verdict: "not-reliably-faster", range: [-12, 3.25] } }, pairs: [] },
      heavy: { cell: "task-high", reason: "unjudged", cells: {}, pairs: [] },
    },
  },
  guard: { tripped: [], n: { "slow-high": 69, "task-high": 69, "smol-high": 32, "slow-medium": 0, "task-max": 0 } },
  ...o,
});
const policy = (o = {}) => computeCellEvidence({ guard: TODAY(), receipts: NO_RECEIPTS, agents: AGENTS, modelRoles: ROLES, table: SHIPPED, install: INSTALL, repoUrl: HERE, ...o }).policy;
const sideOf = (p) => p.sides[0];
const lineOf = (p, objective, stratum) => p.objectives.find((o) => o.objective === objective).lines.find((l) => l.stratum === stratum);

test("today's installed table: this repository's runs, never fitted, every Pull drawn over 3 Cells, every row unjudged slow-high", () => {
  const p = policy();
  const s = sideOf(p);
  assert.equal(s.title, "routes now");
  assert.equal(s.source.text, "this repository's runs · never fitted · @feigi/fleet-ctl 3.104.0");
  assert.equal(s.source.check, null);
  assert.equal(s.heading, "never fitted: every Pull drawn over 3 Cells");
  assert.equal(s.dispatch, "drawn over 3 Cells: slow-high, task-high, smol-high");
  assert.deepEqual(s.footnotes, []);
  for (const o of ["cost", "speed"]) {
    const star = lineOf(p, o, "*").sides[0];
    assert.deepEqual([star.cell, star.reason, star.dispatch, star.held, star.candidates], ["slow-high", "unjudged", null, null, []], o);
  }
});

test("a checkout's 0.0.0 reads linked checkout, a published version its number", () => {
  assert.equal(sideOf(policy({ install: { ...INSTALL, version: "0.0.0" } })).source.text, "this repository's runs · never fitted · @feigi/fleet-ctl linked checkout");
});

test("a fitted table names its commit to 7 characters and its Pulls", () => {
  assert.equal(sideOf(policy({ table: FITTED(), install: { ...INSTALL, version: "3.105.0" } })).source.text,
    "this repository's runs · fitted at 1a2b3c4 on 198 Pulls · @feigi/fleet-ctl 3.105.0");
  assert.match(sideOf(policy({ table: FITTED({ n_rows: 1 }) })).source.text, /on 1 Pull ·/);
});

test("a consumer — install repository ≠ workspace repo, enterprise host — reads <owner/name>'s runs, with the footnote", () => {
  const s = sideOf(policy({ repoUrl: "https://ghe.example.com/acme/widgets" }));
  assert.equal(s.source.text, "feigi/fleet-plugin's runs · never fitted · @feigi/fleet-ctl 3.104.0 ¹");
  assert.equal(s.source.check, null);
  assert.deepEqual(s.footnotes, [{ mark: "¹", text: "this repository's runs reach routing only through its cost guard, which can hold a Cell back but never picks one" }]);
});

test("the same owner/name on another host is another repository's table, never this one", () => {
  assert.equal(sideOf(policy({ repoUrl: "https://ghe.example.com/feigi/fleet-plugin" })).source.text.split(" · ")[0], "feigi/fleet-plugin's runs");
  assert.equal(sideOf(policy({ repoUrl: "https://github.com/someone-else/fleet-plugin" })).source.text.split(" · ")[0], "feigi/fleet-plugin's runs");
  assert.equal(sideOf(policy({ repoUrl: "https://GitHub.com/Feigi/Fleet-Plugin" })).source.text.split(" · ")[0], "this repository's runs", "host and owner/name compare without case");
});

test("an install naming no repository reads another repository's runs, and the comparison is not checked", () => {
  for (const repository of [null, "", "not a url", "https://github.com/only-owner"]) {
    const s = sideOf(policy({ install: { ...INSTALL, repository } }));
    assert.equal(s.source.text, "another repository's runs · never fitted · @feigi/fleet-ctl 3.104.0 ¹", JSON.stringify(repository));
    assert.equal(s.source.check, "not checked: the install names no repository");
    assert.equal(s.footnotes.length, 1);
  }
  assert.equal(sideOf(policy({ install: { ...INSTALL, repository: null }, table: FITTED() })).heading.split(":")[0], "stage 2 at its fit on another repository's runs");
});

test("a workspace whose repository is not known is not compared", () => {
  const s = sideOf(policy({ repoUrl: null }));
  assert.equal(s.source.text.split(" · ")[0], "feigi/fleet-plugin's runs");
  assert.equal(s.source.check, "not checked: this workspace's repository is not known");
});

test("an install that could not be read says so, where its name and version would be, and the comparison says why it is not checked", () => {
  const unread = sideOf(policy({ install: { name: null, version: null, repository: null, error: "/x/package.json: ENOENT" } }));
  assert.equal(unread.source.text, "another repository's runs · never fitted · install not read: /x/package.json: ENOENT ¹");
  assert.equal(unread.source.check, "not checked: the install was not read");
  const none = sideOf(policy({ install: null }));
  assert.equal(none.source.text.split(" · ")[2], "install not read ¹");
  assert.equal(none.source.check, "not checked: the install was not read");
});

test("repoIdentity reads the shapes a package.json repository takes", () => {
  const want = { host: "github.com", name: "feigi/fleet-plugin" };
  for (const u of ["git+https://github.com/feigi/fleet-plugin.git", "https://github.com/feigi/fleet-plugin", "https://github.com/feigi/fleet-plugin/", "git://github.com/feigi/fleet-plugin.git",
    "git@github.com:feigi/fleet-plugin.git", "ssh://git@github.com/feigi/fleet-plugin.git", "github:feigi/fleet-plugin", "feigi/fleet-plugin", "https://github.com/feigi/fleet-plugin/tree/main/plugin"]) {
    assert.deepEqual(repoIdentity(u), want, u);
  }
  assert.deepEqual(repoIdentity("git+ssh://git@ghe.example.com/acme/widgets.git"), { host: "ghe.example.com", name: "acme/widgets" });
  assert.deepEqual(repoIdentity("git@GitHub.com:feigi/fleet-plugin.git"), want, "an scp host compares without case");
  assert.deepEqual(repoIdentity("gitlab:acme/widgets"), { host: "gitlab.com", name: "acme/widgets" });
  assert.deepEqual(repoIdentity("bitbucket:acme/widgets"), { host: "bitbucket.org", name: "acme/widgets" });
  assert.deepEqual(repoIdentity("bitbucket:acme/widgets"), repoIdentity("https://bitbucket.org/acme/widgets"), "the bitbucket shorthand is bitbucket.org's");
  for (const u of [null, undefined, 3, "", "nope", "https://github.com/owner"]) assert.equal(repoIdentity(u), null, String(u));
});

test("repoIdentity drops a ref pin and a www. host, and refuses a relative path", () => {
  const want = { host: "github.com", name: "feigi/fleet-plugin" };
  for (const u of ["github:feigi/fleet-plugin#main", "feigi/fleet-plugin#main", "git+https://github.com/feigi/fleet-plugin.git#v1", "git@github.com:feigi/fleet-plugin.git#v1", "https://www.github.com/feigi/fleet-plugin"]) {
    assert.deepEqual(repoIdentity(u), want, u);
  }
  for (const u of ["../x", "./x", "x/..", "https://github.com/o/.git"]) assert.equal(repoIdentity(u), null, u);
});

test("burn-in, fitted: the counts are the table's own, past tense, naming whose runs; a consumer adds what ends it", () => {
  const here = sideOf(policy({ table: FITTED() }));
  assert.equal(here.heading, "stage 2 at its fit on feigi/fleet-plugin's runs: slow-medium and task-max had 0 of the 20 merged PRs each needs; every Pull drawn over 5 Cells");
  const consumer = sideOf(policy({ table: FITTED(), repoUrl: "https://ghe.example.com/acme/widgets" }));
  assert.equal(consumer.heading, `${here.heading}; it ends with a later fit, reaching this install with a plugin release`);
});

test("burn-in, fitted: Cells short by different counts are each named, one short is 'it needs'", () => {
  const n = { "slow-high": 69, "task-high": 69, "smol-high": 32, "slow-medium": 3, "task-max": 0 };
  assert.match(sideOf(policy({ table: FITTED({ guard: { tripped: [], n } }) })).heading, /: slow-medium had 3 and task-max had 0 of the 20 merged PRs each needs;/);
  const one = { ...n, "slow-medium": 20, "task-max": 20, "smol-high": 7 };
  assert.match(sideOf(policy({ table: FITTED({ stage: 1, guard: { tripped: [], n: one } }) })).heading, /^stage 1 at its fit on .*: smol-high had 7 of the 20 merged PRs it needs;/);
});

test("K counts the Cells the draw uses under the guard: a tripped Cell is not one, and none left is no draw", () => {
  const tripped = (cells) => guardOk(TODAY().guard.cells, { verdict: "tripped", tripped: cells });
  assert.equal(sideOf(policy({ guard: tripped(["smol-high"]) })).heading, "never fitted: every Pull drawn over 2 Cells");
  assert.equal(sideOf(policy({ guard: tripped(["smol-high"]) })).dispatch, "drawn over 2 Cells: slow-high, task-high");
  assert.equal(sideOf(policy({ guard: tripped(["slow-high", "task-high", "smol-high"]) })).heading, "never fitted: no Cell is left to draw, so every Pull runs at its row's Cell");
});

test("no cost guard: every Pull runs at slow-high, whatever the table says, and every row dispatches alike", () => {
  for (const guard of [{ status: "missing" }, { status: "unreadable", why: "not JSON" }]) {
    const p = policy({ guard, table: FITTED({ burn_in: false }) });
    const s = sideOf(p);
    assert.equal(s.heading, "no cost guard: every Pull runs at slow-high, the default Cell");
    assert.equal(s.dispatch, "slow-high only");
    const heavy = lineOf(p, "cost", "heavy").sides[0];
    assert.deepEqual([heavy.cell, heavy.held, heavy.dispatch], ["slow-high", "task-high held: no cost guard", null]);
  }
});

test("a guard readCostGuard accepts and the router's readGuard refuses routes as no guard, as route itself would", () => {
  // A Cell that is no `<role>-<level>` token can be tripped for readCostGuard; readGuard refuses the file.
  const odd = guardOk([...TODAY().guard.cells, entry("odd")], { verdict: "tripped", tripped: ["odd"] });
  assert.equal(sideOf(policy({ guard: odd })).heading, "no cost guard: every Pull runs at slow-high, the default Cell");
});

test("verdict none holds nothing back: the table is the dispatch", () => {
  const none = guardOk(TODAY().guard.cells, { verdict: "none" });
  const p = policy({ guard: none, table: FITTED({ burn_in: false }) });
  assert.equal(sideOf(p).heading, null, "no burn-in, no guard heading");
  assert.equal(sideOf(p).dispatch, "the row's Cell; every 5th Pull drawn over the rest");
  assert.equal(lineOf(p, "cost", "heavy").sides[0].cell, "task-high");
});

test("per-row exceptions: a tripped row Cell replaced by slow-high shows on its row, the shared dispatch in the heading", () => {
  const tripped = guardOk(TODAY().guard.cells, { verdict: "tripped", tripped: ["task-high"] });
  const p = policy({ guard: tripped, table: FITTED({ burn_in: false }) });
  assert.equal(sideOf(p).dispatch, "the row's Cell; every 5th Pull drawn over the rest");
  const heavy = lineOf(p, "cost", "heavy").sides[0];
  assert.deepEqual([heavy.cell, heavy.held, heavy.dispatch], ["slow-high", "task-high tripped", "slow-high, the row's task-high tripped; every 5th Pull drawn over the rest"]);
  const star = lineOf(p, "cost", "*").sides[0];
  assert.equal(star.dispatch, null, "a row that dispatches like the rest names no dispatch of its own");
  assert.equal(lineOf(p, "speed", "heavy").sides[0].dispatch, heavy.dispatch, "under both Objectives");
});

test("per-row exceptions in burn-in: a tripped row Cell keeps the draw and names what the policy Cell became", () => {
  const tripped = guardOk(TODAY().guard.cells, { verdict: "tripped", tripped: ["task-high"] });
  const p = policy({ guard: tripped, table: FITTED() });
  assert.equal(sideOf(p).dispatch, "drawn over 4 Cells: slow-high, smol-high, slow-medium, task-max");
  assert.equal(lineOf(p, "cost", "heavy").sides[0].dispatch, "drawn over 4 Cells: slow-high, smol-high, slow-medium, task-max; the row's task-high tripped, so its policy Cell is slow-high");
});

test("collapsed Strata: one with no row on any side is one line under its Objective; one with a row of its own keeps it", () => {
  const p = policy({ table: FITTED() });
  for (const o of ["cost", "speed"]) {
    assert.deepEqual(p.objectives.find((x) => x.objective === o).lines.map((l) => l.stratum), ["*", "light", "heavy", "unknown"], o);
    assert.equal(lineOf(p, o, "light").collapsed, "light: no row, follows *", o);
    assert.equal(lineOf(p, o, "unknown").collapsed, "unknown: no row, follows *", o);
    assert.equal(lineOf(p, o, "heavy").collapsed, undefined, o);
    assert.equal(lineOf(p, o, "heavy").sides[0].cell, "task-high", o);
  }
});

test("collapsing and keeping rows across two sides: a Stratum only one side lacks keeps its row, and that side reads 'no row of its own: follows *'", () => {
  const side = (title, rows) => ({ title, source: { text: title, check: null }, heading: null, footnotes: [], rows });
  const entry = (cell) => ({ cell, held: null, reason: "r", dispatch: "d", candidates: [] });
  const none = { cost: { "*": entry("slow-high") }, speed: { "*": entry("slow-high") } };
  const left = { cost: { "*": entry("slow-high"), heavy: entry("task-high") }, speed: { "*": entry("slow-high") } };
  const v = policyRowsView({ sides: [side("a", left), side("b", none)] });
  const line = (o, s) => v.objectives.find((x) => x.objective === o).lines.find((l) => l.stratum === s);
  assert.equal(line("cost", "light").collapsed, "light: no row on either side, follows *");
  assert.equal(line("speed", "heavy").collapsed, "heavy: no row on either side, follows *");
  assert.equal(line("cost", "heavy").collapsed, undefined);
  assert.equal(line("cost", "heavy").sides[0].cell, "task-high");
  assert.deepEqual(line("cost", "heavy").sides[1], { follows: "no row of its own: follows *" });
  assert.deepEqual(line("cost", "*").sides.map((s) => s.cell), ["slow-high", "slow-high"]);
});

test("the live run's Objective is marked, and between runs nothing is", () => {
  assert.deepEqual(policy({ objective: "speed" }).objectives.map((o) => [o.objective, o.live]), [["cost", false], ["speed", true]]);
  assert.deepEqual(policy({ objective: "cost" }).objectives.map((o) => [o.objective, o.live]), [["cost", true], ["speed", false]]);
  assert.deepEqual(policy().objectives.map((o) => o.live), [false, false]);
});

test("each candidate shows its n, verdict and 95% interval, in dollars under cost and minutes under speed", () => {
  const p = policy({ table: FITTED() });
  assert.deepEqual(lineOf(p, "cost", "*").sides[0].candidates.map((c) => [c.cell, c.n, c.verdict, c.interval]), [
    ["task-high", 60, "not-reliably-cheaper", "95% interval [−$1.25, $0.50]"],
    ["smol-high", 12, "too-few", "no 95% interval"],
  ]);
  assert.equal(lineOf(p, "cost", "heavy").sides[0].candidates[0].interval, "95% interval [−$4.20, −$1.10]");
  assert.equal(lineOf(p, "speed", "*").sides[0].candidates[0].interval, "95% interval [−12.0 min, 3.3 min]");
  assert.equal(lineOf(p, "cost", "*").sides[0].reason, "no-qualifier");
  assert.equal(lineOf(p, "speed", "heavy").sides[0].reason, "unjudged");
});

test("a candidate whose estimate carries no count shows its n as not checked, never a measured-looking 0", () => {
  for (const merged of ["12", -1, 1.5, null, undefined]) {
    const p = policy({ table: FITTED({ estimates: { "*": { "task-high": { generation: "claude-sonnet-5-5", merged } } } }) });
    assert.equal(lineOf(p, "cost", "*").sides[0].candidates.find((c) => c.cell === "task-high").n, null, JSON.stringify(merged));
  }
  assert.equal(lineOf(policy({ table: FITTED({ estimates: {} }) }), "cost", "*").sides[0].candidates[0].n, null, "no estimate at all");
});

test("a row with no estimate names no generation and carries no flag", () => {
  const p = policy({ table: FITTED({ estimates: {} }) });
  for (const c of lineOf(p, "cost", "*").sides[0].candidates) assert.equal(c.model, null, c.cell);
  assert.equal(sideOf(p).modelLine, null);
  assert.equal(sideOf(policy()).modelLine, null, "an unfitted table has no estimates at all");
});

test("model names: a candidate's judged generation against its Cell's Tier route model, named only where they differ", () => {
  const roles = { ...ROLES, value: { ...ROLES.value, task: "anthropic/claude-sonnet-5-6:high" } };
  const p = policy({ table: FITTED(), modelRoles: roles });
  const [task, smol] = lineOf(p, "cost", "*").sides[0].candidates;
  assert.deepEqual(task.model, { state: "differs", generation: "claude-sonnet-5-5", text: "judged on claude-sonnet-5-5; task-high runs anthropic/claude-sonnet-5-6 here" });
  assert.deepEqual(smol.model, { state: "same", generation: "claude-haiku-5-5", text: null }, "an exact match apart from the provider prefix names nothing");
  assert.equal(sideOf(p).modelLine, null, "one candidate agrees, so the difference stays on its candidate");
});

test("model names: exact match — claude-opus-5.5 is not claude-opus-5-5, and both names show", () => {
  const roles = { ...ROLES, value: { ...ROLES.value, task: "anthropic/claude-opus-5.5:high" } };
  const t = FITTED({ estimates: { "*": { "task-high": { generation: "claude-opus-5-5", merged: 60 } } } });
  const c = lineOf(policy({ table: t, modelRoles: roles }), "cost", "*").sides[0].candidates.find((x) => x.cell === "task-high" && x.model?.text);
  assert.equal(c, undefined, "the heading carries it: the one candidate with a generation differs");
  assert.equal(sideOf(policy({ table: t, modelRoles: roles })).modelLine, "judged on claude-opus-5-5; task-high runs anthropic/claude-opus-5.5 here");
});

test("model names: when every candidate on a side differs, it is one line in that side's heading", () => {
  const roles = { ...ROLES, value: { ...ROLES.value, task: "anthropic/claude-sonnet-5-6:high", smol: "anthropic/claude-haiku-5-6:low" } };
  const p = policy({ table: FITTED(), modelRoles: roles });
  assert.equal(sideOf(p).modelLine, "judged on claude-sonnet-5-5; task-high runs anthropic/claude-sonnet-5-6 here; judged on claude-haiku-5-5; smol-high runs anthropic/claude-haiku-5-6 here");
  for (const c of lineOf(p, "cost", "*").sides[0].candidates) assert.equal(c.model.text, null, `${c.cell}: the heading carries it`);
});

test("model names: an unset model role, or modelRoles never read, reads not checked", () => {
  const unset = { ...ROLES, value: { slow: ROLES.value.slow, smol: ROLES.value.smol } };
  const task = lineOf(policy({ table: FITTED(), modelRoles: unset }), "cost", "*").sides[0].candidates[0];
  assert.deepEqual([task.model.state, task.model.text], ["not checked", "not checked: modelRoles.task unset: omp picks the model"]);
  const never = lineOf(policy({ table: FITTED(), modelRoles: null }), "cost", "*").sides[0].candidates[0];
  assert.deepEqual([never.model.state, never.model.text], ["not checked", "not checked: modelRoles not read yet"]);
  assert.equal(sideOf(policy({ table: FITTED(), modelRoles: null })).modelLine, null, "a check that cannot run is not a difference");
});

test("every row, collapsed or not, has an anchor and a link, in every state", () => {
  const states = {
    "unfitted": policy(),
    "fitted": policy({ table: FITTED() }),
    "no guard": policy({ guard: { status: "missing" } }),
    "no table": policy({ table: null }),
    "no install": policy({ install: null, repoUrl: null }),
  };
  for (const [name, p] of Object.entries(states)) {
    const lines = p.objectives.flatMap((o) => o.lines.map((l) => [o.objective, l]));
    assert.equal(lines.length, 8, name);
    for (const [o, l] of lines) {
      assert.equal(l.anchor, `cells-row-${o}-${l.stratum}`, name);
      assert.equal(l.href, `#cells/row/${o}/${l.stratum}`, name);
    }
  }
});

test("no table read: every row says so, and the heading does not guess", () => {
  const p = policy({ table: null });
  assert.equal(sideOf(p).heading, "no router table read: the rows are not known");
  assert.equal(sideOf(p).source.text, "this repository's runs · no router table read · @feigi/fleet-ctl 3.104.0");
  assert.equal(sideOf(p).dispatch, null);
  for (const o of p.objectives) for (const l of o.lines) assert.deepEqual(l.sides[0], { unread: "router table not read" });
});

test("computeCellEvidence with none of the policy inputs reads as no table, no install, no Objective", () => {
  const ce = build();
  assert.equal(sideOf(ce.policy).heading, "no router table read: the rows are not known");
  assert.equal(ce.policy.objectives.some((o) => o.live), false);
});

// -- policy rows: what the evidence favours --------------------------------------

const BLOBS = { "docs/metrics/member-outcomes.tsv": "e08ea9cd", "docs/metrics/ticket-features.tsv": "12b5a98e", "docs/metrics/tier-outcomes.tsv": "18b6a980" };
const PRIOR = { fitted_commit: SHIPPED.fitted_commit, version: "3.104.0", stage: SHIPPED.stage, cells: SHIPPED.cells, classifier: SHIPPED.classifier, window_start: SHIPPED.window_start };
// A Preview fit the shape today's records fit to: 235 Pulls, stage 2 with the two
// effort Cells added at 0 merged PRs, task-high on every row it fitted.
const TASK = (verdict) => ({ cell: "task-high", reason: "sole-qualifier", cells: { "task-high": { verdict, range: [-3.1, -0.4] }, "smol-high": { verdict: "under-floor", range: null } }, pairs: [] });
const FIT = (o = {}) => ({
  window_start: "2026-10-03", fitted_commit: null, n_rows: 235, stage: 2, cells: FIVE, burn_in: true,
  rows: { cost: { "*": "task-high", light: "task-high", heavy: "task-high" }, speed: { "*": "task-high", light: "task-high", heavy: "task-high" } },
  classifier: { b: null, tau: null },
  estimates: {
    "*": { "slow-high": { generation: "claude-opus-5", merged: 69 }, "task-high": { generation: "claude-sonnet-5-5", merged: 69 }, "smol-high": { generation: "claude-haiku-5-5", merged: 32 } },
    light: { "task-high": { generation: "claude-sonnet-5-5", merged: 40 } },
    heavy: { "task-high": { generation: "claude-sonnet-5-5", merged: 29 } },
  },
  reasons: {
    cost: { "*": TASK("qualifies"), light: TASK("qualifies"), heavy: TASK("qualifies") },
    speed: { "*": TASK("qualifies"), light: TASK("qualifies"), heavy: TASK("qualifies") },
  },
  guard: { tripped: [], n: { "slow-high": 69, "smol-high": 32, "task-high": 69 } },
  ...o,
});
// The guard these fixtures stand beside: TODAY's, with the blob ids the preview read.
const BESIDE = (o = {}) => guardOk(TODAY().guard.cells, { tsv_blobs: BLOBS, ...o });
const PREVIEW = (o = {}) => ({
  status: "ok",
  preview: { computed_at: "2026-10-26T19:17:40.000Z", guard_computed_at: "2026-10-26T19:17:33.000Z", tsv_blobs: BLOBS, prior: PRIOR, table: FIT(), ...o },
});
const favours = (o = {}) => policy({ guard: BESIDE(), preview: PREVIEW(), ...o });
const favoursOf = (p) => p.sides[1];

test("evidence favours sits beside routes now, on the right", () => {
  assert.deepEqual(favours().sides.map((s) => s.title), ["routes now", "evidence favours"]);
});

test("today's records: the Preview fit reads stage 2 with slow-medium and task-max at 0 of 20, task-high on every fitted row, each marked ≠ routes now", () => {
  const p = favours();
  const s = favoursOf(p);
  assert.equal(s.source.text, "Preview fit · this repository's runs · computed 2026-10-26 19:17Z · 235 Pulls");
  assert.equal(s.heading, "stage 2: slow-medium and task-max have 0 of the 20 merged PRs each needs", "present tense: the workspace's own counts");
  assert.deepEqual(s.labels, [], "fitted beside this guard, on its records, against the installed table");
  for (const o of ["cost", "speed"]) {
    for (const stratum of ["*", "light", "heavy"]) {
      const [now, fav] = lineOf(p, o, stratum).sides;
      assert.equal(fav.cell, "task-high", `${o}/${stratum}`);
      assert.equal(fav.reason, "sole-qualifier", `${o}/${stratum}`);
      assert.equal(fav.differs, "≠ routes now", `${o}/${stratum}`);
      assert.deepEqual(fav.candidates.map((c) => [c.cell, c.verdict]), [["task-high", "qualifies"], ["smol-high", "under-floor"]], `${o}/${stratum}`);
      if (stratum === "*") assert.equal(now.cell, "slow-high");
      else assert.deepEqual(now, { follows: "no row of its own: follows *" }, "routes now has no row of its own there, and keeps the line");
    }
    assert.equal(lineOf(p, o, "unknown").collapsed, "unknown: no row on either side, follows *");
  }
  assert.equal(lineOf(p, "cost", "light").sides[1].candidates[0].n, 40, "each row's candidates carry that row's own n");
});

test("≠ routes now is marked only where the two Cells differ, the Cell routes now gives a row it has none of its own for included", () => {
  const slow = { cost: { "*": "slow-high", light: "slow-high" }, speed: { "*": "slow-high", light: "task-high" } };
  const p = favours({ preview: PREVIEW({ table: FIT({ rows: slow }) }) });
  assert.equal(lineOf(p, "cost", "*").sides[1].differs, null);
  assert.equal(lineOf(p, "cost", "light").sides[1].differs, null, "routes now follows * there, which is slow-high too");
  assert.equal(lineOf(p, "speed", "light").sides[1].differs, "≠ routes now");
  for (const e of Object.values(lineOf(p, "cost", "*").sides[0])) assert.notEqual(e, "≠ routes now", "routes now carries no mark");
});

test("a tripped Cell: the Preview fit's row Cell is replaced as route would, and compared after that", () => {
  const tripped = BESIDE({ verdict: "tripped", tripped: ["task-high"] });
  const p = favours({ guard: tripped });
  const fav = lineOf(p, "cost", "*").sides[1];
  assert.equal(fav.cell, "slow-high");
  assert.equal(fav.held, "task-high tripped");
  assert.equal(fav.differs, null, "both sides route slow-high under this guard");
});

test("evidence favours states: no cost guard, before the first Preview fit, and a Preview fit that cannot be read leave its column empty", () => {
  const cases = [
    ["no cost guard", { guard: { status: "missing" } }, "no Preview fit: it is written only beside a cost guard"],
    ["an unreadable guard", { guard: { status: "unreadable", why: "not JSON" } }, "no Preview fit: it is written only beside a cost guard"],
    ["before the first Preview fit", { preview: { status: "missing" } }, "no Preview fit yet: the next phase 0 writes one"],
    ["left out", { preview: undefined }, "no Preview fit yet: the next phase 0 writes one"],
    ["unreadable", { preview: { status: "unreadable", why: "not JSON" } }, "no Preview fit read: not JSON"],
  ];
  for (const [name, o, heading] of cases) {
    const p = favours(o);
    const s = favoursOf(p);
    assert.equal(s.heading, heading, name);
    assert.equal(s.source.text, "Preview fit", name);
    assert.deepEqual(s.labels, [], name);
    assert.deepEqual(s.footnotes, [], name);
    assert.equal(s.dispatch, null, name);
    assert.deepEqual(lineOf(p, "cost", "*").sides[1], { empty: true }, name);
    assert.equal(lineOf(p, "cost", "light").collapsed, "light: no row, follows *", `${name}: an empty column holds no row back from collapsing`);
  }
  assert.equal(favoursOf(favours({ guard: { status: "missing" } })).heading, "no Preview fit: it is written only beside a cost guard", "a Preview fit on disk with no guard is not laid out");
});

test("a Preview fit out of burn-in has no burn-in heading; a single short Cell, or Cells short by different counts, are worded each", () => {
  assert.equal(favoursOf(favours({ preview: PREVIEW({ table: FIT({ burn_in: false, guard: { tripped: [], n: Object.fromEntries(FIVE.map((c) => [c, 20])) } }) }) })).heading, null);
  const one = FIT({ guard: { tripped: [], n: { "slow-high": 69, "task-high": 69, "smol-high": 32, "slow-medium": 20 } } });
  assert.equal(favoursOf(favours({ preview: PREVIEW({ table: one }) })).heading, "stage 2: task-max has 0 of the 20 merged PRs it needs");
  const two = FIT({ guard: { tripped: [], n: { "slow-high": 69, "task-high": 69, "smol-high": 32, "slow-medium": 3 } } });
  assert.equal(favoursOf(favours({ preview: PREVIEW({ table: two }) })).heading, "stage 2: slow-medium has 3 and task-max has 0 of the 20 merged PRs each needs");
});

test("heading label: fitted beside another guard fires only when guard_computed_at differs from the guard's computed_at", () => {
  assert.deepEqual(favoursOf(favours({ preview: PREVIEW({ guard_computed_at: "2026-10-25T08:00:00.000Z" }) })).labels, ["fitted beside the guard of 2026-10-25 08:00Z, not this one"]);
  assert.deepEqual(favoursOf(favours()).labels, []);
});

test("heading label: fitted on other records fires only when the two files' tsv_blobs differ, and reads not checked when the guard has none", () => {
  const other = { ...BLOBS, "docs/metrics/tier-outcomes.tsv": "d59dc49b" };
  assert.deepEqual(favoursOf(favours({ preview: PREVIEW({ tsv_blobs: other }) })).labels, ["fitted on other records than the guard's"]);
  const { tsv_blobs, ...older } = BESIDE().guard;
  assert.deepEqual(favoursOf(favours({ guard: { status: "ok", guard: older } })).labels, ["fitted on the guard's records: not checked: this guard predates the blob ids it needs"]);
  assert.deepEqual(favoursOf(favours()).labels, []);
});

test("heading label: fitted against another prior fires on stage, cells or classifier, and on window_start only when the guard gave none", () => {
  const label = "fitted against 3.104.0 · never fitted; the next phase 0 refits";
  for (const [field, value] of [["stage", 2], ["cells", ["slow-high", "task-high"]], ["classifier", { b: "haiku", tau: 0.7 }]]) {
    assert.deepEqual(favoursOf(favours({ preview: PREVIEW({ prior: { ...PRIOR, [field]: value } }) })).labels, [label], field);
  }
  const windowed = PREVIEW({ prior: { ...PRIOR, window_start: "2026-09-01" } });
  assert.deepEqual(favoursOf(favours({ preview: windowed })).labels, [], "the guard gave a window_start, so the prior's was not read");
  assert.deepEqual(favoursOf(favours({ preview: windowed, guard: BESIDE({ window_start: null }) })).labels, [label]);
  const fitted = PREVIEW({ prior: { ...PRIOR, stage: 2, fitted_commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", version: "0.0.0" } });
  assert.deepEqual(favoursOf(favours({ preview: fitted })).labels, ["fitted against linked checkout · fitted at 1a2b3c4; the next phase 0 refits"]);
  const unfitted = PREVIEW({ prior: { ...PRIOR, stage: 2, fitted_commit: "" } });
  assert.deepEqual(favoursOf(favours({ preview: unfitted })).labels, [label], "an empty fitted_commit was never fitted");
  const unversioned = PREVIEW({ prior: { ...PRIOR, stage: 2, version: 7 } });
  assert.deepEqual(favoursOf(favours({ preview: unversioned })).labels, ["fitted against no version · never fitted; the next phase 0 refits"], "a version that is not a string is none");
  assert.deepEqual(favoursOf(favours({ preview: PREVIEW({ prior: null }) })).labels.length, 1, "a prior the file lacks is not the installed table");
});

test("heading label: a release changing only fitted_commit and version raises no prior label", () => {
  const release = PREVIEW({ prior: { ...PRIOR, fitted_commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", version: "3.105.0" } });
  assert.deepEqual(favoursOf(favours({ preview: release })).labels, []);
  assert.deepEqual(favoursOf(favours({ table: { ...SHIPPED, fitted_commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", n_rows: 198 } })).labels, [], "nor does an installed table that differs only there");
  assert.deepEqual(favoursOf(favours({ table: null })).labels, ["fitted against the installed table: not checked: no router table read"]);
});

test("no installed table: no row is marked ≠ routes now, and a Stratum the Preview fit has no row for keeps its line beside routes now's unread", () => {
  const p = favours({ table: null });
  for (const o of ["cost", "speed"]) {
    for (const stratum of ["*", "light", "heavy"]) assert.equal(lineOf(p, o, stratum).sides[1].differs, null, `${o}/${stratum}: nothing to differ from`);
    const line = lineOf(p, o, "unknown");
    assert.equal(line.collapsed, undefined, `${o}: routes now's rows are not known, so its unknown row may exist`);
    assert.deepEqual(line.sides, [{ unread: "router table not read" }, { follows: "no row of its own: follows *" }], o);
  }
});

test("the guard-against-fit n footnote shows when both read the same files and a Cell's n differs, its mark on the fit's n", () => {
  const est = (n, generation = "claude-sonnet-5-5") => ({ ...FIT().estimates, "*": { ...FIT().estimates["*"], "task-high": { generation, merged: n } } });
  const p = favours({ preview: PREVIEW({ table: FIT({ estimates: est(67) }) }) });
  const s = favoursOf(p);
  assert.deepEqual(s.footnotes, [{ mark: "¹", text: "task-high: the guard counts merges by GitHub's state, the fit by Rulings, and the fit admits only drawn or rule-sized Pulls" }]);
  for (const o of ["cost", "speed"]) {
    const cands = lineOf(p, o, "*").sides[1].candidates;
    assert.deepEqual(cands.map((c) => [c.cell, c.n, c.nMark]), [["task-high", 67, "¹"], ["smol-high", 32, null]], o);
  }
  assert.equal(lineOf(p, "cost", "light").sides[1].candidates[0].nMark, null, "a Stratum's n is not the guard's Cell-wide count");

  const other = favours({ preview: PREVIEW({ table: FIT({ estimates: est(67) }), tsv_blobs: { ...BLOBS, "docs/metrics/tier-outcomes.tsv": "d59dc49b" } }) });
  assert.deepEqual(favoursOf(other).footnotes, [], "other files: the counts need not agree");
  assert.deepEqual(favoursOf(favours()).footnotes, [], "the same n on the same files");
  const { tsv_blobs, ...older } = BESIDE().guard;
  assert.deepEqual(favoursOf(favours({ guard: { status: "ok", guard: older }, preview: PREVIEW({ table: FIT({ estimates: est(67) }) }) })).footnotes, [], "no blob ids, nothing to compare");
  const generation = favours({ preview: PREVIEW({ table: FIT({ estimates: est(67, "claude-sonnet-5") }) }) });
  assert.deepEqual(favoursOf(generation).footnotes, [], "another generation's n: not the one the guard counts");
  assert.equal(lineOf(generation, "cost", "*").sides[1].candidates[0].nMark, null);
  for (const merged of [null, "67", -1]) {
    assert.deepEqual(favoursOf(favours({ preview: PREVIEW({ table: FIT({ estimates: est(merged) }) }) })).footnotes, [], `a merged of ${JSON.stringify(merged)} is no count to compare`);
  }

  const consumer = favours({ repoUrl: "https://ghe.example.com/acme/widgets", preview: PREVIEW({ table: FIT({ estimates: est(67) }) }) });
  assert.equal(consumer.sides[0].footnotes[0].mark, "¹");
  assert.equal(favoursOf(consumer).footnotes[0].mark, "²", "numbered after routes now's own");
});
