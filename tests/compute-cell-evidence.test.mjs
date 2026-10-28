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
