import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { CELLS, computeCellEvidence, refitFailure } from "../plugin/scripts/compute-cell-evidence.mjs";
import { readCostGuard } from "../plugin/scripts/fleet-tick.mjs";
import { guardFile } from "../plugin/scripts/pr-cost.mjs";
import { DAY_ONE_TABLE } from "./support/day-one-router-table.mjs";
import { implementerDefinitions } from "./support/implementer-definitions.mjs";

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

// -- every implementer Cell, in every state --------------------------------------

const STATES = {
  "today's guard": () => ({ guard: TODAY() }),
  "no cost guard": () => ({ guard: { status: "missing" } }),
  "an unreadable guard": () => ({ guard: { status: "unreadable", why: "not JSON" } }),
  "holds nothing back": () => ({ guard: guardOk([entry("slow-high", { n: 7, n_merged: 7 })], { verdict: "none", baseline: { cell: "slow-high", generation: "claude-opus-5", n: 7, mean_usd: 14.9, fail_rate: 0.1 } }) }),
  "a tripped Cell": () => ({ guard: guardOk(TODAY().guard.cells, { verdict: "tripped", tripped: ["task-high"] }) }),
  "a guard that predates the new fields": () => ({ guard: guardOk([{ cell: "slow-high", generation: "claude-opus-5", n: 40, mean_usd: 14.9, fail_rate: 0.1, untimed: 0 }]) }),
  "no modelRoles read yet": () => ({ modelRoles: null }),
};

test("every implementer Cell is drawn in a fixed order, in every state", () => {
  for (const [name, o] of Object.entries(STATES)) {
    assert.deepEqual(build(o()).guard.cells.map((c) => c.cell), CELLS, name);
  }
  assert.deepEqual(CELLS, [
    "slow-high", "task-high", "smol-high", "slow-medium", "task-max",
    "slow-low", "slow-xhigh", "slow-max",
    "task-low", "task-medium", "task-xhigh",
    "smol-low", "smol-medium", "smol-xhigh", "smol-max",
  ]);
});

test("CELLS is exactly the Cells plugin/agents defines", () => {
  const cells = implementerDefinitions().map((name) => name.slice("fleet-implementer-".length));
  assert.deepEqual([...CELLS].sort(), cells.sort());
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

test("a Cell the guard holds beyond CELLS is drawn after them, never left out", () => {
  const ce = build({ guard: guardOk([entry("slow-high"), entry("slow-minimal", { generation: "claude-opus-5" })]) });
  assert.deepEqual(ce.guard.cells.map((c) => c.cell), [...CELLS, "slow-minimal"]);
  assert.equal(cellOf(ce, "slow-minimal").figures.generation, "claude-opus-5");
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

test("a Cell the guard lists unmatched reads 'not judged' though past min_n, while the Cells it judged read ✓", () => {
  const ce = build({ guard: guardOk([entry("slow-high"), entry("task-high"), entry("smol-high", { n: 32, n_merged: 32 })], { unmatched: ["task-high"] }) });
  assert.equal(cellOf(ce, "task-high").figures.merged.text, "69 ≥ 20: not judged, under 20 on a side in the stretches shared with slow-high");
  assert.equal(cellOf(ce, "smol-high").figures.merged.text, "32 ≥ 20 ✓");
  assert.equal(cellOf(ce, "slow-high").figures.merged.text, "69 ≥ 20 ✓");
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

test("no cost guard: a metrics step whose at is no time has not run, and a dated step beside it is the one quoted", () => {
  const why = "pr-cost.mjs --guard exited 1: pr-cost: untimed";
  const dated = step("failed", "2026-10-28T08:00:00.000Z", "metrics-refresh: cost guard failed: dated");
  for (const at of ["garbage", "", null, undefined]) {
    const untimed = step("failed", at, `metrics-refresh: cost guard failed: ${why}`);
    assert.deepEqual(noGuardNotes({ phase0: untimed, closeout: null }), ["no metrics refresh has run in the receipts here"], `phase 0 at ${JSON.stringify(at)}`);
    assert.deepEqual(noGuardNotes({ phase0: null, closeout: untimed }), ["no metrics refresh has run in the receipts here"], `close-out at ${JSON.stringify(at)}`);
    assert.deepEqual(noGuardNotes({ phase0: untimed, closeout: dated }), ["failed at 2026-10-28 08:00Z: dated"], `untimed phase 0 at ${JSON.stringify(at)}`);
    assert.deepEqual(noGuardNotes({ phase0: dated, closeout: untimed }), ["failed at 2026-10-28 08:00Z: dated"], `untimed close-out at ${JSON.stringify(at)}`);
  }
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
  assert.deepEqual(ce.alerts, [], "no cost guard is a state of the guard section's heading, never an alert");
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

test("Declared, not measured counts the real definitions: the plugin's own, minus the Cells", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseFrontmatter } = await import("../plugin/scripts/tier-roles.mjs");
  const dir = new URL("../plugin/agents/", import.meta.url);
  const list = readdirSync(dir).filter((f) => f.endsWith(".agent.md")).map((file) => ({ file, model: parseFrontmatter(readFileSync(new URL(file, dir), "utf8")).model }));
  const d = computeCellEvidence({ guard: { status: "missing" }, receipts: NO_RECEIPTS, agents: { list, error: null }, modelRoles: ROLES }).declared;
  assert.equal(d.members.length, list.length - CELLS.length);
  assert.equal(d.heading, `Declared, not measured: ${list.length - CELLS.length} other members`);
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

// -- the view of the Fit that routes this run ---------------------------------------------------

// The day-one table, not plugin/scripts/router-table.json: the starting table every repository begins from.
const STARTING = DAY_ONE_TABLE;

// The tree a Fit holds here: the root splits on the brief's length, with a group on each side of the cut.
const ABOVE = "brief_chars>4047";
const BELOW = "brief_chars<=4047";
const SPLITS = { "*": { input: "brief_chars", cut: 4047 } };
const BLOBS = { "docs/metrics/member-outcomes.tsv": "e08ea9cd", "docs/metrics/ticket-features.tsv": "12b5a98e", "docs/metrics/tier-outcomes.tsv": "18b6a980" };
// A Fit the shape today's records fit to: 235 Pulls, every starting Cell past its 20 merged PRs and so out of
// burn-in, task-high on every row it fitted.
const TASK = (verdict) => ({ cell: "task-high", reason: "sole-qualifier", cells: { "task-high": { verdict, range: [-3.1, -0.4] }, "smol-high": { verdict: "under-floor", range: null } }, pairs: [] });
const FIT = (o = {}) => ({
  window_start: "2026-10-03", n_rows: 235, cells: STARTING.cells, burn_in: false,
  splits: SPLITS,
  rows: { cost: { "*": "task-high", [ABOVE]: "task-high", [BELOW]: "task-high" }, speed: { "*": "task-high", [ABOVE]: "task-high", [BELOW]: "task-high" } },
  classifier: { b: null, tau: null },
  estimates: {
    "*": { "slow-high": { generation: "claude-opus-5", merged: 69 }, "task-high": { generation: "claude-sonnet-5-5", merged: 69 }, "smol-high": { generation: "claude-haiku-5-5", merged: 32 } },
    [BELOW]: { "task-high": { generation: "claude-sonnet-5-5", merged: 40 } },
    [ABOVE]: { "task-high": { generation: "claude-sonnet-5-5", merged: 29 } },
  },
  reasons: {
    cost: { "*": TASK("qualifies"), [ABOVE]: TASK("qualifies"), [BELOW]: TASK("qualifies") },
    speed: { "*": TASK("qualifies"), [ABOVE]: TASK("qualifies"), [BELOW]: TASK("qualifies") },
  },
  guard: { tripped: [], n: { "slow-high": 69, "smol-high": 32, "task-high": 69 } },
  ...o,
});
// The guard these fixtures stand beside: TODAY's, with the blob ids the Fit read.
const BESIDE = (o = {}) => guardOk(TODAY().guard.cells, { tsv_blobs: BLOBS, ...o });
const FIT_READ = (o = {}) => ({
  status: "ok",
  fit: { computed_at: "2026-10-26T19:17:40.000Z", guard_computed_at: "2026-10-26T19:17:33.000Z", tsv_blobs: BLOBS, table: FIT(), ...o },
});
// omp's model catalog on this install: every role's model runs low to max, but the smol model has no max.
const LADDER = ["low", "medium", "high", "xhigh", "max"];
const CATALOG = {
  value: { models: [
    { selector: "anthropic/claude-opus-5", thinking: LADDER },
    { selector: "anthropic/claude-sonnet-5-5", thinking: LADDER },
    { selector: "anthropic/claude-haiku-5-5", thinking: LADDER.slice(0, 4) },
  ] },
  readAt: Date.UTC(2026, 9, 28, 9, 0),
  error: null,
};
// With no Fit read, the starting table routes.
const policy = (o = {}) => computeCellEvidence({ guard: TODAY(), receipts: NO_RECEIPTS, agents: AGENTS, modelRoles: ROLES, catalog: CATALOG, table: STARTING, ...o }).policy;
// With the Fit read beside its own guard.
const fitted = (o = {}) => policy({ guard: BESIDE(), fit: FIT_READ(), ...o });
const lineOf = (p, objective, stratum) => p.objectives.find((o) => o.objective === objective).lines.find((l) => l.stratum === stratum);

test("the tab is one view of the Fit: no sides, and neither 'routes now' nor 'evidence favours' anywhere in it", () => {
  for (const p of [policy(), fitted(), policy({ guard: { status: "missing" } }), policy({ table: null })]) {
    assert.equal(Object.hasOwn(p, "sides"), false);
    const text = JSON.stringify(p);
    for (const words of ["routes now", "evidence favours", "Preview fit", "main's table"]) assert.equal(text.includes(words), false, words);
    assert.equal(p.title, "The Fit that routes this run");
  }
});

test("a consumer is laid out by the same code as this repository: no sentence says its runs reach routing only through its cost guard", () => {
  const consumer = { install: { name: "@feigi/fleet-ctl", version: "3.104.0", repository: "git+https://github.com/feigi/fleet-plugin.git", error: null }, repoUrl: "https://ghe.example.com/acme/widgets" };
  for (const p of [policy(consumer), fitted(consumer)]) {
    assert.equal(JSON.stringify(p).includes("only through its cost guard"), false);
    assert.equal(JSON.stringify(p).includes("never picks one"), false);
  }
  assert.deepEqual(policy(consumer), policy(), "the install and the workspace's repository are no input to the view");
  assert.deepEqual(fitted(consumer), fitted());
});

test("no Fit yet: the starting table routes, a one-node tree in burn-in, each group drawing over the starting Cells", () => {
  const p = policy();
  assert.deepEqual(p.source, { text: "starting table · no Fit yet: the next phase 0 writes one", check: null });
  assert.equal(p.flag, null);
  assert.equal(p.heading, "burn-in: every Pull is drawn over the starting Cells the guard has not tripped");
  assert.deepEqual(p.burnIn, {
    heading: "burn-in: 3 of 3 starting Cells have the 20 merged PRs each needs",
    cells: [{ cell: "slow-high", n: 69, of: 20 }, { cell: "task-high", n: 69, of: 20 }, { cell: "smol-high", n: 32, of: 20 }],
  }, "the cost guard's counts, while the starting table routes");
  assert.equal(p.tripped, "the cost guard has tripped no Cell");
  assert.deepEqual(p.notices, []);
  for (const o of ["cost", "speed"]) {
    const lines = p.objectives.find((x) => x.objective === o).lines;
    assert.deepEqual(lines.map((l) => [l.stratum, l.depth, l.rule]), [["*", 0, "*"]], o);
    const [root] = lines;
    assert.deepEqual([root.entry.cell, root.entry.reason, root.entry.held, root.entry.candidates], ["slow-high", "unjudged", null, []], o);
    assert.equal(root.exploring, "drawn over slow-high, task-high and smol-high", o);
  }
});

test("burn-in progress: merged PRs per starting Cell against 20, from the Fit's own counts while the Fit routes", () => {
  const short = FIT({ burn_in: true, guard: { tripped: [], n: { "slow-high": 69, "task-high": 12 } } });
  assert.deepEqual(fitted({ fit: FIT_READ({ table: short }) }).burnIn, {
    heading: "burn-in: 1 of 3 starting Cells has the 20 merged PRs each needs",
    cells: [{ cell: "slow-high", n: 69, of: 20 }, { cell: "task-high", n: 12, of: 20 }, { cell: "smol-high", n: 0, of: 20 }],
  });
  assert.equal(fitted().burnIn.heading, "burn-in ended: every starting Cell has its 20 merged PRs");
  assert.equal(policy({ guard: { status: "missing" } }).burnIn, null, "no guard and no Fit: nothing to count from");
});

test("burn-in progress: a Cell at exactly 20 merged PRs has them, one at 19 does not", () => {
  const edge = FIT({ burn_in: true, guard: { tripped: [], n: { "slow-high": 20, "task-high": 19, "smol-high": 69 } } });
  assert.deepEqual(fitted({ fit: FIT_READ({ table: edge }) }).burnIn, {
    heading: "burn-in: 2 of 3 starting Cells have the 20 merged PRs each needs",
    cells: [{ cell: "slow-high", n: 20, of: 20 }, { cell: "task-high", n: 19, of: 20 }, { cell: "smol-high", n: 69, of: 20 }],
  });
});

test("burn-in progress under a starting table out of burn-in: 'ended' only once the cost guard's counts all reach 20", () => {
  const outOfBurnIn = { ...STARTING, burn_in: false };
  const short = guardOk([
    entry("slow-high", { n: 2 }),
    entry("task-high", { generation: "claude-sonnet-5-5", n: 0 }),
    entry("smol-high", { generation: "claude-haiku-5-5", n: 25 }),
  ]);
  assert.deepEqual(policy({ table: outOfBurnIn, guard: short }).burnIn, {
    heading: "no burn-in: the starting table routes without it, though only 1 of 3 starting Cells has the 20 merged PRs each needs",
    cells: [{ cell: "slow-high", n: 2, of: 20 }, { cell: "task-high", n: 0, of: 20 }, { cell: "smol-high", n: 25, of: 20 }],
  }, "the cost guard's counts, never under a heading that says they are all in");
  assert.equal(policy({ table: outOfBurnIn }).burnIn.heading, "burn-in ended: every starting Cell has its 20 merged PRs");
});

test("the Fit routes: its source names it, and each Objective's lines are the tree's groups, each with its rule, its Cell and every candidate's verdict and range", () => {
  const p = fitted();
  assert.deepEqual(p.source, { text: "Fit · computed 2026-10-26 19:17Z · 235 Pulls", check: null });
  assert.equal(p.heading, "every 5th Pull that is no chain head is drawn over its group's exploration Cells; the rest run the group's Cell");
  for (const o of ["cost", "speed"]) {
    const lines = p.objectives.find((x) => x.objective === o).lines;
    assert.deepEqual(lines.map((l) => [l.stratum, l.depth, l.rule]), [["*", 0, "*"], [ABOVE, 1, ABOVE], [BELOW, 1, BELOW]], o);
    for (const l of lines) {
      assert.deepEqual([l.entry.cell, l.entry.reason], ["task-high", "sole-qualifier"], `${o}/${l.stratum}`);
      assert.deepEqual(l.entry.candidates.map((c) => [c.cell, c.verdict]), [["task-high", "qualifies"], ["smol-high", "under-floor"]], `${o}/${l.stratum}`);
    }
  }
  const [task, smol] = lineOf(p, "cost", "*").entry.candidates;
  assert.deepEqual([task.n, task.interval], [69, "95% interval [−$3.10, −$0.40]"]);
  assert.deepEqual([smol.n, smol.interval], [32, "no 95% interval"]);
  assert.equal(lineOf(p, "speed", "*").entry.candidates[0].interval, "95% interval [−3.1 min, −0.4 min]");
  assert.equal(lineOf(p, "cost", BELOW).entry.candidates[0].n, 40, "each line's candidates carry that group's own n");
});

test("a group two splits down is drawn at depth 2 under its own rule, its whole path kept for its anchor", () => {
  const deep = `${ABOVE}&kind=bug`;
  const rows = { "*": "task-high", [ABOVE]: "task-high", [deep]: "slow-high", [BELOW]: "task-high" };
  const t = FIT({ rows: { cost: rows, speed: rows }, reasons: { cost: {}, speed: {} } });
  const l = lineOf(fitted({ fit: FIT_READ({ table: t }) }), "cost", deep);
  assert.deepEqual([l.depth, l.rule, l.anchor, l.href], [2, "kind=bug", `cells-row-cost-${deep}`, `#cells/row/cost/${deep}`]);
  assert.deepEqual([l.entry.cell, l.entry.reason, l.entry.candidates], ["slow-high", "not checked", []]);
});

test("exploration: past burn-in each group explores the Cells around its cost row Cell that this install runs, less the tripped", () => {
  assert.equal(lineOf(fitted(), "cost", "*").exploring, "exploring task-xhigh, task-medium, slow-medium and smol-xhigh");
  assert.equal(lineOf(fitted(), "speed", "*").exploring, "exploring task-xhigh, task-medium, slow-medium and smol-xhigh", "centred on the cost row's Cell under speed too");
  const slow = { "*": "task-high", [ABOVE]: "slow-high", [BELOW]: "task-high" };
  assert.equal(lineOf(fitted({ fit: FIT_READ({ table: FIT({ rows: { cost: slow, speed: slow } }) }) }), "cost", ABOVE).exploring,
    "exploring slow-xhigh, slow-medium and task-xhigh", "a group explores around its own Cell");
  assert.equal(lineOf(fitted({ guard: BESIDE({ verdict: "tripped", tripped: ["task-medium"] }) }), "cost", "*").exploring,
    "exploring task-xhigh, slow-medium and smol-xhigh", "a tripped Cell is never drawn");
  const undefinedCells = { list: AGENTS.list.filter((a) => a.file !== "fleet-implementer-smol-xhigh.agent.md"), error: null };
  assert.equal(lineOf(fitted({ agents: undefinedCells }), "cost", "*").exploring, "exploring task-xhigh, task-medium and slow-medium", "a Cell with no definition is never drawn");
  const none = BESIDE({ verdict: "tripped", tripped: ["task-xhigh", "task-medium", "slow-medium", "smol-xhigh"] });
  assert.equal(lineOf(fitted({ guard: none }), "cost", "*").exploring, "exploring nothing: no exploration Cell this install runs is left untripped");
});

test("exploration: what this install runs is not checked while a read it needs has no value", () => {
  assert.equal(lineOf(fitted({ catalog: null }), "cost", "*").exploring, "exploring: not checked: omp's model catalog not read yet");
  assert.equal(lineOf(fitted({ modelRoles: null }), "cost", "*").exploring, "exploring: not checked: modelRoles not read yet");
  assert.equal(lineOf(fitted({ agents: { list: [], error: "/x/agents: ENOENT" } }), "cost", "*").exploring, "exploring: not checked: the definitions could not be read");
  assert.equal(lineOf(policy({ catalog: null }), "cost", "*").exploring, "drawn over slow-high, task-high and smol-high", "burn-in draws the starting Cells, whatever the install runs");
});

test("exploration: a catalog read that fails says why, beside the unread catalog and beside the Cells a stale one names", () => {
  const failing = { at: Date.UTC(2026, 9, 28, 10, 0), message: "omp models --json failed (ENOENT)" };
  assert.equal(lineOf(fitted({ catalog: { value: null, readAt: null, error: failing } }), "cost", "*").exploring,
    "exploring: not checked: omp's model catalog not read yet; reading fails: omp models --json failed (ENOENT)");
  assert.equal(lineOf(fitted({ catalog: { ...CATALOG, error: failing } }), "cost", "*").exploring,
    "exploring task-xhigh, task-medium, slow-medium and smol-xhigh; omp's model catalog as read at 2026-10-28 09:00Z; reading fails: omp models --json failed (ENOENT)");
  assert.equal(lineOf(fitted(), "cost", "*").exploring, "exploring task-xhigh, task-medium, slow-medium and smol-xhigh", "a read that stands carries no note");
});

test("tripped Cells: the guard's are named, a tripped row Cell is replaced by slow-high, and burn-in draws the rest", () => {
  const tripped = BESIDE({ verdict: "tripped", tripped: ["task-high"] });
  const p = fitted({ guard: tripped });
  assert.equal(p.tripped, "tripped by the cost guard: task-high");
  assert.deepEqual([lineOf(p, "cost", "*").entry.cell, lineOf(p, "cost", "*").entry.held], ["slow-high", "task-high tripped"]);
  const burnIn = policy({ guard: guardOk(TODAY().guard.cells, { verdict: "tripped", tripped: ["smol-high"] }) });
  assert.equal(burnIn.tripped, "tripped by the cost guard: smol-high");
  assert.equal(lineOf(burnIn, "cost", "*").exploring, "drawn over slow-high and task-high");
  const all = policy({ guard: guardOk(TODAY().guard.cells, { verdict: "tripped", tripped: ["slow-high", "task-high", "smol-high"] }) });
  assert.equal(lineOf(all, "cost", "*").exploring, "draws nothing: every starting Cell is tripped");
});

test("no cost guard: every Pull runs at slow-high whatever the table says, nothing is drawn, and nothing is tripped", () => {
  for (const guard of [{ status: "missing" }, { status: "unreadable", why: "not JSON" }]) {
    const p = fitted({ guard });
    assert.equal(p.heading, "no cost guard: every Pull runs at slow-high, the default Cell", guard.status);
    assert.equal(p.tripped, null, guard.status);
    assert.deepEqual(p.labels, [], guard.status);
    const root = lineOf(p, "cost", "*");
    assert.deepEqual([root.entry.cell, root.entry.held, root.exploring], ["slow-high", "task-high held: no cost guard", null], guard.status);
  }
  // A Cell that is no `<role>-<level>` token can be tripped for readCostGuard; readGuard refuses the file.
  const odd = guardOk([...TODAY().guard.cells, entry("odd")], { verdict: "tripped", tripped: ["odd"] });
  assert.equal(policy({ guard: odd }).heading, "no cost guard: every Pull runs at slow-high, the default Cell");
});

// A Fit in burn-in whose slow-high model changed: the root group holds the old generation beside the new one.
const CHANGED = (n = 3) => FIT({
  burn_in: true,
  estimates: { "*": { ...FIT().estimates["*"], "slow-high": { generation: "claude-opus-5-5", merged: n, older: { "claude-opus-5": { merged: 69 } } } } },
  guard: { tripped: [], n: { "slow-high": n, "task-high": 69, "smol-high": 32 } },
});

test("a role whose model changed and whose burn-in restarted shows a notice", () => {
  const p = fitted({ fit: FIT_READ({ table: CHANGED() }) });
  assert.deepEqual(p.notices, ["slow-high's model changed to claude-opus-5-5, after claude-opus-5: burn-in restarted, at 3 of the 20 merged PRs it needs"]);
  assert.equal(p.burnIn.heading, "burn-in: 2 of 3 starting Cells have the 20 merged PRs each needs");
});

test("no model-change notice once the new model has its 20 merged PRs, with no older generation, or while the starting table routes", () => {
  assert.deepEqual(fitted({ fit: FIT_READ({ table: { ...CHANGED(20), burn_in: false } }) }).notices, []);
  assert.deepEqual(fitted({ fit: FIT_READ({ table: FIT({ burn_in: true, guard: { tripped: [], n: { "slow-high": 3 } } }) }) }).notices, [], "no older generation: a first burn-in");
  assert.deepEqual(policy().notices, []);
});

test("the model-change notice holds below 20 merged PRs and goes at exactly 20, and only in burn-in", () => {
  assert.deepEqual(fitted({ fit: FIT_READ({ table: CHANGED(20) }) }).notices, [], "in burn-in, at exactly 20: no notice");
  assert.deepEqual(fitted({ fit: FIT_READ({ table: CHANGED(19) }) }).notices, ["slow-high's model changed to claude-opus-5-5, after claude-opus-5: burn-in restarted, at 19 of the 20 merged PRs it needs"]);
  assert.deepEqual(fitted({ fit: FIT_READ({ table: { ...CHANGED(3), burn_in: false } }) }).notices, [], "short of 20 beside an older generation, but out of burn-in");
});

test("no model-change notice beside an older generation when the record names no generation of its own", () => {
  const unnamed = FIT({
    burn_in: true,
    estimates: { "*": { ...FIT().estimates["*"], "slow-high": { merged: 3, older: { "claude-opus-5": { merged: 69 } } } } },
    guard: { tripped: [], n: { "slow-high": 3, "task-high": 69, "smol-high": 32 } },
  });
  assert.deepEqual(fitted({ fit: FIT_READ({ table: unnamed }) }).notices, []);
});

test("Fit-versus-guard labels: fitted beside another guard, on other records, or against a guard with no blob ids; nothing for the Fit beside its own guard", () => {
  assert.deepEqual(fitted().labels, []);
  assert.deepEqual(fitted({ fit: FIT_READ({ guard_computed_at: "2026-10-25T08:00:00.000Z" }) }).labels, ["fitted beside the guard of 2026-10-25 08:00Z, not this one"]);
  const other = { ...BLOBS, "docs/metrics/tier-outcomes.tsv": "d59dc49b" };
  assert.deepEqual(fitted({ fit: FIT_READ({ tsv_blobs: other }) }).labels, ["fitted on other records than the guard's"]);
  const { tsv_blobs, ...older } = BESIDE().guard;
  assert.deepEqual(fitted({ guard: { status: "ok", guard: older } }).labels, ["fitted on the guard's records: not checked: this guard predates the blob ids it needs"]);
  assert.deepEqual(policy().labels, [], "no Fit read: nothing to compare");
});

test("the guard-against-Fit n footnote shows when both read the same files and a Cell's n differs, its mark on the root's n", () => {
  const est = (n, generation = "claude-sonnet-5-5") => ({ ...FIT().estimates, "*": { ...FIT().estimates["*"], "task-high": { generation, merged: n } } });
  const p = fitted({ fit: FIT_READ({ table: FIT({ estimates: est(67) }) }) });
  assert.deepEqual(p.footnotes, [{ mark: "¹", text: "task-high: the guard counts merges by GitHub's state, the Fit by Rulings, and the Fit admits only drawn or rule-sized Pulls" }]);
  for (const o of ["cost", "speed"]) {
    assert.deepEqual(lineOf(p, o, "*").entry.candidates.map((c) => [c.cell, c.n, c.nMark]), [["task-high", 67, "¹"], ["smol-high", 32, null]], o);
  }
  assert.equal(lineOf(p, "cost", BELOW).entry.candidates[0].nMark, null, "a group's n is not the guard's Cell-wide count");
  const other = { ...BLOBS, "docs/metrics/tier-outcomes.tsv": "d59dc49b" };
  assert.deepEqual(fitted({ fit: FIT_READ({ table: FIT({ estimates: est(67) }), tsv_blobs: other }) }).footnotes, [], "other files: the counts need not agree");
  assert.deepEqual(fitted({ fit: FIT_READ({ table: FIT({ estimates: est(67, "claude-sonnet-5") }) }) }).footnotes, [], "another generation's n");
});

test("the live run's Objective is marked, and between runs nothing is", () => {
  assert.deepEqual(policy({ objective: "speed" }).objectives.map((o) => [o.objective, o.live]), [["cost", false], ["speed", true]]);
  assert.deepEqual(policy({ objective: "cost" }).objectives.map((o) => [o.objective, o.live]), [["cost", true], ["speed", false]]);
  assert.deepEqual(policy().objectives.map((o) => o.live), [false, false]);
});

test("a candidate whose estimate carries no count shows its n as not checked, never a measured-looking 0", () => {
  for (const merged of ["12", -1, 1.5, null, undefined]) {
    const t = FIT({ estimates: { "*": { "task-high": { generation: "claude-sonnet-5-5", merged } } } });
    assert.equal(lineOf(fitted({ fit: FIT_READ({ table: t }) }), "cost", "*").entry.candidates.find((c) => c.cell === "task-high").n, null, JSON.stringify(merged));
  }
  assert.equal(lineOf(fitted({ fit: FIT_READ({ table: FIT({ estimates: {} }) }) }), "cost", "*").entry.candidates[0].n, null, "no estimate at all");
});

test("model names: a candidate's judged generation against its Cell's Tier route model, named only where they differ", () => {
  const roles = { ...ROLES, value: { ...ROLES.value, task: "anthropic/claude-sonnet-5-6:high" } };
  const p = fitted({ modelRoles: roles });
  const [task, smol] = lineOf(p, "cost", "*").entry.candidates;
  assert.deepEqual(task.model, { state: "differs", generation: "claude-sonnet-5-5", text: "judged on claude-sonnet-5-5; task-high runs anthropic/claude-sonnet-5-6 here" });
  assert.deepEqual(smol.model, { state: "same", generation: "claude-haiku-5-5", text: null });
  assert.equal(p.modelLine, null, "one candidate agrees, so the difference stays on its candidate");
});

test("model names: when every candidate differs, it is one line in the view's heading", () => {
  const roles = { ...ROLES, value: { ...ROLES.value, task: "anthropic/claude-sonnet-5-6:high", smol: "anthropic/claude-haiku-5-6:low" } };
  const p = fitted({ modelRoles: roles });
  assert.equal(p.modelLine, "judged on claude-sonnet-5-5; task-high runs anthropic/claude-sonnet-5-6 here; judged on claude-haiku-5-5; smol-high runs anthropic/claude-haiku-5-6 here");
  for (const c of lineOf(p, "cost", "*").entry.candidates) assert.equal(c.model.text, null, `${c.cell}: the heading carries it`);
});

test("model names: an unset model role, or modelRoles never read, reads not checked", () => {
  const unset = { ...ROLES, value: { slow: ROLES.value.slow, smol: ROLES.value.smol } };
  const task = lineOf(fitted({ modelRoles: unset }), "cost", "*").entry.candidates[0];
  assert.deepEqual([task.model.state, task.model.text], ["not checked", "not checked: modelRoles.task unset: omp picks the model"]);
  const never = lineOf(fitted({ modelRoles: null }), "cost", "*").entry.candidates[0];
  assert.deepEqual([never.model.state, never.model.text], ["not checked", "not checked: modelRoles not read yet"]);
  assert.equal(fitted({ modelRoles: null }).modelLine, null, "a check that cannot run is not a difference");
});

test("every line has an anchor and a link, in every state", () => {
  const states = {
    "starting table": [policy(), 2],
    "Fit": [fitted(), 6],
    "no guard": [policy({ guard: { status: "missing" } }), 2],
    "no table": [policy({ table: null }), 2],
  };
  for (const [name, [p, n]] of Object.entries(states)) {
    const lines = p.objectives.flatMap((o) => o.lines.map((l) => [o.objective, l]));
    assert.equal(lines.length, n, name);
    for (const [o, l] of lines) {
      assert.equal(l.anchor, `cells-row-${o}-${l.stratum}`, name);
      assert.equal(l.href, `#cells/row/${o}/${l.stratum}`, name);
    }
  }
});

test("no Fit and no starting table read: every line says so, and the source says what was not checked", () => {
  const p = policy({ table: null });
  assert.deepEqual(p.source, { text: "starting table · no Fit yet: the next phase 0 writes one", check: "not checked: no starting table read" });
  assert.equal(p.heading, null);
  for (const o of p.objectives) assert.deepEqual(o.lines.map((l) => [l.entry, l.unread]), [[null, "no starting table read: the rows are not known"]]);
  const ce = build();
  assert.equal(ce.policy.source.check, "not checked: no starting table read", "computeCellEvidence reads a left-out table as none read");
});

test("an unreadable Fit: the starting table routes, and the source says why the Fit was not read", () => {
  const p = policy({ fit: { status: "unreadable", why: "not JSON" } });
  assert.equal(p.source.text, "starting table · the Fit is not read: not JSON");
  assert.deepEqual(lineOf(p, "cost", "*").entry.cell, "slow-high");
});

test("a Fit route routes by whose own fields are not all read: each is not checked, and the Fit's rows are laid out", () => {
  const p = fitted({ fit: FIT_READ({ computed_at: null, guard_computed_at: null, tsv_blobs: null, table: FIT({ n_rows: "235" }) }) });
  assert.deepEqual(p.source, { text: "Fit · computed: not checked: `computed_at` is not a string · Pulls: not checked: `n_rows` is not a count", check: null });
  assert.deepEqual(p.labels, ["fitted beside this guard: not checked: `guard_computed_at` is not a string", "fitted on the guard's records: not checked: the Fit names no blob ids"]);
  assert.equal(lineOf(p, "cost", "*").entry.cell, "task-high", "the Fit's own row, not the starting table's");
});

// -- the failed-Fit flag ---------------------------------------------------------------------------

const EISDIR = "EISDIR: illegal operation on a directory, open '/x/.fleet/router-fit.json.tmp'";
const refitOut = (why = EISDIR) => [
  "metrics-refresh: drain: nothing pending",
  "metrics-refresh: cost guard: verdict none; pr-cost.mjs exit 4; .fleet/cost-guard.json computed 2026-10-28T08:00:00.000Z",
  `metrics-refresh: fit: failed — ${why}`,
].join("\n");
const LAST_GOOD = `this run's Fit failed at 2026-10-28 08:00Z: ${EISDIR}; the last good Fit, computed 2026-10-26 19:17Z, routes`;
const NONE_GOOD = `this run's Fit failed at 2026-10-28 08:00Z: ${EISDIR}; no Fit is read, so the starting table routes`;
const failedAt = (at, output = refitOut()) => step("ok", at, output);

test("refitFailure reads the reason off the failed fit line, found anywhere in a line, and nothing else", () => {
  assert.equal(refitFailure(refitOut()), EISDIR);
  assert.equal(refitFailure("metrics-refresh.mjs failed: metrics-refresh: fit: failed —   spaced out  \r\nnext"), "spaced out");
  assert.equal(refitFailure("metrics-refresh: fit: skipped, no guard written — .fleet/router-fit.json left as it is"), null);
  assert.equal(refitFailure("metrics-refresh: fit: fitted 235 Pulls, in burn-in; .fleet/router-fit.json computed 2026-10-28T08:00:00.000Z"), null);
  assert.equal(refitFailure(""), null);
  assert.equal(refitFailure(null), null);
});

test("a failed Fit with a last good Fit on disk: the flag, and the last good Fit's rows", () => {
  const p = fitted({ receipts: { phase0: failedAt("2026-10-28T08:00:00.000Z"), closeout: null } });
  assert.equal(p.flag, LAST_GOOD);
  assert.equal(p.source.text, "Fit · computed 2026-10-26 19:17Z · 235 Pulls");
  assert.deepEqual(p.objectives[0].lines.map((l) => [l.stratum, l.entry.cell]), [["*", "task-high"], [ABOVE, "task-high"], [BELOW, "task-high"]]);
  const closeout = fitted({ receipts: { phase0: null, closeout: failedAt("2026-10-28T08:00:00.000Z") } });
  assert.equal(closeout.flag, LAST_GOOD, "close-out's step is read as phase 0's is");
});

test("a failed Fit with no Fit ever written: the flag, and the starting table's rows", () => {
  const receipts = { phase0: failedAt("2026-10-28T08:00:00.000Z"), closeout: null };
  for (const fit of [{ status: "missing" }, { status: "unreadable", why: "not JSON" }]) {
    const p = policy({ fit, receipts });
    assert.equal(p.flag, NONE_GOOD, fit.status);
    assert.deepEqual(p.objectives.map((o) => o.lines.map((l) => [l.stratum, l.entry.cell])), [[["*", "slow-high"]], [["*", "slow-high"]]], fit.status);
  }
});

test("no failed-Fit flag when the newest step that tried a refit has no failed line, a Fit came after it, or there is no receipt", () => {
  const older = failedAt("2026-10-28T08:00:00.000Z");
  const newer = step("ok", "2026-10-28T10:00:00.000Z", "metrics-refresh: cost guard: verdict none\nmetrics-refresh: fit: fitted 235 Pulls, in burn-in");
  assert.equal(fitted({ receipts: { phase0: older, closeout: newer } }).flag, null, "the older step's failed line is not the newest refit");
  const tie = { phase0: step("ok", "2026-10-28T08:00:00.000Z", "metrics-refresh: fit: fitted 235 Pulls"), closeout: older };
  assert.equal(fitted({ receipts: tie }).flag, null, "on equal times, phase 0's step is the newest");
  assert.equal(fitted({ receipts: { phase0: failedAt("2026-10-26T19:00:00.000Z"), closeout: null } }).flag, null, "the Fit was written after the step");
  assert.equal(fitted({ receipts: { phase0: failedAt("2026-10-26T19:17:40.000Z"), closeout: null } }).flag, null, "a Fit computed at the step's own time is not before it");
  assert.equal(fitted().flag, null, "no receipt");
  assert.equal(fitted({ receipts: { phase0: step("pending", "2026-10-28T08:00:00.000Z", refitOut()), closeout: null } }).flag, null, "a step that has not run");
});

test("a failed Fit beside a last good Fit whose computed_at is no string: flagged, the time it was computed not checked", () => {
  const p = fitted({ fit: FIT_READ({ computed_at: null }), receipts: { phase0: failedAt("2026-10-28T08:00:00.000Z"), closeout: null } });
  assert.equal(p.flag, `this run's Fit failed at 2026-10-28 08:00Z: ${EISDIR}; the last good Fit, computed: not checked: \`computed_at\` is not a string, routes`);
});

test("a newer step that tried no refit — a --no-fit close-out, or one that stopped before its refit — leaves an earlier failed Fit flagged", () => {
  const failed = failedAt("2026-10-28T08:00:00.000Z");
  const noFit = step("ok", "2026-10-28T12:00:00.000Z", "metrics-refresh: drain: nothing pending\nmetrics-refresh: cost guard: verdict none; pr-cost.mjs exit 4; .fleet/cost-guard.json computed 2026-10-28T12:00:00.000Z");
  assert.equal(fitted({ receipts: { phase0: failed, closeout: noFit } }).flag, LAST_GOOD, "a close-out computes no Fit");
  const stopped = step("failed", "2026-10-28T10:00:00.000Z", "metrics-refresh.mjs failed: metrics-refresh: drain failed: pending file malformed");
  assert.equal(fitted({ receipts: { phase0: stopped, closeout: failed } }).flag, LAST_GOOD, "a step that stopped before its refit");
});

test("a Fit whose computed_at is no time counts as not after the step, so the flag shows", () => {
  const p = fitted({ receipts: { phase0: failedAt("2026-10-28T08:00:00.000Z"), closeout: null }, fit: FIT_READ({ computed_at: "garbage" }) });
  assert.equal(p.flag, `this run's Fit failed at 2026-10-28 08:00Z: ${EISDIR}; the last good Fit, computed garbage, routes`);
});

test("a step whose at is no time has not run, so its failed line raises no flag and a dated step beside it is the newest", () => {
  const untimedOut = refitOut("ENOSPC: no space left on device");
  for (const at of ["garbage", "", null, undefined]) {
    const untimed = failedAt(at, untimedOut);
    assert.equal(fitted({ receipts: { phase0: untimed, closeout: null } }).flag, null, `phase 0 at ${JSON.stringify(at)}`);
    assert.equal(fitted({ receipts: { phase0: null, closeout: untimed } }).flag, null, `close-out at ${JSON.stringify(at)}`);
    const dated = failedAt("2026-10-28T08:00:00.000Z");
    assert.equal(fitted({ receipts: { phase0: untimed, closeout: dated } }).flag, LAST_GOOD, `untimed phase 0 at ${JSON.stringify(at)}`);
    assert.equal(fitted({ receipts: { phase0: dated, closeout: untimed } }).flag, LAST_GOOD, `untimed close-out at ${JSON.stringify(at)}`);
  }
});

// -- Cells this install does not run ------------------------------------------------------------

const SMOL_NONE = { ...CATALOG, value: { models: CATALOG.value.models.map((m) => (m.selector === "anthropic/claude-haiku-5-5" ? { ...m, thinking: null } : m)) } };

test("the Cells the install does not run are listed with their role, model and levels, apart from the tripped Cells", () => {
  const p = policy({ guard: guardOk(TODAY().guard.cells, { verdict: "tripped", tripped: ["task-high"] }) });
  assert.equal(p.tripped, "tripped by the cost guard: task-high");
  assert.deepEqual(p.unrunnable, {
    heading: "not run by this install: smol-max",
    cells: [{
      cell: "smol-max", role: "smol", model: "anthropic/claude-haiku-5-5", levels: ["low", "medium", "high", "xhigh"],
      text: "smol-max · modelRoles.smol → anthropic/claude-haiku-5-5 runs low, medium, high, xhigh",
    }],
  });
  assert.equal(JSON.stringify(p.tripped).includes("smol-max"), false, "an unrunnable Cell is not a tripped one");
  const none = policy({ catalog: SMOL_NONE }).unrunnable;
  assert.equal(none.heading, "not run by this install: smol-high, smol-low, smol-max, smol-medium and smol-xhigh");
  assert.equal(none.cells[0].text, "smol-high · modelRoles.smol → anthropic/claude-haiku-5-5 runs none");
  const unset = policy({ modelRoles: { ...ROLES, value: { ...ROLES.value, task: undefined } } }).unrunnable;
  assert.equal(unset.cells.find((c) => c.cell === "task-high").text, "task-high · modelRoles.task → no model runs none");
  const clear = policy({ catalog: { ...CATALOG, value: { models: CATALOG.value.models.map((m) => ({ ...m, thinking: LADDER })) } } }).unrunnable;
  assert.deepEqual(clear, { heading: "the install runs every Cell it has a definition for", cells: [] });
  const unread = policy({ catalog: null }).unrunnable;
  assert.deepEqual(unread, { heading: "unrunnable Cells: not checked: omp's model catalog not read yet", cells: [] });
});

test("a policy row naming a Cell the install does not run shows the default Cell, held, as route does", () => {
  const rows = { "*": "smol-max", [ABOVE]: "smol-max", [BELOW]: "task-high" };
  const p = fitted({ fit: FIT_READ({ table: FIT({ rows: { cost: rows, speed: rows } }) }) });
  for (const o of ["cost", "speed"]) {
    const unrunnable = lineOf(p, o, "*").entry;
    assert.deepEqual([unrunnable.cell, unrunnable.held], ["slow-high", "smol-max unrunnable here"], o);
    assert.deepEqual([lineOf(p, o, BELOW).entry.cell, lineOf(p, o, BELOW).entry.held], ["task-high", null], o);
  }
  // The same table on an install that runs smol-max leaves the row alone: the view reads the install, as route does.
  const runs = fitted({ fit: FIT_READ({ table: FIT({ rows: { cost: rows, speed: rows } }) }), catalog: { ...CATALOG, value: { models: CATALOG.value.models.map((m) => ({ ...m, thinking: LADDER })) } } });
  assert.deepEqual([lineOf(runs, "cost", "*").entry.cell, lineOf(runs, "cost", "*").entry.held], ["smol-max", null]);
  // With the install unread nothing is checked, as route does with an unread install.
  assert.equal(lineOf(fitted({ fit: FIT_READ({ table: FIT({ rows: { cost: rows, speed: rows } }) }), catalog: null }), "cost", "*").entry.cell, "smol-max");
});

test("a derived default Cell replaces slow-high in the view where the install does not run it", () => {
  const slowNoHigh = { ...CATALOG, value: { models: CATALOG.value.models.map((m) => (m.selector === "anthropic/claude-opus-5" ? { ...m, thinking: ["low", "medium", "xhigh", "max"] } : m)) } };
  const p = policy({ catalog: slowNoHigh });
  assert.equal(lineOf(p, "cost", "*").entry.cell, "slow-medium");
  assert.equal(lineOf(p, "cost", "*").entry.held, "slow-high unrunnable here");
});

test("burn-in progress counts the starting Cells the Fit recorded, and says which it left out", () => {
  const two = FIT({ burn_in: true, starting_cells: ["slow-high", "task-high"], guard: { tripped: [], n: { "slow-high": 69, "task-high": 12 } } });
  assert.deepEqual(fitted({ fit: FIT_READ({ table: two }) }).burnIn, {
    heading: "burn-in: 1 of 2 runnable starting Cells has the 20 merged PRs each needs; smol-high unrunnable",
    cells: [{ cell: "slow-high", n: 69, of: 20 }, { cell: "task-high", n: 12, of: 20 }],
  });
  const ended = FIT({ burn_in: false, starting_cells: ["slow-high", "task-high"], guard: { tripped: [], n: { "slow-high": 69, "task-high": 69 } } });
  assert.equal(fitted({ fit: FIT_READ({ table: ended }) }).burnIn.heading, "burn-in ended: every runnable starting Cell has its 20 merged PRs; smol-high unrunnable");
  // A Fit that records no set counted all three, so the cockpit's own install read decides nothing for it.
  assert.equal(fitted({ fit: FIT_READ({ table: FIT({ burn_in: true, guard: { tripped: [], n: {} } }) }), catalog: SMOL_NONE }).burnIn.heading, "burn-in: 0 of 3 starting Cells have the 20 merged PRs each needs");
  assert.equal(fitted({ fit: FIT_READ({ table: FIT({ burn_in: true, starting_cells: ["nope"], guard: { tripped: [], n: {} } }) }) }).burnIn.cells.length, 3, "a record that names no starting Cell is none");
});

test("while the starting table routes, burn-in progress counts the starting Cells the cockpit's own install read runs", () => {
  const p = policy({ catalog: SMOL_NONE });
  assert.deepEqual(p.burnIn, {
    heading: "burn-in: 2 of 2 runnable starting Cells have the 20 merged PRs each needs; smol-high unrunnable",
    cells: [{ cell: "slow-high", n: 69, of: 20 }, { cell: "task-high", n: 69, of: 20 }],
  });
  assert.equal(p.burnIn.cells.length, 2);
  assert.equal(policy({ catalog: null }).burnIn.heading, "burn-in: 3 of 3 starting Cells have the 20 merged PRs each needs", "an unread install counts all three");
  assert.equal(lineOf(policy({ catalog: SMOL_NONE }), "cost", "*").exploring, "drawn over slow-high and task-high");
});
