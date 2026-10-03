// pr-cost.mjs: booking, the per-cell figures, and the guard's exit contract,
// over synthetic member-outcomes / tier-outcomes / ticket-features TSVs and a
// stub `gh` that answers the one `gh pr list` from a fixture file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.mjs";
import { writeExecStub } from "./exec-stub.mjs";
import { COLUMNS as MEMBER_COLUMNS, formatTsv, parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { COLUMNS as TIER_COLUMNS, formatRow, parseTierOutcomes } from "./tier-outcomes.mjs";
import {
  computeReport, parseFeatures, trips, guardFile, formatReport,
  FEATURE_COLUMNS, WINDOW_START, MIN_N,
} from "./pr-cost.mjs";

const SCRIPT = fileURLToPath(new URL("./pr-cost.mjs", import.meta.url));
const DAY = WINDOW_START;
const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";

// One world: member rows, tier rows, Pulls and PR states, built up by helpers
// and rendered into the three files the CLI reads.
function world() {
  return { members: [], tiers: [], features: [], prs: [] };
}
const member = (o) => ({
  session: SESSION, run_date: DAY, role: "implementer", member: o.agent, model: "claude-opus-5",
  effort: "high", ticket: "", pr: "", tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1,
  harness: "omp", subagentType: "", tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: 0, ...o,
});
const pull = (o) => ({
  run_date: DAY, session: SESSION, policy_cell: "slow-high", exploration_draw: "", sizing_src: "rule",
  sizing_pre: "", router_usd: "", brief_chars: "100", criteria: "1", comments: "0", age_days: "0",
  paths: "0", test_paths: "0", xrefs: "0", kind: "enhancement", ...o,
});
const tier = (o) => ({
  run_date: DAY, class: "", tier: "", closed_own_ticket: "yes", minted_false_claim: "no", note: "n",
  sizing: "light", profile: "small", loc: "10", files: "1", ...o,
});

// A whole ruled PR: one Pull at `cell` costing `usd`, its verdict, its state.
function addPr(w, { ticket, pr, cell, usd, fail = false, state = "MERGED", agent = `impl-${ticket}` }) {
  const level = cell.split("-")[1];
  w.features.push(pull({ ticket: String(ticket), agent, chosen_cell: cell }));
  w.members.push(member({ agent, cost: usd, effort: level, subagentType: `fleet-implementer-${cell}`, pr: String(pr) }));
  w.tiers.push(tier({ pr: String(pr), ticket: String(ticket), minted_false_claim: fail ? "yes" : "no" }));
  w.prs.push({ number: pr, state, mergedAt: state === "MERGED" ? `${DAY}T12:00:00Z` : null });
}
// `n` merged PRs at `cell`, `failures` of them failing the floor, each costing `usd`.
let nextTicket = 1000;
function addCell(w, cell, n, failures, usd) {
  for (let i = 0; i < n; i++) {
    const t = nextTicket++;
    addPr(w, { ticket: t, pr: t + 5000, cell, usd, fail: i < failures });
  }
}

const parsed = (w) => ({
  members: parseMemberTsv(formatTsv(w.members)),
  tiers: parseTierOutcomes(w.tiers.map(formatRow).join("\n")),
  features: parseFeatures(featuresText(w)),
  prs: w.prs,
});
const featuresText = (w) => [FEATURE_COLUMNS.join("\t"), ...w.features.map((f) => FEATURE_COLUMNS.map((c) => f[c] ?? "").join("\t"))].join("\n") + "\n";

function runCli(w, args = ["--guard"], { features } = {}) {
  const dir = tempDir("pr-cost-");
  mkdirSync(join(dir, "docs", "metrics"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "docs", "metrics", "member-outcomes.tsv"), `# ${MEMBER_COLUMNS.join("\t")}\n${formatTsv(w.members)}`);
  writeFileSync(join(dir, "docs", "metrics", "tier-outcomes.tsv"), `# ${TIER_COLUMNS.join("\t")}\n${w.tiers.map(formatRow).join("\n")}\n`);
  writeFileSync(join(dir, "docs", "metrics", "ticket-features.tsv"), features ?? featuresText(w));
  writeFileSync(join(dir, "prs.json"), JSON.stringify(w.prs));
  writeExecStub(join(dir, "bin", "gh"), `#!/bin/sh\n[ "$1 $2" = "pr list" ] || exit 9\nprintf '%s\\n' "$@" > "$FIXTURE_PRS.args"\ncat "$FIXTURE_PRS"\n`);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FIXTURE_PRS: join(dir, "prs.json") },
  });
  const guardPath = join(dir, ".fleet", "cost-guard.json");
  const argsPath = join(dir, "prs.json.args");
  return {
    ...r,
    guard: existsSync(guardPath) ? JSON.parse(readFileSync(guardPath, "utf8")) : null,
    ghArgs: existsSync(argsPath) ? readFileSync(argsPath, "utf8").trim().split("\n") : null,
  };
}

// ---------------------------------------------------------------------------
// The guard's exit contract.

test("--guard: a cell exactly 15 points worse than the baseline trips, exits 3 and is named in tripped[]", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 6, 10);   // 30% fail, $10
  addCell(w, "task-high", MIN_N, 9, 5);    // 45% fail: +15 points, exactly the margin
  addCell(w, "smol-high", MIN_N, 8, 3);    // 40% fail: +10 points, under it
  const r = runCli(w);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(r.guard.tripped, ["task-high"]);
  assert.equal(r.guard.verdict, "tripped");
  assert.deepEqual(r.guard.baseline, { cell: "slow-high", n: 20, mean_usd: 10, fail_rate: 0.3 });
  assert.deepEqual(r.guard.cells.find((c) => c.cell === "task-high"), { cell: "task-high", n: 20, mean_usd: 5, fail_rate: 0.45 });
  assert.equal(r.guard.window_start, WINDOW_START);
  assert.ok(!Number.isNaN(Date.parse(r.guard.computed_at)));
  assert.match(r.stdout, /^task-high\t20\t20\t11\t0\.45\t5\t5\t0\t[^\t]*\ttripped$/m);
  assert.match(r.stdout, /^smol-high\t.*\tok$/m);
});

test("--guard: a cell at least as dear as the baseline trips on $ alone, at an equal fail rate", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 4, 10);
  addCell(w, "task-high", MIN_N, 4, 10);
  const r = runCli(w);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(r.guard.tripped, ["task-high"]);
});

test("--guard: every cell within the margin and cheaper exits 0, verdict ok", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 6, 10);
  addCell(w, "task-high", MIN_N, 8, 5);
  const r = runCli(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.guard.tripped, []);
  assert.equal(r.guard.verdict, "ok");
});

test("--guard: a baseline under n=20 is no verdict, exit 4, and judges no cell however bad", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N - 1, 0, 10);
  addCell(w, "task-high", MIN_N, MIN_N, 50);
  const r = runCli(w);
  assert.equal(r.status, 4, r.stderr);
  assert.equal(r.guard.verdict, "none");
  assert.deepEqual(r.guard.tripped, []);
  assert.equal(r.guard.baseline.n, 19);
  assert.match(r.stdout, /^# verdict: none \(baseline slow-high n=19\/20\)/m);
});

test("--guard: a cell under n=20 is never tripped, however bad, while the baseline has a verdict", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  addCell(w, "smol-high", MIN_N - 1, MIN_N - 1, 50);
  const r = runCli(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.guard.tripped, []);
});

test("--guard: an unreadable input is exit 2 and writes no guard file", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  const bad = runCli(w, ["--guard"], { features: `${FEATURE_COLUMNS.join("\t")}\n${DAY}\tshort-row\n` });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /ticket-features\.tsv row 1: 2 fields, expected 18/);
  assert.equal(bad.guard, null);
  const noCell = runCli(w, ["--guard"], { features: featuresText(w).replace("\tslow-high\t\t", "\tfast-high\t\t") });
  assert.equal(noCell.status, 2);
  assert.match(noCell.stderr, /chosen_cell "fast-high" is not a cell/);
});

test("--guard: a gh pr list page at its cap is refused rather than read as complete", () => {
  const w = world();
  addCell(w, "slow-high", 1, 0, 10);
  for (let i = w.prs.length; i < 1000; i++) w.prs.push({ number: 90000 + i, state: "CLOSED", mergedAt: null });
  const r = runCli(w);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /returned 1000 PRs, its cap/);
});

test("without --guard the report prints and exits 0, writing nothing", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  addCell(w, "task-high", MIN_N, MIN_N, 50);
  const r = runCli(w, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.guard, null);
  // One read, every state, scoped to PRs created since the window opened.
  assert.deepEqual(r.ghArgs, ["pr", "list", "--state", "all", "--search", `created:>=${WINDOW_START}`,
    "--limit", "1000", "--json", "number,state,mergedAt"]);
  assert.match(r.stdout, /^cell\tn_pulls\tn_merged\tn_pass\tfail_rate\tmean_usd\tmedian_usd\trouter_usd\tusd_diff_ci95\tguard$/m);
  const json = JSON.parse(runCli(w, ["--json"]).stdout);
  assert.deepEqual(json.tripped, ["task-high"]);
});

test("the retire condition holds once every non-default stage-1 cell has tripped, and only then", () => {
  const w = world();
  addCell(w, "slow-high", MIN_N, 0, 10);
  addCell(w, "task-high", MIN_N, 0, 11);
  const one = computeReport(parsed(w));
  assert.deepEqual([one.tripped, one.retire], [["task-high"], false]);
  addCell(w, "smol-high", MIN_N, 5, 1);
  const both = computeReport(parsed(w));
  assert.deepEqual([both.tripped, both.retire], [["smol-high", "task-high"], true]);
  assert.equal(guardFile(both, "t").retire, true);
  // A stratum that already adopted a non-default cell keeps the router.
  assert.equal(computeReport({ ...parsed(w), routerTable: { rows: { "*": "slow-high", light: "task-high" } } }).retire, false);
});

test("trips() takes the 15-point margin in counts, so 3 of 20 is exactly the margin", () => {
  const base = { n: 20, n_pass: 16, mean_usd: 10 };
  assert.equal(trips({ n: 20, n_pass: 13, mean_usd: 1 }, base), true, "7 of 20 failing vs 4 of 20 is +15 points");
  assert.equal(trips({ n: 20, n_pass: 14, mean_usd: 1 }, base), false, "6 of 20 vs 4 of 20 is +10 points");
  assert.equal(trips({ n: 40, n_pass: 26, mean_usd: 1 }, base), true, "35% vs 20% across different n");
  assert.equal(trips({ n: 20, n_pass: 20, mean_usd: 10 }, base), true, "equal $ trips");
  assert.equal(trips({ n: 20, n_pass: 20, mean_usd: 9.99 }, base), false);
});

// ---------------------------------------------------------------------------
// Booking.

test("a PR carries every attempt for its ticket, its PR-named members and their nested members; merge-bot and memory carry nothing", () => {
  const w = world();
  const T = 41, P = 141;
  // A superseded attempt in another cell, then the verdict-carrying one.
  w.features.push(pull({ ticket: String(T), agent: `impl-${T}`, chosen_cell: "task-high" }));
  w.members.push(member({ agent: `impl-${T}`, cost: 2, effort: "high", subagentType: "fleet-implementer-task-high" }));
  w.features.push(pull({ ticket: String(T), agent: `impl-${T}-b`, chosen_cell: "slow-high", router_usd: "0.0002" }));
  w.members.push(member({ agent: `impl-${T}-b`, cost: 3, effort: "high", subagentType: "fleet-implementer-slow-high" }));
  w.members.push(member({ agent: `impl-${T}-b/Probe`, member: `impl-${T}-b/Probe`, cost: 0.5 }));
  for (const [agent, cost] of [[`review-pr-${P}`, 1], [`fix-pr-${P}`, 1.25], [`finisher-pr-${P}`, 0.25],
    [`reviewcorrectnesspr${P}`, 0.75], [`verifycorrectnesspr${P}-2`, 0.125], [`snapshotpr${P}`, 0.0625], [`test-runpr${P}`, 0.0625],
    [`review-pr-${P}/Helper`, 0.25], ["merge-bot-3", 100], ["memory", 100], ["__advisor", 100], ["MergeBot4", 100],
    // Excluded by its own name even where an ancestor is booked.
    [`impl-${T}-b/__advisor`, 100], [`review-pr-${P}/memory`, 100]]) {
    w.members.push(member({ agent, cost, role: "reviewer" }));
  }
  w.tiers.push(tier({ pr: String(P), ticket: String(T) }));
  w.prs.push({ number: P, state: "MERGED" });
  const rep = computeReport(parsed(w));
  const slow = rep.cells.find((c) => c.cell === "slow-high");
  assert.equal(slow.n_merged, 1);
  assert.equal(slow.mean_usd, 2 + 3 + 0.5 + 1 + 1.25 + 0.25 + 0.75 + 0.125 + 0.0625 + 0.0625 + 0.25);
  assert.equal(slow.router_usd, 0.0002);
  // The superseded attempt counts as a Pull of its own cell, its $ on the PR's.
  assert.equal(rep.cells.find((c) => c.cell === "task-high").n_pulls, 1);
  assert.equal(rep.cells.find((c) => c.cell === "task-high").mean_usd, null);
});

test("unruled and closed spend lands on its cell's mean, an open PR is pending, and a cell mismatch is excluded from every cell", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 10 });
  addPr(w, { ticket: 2, pr: 102, cell: "slow-high", usd: 4, state: "CLOSED" });
  addPr(w, { ticket: 3, pr: 103, cell: "slow-high", usd: 99, state: "OPEN" });
  // A Pull with no ruling yet, whose implementer opened nothing.
  w.features.push(pull({ ticket: "4", agent: "impl-4", chosen_cell: "slow-high" }));
  w.members.push(member({ agent: "impl-4", cost: 6, subagentType: "fleet-implementer-slow-high" }));
  // A Pull with no ruling whose implementer opened a PR still open.
  w.features.push(pull({ ticket: "5", agent: "impl-5", chosen_cell: "slow-high" }));
  w.members.push(member({ agent: "impl-5", cost: 50, pr: "105", subagentType: "fleet-implementer-slow-high" }));
  w.prs.push({ number: 105, state: "OPEN" });
  // Booked as smol-high, but its member ran a different definition.
  addPr(w, { ticket: 6, pr: 106, cell: "smol-high", usd: 1 });
  w.members.at(-1).subagentType = "fleet-implementer-slow-high";
  // A ticket before the window is not a Pull of this guard.
  w.features.push(pull({ ticket: "7", agent: "impl-7", chosen_cell: "slow-high", run_date: "2026-09-01" }));
  w.members.push(member({ agent: "impl-7", cost: 1000 }));

  const rep = computeReport(parsed(w));
  const slow = rep.cells.find((c) => c.cell === "slow-high");
  assert.deepEqual({ n_pulls: slow.n_pulls, n_merged: slow.n_merged, mean_usd: slow.mean_usd, median_usd: slow.median_usd },
    { n_pulls: 3, n_merged: 1, mean_usd: 20, median_usd: 10 });
  assert.deepEqual(rep.pending, ["103", "105"]);
  assert.deepEqual(rep.mismatch, [{ pr: "106", cell: "smol-high", subagent_type: "fleet-implementer-slow-high", effort: "high" }]);
  assert.equal(rep.cells.find((c) => c.cell === "smol-high"), undefined);
  assert.match(formatReport(rep), /^# mismatch \(excluded from every cell\): PR#106 smol-high vs fleet-implementer-slow-high\/high$/m);
});

test("a blank cost books 0 and is counted unpriced; Claude rows are outside the instrument", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: "" });
  w.members.push(member({ agent: "review-pr-101", cost: 2 }));
  w.members.push(member({ agent: "fix-pr-101", cost: 7, harness: "claude" }));
  const rep = computeReport(parsed(w));
  assert.equal(rep.unpriced, 1);
  assert.equal(rep.cells[0].mean_usd, 2);
});

test("the A/B report says B has not run until a B Pull carries a sizing_pre", () => {
  const w = world();
  addCell(w, "slow-high", 3, 0, 10);
  assert.deepEqual(computeReport(parsed(w)).ab,
    { status: "not-run", reason: "B not run — the table has no row a better classifier could change" });
  w.features.find((f) => Number(f.ticket) % 2 === 1).sizing_pre = "light";
  assert.equal(computeReport(parsed(w)).ab.status, "insufficient");
});

test("the cross-check reports recorded cost against pricing.json as a ratio, never a $", () => {
  const w = world();
  addPr(w, { ticket: 1, pr: 101, cell: "slow-high", usd: 0.03 });
  Object.assign(w.members[0], { tokensIn: 1000, tokensOut: 1000, tokensCacheRead: 0, tokensCacheCreate: 0, tokensCacheWrite1h: 0 });
  const pricing = { models: { "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 } } };
  assert.deepEqual(computeReport({ ...parsed(w), pricing }).cross_check, { rows: 1, skipped: 0, ratio: 1 });
  assert.deepEqual(computeReport({ ...parsed(w), pricing: { models: {} } }).cross_check, { rows: 0, skipped: 1, ratio: null });
});
