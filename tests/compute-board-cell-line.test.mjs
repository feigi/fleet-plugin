// The card's Cell line (docs/specs/2026-10-27-cockpit-tabs-design.md § 7):
// compute-board.mjs's cellLine, pure, and the Cell lines computeBoard puts on
// its cards and books into the Cell evidence tab's "this run's Pulls".
//   node --test tests/compute-board-cell-line.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellLine, computeBoard } from "../plugin/scripts/compute-board.mjs";
import { formatRouting } from "../plugin/scripts/ledger-grammar.mjs";
import { identityRoles } from "./support/label-map-seed.mjs";

// A part list as one string: each part after its separator, a hole in _…_, a link's hash in <…>.
const says = (parts) => parts.map((p) => `${p.sep}${p.dim ? `_${p.text}_` : p.text}${p.href ? `<${p.href}>` : ""}`).join("");
const lines = (l) => l.lines.map(says);

// A Routing line; every part `route` prints, defaulted to a not-drawn heavy cost Pull.
const routing = (o = {}) => formatRouting({
  policy: "slow-high", cell: "slow-high", draw: null, by: null, stratum: "heavy", brief: 9658, criteria: 8,
  sized: null, objective: "cost", tripped: [], reason: "ok", ...o,
});
// An implementer's member record, as gather() keeps it.
const rec = (cell, { model = "claude-haiku-5-5", thinking = cell.split("-")[1], last = model, definition = `fleet-implementer-${cell}` } = {}) => ({
  model: last, resolvedModelIdentity: `anthropic/${model}`, thinking, subagent_type: definition,
});
const members = (o) => new Map(Object.entries(o));

// The spec's own example: a Pull drawn under burn-in, its first implementer Admissible.
const drawn = (o = {}) => cellLine({
  row: "#3747 impl-3747 · tier=smol-high",
  issue: 3747,
  routed: [`impl-3747 ${routing({ cell: "smol-high", draw: { k: 2, K: 3 }, by: "burn-in", ...o })}`],
  members: members({ "impl-3747": rec("smol-high") }),
});

test("cellLine: the spec's example reads Cell · why, then Stratum with its numbers · model · level", () => {
  const l = drawn();
  assert.deepEqual(lines(l), [
    "smol-high<#cells/smol-high@claude-haiku-5-5> · drawn 2 of 3: burn-in",
    "heavy: 9,658 chars (past 3,483), 8 criteria (past 5) · claude-haiku-5-5 · high",
  ]);
  assert.equal(l.cell, "smol-high");
  assert.equal(l.generation, "claude-haiku-5-5");
  assert.equal(l.mark, null);
  assert.deepEqual(l.targets, [{ cell: "smol-high", generation: "claude-haiku-5-5" }]);
});

// -- § 7.2, every reason ------------------------------------------------------

test("cellLine: a draw after burn-in reads every 5th Pull", () => {
  assert.equal(lines(drawn({ by: "every-5th", draw: { k: 1, K: 2 } }))[0], "smol-high<#cells/smol-high@claude-haiku-5-5> · drawn 1 of 2: every 5th Pull");
});

test("cellLine: a draw with a tripped Cell left out names it", () => {
  assert.equal(lines(drawn({ reason: "guard-tripped", tripped: ["task-high"] }))[0],
    "smol-high<#cells/smol-high@claude-haiku-5-5> · drawn 2 of 3: burn-in · left out as tripped: task-high");
});

const undrawn = (o = {}, table = null, cell = "slow-high") => cellLine({
  row: "#9 impl-9", issue: 9, routed: [`impl-9 ${routing({ cell, policy: cell, ...o })}`], members: members({ "impl-9": rec(cell) }), table,
});

test("cellLine: not drawn, ok, reads the policy row, linked to it", () => {
  assert.equal(lines(undrawn())[0], "slow-high<#cells/slow-high@claude-haiku-5-5> · cost row, heavy<#cells/row/cost/heavy>");
  assert.equal(lines(undrawn({ objective: "speed", stratum: "light", brief: 900, criteria: 2 }))[0],
    "slow-high<#cells/slow-high@claude-haiku-5-5> · speed row, light<#cells/row/speed/light>");
});

test("cellLine: not drawn, ok, follows * only off a table that has no row for the Stratum", () => {
  const star = { rows: { cost: { "*": "slow-high" }, speed: { "*": "slow-high" } } };
  const heavy = { rows: { cost: { "*": "slow-high", heavy: "slow-high" }, speed: { "*": "slow-high" } } };
  assert.equal(lines(undrawn({}, star))[0], "slow-high<#cells/slow-high@claude-haiku-5-5> · cost row, heavy<#cells/row/cost/*> · follows *");
  assert.equal(lines(undrawn({}, heavy))[0], "slow-high<#cells/slow-high@claude-haiku-5-5> · cost row, heavy<#cells/row/cost/heavy>");
  assert.equal(lines(undrawn({}, null))[0], "slow-high<#cells/slow-high@claude-haiku-5-5> · cost row, heavy<#cells/row/cost/heavy>", "no table read: nothing guessed");
});

test("cellLine: the policy row's Cell tripped reads the default Cell, naming the tripped Cell", () => {
  assert.equal(lines(undrawn({ reason: "table-cell-tripped", tripped: ["task-high"] }))[0],
    "slow-high<#cells/slow-high@claude-haiku-5-5> · cost row's task-high tripped: default Cell<#cells/row/cost/heavy>");
  assert.equal(lines(undrawn({ reason: "table-cell-tripped", tripped: ["smol-high", "task-high"] }))[0],
    "slow-high<#cells/slow-high@claude-haiku-5-5> · cost row's Cell (one of smol-high, task-high) tripped: default Cell<#cells/row/cost/heavy>",
    "two tripped: the row's is not on record, so neither is named as it");
  assert.equal(lines(drawn({ reason: "table-cell-tripped", tripped: ["task-high"] }))[0],
    "smol-high<#cells/smol-high@claude-haiku-5-5> · drawn 2 of 3: burn-in · cost row's task-high tripped<#cells/row/cost/heavy>",
    "drawn: the draw, then the reason, and no default Cell");
});

test("cellLine: no guard, and no Cell left to draw", () => {
  assert.equal(lines(undrawn({ reason: "guard-missing" }))[0], "slow-high<#cells/slow-high@claude-haiku-5-5> · no cost guard yet: default Cell only");
  assert.equal(lines(undrawn({ reason: "guard-tripped", tripped: ["task-high", "smol-high"] }))[0],
    "slow-high<#cells/slow-high@claude-haiku-5-5> · every other Cell tripped: no draw");
});

test("cellLine: an issue unread when routed, and no sizing, read the Stratum unknown", () => {
  assert.deepEqual(lines(undrawn({ reason: "no-issue-json", stratum: "unknown", brief: null, criteria: null })), [
    "slow-high<#cells/slow-high@claude-haiku-5-5> · issue unreadable when routed",
    "unknown: no brief read · claude-haiku-5-5 · high",
  ]);
  assert.deepEqual(lines(undrawn({ reason: "no-sizing", stratum: "unknown" })), [
    "slow-high<#cells/slow-high@claude-haiku-5-5> · no sizing",
    "unknown: no sizing · claude-haiku-5-5 · high",
  ]);
});

test("cellLine: a reason the card has no words for, and an entry that is no Routing, read recorded as …", () => {
  const entry = "POLICY=slow-high CELL=slow-high DRAW=- BY=- STRATUM=heavy BRIEF=1 CRITERIA=1 SIZED=- OBJECTIVE=cost TRIPPED=- REASON=frobbed";
  const l = cellLine({ row: "#9 impl-9 · tier=task-high", issue: 9, routed: [`impl-9 ${entry}`], members: members({ "impl-9": rec("task-high") }) });
  assert.deepEqual(lines(l), [
    `task-high<#cells/task-high@claude-haiku-5-5> · recorded as ${entry}`,
    "_not on record_ · claude-haiku-5-5 · high",
  ], "no Routing to read: its Cell from tier=, its Stratum not on record");
});

// -- the Stratum ------------------------------------------------------------

test("cellLine: the Stratum's numbers say which side of each threshold they sit", () => {
  assert.equal(lines(undrawn({ stratum: "light", brief: 1200, criteria: 2 }))[1], "light: 1,200 chars (not past 3,483), 2 criteria (not past 5) · claude-haiku-5-5 · high");
  assert.equal(lines(undrawn({ stratum: "heavy", brief: 13638, criteria: 11 }))[1], "heavy: 13,638 chars (past 3,483), 11 criteria (past 5) · claude-haiku-5-5 · high");
  assert.equal(lines(undrawn({ stratum: "heavy", brief: 3483, criteria: 6 }))[1], "heavy: 3,483 chars (not past 3,483), 6 criteria (past 5) · claude-haiku-5-5 · high");
});

test("cellLine: under arm B the Stratum reads its sizing label", () => {
  assert.equal(lines(undrawn({ stratum: "heavy", sized: "heavy" }))[1], "heavy: sized heavy · claude-haiku-5-5 · high");
});

// -- the model -----------------------------------------------------------------

test("cellLine: a last turn on another model adds fell back to it", () => {
  const l = cellLine({ row: "#9 impl-9", issue: 9, routed: [`impl-9 ${routing()}`], members: members({ "impl-9": rec("slow-high", { model: "claude-opus-5", last: "claude-sonnet-5" }) }) });
  assert.equal(lines(l)[1], "heavy: 9,658 chars (past 3,483), 8 criteria (past 5) · claude-opus-5 · high · fell back to claude-sonnet-5");
  assert.equal(l.generation, "claude-opus-5", "the generation is the dispatch model, not the last turn's");
});

test("cellLine: no transcript reads the model not on record, and the link goes to the Cell's entry", () => {
  const l = cellLine({ row: "#9 impl-9", issue: 9, routed: [`impl-9 ${routing()}`] });
  assert.deepEqual(lines(l), ["slow-high<#cells/slow-high> · cost row, heavy<#cells/row/cost/heavy>", "heavy: 9,658 chars (past 3,483), 8 criteria (past 5) · _not on record_"]);
  assert.equal(l.mark, null, "nothing says it ran off its Cell");
  const noLevel = cellLine({ row: "#9 impl-9", issue: 9, routed: [`impl-9 ${routing()}`], members: members({ "impl-9": rec("slow-high", { thinking: "-" }) }) });
  assert.equal(lines(noLevel)[1], "heavy: 9,658 chars (past 3,483), 8 criteria (past 5) · claude-haiku-5-5 · _not on record_");
});

// -- rows written before the Routing --------------------------------------------

test("cellLine: a row before the Routing takes its Cell from tier=, reads its route= as recorded as …, and the rest not on record", () => {
  const row = "#3862 impl-3862 · tier=slow-high · route=guard-tripped · tier-ok=impl-3862:fleet-implementer-slow-high";
  const l = cellLine({ row, issue: 3862, agents: { "impl-3862": "fleet-implementer-slow-high" }, members: members({ "impl-3862": rec("slow-high", { model: "claude-opus-5" }) }) });
  assert.deepEqual(lines(l), [
    "slow-high<#cells/slow-high@claude-opus-5> · recorded as guard-tripped",
    "_not on record_ · claude-opus-5 · high",
  ]);
  assert.equal(l.mark, null);
  const bare = cellLine({ row: "#12 impl-12 · tier=task-high", issue: 12 });
  assert.deepEqual(lines(bare), ["task-high<#cells/task-high> · _not on record_", "_not on record_ · _not on record_"]);
});

test("cellLine: a row naming none of its own ticket's impl tokens takes the others in attempt order, by number then retry", () => {
  const l = cellLine({
    row: "#20 impl-31-b impl-30 impl-31 · tier=slow-high", issue: 20,
    members: members({
      "impl-30": rec("slow-high", { model: "claude-opus-5" }),
      "impl-31": rec("slow-high", { model: "claude-sonnet-5" }),
      "impl-31-b": rec("slow-high", { model: "claude-haiku-5-5" }),
    }),
  });
  assert.equal(l.generation, "claude-haiku-5-5", "the latest attempt, impl-31-b, is the Pull");
});

test("cellLine: a tier= that names no Cell links nowhere and books no guard entry", () => {
  const l = cellLine({ row: "#12 impl-12 · tier=bogus", issue: 12 });
  assert.equal(lines(l)[0], "bogus · _not on record_");
  assert.deepEqual(l.targets, []);
});

// -- § 7.3, the mark --------------------------------------------------------------

// #3777: drew task-high, its first implementer dispatched as slow-high and
// stopped by the tier check, impl-3777-b ran as task-high.
const shape3777 = (routed) => cellLine({
  row: `#3777 impl-3777=tier-mismatch impl-3777-b=PR#3790 · tier=task-high${routed ? "" : " · route=ok"}`,
  issue: 3777,
  routed: routed ? [`impl-3777 ${routing({ cell: "task-high", draw: { k: 1, K: 2 }, by: "burn-in" })}`] : [],
  agents: { "impl-3777": "fleet-implementer-slow-high", "impl-3777-b": "fleet-implementer-task-high" },
  members: members({ "impl-3777": rec("slow-high", { model: "claude-opus-5" }), "impl-3777-b": rec("task-high", { model: "claude-sonnet-5" }) }),
});

test("cellLine: the #3777 shape marks the first implementer, and shows the one that ran at the Cell", () => {
  const l = shape3777(true);
  assert.deepEqual(l.mark, { text: "⚑ first ran as fleet-implementer-slow-high", severity: "amber" });
  assert.equal(l.generation, "claude-sonnet-5");
  assert.match(lines(l)[1], / · claude-sonnet-5 · high$/);
  assert.doesNotMatch(lines(l)[0], /rescue/, "impl-3777-b ran at the Pull's own Cell: no rescue");
  assert.equal(lines(l)[0], "task-high<#cells/task-high@claude-sonnet-5> · drawn 1 of 2: burn-in");
});

test("cellLine: before the Routing the Pull is the row's latest impl token, so an earlier implementer is never marked", () => {
  // tier= is rewritten to each later implementer's Cell, so on a row with no
  // `## Routed` entry an earlier implementer off it reads the same as a rescue.
  const l = shape3777(false);
  assert.equal(l.mark, null);
  assert.equal(l.generation, "claude-sonnet-5");
  assert.deepEqual(lines(l), ["task-high<#cells/task-high@claude-sonnet-5> · recorded as ok", "_not on record_ · claude-sonnet-5 · high"]);
});

test("cellLine: a first implementer at another level, with a later Admissible row, is marked at its level", () => {
  const l = cellLine({
    row: "#5 impl-5=killed impl-5-b", issue: 5, routed: [`impl-5 ${routing({ cell: "task-high", policy: "task-high" })}`],
    members: members({ "impl-5": rec("task-high", { thinking: "medium" }), "impl-5-b": rec("task-high") }),
  });
  assert.deepEqual(l.mark, { text: "⚑ first ran at medium, not high", severity: "amber" });
});

test("cellLine: no Admissible row marks the Pull red: it counts in no Cell's figures", () => {
  const offDef = cellLine({
    row: "#3885 impl-3885", issue: 3885, routed: [`impl-3885 ${routing({ cell: "task-high", policy: "task-high" })}`],
    agents: { "impl-3885": "fleet-implementer-slow-high" }, members: members({ "impl-3885": rec("slow-high") }),
  });
  assert.deepEqual(offDef.mark, { text: "⚑ ran as fleet-implementer-slow-high: no Admissible row, so it counts in no Cell's figures", severity: "red" });
  assert.equal(offDef.generation, null);
  assert.deepEqual(offDef.targets, [{ cell: "task-high", generation: null }]);

  const noModel = cellLine({
    row: "#6 impl-6", issue: 6, routed: [`impl-6 ${routing()}`],
    members: members({ "impl-6": { ...rec("slow-high"), resolvedModelIdentity: null } }),
  });
  assert.deepEqual(noModel.mark, { text: "⚑ no model on record: no Admissible row, so it counts in no Cell's figures", severity: "red" });

  const offLevel = cellLine({ row: "#7 impl-7", issue: 7, routed: [`impl-7 ${routing()}`], members: members({ "impl-7": rec("slow-high", { thinking: "low" }) }) });
  assert.deepEqual(offLevel.mark, { text: "⚑ ran at low, not high: no Admissible row, so it counts in no Cell's figures", severity: "red" });
});

test("cellLine: with no transcript to read, whether it counts is not checked", () => {
  const l = cellLine({
    row: "#3885 impl-3885", issue: 3885, routed: [`impl-3885 ${routing({ cell: "task-high", policy: "task-high" })}`],
    agents: { "impl-3885": "fleet-implementer-slow-high" },
  });
  assert.deepEqual(l.mark, { text: "⚑ ran as fleet-implementer-slow-high: not checked", severity: "amber" });
});

test("cellLine: ran as reads agent=, else tier-ok=, else the transcript", () => {
  const base = { row: "#8 impl-8 · tier-ok=impl-8:fleet-implementer-smol-high", issue: 8, routed: [`impl-8 ${routing({ cell: "task-high", policy: "task-high" })}`] };
  assert.equal(cellLine({ ...base, agents: { "impl-8": "fleet-implementer-slow-high" } }).mark.text, "⚑ ran as fleet-implementer-slow-high: not checked");
  assert.equal(cellLine(base).mark.text, "⚑ ran as fleet-implementer-smol-high: not checked");
  assert.equal(cellLine({ ...base, row: "#8 impl-8", members: members({ "impl-8": rec("slow-medium") }) }).mark.text,
    "⚑ ran as fleet-implementer-slow-medium: no Admissible row, so it counts in no Cell's figures");
});

// -- rescue, and which Pull ------------------------------------------------------

test("cellLine: a later implementer at another Cell is a rescue: its Cell and its own model, and no mark", () => {
  const l = cellLine({
    row: "#4 impl-4=killed impl-4-b=PR#40 · tier=slow-high", issue: 4,
    routed: [`impl-4 ${routing({ cell: "smol-high", draw: { k: 2, K: 3 }, by: "burn-in" })}`],
    agents: { "impl-4": "fleet-implementer-smol-high", "impl-4-b": "fleet-implementer-slow-high" },
    members: members({ "impl-4": rec("smol-high"), "impl-4-b": rec("slow-high", { model: "claude-opus-5" }) }),
  });
  assert.equal(lines(l)[0], "smol-high<#cells/smol-high@claude-haiku-5-5> · drawn 2 of 3: burn-in · rescue at slow-high<#cells/slow-high@claude-opus-5> claude-opus-5 · high");
  assert.equal(lines(l)[1], "heavy: 9,658 chars (past 3,483), 8 criteria (past 5) · claude-haiku-5-5 · high", "the model is the Pull's first implementer's");
  assert.equal(l.mark, null);
  assert.deepEqual(l.targets, [{ cell: "smol-high", generation: "claude-haiku-5-5" }, { cell: "slow-high", generation: "claude-opus-5" }]);

  const unread = cellLine({
    row: "#4 impl-4=killed impl-4-b · tier=slow-high", issue: 4, routed: [`impl-4 ${routing({ cell: "smol-high", draw: { k: 2, K: 3 }, by: "burn-in" })}`],
    agents: { "impl-4": "fleet-implementer-smol-high", "impl-4-b": "fleet-implementer-slow-high" }, members: members({ "impl-4": rec("smol-high") }),
  });
  assert.match(lines(unread)[0], / · rescue at slow-high<#cells\/slow-high> _not on record_$/);
});

test("cellLine: the latest Pull is the last implementer with a Routing; one with none is under it", () => {
  const l = cellLine({
    row: "#3 impl-3=released impl-3-b=killed impl-3-c", issue: 3,
    routed: [`impl-3 ${routing({ cell: "slow-high" })}`, `impl-3-b ${routing({ cell: "task-high", policy: "task-high", draw: { k: 1, K: 2 }, by: "every-5th" })}`],
    members: members({ "impl-3-b": rec("task-high", { thinking: "medium" }), "impl-3-c": rec("task-high") }),
  });
  assert.equal(lines(l)[0], "task-high<#cells/task-high@claude-haiku-5-5> · drawn 1 of 2: every 5th Pull");
  assert.deepEqual(l.mark, { text: "⚑ first ran at medium, not high", severity: "amber" }, "judged: impl-3-b, the Pull's first, not impl-3");
});

test("cellLine: a row with no impl token has no Cell line", () => {
  assert.equal(cellLine({ row: "#3901 PR#3901 · inherited (closes #3859)", issue: 3901 }), null);
});

// -- on the board -------------------------------------------------------------------

// Shaped like the ledger's live rows on 2026-10-28: tier=, route=, tier-ok= and a
// `## Dispatched` agent=, and no `## Routed` entry.
const liveInputs = () => ({
  ledger: {
    rows: [
      "#3862 impl-3862 · tier=slow-high · route=guard-tripped · tier-ok=impl-3862:fleet-implementer-slow-high",
      "#3865 impl-3865=PR#3949 · tier=task-high · route=guard-tripped · tier-ok=impl-3865:fleet-implementer-task-high · review=member:review-pr-3949",
      "#3898 impl-3898 · tier=slow-high · route=guard-tripped · tier-ok=impl-3898:fleet-implementer-slow-high",
      "#3901 PR#3901 · inherited (closes #3859) · review=member:review-pr-3901",
      "#3907 excluded · behind-pr:#3949",
    ],
    dispatched: ["impl-3865=PR#3949", "impl-3862", "impl-3898"],
    agents: { "impl-3865": "fleet-implementer-task-high", "impl-3862": "fleet-implementer-slow-high", "impl-3898": "fleet-implementer-slow-high" },
    routed: [],
    filed: [], ruled: [],
  },
  issues: [{ number: 4000, title: "a pooled ticket", labels: ["ready-for-agent"] }],
  prs: [{ number: 3949, state: "OPEN", labels: [], title: "t" }, { number: 3901, state: "OPEN", labels: [], title: "t" }],
  ci: {},
  prev: null,
  roles: identityRoles(),
  now: 1000,
  implementers: [
    { member: "impl-3862", ...rec("slow-high", { model: "claude-opus-5" }) },
    { member: "impl-3865", ...rec("task-high", { model: "claude-sonnet-5" }) },
    { member: "impl-3898", ...rec("slow-high", { model: "claude-opus-5" }) },
  ],
});

test("computeBoard: today's cards show their Cell from tier=, their model and level, and not on record for the rest", () => {
  const b = computeBoard(liveInputs());
  const line = (n) => b.tickets.find((t) => t.issue === n).cellLine;
  assert.deepEqual(lines(line(3862)), ["slow-high<#cells/slow-high@claude-opus-5> · recorded as guard-tripped", "_not on record_ · claude-opus-5 · high"]);
  assert.deepEqual(lines(line(3865)), ["task-high<#cells/task-high@claude-sonnet-5> · recorded as guard-tripped", "_not on record_ · claude-sonnet-5 · high"]);
  assert.deepEqual(lines(line(3898)), ["slow-high<#cells/slow-high@claude-opus-5> · recorded as guard-tripped", "_not on record_ · claude-opus-5 · high"]);
});

test("computeBoard: POOL cards and PR-only rows carry no Cell line", () => {
  const b = computeBoard(liveInputs());
  const t = (n) => b.tickets.find((x) => x.issue === n);
  assert.equal(t(3901).column, "REVIEW");
  assert.equal(t(3901).cellLine, null, "a PR-only row");
  assert.equal(t(3907).column, "POOL");
  assert.equal(t(3907).cellLine, null, "an Exclusion");
  assert.equal(t(4000).column, "POOL");
  assert.equal(t(4000).cellLine, null, "an unrowed ready issue");
});

test("computeBoard: the =tier-mismatch attention flag is unchanged by the mark", () => {
  const inputs = liveInputs();
  inputs.ledger.rows = ["#3777 impl-3777=tier-mismatch · tier=task-high"];
  inputs.ledger.agents = { "impl-3777": "fleet-implementer-slow-high" };
  const t = computeBoard(inputs).tickets.find((x) => x.issue === 3777);
  assert.deepEqual(t.flags, ["tier-mismatch"]);
  assert.equal(t.cellLine.mark.text, "⚑ ran as fleet-implementer-slow-high: not checked");
});

test("computeBoard: each card's Pull is booked As-routed under its Cell's guard entry, mark and all", () => {
  const inputs = liveInputs();
  inputs.ledger.rows.push("#3885 impl-3885 · tier=task-high");
  inputs.ledger.agents["impl-3885"] = "fleet-implementer-slow-high";
  inputs.implementers.push({ member: "impl-3885", ...rec("slow-high") });
  const cells = computeBoard(inputs).cellEvidence.guard.cells;
  const pulls = (cell) => cells.find((c) => c.cell === cell).pulls;
  assert.deepEqual(pulls("slow-high"), [{ issue: 3862, href: "#board/3862", mark: null }, { issue: 3898, href: "#board/3898", mark: null }]);
  assert.deepEqual(pulls("task-high"), [
    { issue: 3865, href: "#board/3865", mark: null },
    { issue: 3885, href: "#board/3885", mark: { text: "⚑ ran as fleet-implementer-slow-high: no Admissible row, so it counts in no Cell's figures", severity: "red" } },
  ], "no Admissible row: still listed under the Cell it was routed to");
  assert.deepEqual(pulls("smol-high"), []);
});
